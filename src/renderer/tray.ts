// Мини-окно у значка в трее: быстрые переключатели без открытия основного окна.

interface TrayApi {
  getDashboardState(options?: { light?: boolean }): Promise<{
    config: { selectedStrategy: string | null };
    status: {
      pathsValid: boolean;
      bypass: { running: boolean };
      selectedStrategy: string | null;
      settings: { gameFilter: GameFilter; ipset: IpsetMode };
    };
  }>;
  startBypass(): Promise<unknown>;
  setIpsetMode(mode: IpsetMode): Promise<{ restarted?: boolean }>;
  setGameFilter(mode: GameFilter): Promise<{ restarted?: boolean }>;
  recoverBypassNow(): Promise<{ health: Health }>;
  stopBypass(): Promise<unknown>;
  tgwsStatus(): Promise<{
    running: boolean;
    config: { host: string; port: number };
    stats: { active: number };
  }>;
  tgwsStart(): Promise<unknown>;
  tgwsStop(): Promise<unknown>;
  vpnStatus(): Promise<{ running: boolean; configured: boolean; summary: { endpoint: string } | null }>;
  vpnConnect(): Promise<unknown>;
  vpnDisconnect(): Promise<unknown>;
  checkAccess(): Promise<Array<{ id: string; status: 'ok' | 'partial' | 'fail'; detail: string }>>;
  getBypassActivity(): Promise<{
    health: Health;
    healthLabel: string;
    network: string;
    since: { at: number } | null;
    retryAt: number | null;
    canRecover: boolean;
    game: string | null;
    foreignVpn: string | null;
  }>;
  onBypassActivityChanged(callback: () => void): () => void;
  showMainWindow(view?: string): Promise<unknown>;
  onTrayReveal(callback: () => void): () => void;
  reportTrayHeight(height: number): void;
}

type Health = 'off' | 'checking' | 'ok' | 'degraded' | 'recovering' | 'down';
type IpsetMode = 'loaded' | 'any' | 'none';
type GameFilter = 'disabled' | 'all' | 'tcp' | 'udp';

const trayApi = (window as unknown as { zapretApi: TrayApi }).zapretApi;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const bypassRow = $('tpBypass');
const bypassText = $('tpBypassText');
const bypassToggle = $<HTMLInputElement>('tpBypassToggle');
const tgRow = $('tpTg');
const tgText = $('tpTgText');
const tgToggle = $<HTMLInputElement>('tpTgToggle');
const vpnRow = $('tpVpn');
const vpnText = $('tpVpnText');
const vpnToggle = $<HTMLInputElement>('tpVpnToggle');
const summary = $('tpSummary');
const meta = $('tpMeta');
const errorEl = $('tpError');
const checkBtn = $<HTMLButtonElement>('tpCheck');
const repairRow = $('tpRepair');
const repairText = $('tpRepairText');
const repairBtn = $<HTMLButtonElement>('tpRepairBtn');
const tune = $('tpTune');
const ipsetSeg = $('tpIpset');
const gameSeg = $('tpGame');

let busy = false;
let pollTimer: number | null = null;

