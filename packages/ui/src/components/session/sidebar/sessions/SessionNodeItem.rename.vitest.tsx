import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { SessionNodeItemProps } from './SessionNodeItem';

// Run through packages/web's Vitest config so the real row's Vite assets load.
for (const menu of ['context', 'overflow'] as const) {
  test(`${menu} rename closes the real menu and edits only the owning occurrence`, async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
      window: dom, document: dom.document, navigator: dom.navigator,
      localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
      fetch: async () => new Response(null, { status: 503 }),
      Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
      DOMRect: dom.DOMRect,
      MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
      HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
      MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
      CSS: dom.CSS, getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { SessionNodeItem } = await import('./SessionNodeItem');
    const { SyncProvider } = await import('@/sync/sync-context');
    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
    const sdk = createOpencodeClient({ baseUrl: 'http://localhost', fetch: globalThis.fetch });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const noop = () => undefined;
    const session = { id: 'rename-session', slug: 'rename-session', title: 'Original title', directory: '/repo', projectID: 'project', version: '1', time: { created: 1, updated: 1 } };
    const common = {
      node: { session, children: [], worktree: null }, pinnedSessionIds: new Set<string>(), expandedParents: new Set<string>(),
      hasSessionSearchQuery: false, normalizedSessionSearchQuery: '', notifyOnSubtasks: false,
      toggleParent: noop, handleSessionSelect: noop, handleSessionDoubleClick: noop, handleShareSession: noop,
      copiedSessionId: null, handleCopyShareUrl: noop, handleCopySessionId: noop, handleUnshareSession: noop,
      createFolderAndStartRename: () => null, handleDeleteSession: noop, handleRestoreSession: noop,
      startSessionWorktreeMenuLoad: () => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) }),
      mobileVariant: false, alwaysShowActions: true, subtreeContainsEditing: new Set<string>(), nodeStructureKey: session.id,
    } satisfies Partial<SessionNodeItemProps>;
    const saved: string[] = [];
    let scrollAway: () => void = () => { throw new Error('Harness not mounted'); };
    function Harness() {
      const [editingId, setEditingId] = React.useState<string | null>(null);
      const [editingRowKey, setEditingRowKey] = React.useState<string | null>(null);
      const [editTitle, setEditTitle] = React.useState('');
      const [menuKey, setMenuKey] = React.useState<string | null>(null);
      const [offscreen, setOffscreen] = React.useState(false);
      scrollAway = () => setOffscreen(true);
      const cancel = () => { setEditingId(null); setEditingRowKey(null); };
      // Model the virtualizer's pin handoff: closing menus must retain the row
      // until editingRowKey takes ownership, even if it scrolls out of range.
      const rows = ['project-row', 'recent-row'].filter((key) => key !== 'project-row' || !offscreen || menuKey?.endsWith(key) || editingRowKey === key);
      return <I18nProvider><SyncProvider sdk={sdk} directory="/repo">{rows.map((rowKey) => <div key={rowKey} data-test-row={rowKey}>
        <SessionNodeItem {...common} rowKey={rowKey} editingId={editingId} editingRowKey={editingRowKey}
          setEditingId={setEditingId} setEditingRowKey={setEditingRowKey} editTitle={editTitle} setEditTitle={setEditTitle}
          handleSaveEdit={(title) => { saved.push(title ?? editTitle); cancel(); }} handleCancelEdit={cancel}
          openSidebarMenuKey={menuKey} setOpenSidebarMenuKey={setMenuKey} menuOpenSessionId={menuKey ? session.id : null} />
      </div>)}</SyncProvider></I18nProvider>;
    }
    try {
      await act(async () => root.render(<Harness />));
      const row = container.querySelector('[data-test-row="project-row"]');
      if (!row) throw new Error('Missing project row');
      await act(async () => {
        if (menu === 'context') {
          row.querySelector('[data-session-row]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
        } else {
          const trigger = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
          if (!trigger) throw new Error('Missing overflow trigger');
          trigger.click();
        }
      });
      const rename = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === 'Rename');
      if (!rename) throw new Error('Missing rename menu item');
      await act(async () => { rename.click(); scrollAway(); await new Promise((resolve) => setTimeout(resolve, 100)); });
      const input = row.querySelector<HTMLInputElement>('input');
      expect(input).not.toBeNull();
      expect(container.querySelectorAll('input')).toHaveLength(1);
      expect(input?.value).toBe(session.title);
      expect(document.activeElement).toBe(input);
      expect(input?.selectionStart).toBe(0);
      expect(input?.selectionEnd).toBe(session.title.length);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      await act(async () => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      expect(saved).toEqual([session.title]);
      expect(container.querySelector('input')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await dom.happyDOM.abort();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
}
