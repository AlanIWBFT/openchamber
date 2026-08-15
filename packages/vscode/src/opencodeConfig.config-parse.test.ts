import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateMcpConfig } from './opencodeConfig';

const PARTIAL_PARSE_CONFIG = [
  '{',
  '  "$schema": "https://opencode.ai/config.json",',
  '  plugin: ["opencode-see-image"],',
  '  mcp: {',
  '    openproject: {',
  '      type: "remote",',
  '      url: "https://openproject.example.com/mcp",',
  '      enabled: true',
  '    }',
  '  },',
  '  provider: {',
  '    "ollama-cloud": {',
  '      npm: "@ai-sdk/openai-compatible",',
  '      name: "Ollama Cloud"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const VALID_CONFIG = [
  '{',
  '  "$schema": "https://opencode.ai/config.json",',
  '  "plugin": ["opencode-see-image"],',
  '  "mcp": {',
  '    "openproject": {',
  '      "type": "remote",',
  '      "url": "https://openproject.example.com/mcp",',
  '      "enabled": true',
  '    }',
  '  },',
  '  "provider": {',
  '    "ollama-cloud": {',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "name": "Ollama Cloud"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

describe('opencodeConfig JSONC parse safety (issue #2923)', () => {
  let tempDir: string;
  let previousOpenCodeConfig: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-config-parse-'));
    previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
  });

  afterEach(() => {
    if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('refuses MCP updates that would overwrite a partial-parse config', () => {
    const configPath = path.join(tempDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, PARTIAL_PARSE_CONFIG, 'utf8');
    process.env.OPENCODE_CONFIG = configPath;

    assert.throws(
      () => updateMcpConfig('openproject', { enabled: true }),
      (error: unknown) => (
        error instanceof Error
        && /cannot be loaded safely/.test(error.message)
        && (error as Error & { code?: string }).code === 'INVALID_JSONC'
      ),
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), PARTIAL_PARSE_CONFIG);
    assert.equal(fs.existsSync(`${configPath}.openchamber.backup`), false);
  });

  test('preserves unrelated keys when updating a valid MCP config', () => {
    const configPath = path.join(tempDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, VALID_CONFIG, 'utf8');
    process.env.OPENCODE_CONFIG = configPath;

    updateMcpConfig('openproject', { enabled: false });

    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(rewritten.plugin, ['opencode-see-image']);
    assert.equal(rewritten.provider['ollama-cloud'].name, 'Ollama Cloud');
    assert.equal(rewritten.mcp.openproject.enabled, false);
    assert.equal(fs.readFileSync(`${configPath}.openchamber.backup`, 'utf8'), VALID_CONFIG);
  });
});
