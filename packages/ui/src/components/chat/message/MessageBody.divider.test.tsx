import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpenCode } from '@opencode/client';
import type { Part } from '@/lib/opencode/model';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import type { TurnGroupingContext } from '../lib/turns/types';

const { default: MessageBody } = await import('./MessageBody');

const unavailable = (): never => { throw new Error('Message rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => Response.json([]) });
const answer: Part = { id: 'text', sessionID: 'session', messageID: 'answer', type: 'text', text: 'The answer.', time: { start: 1, end: 2 } };
const reasoning = (text: string): Part => ({ id: 'reasoning', sessionID: 'session', messageID: 'answer', type: 'reasoning', text, time: { start: 0, end: 1 } });
const context: TurnGroupingContext = {
  turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
  isLatestTurn: true, isWorking: false, hasTools: false, hasReasoning: false,
};
const renderAnswer = (parts: Part[], turnContext = context, showReasoningTraces = true) => renderToStaticMarkup(
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>
        <MessageBody
          messageId="answer" parts={parts} isUser={false} isMessageCompleted messageFinish="stop"
          isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
          onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="completed" allowAnimation={false}
          hasTextContent showReasoningTraces={showReasoningTraces} turnGroupingContext={turnContext}
        />
      </I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>,
);
const renderStreamingReasoning = (parts: Part[]) => renderToStaticMarkup(
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>
        <MessageBody
          messageId="answer" parts={parts} isUser={false} isMessageCompleted={false}
          isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
          onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="streaming" allowAnimation={false}
          hasTextContent={false} showReasoningTraces turnGroupingContext={{ ...context, isWorking: true }}
        />
      </I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>,
);
const divider = 'mt-1.5 mb-3 h-px w-full bg-muted-foreground/20';

describe('final answer divider', () => {
  test('does not separate settled answer text from earlier work', () => {
    const markup = renderAnswer([reasoning('Checking the response.'), answer], { ...context, earlierAssistantText: ['First reply.'] });
    expect(markup).toContain('data-message-text-export-source="true"');
    expect(markup).not.toContain(divider);
  });


  test('keeps empty reasoning mounted while it streams', () => {
    const streaming: Part = { id: 'reasoning', sessionID: 'session', messageID: 'answer', type: 'reasoning', text: '', time: { start: 0 } };
    const ended: Part = { ...streaming, time: { start: 0, end: 1 } };
    expect(renderStreamingReasoning([streaming])).not.toBe(renderStreamingReasoning([ended]));
  });
});
