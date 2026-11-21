import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReportDelivery } from './report-delivery.js';

afterEach(() => vi.useRealTimers());

describe('pending workflow reports', () => {
  it('delivers a non-waking report without reading the archive', async () => {
    const readArchive = vi.fn();
    const postSynthetic = vi.fn();
    const save = vi.fn(async () => {});
    const delivery = createReportDelivery({ readArchive, postSynthetic, save, text: () => 'stopped', sleep: async () => {} });
    const run = { id: 'run', parentSessionId: 'parent', report: { messageId: 'original', delivered: false, resume: false } };
    await delivery.deliver(run);
    expect(readArchive).not.toHaveBeenCalled();
    expect(postSynthetic).toHaveBeenCalledWith('parent', expect.objectContaining({ id: 'original', resume: false }));
    expect(run.report.delivered).toBe(true);
  });
  it.each(['recover', 'delete', 'shutdown'])('backs off without a reconnect and stops after %s', async (end) => {
    vi.useFakeTimers();
    const readArchive = vi.fn().mockRejectedValue(new Error('offline'));
    const postSynthetic = vi.fn();
    const save = vi.fn(async () => {});
    const delivery = createReportDelivery({ readArchive, postSynthetic, save, text: () => 'report', sleep: async () => {} });
    const run = { id: 'run', parentSessionId: 'parent', report: { messageId: 'original', delivered: false, resume: true } };
    try {
      await delivery.deliver(run);
      expect(readArchive).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(readArchive).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(readArchive).toHaveBeenCalledTimes(5);
      readArchive.mockResolvedValue('archived');
      if (end === 'shutdown') delivery.shutdown();
      if (end === 'delete') delete run.report;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(postSynthetic).toHaveBeenCalledTimes(end === 'recover' ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
      if (end === 'recover') {
        expect(postSynthetic).toHaveBeenCalledWith('parent', expect.objectContaining({ id: 'original', resume: false }));
        expect(run.report.delivered).toBe(true);
      }
    } finally { delivery.shutdown(); }
  });
});
