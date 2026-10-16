import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type RequestContext = { directory: string | null; sessionId: string | null };
type Listener = (event: {
  type: string;
  requestId: string;
  action: string;
  parameters: Record<string, unknown>;
  context: RequestContext;
}) => void;

const posted: Array<{ requestId: string; ok: boolean; data?: unknown; error?: string }> = [];
const claims: string[] = [];
/** Flipped to false to play the client that lost the race for a request. */
let grantClaims = true;
let beforeClaim: (() => Promise<void>) | null = null;
let listener: Listener | null = null;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (path.endsWith('/claim')) {
      claims.push(body.requestId);
      await beforeClaim?.();
      return { ok: true, status: 200, json: async () => ({ granted: grantClaims }) };
    }
    posted.push(body);
    return { ok: true, status: 200 };
  }),
}));
mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (handler: Listener) => {
    listener = handler;
    return () => { listener = null; };
  },
}));

const {
  registerBrowserController,
  registerBrowserOpener,
  registerSleepingBrowserTab,
  setShownBrowserTab,
} = await import('./controlClient');

const registerOpener = (
  open: Parameters<typeof registerBrowserOpener>[0]['open'],
  tabs: Parameters<typeof registerBrowserOpener>[0]['tabs'] = () => [],
) => registerBrowserOpener({ open, tabs });

/** A request from an older server or a caller with no session. */
const UNKNOWN_CONTEXT: RequestContext = { directory: null, sessionId: null };
/** The project every tab below lives in unless a test says otherwise. */
const REPO = '/repo';

/** Registrations are module-global, so every test unwinds its own. */
const cleanups: Array<() => void> = [];

const emitOpen = (parameters: Record<string, unknown>, context: RequestContext = UNKNOWN_CONTEXT, requestId = 'req-1'): void => {
  listener?.({ type: 'browser-control-request', requestId, action: 'browser.open', parameters, context });
};

