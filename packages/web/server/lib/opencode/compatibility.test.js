import { describe, it, expect } from 'vitest';
import { checkOpenCodeCompatibility, readOpenCodeCliVersion, readExternalOpenCodeVersion, readOpenCodeInfo } from './compatibility.js';

const cli = (output, code = 0) => ({ binary: process.execPath, args: ['-e', `console.log(${JSON.stringify(output)}); process.exit(${code})`, '--'] });
const fork = version => ({ distribution: 'openchamber', version });

describe('OpenCode compatibility', () => {
  it('accepts fork builds by identity, not upstream version', async () => {
    await expect(readOpenCodeCliVersion(cli('2.3.2'))).rejects.toThrow(/fork/);
    expect(await readOpenCodeCliVersion(cli(JSON.stringify(fork('local'))))).toBe('local');
    await expect(readOpenCodeCliVersion(cli('2.0.19', 1))).rejects.toThrow();
    await expect(readOpenCodeCliVersion(cli('error, requires 2.0.19'))).rejects.toThrow();
  });

  it('runs the version check with the environment a launch needs', async () => {
    const launch = {
      binary: process.execPath,
      args: ['-e', 'console.log(process.env.OPENCHAMBER_TEST_VERSION ?? "missing")', '--'],
      env: { OPENCHAMBER_TEST_VERSION: JSON.stringify(fork('2.3.0')) },
    };
    expect(await readOpenCodeCliVersion(launch)).toBe('2.3.0');
  });

  it('does not accept HTTP 200 HTML or malformed JSON as readiness', async () => {
    await expect(readOpenCodeInfo(new Response('<html>OpenCode</html>'))).rejects.toThrow(/fork/);
    await expect(readOpenCodeInfo(Response.json({ version: '2.3.2' }))).rejects.toThrow(/fork/);
    await expect(readOpenCodeInfo(Response.json({ ...fork('2.3.2'), distribution: 'other' }))).rejects.toThrow(/fork/);
    expect(await readOpenCodeInfo(Response.json(fork('2.3.2')))).toEqual(fork('2.3.2'));
  });

  it('refuses an unmarked endpoint without trying legacy routes', async () => {
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url.pathname);
      return url.pathname === '/api/info' ? new Response('<html/>') : Response.json({ healthy: true, version: '1.18.32' });
    };
    const read = () => readExternalOpenCodeVersion('http://localhost:4096', {}, fetchImpl);
    expect(await checkOpenCodeCompatibility(read, 'external')).toMatchObject({ state: 'incompatible' });
    expect(requests).toEqual(['/api/info']);
  });

  it('keeps a timeout unavailable rather than reporting the wrong distribution', async () => {
    const fetchImpl = async (url) => {
      if (url.pathname === '/api/info') throw new DOMException('The operation timed out.', 'TimeoutError');
      return Response.json({ healthy: true, version: '1.18.32' });
    };
    expect(await checkOpenCodeCompatibility(() => readExternalOpenCodeVersion('http://localhost:4096', {}, fetchImpl), 'external')).toMatchObject({ state: 'unavailable' });
  });

  it.each([401, 403])('does not call an auth failure v1 (%s)', async (status) => {
    let requests = 0;
    expect(await readExternalOpenCodeVersion('http://localhost:4096', {}, async () => {
      requests += 1;
      return new Response(null, { status });
    })).toBeNull();
    expect(requests).toBe(1);
  });

});
