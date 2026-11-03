import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StrategyMemory } from '../src/main/strategy-memory';
import type { StrategyRanking } from '../src/main/tests-runner';

function ranking(strategy: string, score: number, failed: string[] = []): StrategyRanking {
  return { strategy, score, maxScore: 10, okChecks: score, totalChecks: 10, failed };
}

test('у каждой сети свой рейтинг и свой последний конфиг', () => {
  const memory = new StrategyMemory(null);
  memory.saveRankings('home', 'Дом', 'C:/z', [ranking('a.bat', 10)], true);
  memory.saveRankings('phone', 'Телефон', 'C:/z', [ranking('b.bat', 9)], true);
  memory.rememberSelected('home', 'Дом', 'a.bat');
  memory.rememberSelected('phone', 'Телефон', 'b.bat');

  assert.equal(memory.getRankings('home', 'C:/z')[0].strategy, 'a.bat');
  assert.equal(memory.getRankings('phone', 'C:/z')[0].strategy, 'b.bat');
  assert.equal(memory.getProfile('home')?.selected, 'a.bat');
  assert.equal(memory.getProfile('phone')?.selected, 'b.bat');
});

test('рейтинг с другой папки zapret не используется', () => {
  const memory = new StrategyMemory(null);
  memory.saveRankings('home', 'Дом', 'C:/z-1.0', [ranking('a.bat', 10)], true);
  assert.deepEqual(memory.getRankings('home', 'C:/z-1.1'), []);
  assert.equal(memory.rankedAt('home', 'C:/z-1.1'), null);
});

test('быстрый подбор дополняет рейтинг, полный — заменяет', () => {
  const memory = new StrategyMemory(null);
  memory.saveRankings('home', 'Дом', 'C:/z', [ranking('a.bat', 5), ranking('b.bat', 3)], true);
  memory.saveRankings('home', 'Дом', 'C:/z', [ranking('c.bat', 10)], false);
  assert.deepEqual(
    memory.getRankings('home', 'C:/z').map((r) => r.strategy),
    ['c.bat', 'a.bat', 'b.bat']
  );

  memory.saveRankings('home', 'Дом', 'C:/z', [ranking('b.bat', 8)], true);
  assert.deepEqual(memory.getRankings('home', 'C:/z').map((r) => r.strategy), ['b.bat']);
});

test('отложенный конфиг возвращается через заданное время и сбрасывается полным подбором', () => {
  let now = 1_000;
  const memory = new StrategyMemory(null, () => now);
  memory.saveRankings('home', 'Дом', 'C:/z', [ranking('a.bat', 10)], true);
  memory.markBad('home', 'Дом', 'C:/z', 'a.bat', 60_000);
  assert.equal(memory.isBad('home', 'C:/z', 'a.bat'), true);
  assert.equal(memory.isBad('phone', 'C:/z', 'a.bat'), false, 'в другой сети конфиг может работать');

  now += 61_000;
  assert.equal(memory.isBad('home', 'C:/z', 'a.bat'), false);

  memory.markBad('home', 'Дом', 'C:/z', 'a.bat', 60_000);
  memory.saveRankings('home', 'Дом', 'C:/z', [ranking('a.bat', 10)], true);
  assert.equal(memory.isBad('home', 'C:/z', 'a.bat'), false);
});

test('после обновления zapret рейтинги и отметки забываются, выбранные конфиги — нет', () => {
  const memory = new StrategyMemory(null);
  memory.saveRankings('home', 'Дом', 'C:/z', [ranking('a.bat', 10)], true);
  memory.markBad('home', 'Дом', 'C:/z', 'b.bat', 60_000);
  memory.rememberSelected('home', 'Дом', 'a.bat');
  memory.forgetRankings();

  assert.deepEqual(memory.getRankings('home', 'C:/z'), []);
  assert.equal(memory.isBad('home', 'C:/z', 'b.bat'), false);
  assert.equal(memory.getProfile('home')?.selected, 'a.bat');
});

test('память сохраняется на диск и читается обратно', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-memory-'));
  const file = path.join(dir, 'memory.json');
  try {
    const memory = new StrategyMemory(file);
    memory.saveRankings('home', 'Дом', 'C:/z', [ranking('a.bat', 10)], true);
    memory.rememberSelected('home', 'Дом', 'a.bat');

    const reloaded = new StrategyMemory(file);
    assert.equal(reloaded.getRankings('home', 'C:/z')[0].strategy, 'a.bat');
    assert.equal(reloaded.getProfile('home')?.label, 'Дом');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('битый файл не ломает приложение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-memory-'));
  const file = path.join(dir, 'memory.json');
  try {
    fs.writeFileSync(file, '{ не json');
    const memory = new StrategyMemory(file);
    assert.deepEqual(memory.listProfiles(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('хранит не больше 20 сетей, старые вытесняются', () => {
  let now = 0;
  const memory = new StrategyMemory(null, () => now);
  for (let i = 0; i < 25; i += 1) {
    now += 1;
    memory.touch(`net-${i}`, `Сеть ${i}`);
  }
  const ids = memory.listProfiles().map((p) => p.id);
  assert.equal(ids.length, 20);
  assert.ok(!ids.includes('net-0'));
  assert.ok(ids.includes('net-24'));
});
