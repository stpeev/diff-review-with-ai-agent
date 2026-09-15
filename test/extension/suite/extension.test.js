/* global require, suite, test */
const assert = require('node:assert/strict');
const vscode = require('vscode');

suite('Diff Review extension', () => {
  test('activates and registers core review commands', async () => {
    const extension = vscode.extensions.getExtension('JinqiShen.diff-review');
    assert.ok(extension, 'The development extension should be discoverable.');

    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'diffReview.createNote',
      'diffReview.reply',
      'diffReview.resolve',
      'diffReview.showPanel',
      'diffReview.registerMcpServer',
    ]) {
      assert.ok(commands.includes(command), `Expected ${command} after activation.`);
    }
  });
});
