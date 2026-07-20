import { describe, expect, test } from 'bun:test';

import {
    countExplorationTools,
    formatDirectoryDisplayPath,
    getReadToolDisplayType,
    isExpandableTool,
    isExplorationPartDisplayReady,
    isExplorationTool,
    isHiddenSessionTool,
    isStaticTool,
} from './toolRenderUtils';
import { parseReadToolOutput } from '../toolRenderers';

describe('tool rendering classification', () => {
    test('renders read with the standard expandable tool card', () => {
        expect(isStaticTool('read')).toBe(false);
        expect(isStaticTool('skill')).toBe(true);
        expect(isExpandableTool('read')).toBe(true);
        expect(isExpandableTool('skill')).toBe(false);
    });

    test('expands built-in tools without compact interactions', () => {
        expect(isExpandableTool('grep')).toBe(true);
        expect(isExpandableTool('webfetch')).toBe(true);
        expect(isExpandableTool('todowrite')).toBe(true);
        expect(isExpandableTool('plan_exit')).toBe(true);
    });

    test('expands custom and MCP tools', () => {
        expect(isExpandableTool('linear_list_issues')).toBe(true);
        expect(isExpandableTool('my-plugin_publish')).toBe(true);
        expect(isStaticTool('linear_list_issues')).toBe(false);
    });

    test('normalizes dotted and indexed tool names', () => {
        expect(isExpandableTool('runtime.read:2')).toBe(true);
        expect(isExpandableTool('runtime.custom_tool:2')).toBe(true);
    });

    test('hides only built-in todo updates from session rendering', () => {
        expect(isHiddenSessionTool('todowrite', 'completed')).toBe(true);
        expect(isHiddenSessionTool('todowrite:2', 'running')).toBe(true);
        expect(isHiddenSessionTool('todoread', 'completed')).toBe(false);
        expect(isHiddenSessionTool('plugin.todowrite', 'completed')).toBe(false);
    });

    test('keeps failed todo updates visible', () => {
        expect(isHiddenSessionTool('todowrite', 'error')).toBe(false);
        expect(isHiddenSessionTool('todowrite', 'failed')).toBe(false);
        expect(isHiddenSessionTool('todowrite', 'timeout')).toBe(false);
        expect(isHiddenSessionTool('todowrite', 'cancelled')).toBe(false);
        expect(isHiddenSessionTool('todowrite', 'aborted')).toBe(false);
    });
});

describe('exploration tools', () => {
    test('counts built-in searches and reads without including namespaced custom tools', () => {
        expect(countExplorationTools(['glob', 'grep', 'list', 'read:0', 'plugin.read'])).toEqual({
            search: 3,
            read: 1,
        });
    });

    test('recognizes only exact built-in exploration names', () => {
        expect(isExplorationTool('grep:2')).toBe(true);
        expect(isExplorationTool('mcp.server.grep')).toBe(false);
    });

    test('requires active state or authoritative completion time for display', () => {
        expect(isExplorationPartDisplayReady({ state: { status: 'running' } })).toBe(true);
        expect(isExplorationPartDisplayReady({ state: { status: 'error' } })).toBe(true);
        expect(isExplorationPartDisplayReady({ state: { status: 'cancelled' } })).toBe(true);
        expect(isExplorationPartDisplayReady({ state: { status: 'completed' } })).toBe(false);
        expect(isExplorationPartDisplayReady({ state: { status: 'completed', time: { start: 2, end: 1 } } })).toBe(false);
        expect(isExplorationPartDisplayReady({ state: { status: 'completed', time: { start: 1, end: 2 } } })).toBe(true);
    });
});

describe('read tool output', () => {
    test('uses authoritative display metadata before tagged output fallback', () => {
        expect(getReadToolDisplayType({ display: { type: 'directory' } }, '<type>file</type>')).toBe('directory');
        expect(getReadToolDisplayType({}, '<type>directory</type>')).toBe('directory');
        expect(getReadToolDisplayType({}, 'Image read successfully')).toBe('unknown');
    });

    test('adds a trailing slash only when a directory display path has no slash', () => {
        expect(formatDirectoryDisplayPath('.')).toBe('./');
        expect(formatDirectoryDisplayPath('mydir')).toBe('mydir/');
        expect(formatDirectoryDisplayPath('parent/mydir')).toBe('parent/mydir');
        expect(formatDirectoryDisplayPath('/')).toBe('/');
    });

    test('converts directory entries to multiline text without result tags', () => {
        const parsed = parseReadToolOutput([
            '<path>/repo/src</path>',
            '<type>directory</type>',
            '<entries>',
            'components/',
            'index.ts',
            '(2 entries)',
            '</entries>',
        ].join('\n'));

        expect(parsed.type).toBe('directory');
        expect(parsed.lines.map((line) => line.text).join('\n')).toBe('components/\nindex.ts\n(2 entries)');
    });
});
