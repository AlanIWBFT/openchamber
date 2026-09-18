import type { ModelMetadata } from '@/types';

export type ContextWindowLimits = {
  /** 0 when unknown; the readouts then fall back to their own default. */
  context: number;
  output: number;
};

export const NO_CONTEXT_WINDOW_LIMITS: ContextWindowLimits = { context: 0, output: 0 };

type AnsweringMessage = { role?: string; providerID?: string; modelID?: string };

/**
 * `provider/model` of the newest assistant message, or null before the first
 * answer. Reduced to a string so a store selector can return it and only
 * notify when the answering model changes, not on every streamed part.
 */
export const findAnsweringModelKey = (messages: readonly AnsweringMessage[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (!message.providerID || !message.modelID) continue;
    return `${message.providerID}/${message.modelID}`;
  }
  return null;
};

/** Limits of the model behind a key produced by `findAnsweringModelKey`. */
export const limitsForAnsweringModel = (
  answeringModelKey: string | null,
  getModelMetadata: (providerId: string, modelId: string) => ModelMetadata | undefined,
): ContextWindowLimits => {
  if (!answeringModelKey) return NO_CONTEXT_WINDOW_LIMITS;
  const separator = answeringModelKey.indexOf('/');
  const metadata = getModelMetadata(answeringModelKey.slice(0, separator), answeringModelKey.slice(separator + 1));
  return { context: metadata?.limit?.context ?? 0, output: metadata?.limit?.output ?? 0 };
};
