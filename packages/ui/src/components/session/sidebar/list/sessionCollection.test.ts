import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { Event } from '@opencode-ai/sdk/v2/client';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deriveRecentSessions } from '../recent/activitySections';
import { applyGlobalSessionStatusEvent, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { getDescendantIds, projectSidebarActiveSessions, projectSidebarCollection, useRecentSessionCollection } from './sessionCollection';

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9, defaultView: globalThis, activeElement: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: documentStub,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const session = (id: string, directory: string | null): Session => {
  // SAFETY: Sidebar projection reads only id, directory, and time from session fixtures.
  return {
    id,
    directory,
    time: { created: 1, updated: 1 },
  } as Session;
};

describe('projectSidebarActiveSessions', () => {
  test('keeps global precedence and order, then appends missing live sessions', () => {
    const global = [session('global-b', '/workspace/b'), session('global-a', '/workspace/a')];
    const live = [session('global-a', '/workspace/a'), session('live-c', '/workspace/c')];

    expect(projectSidebarActiveSessions({
      globalActiveSessions: global,
      liveSessions: live,
      knownDirectories: new Set(['/workspace/a', '/workspace/b', '/workspace/c']),
      isVSCode: false,
    }).map((entry) => entry.id)).toEqual(['global-b', 'global-a', 'live-c']);
  });

  test('filters unknown VS Code directories', () => {
    const sessions = [session('known', '/workspace/known'), session('unknown', '/workspace/unknown')];

    expect(projectSidebarActiveSessions({
      globalActiveSessions: sessions,
      liveSessions: [],
      knownDirectories: new Set(['/workspace/known']),
      isVSCode: true,
    }).map((entry) => entry.id)).toEqual(['known']);
  });

  test('allows missing or unknown directories for web when no directories are known', () => {
    const sessions = [session('unknown', '/workspace/unknown'), session('empty', null)];

    expect(projectSidebarActiveSessions({
      globalActiveSessions: sessions,
      liveSessions: [],
      knownDirectories: new Set(),
      isVSCode: false,
    }).map((entry) => entry.id)).toEqual(['unknown', 'empty']);
  });

  test('keeps archived sessions despite directory filtering', () => {
    const archived = session('archived', '/workspace/unknown');
    archived.time.archived = 1;

    expect(projectSidebarActiveSessions({
      globalActiveSessions: [archived],
      liveSessions: [],
      knownDirectories: new Set(['/workspace/known']),
      isVSCode: true,
    }).map((entry) => entry.id)).toEqual(['archived']);
  });

  test('does not replace a filtered global record with a live duplicate', () => {
    expect(projectSidebarActiveSessions({
      globalActiveSessions: [session('same', '/workspace/unknown')],
      liveSessions: [session('same', '/workspace/known')],
      knownDirectories: new Set(['/workspace/known']),
      isVSCode: true,
    })).toEqual([]);
  });
});

describe('projectSidebarCollection', () => {
  test('returns the same structural projection for unchanged inputs without module caching', () => {
    const globalActiveSessions = [session('a', '/workspace/a'), session('b', '/workspace/b')];
    const input = {
      globalActiveSessions,
      liveSessions: [],
      knownDirectories: new Set(['/workspace/a', '/workspace/b']),
      isVSCode: false,
    };

    const beforeSelection = projectSidebarCollection(input);
    const afterSelection = projectSidebarCollection(input);

    expect(afterSelection).toEqual(beforeSelection);
  });

  test('rebuilds when a structural session collection input changes', () => {
    const input = {
      globalActiveSessions: [session('a', '/workspace/a')],
      liveSessions: [],
      knownDirectories: new Set(['/workspace/a']),
      isVSCode: false,
    };

    const before = projectSidebarCollection(input);
    const after = projectSidebarCollection({
      ...input,
      globalActiveSessions: [session('a', '/workspace/a'), session('b', '/workspace/a')],
    });

    expect(after).not.toBe(before);
    expect(after.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  test('keeps project membership independent from Recent active membership', () => {
    const input = {
      globalActiveSessions: [session('old-root', '/workspace/a')],
      liveSessions: [],
      knownDirectories: new Set(['/workspace/a']),
      isVSCode: false,
    };
    const projectBefore = projectSidebarCollection(input);
    const recentBefore = deriveRecentSessions(projectBefore, new Set(), 200_000_000);
    const projectAfter = projectSidebarCollection(input);
    const recentAfter = deriveRecentSessions(projectAfter, new Set(['old-root']), 200_000_000);

    expect(projectAfter).toEqual(projectBefore);
    expect(recentBefore).toEqual([]);
    expect(recentAfter.map((entry) => entry.id)).toEqual(['old-root']);
  });
});

describe('useRecentSessionCollection', () => {
  test('updates mounted Recent membership when global active status changes', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const oldSession = { ...session('old-root', '/workspace/a'), time: { created: 1, updated: 1 } };
    let renderedIds: string[] = [];
    let renderCount = 0;
    let timeReadCount = 0;
    Object.defineProperty(oldSession, 'time', {
      get: () => {
        timeReadCount += 1;
        return { created: 1, updated: 1 };
      },
    });
    timeReadCount = 0;
    const Harness = () => {
      renderCount += 1;
      const recent = useRecentSessionCollection({
        enabled: true,
        isVSCode: false,
        pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(),
        sessions: [oldSession],
      });
      renderedIds = recent.map((entry) => entry.id);
      return null;
    };

    try {
      useGlobalSessionStatusStore.setState({ statusById: new Map() });
      await act(async () => root.render(React.createElement(Harness)));
      expect(renderedIds).toEqual([]);

      await act(async () => {
        // SAFETY: This fixture matches the SDK event shape consumed by the status event reducer.
        applyGlobalSessionStatusEvent('/workspace/a', {
          type: 'session.status',
          properties: { sessionID: 'old-root', status: { type: 'busy' } },
        } as Event);
      });
      expect(renderedIds).toEqual(['old-root']);
      const activeRenderCount = renderCount;
      const activeDeriveOperationCount = timeReadCount;

      await act(async () => {
        // SAFETY: This fixture matches the SDK event shape consumed by the status event reducer.
        applyGlobalSessionStatusEvent('/other-workspace', {
          type: 'session.status',
          properties: { sessionID: 'old-root', status: { type: 'retry', attempt: 2, message: 'waiting' } },
        } as Event);
      });
      expect(renderCount).toBe(activeRenderCount);
      expect(timeReadCount).toBe(activeDeriveOperationCount);
    } finally {
      await act(async () => root.unmount());
      useGlobalSessionStatusStore.setState({ statusById: new Map() });
      dom.restore();
    }
  });
});

describe('getDescendantIds', () => {
  test('returns a depth-first subtree without exposing session entities', () => {
    const childA = session('child-a', '/workspace/a');
    const grandchild = session('grandchild', '/workspace/a');
    const childB = session('child-b', '/workspace/a');
    const childrenMap = new Map([
      ['root', [childA, childB]],
      ['child-a', [grandchild]],
    ]);

    expect(getDescendantIds(childrenMap, 'root'))
      .toEqual(['child-a', 'grandchild', 'child-b']);
  });

  test('cuts a parent cycle with deterministic unique descendants and excludes the root', () => {
    const childA = session('a', '/workspace/a');
    const childB = session('b', '/workspace/a');
    const childC = session('c', '/workspace/a');
    const childrenMap = new Map([
      ['root', [childA]],
      ['a', [childB, childC]],
      ['b', [childA]],
    ]);

    expect(getDescendantIds(childrenMap, 'root')).toEqual(['a', 'b', 'c']);
    expect(new Set(getDescendantIds(childrenMap, 'root')).size).toBe(3);
  });
});
