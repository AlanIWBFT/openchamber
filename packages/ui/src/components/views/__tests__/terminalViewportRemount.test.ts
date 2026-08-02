/**
 * Regression guard for slow terminal opening on Linux.
 *
 * `TerminalViewport` is keyed by `terminalViewportKey`. That key used to include
 * the PTY session id, which is null until `createSession` resolves. Historically,
 * the viewport had to mount first to report its size before session creation, so
 * every terminal open built a Ghostty terminal (WASM VT + 2D canvas renderer +
 * font atlas), threw it away when the session id arrived, and built a second one.
 * The same churn repeated on reconnect and on every incidental session-id change,
 * and the repeated WASM terminal allocate/free cycles are the suspected source of
 * the reported crashes.
 *
 * Viewport identity must therefore be directory + tab only. Session changes are
 * handled by the chunk replay path, which resets the existing terminal in place.
 * New sessions start concurrently with a container-derived size (or 80x24) and
 * resize after their viewport fits.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const terminalViewSource = readFileSync(join(__dirname, '..', 'TerminalView.tsx'), 'utf-8');
const terminalViewportSource = readFileSync(
    join(__dirname, '..', '..', 'terminal', 'TerminalViewport.tsx'),
    'utf-8',
);

const viewportKeyBlock = (() => {
    const start = terminalViewSource.indexOf('const terminalViewportKey = React.useMemo(');
    expect(start).toBeGreaterThan(-1);
    const end = terminalViewSource.indexOf('}, [', start);
    expect(end).toBeGreaterThan(start);
    return terminalViewSource.slice(start, terminalViewSource.indexOf(');', end));
})();

describe('terminal viewport remount guard', () => {
    test('viewport identity excludes the PTY session id', () => {
        expect(viewportKeyBlock).toContain('effectiveDirectory');
        expect(viewportKeyBlock).toContain('activeTabId');
        expect(viewportKeyBlock).not.toContain('terminalSessionId');
    });

    test('viewport key memo does not depend on the PTY session id', () => {
        const dependencyStart = terminalViewSource.indexOf('}, [', terminalViewSource.indexOf('const terminalViewportKey'));
        const dependencies = terminalViewSource.slice(dependencyStart, terminalViewSource.indexOf(']', dependencyStart));
        expect(dependencies).toContain('effectiveDirectory');
        expect(dependencies).toContain('activeTabId');
        expect(dependencies).not.toContain('terminalSessionId');
    });

    test('replay discontinuities reset the terminal in place instead of remounting it', () => {
        const start = terminalViewportSource.indexOf('const recreateRenderer = React.useCallback(');
        expect(start).toBeGreaterThan(-1);
        const body = terminalViewportSource.slice(start, terminalViewportSource.indexOf('}, []);', start));
        expect(body).toContain('terminal.reset()');
        // The generation bump stays only as the fallback when no terminal exists yet.
        expect(body.indexOf('if (!terminal)')).toBeLessThan(body.indexOf('terminal.reset()'));
    });

    test('scrollback is read from the buffer slice, not from the tab', () => {
        expect(terminalViewSource).toContain('getBuffer(');
        expect(terminalViewSource).not.toContain('activeTab?.bufferChunks');
    });

    test('starts the PTY before Ghostty reports its first viewport size', () => {
        expect(terminalViewSource).toContain('const FALLBACK_TERMINAL_SIZE = { cols: 80, rows: 24 } as const;');
        expect(terminalViewSource).toContain('const initialSize = lastViewportSizeRef.current ?? FALLBACK_TERMINAL_SIZE;');
        expect(terminalViewSource).not.toContain('if (!size && isTerminalVisibleRef.current)');
        expect(terminalViewSource).toContain('cols: initialSize.cols');
        expect(terminalViewSource).toContain('rows: initialSize.rows');
        expect(terminalViewSource).toContain('void terminal.resize({ sessionId: session.sessionId, ...viewportSize })');
        expect(terminalViewSource).toContain('if (!isTerminalVisible) {');
        expect(terminalViewSource).not.toContain('isTerminalVisibleRef');
    });

    test('deduplicates create attempts while the viewport layout settles', () => {
        expect(terminalViewSource).toContain('pendingTerminalCreatesRef.current.has(createKey)');
        expect(terminalViewSource).toContain('pendingTerminalCreatesRef.current.delete(createKey)');
    });

    test('derives the initial PTY size before Ghostty mounts', () => {
        expect(terminalViewportSource).toContain('const getProvisionalTerminalSize');
        expect(terminalViewportSource).toContain('React.useLayoutEffect(() => {');
        expect(terminalViewportSource).toContain('resizeRef.current(size.cols, size.rows)');
        expect(terminalViewportSource).toContain('...(provisionalSizeRef.current ?? {})');
    });
});
