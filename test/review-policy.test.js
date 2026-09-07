const test = require('node:test');
const assert = require('node:assert');
const {
    addressSteps, sectionedPolicy, prosePolicy, MCP_TOOLS, LM_TOOLS,
} = require('../out/test/review-policy');
const { renderBody, MARKER } = require('../out/test/slash-commands');

const MCP = { tools: MCP_TOOLS, threadRef: 'listed' };
const LM = { tools: LM_TOOLS, threadRef: 'inline' };

test('addressSteps: the five steps, in order', () => {
    assert.deepStrictEqual(addressSteps(MCP).map(s => s.heading), [
        'Work each open thread',
        'Reply to every thread you touch',
        'Resolve only what you actually addressed',
        'Never commit',
        'Report',
    ]);
});

test('addressSteps: tool names come from the caller, not the module', () => {
    const mcp = addressSteps(MCP).map(s => s.body).join('\n');
    const lm = addressSteps(LM).map(s => s.body).join('\n');

    assert.ok(mcp.includes('replyToDiffComment'));
    assert.ok(mcp.includes('resolveDiffComment'));
    assert.ok(!mcp.includes('diffReview_'));

    assert.ok(lm.includes('diffReview_replyToComment'));
    assert.ok(lm.includes('diffReview_resolveComment'));
});

test('addressSteps: threadRef picks how a thread is identified', () => {
    const inline = addressSteps(LM)[0].body;
    const listed = addressSteps(MCP)[0].body;

    assert.ok(inline.includes('(Thread #N)'));
    assert.ok(!inline.includes('oldest-first'));
    assert.ok(listed.includes('oldest-first'));
    assert.ok(!listed.includes('(Thread #N)'));
});

test('addressSteps: the substance is identical whatever the threadRef', () => {
    // Only the first step (how threads are identified) may differ; the
    // reply / resolve / never-commit / report policy must not.
    const inline = addressSteps({ tools: MCP_TOOLS, threadRef: 'inline' }).slice(1);
    const listed = addressSteps({ tools: MCP_TOOLS, threadRef: 'listed' }).slice(1);
    assert.deepStrictEqual(inline, listed);
});

test('sectionedPolicy: numbers from startAt and uses ### headings', () => {
    const md = sectionedPolicy(MCP, 2);
    assert.ok(md.includes('### 2. Work each open thread'));
    assert.ok(md.includes('### 6. Report'));
    assert.ok(!md.includes('### 1.'));
});

test('prosePolicy: one bold-headed bullet per step', () => {
    const lines = prosePolicy(LM).split('\n').filter(l => l.startsWith('- **'));
    assert.strictEqual(lines.length, addressSteps(LM).length);
    assert.ok(prosePolicy(LM).includes("- **Never commit.** Committing stays the user's call."));
});

test('the /address-diff-review command embeds the shared policy verbatim', () => {
    // The drift guard: if the installed command body and review-policy.ts ever
    // state the policy differently again, this fails.
    const body = renderBody('claude-md', 'address');
    assert.ok(body.includes(sectionedPolicy(MCP, 2)), 'address body does not carry the shared policy');
});

test('the /address-diff-review command still carries its MCP preflight step', () => {
    const body = renderBody('claude-md', 'address');
    assert.ok(body.includes('### 1. Confirm the MCP server is reachable'));
    assert.ok(body.includes('listDiffComments'));
    assert.ok(body.includes(MARKER.address));
});
