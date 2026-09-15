import { expect, test } from 'vitest';
import { anchoredLocation, driftedLocation, fileNoteLocation } from './model';
import { isDriftedContextValue, presentationFor } from './presentation';

test('presentation context values distinguish anchored and drifted threads', () => {
  expect(presentationFor({ status: 'open', location: driftedLocation(5) }).contextValue).toBe('drifted-open');
  expect(presentationFor({ status: 'resolved', location: driftedLocation(5) }).contextValue).toBe('drifted-resolved');
  expect(presentationFor({ status: 'open', location: anchoredLocation(0) }).contextValue).toBe('open');
  expect(isDriftedContextValue('drifted-open')).toBe(true);
  expect(isDriftedContextValue('open')).toBe(false);
  expect(isDriftedContextValue(undefined)).toBe(false);
});

test('presentation renders location-aware labels and collapsed state', () => {
  expect(presentationFor({ status: 'open', location: driftedLocation(0) })).toMatchObject({
    label: '⚠ Moved — anchor not found (was L1)',
    collapsed: true,
    resolved: false,
  });
  expect(presentationFor({ status: 'resolved', location: driftedLocation(62) })).toMatchObject({
    label: '✅ Resolved · ⚠ Moved (was L63)',
    collapsed: true,
    resolved: true,
  });
  expect(presentationFor({ status: 'open', location: anchoredLocation(0) })).toMatchObject({
    label: 'Open',
    collapsed: false,
  });
  expect(presentationFor({ status: 'resolved', location: anchoredLocation(0) })).toMatchObject({
    label: '✅ Resolved',
    collapsed: true,
  });
});

test('presentation keeps file notes drift-free and non-actionable', () => {
  expect(presentationFor({ status: 'open', location: fileNoteLocation() })).toMatchObject({
    label: 'Open (file note)',
    contextValue: 'open',
    collapsed: true,
  });
  expect(presentationFor({ status: 'resolved', location: fileNoteLocation() })).toMatchObject({
    label: '✅ Resolved (file note)',
    resolved: true,
  });
});
