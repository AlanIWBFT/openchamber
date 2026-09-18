/**
 * The pill ↔ full-composer height morph (Capacitor iOS).
 *
 * The swap between the collapsed pill and the full composer is a React
 * conditional: one tree unmounts, the other mounts, and the glass box changes
 * height in a single frame. Left alone that is a visible jump — the box, and
 * the pinned transcript above it, snap by the height difference before the
 * keyboard has even started moving.
 *
 * This runs the swap as a FLIP on the glass box: measure the outgoing box,
 * commit the swap, measure the incoming box, freeze it at the old height and
 * transition to the new one. Contents are bottom-anchored while the box is
 * height-constrained, so the footer row and the model/agent row stay put and
 * the editor unfolds above them; the incoming editor block fades in.
 *
 * The growth is timed to the keyboard: it starts on the `oc:keyboard-anim`
 * event for its direction and runs on the keyboard's shared duration and
 * curve (mobileKeyboardTiming.ts), so the box, the composer's keyboard slide
 * and the transcript's inset tween are one motion. A fallback timer starts
 * it when no keyboard event follows (an expand that raises no keyboard, a
 * collapse without a keyboard transition).
 *
 * The transcript follows for free: the composer slot's ResizeObserver
 * publishes the animating height frame by frame and the scroll hook's
 * pinned-end observer re-pins on each write.
 *
 * Only the native iOS shell morphs. Mobile browsers rely on Safari's own
 * reveal scroll, which a growing box would fight; Android resizes the window
 * natively and is not verified against this; reduced motion keeps the instant
 * swap.
 */

import { KEYBOARD_EASING_CSS, KEYBOARD_HIDE_MS, KEYBOARD_SHOW_MS } from '@/lib/mobileKeyboardTiming';
import { isCapacitorApp } from '@/lib/platform';

export type ComposerMorphDirection = 'expand' | 'collapse';

/** Marks the glass box (pill or full) the morph measures and animates. */
const COMPOSER_MORPH_BOX_ATTR = 'data-composer-box';

/** Morph state on the box while it animates; mobile.css keys on it. */
const MORPH_STATE_ATTR = 'data-composer-morph';

const MORPH_DURATION_VAR = '--oc-composer-morph-ms';

/** Longest wait for the keyboard's own timing before the morph starts alone. */
const KEYBOARD_EVENT_FALLBACK_MS = 120;

/** Slack after the transition's nominal end before styles are cleared. */
const FINISH_SLACK_MS = 40;

interface MorphTiming {
    durationMs: number;
    easing: string;
}

/** Timing per direction: the keyboard's show leg for expand, hide leg for collapse. */
const morphTiming = (direction: ComposerMorphDirection): MorphTiming => ({
    durationMs: direction === 'expand' ? KEYBOARD_SHOW_MS : KEYBOARD_HIDE_MS,
    easing: KEYBOARD_EASING_CSS,
});

const composerMorphSupported = (): boolean => {
    // isCapacitorApp() is false outside a window, so the DOM is present past it.
    if (!isCapacitorApp()) return false;
    if (document.documentElement.classList.contains('oc-platform-android')) return false;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
    return true;
};

export interface ComposerMorphController {
    /**
     * Run `swap` (which must commit the pill ↔ composer change synchronously,
     * i.e. via flushSync) as a height morph of the box found under `host`.
     * Falls back to a plain swap when the morph is unsupported or there is
     * nothing to measure.
     */
    run: (direction: ComposerMorphDirection, host: HTMLElement | null, swap: () => void) => void;
    /** Abort an in-flight morph and restore the box to its natural layout. */
    cancel: () => void;
}

export function createComposerMorphController(): ComposerMorphController {
    let active: (() => void) | null = null;

    const cancel = () => {
        if (!active) return;
        const cleanup = active;
        active = null;
        cleanup();
    };

    const run: ComposerMorphController['run'] = (direction, host, swap) => {
        if (!host || !composerMorphSupported()) {
            cancel();
            swap();
            return;
        }
        // Measured before cancelling: a swap that interrupts the opposite
        // morph continues from the box's mid-transition height rather than
        // snapping to its resting size first.
        const outgoing = host.querySelector<HTMLElement>(`[${COMPOSER_MORPH_BOX_ATTR}]`);
        const fromHeight = outgoing?.getBoundingClientRect().height ?? null;
        cancel();
        swap();
        const box = host.querySelector<HTMLElement>(`[${COMPOSER_MORPH_BOX_ATTR}]`);
        if (!box || fromHeight === null) return;
        const toHeight = box.getBoundingClientRect().height;
        if (Math.abs(toHeight - fromHeight) < 1) return;

        const phase = direction === 'expand' ? 'show' : 'hide';
        let startTimer: number | null = null;
        let finishTimer: number | null = null;
        let started = false;

        const restore = () => {
            box.style.transition = '';
            box.style.height = '';
            box.style.removeProperty(MORPH_DURATION_VAR);
            box.removeAttribute(MORPH_STATE_ATTR);
        };
        const cleanup = () => {
            if (startTimer !== null) window.clearTimeout(startTimer);
            if (finishTimer !== null) window.clearTimeout(finishTimer);
            window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
            box.removeEventListener('transitionend', handleTransitionEnd);
            restore();
        };
        const finish = () => {
            if (active !== cleanup) return;
            active = null;
            cleanup();
        };
        const timing = morphTiming(direction);
        const start = () => {
            if (started) return;
            started = true;
            if (startTimer !== null) {
                window.clearTimeout(startTimer);
                startTimer = null;
            }
            window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
            box.style.transition = `height ${timing.durationMs}ms ${timing.easing}`;
            box.style.height = `${toHeight}px`;
            finishTimer = window.setTimeout(finish, timing.durationMs + FINISH_SLACK_MS);
        };
        function handleKeyboardAnim(event: Event) {
            // SAFETY: oc:keyboard-anim is dispatched only by useNativeMobileChrome
            // as a CustomEvent whose detail carries `phase: 'show' | 'hide'`.
            const detail = (event as CustomEvent<{ phase: 'show' | 'hide' }>).detail;
            if (detail.phase !== phase) return;
            start();
        }
        function handleTransitionEnd(event: TransitionEvent) {
            if (event.target !== box || event.propertyName !== 'height') return;
            finish();
        }

        // Freeze at the outgoing height first; the fade keyframes read the
        // duration variable, so it is set before the state attribute lands.
        box.style.setProperty(MORPH_DURATION_VAR, `${timing.durationMs}ms`);
        box.style.height = `${fromHeight}px`;
        box.setAttribute(MORPH_STATE_ATTR, direction);
        // Flush so the transition below starts from the frozen height rather
        // than coalescing both writes into one frame.
        void box.offsetHeight;

        box.addEventListener('transitionend', handleTransitionEnd);
        window.addEventListener('oc:keyboard-anim', handleKeyboardAnim);
        startTimer = window.setTimeout(() => {
            startTimer = null;
            start();
        }, KEYBOARD_EVENT_FALLBACK_MS);

        active = cleanup;
    };

    return { run, cancel };
}
