import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { createDictationService } from './service.js';
import { getLocalSttModelSpec } from './local/model-catalog.js';

async function installModel(modelsDir, modelId) {
  const spec = getLocalSttModelSpec(modelId);
  const dir = path.join(modelsDir, spec.extractedDir);
  await mkdir(dir, { recursive: true });
  for (const file of spec.requiredFiles) {
    await writeFile(path.join(dir, file), 'x');
  }
}

describe('dictation model choice', () => {
  let modelsDir;
  let service;

  beforeEach(async () => {
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'oc-dictation-'));
    service = createDictationService({ modelsDir });
  });

  afterEach(async () => {
    service.shutdown();
    await rm(modelsDir, { recursive: true, force: true });
  });

  const activeModel = async (localModel) => (await service.getStatus({ provider: 'local', localModel })).activeModel;

  it('uses Parakeet v3 when nobody picked a model', async () => {
    expect(await activeModel('')).toBe('parakeet-tdt-0.6b-v3-int8');
  });

  it('keeps Parakeet v2 for someone who has it installed and picked nothing', async () => {
    await installModel(modelsDir, 'parakeet-tdt-0.6b-v2-int8');
    expect(await activeModel('')).toBe('parakeet-tdt-0.6b-v2-int8');
    expect(await activeModel('whisper-base-int8')).toBe('parakeet-tdt-0.6b-v2-int8');
  });

  it('uses the picked model even when v2 is installed', async () => {
    await installModel(modelsDir, 'parakeet-tdt-0.6b-v2-int8');
    expect(await activeModel('qwen3-asr-0.6b-int8')).toBe('qwen3-asr-0.6b-int8');
  });
});

const ensureLocalSttModel = vi.fn();
const isLocalSttModelInstalled = vi.fn(async () => false);

describe('dictation service shutdown', () => {
  afterEach(() => {
    ensureLocalSttModel.mockReset();
    isLocalSttModelInstalled.mockClear();
  });

  it('aborts an in-flight model download and rejects later admission', async () => {
    let signal;
    ensureLocalSttModel.mockImplementationOnce((options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const service = createDictationService({ modelsDir: 'models', ensureModel: ensureLocalSttModel, isModelInstalled: isLocalSttModelInstalled });

    await service.requestModelDownload('whisper-tiny-int8');
    expect(signal.aborted).toBe(false);

    service.shutdown();

    expect(signal.aborted).toBe(true);
    await service.requestModelDownload('whisper-base-int8');
    expect(ensureLocalSttModel).toHaveBeenCalledTimes(1);
  });
});
