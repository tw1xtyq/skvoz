import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeProbe, normalizeProbeSite, pickProbeUrls, PROBE_BODY_BYTES } from '../src/main/bypass-health';
import { BypassEventLog } from '../src/main/bypass-events';
import { BackgroundRerank, hasDisplayRequests, type BackgroundRerankOptions } from '../src/main/background-rerank';
import { paintStatusDot } from '../src/main/tray-badge';
import { buildDiagnosticReport, redactText } from '../src/main/diagnostic-report';

const TARGETS = [
  { name: 'Discord Main', url: 'https://discord.com' },
  { name: 'Discord Gateway', url: 'https://gateway.discord.gg' },
  { name: 'YouTube Web', url: 'https://www.youtube.com' },
  { name: 'Google', url: 'https://www.google.com' },
  { name: 'Cloudflare DNS' },
];

test('по одной цели YouTube и Discord', () => {
  assert.deepEqual(pickProbeUrls(TARGETS, []), ['https://discord.com', 'https://www.youtube.com']);
});

test('цель, не открывавшаяся у конфига при подборе, пропускается', () => {
  assert.deepEqual(pickProbeUrls(TARGETS, ['Discord Main']), [
    'https://gateway.discord.gg',
    'https://www.youtube.com',
  ]);
});

test('свои сайты важнее списка zapret', () => {
  assert.deepEqual(pickProbeUrls(TARGETS, [], ['instagram.com', 'instagram.com', 'мусор']), [
    'https://instagram.com/',
  ]);
});

test('адрес сайта нормализуется, мусор отбрасывается', () => {
  assert.equal(normalizeProbeSite('youtube.com'), 'https://youtube.com/');
  assert.equal(normalizeProbeSite('http://example.org/path'), 'http://example.org/path');
  assert.equal(normalizeProbeSite('localhost'), null);
  assert.equal(normalizeProbeSite('   '), null);
});

const ANY_CODE = /^[1-5]\d\d$/;

test('ответ пришёл целиком — сайт открывается', () => {
  assert.equal(judgeProbe('200 65536', 0, ANY_CODE, true), true);
  assert.equal(judgeProbe('301 162', 0, ANY_CODE, true), true, 'короткий редирект — тоже ответ');
});

test('сброс соединения — блокировка', () => {
  assert.equal(judgeProbe('000 0', 35, ANY_CODE, true), false);
  assert.equal(judgeProbe('000 0', 28, ANY_CODE, true), false);
  assert.equal(judgeProbe('', null, ANY_CODE, true), false);
});

test('соединение «замёрзло» после первых килобайт — блокировка', () => {
  assert.equal(judgeProbe('200 16384', 28, ANY_CODE, true), false);
  assert.equal(judgeProbe(`200 ${PROBE_BODY_BYTES}`, 28, ANY_CODE, true), true, 'медленно, но данные идут');
});

test('для контрольных адресов хватает заголовков', () => {
  assert.equal(judgeProbe('204 0', 0, /^[23]\d\d$/, false), true);
  assert.equal(judgeProbe('503 0', 0, /^[23]\d\d$/, false), false);
});

test('журнал склеивает повторы и знает, с какого момента обход работает', () => {
  let now = 0;
  const log = new BypassEventLog(null, () => now);
  log.add('started', 'Обход запущен', 'a.bat');
  now += 1_000;
  log.add('crashed', 'winws.exe не запущен');
  now += 1_000;
  log.add('crashed', 'winws.exe не запущен');
  assert.equal(log.list().length, 2);
  assert.deepEqual(log.runningSince(), { at: 0, strategy: 'a.bat' });

  now += 1_000;
  log.add('switched', 'a → b', 'b.bat');
  assert.deepEqual(log.runningSince(), { at: 3_000, strategy: 'b.bat' });

  log.add('stopped', 'Обход остановлен');
  assert.equal(log.runningSince(), null);
  assert.equal(log.list()[0].kind, 'stopped', 'новые сверху');
});

test('журнал не растёт бесконечно', () => {
  let now = 0;
  const log = new BypassEventLog(null, () => now);
  for (let i = 0; i < 150; i += 1) {
    now += 10 * 60_000;
    log.add('network', `Сеть ${i}`);
  }
  assert.equal(log.list().length, 100);
  assert.equal(log.list()[0].text, 'Сеть 149');
});

function rerankHarness(overrides: Partial<BackgroundRerankOptions> = {}) {
  const state = { idle: 3_600, runs: 0, result: 'done' as 'done' | 'cancelled' | 'failed', needs: true };
  let now = 0;
  const rerank = new BackgroundRerank({
    isEnabled: () => true,
    canRun: () => true,
    getIdleSeconds: () => state.idle,
    needsRerank: async () => state.needs,
    run: async () => {
      state.runs += 1;
      return state.result;
    },
    now: () => now,
    ...overrides,
  });
  return { rerank, state, advance: (ms: number) => (now += ms) };
}

