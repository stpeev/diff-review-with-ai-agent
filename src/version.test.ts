import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from 'vitest';
import { VERSION } from './version';

test('VERSION matches the package manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as {
    version: string;
  };
  expect(VERSION).toBe(manifest.version);
});
