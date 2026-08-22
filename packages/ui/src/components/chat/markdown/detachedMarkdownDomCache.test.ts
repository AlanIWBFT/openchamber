import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { DetachedMarkdownDomCache, type DetachedMarkdownDom } from './detachedMarkdownDomCache';

Object.assign(globalThis, { document: new Window().document });

const keyFor = ({ scope, id, locale }: DetachedMarkdownDom) => ({ scope, id, locale });

const createEntry = (
  document: Document,
  sessionId: string,
  messageId: string,
  partId: string,
): DetachedMarkdownDom => {
  const fragment = document.createDocumentFragment();
  const node = document.createElement('p');
  node.textContent = `${messageId}:${partId}`;
  fragment.appendChild(node);
  return {
    scope: `runtime:${sessionId}`,
    id: `${messageId}:${partId}`,
    locale: 'en',
    fragment,
  };
};

describe('DetachedMarkdownDomCache', () => {
  test('consumes the original DOM fragment once and rejects another locale', () => {
    const cache = new DetachedMarkdownDomCache({ maxSessions: 2, maxEntriesPerSession: 2 });
    const entry = createEntry(document, 'session-a', 'message-a', 'part-a');
    const originalNode = entry.fragment.firstChild;

    cache.store(entry);
    expect(cache.take({ ...keyFor(entry), locale: 'zh' })).toBeNull();
    cache.store(entry);
    const restored = cache.take(keyFor(entry));
    expect(restored?.firstChild).toBe(originalNode);
    expect(cache.take(keyFor(entry))).toBeNull();
  });

  test('bounds entries per session and evicts the least recently used session', () => {
    const cache = new DetachedMarkdownDomCache({ maxSessions: 2, maxEntriesPerSession: 2 });
    cache.store(createEntry(document, 'session-a', 'message-1', 'part'));
    cache.store(createEntry(document, 'session-a', 'message-2', 'part'));
    cache.store(createEntry(document, 'session-a', 'message-3', 'part'));
    cache.store(createEntry(document, 'session-b', 'message-4', 'part'));
    cache.store(createEntry(document, 'session-c', 'message-5', 'part'));
    expect(cache.stats()).toEqual({ sessions: 2, entries: 2 });
    expect(cache.take({
      scope: 'runtime:session-a',
      id: 'message-2:part',
      locale: 'en',
    })).toBeNull();
    expect(cache.take({
      scope: 'runtime:session-c',
      id: 'message-5:part',
      locale: 'en',
    })).not.toBeNull();
  });

  test('isolates identities by runtime and replaces an identity without growing stats', () => {
    const cache = new DetachedMarkdownDomCache({ maxSessions: 2, maxEntriesPerSession: 2 });
    const first = createEntry(document, 'session', 'message', 'part');
    const replacement = createEntry(document, 'session', 'message', 'part');
    const replacementNode = replacement.fragment.firstChild;
    const otherRuntime = createEntry(document, 'other-runtime-session', 'message', 'part');

    cache.store(first);
    cache.store(replacement);
    cache.store(otherRuntime);

    expect(cache.stats()).toEqual({ sessions: 2, entries: 2 });
    expect(cache.take(keyFor(otherRuntime))).not.toBeNull();
    expect(cache.take(keyFor(replacement))?.firstChild).toBe(replacementNode);
  });

  test('refreshes session LRU and clears all entries', () => {
    const cache = new DetachedMarkdownDomCache({ maxSessions: 2, maxEntriesPerSession: 2 });
    const sessionA = createEntry(document, 'session-a', 'message-a', 'part');
    const sessionB = createEntry(document, 'session-b', 'message-b', 'part');
    const sessionC = createEntry(document, 'session-c', 'message-c', 'part');
    cache.store(sessionA);
    cache.store(sessionB);
    cache.store(sessionA);
    cache.store(sessionC);
    expect(cache.take(keyFor(sessionB))).toBeNull();

    cache.clear();
    expect(cache.stats()).toEqual({ sessions: 0, entries: 0 });
  });
});
