import { expect, test } from 'vitest';
import { anchoredLocation, driftedLocation, fileNoteLocation } from '../review/model';
import { branchLoadPlan, branchStateFromSnapshots } from './branch-state';

const comment = {
  id: 4,
  stableId: 'comment-4',
  role: 'user' as const,
  body: 'Review this.',
  timestamp: '2026-09-12T00:00:00.000Z',
};

test('branch snapshots preserve anchored multi-line ranges and ID allocation', () => {
  const state = branchStateFromSnapshots(
    [
      {
        id: 3,
        stableId: 'thread-3',
        uri: 'file:///workspace/example.ts',
        status: 'open',
        comments: [comment],
        location: anchoredLocation(2, 5),
        anchorHash: 'anchor',
        anchorContext: 'context',
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
    ],
    [{ id: 9, deletedAt: '2026-09-12T01:00:00.000Z' }],
  );

  expect(state.nextThreadId).toBe(10);
  expect(state.nextCommentId).toBe(5);
  expect(state.threads[0]).toMatchObject({ startLine: 2, endLine: 5, anchorHash: 'anchor' });
});

test('branch snapshots preserve drift as informational and file notes as explicit intent', () => {
  const state = branchStateFromSnapshots(
    [
      {
        id: 1,
        stableId: 'drifted',
        uri: 'file:///workspace/a.ts',
        status: 'open',
        comments: [comment],
        location: driftedLocation(7),
        anchorHash: 'must-not-persist',
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
      {
        id: 2,
        stableId: 'file-note',
        uri: 'file:///workspace/b.ts',
        status: 'resolved',
        comments: [comment],
        location: fileNoteLocation(),
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
    ],
    [],
  );

  expect(state.threads[0]).toMatchObject({ startLine: 7, endLine: 7, drifted: true });
  expect(state.threads[0]!.anchorHash).toBeUndefined();
  expect(state.threads[1]).toMatchObject({ startLine: 0, endLine: 0, fileNote: true });
});

test('branchLoadPlan prefers target comments and only inherits a populated previous branch', () => {
  const previous = branchStateFromSnapshots(
    [
      {
        id: 1,
        stableId: 'one',
        uri: 'file:///a.ts',
        status: 'open',
        comments: [comment],
        location: anchoredLocation(0, 0),
        updatedAt: 'now',
      },
    ],
    [],
  );
  const target = branchStateFromSnapshots(
    [
      {
        id: 2,
        stableId: 'two',
        uri: 'file:///b.ts',
        status: 'open',
        comments: [comment],
        location: anchoredLocation(0, 0),
        updatedAt: 'now',
      },
    ],
    [],
  );

  expect(branchLoadPlan({ main: previous, feature: target }, 'feature', 'main')).toEqual({
    branch: target,
    inherited: false,
  });
  expect(branchLoadPlan({ main: previous, feature: { ...target, threads: [] } }, 'feature', 'main')).toEqual({
    branch: previous,
    inherited: true,
  });
  expect(branchLoadPlan({ feature: { ...target, threads: [] } }, 'feature', 'main')).toBeUndefined();
});
