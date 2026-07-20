import { describe, expect, test } from 'bun:test';
import type { ToolPart, ToolState } from '@/lib/opencode/model';

import {
    countExplorationTools,
    formatDirectoryDisplayPath,
    getReadToolDisplayType,
    isExpandableTool,
    isExplorationPartDisplayReady,
    isExplorationTool,
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
        expect(isExpandableTool('bash')).toBe(true);
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

    test('retains historical Todo calls in the generic expandable renderer', () => {
        expect(isExpandableTool('todowrite')).toBe(true);
        expect(isExpandableTool('todoread')).toBe(true);
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
        const part = (state: ToolState): ToolPart => ({ id: 'read-1', sessionID: 's1', messageID: 'm1', callID: 'c1', type: 'tool', tool: 'read', state });
        expect(isExplorationPartDisplayReady(part({ status: 'pending', input: {}, raw: '' }))).toBe(true);
        expect(isExplorationPartDisplayReady(part({ status: 'running', input: {}, time: { start: 1 } }))).toBe(true);
        expect(isExplorationPartDisplayReady(part({ status: 'error', input: {}, error: 'cancelled', time: { start: 1, end: 2 } }))).toBe(true);
        expect(isExplorationPartDisplayReady(part({ status: 'completed', input: {}, output: '', time: { start: 2, end: 1 } }))).toBe(false);
        expect(isExplorationPartDisplayReady(part({ status: 'completed', input: {}, output: '', time: { start: 1, end: 2 } }))).toBe(true);
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

    test('recognizes V2 read headers without mistaking file content for the directory header', () => {
        expect(getReadToolDisplayType({}, 'Read directory /repo/src, entries 1-2\ncomponents/\nindex.ts')).toBe('directory');
        expect(getReadToolDisplayType({}, 'Read directory /repo/empty, 0 entries')).toBe('directory');
        expect(getReadToolDisplayType({}, 'Read file /repo/a.txt, lines 1-1\n1: <type>directory</type>')).toBe('file');
        expect(parseReadToolOutput('Read directory /repo/src, entries 1-2\ncomponents/\nindex.ts').lines.map((line) => line.text))
            .toEqual(['components/', 'index.ts']);
        expect(parseReadToolOutput('Read file /repo/a.txt, lines 1-1\n1: <content>literal</content>').lines.map((line) => line.text))
            .toEqual(['<content>literal</content>']);
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
