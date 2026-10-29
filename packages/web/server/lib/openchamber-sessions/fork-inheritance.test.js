import { describe, expect, it, vi } from 'vitest';
import { applyForkInheritance, sourceOwnedLinksPatch } from './fork-inheritance.js';

const goal = (objectiveFile) => ({ id: 'goal_1', objective: objectiveFile ? '' : 'Ship it', objectiveFile, status: 'paused' });

const harness = (metadata, overrides = {}) => {
  const writeMetadata = overrides.writeMetadata ?? vi.fn(async () => undefined);
  const deps = {
    readObjective: vi.fn(async () => 'Objective from file'),
    writeObjective: vi.fn(async () => undefined),
    updateMetadata: async (id, decide) => writeMetadata(id, decide(metadata)),
    ...overrides,
  };
  const run = () => applyForkInheritance({ sourceSessionID: 'ses_source', fork: { id: 'ses_fork', metadata }, ...deps });
  return { deps: { ...deps, writeMetadata }, run };
};

describe('sourceOwnedLinksPatch', () => {
  it('pauses an active goal so the fork does not pursue it in parallel', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { goal: { id: 'g', status: 'active' } } }))
      .toEqual({ goal: { status: 'paused', statusReason: 'paused in fork' } });
    expect(sourceOwnedLinksPatch({ openchamber: { goal: { id: 'g', status: 'complete' } } })).toBeNull();
  });

  it('removes the btw and review links but keeps the goal', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { goal: goal(false), btwSessionID: 'b', reviewSessionID: 'r' } }))
      .toEqual({ btwSessionID: null, reviewSessionID: null });
  });

  it('removes inherited side-thread identity and work-title ownership', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { kind: 'btw', originalSessionID: 'p', btwBoundaryMessageID: 'm' } }))
      .toEqual({ kind: null, originalSessionID: null, btwBoundaryMessageID: null });
    expect(sourceOwnedLinksPatch({ openchamber: { kind: 'review', originalSessionID: 'p', workTitle: { title: 'Source', by: 'user' }, btwPromoted: true } }))
      .toEqual({ kind: null, originalSessionID: null, workTitle: null, btwPromoted: null });
    // A fork of a scheduled run is the user's own work again.
    expect(sourceOwnedLinksPatch({ openchamber: { kind: 'scheduled' } })).toEqual({ kind: null });
    expect(sourceOwnedLinksPatch(undefined)).toBeNull();
  });
});

describe('applyForkInheritance', () => {
  it('does nothing for an inline goal without source links', async () => {
    const h = harness({ openchamber: { goal: goal(false) } });
    await h.run();
    expect(h.deps.readObjective).not.toHaveBeenCalled();
    expect(h.deps.writeMetadata).not.toHaveBeenCalled();
  });

  it('copies a file-backed objective and strips source links', async () => {
    const h = harness({ openchamber: { goal: goal(true), btwSessionID: 'b' } });
    await h.run();
    expect(h.deps.readObjective).toHaveBeenCalledWith('ses_source');
    expect(h.deps.writeObjective).toHaveBeenCalledWith('ses_fork', 'Objective from file');
    expect(h.deps.writeMetadata).toHaveBeenCalledWith('ses_fork', { openchamber: { btwSessionID: null } });
  });

  it('inlines the objective when the file copy fails', async () => {
    const h = harness({ openchamber: { goal: goal(true) } }, {
      writeObjective: vi.fn(async () => { throw new Error('disk full'); }),
    });
    await h.run();
    expect(h.deps.writeMetadata).toHaveBeenCalledWith('ses_fork', {
      openchamber: { goal: { objective: 'Objective from file', objectiveFile: false } },
    });
  });

  it('swallows a metadata write failure', async () => {
    const h = harness({ openchamber: { reviewSessionID: 'r' } }, {
      writeMetadata: vi.fn(async () => { throw new Error('offline'); }),
    });
    await expect(h.run()).resolves.toBeUndefined();
  });

  it('keeps a new user work title written while the inherited objective was being copied', async () => {
    const inherited = { openchamber: { goal: goal(true), workTitle: { title: 'Source', by: 'agent' } } };
    const current = { openchamber: { ...inherited.openchamber, workTitle: { title: 'My fork', by: 'user' } } };
    let patch;
    const h = harness(inherited, { updateMetadata: async (_id, decide) => { patch = decide(current); } });
    await h.run();
    expect(patch).toBeNull();
    expect(current.openchamber.workTitle).toEqual({ title: 'My fork', by: 'user' });
  });
});
