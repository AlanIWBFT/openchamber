import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const restrictToXAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

/**
 * Sortable shell for the active tab: the pill itself drags, while the
 * interactive content inside (rename form, menu) stops pointer-down so a text
 * selection or menu click never starts a drag. The close button and the
 * session menu (passed down from the header) reveal on hover, exactly like on
 * inactive tabs.
 */
const ActiveTabShell: React.FC<{
  id: string;
  menu: React.ReactNode;
  menuOpen: boolean;
  onClose: () => void;
  closeLabel: string;
  children: React.ReactNode;
}> = ({ id, menu, menuOpen, onClose, closeLabel, children }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn('session-tab-slot flex h-7 w-44 shrink-0 touch-none', isDragging && 'z-10 opacity-60')}
      data-active-session-tab
      data-active="true"
      {...attributes}
      {...listeners}
    >
      <div
        role="tab"
        aria-selected
        className="group/session-tab relative flex h-7 w-full min-w-0 items-center rounded-md bg-interactive-selection px-2"
      >
        <div className={cn('min-w-0 flex-1', 'group-hover/session-tab:pr-10', menuOpen && 'pr-10')}>
          {children}
        </div>
        <div
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            'absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5',
            'opacity-0 transition-opacity duration-150',
            'group-hover/session-tab:flex group-hover/session-tab:opacity-100',
            menuOpen && 'flex opacity-100',
          )}
        >
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <Icon name="close" className="size-4" />
          </button>
          {menu}
        </div>
      </div>
    </div>
  );
};

type SessionTab = { id: string; session: Session };

/**
 * One inactive tab: a soft pill with the session title. The "..." menu trigger
 * has no reserved footprint — it appears at the tab's end on hover (or while
 * its menu is open), nudging the title, mirroring the sidebar row mechanic.
 * The reveal itself is opacity-only; the layout change is instant.
 */
const InactiveSessionTab: React.FC<{
  tab: SessionTab;
  onSelect: (tab: SessionTab) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
}> = ({ tab, onSelect, onClose, onCloseOthers }) => {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  const title = tab.session.title?.trim() || t('sessions.sidebar.session.untitled');

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn('session-tab-slot flex h-7 w-44 shrink-0', isDragging && 'z-10 opacity-60')}
      data-active="false"
      {...attributes}
      {...listeners}
    >
      <div
        role="tab"
        aria-selected={false}
        tabIndex={0}
        onClick={() => onSelect(tab)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(tab);
          }
        }}
        onAuxClick={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            onClose(tab.id);
          }
        }}
        className={cn(
          'group/session-tab relative flex h-7 w-full min-w-0 cursor-pointer touch-none select-none items-center rounded-md px-2',
          'text-muted-foreground transition-colors duration-150 hover:bg-interactive-hover hover:text-foreground',
          menuOpen && 'bg-interactive-hover text-foreground',
        )}
        title={title}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] font-medium leading-4',
            'group-hover/session-tab:pr-10',
            menuOpen && 'pr-10',
          )}
        >
          {title}
        </span>
        <div
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            'absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5',
            'opacity-0 transition-opacity duration-150',
            'group-hover/session-tab:flex group-hover/session-tab:opacity-100',
            menuOpen && 'flex opacity-100',
          )}
        >
          <button
            type="button"
            aria-label={t('header.sessionTabs.closeTab')}
            onClick={() => onClose(tab.id)}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <Icon name="close" className="size-4" />
          </button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('header.sessionTabs.tabMenuAria')}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <Icon name="more" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[190px]">
            <DropdownMenuItem onClick={() => onClose(tab.id)}>
              <Icon name="close" className="mr-2 size-4" />
              {t('header.sessionTabs.closeTab')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onCloseOthers(tab.id)}>
              <Icon name="close-circle" className="mr-2 size-4" />
              {t('header.sessionTabs.closeOtherTabs')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void copyTextToClipboard(tab.id)}>
              <Icon name="file-copy" className="mr-2 size-4" />
              {t('sessions.sidebar.session.menu.copyId')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>
    </div>
  );
};

/**
 * The header's horizontal working set of sessions (web/desktop only).
 *
 * Every session the user opens joins the strip once; the tab whose session is
 * current renders `children` — the header's existing title block with rename,
 * meta row and the full session menu — inside a softly selected pill. Closing
 * a tab only removes it from the strip; closing the active one activates its
 * neighbour. Ids whose session has not loaded (or was archived/deleted) stay
 * in the store but do not render, so a partial session list never destroys
 * the working set.
 */
