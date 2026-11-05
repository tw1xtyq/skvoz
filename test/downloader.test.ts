import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractZipWithTar, systemTarPath } from '../src/main/downloader';

test('tar берётся только из System32', () => {
  assert.equal(systemTarPath('D:\\Win'), 'D:\\Win\\System32\\tar.exe');
});

test(
  'ZIP распаковывается, даже если первым в PATH стоит GNU tar',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-tar-'));
    const previousPath = process.env.PATH;
    try {
      const source = path.join(dir, 'winws.txt');
      const zip = path.join(dir, 'zapret.zip');
      const dest = path.join(dir, 'out');
      fs.writeFileSync(source, 'ok');
      fs.mkdirSync(dest);
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath '${source}' -DestinationPath '${zip}'`,
      ]);

      process.env.PATH = `C:\\Program Files\\Git\\usr\\bin;${previousPath}`;
      await extractZipWithTar(zip, dest);

      assert.equal(fs.readFileSync(path.join(dest, 'winws.txt'), 'utf8'), 'ok');
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
