import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDictationService } from './service.js';

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
