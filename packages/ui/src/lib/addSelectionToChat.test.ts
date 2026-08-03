import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const focusChatInputCalls: number[] = [];
const pendingInputCalls: Array<{ text: string | null; mode?: string }> = [];
const activeMainTabCalls: string[] = [];
const sessionSwitcherCalls: boolean[] = [];

mock.module('@/components/chat/composer/editor/dom', () => ({
  focusChatInput: () => {
    focusChatInputCalls.push(1);
  },
}));

mock.module('@/sync/input-store', () => ({
  useInputStore: {
    getState: () => ({
      setPendingInputText: (text: string | null, mode?: string) => {
        pendingInputCalls.push({ text, mode });
      },
    }),
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      setActiveMainTab: (tab: string) => {
        activeMainTabCalls.push(tab);
      },
      setSessionSwitcherOpen: (open: boolean) => {
        sessionSwitcherCalls.push(open);
      },
    }),
  },
}));

const { addSelectionToChat, captureSelectionMarkdownForChat } = await import('./addSelectionToChat');

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

const installEmptySelectionEnvironment = (activeElement: Element | null = null) => {
  const documentLike = {
    activeElement,
    querySelector: () => null,
  };
  const windowLike = {
    getSelection: () => null,
  };
  Object.defineProperty(globalThis, 'document', { value: documentLike, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: windowLike, configurable: true });
};

const clearCalls = () => {
  focusChatInputCalls.length = 0;
  pendingInputCalls.length = 0;
  activeMainTabCalls.length = 0;
  sessionSwitcherCalls.length = 0;
};

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
});

describe('captureSelectionMarkdownForChat', () => {
  beforeEach(() => {
    clearCalls();
  });

  test('returns null when nothing is selected', () => {
    installEmptySelectionEnvironment();
    expect(captureSelectionMarkdownForChat()).toBeNull();
  });

  test('captures a textarea selection outside the composer', () => {
    const textarea = {
      tagName: 'TEXTAREA',
      value: 'alpha beta gamma',
      selectionStart: 6,
      selectionEnd: 10,
      closest: () => null,
    } as unknown as HTMLTextAreaElement;

    installEmptySelectionEnvironment(textarea);
    expect(captureSelectionMarkdownForChat()).toBe('```md\nbeta\n```');
  });

  test('ignores selections inside the chat composer', () => {
    const textarea = {
      tagName: 'TEXTAREA',
      value: 'draft text',
      selectionStart: 0,
      selectionEnd: 5,
      closest: (selector: string) => (selector === '[data-chat-input="true"]' ? textarea : null),
    } as unknown as HTMLTextAreaElement;

    installEmptySelectionEnvironment(textarea);
    expect(captureSelectionMarkdownForChat()).toBeNull();
  });
});

describe('addSelectionToChat', () => {
  beforeEach(() => {
    clearCalls();
  });

  test('appends captured selection and focuses chat input', async () => {
    const textarea = {
      tagName: 'TEXTAREA',
      value: 'selected',
      selectionStart: 0,
      selectionEnd: 8,
      closest: () => null,
    } as unknown as HTMLTextAreaElement;
    installEmptySelectionEnvironment(textarea);

    expect(addSelectionToChat()).toBe(true);
    expect(activeMainTabCalls).toEqual(['chat']);
    expect(sessionSwitcherCalls).toEqual([false]);
    expect(pendingInputCalls).toEqual([{ text: '```md\nselected\n```', mode: 'append' }]);

    await Promise.resolve();
    expect(focusChatInputCalls.length).toBe(1);
  });

  test('focuses chat input when nothing is selected', async () => {
    installEmptySelectionEnvironment();

    expect(addSelectionToChat()).toBe(false);
    expect(pendingInputCalls).toEqual([]);
    expect(activeMainTabCalls).toEqual(['chat']);

    await Promise.resolve();
    expect(focusChatInputCalls.length).toBe(1);
  });
});
