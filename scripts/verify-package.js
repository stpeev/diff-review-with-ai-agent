const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(root, `${manifest.name}-${manifest.version}.vsix`);

if (!fs.existsSync(vsix)) throw new Error(`Expected package artifact ${path.basename(vsix)}.`);

const entries = execFileSync('unzip', ['-Z1', vsix], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
for (const required of ['extension/out/extension.js', 'extension/out/mcp-server.js', 'extension/out/mcp-launcher.js']) {
  if (!entries.includes(required)) throw new Error(`Package is missing ${required}.`);
}
const forbidden = entries.filter(entry => /(^|\/)(test|coverage|node_modules)\//.test(entry) || /\.test\.[cm]?[jt]s$/.test(entry));
if (forbidden.length > 0) throw new Error(`Package contains development files: ${forbidden.join(', ')}`);

// The launcher is deployed by itself to ~/.diff-review. Exercise the exact
// packaged file from an otherwise empty directory so an accidental reference
// to a sibling chunk or the repository's node_modules cannot be hidden.
const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-launcher-'));
try {
  const launcher = path.join(launcherDir, 'mcp-launcher.js');
  const marker = path.join(launcherDir, 'started');
  const fakeServer = path.join(launcherDir, 'fake-server.js');
  fs.writeFileSync(launcher, execFileSync('unzip', ['-p', vsix, 'extension/out/mcp-launcher.js']));
  fs.writeFileSync(fakeServer, "require('node:fs').writeFileSync(process.env.DIFF_REVIEW_LAUNCHER_MARKER, 'started');\n");
  execFileSync(process.execPath, [launcher], {
    cwd: launcherDir,
    env: { ...process.env, DIFF_REVIEW_SERVER: fakeServer, DIFF_REVIEW_LAUNCHER_MARKER: marker },
  });
  if (fs.readFileSync(marker, 'utf8') !== 'started') throw new Error('Packaged launcher did not load the resolved server.');
} finally {
  fs.rmSync(launcherDir, { recursive: true, force: true });
}

process.stdout.write(`Verified ${path.basename(vsix)} (${entries.length} entries).\n`);
