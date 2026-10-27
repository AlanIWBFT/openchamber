import { fileURLToPath } from 'node:url';
import type { Plugin, ResolvedConfig, Rollup } from 'vite';
import { createWebIconScript } from './scripts/web-icons.mjs';

const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const scriptMarker = '<script data-web-icons></script>';

export const webIconsPlugin = () => {
  let base = '/';
  let isBuild = false;
  let scriptReference = '';
  return {
    name: 'openchamber-web-icons',
    enforce: 'post',
    configResolved(config: Pick<ResolvedConfig, 'base' | 'command'>) {
      base = config.base;
      isBuild = config.command === 'build';
    },
    buildStart(this: Pick<Rollup.PluginContext, 'emitFile'>) {
      if (!isBuild) return;
      scriptReference = this.emitFile({
        type: 'asset',
        name: 'web-icons.js',
        source: createWebIconScript(publicDirectory),
      });
    },
    configureServer(server) {
      server.middlewares.use(`${base}__web-icons.js`, (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(createWebIconScript(publicDirectory));
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        return context.server ? html.replace(scriptMarker, `<script src="${base}__web-icons.js"></script>`) : html;
      },
    },
    generateBundle(this: Pick<Rollup.PluginContext, 'getFileName'>, _options: Rollup.OutputOptions, bundle: Rollup.OutputBundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') return;
      const src = `${base}${this.getFileName(scriptReference)}`;
      index.source = String(index.source).replace(scriptMarker, `<script src="${src}"></script>`);
    },
  } satisfies Plugin;
};
