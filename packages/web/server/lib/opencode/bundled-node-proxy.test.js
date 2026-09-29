import { expect, it } from 'vitest';
import { bundledNodeProxyArgs } from './bundled-opencode-server.js';

it('enables a proxy only for this Node invocation and honors explicit Node settings', () => {
  const env = { https_proxy: 'http://127.0.0.1:3180' };
  expect(bundledNodeProxyArgs(env)).toEqual(['--use-env-proxy']);
  expect(env).not.toHaveProperty('NODE_USE_ENV_PROXY');
  expect(bundledNodeProxyArgs({ ...env, NODE_USE_ENV_PROXY: '0' })).toEqual([]);
  expect(bundledNodeProxyArgs({ ...env, NODE_OPTIONS: '--no-use-env-proxy' })).toEqual([]);
  expect(bundledNodeProxyArgs({})).toEqual([]);
});
