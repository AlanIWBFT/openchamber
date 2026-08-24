import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildChildrenIndex } from './subagentCost';

function makeSession(id: string, cost: number, parentID?: string): Session {
  return { id, cost, parentID } as unknown as Session;
}

describe('buildChildrenIndex', () => {
  test('groups sessions by parentID', () => {
    const root = makeSession('root', 1);
    const childA = makeSession('a', 2, 'root');
    const childB = makeSession('b', 3, 'root');
    const index = buildChildrenIndex([root, childA, childB]);
    expect(index.get('root')).toEqual([childA, childB]);
  });
});
