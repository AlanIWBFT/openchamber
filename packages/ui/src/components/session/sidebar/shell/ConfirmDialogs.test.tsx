import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { MultiRunSummary } from '@/lib/multirun/runs';
import type { SessionGroup } from '../types';
import type { BulkDeleteSessionsConfirmState } from './ConfirmDialogs';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  PointerEvent: browser.PointerEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionMultiSelectStore } = await import('@/stores/useSessionMultiSelectStore');
const { useSidebarBulkActions } = await import('../folders/useSidebarBulkActions');
const { SessionRowOrderProvider } = await import('../sessions/sessionRowOrder');
const { ArchiveAllDropdown } = await import('@/components/session/ArchiveAllDropdown');
const { SessionDeleteConfirmDialog, BulkSessionDeleteConfirmDialog } = await import('./ConfirmDialogs');
const { useRunWork } = await import('../sessions/useRunWork');
const { useWorktreeWork } = await import('../works/useWorktreeWork');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');

type BulkActionCapture = {
  actions?: ReturnType<typeof useSidebarBulkActions>;
  confirmation?: BulkDeleteSessionsConfirmState;
};

const initialUI = useUIStore.getState();
const initialSelection = useSessionMultiSelectStore.getState();
const initialSessionUI = useSessionUIStore.getState();
const initialProjects = useProjectsStore.getState();
const session: Session = {
  id: 'target', title: 'Target', directory: '/workspace', projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
};
let root: Root;

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUIStore.setState({ showDeletionDialog: true, showArchiveDialog: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI, true);
  useSessionMultiSelectStore.setState(initialSelection, true);
  useSessionUIStore.setState(initialSessionUI, true);
  useProjectsStore.setState(initialProjects, true);
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const confirmationCheckbox = (): HTMLElement => {
  const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]');
  if (!checkbox) throw new Error('Confirmation preference checkbox missing');
  return checkbox;
};

for (const kind of ['single', 'bulk'] as const) {
  for (const archivedBucket of [true, false]) {
    test(`${kind} ${archivedBucket ? 'delete' : 'archive'} dialog changes only its own preference and can re-enable it`, async () => {
      let confirmed = 0;
      const onConfirm = () => { confirmed += 1; };
      await act(async () => root.render(<I18nProvider>
        {kind === 'single'
          ? <SessionDeleteConfirmDialog value={{ session, descendantCount: 0, descendantIds: [], archivedBucket }} setValue={() => undefined} onConfirm={onConfirm} />
          : <BulkSessionDeleteConfirmDialog value={{ sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket }} setValue={() => undefined} onConfirm={onConfirm} />}
      </I18nProvider>));
      expect(confirmationCheckbox().getAttribute('aria-checked')).toBe('false');
      await act(async () => confirmationCheckbox().click());
      expect(useUIStore.getState()).toMatchObject({ showDeletionDialog: !archivedBucket, showArchiveDialog: archivedBucket });
      expect(confirmationCheckbox().getAttribute('aria-checked')).toBe('true');
      expect(confirmed).toBe(0);
      await act(async () => confirmationCheckbox().click());
      expect(useUIStore.getState()).toMatchObject({ showDeletionDialog: true, showArchiveDialog: true });
      expect(confirmationCheckbox().getAttribute('aria-checked')).toBe('false');
    });
  }
}

const selectArchiveAll = async () => {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Archive all sessions"]');
  if (!trigger) throw new Error('Archive-all trigger missing');
  await act(async () => trigger.click());
  const item = document.querySelector<HTMLElement>('[role="menuitem"]');
  if (!item) throw new Error('Archive-all menu item missing');
  await act(async () => item.click());
};

const clickDialogButton = async (label: string) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((entry) => entry.textContent === label);
  if (!button) throw new Error(`Dialog button missing: ${label}`);
  await act(async () => button.click());
};

for (const showArchiveDialog of [true, false]) {
  test(`archive run always asks before archiving all members with ordinary confirmation=${showArchiveDialog}`, async () => {
    useUIStore.setState({ showArchiveDialog });
    const archived: string[][] = [];
    useSessionUIStore.setState({ archiveSessions: async (ids) => {
      archived.push(ids);
      return { archivedIds: ids, failedIds: [] };
    } });
    const run: MultiRunSummary = {
      key: 'run', title: 'Parallel task', groupSlug: 'task', lanes: [], fusions: [],
      memberIds: ['model-a', 'model-b', 'fusion'], providerIDs: [], variants: [], createdAt: 1, lastActivity: 1,
    };
    const captured: { work?: ReturnType<typeof useRunWork> } = {};
    const Harness = () => {
      const work = useRunWork(run, [], () => undefined);
      captured.work = work;
      return work.archiveDialog;
    };
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    const work = captured.work;
    if (!work) throw new Error('Run actions missing');
    let pending: Promise<void> | undefined;
    await act(async () => { pending = work.archive(); });
    expect(archived).toEqual([]);
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toContain('Their worktree folders will remain.');
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    await clickDialogButton('Cancel');
    await pending;
    expect(archived).toEqual([]);
    await act(async () => { pending = work.archive(); });
    await clickDialogButton('Archive');
    await pending;
    expect(archived).toEqual([run.memberIds]);
    expect(useUIStore.getState().showArchiveDialog).toBe(showArchiveDialog);
  });

  test(`manual worktree archive cancels before work state or navigation with ordinary confirmation=${showArchiveDialog}`, async () => {
    useUIStore.setState({ showArchiveDialog, worktreeArchiveOnDoneEnabled: true });
    useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo' }], activeProjectId: 'project' });
    const group: SessionGroup = {
      id: 'worktree', label: 'Task', branch: 'task', description: null, isMain: false, directory: '/repo/task', sessions: [],
      worktree: { path: '/repo/task', projectDirectory: '/repo', branch: 'task', title: 'Task', label: 'Task' },
    };
    const captured: { work?: ReturnType<typeof useWorktreeWork> } = {};
    let navigations = 0;
    const Harness = () => {
      const work = useWorktreeWork({ group, projectId: 'project', collapsed: true, onNavigate: () => { navigations += 1; } });
      captured.work = work;
      return work.archiveDialog;
    };
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    const work = captured.work;
    if (!work) throw new Error('Worktree actions missing');
    const before = useSessionUIStore.getState();
    let pending: Promise<void> | undefined;
    await act(async () => { pending = work.archive(); });
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toContain('worktree folder removed');
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    expect(useSessionUIStore.getState()).toBe(before);
    await clickDialogButton('Cancel');
    await pending;
    expect(useSessionUIStore.getState()).toBe(before);
    expect(navigations).toBe(0);
    await act(async () => { pending = work.archive(); });
    await act(async () => root.render(null));
    await pending;
    expect(useSessionUIStore.getState()).toBe(before);
    expect(navigations).toBe(0);
  });
}

