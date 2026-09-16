import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseManifestJson } from '../src/schemas';

const examples = new URL('../examples/', import.meta.url);

describe('checked-in SDK examples', () => {
  test('all manifests remain valid', async () => {
    for (const entry of await readdir(examples, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = parseManifestJson(await readFile(new URL(`${entry.name}/package.json`, examples), 'utf8'));
      expect(manifest.ok).toBe(true);
    }
  });

  test('all shipped bundles match their source and current SDK', async () => {
    for (const entry of ['hello-kit/panel/main', 'github-token/panel/main', 'config-editor/panel/main', 'service-echo/panel/main',
      'service-echo/service/main', 'tasks-demo/panel/main', 'tasks-demo/panel/attach', 'tasks-demo/panel/page']) {
      const node = entry.includes('/service/');
      const result = await Bun.build({ entrypoints: [fileURLToPath(new URL(`${entry}.ts`, examples))], format: node ? 'esm' : 'iife', target: node ? 'node' : 'browser', minify: !node, write: false });
      expect(result.success).toBe(true);
      // Bun's unminified source comments are relative to the command's working directory.
      const normalize = (source: string) => source.replace(/^\/\/ (?:packages\/sdk\/)?examples\//gm, '// examples/');
      expect(Bun.hash(normalize(await result.outputs[0].text()))).toBe(Bun.hash(normalize(await readFile(new URL(`${entry}.js`, examples), 'utf8'))));
    }
  });
});
