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
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
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

function Harness({ record, retired = false, changedFiles, isLatestTurn = true, isWorking = true, showReasoning = true, defaultExpanded = false }: {
    record: TurnRecord;
    retired?: boolean;
    changedFiles?: TurnChangedFile[];
    isLatestTurn?: boolean;
    isWorking?: boolean;
    showReasoning?: boolean;
    defaultExpanded?: boolean;
}) {
    const [expanded, setExpanded] = React.useState(defaultExpanded);
    const [expandedTools, setExpandedTools] = React.useState(new Set<string>());
    const renderMessage = (message: ChatMessageEntry) => (
        <div key={message.info.id} data-fixture-message={message.info.id}>
            <MessageBody
                messageId={message.info.id} parts={message.parts} isUser={false}
                isMessageCompleted={message.info.role === 'assistant' && Boolean(message.info.finish)}
                messageFinish={message.info.role === 'assistant' ? message.info.finish : undefined}
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
        <SyncProvider sdk={sdk} directory="/project">
            <I18nProvider>
                <LiveTurnActivity turn={record} expanded={expanded}
                    isWorking={isWorking && !retired} showReasoning={showReasoning} streamPhase="completed"
                    onToggle={() => setExpanded((value) => !value)} renderMessage={renderMessage} />
            </I18nProvider>
        </SyncProvider>
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
            MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
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
        useUIStore.setState({ chatRenderMode: 'live', collapsibleThinkingBlocks: false, showSplitAssistantMessageActions: false });
        useDirectoryStore.setState({ currentDirectory: '/project' });
        useI18nStore.getState().setLocale('en');
        MessageBody = (await import('../message/MessageBody')).default;
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        jest.useRealTimers();
        restore();
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
        const messages = Array.from({ length: 40 }, (_, index) => assistant(`step-${index}`, [text(`text-${index}`, `Step ${index}`)], 'tool-calls'));
        const final = assistant('final', [text('answer', 'First answer')], 'stop');
        const render = (record: TurnRecord) => (
            <TurnMessageWindowContext.Provider value={windowStore}><Harness record={record} /></TurnMessageWindowContext.Provider>
        );
        await act(async () => root.render(render(turn([...messages, final]))));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        await act(async () => header?.click());
        expect(container.querySelector('[data-fixture-message="step-0"]')).not.toBeNull();
        expect(container.querySelector('[data-fixture-message="step-39"]')).toBeNull();
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

    test('a collapsed interrupted turn fully closes and restores its preview on resume', async () => {
        const record = turn([assistant('progress', [text('progress-text', 'Still working'), readPart], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} />));
        expect(container.textContent).toContain('Still working');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => root.render(<Harness record={record} isWorking={false} />));
        expect(container.querySelector('[data-live-activity-content]')?.textContent).toBe('');
        expect(container.textContent).not.toContain('Still working');
        await act(async () => root.render(<Harness record={record} />));
        expect(container.textContent).toContain('Still working');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).not.toContain('Still working');
        expect(container.textContent).toContain('Activity');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Still working');
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
