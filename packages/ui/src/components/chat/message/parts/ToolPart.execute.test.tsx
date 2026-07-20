import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useGuestsStore } from '@/lib/guests/store';
import { defaultExpandedScriptToolIDs } from '@/lib/opencode/script';
import type { ToolExpansionState } from './ToolPart';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-guest-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('./ToolPart');

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpectedThemeChange,
  customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange,
  importTheme: unexpectedThemeChange,
  deleteImportedTheme: unexpectedThemeChange,
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: unexpectedThemeChange,
  themeMode: 'light',
  setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange,
  setDarkThemePreference: unexpectedThemeChange,
};

const part: ToolPartData = {
  id: 'prt_execute', sessionID: 'ses_exec', messageID: 'msg_exec',
  type: 'tool', tool: 'execute', callID: 'call_exec',
  state: {
    status: 'completed',
    input: { code: 'const issues = await linear.list_issues({ teamId: "OPE" });\nreturn issues;' },
    output: '{"count":3}',
    metadata: {
      truncated: true,
      outputPath: '/tmp/oc-script-output.json',
      toolCalls: [
        { tool: 'linear.list_issues', status: 'completed', input: { teamId: 'OPE' } },
        { tool: 'linear.list_issues', status: 'error', input: { teamId: 'OPE' } },
        { tool: 'linear.get_workspace', status: 'completed' },
      ],
    },
    time: { start: 1, end: 2 },
  },
};

async function withToolPart(check: (container: HTMLElement, render: (part: ToolPartData | null, nestedTools?: ToolExpansionState) => Promise<void>) => Promise<void>) {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });

  try {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    const render = async (part: ToolPartData | null, nestedTools?: ToolExpansionState) => act(async () => {
      root.render(part ? (
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={part} nestedTools={nestedTools} isExpanded isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>
      ) : null);
    });
    await check(container, render);
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test('a Code Mode call shows its script, the tools it called, and the truncation note', async () => {
  await withToolPart(async (container, render) => {
    await render(part);
    // The row is named "Script", not "execute", and carries the braces icon.
    expect(container.textContent).toContain('Script');
    expect(container.textContent).not.toContain('execute');
    expect(container.querySelector('use[href="#oc-braces"]')).not.toBeNull();

    // The description names the called tools, deduplicated and counted.
    expect(container.textContent).toContain('linear.list_issues \u00d72, linear.get_workspace');

    // The body lists every call with its input, and reports the truncated output.
    expect(container.textContent).toContain('Tool calls');
    expect(container.textContent).toContain('{"teamId":"OPE"}');
    expect(container.textContent).toContain('Output was truncated');
    expect(container.textContent).toContain('/tmp/oc-script-output.json');
  });
});

test('Script exploration shares its disclosure and keeps full directory results behind it', async () => {
  const script: ToolPartData = { ...part, state: {
    status: 'completed', input: { code: 'await tools.read()' }, output: '', time: { start: 1, end: 2 },
    metadata: { toolCalls: [{ id: 'read-child', name: 'read', tool: 'functions.read', status: 'completed',
      input: { path: '/repo/src' }, time: { start: 1, end: 2 },
      content: [{ type: 'text', text: 'Read directory /repo/src, entries 1-1\nnested-file.ts' }],
    }] },
  } };
  await withToolPart(async (container, render) => {
    const toggled: string[] = [];
    const childID = `${script.id}:child:read-child`;
    const toggle = (id: string) => { toggled.push(id); };
    await render(script, { expanded: new Set([childID]), toggle });
    const group = container.querySelector('[data-exploration-group]');
    const groupID = group?.getAttribute('data-exploration-group');
    if (!group || !groupID) throw new Error('Expected the Script exploration disclosure');
    expect(container.textContent).not.toContain('nested-file.ts');
    await act(async () => { group.querySelector<HTMLButtonElement>('button')?.click(); });
    expect(toggled).toEqual([groupID]);
    await render(script, { expanded: new Set([groupID, childID]), toggle });
    expect(container.textContent).toContain('nested-file.ts');
    await render(script, { expanded: new Set([childID]), toggle });
    expect(container.textContent).not.toContain('nested-file.ts');
  });
});

test('Script children use real cards, redact controls, and recover the message owner expansion state after remount', async () => {
  const script: ToolPartData = { ...part, state: {
    status: 'completed', input: { code: 'await functions.exec_command({ cmd: "echo test" })' }, output: 'script result', time: { start: 1, end: 2 },
    metadata: { toolCalls: [
      { id: 'command', name: 'exec_command', tool: 'functions.exec_command', status: 'completed', input: { cmd: 'echo test' }, time: { start: 1, end: 2 },
        content: [{ type: 'text', text: 'initial result' }], metadata: { command: 'echo test', output: 'latest command output', execID: 1, processRunning: false } },
      { id: 'poll', name: 'poll_exec', tool: 'functions.poll_exec', status: 'completed', input: { exec_id: 1 }, time: { start: 1, end: 2 } },
      { id: 'input', name: 'write_stdin', tool: 'functions.write_stdin', status: 'error', input: { exec_id: 1, chars: 'sensitive input' },
        error: 'stdin unavailable', time: { start: 1, end: 2 } },
    ] },
  } };
  await withToolPart(async (container, render) => {
    const expanded = new Set(defaultExpandedScriptToolIDs(script, { shell: true, edit: false }));
    expanded.add('prt_execute:child:input');
    const toggled: string[] = [];
    const nestedTools: ToolExpansionState = { expanded, toggle: (id) => { toggled.push(id); } };
    await render(script, nestedTools);
    expect(container.textContent).toContain('latest command output');
    expect(container.textContent).toContain('stdin unavailable');
    expect(container.textContent).not.toContain('sensitive input');
    const command = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((element) => element.textContent?.includes('Shell Command'));
    expect(command).toBeDefined();
    await act(async () => { command?.click(); });
    expect(toggled).toEqual(['prt_execute:child:command']);
    await render(script, { ...nestedTools, expanded: new Set() });
    expect(container.textContent).not.toContain('latest command output');
    await render(null);
    await render(script, nestedTools);
    expect(container.textContent).toContain('latest command output');
    expect(container.textContent).not.toContain('sensitive input');
  });
});
