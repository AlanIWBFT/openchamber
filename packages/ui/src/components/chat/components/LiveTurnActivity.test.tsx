import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, jest, setDefaultTimeout, test } from 'bun:test';
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
import { SyncProvider, useDirectoryStore as useSyncDirectoryStore } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { applyRetryOverlay } from '../lib/turns/applyRetryOverlay';
import type { ChatMessageEntry, TurnChangedFile, TurnRecord } from '../lib/turns/types';
import { LiveTurnActivity } from './LiveTurnActivity';
import { createTurnMessageWindowStore, TurnMessageWindowContext } from '../lib/turns/turnMessageWindow';

plugin({
    name: 'live-activity-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
        }));
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
let ChatMessage: typeof import('../ChatMessage').default;

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

function Harness({ record, realMessage = false, retired = false, changedFiles, isLatestTurn = true, isWorking = true, showReasoning = true, defaultExpanded = false, onCopyMessage, onCopyTurn }: {
    record: TurnRecord;
    realMessage?: boolean;
    retired?: boolean;
    changedFiles?: TurnChangedFile[];
    isLatestTurn?: boolean;
    onCopyMessage?: (messageId: string) => boolean;
    onCopyTurn?: () => Promise<boolean>;
    isWorking?: boolean;
    showReasoning?: boolean;
    defaultExpanded?: boolean;
}) {
    const [expanded, setExpanded] = React.useState(defaultExpanded);
    const [segmentExpansion, setSegmentExpansion] = React.useState(new Map<string, boolean>());
    const [expandedTools, setExpandedTools] = React.useState(new Set<string>());
    const renderMessage = (message: ChatMessageEntry) => realMessage ? (
        <ChatMessage key={message.info.id} message={message} assistantHeaderMessageId={record.assistantMessages[0]?.info.id} />
    ) : (
        <div key={message.info.id} data-fixture-message={message.info.id}>
            <MessageBody
                messageId={message.info.id} parts={message.parts} isUser={false}
                isMessageCompleted={message.info.role === 'assistant' && Boolean(message.info.finish)}
                messageFinish={message.info.role === 'assistant' ? message.info.finish : undefined}
                onCopyMessage={onCopyMessage ? () => onCopyMessage(message.info.id) : undefined}
                onCopyTurn={message === record.assistantMessages.at(-1) ? onCopyTurn : undefined}
                isMobile={false} copiedCode={null} onCopyCode={() => undefined} expandedTools={expandedTools}
                onToggleTool={(id) => setExpandedTools((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    return next;
                })} onShowPopup={() => undefined} streamPhase="completed" allowAnimation={false}
                hasTextContent={message.parts.some((part) => part.type === 'text')} showReasoningTraces={showReasoning}
                turnGroupingContext={{
                    turnId: 'user', isFirstAssistantInTurn: message.info.id === record.assistantMessages[0]?.info.id,
                    isLastAssistantInTurn: message.info.id === record.assistantMessages.at(-1)?.info.id,
                    isLatestTurn, changedFiles, isWorking: false, hasTools: record.hasTools, hasReasoning: record.hasReasoning,
                    explorationGroups: record.explorationGroups.filter((group) => group.anchorMessageId === message.info.id),
                    explorationPartIds: record.explorationGroups.flatMap((group) => group.parts.filter((part) => part.messageId === message.info.id).map((part) => part.id)),
                }}
            />
        </div>
    );
    return <RuntimeAPIContext.Provider value={runtimeApis}>
        <ThemeSystemContext.Provider value={themeContext}>
            <SyncProvider sdk={sdk} directory="/project">
                <I18nProvider>
                    <LiveTurnActivity turn={record} expanded={expanded}
                        segmentExpansion={segmentExpansion} defaultExpanded={defaultExpanded}
                        onToggleSegment={(id) => {
                            if (id === record.turnId) setExpanded((value) => !value);
                            else setSegmentExpansion((current) => new Map(current).set(id, !(current.get(id) ?? defaultExpanded)));
                        }}
                        isWorking={isWorking && !retired} showReasoning={showReasoning} streamPhase="completed"
                        hasLaterTurn={retired}
                        onToggle={() => setExpanded((value) => !value)} renderMessage={renderMessage} />
                </I18nProvider>
            </SyncProvider>
        </ThemeSystemContext.Provider>
    </RuntimeAPIContext.Provider>;
}

// The first test pays for loading the real message body and for its first
// render. Under the full parallel suite that crossed the 5 second default on
// Windows; later tests take well under a second.
setDefaultTimeout(30_000);

