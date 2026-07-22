import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { QuestionRequest } from '@/types/question';

mock.module('@/components/ui', () => ({
  toast: {
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: { isMobile: boolean }) => unknown) => selector({ isMobile: false }),
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: (selector: (state: { currentSessionId: string | null }) => unknown) => selector({ currentSessionId: null }),
}));

mock.module('@/sync/sync-context', () => ({
  useSessions: () => [],
}));

mock.module('@/sync/session-actions', () => ({
  respondToQuestion: async () => undefined,
  rejectQuestion: async () => undefined,
  isQuestionRequestNotFoundError: () => false,
}));

const { QuestionCard } = await import('./QuestionCard');

function renderQuestion(custom?: boolean): string {
  const question: QuestionRequest = {
    id: 'question-1',
    sessionID: 'session-1',
    questions: [{
      header: 'Build Agent',
      question: 'Switch to the build agent?',
      options: [
        { label: 'Yes', description: 'Switch to build' },
        { label: 'No', description: 'Stay in plan' },
      ],
      custom,
    }],
  };

  return renderToStaticMarkup(
    <I18nProvider>
      <QuestionCard question={question} />
    </I18nProvider>,
  );
}

describe('QuestionCard custom answers', () => {
  test('hides the custom answer option when custom is false', () => {
    expect(renderQuestion(false)).not.toContain('>Other…<');
  });

  test('keeps custom answers enabled when custom is omitted', () => {
    expect(renderQuestion()).toContain('>Other…<');
  });
});