export const SessionTabsStrip: React.FC<{
  /** The header's session menu for the active tab (already a DropdownMenu). */
  menu?: React.ReactNode;
  /** Whether that menu is open, so the hover overlay stays visible. */
  menuOpen?: boolean;
  children: React.ReactNode;
}> = ({ menu = null, menuOpen = false, children }) => {
  const { t } = useI18n();
  const tabIds = useSessionTabsStore((state) => state.tabIds);
  const ensureTab = useSessionTabsStore((state) => state.ensureTab);
  const closeTab = useSessionTabsStore((state) => state.closeTab);
  const closeOtherTabs = useSessionTabsStore((state) => state.closeOtherTabs);
  const reorderTabs = useSessionTabsStore((state) => state.reorderTabs);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);

  // Opening a session anywhere (sidebar, palette, deep link) adds its tab.
  React.useEffect(() => {
    if (currentSessionId) ensureTab(currentSessionId);
  }, [currentSessionId, ensureTab]);

  const sessionsById = React.useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of activeSessions) map.set(session.id, session);
    return map;
  }, [activeSessions]);

  // Only tabs with a known live session render; unknown ids stay stored.
  const tabs = React.useMemo<SessionTab[]>(() => {
    const list: SessionTab[] = [];
    for (const id of tabIds) {
      const session = sessionsById.get(id);
      if (session) list.push({ id, session });
    }
    return list;
  }, [tabIds, sessionsById]);

  const handleSelect = React.useCallback((tab: SessionTab) => {
    setCurrentSession(tab.id, resolveGlobalSessionDirectory(tab.session));
  }, [setCurrentSession]);

  const activateNeighbour = React.useCallback((closedId: string) => {
    const index = tabs.findIndex((tab) => tab.id === closedId);
    const neighbour = tabs[index + 1] ?? tabs[index - 1] ?? null;
    if (neighbour) {
      handleSelect(neighbour);
    } else {
      openNewSessionDraft();
    }
  }, [tabs, handleSelect, openNewSessionDraft]);

  const handleClose = React.useCallback((id: string) => {
    if (id === currentSessionId) activateNeighbour(id);
    closeTab(id);
  }, [activateNeighbour, closeTab, currentSessionId]);

  const handleCloseOthers = React.useCallback((id: string) => {
    closeOtherTabs(id);
    if (currentSessionId && currentSessionId !== id) {
      const kept = tabs.find((tab) => tab.id === id);
      if (kept) handleSelect(kept);
    }
  }, [closeOtherTabs, currentSessionId, handleSelect, tabs]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderTabs(String(active.id), String(over.id));
    }
  }, [reorderTabs]);

  // Soft fade at the edges while more tabs hide behind them.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  const updateEdges = React.useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const left = node.scrollLeft > 2;
    const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  React.useEffect(() => {
    updateEdges();
    const node = scrollRef.current;
    if (!node || !globalThis.ResizeObserver) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateEdges, tabs.length]);

  // Keep the active tab in view when it changes.
  React.useEffect(() => {
    scrollRef.current
      ?.querySelector('[data-active-session-tab]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentSessionId]);

  const maskImage = edges.left && edges.right
    ? 'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)'
    : edges.left
      ? 'linear-gradient(to right, transparent, black 24px)'
      : edges.right
        ? 'linear-gradient(to right, black calc(100% - 24px), transparent)'
        : undefined;

  const tabIdsInOrder = React.useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const renderTab = (tab: SessionTab) => {
    if (tab.id === currentSessionId) {
      return (
        <ActiveTabShell
          key={tab.id}
          id={tab.id}
          menu={menu}
          menuOpen={menuOpen}
          onClose={() => handleClose(tab.id)}
          closeLabel={t('header.sessionTabs.closeTab')}
        >
          {children}
        </ActiveTabShell>
      );
    }
    return (
      <InactiveSessionTab
        key={tab.id}
        tab={tab}
        onSelect={handleSelect}
        onClose={handleClose}
        onCloseOthers={handleCloseOthers}
      />
    );
  };

  // A brand-new draft (no session yet) shows as a transient active pill after
  // the tabs; it becomes a real tab once the first message creates the session.
  const showDraftPill = !currentSessionId || !tabs.some((tab) => tab.id === currentSessionId);

  return (
    <div className="app-region-no-drag flex h-full min-w-0 flex-1 items-center" role="tablist" aria-label={t('header.sessionTabs.stripAria')}>
      <div
        ref={scrollRef}
        onScroll={updateEdges}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToXAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={tabIdsInOrder} strategy={horizontalListSortingStrategy}>
            {tabs.map(renderTab)}
          </SortableContext>
        </DndContext>
        {showDraftPill ? (
          <div
            role="tab"
            aria-selected
            className="session-tab-slot flex h-7 w-44 shrink-0 items-center rounded-md bg-interactive-selection px-2"
            data-active="true"
          >
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