test('перепроверка — только в простое', async () => {
  const { rerank, state } = rerankHarness();
  state.idle = 30;
  assert.equal(await rerank.check(), false);
  assert.equal(state.runs, 0);
  state.idle = 3_600;
  assert.equal(await rerank.check(), true);
  assert.equal(state.runs, 1);
});

test('после прерванной перепроверки — пауза, после удачной — нет', async () => {
  const { rerank, state, advance } = rerankHarness();
  state.result = 'cancelled';
  await rerank.check();
  await rerank.check();
  assert.equal(state.runs, 1);
  advance(61 * 60_000);
  state.result = 'done';
  await rerank.check();
  assert.equal(state.runs, 2);
  await rerank.check();
  assert.equal(state.runs, 3, 'нужна ли ещё перепроверка, решает needsRerank');
});

test('выключенная или ненужная перепроверка не запускается', async () => {
  const disabled = rerankHarness({ isEnabled: () => false });
  await disabled.rerank.check();
  assert.equal(disabled.state.runs, 0);

  const fresh = rerankHarness();
  fresh.state.needs = false;
  await fresh.rerank.check();
  assert.equal(fresh.state.runs, 0);
});

test('пока идёт видео, перепроверка ждёт', async () => {
  let watching = true;
  const { rerank, state } = rerankHarness({ isUserWatching: async () => watching });
  assert.equal(await rerank.check(), false);
  assert.equal(state.runs, 0);
  watching = false;
  assert.equal(await rerank.check(), true);
});

const POWERCFG_IDLE = `DISPLAY:
Нет.

SYSTEM:
[DRIVER] Realtek High Definition Audio (HDAUDIO\\FUNC_01)
Используется аудиопоток.

AWAYMODE:
Нет.

EXECUTION:
Нет.
`;

test('видео и игры видны по запросам DISPLAY, аудиопоток — нет', () => {
  assert.equal(hasDisplayRequests(POWERCFG_IDLE), false);
  const playing = POWERCFG_IDLE.replace(
    'DISPLAY:\nНет.',
    'DISPLAY:\n[PROCESS] \\Device\\HarddiskVolume3\\Program Files\\Google\\Chrome\\Application\\chrome.exe\nVideo Wake Lock'
  );
  assert.equal(hasDisplayRequests(playing), true);
  assert.equal(hasDisplayRequests(POWERCFG_IDLE.replace(/\n/g, '\r\n')), false);
});

test('точка рисуется в правом нижнем углу, остальное не трогается', () => {
  const size = 32;
  const bitmap = Buffer.alloc(size * size * 4, 0);
  const painted = paintStatusDot(bitmap, size, size, [0, 200, 0]);
  const pixel = (x: number, y: number) => [...painted.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

  const [b, g, r, a] = pixel(24, 24);
  assert.equal(a, 255);
  assert.ok(g > 150 && r < 50 && b < 50, `ожидался зелёный, получили ${[r, g, b]}`);
  assert.deepEqual(pixel(2, 2), [0, 0, 0, 0]);
  assert.deepEqual([...bitmap.subarray(0, 4)], [0, 0, 0, 0], 'исходный буфер не меняется');
});

test('отчёт не содержит домашней папки и имени пользователя', () => {
  const report = buildDiagnosticReport({
    generatedAt: 0,
    appVersion: '1.0.0',
    platform: 'Windows_NT',
    isAdmin: true,
    settings: { probeSites: [] },
    zapret: { path: 'C:\\Users\\vasya\\zapret', running: true, strategy: 'a.bat', strategies: 3 },
    watchdogHealth: 'ok',
    network: 'Дом',
    rankings: [{ strategy: 'a.bat', score: 5, maxScore: 10, okChecks: 5, totalChecks: 10, failed: ['Discord'] }],
    rankedAt: 0,
    events: [{ at: 0, kind: 'started', text: 'Обход запущен', strategy: 'a.bat' }],
    log: [{ at: 0, level: 'info', text: 'Запуск C:\\Users\\vasya\\zapret\\bin\\winws.exe' }],
    redact: ['C:\\Users\\vasya', 'vasya'],
  });
  assert.ok(!report.includes('vasya'));
  assert.ok(report.includes('50% a.bat'));
  assert.ok(report.includes('не открылось: Discord'));
});

test('короткие строки не вычищаются, чтобы не испортить текст', () => {
  assert.equal(redactText('Обход a.bat', ['a']), 'Обход a.bat');
});
