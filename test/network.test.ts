import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasElevatedIntegrity } from '../src/main/admin';
import { assertBinariesPresent } from '../src/main/downloader';
import { describeNetworkError, downloadWithRetry } from '../src/main/http';
import { withSystemPath } from '../src/main/system-path';

async function withServer(
  handler: http.RequestListener,
  run: (url: string, dir: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-net-'));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/file`, dir);
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const FAST = { stallMs: 150, retryDelayMs: 1 };

test('загрузка: зависшее соединение рвётся и не оставляет файла', async () => {
  let requests = 0;
  await withServer(
    (_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-length': '1000' });
      res.write(Buffer.alloc(10));
    },
    async (url, dir) => {
      const dest = path.join(dir, 'a.zip');
      await assert.rejects(downloadWithRetry(url, dest, FAST), /Timeout/);
      assert.equal(requests, 3);
      assert.equal(fs.existsSync(dest), false);
    }
  );
});

test('загрузка: после обрыва повторяет и докачивает целый файл', async () => {
  let requests = 0;
  const retries: number[] = [];
  await withServer(
    (_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-length': '100' });
      if (requests === 1) {
        res.write(Buffer.alloc(10));
        res.destroy();
        return;
      }
      res.end(Buffer.alloc(100, 7));
    },
    async (url, dir) => {
      const dest = path.join(dir, 'a.zip');
      await downloadWithRetry(url, dest, { ...FAST, onRetry: (attempt) => retries.push(attempt) });
      assert.deepEqual(retries, [2]);
      assert.equal(fs.statSync(dest).size, 100);
    }
  );
});

test('загрузка: ошибка записи на диск отклоняет промис, а не роняет процесс', async () => {
  await withServer(
    (_req, res) => res.end(Buffer.alloc(100)),
    async (url, dir) => {
      await assert.rejects(downloadWithRetry(url, path.join(dir, 'нет-папки', 'a.zip'), FAST), { code: 'ENOENT' });
    }
  );
});

test('загрузка: HTTP-ошибка не сохраняется как файл', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(403);
      res.end('rate limit');
    },
    async (url, dir) => {
      const dest = path.join(dir, 'a.zip');
      await assert.rejects(downloadWithRetry(url, dest, FAST), /HTTP 403/);
      assert.equal(fs.existsSync(dest), false);
    }
  );
});

test('describeNetworkError называет причину и сохраняет код', () => {
  const nodeError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const cases: Array<[unknown, RegExp]> = [
    [new Error('net::ERR_NAME_NOT_RESOLVED'), /DNS.*ERR_NAME_NOT_RESOLVED/],
    [nodeError, /DNS.*ENOTFOUND/],
    [new Error('net::ERR_CERT_AUTHORITY_INVALID'), /антивирусе.*ERR_CERT_AUTHORITY_INVALID/],
    [new Error('net::ERR_CONNECTION_RESET'), /заблокирован.*ERR_CONNECTION_RESET/],
    [new Error('net::ERR_PROXY_CONNECTION_FAILED'), /прокси/],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), /нет подключения/],
    [new Error('HTTP 403'), /ограничил запросы.*HTTP 403/],
    [timeout, /не отвечает/],
    [new Error('Timeout: нет данных 45 секунд'), /не отвечает/],
    [Object.assign(new Error("EPERM: operation not permitted, open 'a'"), { code: 'EPERM' }), /антивирус.*EPERM/],
  ];
  for (const [error, expected] of cases) assert.match(describeNetworkError(error), expected);
  assert.equal(describeNetworkError(new Error('контрольная сумма не совпала')), 'контрольная сумма не совпала');
});

test('hasElevatedIntegrity смотрит на метку токена, а не на язык системы', () => {
  const line = (sid: string) => `"Обязательная метка\\Уровень","Метка","${sid}",""`;
  assert.equal(hasElevatedIntegrity(line('S-1-16-12288')), true);
  assert.equal(hasElevatedIntegrity(line('S-1-16-16384')), true);
  assert.equal(hasElevatedIntegrity(line('S-1-16-8192')), false);
  assert.equal(hasElevatedIntegrity(line('S-1-16-122880')), false);
});

test('withSystemPath дописывает только недостающие папки Windows', () => {
  const root = 'C:\\Windows';
  const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
  assert.equal(withSystemPath('', root), `C:\\Windows\\System32;${shell}`);
  assert.equal(withSystemPath('D:\\tools', root), `D:\\tools;C:\\Windows\\System32;${shell}`);
  const complete = `c:\\windows\\system32\\;${shell}\\`;
  assert.equal(withSystemPath(complete, root), complete);
});

test('assertBinariesPresent перечисляет файлы, которые удалил антивирус', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-bin-'));
  try {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'winws.exe'), '');
    fs.writeFileSync(path.join(dir, 'bin', 'WinDivert.dll'), '');
    assert.throws(() => assertBinariesPresent(dir), /WinDivert64\.sys.*антивирус/);
    fs.writeFileSync(path.join(dir, 'bin', 'WinDivert64.sys'), '');
    assert.doesNotThrow(() => assertBinariesPresent(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
