import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Part, AssistantMessage } from '@/lib/opencode/model';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMessageSelectionStore } from '@/stores/useMessageSelectionStore';
import { useMessageSelectionClicks } from '../messageSelection/useMessageSelectionClicks';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnChangedFile, TurnRecord } from '../lib/turns/types';
import { buildTimelineRows } from '../lib/turns/timelineRows';
import { useTimelineRowIndexes } from '../timeline/useTimelineRowIndexes';
import { useMessageListHandle } from '../timeline/useMessageListHandle';
import type { MessageListHandle, TurnEntry } from '../timeline/types';
import { MessageSliceContext } from '../message/messageSliceContext';
import { useWorkflowRunsStore } from '@/lib/workflows/store';
import type { WorkflowRun } from '@/lib/workflows/model';
import { PendingWorkflowApprovals } from '../workflows/PendingWorkflowApprovals';
import { WorkflowsPanel } from '../workflows/WorkflowsPanel';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncChildStores } from '@/sync/sync-refs';
import { ChatColumnSessionContext } from '../chatColumnSession';

plugin({
    name: 'live-activity-provider-logos',
    setup(build) {
        // Expand Vite's eager asset glob into the same real file URL map for
        // Bun. This is a loader transform, not a replacement of the logo hook.
        build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
            const folder = resolve(dirname(path), '../assets/provider-logos');
            const logos = Object.fromEntries(readdirSync(folder).filter((name) => name.endsWith('.svg'))
                .map((name) => [`../assets/provider-logos/${name}`, pathToFileURL(resolve(folder, name)).href]));
            const contents = readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`);
            return { contents, loader: 'ts' };
        });
    },
});

// Loaded after the plugin: its imports reach the logo glob that Bun cannot
// expand on its own.
const { SegmentContext } = await import('./toolSegmentContext');
const { toolSegments } = await import('../lib/turns/toolSegments');

const unavailable = (): never => { throw new Error('Activity rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get sourceControl() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
};
const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(true);
const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
    setTheme: unexpectedThemeChange, reloadCustomThemes: unexpectedThemeChange, importTheme: unexpectedThemeChange,
    deleteImportedTheme: unexpectedThemeChange, isSystemPreference: false, setSystemPreference: unexpectedThemeChange,
    themeMode: 'dark', setThemeMode: unexpectedThemeChange, lightThemeId: getDefaultTheme(false).metadata.id,
    darkThemeId: theme.metadata.id, setLightThemePreference: unexpectedThemeChange, setDarkThemePreference: unexpectedThemeChange,
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });
// The answer's action bar also has an aria-expanded button, the branch menu
// trigger, so the changed-file toggle is the one that opens no popup.
const changedFilesToggle = () => document.querySelector<HTMLButtonElement>('[data-fixture-message="final"] button[aria-expanded]:not([aria-haspopup])');
let MessageBody: typeof import('../message/MessageBody').default;

function assistant(id: string, parts: Part[], finish?: AssistantMessage['finish']): ChatMessageEntry {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 2, completed: finish ? 3 : undefined },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
    };
    return { info, parts };
}
function text(id: string, content: string): Part {
    return { type: 'text', id, text: content, sessionID: 'session', messageID: 'message' };
}
const readPart: Part = {
    type: 'tool', tool: 'read', id: 'read', callID: 'read', sessionID: 'session', messageID: 'progress',
    state: { status: 'completed', input: { filePath: '/project/source.ts' }, output: 'code', metadata: {}, time: { start: 1, end: 2 } },
};
function turn(messages: ChatMessageEntry[]): TurnRecord {
    return projectTurnRecords([{
        info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } },
        parts: [text('request', 'Request')],
    }, ...messages]).turns[0];
}

// The rows a turn under a fold becomes in the list, drawn the way MessageList draws them.
function TurnRows({ record, expansion, defaultExpanded, onToggle, renderMessage }: {
    record: TurnRecord;
    expansion: ReadonlyMap<string, boolean>;
    defaultExpanded: boolean;
    onToggle: (id: string) => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}) {
    const rows = buildTimelineRows([{ kind: 'turn', key: 'turn', turn: record, isLastTurn: true }], {
        collapsedActivity: !defaultExpanded, expandedTurns: expansion, showReasoningTraces: true,
    }, []);
    const index = toolSegments(record, true);
    const value = { index, preview: index.segments.at(-1), expanded: (id: string) => expansion.get(id) ?? defaultExpanded, toggle: (ids: readonly string[]) => ids.forEach(onToggle) };
    return <SegmentContext.Provider value={value}>
        {rows.map(row => {
            if (row.kind !== 'turn-message') return null;
            const message = record.assistantMessages.find(message => message.info.id === row.messageId)!;
            return <MessageSliceContext.Provider key={row.key} value={row.slice}>{renderMessage(message)}</MessageSliceContext.Provider>;
        })}
    </SegmentContext.Provider>;
}

function SelectionSurface({ children }: { children: React.ReactNode }) {
    const { onClickCapture } = useMessageSelectionClicks('session', '/project');
    return <div onClickCapture={onClickCapture}>{children}</div>;
}

function Harness({ record, isWorking = true, defaultExpanded = false, changedFiles, isLatestTurn = true, onCopyMessage, onCopyTurn }: {
    record: TurnRecord;
    isWorking?: boolean;
    defaultExpanded?: boolean;
    changedFiles?: TurnChangedFile[];
    isLatestTurn?: boolean;
    onCopyMessage?: (messageId: string) => boolean;
    onCopyTurn?: () => Promise<boolean>;
}) {
    const [expansion, setExpansion] = React.useState<ReadonlyMap<string, boolean>>(new Map());
    const renderMessage = (message: ChatMessageEntry) => (
        <div key={message.info.id} data-fixture-message={message.info.id}>
            <MessageBody
                messageId={message.info.id} parts={message.parts} isUser={false}
                isMessageCompleted={message.info.role === 'assistant' && Boolean(message.info.finish)}
                messageFinish={message.info.role === 'assistant' ? message.info.finish : undefined}
                isMobile={false} copiedCode={null} onCopyCode={() => undefined} expandedTools={new Set()}
                onToggleTool={() => undefined} onShowPopup={() => undefined} streamPhase="completed" allowAnimation={false}
                hasTextContent={message.parts.some((part) => part.type === 'text')} showReasoningTraces
                onCopyMessage={onCopyMessage ? () => onCopyMessage(message.info.id) : undefined}
                onCopyTurn={message === record.assistantMessages.at(-1) ? onCopyTurn : undefined}
                turnGroupingContext={{
                    turnId: 'user', isFirstAssistantInTurn: message === record.assistantMessages[0],
                    isLastAssistantInTurn: message === record.assistantMessages.at(-1),
                    isLatestTurn, changedFiles, isWorking, hasTools: record.hasTools, hasReasoning: record.hasReasoning,
                }}
            />
        </div>
    );
    return <RuntimeAPIContext.Provider value={runtimeApis}>
        <ThemeSystemContext.Provider value={themeContext}>
            <SyncProvider sdk={sdk} directory="/project">
                <I18nProvider>
                    <SelectionSurface><TurnRows record={record} expansion={expansion} defaultExpanded={defaultExpanded}
                        onToggle={(id) => setExpansion((value) => new Map(value).set(id, !(value.get(id) ?? defaultExpanded)))} renderMessage={renderMessage} /></SelectionSurface>
                </I18nProvider>
            </SyncProvider>
        </ThemeSystemContext.Provider>
    </RuntimeAPIContext.Provider>;
}

// The first test pays for loading the real message body and for its first
// render. Under the full parallel suite that crossed the 5 second default on
// Windows; later tests take well under a second.
setDefaultTimeout(30_000);

describe('live Activity with the real message body', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;
    beforeEach(async () => {
        const win = new Window({ url: 'http://localhost', settings: { device: { prefersReducedMotion: 'reduce' } } });
        const globals = {
            window: win, document: win.document, Event: win.Event, CustomEvent: win.CustomEvent, navigator: win.navigator, localStorage: win.localStorage,
            customElements: win.customElements, CSS: win.CSS,
            Node: win.Node, NodeList: win.NodeList, Element: win.Element, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement,
            HTMLAnchorElement: win.HTMLAnchorElement,
            MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
            requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        // Reduced motion makes the disclosure lifecycle deterministic without
        // replacing the real component or animation module.
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        useUIStore.setState({ collapsibleThinkingBlocks: false, showSplitAssistantMessageActions: false });
        useDirectoryStore.setState({ currentDirectory: '/project' });
        useI18nStore.getState().setLocale('en');
        MessageBody = (await import('../message/MessageBody')).default;
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        useMessageSelectionStore.getState().end();
        useWorkflowRunsStore.getState().reset();
        restore();
    });

    test('keeps both proposed workflow cards outside Activity while approval is pending', async () => {
        useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: true });
        const proposal = (id: string, messageID: string): Part => ({
            type: 'tool', tool: 'openchamber_workflow', id, callID: id, sessionID: 'session', messageID,
            state: { status: 'completed', input: { action: 'workflow.run' },
                output: JSON.stringify({ ok: true, action: 'workflow.run', data: { runId: id } }),
                time: { start: 1, end: 2 } },
        });
        const runs: WorkflowRun[] = ['first', 'second'].map((id) => ({
            id, parentSessionId: 'session', directory: '/project', name: `Workflow ${id}`, description: 'Review files',
            state: 'awaiting-approval', attempt: 0, createdAt: 1, currentPhase: null, phases: ['Review'], agents: [], logs: [],
        }));
        useWorkflowRunsStore.setState({ bySession: { session: { status: 'ready', runs } } });
        const first = assistant('first-step', [proposal('first', 'first-step')], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([first])} />));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        const second = assistant('second-step', [proposal('second', 'second-step')], 'tool-calls');
        const record = turn([first, second, assistant('final', [text('answer', 'Choose the plans')], 'stop')]);
        await act(async () => root.render(<Harness record={record} />));
        const cards = () => [...container.querySelectorAll('[data-component="workflow-run"]')].map((card) => card.textContent);
        expect(cards()).toHaveLength(2);
        expect(cards()[0]).toContain('Workflow first');
        expect(cards()[1]).toContain('Workflow second');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(cards()).toHaveLength(2);
    });

    test('shows every pending run missing from loaded calls, then hands it over without duplication', async () => {
        useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: true });
        const runs: WorkflowRun[] = ['first', 'second'].map((id) => ({
            id, parentSessionId: 'session', directory: '/project', name: `Workflow ${id}`, description: 'Review files',
            state: 'awaiting-approval', attempt: 0, createdAt: 1, currentPhase: null, phases: [], agents: [], logs: [],
        }));
        useWorkflowRunsStore.setState({ bySession: { session: { status: 'ready', runs } } });
        const draw = (messages: ChatMessageEntry[], sessionId = 'session') => <SyncProvider sdk={sdk} directory="/project">
            <I18nProvider><PendingWorkflowApprovals sessionId={sessionId} messages={messages} /></I18nProvider>
        </SyncProvider>;
        await act(async () => root.render(draw([])));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(2);
        const call: Part = {
            type: 'tool', tool: 'openchamber_workflow', id: 'call', callID: 'call', sessionID: 'session', messageID: 'step',
            state: { status: 'completed', input: { action: 'workflow.run' },
                output: JSON.stringify({ ok: true, action: 'workflow.run', data: { runId: 'first' } }), time: { start: 1, end: 2 } },
        };
        await act(async () => root.render(draw([assistant('step', [call], 'tool-calls')])));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        expect(container.textContent).toContain('Workflow second');
        await act(async () => useWorkflowRunsStore.getState().apply({ ...runs[1], state: 'declined' }));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(0);
        await act(async () => root.render(draw([], 'other')));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(0);
    });

    test('the real live row and footer share workflow call parts while the message snapshot stays stale', async () => {
        // Happy DOM has no layout. Give the real virtualized list a viewport
        // so its row and footer both mount rather than remaining unmeasured.
        const geometry = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            return new window.DOMRect(0, 0, 720, 600);
        });
        const { default: MessageList } = await import('../MessageList');
        // Leave bootstrap pending so only the test publishes the real live store.
        const liveSdk = OpenCode.make({ baseUrl: 'http://workflow.test', fetch: () => new Promise<Response>(() => {}) });
        useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: true, activityRenderMode: 'summary' });
        const run: WorkflowRun = {
            id: 'streaming-run', parentSessionId: 'session', directory: '/project', name: 'Streaming approval', description: 'Review files',
            state: 'awaiting-approval', attempt: 0, createdAt: 1, currentPhase: null, phases: [], agents: [], logs: [],
        };
        useWorkflowRunsStore.setState({ bySession: { session: { status: 'ready', runs: [run] } } });
        const step = assistant('live-step', [text('progress', 'Preparing approval')]);
        const record = turn([step]);
        let messages = [record.userMessage, step];
        const draw = () => <RuntimeAPIContext.Provider value={runtimeApis}>
            <ThemeSystemContext.Provider value={themeContext}>
                <SyncProvider sdk={liveSdk} directory="/project">
                    <I18nProvider>
                        <ChatColumnSessionContext.Provider value={{ sessionId: 'session', directory: '/project' }}>
                            <MessageList sessionKey="session" directory="/project" messages={messages}
                                sessionIsWorking activeStreamingMessageId={messages.at(-1)?.info.id} activeStreamingPhase="streaming" isLoadingOlder={false} />
                        </ChatColumnSessionContext.Provider>
                    </I18nProvider>
                </SyncProvider>
            </ThemeSystemContext.Provider>
        </RuntimeAPIContext.Provider>;
        await act(async () => root.render(draw()));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        const store = getSyncChildStores().getChild('/project');
        if (!store) throw new Error('Expected mounted directory store');
        const call: Part = {
            type: 'tool', tool: 'openchamber_workflow', id: 'live-call', callID: 'live-call', sessionID: 'session', messageID: 'live-step',
            state: { status: 'completed', input: { action: 'workflow.run' },
                output: JSON.stringify({ ok: true, action: 'workflow.run', data: { runId: run.id } }), time: { start: 1, end: 2 } },
        };
        await act(async () => store.setState({ part: { 'live-step': [...step.parts, call] } }));
        expect(messages[1].parts).toEqual(step.parts);
        expect(container.querySelectorAll('[data-turn-row] [data-component="workflow-run"]')).toHaveLength(1);
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        await act(async () => useUIStore.setState({ activityRenderMode: 'collapsed' }));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        // A later step can stream while the preceding completed call still lives
        // only in the part store. Both consumers must keep overlaying that step.
        const next = assistant('next-step', [text('continuation', 'Continuing the work')]);
        messages = [...messages, next];
        await act(async () => root.render(draw()));
        expect(container.querySelectorAll('[data-turn-row] [data-component="workflow-run"]')).toHaveLength(1);
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        geometry.mockRestore();
    });

    test('the real timeline keeps live-only prose when a follow-up prompt retires its turn', async () => {
        const geometry = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            return new window.DOMRect(0, 0, 720, 600);
        });
        const { default: MessageList } = await import('../MessageList');
        const liveSdk = OpenCode.make({ baseUrl: 'http://steering.test', fetch: () => new Promise<Response>(() => {}) });
        useUIStore.setState({ activityRenderMode: 'collapsed' });
        const step = assistant('progress', []);
        const record = turn([step]);
        const original = [record.userMessage, step];
        let messages = original;
        const draw = () => <RuntimeAPIContext.Provider value={runtimeApis}>
            <ThemeSystemContext.Provider value={themeContext}>
                <SyncProvider sdk={liveSdk} directory="/project">
                    <I18nProvider>
                        <ChatColumnSessionContext.Provider value={{ sessionId: 'session', directory: '/project' }}>
                            <MessageList sessionKey="session" directory="/project" messages={messages}
                                sessionIsWorking activeStreamingMessageId="progress" activeStreamingPhase="streaming" isLoadingOlder={false} />
                        </ChatColumnSessionContext.Provider>
                    </I18nProvider>
                </SyncProvider>
            </ThemeSystemContext.Provider>
        </RuntimeAPIContext.Provider>;
        await act(async () => root.render(draw()));
        const store = getSyncChildStores().getChild('/project');
        if (!store) throw new Error('Expected mounted directory store');
        const parts: Part[] = [text('progress-text', 'Still working'), { ...readPart, state: { status: 'running', input: { filePath: '/project/source.ts' }, time: { start: 3 } } }];
        await act(async () => store.setState({ part: { progress: parts } }));
        expect(container.textContent).toContain('Still working');
        messages = [...original, {
            info: { id: 'follow-up', sessionID: 'session', role: 'user', time: { created: 4 } },
            parts: [text('follow-up-text', 'Steer the work')],
        }];
        await act(async () => root.render(draw()));
        expect(container.textContent).toContain('Steer the work');
        expect(container.textContent?.split('Still working')).toHaveLength(2);
        expect(container.querySelector('[data-activity-answer-group]')).toBeNull();
        messages = original;
        await act(async () => root.render(draw()));
        expect(container.textContent?.split('Still working')).toHaveLength(2);
        geometry.mockRestore();
    });

    test('the panel declines through the same endpoint and holds both approval buttons during the request', async () => {
        useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: true });
        useSessionUIStore.setState({ currentSessionId: 'session' });
        const run: WorkflowRun = {
            id: 'pending', parentSessionId: 'session', directory: '/project', name: 'Review files', description: 'Review files',
            state: 'awaiting-approval', attempt: 0, createdAt: 1, currentPhase: null, phases: [], agents: [], logs: [],
        };
        useWorkflowRunsStore.setState({ bySession: { session: { status: 'ready', runs: [run] } }, byDirectory: { '/project': 'ready' } });
        const requests: { url: string; method?: string }[] = [];
        let finish: () => void = () => {};
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            requests.push({ url, method: init?.method });
            if (url.endsWith('/pending/decline')) await new Promise<void>((resolve) => { finish = resolve; });
            return Response.json(url.includes('/saved') ? { workflows: [] } : {});
        });
        try {
            await act(async () => root.render(<I18nProvider><WorkflowsPanel directory="/project" /></I18nProvider>));
            const approve = container.querySelector<HTMLButtonElement>('button[aria-label="Run workflow"]');
            const decline = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === "Don't run");
            expect(approve).not.toBeNull();
            expect(decline).not.toBeNull();
            await act(async () => decline?.click());
            expect(requests.filter((request) => request.url.endsWith('/pending/decline'))).toEqual([
                { url: '/api/openchamber/workflows/pending/decline', method: 'POST' },
            ]);
            expect(approve?.disabled).toBe(true);
            expect(decline?.disabled).toBe(true);
            await act(async () => finish());
            expect(approve?.disabled).toBe(false);
            expect(decline?.disabled).toBe(false);
        } finally {
            finish();
            fetchSpy.mockRestore();
        }
    });

    for (const hidden of [true, false]) test(`a link mounts its offscreen source when its tools ${hidden ? 'are hidden' : 'already fit in the preview'}`, async () => {
        const command = (id: string): Part => ({ ...readPart, id, messageID: id, tool: 'exec_command' });
        const long = assistant('long', Array.from({ length: 100 }, (_, i) => text(`t${i}`, `paragraph ${i}`)));
        const record = turn(hidden ? [long,
            assistant('head', [command('head')]), assistant('source', [command('source')]),
            assistant('last', [text('break', 'Next'), command('latest')])] : [assistant('source', [command('source'), text('quoted', 'Quoted')]), long]);
        const entries: TurnEntry[] = [{ kind: 'turn', key: 'turn:user', turn: record, isLastTurn: true }];
        const ref = React.createRef<MessageListHandle>();
        const requests: number[] = [];
        let sourceIndex = -1;
        function VirtualList() {
            const [expanded, setExpanded] = React.useState<ReadonlyMap<string, boolean>>(new Map());
            const previous = React.useRef<ReturnType<typeof buildTimelineRows>>([]);
            const rows = buildTimelineRows(entries, { collapsedActivity: true, expandedTurns: expanded, showReasoningTraces: true }, previous.current);
            previous.current = rows;
            sourceIndex = rows.findIndex(row => row.kind === 'turn-message' && row.messageId === 'source');
            const indexes = useTimelineRowIndexes(rows, entries, true);
            const listRef = React.useRef({ getScrollableNode: () => container,
                scrollToIndex: async ({ index }: { index: number }) => { requests.push(index); }, scrollToEnd: async () => {} });
            useMessageListHandle(ref, { sessionKey: 'session', rows, indexes, listRef, expandTurnActivity: ids => {
                setExpanded(new Map(ids.map(id => [id, true]))); return true;
            } });
            return null;
        }
        await act(async () => root.render(<VirtualList />));
        expect(sourceIndex).toBe(hidden ? -1 : 1);
        await act(async () => { expect(ref.current?.scrollToMessageId('source')).toBe(true); });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(sourceIndex).toBeGreaterThan(hidden ? 4 : 0);
        expect(requests).toEqual([sourceIndex]);
    });

    for (const mode of ['collapsed', 'summary'] as const) test(`live segments and position restore respect the ${mode} preference`, async () => {
        const geometry = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new window.DOMRect(0, 0, 720, 600));
        const { default: MessageList } = await import('../MessageList');
        const liveSdk = OpenCode.make({ baseUrl: 'http://preview.test', fetch: () => new Promise<Response>(() => {}) });
        const previousReasoning = useUIStore.getState().showReasoningTraces;
        useUIStore.setState({ activityRenderMode: mode, showReasoningTraces: false });
        const list = React.createRef<import('../MessageList').MessageListHandle>();
        const command = (id: string, messageID: string): Part => ({
            type: 'tool', tool: 'exec_command', id, callID: id, sessionID: 'session', messageID,
            state: { status: 'completed', input: { cmd: id }, output: '', time: { start: 1, end: 2 } },
        });
        const first = assistant('first', [command('old-command', 'first')], 'stop');
        const thought = (messageID: string): Part => ({ type: 'reasoning', id: `thinking-${messageID}`, messageID, sessionID: 'session', text: 'Checking', time: { start: 1, end: 2 } });
        first.parts.unshift(thought('first'));
        const older = assistant('older', [thought('older'), command('older-command', 'older')], 'tool-calls');
        const prompt = turn([first]).userMessage;
        const second = assistant('second', [text('reply', 'Second reply')]);
        const messages = [prompt, older, first, { info: { ...prompt.info, id: 'next-user' }, parts: [text('next', 'Next prompt')] }, second];
        try {
            await act(async () => root.render(<RuntimeAPIContext.Provider value={runtimeApis}>
                <ThemeSystemContext.Provider value={themeContext}><SyncProvider sdk={liveSdk} directory="/project"><I18nProvider>
                    <ChatColumnSessionContext.Provider value={{ sessionId: 'session', directory: '/project' }}>
                        <MessageList ref={list} sessionKey="session" directory="/project" messages={messages} activeStreamingMessageId="second" scrollContainerProps={{ 'data-scrollbar': 'chat' }}
                            sessionIsWorking activeStreamingPhase="streaming" isLoadingOlder={false} />
                    </ChatColumnSessionContext.Provider>
                </I18nProvider></SyncProvider></ThemeSystemContext.Provider>
            </RuntimeAPIContext.Provider>));
            expect(container.textContent).toContain('old-command');
            const store = getSyncChildStores().getChild('/project');
            if (!store) throw Error('Expected mounted directory store');
            const parts = [...second.parts, ...Array.from({ length: 9 }, (_, i) => command(`new-command-${i}`, 'second'))];
            await act(async () => store.setState({ part: { second: parts } }));
            const oldHeader = container.querySelector<HTMLButtonElement>('[data-tool-segment="user:work:older-command"]');
            const liveHeader = container.querySelector<HTMLButtonElement>('[data-tool-segment="next-user:work:new-command-0"]');
            expect(oldHeader?.hasAttribute('data-message-select-unit')).toBe(false);
            expect(liveHeader?.getAttribute('data-message-select-unit')).toBe('answer:next-user');
            expect(liveHeader?.getAttribute('aria-expanded')).toBe(String(mode === 'summary'));
            if (mode === 'summary') {
                expect(container.textContent).toContain('new-command-0');
                await act(async () => liveHeader?.click());
                expect(container.textContent).not.toContain('new-command-0');
                return;
            }
            expect(container.textContent).not.toContain('old-command');
            expect(container.textContent).not.toContain('new-command-1');
            expect(container.textContent).toContain('new-command-2');
            expect(container.textContent).toContain('new-command-8');
            for (const messageId of ['older', 'first']) {
                await act(async () => {
                    expect(list.current?.alignViewportAnchor({ messageId, offsetTop: 0 })).toBe('aligned');
                });
                expect(oldHeader?.getAttribute('aria-expanded')).toBe('false');
            }
            // The saved message used to extend 96px above the viewport. Its
            // replacement header is only 32px tall, so reusing -96 would hide it.
            const scroller = container.querySelector<HTMLElement>('[data-scrollbar="chat"]');
            if (!scroller || !oldHeader) throw Error('Expected a scrollable timeline and folded header');
            scroller.scrollTop = 96;
            oldHeader.getBoundingClientRect = () => new window.DOMRect(0, 0 - scroller.scrollTop, 720, 32);
            const saved = { messageId: 'first', offsetTop: -96 };
            expect(list.current?.alignViewportAnchor({ ...saved, messageId: 'older' })).toBe('moved');
            expect(oldHeader.getBoundingClientRect().top).toBe(0);
            scroller.scrollTop = 96;
            expect(list.current?.alignViewportAnchor(saved)).toBe('moved');
            expect(list.current?.alignViewportAnchor(saved)).toBe('aligned');
            expect(oldHeader.getBoundingClientRect().top).toBe(0);
            expect(oldHeader.getAttribute('aria-expanded')).toBe('false');
            // A link to the same hidden source, unlike re-entry, explicitly reveals it.
            await act(async () => {
                expect(list.current?.alignViewportAnchor({ messageId: 'first', offsetTop: 0 }, true)).toBe('moved');
            });
            expect(oldHeader?.getAttribute('aria-expanded')).toBe('true');
            expect(container.textContent).toContain('old-command');
            const source = container.querySelector<HTMLElement>('[data-message-id="first"]');
            if (!source) throw Error('Expected the revealed source message');
            source.getBoundingClientRect = () => new window.DOMRect(0, 0 - scroller.scrollTop, 720, 250);
            expect(list.current?.alignViewportAnchor(saved)).toBe('moved');
            expect(source.getBoundingClientRect().top).toBe(-96);
            expect(container.textContent).not.toContain('new-command-1');
        } finally {
            useUIStore.setState({ showReasoningTraces: previousReasoning });
            geometry.mockRestore();
        }
    });

    test('a tool segment toggles in place without reloading the page between answers', async () => {
        const tools = (prefix: string, length: number) => Array.from({ length }, (_, i): Part => ({
            type: 'tool', tool: 'exec_command', id: prefix + i, callID: prefix + i, messageID: 'step', sessionID: 'session',
            state: { status: 'completed', input: { cmd: prefix + i }, output: '',
                metadata: { execDisplay: 'root', exitCode: i === 0 ? 1 : 0 }, time: { start: 1, end: 2 } },
        }));
        const page: Part = { ...readPart, id: 'page', tool: 'openchamber_render', callID: 'page', state: {
            status: 'running', input: { html: '<input name="draft">', title: 'Pick', awaitAnswer: true }, time: { start: 1 },
        } };
        const record = turn([assistant('step', [...tools('old-', 2), text('lead', 'Before page'), page, text('after', 'After page'),
            ...tools('middle-', 5), text('next', 'Second answer'), ...tools('new-', 9)], 'tool-calls')]);
        const draw = (working: boolean) => act(async () => root.render(<Harness record={record} isWorking={working} />));
        await draw(true);
        const controls = [...container.querySelectorAll<HTMLButtonElement>('[data-tool-segment]')];
        expect(controls).toHaveLength(3);
        expect(controls[0].textContent).toContain('Ran 2 commands');
        expect(controls[0].textContent).not.toContain('exec_command');
        expect(controls[1].textContent).toContain('Ran 5 commands');
        expect(controls[0].textContent).not.toContain('Failed:');
        const frame = container.querySelector('iframe');
        expect(frame?.title).toBe('Pick');
        const order = ['Before page', 'title="Pick"', 'After page', 'Second answer'].map(s => container.innerHTML.indexOf(s));
        expect(order.every((p, i) => p >= 0 && (!i || p > order[i - 1]))).toBe(true);
        expect(container.textContent).not.toContain('old-0');
        expect(container.textContent).not.toContain('middle-1');
        expect(container.textContent).not.toContain('middle-4');
        expect(container.textContent).not.toContain('new-1');
        expect(container.textContent).toContain('new-2');
        await act(async () => useMessageSelectionStore.getState().begin('session', 'prompt:user'));
        await act(async () => controls[0].click());
        expect([...useMessageSelectionStore.getState().selection!.keys]).toEqual(['prompt:user', 'answer:user']);
        expect(controls[0].getAttribute('aria-expanded')).toBe('false');
        await act(async () => useMessageSelectionStore.getState().end());
        await act(async () => controls[0].click());
        expect(container.textContent).toContain('old-0');
        expect(container.textContent).not.toContain('middle-1');
        await draw(false);
        expect(container.querySelector('iframe')).toBe(frame);
        expect(controls[0].getAttribute('aria-expanded')).toBe('true');
    });
    test('a hidden poll at a virtual slice boundary never draws the following answer or form twice', async () => {
        const calls = Array.from({ length: 48 }, (_, i): Part => ({
            ...readPart, id: `call-${i}`, callID: `call-${i}`, tool: i === 24 ? 'poll_exec' : 'exec_command',
        }));
        const page: Part = { ...readPart, id: 'page', tool: 'openchamber_render', state: {
            status: 'running', input: { html: '<input>', title: 'Question', awaitAnswer: true }, time: { start: 1 },
        } };
        await act(async () => root.render(<Harness record={turn([assistant('step', [...calls, text('answer', 'One explanation'), page])])} />));
        expect(container.textContent?.split('One explanation').length).toBe(2);
        expect(container.querySelectorAll('iframe[title="Question"]').length).toBe(1);
    });
    test('a completed, collapsed Script shows its still-running command beyond the preview budget', async () => {
        const script: Part = { ...readPart, id: 'script', tool: 'execute', state: { status: 'completed', time: { start: 1, end: 2 }, input: {}, output: '',
            metadata: { toolCalls: [{ id: 'worker', name: 'exec_command', tool: 'functions.exec_command', status: 'completed',
                time: { start: 1, end: 2 }, input: { cmd: 'long-running-child' }, metadata: {
                    command: 'long-running-child', processRunning: true, execDisplay: 'root', execID: 42, sessionExposed: true,
                } }] } } };
        const calls = Array.from({ length: 8 }, (_, i): Part => ({ ...readPart, tool: 'exec_command', id: `cmd-${i}`, callID: `cmd-${i}` }));
        await act(async () => root.render(<Harness record={turn([assistant('step', [script, ...calls], 'tool-calls')])} />));
        expect(container.querySelector('[data-tool-segment]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).toContain('long-running-child');
    });
    test('the answer copies the whole turn while each earlier step copies only itself', async () => {
        useUIStore.setState({ showSplitAssistantMessageActions: true });
        const copiedMessages: string[] = [];
        let copiedTurns = 0;
        const progress = assistant('progress', [text('progress-text', 'Checking the source'), readPart], 'tool-calls');
        const final = assistant('final', [text('final-text', 'The final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])}
            onCopyMessage={(messageId) => { copiedMessages.push(messageId); return true; }}
            onCopyTurn={async () => { copiedTurns += 1; return true; }} />));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());

        const copyButton = (messageId: string) => container.querySelector<HTMLButtonElement>(
            `[data-fixture-message="${messageId}"] button[aria-label="Copy message text"]`,
        );
        await act(async () => copyButton('final')?.click());
        expect(copiedTurns).toBe(1);
        expect(copiedMessages).toEqual([]);

        await act(async () => copyButton('progress')?.click());
        expect(copiedTurns).toBe(1);
        expect(copiedMessages).toEqual(['progress']);
    });

    test('shows at most four changed files and folds the rest into one chip, including at the threshold', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        for (const count of [0, 1, 3, 4, 5, 100]) {
            const files = Array.from({ length: count }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
            await act(async () => root.render(<Harness record={record} changedFiles={files} />));
            expect(container.querySelectorAll('button[aria-label^="Open src/file-"]')).toHaveLength(Math.min(count, 4));
            const toggle = changedFilesToggle();
            if (count <= 4) {
                expect(toggle).toBeNull();
            } else {
                expect(toggle?.textContent).toBe(`+${count - 4}`);
                expect(toggle?.getAttribute('aria-label')).toBe(`Other changed files (${count - 4})`);
                expect(toggle?.getAttribute('aria-expanded')).toBe('false');
                expect(container.textContent).not.toContain('file-4.ts');
            }
        }
    });

    test('reveals the rest in source order, keeps them through updates and locale changes, then hides them with focus intact', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        const files = Array.from({ length: 100 }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
        await act(async () => root.render(<Harness record={record} changedFiles={files} />));
        const toggle = changedFilesToggle();
        if (!toggle) throw new Error('Missing changed-file toggle');
        toggle.focus();
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.getAttribute('aria-label')).toBe('Show fewer files');
        expect(Array.from(container.querySelectorAll('button[aria-label^="Open src/file-"]'), (button) => button.getAttribute('title')))
            .toEqual(files.map((file) => file.file));
        expect(toggle.previousElementSibling?.getAttribute('title')).toBe('src/file-99.ts');
        await act(async () => root.render(<Harness record={record} changedFiles={[...files]} />));
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        await act(async () => {
            useI18nStore.getState().setLocale('uk');
            await import('@/lib/i18n/messages/uk');
        });
        expect(toggle.getAttribute('aria-label')).toBe('Показати менше файлів');
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.textContent).toBe('+96');
        expect(toggle.getAttribute('aria-label')).toBe('Інші змінені файли (96)');
        expect(document.activeElement).toBe(toggle);
        expect(container.textContent).not.toContain('file-4.ts');
        expect(container.querySelectorAll('button[aria-label^="Відкрити src/file-"]')).toHaveLength(4);
    });

    test('a file without line counts shows its name alone, and one outside the turn diff is not a button', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        await act(async () => root.render(<Harness record={record} changedFiles={[
            { file: 'src/a.ts' },
            { file: 'src/b.ts', additions: 1, deletions: 2 },
            { file: 'src/c.ts', additions: 1, deletions: 0, inTurnDiff: false },
        ]} />));
        expect(container.querySelector('button[aria-label="Open src/a.ts"]')?.textContent).toBe('a.ts');
        expect(container.querySelector('button[aria-label="Open src/b.ts"]')?.textContent).toBe('b.ts+1 −2');
        expect(container.querySelector('button[aria-label="Open src/c.ts"]')).toBeNull();
        expect(container.querySelector('span[title="src/c.ts"]')?.textContent).toBe('c.ts+1 −0');
    });

    test('keeps historical files informational and withholds the list before stop', async () => {
        const files = Array.from({ length: 5 }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
        const final = assistant('final', [text('answer', 'Done')], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([final])} changedFiles={files} isLatestTurn={false} />));
        expect(container.textContent).not.toContain('file-0.ts');
        await act(async () => root.render(<Harness record={turn([assistant('final', final.parts, 'stop')])} changedFiles={files} isLatestTurn={false} />));
        expect(container.textContent).toContain('file-0.ts');
        await act(async () => changedFilesToggle()?.click());
        expect(container.textContent).toContain('file-4.ts');
        expect(container.querySelectorAll('button[aria-label^="Open src/file-"]')).toHaveLength(0);
    });
});
