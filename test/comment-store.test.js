const test = require('node:test');
const assert = require('node:assert');
const {
    emptyBranch, emptyScopeFile, mergeScopeFiles,
    hashAnchor, anchorContextSnippet, findAnchorLine,
    serializeComments, ghostContextValue, statusOfContextValue, isGhostContextValue,
    ghostLabel, applyGhostEdit,
} = require('../out/test/comment-store');

function thread(id, updatedAt, overrides) {
    return Object.assign({
        id,
        uri: 'file:///a.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [{ id: 1, role: 'user', body: 'hi', timestamp: updatedAt }],
        updatedAt,
    }, overrides || {});
}

// --------------- mergeScopeFiles ---------------

test('mergeScopeFiles unions threads present on only one side', () => {
    const mine = emptyScopeFile('writer-a');
    mine.branches.main = { nextThreadId: 2, nextCommentId: 2, threads: [thread(1, '2026-01-01T00:00:00Z')] };
    const theirs = emptyScopeFile('writer-b');
    theirs.branches.main = { nextThreadId: 3, nextCommentId: 3, threads: [thread(2, '2026-01-01T00:00:01Z')] };

    const merged = mergeScopeFiles(mine, theirs, 'writer-a');
    const ids = merged.branches.main.threads.map(t => t.id).sort();
    assert.deepStrictEqual(ids, [1, 2]);
});

test('mergeScopeFiles keeps the later-updated version of a thread present on both sides', () => {
    const mine = emptyScopeFile('writer-a');
    mine.branches.main = { nextThreadId: 2, nextCommentId: 2, threads: [thread(1, '2026-01-01T00:00:00Z', { status: 'open' })] };
    const theirs = emptyScopeFile('writer-b');
    theirs.branches.main = { nextThreadId: 2, nextCommentId: 2, threads: [thread(1, '2026-01-01T00:05:00Z', { status: 'resolved' })] };

    const merged = mergeScopeFiles(mine, theirs, 'writer-a');
    assert.strictEqual(merged.branches.main.threads[0].status, 'resolved');
});

test('mergeScopeFiles keeps branches that exist on only one side', () => {
    const mine = emptyScopeFile('writer-a');
    mine.branches.main = { ...emptyBranch(), threads: [thread(1, '2026-01-01T00:00:00Z')] };
    const theirs = emptyScopeFile('writer-b');
    theirs.branches.feature = { ...emptyBranch(), threads: [thread(2, '2026-01-01T00:00:00Z')] };

    const merged = mergeScopeFiles(mine, theirs, 'writer-a');
    assert.ok(merged.branches.main);
    assert.ok(merged.branches.feature);
});

test('mergeScopeFiles bumps the revision past both inputs', () => {
    const mine = { ...emptyScopeFile('writer-a'), revision: 3 };
    const theirs = { ...emptyScopeFile('writer-b'), revision: 5 };
    const merged = mergeScopeFiles(mine, theirs, 'writer-a');
    assert.strictEqual(merged.revision, 6);
});

test('mergeScopeFiles takes the max nextThreadId/nextCommentId per branch', () => {
    const mine = emptyScopeFile('writer-a');
    mine.branches.main = { nextThreadId: 10, nextCommentId: 4, threads: [] };
    const theirs = emptyScopeFile('writer-b');
    theirs.branches.main = { nextThreadId: 3, nextCommentId: 9, threads: [] };
    const merged = mergeScopeFiles(mine, theirs, 'writer-a');
    assert.strictEqual(merged.branches.main.nextThreadId, 10);
    assert.strictEqual(merged.branches.main.nextCommentId, 9);
});

// --------------- anchoring ---------------

test('hashAnchor is stable for identical inputs', () => {
    assert.strictEqual(
        hashAnchor('const x = 1;', ['a', 'const x = 1;', 'b']),
        hashAnchor('const x = 1;', ['a', 'const x = 1;', 'b']),
    );
});

test('hashAnchor differs when context changes even if the line does not', () => {
    const a = hashAnchor('const x = 1;', ['before-a', 'const x = 1;', 'after']);
    const b = hashAnchor('const x = 1;', ['before-b', 'const x = 1;', 'after']);
    assert.notStrictEqual(a, b);
});

function makeFile(lines) { return lines; }

test('findAnchorLine: step 1, matches at the stored line unchanged', () => {
    const file = makeFile(['a', 'b', 'TARGET', 'c', 'd']);
    const hash = hashAnchor('TARGET', anchorContextSnippet(file, 2, 1).split('\n'));
    assert.strictEqual(findAnchorLine(file, hash, 2, 1, 50), 2);
});

test('findAnchorLine: step 2, re-anchors within the search radius after lines shift', () => {
    const original = makeFile(['a', 'b', 'TARGET', 'c', 'd']);
    const hash = hashAnchor('TARGET', anchorContextSnippet(original, 2, 1).split('\n'));
    // Two lines inserted before the whole anchored block — TARGET's immediate
    // context ('b', 'c') is unchanged, only its absolute line moved from 2 to 4.
    const shifted = makeFile(['x', 'y', 'a', 'b', 'TARGET', 'c', 'd']);
    assert.strictEqual(findAnchorLine(shifted, hash, 2, 1, 50), 4);
});

