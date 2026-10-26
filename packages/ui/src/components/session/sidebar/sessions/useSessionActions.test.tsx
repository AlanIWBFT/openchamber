import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { I18nProvider } from '@/lib/i18n';
import type { DeleteSessionConfirmState } from '../shell/ConfirmDialogs';
import { useSessionActions } from './useSessionActions';
import { installHookTestDom } from '../test-utils/testDom';

type SessionActionCapture = {
  actions?: ReturnType<typeof useSessionActions>;
  confirmation?: DeleteSessionConfirmState;
};

const session = (id: string): Session => ({
  id,
  projectID: 'project',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: id,
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

describe('explicit session row behavior', () => {
  const sources: Array<{
    name: string;
    source: Parameters<ReturnType<typeof useSessionActions>['handleDeleteSession']>[1];
    hardDelete: boolean;
    bypass?: boolean;
  }> = [
    { name: 'archive', source: undefined, hardDelete: false },
    { name: 'archived delete', source: { archivedBucket: true }, hardDelete: true },
    { name: 'active hard delete', source: { hardDelete: true }, hardDelete: true },
    { name: 'quick archive', source: { skipConfirm: true }, hardDelete: false, bypass: true },
    { name: 'quick delete', source: { hardDelete: true, skipConfirm: true }, hardDelete: true, bypass: true },
  ];
  for (const { name, source, hardDelete, bypass } of sources) {
    for (const showDeletionDialog of [true, false]) {
      for (const showArchiveDialog of [true, false]) {
        test(`${name} uses its own preference with delete=${showDeletionDialog}, archive=${showArchiveDialog}`, async () => {
          const dom = installHookTestDom();
          const root = createRoot(dom.container);
          const original = useSessionUIStore.getState();
          const calls: string[] = [];
          useSessionUIStore.setState({
            archiveSession: async (id) => { calls.push(`archive:${id}`); return true; },
            deleteSession: async (id) => { calls.push(`delete:${id}`); return true; },
          });
          const capture: SessionActionCapture = {};
          const Harness = () => {
            const [confirmation, setConfirmation] = React.useState<DeleteSessionConfirmState>(null);
            capture.confirmation = confirmation;
            capture.actions = useSessionActions({
              mobileVariant: false, allowReselect: false, resetSessionSearch: () => undefined,
              descendantIds: [], showDeletionDialog, showArchiveDialog,
              setDeleteSessionConfirm: setConfirmation, deleteSessionConfirm: confirmation,
              setEditingId: () => undefined, setEditingRowKey: () => undefined, editingSessionId: 'target',
              editingOccurrenceKey: 'project:target', setEditTitle: () => undefined, editingId: null, editTitle: '',
            });
            return null;
          };
          try {
            await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
            await act(async () => capture.actions!.handleDeleteSession(session('target'), source));
            const needsConfirmation = !bypass && (hardDelete ? showDeletionDialog : showArchiveDialog);
            expect(capture.confirmation?.archivedBucket ?? null).toBe(needsConfirmation ? hardDelete : null);
            if (needsConfirmation) {
              expect(calls).toEqual([]);
              await act(async () => capture.actions!.confirmDeleteSession());
            }
            expect(calls).toEqual([`${hardDelete ? 'delete' : 'archive'}:target`]);
          } finally {
            await act(async () => root.unmount());
            useSessionUIStore.setState(original, true);
            dom.restore();
          }
        });
      }
    }
  }

  test('shares edit and menu state across project and Recent render contexts', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    type SharedRowCapture = {
      actions?: ReturnType<typeof useSessionActions>;
      editingId?: string | null;
      editingRowKey?: string | null;
      editTitle?: string;
      menuKey?: string | null;
      setMenuKey?: (key: string | null) => void;
      project?: { editingId: string | null; editTitle: string; menuKey: string | null };
      recent?: { editingId: string | null; editTitle: string; menuKey: string | null };
    };
    const capture: SharedRowCapture = {};
    const RowConsumer = ({ context, editingId, editTitle, menuKey }: {
      context: 'project' | 'recent';
      editingId: string | null;
      editTitle: string;
      menuKey: string | null;
    }) => {
      capture[context] = { editingId, editTitle, menuKey };
      return null;
    };
    const Harness = () => {
      const [editingId, setEditingId] = React.useState<string | null>(null);
      const [editingRowKey, setEditingRowKey] = React.useState<string | null>(null);
      const [editTitle, setEditTitle] = React.useState('');
      const [menuKey, setMenuKey] = React.useState<string | null>(null);
      const [confirmation, setConfirmation] = React.useState<DeleteSessionConfirmState>(null);
      capture.actions = useSessionActions({
        mobileVariant: false,
        allowReselect: false,
        resetSessionSearch: () => undefined,
        descendantIds: [],
        showDeletionDialog: true,
        showArchiveDialog: true,
        setDeleteSessionConfirm: setConfirmation,
        deleteSessionConfirm: confirmation,
        editingId,
        setEditingId,
        setEditingRowKey,
        editingSessionId: 'same-session',
        editingOccurrenceKey: 'project:session:same-session',
        editTitle,
        setEditTitle,
      });
      capture.editingId = editingId;
      capture.editingRowKey = editingRowKey;
      capture.editTitle = editTitle;
      capture.menuKey = menuKey;
      capture.setMenuKey = setMenuKey;
      return React.createElement(React.Fragment, null,
        React.createElement(RowConsumer, { context: 'project', editingId, editTitle, menuKey }),
        React.createElement(RowConsumer, { context: 'recent', editingId, editTitle, menuKey }),
      );
    };
    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      await act(async () => capture.actions!.handleSessionDoubleClick('same-session', 'Shared title'));
      expect(capture.editingId).toBe('same-session');
      expect(capture.editingRowKey).toBe('project:session:same-session');
      expect(capture.editTitle).toBe('Shared title');
      expect(capture.project).toEqual(capture.recent);
      await act(async () => capture.setMenuKey!('recent:active:same-session'));
      expect(capture.menuKey).toBe('recent:active:same-session');
      expect(capture.project).toEqual(capture.recent);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('executes the immutable descendant snapshot captured when confirmation opens', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const original = useSessionUIStore.getState();
    const archivedCalls: string[][] = [];
    useSessionUIStore.setState({
      archiveSessions: async (ids) => {
        archivedCalls.push(ids);
        return { archivedIds: ids, failedIds: [] };
      },
    });
    const descendants = ['child-a', 'child-b'];
    type ConfirmationCapture = {
      actions?: ReturnType<typeof useSessionActions>;
      confirmation?: DeleteSessionConfirmState;
    };
    const capture: ConfirmationCapture = {};
    const Harness = () => {
      const [editingId, setEditingId] = React.useState<string | null>(null);
      const [, setEditingRowKey] = React.useState<string | null>(null);
      const [editTitle, setEditTitle] = React.useState('');
      const [confirmation, setConfirmation] = React.useState<DeleteSessionConfirmState>(null);
      capture.confirmation = confirmation;
      capture.actions = useSessionActions({
        mobileVariant: false,
        allowReselect: false,
        resetSessionSearch: () => undefined,
        descendantIds: descendants,
        showDeletionDialog: true,
        showArchiveDialog: true,
        setDeleteSessionConfirm: setConfirmation,
        deleteSessionConfirm: confirmation,
        editingId,
        setEditingId,
        setEditingRowKey,
        editingSessionId: 'root',
        editingOccurrenceKey: 'project:session:root',
        editTitle,
        setEditTitle,
      });
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      await act(async () => capture.actions!.handleDeleteSession(session('root')));
      expect(capture.confirmation?.descendantIds).toEqual(['child-a', 'child-b']);
      await act(async () => capture.actions!.confirmDeleteSession());
      expect(archivedCalls).toEqual([['root', 'child-a', 'child-b']]);
    } finally {
      await act(async () => root.unmount());
      useSessionUIStore.setState({ archiveSessions: original.archiveSessions });
      dom.restore();
    }
  });
});
