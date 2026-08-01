import { describe, expect, test } from 'bun:test';

import { getDiffPatchEntries, getPrimaryToolPath, getRenderablePatchInfo } from './toolDiffUtils';

const identity = (path: string) => path;

describe('toolDiffUtils', () => {
    test('prefers the absolute apply_patch path over its worktree-relative label', () => {
        expect(getPrimaryToolPath('apply_patch', undefined, {
            files: [{
                filePath: '/workspace/project/src/file.ts',
                relativePath: 'workspace/project/src/file.ts',
                type: 'update',
            }],
        })).toBe('/workspace/project/src/file.ts');
    });

    test('opens the move destination and skips deleted apply_patch files', () => {
        expect(getPrimaryToolPath('apply_patch', undefined, {
            files: [
                { filePath: '/workspace/deleted.ts', relativePath: 'deleted.ts', type: 'delete' },
                {
                    filePath: '/workspace/old.ts',
                    relativePath: 'new.ts',
                    movePath: '/workspace/new.ts',
                    type: 'move',
                },
            ],
        })).toBe('/workspace/new.ts');
    });

    test('falls back to the relative apply_patch path for legacy metadata', () => {
        expect(getPrimaryToolPath('apply_patch', undefined, {
            files: [{ relativePath: 'src/file.ts', type: 'update' }],
        })).toBe('src/file.ts');
    });

    test('treats raw apply_patch envelopes as text, not visual diffs', () => {
        const entries = getDiffPatchEntries(undefined, [
            '*** Begin Patch',
            '*** Update File: src/app.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '*** End Patch',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('text');
        expect(entries[0]?.patch).toContain('*** Begin Patch');
    });

    test('splits multi-file unified patches into one renderable entry per file', () => {
        const entries = getDiffPatchEntries(undefined, [
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '@@ -1 +1 @@',
            '-left',
            '+right',
        ].join('\n'), identity);

        expect(entries.map((entry) => entry.renderMode)).toEqual(['diff', 'diff']);
        expect(entries.map((entry) => entry.title)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('uses metadata.files patches before top-level fallback diffs', () => {
        const entries = getDiffPatchEntries({
            files: [{
                relativePath: 'src/file.ts',
                patch: [
                    '--- a/src/file.ts',
                    '+++ b/src/file.ts',
                    '@@ -1 +1 @@',
                    '-old',
                    '+new',
                ].join('\n'),
            }],
        }, 'not a diff', identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(entries[0]?.title).toBe('src/file.ts');
    });

    test('synthesizes headers for valid headerless hunks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(getRenderablePatchInfo(entries[0]?.patch ?? '')).not.toBeNull();
    });

    test('keeps malformed unified patches as text fallbacks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '--- a/src/file.ts',
            '+++ b/src/file.ts',
            '@@',
            '-old',
            '+new',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('text');
        expect(entries[0]?.patch).toContain('@@');
    });
});
