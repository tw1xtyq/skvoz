import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { consumeFreshInstallMarker, FRESH_INSTALL_MARKER } from '../src/main/autonomous';
import { probeBypassTargets } from '../src/main/bypass-health';
import { isTcpTimestampsEnabled, parseScState } from '../src/main/diagnostics';
import { readBundledZapret } from '../src/main/downloader';
import { runDetachedHidden } from '../src/main/exec';
import { dropMissingInstalls, verifyInstallation } from '../src/main/scanner';
import { gameFilterPorts, parseGameFilterMode, parseGameFilterRanges } from '../src/main/service-actions';
import { isCdnDc, RepeatFilter, wsRoutes } from '../src/main/tgws/server';
import { describeWinwsExit } from '../src/main/winws-errors';
import { setGameFilter } from '../src/main/zapret';

test('метка новой установки срабатывает один раз', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-fresh-'));
  try {
    assert.equal(consumeFreshInstallMarker(dir), false);
    fs.writeFileSync(path.join(dir, FRESH_INSTALL_MARKER), '');
    assert.equal(consumeFreshInstallMarker(dir), true);
    assert.equal(consumeFreshInstallMarker(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('папка без winws.exe не считается установкой zapret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-scan-'));
  try {
    const root = path.join(dir, 'zapret-discord-youtube-1.0.0');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'winws.exe'), '');
    assert.equal(dropMissingInstalls([verifyInstallation(root, 'windows-service')]).length, 1);

    fs.rmSync(path.join(root, 'bin', 'winws.exe'));
    assert.equal(dropMissingInstalls([verifyInstallation(root, 'windows-service')]).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('состояние службы читается и из русского вывода sc', () => {
  const output = `
Имя_службы: WinDivert
        Тип                : 1  KERNEL_DRIVER
        Состояние          : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)
`;
  assert.equal(parseScState(output), 'running');
});

test('метки времени TCP читаются и из русского вывода netsh', () => {
  assert.equal(isTcpTimestampsEnabled('Метки времени RFC 1323                  : enabled'), true);
  assert.equal(isTcpTimestampsEnabled('RFC 1323 Timestamps                 : disabled'), false);
});

test('Game Filter понимает оба формата файла', () => {
  assert.equal(parseGameFilterMode('all'), 'all');
  assert.equal(parseGameFilterMode('mode=tcp\r\ntcp=1024-65535\r\nudp=1024-65535\r\n'), 'tcp');
  assert.equal(parseGameFilterMode('mode=disabled\n'), 'disabled');
  assert.equal(parseGameFilterMode('мусор'), 'disabled');
});

test('Game Filter берёт порты из файла service.bat', () => {
  const custom = 'mode=all\r\ntcp=5000-6000\r\nudp=7000,8000-9000\r\n';
  assert.deepEqual(gameFilterPorts(custom), { tcp: '5000-6000', udp: '7000,8000-9000' });
  assert.deepEqual(gameFilterPorts('mode=tcp\ntcp=5000\nudp=7000\n'), { tcp: '5000', udp: '12' });
  assert.deepEqual(gameFilterPorts('mode=udp\ntcp=5000\nudp=7000\n'), { tcp: '12', udp: '7000' });
  assert.deepEqual(gameFilterPorts('all'), { tcp: '1024-65535', udp: '1024-65535' });
  assert.deepEqual(gameFilterPorts('mode=all\ntcp=1 & calc\nudp=\n'), { tcp: '1024-65535', udp: '1024-65535' });
  assert.deepEqual(gameFilterPorts('mode=disabled\ntcp=5000\nudp=7000\n'), { tcp: '12', udp: '12' });
  assert.deepEqual(gameFilterPorts(''), { tcp: '12', udp: '12' });
});

test('смена режима Game Filter не стирает диапазоны портов', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-game-'));
  const flagFile = path.join(root, 'utils', 'game_filter.enabled');
  fs.mkdirSync(path.dirname(flagFile));
  try {
    setGameFilter(root, 'disabled');
    assert.equal(fs.existsSync(flagFile), false);

    setGameFilter(root, 'all');
    assert.equal(fs.readFileSync(flagFile, 'utf8'), 'mode=all\r\ntcp=1024-65535\r\nudp=1024-65535\r\n');

    fs.writeFileSync(flagFile, 'mode=all\r\ntcp=5000-6000\r\nudp=7000\r\n');
    setGameFilter(root, 'disabled');
    assert.equal(parseGameFilterMode(fs.readFileSync(flagFile, 'utf8')), 'disabled');
    setGameFilter(root, 'udp');
    assert.equal(fs.readFileSync(flagFile, 'utf8'), 'mode=udp\r\ntcp=5000-6000\r\nudp=7000\r\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Telegram: обычные DC идут и через закреплённый IP, и через DNS', () => {
  assert.deepEqual(wsRoutes(2, false), [
    { host: '149.154.167.220', domain: 'kws2.web.telegram.org' },
    { host: 'kws2.web.telegram.org', domain: 'kws2.web.telegram.org' },
  ]);
  assert.deepEqual(wsRoutes(1, false), [{ host: 'kws1.web.telegram.org', domain: 'kws1.web.telegram.org' }]);
  assert.equal(wsRoutes(4, true).length, 4);
});

test('Telegram: CDN не отправляется в обычный DC', () => {
  assert.equal(isCdnDc(203), true);
  assert.equal(isCdnDc(5), false);
  assert.deepEqual(wsRoutes(203, false), []);
  assert.deepEqual(wsRoutes(201, true), []);
});

test('RepeatFilter пропускает повторы и считает их', () => {
  let now = 0;
  const filter = new RepeatFilter(60_000, () => now);
  assert.deepEqual(filter.accept('a'), { show: true, skipped: 0 });
  now = 1_000;
  assert.equal(filter.accept('a').show, false);
  assert.equal(filter.accept('a').show, false);
  assert.equal(filter.accept('b').show, true);
  now = 61_000;
  assert.deepEqual(filter.accept('a'), { show: true, skipped: 2 });
});

test('запуск: виден код выхода и вывод упавшего процесса', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-launch-'));
  let keepAlive: NodeJS.Timeout | undefined;
  try {
    const logPath = path.join(dir, 'out.log');
    // процесс отвязан через unref, а другой работы у тестового цикла нет
    keepAlive = setInterval(() => undefined, 1_000);
    const script = "console.log('windivert: error opening filter: error 1275'); process.exit(7)";
    const { exited } = await runDetachedHidden(process.execPath, ['-e', script], dir, logPath);
    assert.equal(await exited, 7);
    const message = describeWinwsExit(7, fs.readFileSync(logPath, 'utf8'));
    assert.match(message, /заблокировала драйвер/);
    assert.match(message, /error 1275/);
  } finally {
    clearInterval(keepAlive);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('проверка обхода: разовый сбой сайта не считается блокировкой', async () => {
  const calls: string[] = [];
  const result = await probeBypassTargets(['https://a.example', 'https://b.example'], {
    retryDelayMs: 0,
    reachable: async () => true,
    check: async (url) => {
      calls.push(url);
      return url.includes('a.') || calls.length > 2;
    },
  });
  assert.equal(result, 'ok');
  assert.deepEqual(calls, ['https://a.example', 'https://b.example', 'https://b.example']);
});

test('проверка обхода: называет сайт, который не открылся и после повтора', async () => {
  let failed: string[] = [];
  const result = await probeBypassTargets(['https://a.example/x', 'https://b.example'], {
    retryDelayMs: 0,
    reachable: async () => true,
    check: async (url) => url.includes('b.'),
    onFailed: (hosts) => {
      failed = hosts;
    },
  });
  assert.equal(result, 'blocked');
  assert.deepEqual(failed, ['a.example']);
});

test('проверка обхода: без интернета это не блокировка', async () => {
  const result = await probeBypassTargets(['https://a.example'], {
    retryDelayMs: 0,
    reachable: async () => false,
    check: async () => false,
  });
  assert.equal(result, 'offline');
});

test('describeWinwsExit не выдумывает причину, если её нет в выводе', () => {
  assert.match(describeWinwsExit(1, ''), /код 1.*другой конфиг/);
  assert.match(describeWinwsExit(1, 'Access is denied.'), /нет прав/);
});

test('readBundledZapret: архив есть только в сборке', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-res-'));
  try {
    assert.equal(readBundledZapret(dir), null);
    fs.mkdirSync(path.join(dir, 'zapret'));
    fs.writeFileSync(path.join(dir, 'zapret', 'zapret.zip'), 'x');
    assert.equal(readBundledZapret(dir), null);
    fs.writeFileSync(path.join(dir, 'zapret', 'VERSION'), '1.10.4\n');
    fs.writeFileSync(path.join(dir, 'zapret', 'SHA256'), 'ABC\n');
    assert.deepEqual(readBundledZapret(dir), {
      zipPath: path.join(dir, 'zapret', 'zapret.zip'),
      version: '1.10.4',
      sha256: 'abc',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('неверные диапазоны игрового фильтра заменяются стандартным', () => {
  for (const bad of [',', '-', '1-2-3', '0', '70000', '6000-5000', '5000,']) {
    assert.equal(parseGameFilterRanges(`mode=all\r\ntcp=${bad}\r\n`).tcp, '1024-65535', bad);
  }
  assert.equal(parseGameFilterRanges('tcp=80, 5000-6000\n').tcp, '80,5000-6000');
});