test('findAnchorLine: step 3, finds the anchor anywhere in the file outside the search radius', () => {
    const original = ['pad', 'pad', 'TARGET', 'pad', 'pad'];
    const hash = hashAnchor('TARGET', anchorContextSnippet(original, 2, 1).split('\n'));
    // Far away from the stored line, well outside a small search radius.
    const shifted = ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'pad', 'pad', 'TARGET', 'pad', 'pad'];
    assert.strictEqual(findAnchorLine(shifted, hash, 0, 1, 3), 12);
});

test('findAnchorLine: step 5 territory — returns undefined when the anchor is nowhere in the file', () => {
    const file = ['completely', 'different', 'content'];
    const hash = hashAnchor('TARGET', ['a', 'TARGET', 'b']);
    assert.strictEqual(findAnchorLine(file, hash, 1, 1, 50), undefined);
});

test('findAnchorLine: context radius matters — same line text with different surroundings does not false-match', () => {
    const original = ['ctx-a', 'DUPLICATE', 'ctx-b'];
    const hash = hashAnchor('DUPLICATE', anchorContextSnippet(original, 1, 1).split('\n'));
    const decoy = ['other-a', 'DUPLICATE', 'other-b']; // same line text, different context
    assert.strictEqual(findAnchorLine(decoy, hash, 1, 1, 50), undefined);
});

// --------------- Ghost (drifted-but-visible) threads ---------------

test('serializeComments maps live comments to their persisted shape', () => {
    const out = serializeComments([
        { id: 3, role: 'user', body: 'plain string body', createdAt: '2026-01-01T00:00:00Z' },
        { id: 4, role: 'agent', body: { value: 'markdown body' }, createdAt: '2026-01-02T00:00:00Z' },
    ]);
    assert.deepStrictEqual(out, [
        { id: 3, role: 'user', body: 'plain string body', timestamp: '2026-01-01T00:00:00Z' },
        { id: 4, role: 'agent', body: 'markdown body', timestamp: '2026-01-02T00:00:00Z' },
    ]);
});

test('ghost context values round-trip through status', () => {
    assert.strictEqual(ghostContextValue('open'), 'drifted-open');
    assert.strictEqual(ghostContextValue('resolved'), 'drifted-resolved');
    assert.strictEqual(statusOfContextValue('drifted-open'), 'open');
    assert.strictEqual(statusOfContextValue('drifted-resolved'), 'resolved');
    assert.strictEqual(statusOfContextValue('resolved'), 'resolved');
    assert.strictEqual(statusOfContextValue('open'), 'open');
    assert.strictEqual(statusOfContextValue(undefined), 'open');
});

test('isGhostContextValue distinguishes ghosts from live threads', () => {
    assert.ok(isGhostContextValue('drifted-open'));
    assert.ok(isGhostContextValue('drifted-resolved'));
    assert.ok(!isGhostContextValue('open'));
    assert.ok(!isGhostContextValue('resolved'));
    assert.ok(!isGhostContextValue(undefined));
});

test('ghostLabel names the line the comment was last seen on, 1-based', () => {
    assert.strictEqual(ghostLabel(0, 'open'), '⚠ Moved — anchor not found (was L1)');
    assert.strictEqual(ghostLabel(62, 'open'), '⚠ Moved — anchor not found (was L63)');
});

test('ghostLabel marks a resolved drifted comment as resolved', () => {
    assert.strictEqual(ghostLabel(62, 'resolved'), '✅ Resolved · ⚠ Moved (was L63)');
});

test('applyGhostEdit writes a reply back into the drifted record', () => {
    const rec = {
        id: 7, uri: 'file:///a.ts', lastKnownLine: 62, status: 'open',
        comments: [{ id: 1, role: 'user', body: 'hi', timestamp: '2026-01-01T00:00:00Z' }],
        updatedAt: '2026-01-01T00:00:00Z',
    };
    applyGhostEdit(rec, [
        { id: 1, role: 'user', body: 'hi', createdAt: '2026-01-01T00:00:00Z' },
        { id: 2, role: 'agent', body: 'answered', createdAt: '2026-01-03T00:00:00Z' },
    ], 'drifted-open', '2026-01-03T00:00:00Z');

    assert.strictEqual(rec.comments.length, 2);
    assert.deepStrictEqual(rec.comments[1], { id: 2, role: 'agent', body: 'answered', timestamp: '2026-01-03T00:00:00Z' });
    assert.strictEqual(rec.status, 'open');
    assert.strictEqual(rec.updatedAt, '2026-01-03T00:00:00Z');
});

test('applyGhostEdit writes a resolve back into the drifted record', () => {
    const rec = {
        id: 7, uri: 'file:///a.ts', lastKnownLine: 62, status: 'open',
        comments: [{ id: 1, role: 'user', body: 'hi', timestamp: '2026-01-01T00:00:00Z' }],
        updatedAt: '2026-01-01T00:00:00Z',
    };
    applyGhostEdit(rec, [{ id: 1, role: 'user', body: 'hi', createdAt: '2026-01-01T00:00:00Z' }], 'drifted-resolved', '2026-01-04T00:00:00Z');
    assert.strictEqual(rec.status, 'resolved');
});

test('applyGhostEdit leaves the untrusted position untouched', () => {
    const rec = {
        id: 7, uri: 'file:///a.ts', lastKnownLine: 62, status: 'open',
        comments: [], updatedAt: '2026-01-01T00:00:00Z',
    };
    applyGhostEdit(rec, [], 'drifted-open', '2026-01-05T00:00:00Z');
    assert.strictEqual(rec.lastKnownLine, 62);
});
