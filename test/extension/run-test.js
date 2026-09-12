/* global __dirname, console, process, require */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const launcher = await downloadedExecutable();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-vscode-test-'));
  const userDataDir = path.join(profile, 'user-data');
  const extensionsDir = path.join(profile, 'extensions');
  try {
    await runTests({
      vscodeExecutablePath: launcher.path,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`, '--disable-extensions'],
    });
  } finally {
    launcher.dispose();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function downloadedExecutable() {
  const electron = await downloadAndUnzipVSCode('1.95.0');
  if (process.platform !== 'darwin') return { path: electron, dispose() {} };

  const wrapper = path.join(os.tmpdir(), `diff-review-vscode-${process.pid}.sh`);
  const appPath = path.resolve(electron, '..', '..', 'Resources', 'app');
  fs.writeFileSync(
    wrapper,
    '#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec "$DIFF_REVIEW_ELECTRON" "$DIFF_REVIEW_APP" "$@"\n',
    { mode: 0o700 },
  );
  process.env.DIFF_REVIEW_ELECTRON = electron;
  process.env.DIFF_REVIEW_APP = appPath;
  return {
    path: wrapper,
    dispose() {
      fs.rmSync(wrapper, { force: true });
    },
  };
}

main().catch((error) => {
  console.error('Failed to run extension-host tests.', error);
  process.exitCode = 1;
});
