const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { deliverToClaude, deliverToSession } = require('../out/test/agent-deliver.js');

function claudeSession(socketPath, token = 'test-token') {
    return {
        agent: 'claude', sessionId: 'session-123', label: 'claude-test', cwd: '/work',
        socketPath, token,
    };
}

test('Claude delivery authenticates before sending the user message', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-uds-test-'));
    const socketPath = path.join(dir, 'claude.sock');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    let received = '';
    let markReceived;
    const receivedDone = new Promise(resolve => { markReceived = resolve; });
    const listening = new Promise((resolve, reject) => {
        const server = net.createServer(socket => {
            socket.setEncoding('utf8');
            socket.on('data', chunk => { received += chunk; });
            socket.on('end', () => {
                socket.end(JSON.stringify({ type: 'peer_message_status', dropped: false }) + '\n');
                markReceived();
            });
        });
        t.after(() => server.close());
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    await listening;

    const outcome = await deliverToSession(claudeSession(socketPath), 'Address comment #7');
    assert.equal(outcome, 'accepted by Claude messaging socket');
    await receivedDone;

    const frames = received.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(frames, [
        { type: 'auth', token: 'test-token' },
        {
            type: 'user', session_id: 'session-123',
            message: { role: 'user', content: 'Address comment #7' },
        },
    ]);
});

test('Claude delivery requires the private socket credentials', async () => {
    await assert.rejects(
        deliverToClaude({ agent: 'claude', sessionId: 's', label: 'c', cwd: '/work' }, 'hello'),
        /did not publish a messaging socket and token/,
    );
});