function showError(err: unknown): void {
  const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

async function refresh(): Promise<void> {
  if (busy) return;
  try {
    const [{ config, status }, tg, vpn, activity] = await Promise.all([
      trayApi.getDashboardState({ light: true }),
      trayApi.tgwsStatus(),
      trayApi.vpnStatus(),
      trayApi.getBypassActivity(),
    ]);
    const running = status.bypass.running;
    const strategy = (config.selectedStrategy ?? status.selectedStrategy ?? '').replace(/\.bat$/i, '');
    // сторож видит сбой раньше, чем winws пропадёт: точка жёлтая или красная
    const troubled = running && ['degraded', 'recovering', 'down'].includes(activity.health);
    bypassRow.classList.toggle('is-live', running && !troubled);
    bypassRow.classList.toggle('is-warn', troubled && activity.health !== 'down');
    bypassRow.classList.toggle('is-bad', troubled && activity.health === 'down');
    bypassToggle.checked = running;
    bypassToggle.disabled = !status.pathsValid;
    bypassText.textContent = !status.pathsValid
      ? 'zapret не найден'
      : running
        ? [strategy, activity.health === 'off' ? '' : activity.healthLabel].filter(Boolean).join(' · ')
        : `Выключен${strategy ? ` · ${strategy}` : ''}`;
    bypassText.title = bypassText.textContent;

    const metaParts = [
      activity.game ? `игровой режим · ${activity.game}` : '',
      activity.network === 'Неизвестная сеть' ? '' : activity.network,
    ];
    if (running && activity.since) metaParts.push(`обход работает с ${formatClock(activity.since.at)}`);
    meta.textContent = metaParts.filter(Boolean).join(' · ');
    meta.classList.toggle('hidden', !meta.textContent);

    renderRepair(running, activity);
    renderSeg(ipsetSeg, status.pathsValid ? status.settings.ipset : null);
    renderSeg(gameSeg, status.pathsValid ? status.settings.gameFilter : null);
    tune.classList.toggle('is-disabled', !status.pathsValid);
    tune.title = !status.pathsValid ? 'zapret не найден' : running ? 'Смена перезапустит обход' : '';

    tgRow.classList.toggle('is-live', tg.running);
    tgToggle.checked = tg.running;
    tgText.textContent = tg.running
      ? `${tg.config.host}:${tg.config.port} · ${tg.stats.active} подкл.`
      : 'Выключен';

    vpnRow.classList.toggle('is-live', vpn.running);
    vpnToggle.checked = vpn.running;
    vpnToggle.disabled = !vpn.configured && !vpn.running;
    vpnText.textContent = vpn.running
      ? `Включён · ${vpn.summary?.endpoint ?? ''}`
      : vpn.configured
        ? 'Выключен'
        : 'Нет конфига';

    // VPN не обязателен: «всё работает» — когда включены обход и прокси
    const live = Number(running) + Number(tg.running);
    summary.textContent = troubled
      ? 'есть сбой'
      : live === 2 ? 'всё работает' : live === 1 ? 'работает частично' : vpn.running ? 'только VPN' : 'выключено';
    summary.dataset.state = troubled ? 'warn' : String(live);
  } catch (err) {
    showError(err);
  }
}

function setControlsDisabled(disabled: boolean): void {
  bypassToggle.disabled = disabled;
  tgToggle.disabled = disabled;
  vpnToggle.disabled = disabled;
  repairBtn.disabled = disabled;
  document.querySelectorAll<HTMLButtonElement>('.tp-seg button').forEach((b) => (b.disabled = disabled));
}

async function act(fn: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  errorEl.classList.add('hidden');
  setControlsDisabled(true);
  try {
    await fn();
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    // refresh снова заблокирует недоступное; если он упадёт — переключатели не залипнут
    setControlsDisabled(false);
    await refresh();
  }
}

function renderSeg(seg: HTMLElement, value: string | null): void {
  seg.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.value === value));
    button.classList.remove('is-pending');
    if (!busy) button.disabled = value === null;
  });
}

