import { expect, test } from 'vitest';
import {
  anchoredLocation,
  driftedLocation,
  fileNoteLocation,
  isActionableLocation,
  markLocationDrifted,
  restoreAnchoredLocation,
} from './model';

test('review locations make actionable ranges explicit', () => {
  const anchored = anchoredLocation(3, 5);
  expect(isActionableLocation(anchored)).toBe(true);
  expect(isActionableLocation(driftedLocation(3))).toBe(false);
  expect(isActionableLocation(fileNoteLocation())).toBe(false);
});

test('only anchored locations can transition to drifted', () => {
  expect(markLocationDrifted(anchoredLocation(4, 6))).toEqual({ kind: 'drifted', lastKnownLine: 4 });
  expect(() => markLocationDrifted(fileNoteLocation())).toThrow('Only an anchored review location can drift.');
});

test('review locations reject invalid line ranges', () => {
  expect(() => anchoredLocation(-1)).toThrow('non-negative ordered line range');
  expect(() => anchoredLocation(4, 3)).toThrow('non-negative ordered line range');
  expect(() => driftedLocation(-1)).toThrow('non-negative last-known line');
});

test('restored anchored locations retain the persisted multi-line span', () => {
  expect(restoreAnchoredLocation(4, 7, 10)).toEqual({ kind: 'anchored', startLine: 10, endLine: 13 });
  expect(() => restoreAnchoredLocation(4, 3, 10)).toThrow('non-negative ordered line range');
});
