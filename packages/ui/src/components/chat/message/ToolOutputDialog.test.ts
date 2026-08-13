import { describe, expect, test } from 'bun:test';

import {
    clampImagePreviewTransform,
    getContainedImagePreviewSize,
    getImagePreviewBounds,
    getImagePreviewDialogLayout,
    getImagePreviewGestureTransform,
    getLocalImagePreviewPoints,
} from './imagePreviewSizing';
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

describe('Mobile image preview gestures', () => {
    test('zooms around the midpoint of a two-finger gesture', () => {
        expect(getImagePreviewGestureTransform(
            { scale: 1, x: 0, y: 0 },
            [{ x: 100, y: 200 }, { x: 200, y: 200 }],
            [{ x: 50, y: 200 }, { x: 250, y: 200 }],
            { width: 300, height: 500 },
            { width: 300, height: 500 },
        )).toEqual({ scale: 2, x: 0, y: 50 });
    });

    test('supports panning after zoom and clamps the image to the viewport', () => {
        expect(getImagePreviewGestureTransform(
            { scale: 2, x: 0, y: 0 },
            [{ x: 100, y: 100 }],
            [{ x: 400, y: -400 }],
            { width: 300, height: 500 },
            { width: 300, height: 500 },
        )).toEqual({ scale: 2, x: 150, y: -250 });
    });

    test('limits pinch zoom to four times', () => {
        expect(clampImagePreviewTransform(
            { scale: 8, x: 1000, y: -1000 },
            { width: 300, height: 500 },
            { width: 300, height: 500 },
        )).toEqual({ scale: 4, x: 450, y: -750 });
    });

    test('converts page coordinates into the image viewport coordinate system', () => {
        expect(getLocalImagePreviewPoints(
            [{ x: 129, y: 257 }, { x: 229, y: 257 }],
            { x: 29, y: 57 },
        )).toEqual([{ x: 100, y: 200 }, { x: 200, y: 200 }]);
    });

    test('clamps letterboxed wide images against their visible content', () => {
        const content = getContainedImagePreviewSize(
            { width: 2908, height: 1686 },
            { width: 332, height: 758 },
        );
        expect(clampImagePreviewTransform(
            { scale: 2.5, x: 1000, y: 1000 },
            { width: 332, height: 758 },
            content,
        )).toEqual({ scale: 2.5, x: 249, y: 0 });
    });
});
