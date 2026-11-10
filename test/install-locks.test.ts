import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isFileLockError, promoteWithFallback, removeInstallLeftovers } from '../src/main/downloader';
import { humanizeError, lockedFileName } from '../src/renderer/ui';

function lockError(message = 'EPERM: operation not permitted'): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EPERM' });
}

test('из ошибки берётся имя файла, а не кавычка', () => {
  assert.equal(
    lockedFileName("EPERM: operation not permitted, rename 'C:\\Users\\a\\Videos\\zapret-discord-youtube-1.10.4\\' -> 'C:\\x\\y'"),
    'zapret-discord-youtube-1.10.4'
  );
  assert.equal(
    lockedFileName("EPERM: operation not permitted, unlink 'C:\\ProgramData\\Skvoz\\z\\bin\\WinDivert64.sys'"),
    'WinDivert64.sys'
  );
  assert.equal(lockedFileName('Remove-Item : Отказано в доступе по пути C:\\z\\bin\\winws.exe.'), 'winws.exe');
  assert.equal(lockedFileName("EPERM: operation not permitted, rmdir ''"), '');
  assert.equal(lockedFileName('EPERM: operation not permitted'), '');
});

test('окно ошибки без имени файла не показывает «»', () => {
  const view = humanizeError(new Error("EPERM: operation not permitted, rename '\\' -> '\\'"));
  assert.equal(view.title, 'Файл занят');
  assert.ok(!view.message.includes('«'), view.message);
});

test('блокировку узнаём и без кода — по тексту ошибки', () => {
  assert.ok(isFileLockError(lockError()));
  assert.ok(isFileLockError(new Error('EBUSY: resource busy or locked, rmdir C:\\z')));
  assert.ok(isFileLockError(new Error('Remove-Item : Процесс не может получить доступ к файлу, так как этот файл занят другим процессом.')));
  assert.ok(!isFileLockError(new Error('ENOENT: no such file or directory')));
});

test('занятая старая папка — ставим рядом', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-promote-'));
  const staging = path.join(dir, 'staging');
  const target = path.join(dir, 'zapret-discord-youtube-1.10.4');
  fs.mkdirSync(staging);
  fs.mkdirSync(target);
  fs.mkdirSync(`${target}-2`); // уже занята прошлой попыткой
  const tried: string[] = [];
  try {
    const result = await promoteWithFallback(staging, target, () => undefined, async (_s, to) => {
      tried.push(path.basename(to));
      if (to === target) throw lockError();
    });
    assert.equal(result, `${target}-3`);
    assert.deepEqual(tried, ['zapret-discord-youtube-1.10.4', 'zapret-discord-youtube-1.10.4-3']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('другие ошибки установки не прячем за запасной папкой', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-promote-'));
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(staging);
  try {
    await assert.rejects(
      promoteWithFallback(staging, path.join(dir, 'z'), () => undefined, async () => {
        throw new Error('ENOSPC: no space left on device');
      }),
      /ENOSPC/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('остатки прошлых установок убираются, свежая загрузка и рабочая папка — нет', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-leftovers-'));
  const keep = ['zapret-discord-youtube-1.10.4', 'zapret-download-fresh', 'Captures'];
  const drop = ['zapret-discord-youtube-1.10.4.retired-1793628781374', 'zapret-download-old'];
  for (const name of [...keep, ...drop]) fs.mkdirSync(path.join(dir, name));
  const old = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(path.join(dir, 'zapret-download-old'), old, old);
  try {
    removeInstallLeftovers(dir);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(fs.readdirSync(dir).sort(), [...keep].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
