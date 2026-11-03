import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BypassWatchdog, type BypassWatchdogOptions, type WatchdogHealth } from '../src/main/bypass-watchdog';
import type { BypassProbeResult } from '../src/main/bypass-health';

interface Harness {
  watchdog: BypassWatchdog;
  state: {
    running: boolean;
    current: string;
    working: Set<string>;
    fallbacks: string[];
    quickPick: string | null;
    quickPickCalls: number;
    started: string[];
    bad: string[];
    switched: [string, string][];
    events: string[];
    health: WatchdogHealth[];
    gaveUp: number;
    online: boolean;
    probeOverride: BypassProbeResult | null;
    stoppedByUser: boolean;
    busy: boolean;
  };
  tick: (times?: number) => Promise<void>;
}

function createHarness(overrides: Partial<BypassWatchdogOptions> = {}): Harness {
  const state: Harness['state'] = {
    running: true,
    current: 'a.bat',
    working: new Set(['a.bat']),
    fallbacks: ['b.bat', 'c.bat'],
    quickPick: null,
    quickPickCalls: 0,
    started: [],
    bad: [],
    switched: [],
    events: [],
    health: [],
    gaveUp: 0,
    online: true,
    probeOverride: null,
    stoppedByUser: false,
    busy: false,
  };

  const watchdog = new BypassWatchdog({
    healthCheckIntervalMs: 0,
    cooldownMs: 0,
    settleMs: 0,
    isStoppedByUser: () => state.stoppedByUser,
    autoRecoverEnabled: () => true,
    autoSwitchEnabled: () => true,
    isBusy: () => state.busy,
    isOnline: () => true,
    verifyRunning: async () => ({ running: state.running, pid: 42 }),
    resolveZapretPath: async () => 'C:/zapret',
    resolveStrategy: async () => state.current,
    probe: async (_root, strategy) => {
      if (state.probeOverride) return state.probeOverride;
      if (!state.online) return 'offline';
      return state.working.has(strategy) ? 'ok' : 'blocked';
    },
    restartBypass: async (_root, strategy) => {
      state.started.push(strategy);
      state.running = true;
    },
    nextFallbackStrategy: async (_root, tried) => state.fallbacks.find((s) => !tried.includes(s)) ?? null,
    markStrategyBad: (_root, strategy) => state.bad.push(strategy),
    quickPickStrategy: async () => {
      state.quickPickCalls += 1;
      return state.quickPick;
    },
    onStrategySwitched: (strategy, previous) => {
      state.switched.push([previous, strategy]);
      state.current = strategy;
    },
    onOutput: () => undefined,
    onRecovered: () => undefined,
    onGiveUp: () => {
      state.gaveUp += 1;
    },
    onEvent: (event) => state.events.push(event.kind),
    onHealth: (health) => state.health.push(health),
    sleep: async () => undefined,
    ...overrides,
  });
  watchdog.setExpected(true);

  return {
    watchdog,
    state,
    tick: async (times = 1) => {
      for (let i = 0; i < times; i += 1) await watchdog.tick();
    },
  };
}

test('упавший winws перезапускается с тем же конфигом', async () => {
  const { state, tick, watchdog } = createHarness();
  state.running = false;
  await tick();
  assert.deepEqual(state.started, ['a.bat']);
  assert.deepEqual(state.events, ['crashed', 'restored']);
  assert.equal(watchdog.currentHealth, 'ok');
});

test('рабочий обход не трогаем', async () => {
  const { state, tick, watchdog } = createHarness();
  await tick(5);
  assert.deepEqual(state.started, []);
  assert.equal(watchdog.currentHealth, 'ok');
});

test('одна неудачная проверка — ещё не повод перезапускать', async () => {
  const { state, tick, watchdog } = createHarness();
  state.working.clear();
  await tick();
  assert.deepEqual(state.started, []);
  assert.equal(watchdog.currentHealth, 'degraded');
});

