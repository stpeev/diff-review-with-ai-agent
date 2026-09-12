import { expect, test } from 'vitest';
import { reviewPanelTitle } from './panel-summary';
test('renders review panel counts', () => {
  expect(reviewPanelTitle(3, 2, 1)).toBe('Review Comments (2 open, 1 resolved, 1 drifted)');
  expect(reviewPanelTitle(1, 1, 0)).toBe('Review Comments (1 open, 0 resolved)');
});
