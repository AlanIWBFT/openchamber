import type { ShortcutActionId } from './shortcuts';

export type ShortcutHandler = (event: KeyboardEvent) => boolean | void;

interface RegisteredHandler {
  handler: ShortcutHandler;
  token: symbol;
}

/** Active application command handlers, keyed by shortcut action ID. */
export class ShortcutRegistry {
  private readonly handlers = new Map<ShortcutActionId, RegisteredHandler[]>();

  register(actionId: ShortcutActionId, handler: ShortcutHandler): () => void {
    const token = Symbol(actionId);
    const registered = this.handlers.get(actionId) ?? [];
    registered.push({ handler, token });
    this.handlers.set(actionId, registered);
    return () => {
      const current = this.handlers.get(actionId);
      if (!current) return;
      const index = current.findIndex((entry) => entry.token === token);
      if (index === -1) return;
      current.splice(index, 1);
      if (current.length === 0) {
        this.handlers.delete(actionId);
      }
    };
  }

  get(actionId: ShortcutActionId): ShortcutHandler | undefined {
    return this.handlers.get(actionId)?.[0]?.handler;
  }

  actionIds(): IterableIterator<ShortcutActionId> {
    return this.handlers.keys();
  }
}

/** Shared registry for application commands registered by React surfaces. */
export const shortcutRegistry = new ShortcutRegistry();