for (const showDeletionDialog of [true, false]) {
  for (const showArchiveDialog of [true, false]) {
    test(`VS Code archive-all entry always confirms with delete=${showDeletionDialog}, archive=${showArchiveDialog}`, async () => {
      useUIStore.setState({ showDeletionDialog, showArchiveDialog });
      let archived = 0;
      await act(async () => root.render(<I18nProvider>
        <ArchiveAllDropdown onArchiveAll={() => { archived += 1; }} />
      </I18nProvider>));
      await selectArchiveAll();
      expect(archived).toBe(0);
      expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe('Archive all conversations?');
      expect(document.querySelector('[role="checkbox"]')).toBeNull();
      await clickDialogButton('Cancel');
      expect(archived).toBe(0);
      await selectArchiveAll();
      expect(archived).toBe(0);
      await clickDialogButton('Archive');
      expect(archived).toBe(1);
      expect(useUIStore.getState()).toMatchObject({ showDeletionDialog, showArchiveDialog });
    });
  }
}

test('unmounting the VS Code archive-all entry cancels its pending confirmation', async () => {
  let archived = 0;
  await act(async () => root.render(<I18nProvider>
    <ArchiveAllDropdown onArchiveAll={() => { archived += 1; }} />
  </I18nProvider>));
  await selectArchiveAll();
  expect(archived).toBe(0);
  await act(async () => root.render(null));
  expect(archived).toBe(0);
});

for (const hardDelete of [true, false]) {
  for (const showDeletionDialog of [true, false]) {
    for (const showArchiveDialog of [true, false]) {
      test(`bulk ${hardDelete ? 'delete' : 'archive'} uses its own preference with delete=${showDeletionDialog}, archive=${showArchiveDialog}`, async () => {
        useUIStore.setState({ showDeletionDialog, showArchiveDialog });
        useSessionMultiSelectStore.setState({ enabled: true, selectedIds: new Set(['target']), scopeKey: 'project', anchorId: 'target' });
        const calls: string[] = [];
        const capture: BulkActionCapture = {};
        const Harness = () => {
          const [confirmation, setConfirmation] = React.useState<BulkDeleteSessionsConfirmState>(null);
          capture.confirmation = confirmation;
          capture.actions = useSidebarBulkActions({
            isInlineEditing: false, showDeletionDialog, showArchiveDialog, foldersMap: {}, getFolderScopesForProject: () => [],
            addSessionsToFolder: () => undefined, removeSessionsFromFolders: () => undefined, createFolderAndStartRename: () => null,
            archiveSessions: async (ids) => { calls.push('archive'); return { archivedIds: ids, failedIds: [] }; },
            deleteSessions: async (ids) => { calls.push('delete'); return { deletedIds: ids, failedIds: [] }; },
            unarchiveSessions: async (ids) => ({ restoredIds: ids, failedIds: [] }),
            bulkDeleteConfirm: confirmation, setBulkDeleteConfirm: setConfirmation,
          });
          return null;
        };
        await act(async () => root.render(<I18nProvider>
          <SessionRowOrderProvider entries={[]} descendantIds={[]} sessionsById={new Map([['target', { time: { archived: 0 } }]])}>
            <Harness />
          </SessionRowOrderProvider>
        </I18nProvider>));
        await act(async () => {
          if (hardDelete) capture.actions!.handleBulkHardDelete();
          else capture.actions!.handleBulkArchive();
        });
        const needsConfirmation = hardDelete ? showDeletionDialog : showArchiveDialog;
        expect(capture.confirmation?.archivedBucket ?? null).toBe(needsConfirmation ? hardDelete : null);
        if (needsConfirmation) {
          expect(calls).toEqual([]);
          await act(async () => capture.actions!.confirmBulkDelete());
        }
        expect(calls).toEqual([hardDelete ? 'delete' : 'archive']);
      });
    }
  }
}