describe('Activity with the real message body', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;
    beforeEach(async () => {
        const win = new Window({ url: 'http://localhost', settings: { device: { prefersReducedMotion: 'reduce' } } });
        const globals = {
            window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
            customElements: win.customElements,
            Node: win.Node, NodeList: win.NodeList, Element: win.Element, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement,
            HTMLAnchorElement: win.HTMLAnchorElement,
            MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver, IntersectionObserver: win.IntersectionObserver,
            requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        // Reduced motion keeps tool reveal effects deterministic.
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
        ChatMessage = (await import('../ChatMessage')).default;
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        jest.useRealTimers();
        restore();
    });

    test('a status-only retry renders before an assistant exists and recovers in the same session', async () => {
        const user = turn([]).userMessage;
        const input = { sessionId: 'session', message: 'WebSocket closed with code 1006', fallbackTimestamp: 2 };
        const retryMessage = (message = input.message) => applyRetryOverlay([user], { ...input, message })[1];
        const renderMessage = (message: ChatMessageEntry) => (
            <RuntimeAPIContext.Provider value={runtimeApis}>
                <ThemeSystemContext.Provider value={themeContext}>
                    <SyncProvider sdk={sdk} directory="/project">
                        <I18nProvider><ChatMessage message={message} /></I18nProvider>
                    </SyncProvider>
                </ThemeSystemContext.Provider>
            </RuntimeAPIContext.Provider>
        );

        await act(async () => root.render(renderMessage(retryMessage())));
        expect(container.textContent).toContain('WebSocket closed with code 1006');
        await act(async () => root.render(renderMessage(retryMessage('Retrying the connection'))));
        expect(container.textContent).toContain('Retrying the connection');
        expect(container.textContent).not.toContain('WebSocket closed with code 1006');

        const reply = assistant('reply', [text('answer', 'Recovered reply')], 'stop');
        await act(async () => root.render(renderMessage(reply)));
        expect(container.textContent).toContain('Recovered reply');
        expect(container.textContent).not.toContain('Retrying the connection');
        expect(user.info).not.toHaveProperty('error');

        if (reply.info.role !== 'assistant') throw new Error('Expected an assistant reply');
        const retrying: ChatMessageEntry = { ...reply, info: { ...reply.info, retry: {
            attempt: 1, at: 10, error: { type: 'provider.transport', message: 'Connection interrupted again' },
        } } };
        await act(async () => root.render(renderMessage(retrying)));
        expect(container.textContent).toContain('Connection interrupted again');
        await act(async () => root.render(renderMessage(reply)));
        expect(container.textContent).not.toContain('Connection interrupted again');
        expect(container.textContent).toContain('Recovered reply');
    });

    test('touch toggles briefly reveal the new view, repeated taps restart the hint, and mouse clicks do not latch it', async () => {
        jest.useFakeTimers();
        const record = turn([assistant('progress', Array.from({ length: 9 }, (_, index): Part => ({
            ...readPart, id: `tool-${index}`, type: 'tool', tool: 'shell', callID: `tool-${index}`,
        })), 'tool-calls')]);
        function HintHarness({ working = true }: { working?: boolean }) {
            const [expanded, setExpanded] = React.useState(false);
            return <I18nProvider>
                <LiveTurnActivity turn={record} expanded={expanded} isWorking={working} streamPhase="completed" showReasoning
                    onToggle={() => setExpanded((value) => !value)} renderMessage={(message) => <div key={message.info.id}>{message.info.id}</div>} />
            </I18nProvider>;
        }
        await act(async () => root.render(<HintHarness />));
        const hint = () => container.querySelector('[data-live-activity-view-hint]');
        const activate = async (selector: string, pointerType: string) => {
            const button = container.querySelector<HTMLButtonElement>(selector);
            if (!button) throw new Error(`Missing button: ${selector}`);
            await act(async () => {
                button.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType }));
                button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
            });
        };
        const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };
        expect(hint()?.classList.contains('opacity-0')).toBe(true);
        await activate('[data-live-activity-more]', 'touch');
        expect(hint()?.classList.contains('opacity-100')).toBe(true);
        expect(hint()?.querySelector('.opacity-100')?.textContent).toBe('All activity');
        await advance(900);
        await activate('button[aria-controls]', 'touch');
        expect(hint()?.querySelector('.opacity-100')?.textContent).toBe('Latest activity');
        await advance(900);
        expect(hint()?.classList.contains('opacity-100')).toBe(true);
        await advance(300);
        expect(hint()?.classList.contains('opacity-0')).toBe(true);
        await activate('button[aria-controls]', 'mouse');
        expect(hint()?.classList.contains('opacity-0')).toBe(true);
        await activate('button[aria-controls]', 'touch');
        await act(async () => root.render(<HintHarness working={false} />));
        expect(hint()).toBeNull();
    });

    test('opening a running fold away from the timeline end keeps new messages mounted', async () => {
        const windowStore = createTurnMessageWindowStore();
        const messages = Array.from({ length: 40 }, (_, index) => assistant(`step-${index}`, [text(`text-${index}`, `Step ${index}`)], 'tool-calls'));
        const render = (record: TurnRecord) => (
            <TurnMessageWindowContext.Provider value={windowStore}><Harness record={record} /></TurnMessageWindowContext.Provider>
        );
        await act(async () => root.render(render(turn(messages))));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.querySelector('[data-fixture-message="step-39"]')).not.toBeNull();
        expect(container.querySelector('[data-turn-message-spacer="tail"]')).toBeNull();
        await act(async () => root.render(render(turn([...messages, assistant('newest', [text('new-text', 'Newly appended')])]))));
        expect(container.querySelector('[data-fixture-message="newest"]')?.textContent).toContain('Newly appended');
    });

    test('a settled fold still opens at its head, but resuming it reveals the live tail and keeps it through completion', async () => {
        const windowStore = createTurnMessageWindowStore();
        const messages = Array.from({ length: 80 }, (_, index) => assistant(`step-${index}`, [text(`text-${index}`, `Step ${index}`)], 'tool-calls'));
        const final = assistant('final', [text('answer', 'First answer')], 'stop');
        const render = (record: TurnRecord) => (
            <TurnMessageWindowContext.Provider value={windowStore}><Harness record={record} /></TurnMessageWindowContext.Provider>
        );
        await act(async () => root.render(render(turn([...messages, final]))));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        await act(async () => header?.click());
        expect(container.querySelector('[data-fixture-message="step-0"]')).not.toBeNull();
        expect(container.querySelector('[data-fixture-message="step-79"]')).toBeNull();
        expect(container.querySelector('[data-turn-message-spacer="tail"]')).not.toBeNull();
        const resumed = assistant('resumed', [text('resumed-text', 'Resumed work')], 'tool-calls');
        await act(async () => root.render(render(turn([...messages, final, resumed]))));
        expect(header?.getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-fixture-message="resumed"]')?.textContent).toContain('Resumed work');
        expect(container.querySelector('[data-turn-message-spacer="tail"]')).toBeNull();
        await act(async () => root.render(render(turn([...messages, final, resumed, assistant('done', [text('done-text', 'Done')], 'stop')]))));
        expect(container.querySelector('[data-fixture-message="resumed"]')).not.toBeNull();
        expect(container.querySelector('[data-turn-message-spacer="tail"]')).toBeNull();
    });

    test('folding a windowed long turn keeps the whole seven-row preview mounted as new commands arrive', async () => {
        const windowStore = createTurnMessageWindowStore();
        const command = (index: number) => assistant(`window-step-${index}`, [{
            type: 'tool', tool: 'exec_command', id: `window-command-${index}`, callID: `window-command-${index}`,
            sessionID: 'session', messageID: `window-step-${index}`,
            state: { status: 'completed', input: { cmd: `window-command-${index};` }, output: '',
                metadata: { processRunning: index >= 79, execDisplay: 'root' }, time: { start: 1, end: 2 } },
        }], 'tool-calls');
        const messages = Array.from({ length: 80 }, (_, index) => command(index));
        const render = (entries: ChatMessageEntry[]) => (
            <div data-scrollbar="chat" style={{ height: 240, overflow: 'auto' }}>
                <TurnMessageWindowContext.Provider value={windowStore}>
                    <Harness record={turn(entries)} defaultExpanded />
                </TurnMessageWindowContext.Provider>
            </div>
        );
        await act(async () => root.render(render(messages)));
        expect(windowStore.range('user')).toEqual({ hiddenHead: 40, hiddenTail: 0 });
        const runningRow = container.querySelector('[data-fixture-message="window-step-79"]');
        expect(runningRow?.textContent).toContain('window-command-79;');
        const toggle = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        await act(async () => toggle?.click());
        expect(container.querySelector('[data-live-activity-more]')?.textContent).toBe('+73 more...');
        expect(container.querySelector('[data-live-activity-running-commands]')).toBeNull();
        expect(container.querySelector('[data-turn-message-spacer]')).toBeNull();
        expect(container.querySelectorAll('[data-fixture-message]')).toHaveLength(7);
        for (let index = 73; index < 80; index++) expect(container.textContent).toContain(`window-command-${index};`);
        expect(runningRow?.isConnected).toBe(true);
        expect(windowStore.range('user')).toEqual({ hiddenHead: 40, hiddenTail: 0 });
        await act(async () => root.render(render([...messages, command(80)])));
        expect(container.querySelector('[data-live-activity-more]')?.textContent).toBe('+74 more...');
        expect(container.querySelectorAll('[data-fixture-message]')).toHaveLength(7);
        expect(container.querySelector('[data-turn-message-spacer]')).toBeNull();
        for (let index = 74; index < 81; index++) expect(container.textContent).toContain(`window-command-${index};`);
        expect(runningRow?.isConnected).toBe(true);
        await act(async () => toggle?.click());
        expect(windowStore.range('user')).toEqual({ hiddenHead: 41, hiddenTail: 0 });
        expect(container.querySelector('[data-turn-message-spacer="head"]')).not.toBeNull();
        expect(container.querySelectorAll('[data-fixture-message]')).toHaveLength(40);
        expect(container.textContent).toContain('window-command-80;');
        await act(async () => toggle?.click());
        expect(container.querySelectorAll('[data-fixture-message]')).toHaveLength(7);
        expect(container.querySelector('[data-turn-message-spacer]')).toBeNull();
        expect(runningRow?.isConnected).toBe(true);
    });

    test('running Activity folds to seven rows and pins text until a newer note or final answer replaces it', async () => {
        const tools = Array.from({ length: 9 }, (_, index): Part => ({
            ...readPart, id: `command-${index}`, type: 'tool', tool: 'exec_command', callID: `command-${index}`,
            state: { status: 'completed', input: { cmd: `echo ${index}` }, output: '', metadata: {}, time: { start: 1, end: 2 } },
        }));
        const record = (content: string) => turn([assistant('progress', [text('note', content), ...tools], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record('Checking source')} defaultExpanded />));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        expect(header?.getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('echo 0');
        await act(async () => header?.click());
        expect(header?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-pinned-activity-text]')?.textContent?.trim()).toBe('Checking source');
        expect(container.textContent?.split('Checking source').length).toBe(2);
        expect(container.textContent).not.toContain('echo 0');
        expect(container.textContent).not.toContain('echo 1');
        for (let index = 2; index < 9; index++) expect(container.textContent).toContain(`echo ${index}`);
        expect(container.querySelector('[data-live-activity-more]')?.textContent).toBe('+2 more...');
        await act(async () => root.render(<Harness record={record('Checking source and tests')} />));
        expect(container.querySelector('[data-pinned-activity-text]')?.textContent?.trim()).toBe('Checking source and tests');
        await act(async () => container.querySelector<HTMLButtonElement>('[data-live-activity-more]')?.click());
        expect(container.querySelector('[data-live-activity-more]')).toBeNull();
        expect(container.querySelector('[data-pinned-activity-text]')).toBeNull();
        expect(container.textContent).toContain('Checking source and tests');
        await act(async () => header?.click());
        expect(container.querySelector('[data-pinned-activity-text]')).not.toBeNull();
        await act(async () => root.render(<Harness record={record('Checking source and tests')} isWorking={false} />));
        expect(container.querySelector('[data-pinned-activity-text]')).toBeNull();
        expect(container.textContent).not.toContain('Checking source and tests');
        expect(container.querySelector('[data-live-activity-content]')?.textContent).toBe('');
        expect(container.querySelector('[data-live-activity-more]')).toBeNull();
        const newer = assistant('newer', [text('new-note', 'Now checking tests')], 'tool-calls');
        const messages = [...record('Checking source and tests').assistantMessages, newer];
        await act(async () => root.render(<Harness record={turn(messages)} />));
        expect(container.querySelector('[data-pinned-activity-text]')?.textContent?.trim()).toBe('Now checking tests');
        await act(async () => header?.click());
        expect(header?.getAttribute('aria-expanded')).toBe('true');
        const final = assistant('final', [text('answer', 'Final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([...messages, final])} />));
        expect(header?.getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('echo 0');
        expect(container.querySelector('[data-pinned-activity-text]')).toBeNull();
        expect(container.textContent).toContain('Final answer');
        await act(async () => header?.click());
        expect(container.querySelector('[data-live-activity-content]')?.textContent).toBe('');
        expect(container.textContent).not.toContain('echo 8');
        expect(container.textContent).toContain('Final answer');
    });

    test('folded activity only hoists hidden commands while running and hoists every running command once settled', async () => {
        const commands = (running: boolean): Part[] => Array.from({ length: 10 }, (_, index) => ({
            type: 'tool', tool: 'exec_command', id: `live-${index}`, callID: `live-${index}`, sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { cmd: `command-${index};` }, output: '',
                metadata: { processRunning: running, execDisplay: 'root' }, time: { start: 1, end: 2 } },
        }));
        const record = (running: boolean, final = false) => turn([
            assistant('progress', commands(running), 'tool-calls'),
            ...(final ? [assistant('final', [text('answer', 'Finished answer')], 'stop')] : []),
        ]);
        await act(async () => root.render(<Harness record={record(true)} />));
        const pinned = () => container.querySelector('[data-live-activity-running-commands]');
        expect(container.querySelector('[data-live-activity-more]')).toBeNull();
        for (let index = 0; index < 10; index++) {
            if (index < 3) expect(pinned()?.textContent).toContain(`command-${index};`);
            else {
                expect(pinned()?.textContent).not.toContain(`command-${index};`);
                expect(container.querySelector('[data-live-activity-content]')?.textContent).toContain(`command-${index};`);
            }
            expect(container.textContent?.split(`command-${index};`).length).toBe(2);
        }
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(pinned()).toBeNull();
        for (let index = 0; index < 10; index++) expect(container.textContent?.split(`command-${index};`).length).toBe(2);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        await act(async () => root.render(<Harness record={record(true, true)} isWorking={false} />));
        expect(container.querySelector('[data-live-activity-more]')).toBeNull();
        expect(container.querySelector('[data-live-activity-content]')?.textContent).toBe('');
        for (let index = 0; index < 10; index++) expect(pinned()?.textContent).toContain(`command-${index};`);
        expect(container.textContent).toContain('Finished answer');
        await act(async () => root.render(<Harness record={record(false, true)} isWorking={false} />));
        expect(pinned()).toBeNull();
        expect(container.textContent).not.toContain('command-0;');
        await act(async () => root.render(<Harness record={turn([assistant('progress', commands(true).slice(0, 7), 'tool-calls')])} />));
        expect(pinned()).toBeNull();
        expect(container.querySelector('[data-live-activity-more]')).toBeNull();
        expect(container.textContent).toContain('command-0;');
    });

    test('overflow counts only rows still hidden after hoisting a running command', async () => {
        const parts: Part[] = Array.from({ length: 10 }, (_, index) => ({
            type: 'tool', tool: 'exec_command', id: `count-${index}`, callID: `count-${index}`, sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { cmd: `count-command-${index}` }, output: '',
                metadata: { processRunning: index === 0, execDisplay: 'root' }, time: { start: 1, end: 2 } },
        }));
        await act(async () => root.render(<Harness record={turn([assistant('progress', parts, 'tool-calls')])} />));
        const pinned = container.querySelector('[data-live-activity-running-commands]');
        expect(pinned?.textContent).toContain('count-command-0');
        expect(container.textContent).not.toContain('count-command-1');
        expect(container.textContent).not.toContain('count-command-2');
        const more = container.querySelector('[data-live-activity-more]');
        expect(more?.textContent).toBe('+2 more...');
        expect(more?.parentElement?.nextElementSibling).toBe(pinned);
    });

    test('a visible running command stays in place until new rows push it behind the fold', async () => {
        const record = (count: number, running = true) => turn([assistant('moving-boundary', Array.from({ length: count }, (_, index): Part => ({
            type: 'tool', tool: 'exec_command', id: `boundary-${index}`, callID: `boundary-${index}`, sessionID: 'session', messageID: 'moving-boundary',
            state: { status: 'completed', input: { cmd: `boundary-command-${index};` }, output: '',
                metadata: { processRunning: index === 5 && running, execDisplay: 'root' }, time: { start: 1, end: 2 } },
        })), 'tool-calls')]);
        const pinned = () => container.querySelector('[data-live-activity-running-commands]');
        const preview = () => container.querySelector('[data-live-activity-content]');
        await act(async () => root.render(<Harness record={record(10)} />));
        expect(pinned()).toBeNull();
        expect(container.querySelector('[data-live-activity-more]')?.textContent).toBe('+3 more...');
        expect(preview()?.textContent).toContain('boundary-command-5;');
        const command = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((element) => element.textContent?.includes('boundary-command-5;'));
        expect(command).toBeDefined();
        await act(async () => root.render(<Harness record={record(12)} />));
        expect(pinned()).toBeNull();
        expect(command?.isConnected).toBe(true);
        expect(preview()?.textContent).toContain('boundary-command-5;');
        await act(async () => root.render(<Harness record={record(13)} />));
        expect(pinned()?.textContent).toContain('boundary-command-5;');
        expect(preview()?.textContent).not.toContain('boundary-command-5;');
        expect(container.querySelector('[data-live-activity-more]')?.textContent).toBe('+5 more...');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(pinned()).toBeNull();
        expect(preview()?.textContent).toContain('boundary-command-5;');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(pinned()?.textContent).toContain('boundary-command-5;');
        await act(async () => root.render(<Harness record={record(13, false)} />));
        expect(pinned()).toBeNull();
        expect(container.textContent).not.toContain('boundary-command-5;');
        expect(container.querySelector('[data-live-activity-more]')?.textContent).toBe('+6 more...');
    });

    test('Script commands stay visible through overflow and completion without duplicating expanded children', async () => {
        const script = (running: boolean): Part => ({
            type: 'tool', tool: 'execute', id: 'script', callID: 'script', sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { code: 'return await tools.exec_command(input)' }, output: '',
                metadata: { toolCalls: [{ id: 'child', name: 'exec_command', tool: 'functions.exec_command', status: 'completed',
                    input: { cmd: 'long-running-command' }, metadata: { processRunning: running, execDisplay: 'root' }, time: { start: 1, end: 2 } }] },
                time: { start: 1, end: 2 } },
        });
        const padding: Part[] = Array.from({ length: 7 }, (_, index) => ({
            ...readPart, id: `pad-${index}`, tool: 'exec_command', callID: `pad-${index}`,
        }));
        const record = (running: boolean, final = false, overflowScript = false) => turn([
            assistant('progress', [...padding, script(running), ...(overflowScript ? padding.map((part) => ({ ...part, id: `tail-${part.id}` })) : [])], 'tool-calls'),
            ...(final ? [assistant('final', [text('answer', 'Done')], 'stop')] : []),
        ]);
        await act(async () => root.render(<Harness record={record(true)} />));
        const pinned = () => container.querySelector('[data-live-activity-running-commands]');
        expect(pinned()).toBeNull();
        const scriptHeader = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((element) => element.textContent?.includes('Script'));
        expect(scriptHeader).toBeDefined();
        await act(async () => scriptHeader?.click());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        expect(container.textContent?.split('long-running-command').length).toBe(2);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(pinned()).toBeNull();
        expect(container.textContent?.split('long-running-command').length).toBe(2);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(pinned()).toBeNull();
        await act(async () => root.render(<Harness record={record(true, false, true)} />));
        expect(pinned()?.textContent).toContain('long-running-command');
        expect(container.textContent?.split('long-running-command').length).toBe(2);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(pinned()).toBeNull();
        expect(container.textContent?.split('long-running-command').length).toBe(2);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        await act(async () => root.render(<Harness record={record(true, true, true)} isWorking={false} />));
        expect(container.querySelector('[role="status"]')?.textContent).toContain('1');
        expect(pinned()?.textContent).toContain('long-running-command');
        await act(async () => root.render(<Harness record={record(false, true, true)} isWorking={false} />));
        expect(pinned()).toBeNull();
    });

    test('real message owners preserve both command and preview expansion across folds and command exit', async () => {
        const record = (running: boolean, overflow = false) => turn([assistant('expansion-owner', Array.from({ length: overflow ? 11 : 10 }, (_, index): Part => ({
            type: 'tool', tool: 'exec_command', id: `state-${index}`, callID: `state-${index}`, sessionID: 'session', messageID: 'expansion-owner',
            state: { status: 'completed', input: { cmd: `state-command-${index}` }, output: `OUTPUT_SENTINEL_${index}`,
                metadata: { processRunning: index === 3 && running, execDisplay: 'root', output: `OUTPUT_SENTINEL_${index}` }, time: { start: 1, end: 2 } },
        })), 'tool-calls')]);
        await act(async () => root.render(<Harness record={record(true)} realMessage />));
        const open = async (index: number) => {
            const command = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((element) => element.textContent?.includes(`state-command-${index}`));
            expect(command).toBeDefined();
            await act(async () => command?.click());
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        };
        await open(3);
        await open(9);
        const expectOutputs = () => {
            expect(container.textContent).toContain('OUTPUT_SENTINEL_3');
            expect(container.textContent).toContain('OUTPUT_SENTINEL_9');
        };
        expectOutputs();
        expect(container.querySelector('[data-live-activity-running-commands]')).toBeNull();
        await act(async () => root.render(<Harness record={record(true, true)} realMessage />));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        expect(container.querySelector('[data-live-activity-running-commands]')?.textContent).toContain('OUTPUT_SENTINEL_3');
        expectOutputs();
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        expectOutputs();
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        expectOutputs();
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        await act(async () => root.render(<Harness record={record(false, true)} realMessage />));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        expect(container.querySelector('[data-live-activity-running-commands]')).toBeNull();
        expectOutputs();
    });

    test('a row-window boundary keeps a cross-message Exploration whole and skips it as one row', async () => {
        const windows = createTurnMessageWindowStore();
        const command = (index: number): Part => ({
            type: 'tool', tool: 'exec_command', id: `atomic-command-${index}`, callID: `atomic-command-${index}`, sessionID: 'session', messageID: 'commands',
            state: { status: 'completed', input: { cmd: `atomic-command-${index};` }, output: '', metadata: { processRunning: false, execDisplay: 'root' }, time: { start: 1, end: 2 } },
        });
        const reads = Array.from({ length: 6 }, (_, index): Part => ({
            ...readPart, type: 'tool', id: `atomic-read-${index}`, callID: `atomic-read-${index}`,
            state: { ...readPart.state, input: { filePath: `/project/atomic-source-${index}.ts` } },
        }));
        const record = turn([
            assistant('first', [...Array.from({ length: 40 }, (_, index) => command(index)), ...reads.slice(0, 3)], 'tool-calls'),
            assistant('second', [...reads.slice(3), ...Array.from({ length: 39 }, (_, index) => command(index + 40))], 'tool-calls'),
        ]);
        await act(async () => root.render(
            <TurnMessageWindowContext.Provider value={windows}><Harness record={record} defaultExpanded /></TurnMessageWindowContext.Provider>,
        ));
        expect(windows.range('user')).toEqual({ hiddenHead: 40, hiddenTail: 0 });
        expect(container.textContent).not.toContain('atomic-command-39;');
        expect(container.querySelectorAll('[data-exploration-group]')).toHaveLength(1);
        await act(async () => container.querySelector<HTMLButtonElement>('[data-exploration-group] button')?.click());
        for (let index = 0; index < 6; index++) expect(container.textContent).toContain(`atomic-source-${index}.ts`);
        await act(async () => windows.setRange('user', { hiddenHead: 41, hiddenTail: 0 }));
        expect(container.querySelector('[data-exploration-group]')).toBeNull();
        for (let index = 40; index < 79; index++) expect(container.textContent).toContain(`atomic-command-${index};`);
    });

    test('a pinned note preserves Exploration boundaries and nested expansion through the outer toggle', async () => {
        const first = assistant('first', [text('old', 'Earlier note'), readPart], 'tool-calls');
        const second = assistant('second', [text('new', 'Latest note'), { ...readPart, id: 'read-next' }], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([first])} defaultExpanded />));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        await act(async () => header?.click());
        expect(container.querySelector('[data-pinned-activity-text]')?.textContent?.trim()).toBe('Earlier note');
        await act(async () => root.render(<Harness record={turn([first, second])} />));
        expect(container.querySelectorAll('[data-pinned-activity-text]').length).toBe(1);
        expect(container.querySelector('[data-pinned-activity-text]')?.textContent?.trim()).toBe('Latest note');
        expect(container.textContent?.split('Latest note').length).toBe(2);
        expect(container.textContent).toContain('Earlier note');
        expect(container.querySelectorAll('[data-exploration-group]').length).toBe(2);
        expect(container.querySelector('[data-live-activity-more]')).toBeNull();
        await act(async () => container.querySelector<HTMLButtonElement>('[data-exploration-group] button')?.click());
        expect(container.querySelector('[data-exploration-group] button')?.getAttribute('aria-expanded')).toBe('true');
        await act(async () => header?.click());
        expect(container.querySelector('[data-exploration-group] button')?.getAttribute('aria-expanded')).toBe('true');
        await act(async () => header?.click());
        expect(container.querySelector('[data-exploration-group] button')?.getAttribute('aria-expanded')).toBe('true');
        const final = assistant('final', [text('answer', 'Final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([first, second, final])} />));
        expect(container.querySelector('[data-pinned-activity-text]')).toBeNull();
        expect(header?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-live-activity-content]')?.textContent).toBe('');
        expect(container.querySelectorAll('[data-exploration-group]').length).toBe(0);
        expect(container.textContent).toContain('Final answer');
        await act(async () => header?.click());
        expect(container.querySelector('[data-exploration-group] button')?.getAttribute('aria-expanded')).toBe('true');
    });

    test('an expanded turn stays expanded when its final answer arrives', async () => {
        const progress = assistant('progress', [text('progress-text', 'Checking the source'), readPart], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([progress])} defaultExpanded />));
        expect(container.textContent).toContain('Checking the source');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('Activity');
        const final = assistant('final', [text('final-text', 'The final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])} />));
        expect(container.textContent).toContain('The final answer');
        expect(container.textContent).toContain('Checking the source');
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        expect(header?.getAttribute('aria-expanded')).toBe('true');
        expect(header?.textContent).toContain('Explored codebase');
        await act(async () => header?.click());
        expect(header?.textContent).toContain('Explored codebase');
        expect(container.textContent).not.toContain('Checking the source');
        expect(container.textContent).toContain('The final answer');
        await act(async () => header?.click());
        await act(async () => root.render(<Harness record={turn([progress, { ...final, parts: [...final.parts] }])} />));
        expect(header?.getAttribute('aria-expanded')).toBe('true');
    });

    test('draws a page the agent showed above the answer, outside the folded Activity', async () => {
        const pagePart = (id: string, messageID: string, ok: boolean): Part => ({
            type: 'tool', tool: 'openchamber_render', id, callID: id, sessionID: 'session', messageID,
            state: {
                status: 'completed', input: { request: { action: 'render.page', html: '<p>chart</p>', title: `Page ${id}` } },
                output: '{}', metadata: { openchamber: { ok } }, time: { start: 1, end: 2 },
            },
        });
        const progress = assistant('progress', [text('progress-text', 'Drawing'), readPart, pagePart('early', 'progress', true), pagePart('refused', 'progress', false)], 'tool-calls');
        const final = assistant('final', [pagePart('late', 'final', true), text('final-text', 'Here it is')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress])} />));
        expect([...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'))).toEqual(['Page early']);
        await act(async () => root.render(<Harness record={turn([progress, final])} />));
        const frames = () => [...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'));
        // Both accepted pages sit with the answer, in the order they ran; the refused one does not.
        expect(frames()).toEqual(['Page early', 'Page late']);
        const finalMessage = container.querySelector('[data-fixture-message="final"]');
        expect(finalMessage?.textContent?.indexOf('Here it is')).toBeGreaterThan(-1);
        expect(finalMessage?.querySelectorAll('iframe')).toHaveLength(2);
        expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
        // Opening Activity shows the steps without drawing the pages a second time.
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Drawing');
        expect(frames()).toEqual(['Page early', 'Page late']);
    });

    test('keeps a page in view in a turn that ended without an answer', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'progress',
            state: {
                status: 'completed', input: { action: 'render.page', html: '<p>chart</p>', title: 'Drawn page' },
                output: '{}', metadata: { openchamber: { ok: true } }, time: { start: 1, end: 2 },
            },
        };
        const record = turn([assistant('progress', [text('progress-text', 'Still working'), readPart, page], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} retired />));
        // The tools fold away; the page and latest prose remain, drawn once.
        expect(container.textContent).toContain('Still working');
        expect([...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'))).toEqual(['Drawn page']);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Still working');
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    test('draws what the agent does after a page below it while the turn works', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'asked',
            state: {
                status: 'completed', input: { action: 'render.page', html: '<p>pick</p>', title: 'Pick a layout', awaitAnswer: true },
                output: '{}', metadata: { openchamber: { ok: true, answer: { answered: true, summary: 'B', data: null } } }, time: { start: 1, end: 2 },
            },
        };
        const before = assistant('before', [text('before-text', 'Looking around'), readPart], 'tool-calls');
        const asked = assistant('asked', [page], 'tool-calls');
        // The reply is still being written: not yet marked final.
        const writing = assistant('writing', [text('writing-text', 'Building layout B')], undefined);
        await act(async () => root.render(<Harness record={turn([before, asked, writing])} />));

        const html = container.innerHTML;
        expect(html.indexOf('title="Pick a layout"')).toBeGreaterThan(-1);
        expect(html.indexOf('Building layout B')).toBeGreaterThan(html.indexOf('title="Pick a layout"'));
        expect(html.indexOf('Looking around')).toBeLessThan(html.indexOf('title="Pick a layout"'));
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    test('splits multiple pages inside one message into independently expandable previews', async () => {
        const page = (id: string): Part => ({
            type: 'tool', tool: 'openchamber_render', id, callID: id, sessionID: 'session', messageID: 'steps',
            state: { status: 'completed', input: { request: { action: 'render.page', title: id, html: '<p>Page</p>' } },
                output: '{}', metadata: { openchamber: { ok: true } }, time: { start: 1, end: 2 } },
        });
        const commands = (prefix: string) => Array.from({ length: 9 }, (_, index): Part => ({
            ...readPart, type: 'tool', tool: 'exec_command', id: `${prefix}-${index}`, callID: `${prefix}-${index}`,
            state: { status: 'completed', input: { cmd: `echo ${prefix}-${index}` }, output: '', metadata: {}, time: { start: 1, end: 2 } },
        }));
        const steps = assistant('steps', [text('before', 'Before first page'), ...commands('a'), page('first-page'),
            text('between', 'Between pages'), ...commands('b'), page('second-page'), text('after', 'After second page')], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([steps])} />));
        const html = container.innerHTML;
        expect(html.indexOf('Before first page')).toBeLessThan(html.indexOf('title="first-page"'));
        expect(html.indexOf('Between pages')).toBeGreaterThan(html.indexOf('title="first-page"'));
        expect(html.indexOf('Between pages')).toBeLessThan(html.indexOf('title="second-page"'));
        expect(html.indexOf('After second page')).toBeGreaterThan(html.indexOf('title="second-page"'));
        expect(container.textContent).not.toContain('echo a-0');
        expect(container.textContent).not.toContain('echo b-0');
        const middle = container.querySelector<HTMLButtonElement>('[data-live-turn-activity="user:after-page:first-page"] button[aria-controls]');
        await act(async () => middle?.click());
        expect(container.textContent).toContain('echo b-0');
        expect(container.textContent).not.toContain('echo a-0');
        expect(container.querySelectorAll('iframe')).toHaveLength(2);
        await act(async () => root.render(<Harness record={turn([steps])} isWorking={false} />));
        expect(container.textContent).toContain('echo b-0');
        await act(async () => root.render(<Harness record={turn([steps])} />));
        expect(container.textContent).toContain('After second page');
        await act(async () => root.render(<Harness record={turn([steps, assistant('final', [text('answer', 'Done')], 'stop')])} />));
        expect(container.querySelectorAll('iframe')).toHaveLength(2);
        expect(container.textContent).not.toContain('echo b-0');
        expect(container.textContent).toContain('Done');
    });

    test('page segments keep separate message windows and reveal their tail when a stopped turn resumes', async () => {
        const windows = createTurnMessageWindowStore();
        const steps = (prefix: string) => Array.from({ length: 80 }, (_, index) => assistant(`${prefix}-${index}`, [text(`${prefix}-text-${index}`, `Step ${prefix} ${index}`)], 'tool-calls'));
        const page: Part = { type: 'tool', tool: 'openchamber_render', id: 'boundary', callID: 'boundary', sessionID: 'session', messageID: 'page',
            state: { status: 'completed', input: { title: 'Boundary', html: '<p>Page</p>' }, output: '', metadata: { openchamber: { ok: true } }, time: { start: 1, end: 2 } } };
        const messages = [...steps('before'), assistant('page', [page], 'tool-calls'), ...steps('after')];
        const render = (working: boolean, entries = messages) => <TurnMessageWindowContext.Provider value={windows}><Harness record={turn(entries)} isWorking={working} /></TurnMessageWindowContext.Provider>;
        await act(async () => root.render(render(false)));
        const selector = '[data-live-turn-activity="user:after-page:boundary"]';
        const header = container.querySelector<HTMLButtonElement>(`${selector} button[aria-controls]`);
        await act(async () => header?.click());
        expect(container.querySelector(`${selector} [data-fixture-message="after-0"]`)).not.toBeNull();
        expect(container.querySelector(`${selector} [data-fixture-message="after-79"]`)).toBeNull();
        expect(windows.range('user')).toBeUndefined();
        expect(windows.range('user:after-page:boundary')?.hiddenTail).toBeGreaterThan(0);
        await act(async () => root.render(render(true, [...messages, assistant('resumed', [text('resume', 'Resumed tail')], 'tool-calls')])));
        expect(windows.range('user:after-page:boundary')?.hiddenTail).toBe(0);
        expect(container.querySelector(`${selector} [data-fixture-message="resumed"]`)?.textContent).toContain('Resumed tail');
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    test('keeps a page that waits for the user\'s answer in view while its call runs', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'progress',
            state: {
                status: 'running', input: { action: 'render.page', html: '<p>pick</p>', title: 'Pick a layout', awaitAnswer: true },
                time: { start: 1 },
            },
        };
        const record = turn([assistant('progress', [text('progress-text', 'Asking'), readPart, page], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).toContain('Asking');
        expect([...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'))).toEqual(['Pick a layout']);
        expect(container.querySelector('[data-html-render-status="waiting"]')).not.toBeNull();
    });

    test('a fully collapsed final message hides its thinking and preserves its answer', async () => {
        const thinking: Part = { type: 'reasoning', id: 'thinking', messageID: 'final', sessionID: 'session', text: 'Private reasoning content', time: { start: 1, end: 2 } };
        const final = assistant('final', [thinking, text('final-text', 'Public answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([final])} />));
        expect(container.textContent).toContain('Public answer');
        expect(container.textContent).not.toContain('Private reasoning content');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Private reasoning content');
        expect(container.textContent).toContain('Public answer');
    });

    test('shows background commands in the collapsed header until the root reports exit', async () => {
        const command = (running: boolean): Part => ({
            type: 'tool', tool: 'exec_command', id: 'exec', callID: 'exec', sessionID: 'session', messageID: 'progress',
            state: {
                status: 'completed', input: { cmd: 'long-running-command' }, output: '',
                metadata: { execID: 7, execDisplay: 'root', processRunning: running }, time: { start: 1, end: 2 },
            },
        });
        const final = assistant('final', [text('final-text', 'The final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([assistant('progress', [command(true)], 'tool-calls'), final])} />));
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Commands running: 1');
        expect(container.textContent).toContain('The final answer');
        await act(async () => root.render(<Harness record={turn([assistant('progress', [command(false)], 'tool-calls'), final])} />));
        expect(container.querySelector('[role="status"]')).toBeNull();
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
    });

    test('an idle turn closes, resumes its preview, and retains prose when a later reply retires it', async () => {
        const record = turn([assistant('progress', [text('progress-text', 'Still working'), readPart], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} />));
        expect(container.textContent).toContain('Still working');
        expect(container.textContent).toContain('Activity');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => root.render(<Harness record={record} isWorking={false} />));
        expect(container.querySelector('[data-live-activity-content]')?.textContent).toBe('');
        expect(container.textContent).not.toContain('Still working');
        await act(async () => root.render(<Harness record={record} />));
        expect(container.textContent).toContain('Still working');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).toContain('Still working');
        expect(container.querySelector('[data-live-activity-content]')?.textContent).toBe('');
        expect(container.textContent).toContain('Activity');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Still working');
    });

    for (const livePartsOnly of [false, true]) test(`the timeline retains prose immediately after a follow-up prompt, live-only parts: ${livePartsOnly}`, async () => {
        // Happy DOM has no layout; give the real virtualizer a visible viewport.
        Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
            configurable: true,
            value(this: HTMLElement) { return new window.DOMRect(0, 0, 800, this.dataset.scrollbar === 'steer-test' ? 800 : 100); },
        });
        const { default: MessageList } = await import('../MessageList');
        useUIStore.setState({ activityRenderMode: 'collapsed' });
        const runningRead: Part = {
            type: 'tool', tool: 'read', id: 'running-read', callID: 'running-read', sessionID: 'session', messageID: 'progress',
            state: { status: 'running', input: { filePath: '/project/source.ts' }, time: { start: 3 } },
        };
        const liveText: Part = { type: 'text', id: 'progress-text', sessionID: 'session', messageID: 'progress',
            text: 'Still working', time: { start: 2, end: 3 } };
        const liveParts = [liveText, runningRead];
        const record = turn([assistant('progress', livePartsOnly ? [] : liveParts)]);
        const original = [record.userMessage, ...record.assistantMessages];
        const followUp: ChatMessageEntry = {
            info: { id: 'follow-up', sessionID: 'session', role: 'user', time: { created: 4 } },
            parts: [text('follow-up-text', 'Steer the work')],
        };
        function LivePartSeed() {
            const store = useSyncDirectoryStore('/project', { bootstrap: false });
            React.useLayoutEffect(() => {
                store.setState((state) => ({ part: { ...state.part, progress: liveParts } }));
            }, [store]);
            return null;
        }
        function TimelineHarness({ messages, activeMessageId = 'progress' }: { messages: ChatMessageEntry[]; activeMessageId?: string }) {
            return <RuntimeAPIContext.Provider value={runtimeApis}>
                <ThemeSystemContext.Provider value={themeContext}>
                    <SyncProvider sdk={sdk} directory="/project">
                        {livePartsOnly ? <LivePartSeed /> : null}
                        <I18nProvider>
                            <MessageList sessionKey="session" messages={messages} sessionIsWorking isLoadingOlder={false}
                                activeStreamingMessageId={activeMessageId} activeStreamingPhase="streaming"
                                scrollContainerProps={{ 'data-scrollbar': 'steer-test' }} />
                        </I18nProvider>
                    </SyncProvider>
                </ThemeSystemContext.Provider>
            </RuntimeAPIContext.Provider>;
        }
        const activity = () => container.querySelector('[data-live-turn-activity="user"]');
        await act(async () => root.render(<TimelineHarness messages={original} />));
        expect(activity()?.textContent).toContain('Still working');
        expect(activity()?.querySelector('[data-pinned-activity-text]')).not.toBeNull();
        await act(async () => root.render(<TimelineHarness messages={[...original, followUp]} />));
        expect(container.textContent).toContain('Steer the work');
        expect(activity()?.textContent).toContain('Still working');
        expect(activity()?.querySelector('[data-live-activity-content]')?.textContent).toBe('');
        expect(activity()?.querySelector('[data-pinned-activity-text]')).toBeNull();
        // Removing a failed optimistic send restores the original live preview.
        await act(async () => root.render(<TimelineHarness messages={original} />));
        expect(activity()?.querySelector('[data-pinned-activity-text]')?.textContent).toContain('Still working');
        // Neither the server echo nor the next assistant's arrival hides the retained text.
        await act(async () => root.render(<TimelineHarness messages={[...original, followUp]} />));
        await act(async () => root.render(<TimelineHarness messages={[...original, { ...followUp, info: { ...followUp.info } }]} />));
        expect(activity()?.textContent).toContain('Still working');
        const settledOriginal = original.map((message) => message.info.id === 'progress' ? { ...message, parts: liveParts } : message);
        await act(async () => root.render(<TimelineHarness activeMessageId="next-assistant" messages={[...settledOriginal, followUp,
            assistant('next-assistant', [text('next-text', 'Continuing with the steer')], 'tool-calls')]} />));
        expect(activity()?.textContent).toContain('Still working');
        expect(container.textContent).toContain('Continuing with the steer');
    });

    test('a retired turn keeps its latest text message outside the fold even when tool-only messages follow', async () => {
        const record = turn([
            assistant('earlier', [text('earlier-text', 'Earlier progress')], 'tool-calls'),
            assistant('latest', [text('latest-text', 'Latest progress'), readPart], 'tool-calls'),
            assistant('tools', [{ ...readPart, id: 'later-read' }, text('empty', '  ')], 'tool-calls'),
        ]);
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).toContain('Latest progress');
        expect(container.textContent).not.toContain('Earlier progress');
        expect(container.querySelector('[data-fixture-message="latest"] [data-live-activity-content]')?.textContent).toBe('');
        expect(container.querySelectorAll('[data-message-text-export-source]')).toHaveLength(1);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Earlier progress');
        expect(container.textContent?.split('Latest progress')).toHaveLength(2);
    });

    for (const realMessage of [false, true]) test(`retiring a turn preserves activity order through collapse and expansion, real message: ${realMessage}`, async () => {
        const reasoning = (id: string): Part => ({
            type: 'reasoning', id, messageID: id, sessionID: 'session', text: id, time: { start: 1, end: 2 },
        });
        const command = (id: string): Part => ({
            type: 'tool', tool: 'exec_command', id, callID: id, sessionID: 'session', messageID: id,
            state: { status: 'completed', input: { cmd: id }, output: '',
                metadata: { processRunning: false, execDisplay: 'root' }, time: { start: 1, end: 2 } },
        });
        const record = turn([
            assistant('latest', [reasoning('First reasoning'), text('latest-text', 'Latest progress'), command('first-command;')], 'tool-calls'),
            assistant('tail', [reasoning('Second reasoning'), command('second-command;')], 'tool-calls'),
        ]);
        const assertActivityOrder = () => {
            const content = container.textContent ?? '';
            const labels = ['First reasoning', 'first-command;', 'Second reasoning', 'second-command;'];
            for (const label of labels) expect(content.split(label)).toHaveLength(2);
            for (let index = 1; index < labels.length; index++) {
                expect(content.indexOf(labels[index - 1])).toBeLessThan(content.indexOf(labels[index]));
            }
            expect(content.split('Latest progress')).toHaveLength(2);
        };
        await act(async () => root.render(<Harness record={record} realMessage={realMessage} defaultExpanded />));
        assertActivityOrder();
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        await act(async () => root.render(<Harness record={record} realMessage={realMessage} retired />));
        expect(container.textContent).toContain('Latest progress');
        expect(container.textContent).not.toContain('First reasoning');
        expect(container.textContent).not.toContain('second-command;');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        assertActivityOrder();
        expect(container.textContent?.indexOf('Latest progress')).toBeGreaterThan(container.textContent?.indexOf('second-command;') ?? -1);
        await act(async () => root.render(<Harness record={record} realMessage={realMessage} />));
        assertActivityOrder();
        await act(async () => root.render(<Harness record={record} realMessage={realMessage} retired />));
        assertActivityOrder();
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

    test('keeps file statistics visible when expanded and uses an ASCII minus', async () => {
        const edit: Part = {
            type: 'tool', tool: 'edit', id: 'edit', callID: 'edit', sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { filePath: '/project/source.ts' }, output: '',
                metadata: { diff: '@@ -1,1 +1,2 @@\n-old\n+new\n+added' }, time: { start: 1, end: 2 } },
        };
        await act(async () => root.render(<Harness record={turn([
            assistant('progress', [edit], 'tool-calls'),
            assistant('final', [text('answer', 'Done')], 'stop'),
        ])} />));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        expect(header?.textContent).toContain('Changed 1 file');
        expect(header?.textContent).toContain('+2/-1');
        await act(async () => header?.click());
        expect(header?.textContent).toContain('Changed 1 file');
        expect(header?.textContent).toContain('+2/-1');
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
        expect(container.querySelector('button[aria-label="Open src/b.ts"]')?.textContent).toBe('b.ts+1/-2');
        expect(container.querySelector('button[aria-label="Open src/c.ts"]')).toBeNull();
        expect(container.querySelector('span[title="src/c.ts"]')?.textContent).toBe('c.ts+1/-0');
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
