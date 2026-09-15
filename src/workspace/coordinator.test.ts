import { expect, test, vi } from 'vitest';
import { runScopeTransition, TransitionGeneration } from './coordinator';

test('only the latest workspace transition remains current', () => {
  const transitions = new TransitionGeneration();
  const first = transitions.begin();
  const second = transitions.begin();
  expect(transitions.isCurrent(first)).toBe(false);
  expect(transitions.isCurrent(second)).toBe(true);
});

test('a removal or newer branch change invalidates pending work', () => {
  const transitions = new TransitionGeneration();
  const delayedClassification = transitions.begin();
  transitions.invalidate();

  expect(transitions.isCurrent(delayedClassification)).toBe(false);
  const replacement = transitions.begin();
  expect(transitions.isCurrent(replacement)).toBe(true);
});

test('a failed flush prevents a scope replacement', async () => {
  const transitions = new TransitionGeneration();
  const replace = vi.fn();

  await expect(
    runScopeTransition(transitions, async () => Promise.reject(new Error('disk full')), replace),
  ).rejects.toThrow('disk full');
  expect(replace).not.toHaveBeenCalled();
});

test('a transition superseded during a flush becomes a no-op', async () => {
  const transitions = new TransitionGeneration();
  const replace = vi.fn();

  await expect(
    runScopeTransition(
      transitions,
      async () => {
        transitions.begin();
      },
      replace,
    ),
  ).resolves.toBe(false);
  expect(replace).not.toHaveBeenCalled();
});

test('rapid A to B to C transitions replace only the final scope', async () => {
  const transitions = new TransitionGeneration();
  const releases: (() => void)[] = [];
  const flush = () => new Promise<void>((resolve) => releases.push(resolve));
  const applied: string[] = [];

  const a = runScopeTransition(transitions, flush, () => applied.push('A'));
  const b = runScopeTransition(transitions, flush, () => applied.push('B'));
  const c = runScopeTransition(transitions, flush, () => applied.push('C'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases[1]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases[2]();

  await expect(Promise.all([a, b, c])).resolves.toEqual([false, false, true]);
  expect(applied).toEqual(['C']);
});