test('после двух неудачных перезапусков переходит на запасной, пропуская нерабочие', async () => {
  const { state, tick, watchdog } = createHarness();
  state.working = new Set(['c.bat']);

  await tick(2); // две проверки подряд → первый перезапуск
  assert.deepEqual(state.started, ['a.bat']);
  assert.deepEqual(state.switched, []);

  await tick(2); // второй перезапуск не помог → сразу перебор запасных
  assert.deepEqual(state.started, ['a.bat', 'a.bat', 'b.bat', 'c.bat']);
  assert.deepEqual(state.bad, ['a.bat', 'b.bat']);
  assert.deepEqual(state.switched, [['a.bat', 'c.bat']]);
  assert.ok(state.events.includes('switched'));
  assert.equal(watchdog.currentHealth, 'ok');

  await tick(3);
  assert.equal(state.started.length, 4, 'на новом конфиге всё работает — больше не перезапускаем');
});

test('без автопереключения только перезапускает текущий конфиг', async () => {
  const { state, tick } = createHarness({ autoSwitchEnabled: () => false });
  state.working.clear();
  await tick(8);
  assert.ok(state.started.length >= 3);
  assert.ok(state.started.every((s) => s === 'a.bat'));
  assert.deepEqual(state.switched, []);
  assert.equal(state.quickPickCalls, 0);
});

test('запасные кончились — быстрый подбор, и его результат применяется', async () => {
  const { state, tick } = createHarness({ restartsBeforeSwitch: 1 });
  state.working = new Set(['d.bat']);
  state.quickPick = 'd.bat';
  await tick(2);
  assert.equal(state.quickPickCalls, 1);
  assert.deepEqual(state.switched, [['a.bat', 'd.bat']]);
  assert.equal(state.gaveUp, 0);
});

test('если и подбор ничего не нашёл — сдаётся и больше не дёргает обход', async () => {
  const { state, tick, watchdog } = createHarness({ restartsBeforeSwitch: 1 });
  state.working.clear();
  await tick(2);
  assert.equal(state.gaveUp, 1);
  assert.equal(watchdog.currentHealth, 'down');
  assert.ok(state.events.includes('gave-up'));

  const startedBefore = state.started.length;
  await tick(4);
  assert.equal(state.started.length, startedBefore);
});

test('пропала сеть во время перебора — останавливается, ничего лишнего не откладывая', async () => {
  const { state, tick } = createHarness({
    restartsBeforeSwitch: 1,
    restartBypass: async (_root, strategy) => {
      state.started.push(strategy);
      if (strategy === 'b.bat') state.online = false;
    },
  });
  state.working.clear();
  await tick(2);
  assert.deepEqual(state.bad, ['a.bat'], 'b.bat не виноват, что пропала сеть');
  assert.equal(state.quickPickCalls, 0);
  assert.equal(state.gaveUp, 0);
});

test('нет интернета — не считается поломкой обхода', async () => {
  const { state, tick, watchdog } = createHarness();
  state.probeOverride = 'offline';
  await tick(6);
  assert.deepEqual(state.started, []);
  assert.equal(watchdog.currentHealth, 'checking');
});

test('пока идёт подбор, сторож не вмешивается', async () => {
  const { state, tick } = createHarness();
  state.busy = true;
  state.running = false;
  await tick(3);
  assert.deepEqual(state.started, []);
});

test('пользователь остановил обход во время восстановления — перебор прекращается', async () => {
  const { state, tick } = createHarness({
    restartsBeforeSwitch: 0,
    restartBypass: async (_root, strategy) => {
      state.started.push(strategy);
      state.stoppedByUser = true;
    },
  });
  state.working.clear();
  await tick(2);
  assert.deepEqual(state.started, ['b.bat']);
  assert.deepEqual(state.switched, []);
  assert.equal(state.gaveUp, 0);
});

test('после выключения обхода сторож ничего не делает', async () => {
  const { state, tick, watchdog } = createHarness();
  watchdog.setExpected(false);
  state.running = false;
  await tick(3);
  assert.deepEqual(state.started, []);
  assert.equal(watchdog.currentHealth, 'off');
});

test('после сна проверка сайтов откладывается', async () => {
  let now = 1_000_000;
  const { state, tick, watchdog } = createHarness({ healthCheckIntervalMs: 30_000, now: () => now });
  state.working.clear();
  watchdog.deferHealthCheck(30_000);
  await tick(3);
  assert.equal(watchdog.currentHealth, 'checking', 'проверок ещё не было');
  now += 61_000;
  await tick();
  assert.equal(watchdog.currentHealth, 'degraded');
});