const emit = (action: string, parameters: Record<string, unknown>, context: RequestContext = UNKNOWN_CONTEXT): void => {
  listener?.({ type: 'browser-control-request', requestId: 'req-1', action, parameters, context });
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A mounted tab that records the actions it ran. */
const tab = (
  tabId: string,
  ran: string[],
  { directory = REPO, ownerSessionId = null }: { directory?: string; ownerSessionId?: string | null } = {},
) => registerBrowserController({
  tabId,
  directory,
  ownerSessionId,
  describe: () => ({ title: `Title ${tabId}`, url: `https://${tabId}.test/` }),
  run: async (action) => { ran.push(`${tabId}:${action}`); return { url: `https://${tabId}.test/` }; },
});

const resetRequests = (): void => {
  posted.length = 0;
  claims.length = 0;
  grantClaims = true;
  beforeClaim = null;
  setShownBrowserTab(REPO, null);
};

describe('opening a page before any view exists', () => {
  beforeEach(resetRequests);

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  test('lets the view that the open created apply the layout that was asked for', async () => {
    Object.defineProperty(globalThis, 'window', { value: { __OPENCHAMBER_ELECTRON__: {} }, configurable: true, writable: true });
    cleanups.push(() => Reflect.deleteProperty(globalThis, 'window'));
    const opened: string[] = [];
    const ran: Array<{ action: string; parameters: Record<string, unknown> }> = [];

    cleanups.push(registerOpener((url) => {
      opened.push(url);
      // The pane mounts a moment after the tab is created, as it does in the app.
      setTimeout(() => {
        cleanups.push(registerBrowserController({
          tabId: 'tab-new',
          directory: REPO,
          ownerSessionId: null,
          describe: () => ({ title: '', url: '' }),
          run: async (action, parameters) => {
            ran.push({ action, parameters });
            return { viewport: { mode: 'mobile', width: 390, height: 844 } };
          },
        }));
      }, 120);
      return 'tab-new';
    }));

    emitOpen({ url: 'https://example.test', viewport: 'mobile' });
    await wait(400);

    expect(opened).toEqual(['https://example.test']);
    expect(ran).toEqual([{ action: 'browser.resize', parameters: { viewport: 'mobile' } }]);
    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      opened: true,
      tabId: 'tab-new',
      tabCreated: true,
      viewportApplied: true,
      viewport: { mode: 'mobile', width: 390, height: 844 },
      drivable: true,
    });
  });

  test('does nothing at all when another client was granted the request', async () => {
    grantClaims = false;
    const opened: string[] = [];
    const ran: string[] = [];
    cleanups.push(registerOpener((url) => { opened.push(url); return 'tab-new'; }));
    cleanups.push(tab('tab-1', ran));

    emitOpen({ url: 'https://example.test' });
    await wait(50);

    expect(claims).toEqual(['req-1']);
    // The losing client must not act: a late result cannot undo a click.
    expect(ran).toEqual([]);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('claims the request before touching a page', async () => {
    const ran: string[] = [];
    cleanups.push(tab('tab-1', ran));

    emit('browser.click', { selector: 'button' });
    await wait(50);

    expect(claims).toEqual(['req-1']);
    expect(ran).toEqual(['tab-1:browser.click']);
  });

  test('does not wait for a view when no layout was requested', async () => {
    cleanups.push(registerOpener(() => 'tab-new'));

    emitOpen({ url: 'https://example.test' });
    await wait(20);

    expect(posted[0]?.data).toEqual({ url: 'https://example.test', opened: true, tabId: 'tab-new', tabCreated: true, drivable: false });
  });

  test('on a driving host, an open reports that the page can be driven', async () => {
    // Only an Electron renderer can drive the page it shows.
    Object.defineProperty(globalThis, 'window', { value: { __OPENCHAMBER_ELECTRON__: {} }, configurable: true, writable: true });
    cleanups.push(() => Reflect.deleteProperty(globalThis, 'window'));
    cleanups.push(registerOpener(() => 'tab-new'));

    emitOpen({ url: 'https://example.test' });
    await wait(20);

    expect(posted[0]?.data).toEqual({ url: 'https://example.test', opened: true, tabId: 'tab-new', tabCreated: true, drivable: true });
  });

  test('display-only hosts report an unsupported viewport without failing a created tab', async () => {
    cleanups.push(registerOpener(() => 'tab-new'));
    emitOpen({ url: 'https://example.test', viewport: 'mobile' });
    await wait(20);
    expect(posted[0]).toMatchObject({ ok: true, data: {
      tabId: 'tab-new', tabCreated: true, drivable: false, viewportApplied: false,
    } });
  });

  test('says the layout was not applied when no view ever appears', async () => {
    Object.defineProperty(globalThis, 'window', { value: { __OPENCHAMBER_ELECTRON__: {} }, configurable: true, writable: true });
    cleanups.push(() => Reflect.deleteProperty(globalThis, 'window'));
    cleanups.push(registerOpener(() => 'tab-new'));

    emitOpen({ url: 'https://example.test', viewport: 'mobile' });
    // Past the client's own attach deadline.
    await wait(2_400);

    const data = posted[0]?.data as { viewportApplied?: boolean; note?: string };
    expect(data.viewportApplied).toBe(false);
    expect(typeof data.note).toBe('string');
  });
});

describe('choosing the tab an action runs in', () => {
  beforeEach(resetRequests);

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  test('runs in the tab the user sees, not the one that registered last', async () => {
    const ran: string[] = [];
    cleanups.push(tab('shown', ran));
    cleanups.push(tab('background', ran));
    setShownBrowserTab(REPO, 'shown');

    emit('browser.click', { selector: 'button' });
    await wait(50);

    expect(ran).toEqual(['shown:browser.click']);
  });

  test('runs in the named tab and passes the rest of the parameters without tabId', async () => {
    const seen: Array<Record<string, unknown>> = [];
    cleanups.push(tab('shown', []));
    cleanups.push(registerBrowserController({
      tabId: 'background',
      directory: REPO,
      ownerSessionId: null,
      describe: () => ({ title: '', url: '' }),
      run: async (_action, parameters) => { seen.push(parameters); return {}; },
    }));
    setShownBrowserTab(REPO, 'shown');

    emit('browser.click', { selector: 'button', tabId: 'background' });
    await wait(50);

    expect(seen).toEqual([{ selector: 'button' }]);
  });

  test('lists every tab in a snapshot, marking the one the user sees', async () => {
    cleanups.push(tab('shown', []));
    cleanups.push(tab('background', []));
    setShownBrowserTab(REPO, 'shown');

    emit('browser.snapshot', {});
    await wait(50);

    expect(posted[0]?.data).toEqual({
      url: 'https://shown.test/',
      tabs: [
        { id: 'shown', title: 'Title shown', url: 'https://shown.test/', owner: 'user', active: true },
        { id: 'background', title: 'Title background', url: 'https://background.test/', owner: 'user', active: false },
      ],
    });
  });

  test('refuses an unknown tab instead of acting on another one', async () => {
    const ran: string[] = [];
    cleanups.push(tab('shown', ran));

    emit('browser.click', { selector: 'button', tabId: 'gone' });
    await wait(600);

    expect(ran).toEqual([]);
    expect(posted[0]?.ok).toBe(false);
    expect(posted[0]?.error).toContain('no browser tab with id gone');
  });

  test('opens a page in a new background tab instead of replacing the one the user sees', async () => {
    const ran: string[] = [];
    const opened: string[] = [];
    cleanups.push(tab('shown', ran));
    setShownBrowserTab(REPO, 'shown');
    cleanups.push(registerOpener((url) => { opened.push(url); return 'agent-tab'; }));

    emit('browser.open', { url: 'https://example.test' });
    await wait(50);

    expect(ran).toEqual([]);
    expect(opened).toEqual(['https://example.test']);
    expect(posted[0]?.data).toEqual({ url: 'https://example.test', opened: true, tabId: 'agent-tab', tabCreated: true, drivable: false });
  });

  test('navigates the named tab when browser.open gives one', async () => {
    const ran: string[] = [];
    const opened: string[] = [];
    cleanups.push(tab('agent-tab', ran));
    cleanups.push(registerOpener((url) => { opened.push(url); return 'other'; }));

    emit('browser.open', { url: 'https://example.test', tabId: 'agent-tab' });
    await wait(50);

    expect(opened).toEqual([]);
    expect(ran).toEqual(['agent-tab:browser.open']);
    expect(posted[0]?.data).toMatchObject({ tabId: 'agent-tab', tabCreated: false });
  });
});

/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/3313:
 * two sessions sharing one browser panel must not read or drive each other's
 * pages, and a page opened by a session in another project lands in that
 * project.
 */
describe('tabs belong to the session that opened them', () => {
  beforeEach(resetRequests);

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  const sessionA: RequestContext = { directory: '/repo-a', sessionId: 'ses_a' };
  const sessionB: RequestContext = { directory: '/repo-b', sessionId: 'ses_b' };

  test('waits for the last created tab instead of navigating an older mounted page', async () => {
    const ran: string[] = [];
    const opened: string[] = [];
    let created = false;
    cleanups.push(tab('older', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    cleanups.push(registerOpener((url) => {
      opened.push(url);
      created = true;
      return 'pending';
    }, () => created ? [{
      tabId: 'pending', directory: '/repo-a', ownerSessionId: 'ses_a',
      describe: () => ({ title: '', url: opened[0] }), wake: () => {},
    }] : []));

    emitOpen({ url: 'https://login.test', newTab: true }, sessionA, 'create');
    await wait(20);
    emitOpen({ url: 'https://login.test/account' }, sessionA, 'reuse');
    await wait(60);
    expect(ran).toEqual([]);
    expect(opened).toEqual(['https://login.test']);
    expect(posted).toHaveLength(1);
    cleanups.push(tab('pending', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    await wait(80);
    expect(ran).toEqual(['pending:browser.open']);
    expect(posted[1]).toMatchObject({ requestId: 'reuse', data: { tabId: 'pending', tabCreated: false } });
  });

  test('concurrent default opens create one tab even before its controller registers', async () => {
    let releaseClaim = () => {};
    const claim = new Promise<void>((resolve) => { releaseClaim = resolve; });
    beforeClaim = () => claim;
    const opened: string[] = [];
    const ran: string[] = [];
    const catalog: ReturnType<Parameters<typeof registerBrowserOpener>[0]['tabs']>[number][] = [];
    cleanups.push(registerOpener((url) => {
      opened.push(url);
      const tabId = `concurrent-${opened.length}`;
      catalog.push({
        tabId, directory: '/repo-a', ownerSessionId: 'ses_a',
        describe: () => ({ title: '', url }), wake: () => {},
      });
      return tabId;
    }, () => catalog));
    emitOpen({ url: 'https://first.test' }, sessionA, 'first');
    emitOpen({ url: 'https://second.test' }, sessionA, 'second');
    await wait(500);
    releaseClaim();
    await wait(30);
    expect(claims).toEqual(['first', 'second']);
    expect(opened).toHaveLength(1);
    expect(posted).toHaveLength(1);
    cleanups.push(tab('concurrent-1', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    await wait(80);
    expect(ran).toEqual(['concurrent-1:browser.open']);
    expect(posted[1]).toMatchObject({ requestId: 'second', data: { tabId: 'concurrent-1', tabCreated: false } });
  });

  test('failed attachment keeps the pending target until the user closes that tab', async () => {
    const ran: string[] = [];
    const opened: string[] = [];
    let created = false;
    cleanups.push(tab('older', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    cleanups.push(registerOpener((url) => {
      opened.push(url);
      created = true;
      return 'never-mounted';
    }, () => created ? [{
      tabId: 'never-mounted', directory: '/repo-a', ownerSessionId: 'ses_a',
      describe: () => ({ title: '', url: opened[0] }), wake: () => {},
    }] : []));
    emitOpen({ url: 'https://login.test', newTab: true }, sessionA, 'create');
    await wait(20);
    emitOpen({ url: 'https://login.test/account' }, sessionA, 'reuse');
    await wait(2_200);
    expect(ran).toEqual([]);
    expect(opened).toHaveLength(1);
    expect(posted[1]?.ok).toBe(false);
    expect(posted[1]?.error).toContain('never-mounted could not be loaded');
    created = false;
    emitOpen({ url: 'https://other.test' }, sessionA, 'after-close');
    await wait(50);
    expect(ran).toEqual(['older:browser.open']);
    expect(posted[2]).toMatchObject({ data: { tabId: 'older', tabCreated: false } });
  });

  test('rechecks catalog removal during the claim instead of targeting a closed pending tab', async () => {
    let releaseClaim = () => {};
    const claim = new Promise<void>((resolve) => { releaseClaim = resolve; });
    beforeClaim = () => claim;
    let existing = true;
    const opened: string[] = [];
    cleanups.push(registerOpener((url) => { opened.push(url); return 'replacement'; }, () => existing ? [{
      tabId: 'closing', directory: '/repo-a', ownerSessionId: 'ses_a',
      describe: () => ({ title: '', url: 'https://closing.test' }), wake: () => {},
    }] : []));
    emitOpen({ url: 'https://new.test' }, sessionA);
    await wait(20);
    existing = false;
    releaseClaim();
    await wait(30);
    expect(opened).toEqual(['https://new.test']);
    expect(posted[0]).toMatchObject({ data: { tabId: 'replacement', tabCreated: true } });
  });

  test('reuses the page after the first open, including when the user switches to another owned tab', async () => {
    const ran: string[] = [];
    const opened: string[] = [];
    cleanups.push(registerOpener((url, context) => {
      opened.push(url);
      cleanups.push(tab('reused', ran, { directory: '/repo-a', ownerSessionId: context.sessionId }));
      return 'reused';
    }));
    emitOpen({ url: 'https://login.test' }, sessionA);
    await wait(500);
    cleanups.push(tab('other-owned', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    setShownBrowserTab('/repo-a', 'other-owned');
    posted.length = 0;
    emit('browser.snapshot', {}, sessionA);
    await wait(50);
    emitOpen({ url: 'https://login.test/account' }, sessionA);
    await wait(50);
    expect(opened).toEqual(['https://login.test']);
    expect(ran).toEqual(['reused:browser.snapshot', 'reused:browser.open']);
    expect(posted[1]?.data).toMatchObject({ tabId: 'reused', tabCreated: false });
  });

  test('explicit newTab creates another page without navigating the existing one', async () => {
    const ran: string[] = [];
    const opened: string[] = [];
    cleanups.push(tab('existing', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    cleanups.push(registerOpener((url) => { opened.push(url); return 'fresh'; }));
    emitOpen({ url: 'https://compare.test', newTab: true }, sessionA);
    await wait(50);
    expect(opened).toEqual(['https://compare.test']);
    expect(ran).toEqual([]);
    expect(posted[0]?.data).toMatchObject({ tabId: 'fresh', tabCreated: true });
  });

  test('default open never navigates a user or another session tab', async () => {
    const ran: string[] = [];
    cleanups.push(tab('user-page', ran, { directory: '/repo-a' }));
    cleanups.push(tab('another-session', ran, { directory: '/repo-a', ownerSessionId: 'ses_b' }));
    setShownBrowserTab('/repo-a', 'user-page');
    cleanups.push(registerOpener(() => 'own-new'));
    emitOpen({ url: 'https://own.test' }, sessionA);
    await wait(100);
    expect(claims).toEqual([]);
    await wait(400);
    expect(ran).toEqual([]);
    expect(posted[0]?.data).toMatchObject({ tabId: 'own-new', tabCreated: true });
  });

  test('a client with no owned tab lets another client reuse the session tab first', async () => {
    const opened: string[] = [];
    cleanups.push(registerOpener((url) => { opened.push(url); return 'duplicate'; }));
    emitOpen({ url: 'https://own.test' }, sessionA);
    await wait(100);
    expect(claims).toEqual([]);
    grantClaims = false;
    await wait(400);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('newTab fails when no opener exists instead of reusing a page', async () => {
    const ran: string[] = [];
    cleanups.push(tab('existing', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    emitOpen({ url: 'https://new.test', newTab: true }, sessionA);
    await wait(500);
    expect(ran).toEqual([]);
    expect(posted[0]?.ok).toBe(false);
  });

  test('default open wakes its owned sleeping tab instead of creating a new one', async () => {
    const ran: string[] = [];
    const opened: string[] = [];
    cleanups.push(registerSleepingBrowserTab({
      tabId: 'owned-sleeping', directory: '/repo-a', ownerSessionId: 'ses_a',
      describe: () => ({ title: '', url: 'https://old.test' }),
      wake: () => { cleanups.push(tab('owned-sleeping', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' })); },
    }));
    cleanups.push(registerOpener((url) => { opened.push(url); return 'duplicate'; }));
    emitOpen({ url: 'https://new.test' }, sessionA);
    await wait(50);
    expect(opened).toEqual([]);
    expect(ran).toEqual(['owned-sleeping:browser.open']);
    expect(posted[0]?.data).toMatchObject({ tabId: 'owned-sleeping', tabCreated: false });
  });

  test('opens the tab with the calling session and its project', async () => {
    const contexts: RequestContext[] = [];
    cleanups.push(registerOpener((_url, context) => { contexts.push(context); return 'tab-a'; }));

    emitOpen({ url: 'https://a.test' }, sessionA);
    await wait(500);

    expect(contexts).toEqual([sessionA]);
  });

  test("an action without tabId runs in the session's own tab, not the one on screen", async () => {
    const ran: string[] = [];
    cleanups.push(tab('tab-a', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    cleanups.push(tab('tab-b', ran, { directory: '/repo-b', ownerSessionId: 'ses_b' }));
    setShownBrowserTab('/repo-b', 'tab-b');

    emit('browser.snapshot', {}, sessionA);
    await wait(50);

    expect(ran).toEqual(['tab-a:browser.snapshot']);
  });

  test('returns to the tab the session opened last', async () => {
    const ran: string[] = [];
    cleanups.push(tab('tab-a1', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    cleanups.push(registerOpener(() => 'tab-a2'));
    emitOpen({ url: 'https://a2.test', newTab: true }, sessionA);
    await wait(20);
    cleanups.push(tab('tab-a2', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    // A tab of the same session that registers later, as a restored one does
    // when it wakes, does not take over.
    cleanups.push(tab('tab-a3', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    posted.length = 0;

    emit('browser.click', { selector: 'button' }, sessionA);
    await wait(50);

    expect(ran).toEqual(['tab-a2:browser.click']);
  });

  test("never drives another session's tab, and says why", async () => {
    const ran: string[] = [];
    cleanups.push(tab('tab-a', ran, { directory: '/repo-b', ownerSessionId: 'ses_a' }));
    setShownBrowserTab('/repo-b', 'tab-a');

    emit('browser.click', { selector: 'button' }, sessionB);
    await wait(600);

    expect(ran).toEqual([]);
    expect(posted[0]?.ok).toBe(false);
    expect(posted[0]?.error).toContain('no browser tab of its own');
    // Another session's tab in the caller's project is listed, so the agent
    // can still use it when the user asks for it by name.
    expect(posted[0]?.error).toContain('tab-a');
  });

  test("uses the user's tab on screen when the session has none of its own", async () => {
    const ran: string[] = [];
    cleanups.push(tab('mine', ran, { directory: '/repo-b' }));
    setShownBrowserTab('/repo-b', 'mine');

    emit('browser.snapshot', {}, sessionB);
    // Past the head start a client holding the session's own tab gets.
    await wait(600);

    expect(ran).toEqual(['mine:browser.snapshot']);
    expect(posted[0]?.data).toEqual({
      url: 'https://mine.test/',
      tabs: [{ id: 'mine', title: 'Title mine', url: 'https://mine.test/', owner: 'user', active: true }],
    });
  });

  test("leaves the user's tab alone when it is in another project", async () => {
    const ran: string[] = [];
    cleanups.push(tab('mine', ran, { directory: '/repo-b' }));
    setShownBrowserTab('/repo-b', 'mine');

    emit('browser.click', { selector: 'button' }, sessionA);
    await wait(600);

    expect(ran).toEqual([]);
    expect(posted[0]?.ok).toBe(false);
    // Not offered as a target either.
    expect(posted[0]?.error).not.toContain('mine');
  });

  test("lets a client holding the session's own tab claim before falling back to the user's tab", async () => {
    const ran: string[] = [];
    cleanups.push(tab('mine', ran, { directory: '/repo-a' }));
    setShownBrowserTab('/repo-a', 'mine');

    emit('browser.click', { selector: 'button' }, sessionA);
    await wait(100);
    expect(claims).toEqual([]);

    await wait(500);
    expect(claims).toEqual(['req-1']);
    expect(ran).toEqual(['mine:browser.click']);
  });

  test("a request with no session stays out of another project's agent tab", async () => {
    const ran: string[] = [];
    cleanups.push(tab('elsewhere', ran, { directory: '/repo-c', ownerSessionId: 'ses_c' }));

    emit('browser.click', { selector: 'button' });
    await wait(50);

    expect(ran).toEqual([]);
    expect(claims).toEqual([]);
  });

  test('a named tab runs wherever it belongs, and the listing says who opened each', async () => {
    const ran: string[] = [];
    cleanups.push(tab('tab-a', ran, { directory: '/repo-a', ownerSessionId: 'ses_a' }));
    cleanups.push(tab('tab-b', ran, { directory: '/repo-a', ownerSessionId: 'ses_b' }));
    cleanups.push(tab('elsewhere', ran, { directory: '/repo-c', ownerSessionId: 'ses_c' }));

    emit('browser.snapshot', { tabId: 'tab-b' }, sessionA);
    await wait(50);

    expect(ran).toEqual(['tab-b:browser.snapshot']);
    expect(posted[0]?.data).toEqual({
      url: 'https://tab-b.test/',
      tabs: [
        { id: 'tab-a', title: 'Title tab-a', url: 'https://tab-a.test/', owner: 'you', active: true },
        { id: 'tab-b', title: 'Title tab-b', url: 'https://tab-b.test/', owner: 'another session', active: false },
      ],
    });
  });
});

describe('tabs that have not loaded their page yet', () => {
  beforeEach(resetRequests);

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  /** A sleeping tab whose view mounts a moment after it is woken, as in the app. */
  const sleepingTab = (tabId: string, ran: string[], woken: string[]) => {
    let release = () => {};
    release = registerSleepingBrowserTab({
      tabId,
      directory: REPO,
      ownerSessionId: null,
      describe: () => ({ title: '', url: `https://${tabId}.test/` }),
      wake: () => {
        woken.push(tabId);
        setTimeout(() => {
          release();
          cleanups.push(tab(tabId, ran));
        }, 80);
      },
    });
    return () => release();
  };

  test('lists sleeping tabs without waking them', async () => {
    const woken: string[] = [];
    cleanups.push(registerBrowserController({
      tabId: 'loaded',
      directory: REPO,
      ownerSessionId: null,
      describe: () => ({ title: 'Loaded', url: 'https://loaded.test/' }),
      run: async () => ({ url: 'https://loaded.test/' }),
    }));
    cleanups.push(sleepingTab('asleep', [], woken));
    setShownBrowserTab(REPO, 'loaded');

    emit('browser.snapshot', {});
    await wait(50);

    expect(woken).toEqual([]);
    expect(posted[0]?.data).toEqual({
      url: 'https://loaded.test/',
      tabs: [
        { id: 'loaded', title: 'Loaded', url: 'https://loaded.test/', owner: 'user', active: true },
        { id: 'asleep', title: '', url: 'https://asleep.test/', owner: 'user', active: false },
      ],
    });
  });

  test('wakes a named sleeping tab only after the claim, then runs there', async () => {
    const ran: string[] = [];
    const woken: string[] = [];
    cleanups.push(sleepingTab('asleep', ran, woken));

    grantClaims = false;
    emit('browser.click', { selector: 'button', tabId: 'asleep' });
    await wait(200);
    expect(woken).toEqual([]);

    grantClaims = true;
    emit('browser.click', { selector: 'button', tabId: 'asleep' });
    await wait(300);
    expect(woken).toEqual(['asleep']);
    expect(ran).toEqual(['asleep:browser.click']);
    expect(posted[0]?.ok).toBe(true);
  });

  test('wakes the shown tab when an action names none', async () => {
    const ran: string[] = [];
    const woken: string[] = [];
    cleanups.push(sleepingTab('shown-asleep', ran, woken));
    setShownBrowserTab(REPO, 'shown-asleep');

    emit('browser.snapshot', {});
    await wait(300);

    expect(woken).toEqual(['shown-asleep']);
    expect(ran).toEqual(['shown-asleep:browser.snapshot']);
  });

  test('says so when a woken tab never gets a view', async () => {
    cleanups.push(registerSleepingBrowserTab({
      tabId: 'stuck',
      directory: REPO,
      ownerSessionId: null,
      describe: () => ({ title: '', url: '' }),
      wake: () => {},
    }));

    emit('browser.click', { selector: 'button', tabId: 'stuck' });
    await wait(2_400);

    expect(posted[0]?.ok).toBe(false);
    expect(posted[0]?.error).toContain('could not be loaded');
  });
});
