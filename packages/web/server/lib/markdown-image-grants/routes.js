import express from 'express';
import { constants as fsConstants } from 'node:fs';
import { mintOutsideFileGrant } from '../fs/routes.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_SOURCES = 12;

const asString = (value) => typeof value === 'string' ? value.trim() : '';

const isWithin = (target, root, path) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const parseFileSource = (source) => {
  if (/^file:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (url.protocol !== 'file:' || (url.host && url.host !== 'localhost')) return '';
      const pathname = decodeURIComponent(url.pathname);
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return '';
    }
  }
  const pathname = source.split(/[?#]/, 1)[0] || '';
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

const hasImageSignature = (bytes) => {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('ascii') === 'PNG'
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  const header = bytes.subarray(0, 12).toString('ascii');
  return header.startsWith('GIF87a')
    || header.startsWith('GIF89a')
    || (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP');
};

const markdownImageSources = (message) => {
  const sources = new Set();
  for (const part of Array.isArray(message?.parts) ? message.parts : []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    // Code examples must never authorize file access, even when they contain image syntax.
    let fenced = false;
    for (const line of part.text.split('\n')) {
      if (/^\s{0,3}(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const visible = line.replace(/`+[^`]*`+/g, '');
      const pattern = /(?<!\\)!\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))/g;
      let match = pattern.exec(visible);
      while (match) {
        sources.add(match[1] || match[2]);
        match = pattern.exec(visible);
      }
    }
  }
  return sources;
};

const fetchMessage = async ({ sessionId, messageId, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const url = new URL(buildOpenCodeUrl(
    `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
    '',
  ));
  url.searchParams.set('directory', directory);
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-opencode-directory': directory,
      ...getOpenCodeAuthHeaders(),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenCode returned ${response.status}`);
  const message = await response.json().catch(() => null);
  return message?.info && Array.isArray(message.parts) ? message : null;
};

const inspectImage = async ({ source, directory, approvedTempRoot, fsPromises, path }) => {
  const parsed = parseFileSource(source);
  if (!parsed) return { status: 'error' };
  const sourcePath = path.isAbsolute(parsed) ? parsed : path.resolve(directory, parsed);
  const workspaceRoot = path.resolve(directory);
  const outsideWorkspace = !isWithin(path.resolve(sourcePath), workspaceRoot, path);
  const root = outsideWorkspace ? approvedTempRoot : workspaceRoot;

  try {
    // Resolve symlinks before comparing roots; lexical prefixes are not an authorization boundary.
    const [canonicalRoot, canonicalPath] = await Promise.all([
      fsPromises.realpath(root),
      fsPromises.realpath(sourcePath),
    ]);
    if (!isWithin(canonicalPath, canonicalRoot, path)) return { status: 'error' };
    const handle = await fsPromises.open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) return { status: 'error' };
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (!hasImageSignature(header.subarray(0, bytesRead))) return { status: 'error' };
      return {
        status: 'ready',
        path: outsideWorkspace ? canonicalPath : path.resolve(sourcePath),
        outsideWorkspace,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ELOOP') {
      return { status: 'error' };
    }
    throw error;
  }
};

export const registerMarkdownImageGrantRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    os,
    crypto,
    validateDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    approvedTempRoot = path.join(os.tmpdir(), 'opencode'),
  } = dependencies;

  app.post(
    '/api/openchamber/sessions/:sessionId/markdown-image-grants',
    express.json({ limit: '32kb' }),
    async (req, res) => {
      const sessionId = asString(req.params.sessionId);
      const messageId = asString(req.body?.messageId);
      const sources = Array.isArray(req.body?.sources)
        ? [...new Set(req.body.sources.map(asString).filter(Boolean))]
        : [];
      if (!sessionId || !messageId || sources.length === 0 || sources.length > MAX_IMAGE_SOURCES) {
        return res.status(400).json({ error: 'sessionId, messageId, and 1-12 sources are required' });
      }
      const validatedDirectory = await validateDirectoryPath(asString(req.body?.directory));
      if (!validatedDirectory.ok) {
        return res.status(400).json({ error: validatedDirectory.error || 'Invalid directory' });
      }

      try {
        const message = await fetchMessage({
          sessionId,
          messageId,
          directory: validatedDirectory.directory,
          buildOpenCodeUrl,
          getOpenCodeAuthHeaders,
        });
        if (!message || message.info?.id !== messageId || message.info?.role !== 'assistant') {
          return res.status(404).json({ error: 'Assistant message not found' });
        }
        // Assistant text is authoritative: a remote client cannot mint grants for unreferenced paths.
        const referenced = markdownImageSources(message);
        const results = [];
        for (const source of sources) {
          if (!referenced.has(source)) {
            results.push({ source, status: 'error' });
            continue;
          }
          try {
            const inspected = await inspectImage({
              source,
              directory: validatedDirectory.directory,
              approvedTempRoot,
              fsPromises,
              path,
            });
            if (inspected.status !== 'ready') {
              results.push({ source, status: inspected.status });
              continue;
            }
            // Reuse the existing path-bound raw-file grant instead of creating another asset lifecycle.
            const grant = inspected.outsideWorkspace
              ? await mintOutsideFileGrant(inspected.path, {
                scopes: ['raw'],
                fsPromises,
                path,
                crypto,
              })
              : null;
            results.push({
              source,
              status: 'ready',
              path: inspected.path,
              outsideFileGrant: grant?.outsideFileGrant,
              expiresAt: grant?.expiresAt,
            });
          } catch {
            results.push({ source, status: 'error' });
          }
        }
        return res.json({ results });
      } catch (error) {
        console.warn('[MarkdownImageGrants] failed to prepare images:', error?.message || error);
        return res.status(503).json({ error: 'Failed to prepare session images' });
      }
    },
  );
};
