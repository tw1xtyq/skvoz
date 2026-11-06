import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  backupUserFiles,
  extractZipWithTar,
  readInstalledVersion,
  restoreUserFiles,
  systemTarPath,
} from '../src/main/downloader';
import { compareVersions } from '../src/main/version-utils';
import { checkForUpdates } from '../src/main/zapret';

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

function withRoots(run: (oldRoot: string, newRoot: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-roots-'));
  const oldRoot = path.join(dir, 'old');
  const newRoot = path.join(dir, 'new');
  fs.mkdirSync(path.join(oldRoot, 'utils'), { recursive: true });
  fs.mkdirSync(path.join(newRoot, 'utils'), { recursive: true });
  try {
    run(oldRoot, newRoot);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('выключенная проверка обновлений не включается из нового архива', () => {
  withRoots((oldRoot, newRoot) => {
    fs.writeFileSync(path.join(oldRoot, 'utils', 'game_filter.enabled'), 'mode=all\n');
    fs.writeFileSync(path.join(newRoot, 'utils', 'check_updates.enabled'), 'ENABLED');

    restoreUserFiles(newRoot, backupUserFiles(oldRoot));

    assert.equal(fs.existsSync(path.join(newRoot, 'utils', 'check_updates.enabled')), false);
    assert.equal(fs.readFileSync(path.join(newRoot, 'utils', 'game_filter.enabled'), 'utf8'), 'mode=all\n');
  });
});

test('отсутствующий свой список не удаляет файл из архива', () => {
  withRoots((oldRoot, newRoot) => {
    const list = path.join(newRoot, 'lists', 'list-general-user.txt');
    fs.mkdirSync(path.dirname(list));
    fs.writeFileSync(list, 'example.com\n');

    restoreUserFiles(newRoot, backupUserFiles(oldRoot));

    assert.equal(fs.existsSync(list), true);
  });
});

test('буква — часть версии zapret', () => {
  withRoots((oldRoot) => {
    const folder = path.join(path.dirname(oldRoot), 'zapret-discord-youtube-1.9.9d');
    fs.mkdirSync(folder);
    assert.equal(readInstalledVersion(folder), '1.9.9d');

    fs.writeFileSync(path.join(oldRoot, 'service.bat'), 'set "LOCAL_VERSION=1.9.9d"\r\n');
    assert.equal(readInstalledVersion(oldRoot), '1.9.9d');
  });
  assert.ok(compareVersions('1.9.9d', '1.10.0') < 0);
});

test('недоступный GitHub — это сбой проверки, а не «последняя версия»', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('fetch failed'));
  try {
    const result = await checkForUpdates(path.join(os.tmpdir(), 'zapret-discord-youtube-1.10.4'));
    assert.equal(result.checkFailed, true);
    assert.equal(result.latest, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('буква версии zapret учитывается при сравнении', () => {
  assert.ok(compareVersions('1.9.9', '1.9.9d') < 0);
  assert.ok(compareVersions('1.9.9c', '1.9.9d') < 0);
  assert.equal(compareVersions('v1.9.9d', '1.9.9D'), 0);
});
