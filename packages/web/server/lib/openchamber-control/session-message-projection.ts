import type { MessageListOutput } from '@opencode/client';
import { z } from 'zod';
import { asNonEmptyString, isRecord } from '../shared/guards.js';
import type { TextMessage } from './service.js';

export type StoredRecord = MessageListOutput['data'][number];
const pageReply = z.object({
  ok: z.literal(true), action: z.literal('render.page'), title: z.string().optional(),
  answer: z.object({ answered: z.literal(true), summary: z.string(), data: z.json() }),
});
const questionAnswers = z.array(z.array(z.string()));

export function projectSessionMessages(records: Iterable<StoredRecord>, role: string): TextMessage[] {
  const result: TextMessage[] = [];
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    if (role === 'all' || role === record.type) {
      const text = (record.type === 'user' ? record.text : record.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')).trim();
      if (text) result.push({
        id: record.id, role: record.type, createdAt: record.time.created,
        completedAt: record.type === 'assistant' ? record.time.completed ?? null : null,
        model: record.type === 'assistant' && record.model?.providerID && record.model.id ? `${record.model.providerID}/${record.model.id}` : null, text,
      });
    }
    if (record.type !== 'assistant' || role === 'assistant') continue;
    for (const part of record.content) {
      if (part.type !== 'tool' || part.state.status !== 'completed') continue;
      const { input, metadata } = part.state;
      let text: string;
      let prefix: string;
      if (part.name === 'openchamber_render') {
        const reply = pageReply.safeParse(metadata?.openchamber);
        if (!reply.success) continue;
        const title = asNonEmptyString(reply.data.title) ?? asNonEmptyString(isRecord(input?.parameters) ? input.parameters.title ?? input.title : input?.title);
        if (!title) continue;
        prefix = 'page-answer';
        text = `User submitted a choice through a page (page-generated summary and data, not verbatim user text).\nPage: ${title}\nSubmitted choice: ${reply.data.answer.summary}\nSubmitted data: ${JSON.stringify(reply.data.answer.data)}`;
      } else if (part.name === 'question') {
        const answers = questionAnswers.safeParse(metadata?.answers);
        if (!answers.success) continue;
        const questions = Array.isArray(input?.questions) ? input.questions : [];
        prefix = 'question-answer';
        text = answers.data.flatMap((values, index) => {
          const rendered = values.filter(value => value.trim()).map(value => `Answer: ${value}`).join('\n');
          const entry = questions[index];
          const label = isRecord(entry) ? asNonEmptyString(entry.question) : null;
          return rendered ? [label ? `Question: ${label}\n${rendered}` : rendered] : [];
        }).join('\n\n');
        if (!text) continue;
      } else continue;
      result.push({ id: `${prefix}:${record.id}:${part.id}`, role: 'user', createdAt: part.time.completed ?? record.time.completed ?? record.time.created, completedAt: null, model: null, text });
    }
  }
  return result;
}
