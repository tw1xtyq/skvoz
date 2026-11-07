import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GameDetector,
  findRunningGame,
  gameLabel,
  normalizeGameProcess,
  parseTasklistNames,
} from '../src/main/game-detector';

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"explorer.exe","4120","Console","1","120 512 K"',
  '"VALORANT-Win64-Shipping.exe","9001","Console","1","2 000 000 K"',
  '"winws.exe","777","Console","1","9 000 K"',
].join('\r\n');

test('из вывода tasklist берутся имена процессов', () => {
  assert.deepEqual(parseTasklistNames(TASKLIST), [
    'System Idle Process',
    'explorer.exe',
    'VALORANT-Win64-Shipping.exe',
    'winws.exe',
  ]);
});

test('игры узнаются по списку, по шаблону Unreal и по своему списку', () => {
  assert.equal(findRunningGame(['explorer.exe', 'cs2.exe']), 'cs2.exe');
  assert.equal(findRunningGame(parseTasklistNames(TASKLIST)), 'VALORANT-Win64-Shipping.exe');
  assert.equal(findRunningGame(['explorer.exe', 'MyGame.exe']), null);
  assert.equal(findRunningGame(['explorer.exe', 'MyGame.exe'], ['mygame.exe']), 'MyGame.exe');
  assert.equal(findRunningGame(['chrome.exe', 'discord.exe', 'steam.exe']), null, 'лаунчеры и браузер — не игра');
});

test('имя игры для трея без хвостов движка', () => {
  assert.equal(gameLabel('VALORANT-Win64-Shipping.exe'), 'VALORANT');
  assert.equal(gameLabel('cs2.exe'), 'cs2');
});

test('свои игры: путь, регистр и отсутствие .exe приводятся к имени файла', () => {
  assert.equal(normalizeGameProcess('C:\\Games\\My Game\\MyGame.EXE'), 'mygame.exe');
  assert.equal(normalizeGameProcess('  Deadlock '), 'deadlock.exe');
  assert.equal(normalizeGameProcess('osu!'), 'osu!.exe');
  assert.equal(normalizeGameProcess(''), null);
  assert.equal(normalizeGameProcess('rm -rf /;'), null);
});

test('детектор сообщает о начале и конце игры и не мигает при сбое tasklist', async () => {
  let processes: string[] | null = ['explorer.exe'];
  let enabled = true;
  const changes: Array<[string | null, string | null]> = [];
  const detector = new GameDetector({
    isEnabled: () => enabled,
    customProcesses: () => [],
    listProcesses: async () => processes,
    onChange: (game, previous) => changes.push([game, previous]),
  });

  await detector.poll();
  assert.equal(detector.current, null);
  assert.deepEqual(changes, []);

  processes = ['explorer.exe', 'dota2.exe'];
  await detector.poll();
  assert.equal(detector.current, 'dota2.exe');

  processes = null; // tasklist не ответил
  await detector.poll();
  assert.equal(detector.current, 'dota2.exe');

  processes = ['explorer.exe'];
  await detector.poll();
  assert.deepEqual(changes, [['dota2.exe', null], [null, 'dota2.exe']]);

  processes = ['dota2.exe'];
  enabled = false;
  await detector.poll();
  assert.equal(detector.current, null, 'выключенный режим игру не видит');
});
