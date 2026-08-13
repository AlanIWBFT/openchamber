import { describe, expect, test } from 'bun:test';

import { getImagePreviewBounds, getImagePreviewDialogLayout } from './imagePreviewSizing';
import { MermaidLoadFailure, getMermaidDataUrlSourcePromise, isCurrentMermaidLoadRequest, nextMermaidLoadRequestId } from './toolOutputDialogMermaid';

describe('getMermaidDataUrlSourcePromise', () => {
    test('turns malformed data URLs into rejected promises', async () => {
        const sourcePromise = getMermaidDataUrlSourcePromise('data:text/plain;base64');

        await sourcePromise.then(
            () => {
                throw new Error('expected malformed data URL to reject');
            },
            (error) => {
                expect(error).toBeInstanceOf(Error);
                expect(error).toBeInstanceOf(MermaidLoadFailure);
                expect(error.key).toBe('chat.toolOutputDialog.mermaid.dataUrlMalformed');
                expect(error.params).toBe(undefined);
            },
        );
    });
});

describe('Mermaid load request ids', () => {
    test('invalidates stale async loads when a newer load starts', () => {
        const firstRequest = nextMermaidLoadRequestId(0);
        const secondRequest = nextMermaidLoadRequestId(firstRequest);

        expect(isCurrentMermaidLoadRequest(secondRequest, firstRequest)).toBe(false);
        expect(isCurrentMermaidLoadRequest(secondRequest, secondRequest)).toBe(true);
    });
});

describe('Markdown image preview bounds', () => {
    test('uses sixty percent of the viewport width with vertical containment', () => {
        expect(getImagePreviewBounds({ width: 1200, height: 800 }, false, true)).toEqual({
            maxWidth: 720,
            maxHeight: 640,
        });
    });

    test('preserves existing attachment preview bounds', () => {
        expect(getImagePreviewBounds({ width: 1200, height: 800 }, false, false)).toEqual({
            maxWidth: 900,
            maxHeight: 600,
        });
    });

    test('keeps a readable modal width for narrow portrait images', () => {
        expect(getImagePreviewDialogLayout(
            { width: 29, height: 576 },
            { width: 1280, height: 720 },
            false,
        )).toEqual({
            dialogWidth: 320,
            imageWidth: 29,
            imageHeight: 576,
        });
    });

    test('fits image content inside the mobile dialog chrome without cropping', () => {
        expect(getImagePreviewDialogLayout(
            { width: 275, height: 500 },
            { width: 320, height: 700 },
            true,
        )).toEqual({
            dialogWidth: 304,
            imageWidth: 270,
            imageHeight: 491,
        });
    });
});
