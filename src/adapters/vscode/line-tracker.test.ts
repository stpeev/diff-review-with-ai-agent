import { expect, test, vi } from 'vitest';
import { anchoredLocation, driftedLocation } from '../../review/model';

vi.mock('vscode', () => ({
  Range: class Range {
    constructor(
      readonly startLine: number,
      readonly _startCharacter: number,
      readonly endLine: number,
      readonly _endCharacter: number,
    ) {}
    get start() {
      return { line: this.startLine };
    }
    get end() {
      return { line: this.endLine };
    }
  },
}));

import { applyLineTrackingChange } from './line-tracker';

interface FakeThread {
  uri: { toString(): string };
  range: { start: { line: number }; end: { line: number } };
}

function documentChange(text: string, start: number, end: number, currentText: string) {
  return {
    document: { uri: { toString: () => 'file:///workspace/a.ts' }, getText: () => currentText },
    contentChanges: [{ range: { start: { line: start }, end: { line: end } }, text }],
  };
}

test('line tracking shifts ranges below an inserted block and schedules their save', () => {
  const thread: FakeThread = {
    uri: { toString: () => 'file:///workspace/a.ts' },
    range: { start: { line: 5 }, end: { line: 6 } },
  };
  const saves: FakeThread[] = [];

  applyLineTrackingChange(
    documentChange('new\nline\n', 2, 2, 'a\nb\nnew\nline\nc') as never,
    {
      liveThreads: () => [thread] as never,
      isTracked: () => true,
      metadata: () => ({ location: anchoredLocation(5), anchorHash: 'unused' }),
      markDrifted: () => undefined,
      scheduleSave: (candidate) => saves.push(candidate as never),
    },
    2,
    50,
  );

  expect(thread.range.start.line).toBe(7);
  expect(thread.range.end.line).toBe(8);
  expect(saves).toEqual([thread]);
});

test('line tracking asks the service to drift an anchor removed by a shrinking edit', () => {
  const thread: FakeThread = {
    uri: { toString: () => 'file:///workspace/a.ts' },
    range: { start: { line: 2 }, end: { line: 2 } },
  };
  const drifted: FakeThread[] = [];

  applyLineTrackingChange(
    documentChange('', 1, 3, 'first\nlast') as never,
    {
      liveThreads: () => [thread] as never,
      isTracked: () => true,
      metadata: () => ({ location: anchoredLocation(2), anchorHash: 'missing' }),
      markDrifted: (candidate) => drifted.push(candidate as never),
      scheduleSave: () => undefined,
    },
    2,
    50,
  );

  expect(drifted).toEqual([thread]);
});

test('line tracking leaves an already drifted thread at its last known location', () => {
  const thread: FakeThread = {
    uri: { toString: () => 'file:///workspace/a.ts' },
    range: { start: { line: 5 }, end: { line: 5 } },
  };
  const saves: FakeThread[] = [];

  applyLineTrackingChange(
    documentChange('new\nline\n', 2, 2, 'a\nb\nnew\nline\nc') as never,
    {
      liveThreads: () => [thread] as never,
      isTracked: () => true,
      metadata: () => ({ location: driftedLocation(5) }),
      markDrifted: () => undefined,
      scheduleSave: (candidate) => saves.push(candidate as never),
    },
    2,
    50,
  );

  expect(thread.range.start.line).toBe(5);
  expect(saves).toEqual([]);
});
