import { describe, expect, test } from 'bun:test';

import { findAnsweringModelKey, limitsForAnsweringModel } from './contextWindowLimits';

describe('findAnsweringModelKey', () => {
  test('names the newest assistant message with model ids', () => {
    expect(findAnsweringModelKey([
      { role: 'assistant', providerID: 'zai', modelID: 'glm-4' },
      { role: 'user' },
      { role: 'assistant', providerID: 'openai', modelID: 'gpt' },
      { role: 'user' },
    ])).toBe('openai/gpt');
  });

  test('is null before the first answer or when the answer names no model', () => {
    expect(findAnsweringModelKey([{ role: 'user' }])).toBeNull();
    expect(findAnsweringModelKey([{ role: 'assistant' }])).toBeNull();
  });
});

describe('limitsForAnsweringModel', () => {
  test('reads the answering model window, zero when the catalog lacks it', () => {
    const getModelMetadata = (providerId: string, modelId: string) => (
      providerId === 'zai' && modelId === 'glm-4'
        ? { id: modelId, providerId, limit: { context: 1_000_000, output: 128_000 } }
        : undefined
    );
    expect(limitsForAnsweringModel('zai/glm-4', getModelMetadata)).toEqual({ context: 1_000_000, output: 128_000 });
    expect(limitsForAnsweringModel('other/model', getModelMetadata)).toEqual({ context: 0, output: 0 });
    expect(limitsForAnsweringModel(null, getModelMetadata)).toEqual({ context: 0, output: 0 });
  });
});
