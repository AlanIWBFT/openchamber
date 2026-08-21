import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useActivationOverscan } from './useActivationOverscan';

type Frame = FrameRequestCallback;

describe('MessageList activation overscan', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;
    let pendingFrames: Map<number, Frame>;
    let nextFrameId: number;
    let renderCount: number;

    beforeEach(() => {
        windowInstance = new Window();
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            HTMLElement: windowInstance.HTMLElement,
            Element: windowInstance.Element,
            Node: windowInstance.Node,
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        pendingFrames = new Map();
        nextFrameId = 1;
        renderCount = 0;
        Object.defineProperty(windowInstance, 'requestAnimationFrame', {
            configurable: true,
            value: (callback: Frame) => {
                const frameId = nextFrameId;
                nextFrameId += 1;
                pendingFrames.set(frameId, callback);
                return frameId;
            },
        });
        Object.defineProperty(windowInstance, 'cancelAnimationFrame', {
            configurable: true,
            value: (id: number) => {
                pendingFrames.delete(id);
            },
        });
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        windowInstance.close();
    });

    const Harness = ({ normalOverscan }: { normalOverscan: number }) => {
        renderCount += 1;
        const overscan = useActivationOverscan(true, normalOverscan);
        return <div data-overscan={overscan} />;
    };

    const runNextFrame = async (timestamp: number): Promise<void> => {
        const nextFrame = pendingFrames.entries().next();
        if (nextFrame.done) throw new Error('No animation frame is pending');

        const [frameId, callback] = nextFrame.value;
        pendingFrames.delete(frameId);
        await act(async () => callback(timestamp));
    };

    test('restores normal overscan in at most two renders after the first paint opportunity', async () => {
        await act(async () => root.render(<Harness normalOverscan={8} />));
        expect(host.firstElementChild?.getAttribute('data-overscan')).toBe('0');
        expect(renderCount).toBe(1);

        await runNextFrame(0);
        expect(host.firstElementChild?.getAttribute('data-overscan')).toBe('0');
        expect(renderCount).toBe(1);

        await runNextFrame(16);
        expect(host.firstElementChild?.getAttribute('data-overscan')).toBe('4');
        expect(renderCount).toBe(2);

        await runNextFrame(32);
        expect(host.firstElementChild?.getAttribute('data-overscan')).toBe('8');
        expect(renderCount).toBe(3);
    });

    test('cancels every pending restoration frame when the list unmounts', async () => {
        for (const framesToRun of [0, 1, 2]) {
            await act(async () => root.render(<Harness normalOverscan={16} />));
            for (let frame = 0; frame < framesToRun; frame += 1) {
                await runNextFrame(frame * 16);
            }

            expect(pendingFrames.size).toBe(1);
            await act(async () => root.render(null));
            expect(pendingFrames.size).toBe(0);
        }
    });
});
