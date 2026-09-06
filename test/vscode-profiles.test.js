const test = require('node:test');
const assert = require('node:assert');
const { parseProfiles, userDataRoot, VSCODE_APPS } = require('../out/vscode-profiles');

test('parseProfiles: null input yields no profiles', () => {
    assert.deepStrictEqual(parseProfiles(null), []);
});

test('parseProfiles: unparsable JSON yields no profiles', () => {
    assert.deepStrictEqual(parseProfiles('not json'), []);
});

test('parseProfiles: reads name and location from userDataProfiles', () => {
    const json = JSON.stringify({
        userDataProfiles: [
            { location: 'work', name: 'Work' },
            { location: 'builtin/agents', name: 'Agents' },
        ],
    });
    assert.deepStrictEqual(parseProfiles(json), [
        { location: 'work', name: 'Work' },
        { location: 'builtin/agents', name: 'Agents' },
    ]);
});

test('parseProfiles: with no defaultFlag, a useDefaultFlags.mcp profile is still included', () => {
    const json = JSON.stringify({
        userDataProfiles: [
            { location: 'work', name: 'Work', useDefaultFlags: { mcp: true } },
        ],
    });
    assert.deepStrictEqual(parseProfiles(json), [{ location: 'work', name: 'Work' }]);
});

test('parseProfiles: with defaultFlag "mcp", a useDefaultFlags.mcp profile is excluded', () => {
    const json = JSON.stringify({
        userDataProfiles: [
            { location: 'keep', name: 'Keep' },
            { location: 'drop', name: 'Drop', useDefaultFlags: { mcp: true } },
        ],
    });
    assert.deepStrictEqual(parseProfiles(json, 'mcp'), [{ location: 'keep', name: 'Keep' }]);
});

test('parseProfiles: malformed entries are skipped', () => {
    const json = JSON.stringify({ userDataProfiles: [{ name: 'no location' }, null, 42] });
    assert.deepStrictEqual(parseProfiles(json), []);
});

test('userDataRoot: darwin path', () => {
    const app = VSCODE_APPS.find(a => a.id === 'vscode');
    assert.strictEqual(
        userDataRoot(app, '/Users/tester', 'darwin'),
        '/Users/tester/Library/Application Support/Code/User',
    );
});

test('userDataRoot: linux path', () => {
    const app = VSCODE_APPS.find(a => a.id === 'vscode-insiders');
    assert.strictEqual(
        userDataRoot(app, '/home/tester', 'linux'),
        '/home/tester/.config/Code - Insiders/User',
    );
});

test('userDataRoot: win32 path uses APPDATA when set', () => {
    const app = VSCODE_APPS.find(a => a.id === 'vscodium');
    const prevAppData = process.env.APPDATA;
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
    try {
        assert.strictEqual(
            userDataRoot(app, 'C:\\Users\\tester', 'win32'),
            'C:\\Users\\tester\\AppData\\Roaming\\VSCodium\\User',
        );
    } finally {
        if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    }
});
