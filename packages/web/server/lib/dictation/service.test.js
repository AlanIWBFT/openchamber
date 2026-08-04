import { afterEach, describe, expect, it, vi } from 'vitest';

const ensureLocalSttModel = vi.fn();
const isLocalSttModelInstalled = vi.fn(async () => false);
const workerShutdown = vi.fn();

vi.mock('./local/model-downloader.js', () => ({
  ensureLocalSttModel,
  isLocalSttModelInstalled,
}));

vi.mock('./local/worker-client.js', () => ({
  DictationWorkerClient: class {
    shutdown() {
      workerShutdown();
    }
  },
  WorkerBackedTranscriptionSession: class {},
}));

const { createDictationService } = await import('./service.js');

describe('dictation service shutdown', () => {
  afterEach(() => {
    ensureLocalSttModel.mockReset();
    isLocalSttModelInstalled.mockClear();
    workerShutdown.mockClear();
  });

  it('aborts an in-flight model download and rejects later admission', async () => {
    let signal;
    ensureLocalSttModel.mockImplementationOnce((options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const service = createDictationService({ modelsDir: 'models' });

    await service.requestModelDownload('whisper-tiny-int8');
    expect(signal.aborted).toBe(false);

    service.shutdown();

    expect(signal.aborted).toBe(true);
    expect(workerShutdown).toHaveBeenCalledTimes(1);
    await service.requestModelDownload('whisper-base-int8');
    expect(ensureLocalSttModel).toHaveBeenCalledTimes(1);
  });
});
