import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildChildrenIndex, formatCost } from './subagentCost';

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

describe('formatCost', () => {
  test('prefixes with $ and trims trailing zeros', () => {
    expect(formatCost(1.5)).toBe('$1.5');
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(2)).toBe('$2');
  });
});