/** Сторож видит сбой или сдался — даём починить в один клик, а не искать кнопку в окне */
function renderRepair(running: boolean, activity: Awaited<ReturnType<TrayApi['getBypassActivity']>>): void {
  if (running && activity.foreignVpn) {
    // чинить zapret бесполезно: трафик забирает чужой VPN
    repairRow.classList.remove('hidden', 'is-bad');
    repairBtn.classList.add('hidden');
    repairText.textContent = `Мешает VPN «${activity.foreignVpn}» — отключите его`;
    repairText.title = 'Весь трафик идёт через сторонний VPN, мимо zapret. Пока он включён, проверки обхода на паузе.';
    return;
  }
  const show = activity.canRecover && (activity.health === 'down' || (running && activity.health === 'degraded'));
  repairRow.classList.toggle('hidden', !show && activity.health !== 'recovering');
  repairRow.classList.toggle('is-bad', activity.health === 'down');
  if (activity.health === 'recovering') {
    repairText.textContent = 'Восстанавливаю обход…';
    repairBtn.classList.add('hidden');
    return;
  }
  repairBtn.classList.remove('hidden');
  repairText.textContent =
    activity.health === 'down'
      ? activity.retryAt
        ? `Сам попробую в ${formatTimeOnly(activity.retryAt)}`
        : 'Рабочий конфиг не найден'
      : 'Не все сайты открываются';
  repairText.title = repairText.textContent;
}

function bindSeg(seg: HTMLElement, apply: (value: string) => Promise<unknown>): void {
  seg.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
    if (!button || button.disabled || button.getAttribute('aria-checked') === 'true') return;
    // сразу показываем выбор: перезапуск обхода занимает пару секунд
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', 'false'));
    button.setAttribute('aria-checked', 'true');
    button.classList.add('is-pending');
    void act(() => apply(button.dataset.value!));
  });
}

/** Время ближайшего события (повтор не дальше часа) — без даты, даже если оно уже завтра */
function formatTimeOnly(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${time}`;
}

bypassToggle.addEventListener('change', () =>
  void act(() => (bypassToggle.checked ? trayApi.startBypass() : trayApi.stopBypass()))
);
tgToggle.addEventListener('change', () => void act(() => (tgToggle.checked ? trayApi.tgwsStart() : trayApi.tgwsStop())));
vpnToggle.addEventListener('change', () =>
  void act(() => (vpnToggle.checked ? trayApi.vpnConnect() : trayApi.vpnDisconnect()))
);
bindSeg(ipsetSeg, (value) => trayApi.setIpsetMode(value as IpsetMode));
bindSeg(gameSeg, (value) => trayApi.setGameFilter(value as GameFilter));
repairBtn.addEventListener('click', () => {
  repairText.textContent = 'Восстанавливаю обход…';
  repairBtn.classList.add('hidden');
  void act(() => trayApi.recoverBypassNow());
});
$('tpOpen').addEventListener('click', () => void trayApi.showMainWindow());
$('tpSettings').addEventListener('click', () => void trayApi.showMainWindow('settings'));
// сторож сменил состояние или конфиг — не ждём следующего опроса
trayApi.onBypassActivityChanged(() => {
  if (!document.hidden) void refresh();
});

checkBtn.addEventListener('click', () => {
  void (async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = 'Проверяем…';
    document.querySelectorAll<HTMLElement>('#tpAccess [data-service]').forEach((el) => (el.className = 'is-checking'));
    try {
      for (const result of await trayApi.checkAccess()) {
        const el = document.querySelector<HTMLElement>(`#tpAccess [data-service="${result.id}"]`);
        if (!el) continue;
        el.className = `is-${result.status}`;
        el.title = result.detail;
      }
    } catch (err) {
      showError(err);
    } finally {
      checkBtn.disabled = false;
      checkBtn.textContent = 'Проверить доступ';
    }
  })();
});

function startPolling(): void {
  void refresh();
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => void refresh(), 3000);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
  } else {
    startPolling();
  }
});
// Каждое открытие — короткая анимация появления; сигнал приходит до того, как окно станет видимым
trayApi.onTrayReveal(() => {
  document.body.classList.remove('reveal');
  void document.body.offsetWidth;
  document.body.classList.add('reveal');
  startPolling();
});
startPolling();

// Окно подстраивается под содержимое — без пустоты внизу, когда чинить нечего
let reportedHeight = 0;
new ResizeObserver(() => {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height === reportedHeight) return;
  reportedHeight = height;
  trayApi.reportTrayHeight(height);
}).observe(document.body);

export {};
