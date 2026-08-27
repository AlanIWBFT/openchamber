import { describe, expect, test } from 'bun:test';

import {
    isAutoFollowReleaseKey,
    shouldDelayAutoFollowRepin,
    shouldRepinReleasedAutoFollow,
} from './useChatTimelineScroll';

const keyEvent = (
    key: string,
    modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
): Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'> => ({
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
});

describe('chat timeline scroll intent', () => {
    test('recognizes upward navigation without stealing modified shortcuts', () => {
        expect(isAutoFollowReleaseKey(keyEvent('ArrowUp'))).toBe(true);
        expect(isAutoFollowReleaseKey(keyEvent('PageUp'))).toBe(true);
        expect(isAutoFollowReleaseKey(keyEvent('Home'))).toBe(true);
        expect(isAutoFollowReleaseKey(keyEvent(' ', { shiftKey: true }))).toBe(true);
        expect(isAutoFollowReleaseKey(keyEvent('Pause'))).toBe(true);
        expect(isAutoFollowReleaseKey(keyEvent('Break'))).toBe(true);
        expect(isAutoFollowReleaseKey(keyEvent('ArrowUp', { ctrlKey: true }))).toBe(false);
        expect(isAutoFollowReleaseKey(keyEvent(' ', { shiftKey: false }))).toBe(false);
    });

    test('delays re-pinning only for downward or exact-bottom movement', () => {
        expect(shouldRepinReleasedAutoFollow(false, false)).toBe(false);
        expect(shouldRepinReleasedAutoFollow(true, false)).toBe(true);
        expect(shouldRepinReleasedAutoFollow(false, true)).toBe(true);
        expect(shouldDelayAutoFollowRepin(null, 100, 1200)).toBe(false);
        expect(shouldDelayAutoFollowRepin(100, 500, 1200)).toBe(true);
        expect(shouldDelayAutoFollowRepin(100, 1300, 1200)).toBe(false);
    });
});
