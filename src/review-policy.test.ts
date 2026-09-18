import { test } from 'vitest';
const assert = require('node:assert');
import { addressSteps, sectionedPolicy, MCP_TOOLS, LM_TOOLS } from './review-policy';
import { renderBody, MARKER } from './slash-commands';

test('addressSteps: the five steps, in order', () => {
  assert.deepStrictEqual(
    addressSteps(MCP_TOOLS).map((s) => s.heading),
    [
      'Inspect each open thread',
      'Reply to every thread you touch',
      'Resolve only what you actually addressed',
      'Never commit',
      'Report',
    ],
  );
});

test('addressSteps: tool names come from the caller, not the module', () => {
  const mcp = addressSteps(MCP_TOOLS)
    .map((s) => s.body)
    .join('\n');
  const lm = addressSteps(LM_TOOLS)
    .map((s) => s.body)
    .join('\n');

  assert.ok(mcp.includes('replyToDiffComment'));
  assert.ok(mcp.includes('resolveDiffComment'));
  assert.ok(!mcp.includes('diffReview_'));

  assert.ok(lm.includes('diffReview_replyToComment'));
  assert.ok(lm.includes('diffReview_resolveComment'));
});

test('addressSteps: the first step keeps the listed-thread wording', () => {
  // The slash-command body carries this verbatim; changing it rewrites
  // installed command files, so it changes only with a marker version bump.
  assert.ok(addressSteps(MCP_TOOLS)[0].body.startsWith('Go through them oldest-first.'));
});

test('sectionedPolicy: numbers from startAt and uses ### headings', () => {
  const md = sectionedPolicy(MCP_TOOLS, 2);
  assert.ok(md.includes('### 2. Inspect each open thread'));
  assert.ok(md.includes('### 6. Report'));
  assert.ok(!md.includes('### 1.'));
});

test('the /address-diff-review command embeds the shared policy verbatim', () => {
  // The drift guard: if the installed command body and review-policy.ts ever
  // state the policy differently again, this fails.
  const body = renderBody('claude-md', 'address');
  assert.ok(body.includes(sectionedPolicy(MCP_TOOLS, 2)), 'address body does not carry the shared policy');
});

test('the /address-diff-review command still carries its MCP preflight step', () => {
  const body = renderBody('claude-md', 'address');
  assert.ok(body.includes('### 1. Confirm the MCP server is reachable'));
  assert.ok(body.includes('listDiffComments'));
  assert.ok(body.includes(MARKER.address));
});
