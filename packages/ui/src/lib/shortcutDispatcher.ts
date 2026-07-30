import {
  eventMatchesShortcut,
  normalizeCombo,
  parseShortcut,
  UNASSIGNED_SHORTCUT,
  type ShortcutActionId,
  type ShortcutCombo,
} from './shortcuts';
import { type ShortcutHandler, ShortcutRegistry } from './shortcutRegistry';

const SEQUENCE_TIMEOUT_MS = 1500;
const MODIFIER_KEYS = new Set(['alt', 'control', 'meta', 'shift']);

export interface ShortcutDispatcherOptions {
  registry: ShortcutRegistry;
  getBinding: (actionId: ShortcutActionId) => ShortcutCombo;
  now?: () => number;
  timeoutMs?: number;
}

interface BindingMatch {
  chords: string[];
  handler: ShortcutHandler;
}

/** Stateless with respect to the DOM; callers decide whether a consumed event is prevented. */
export class ShortcutDispatcher {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private prefix: string | undefined;
  private expiresAt = 0;

  constructor(private readonly options: ShortcutDispatcherOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? SEQUENCE_TIMEOUT_MS;
  }

  dispatch(event: KeyboardEvent): boolean {
    if (event.repeat || event.isComposing || MODIFIER_KEYS.has(event.key.toLowerCase())) {
      return false;
    }
    if (event.key === 'Escape' && this.prefix) {
      return this.handleEscape();
    }
    if (this.prefix && this.now() >= this.expiresAt) {
      this.clear();
    }

    const matches = this.getMatches();
    if (this.prefix) {
      const pending = matches.filter((match) => (
        match.chords.length === 2
        && match.chords[0] === this.prefix
        && eventMatchesShortcut(event, match.chords[1])
      ));
      if (pending.length > 0) {
        this.clear();
        return this.invoke(pending, event);
      }
      this.clear();
    }

    const singles = matches.filter((match) => (
      match.chords.length === 1 && eventMatchesShortcut(event, match.chords[0])
    ));
    if (singles.length > 0 && this.invoke(singles, event)) {
      return true;
    }

    const leader = matches.find((match) => (
      match.chords.length === 2 && eventMatchesShortcut(event, match.chords[0])
    ));
    if (leader) {
      this.prefix = leader.chords[0];
      this.expiresAt = this.now() + this.timeoutMs;
      return true;
    }
    return false;
  }

  clear(): void {
    this.prefix = undefined;
    this.expiresAt = 0;
  }

  handleBlur(): void {
    this.clear();
  }

  handleEscape(): boolean {
    const hadPrefix = Boolean(this.prefix);
    this.clear();
    return hadPrefix;
  }

  private invoke(matches: BindingMatch[], event: KeyboardEvent): boolean {
    for (const match of matches) {
      if (match.handler(event) !== false) {
        return true;
      }
    }
    return false;
  }

  private getMatches(): BindingMatch[] {
    const matches: BindingMatch[] = [];
    for (const actionId of this.options.registry.actionIds()) {
      const handler = this.options.registry.get(actionId);
      const binding = normalizeCombo(this.options.getBinding(actionId));
      const parsed = parseShortcut(binding);
      const isDispatchable = parsed
        && parsed.chords.every((chord) => chord.key && chord.key !== UNASSIGNED_SHORTCUT);
      if (handler && isDispatchable) {
        matches.push({ chords: binding.split(' '), handler });
      }
    }
    return matches;
  }
}
