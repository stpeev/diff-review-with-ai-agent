const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readText, backup } = require('../out/file-write');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-file-write-'));
}

test('readText: returns null for a file that does not exist', () => {
    assert.strictEqual(readText(path.join(tmpDir(), 'nope.txt')), null);
});

test('readText: returns the file contents when it exists', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello');
    assert.strictEqual(readText(file), 'hello');
});

test('backup: returns undefined and copies nothing when the file does not exist', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'missing.txt');
    assert.strictEqual(backup(file), undefined);
    assert.strictEqual(fs.existsSync(file + '.diff-review-backup'), false);
});

test('backup: copies the existing file to <file>.diff-review-backup', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'original');
    const dest = backup(file);
    assert.strictEqual(dest, file + '.diff-review-backup');
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'original');
});

test('backup: overwrites a previous backup rather than erroring', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'v1');
    backup(file);
    fs.writeFileSync(file, 'v2');
    const dest = backup(file);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'v2');
});
