// Мини-окно у значка в трее: быстрые переключатели без открытия основного окна.

interface TrayApi {
  getDashboardState(options?: { light?: boolean }): Promise<{
    config: { selectedStrategy: string | null };
    status: { pathsValid: boolean; bypass: { running: boolean }; selectedStrategy: string | null };
  }>;
  startBypass(): Promise<unknown>;
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
  getBypassActivity(): Promise<{ health: Health; healthLabel: string; network: string; since: { at: number } | null }>;
  onBypassActivityChanged(callback: () => void): () => void;
  showMainWindow(view?: string): Promise<unknown>;
  onTrayReveal(callback: () => void): () => void;
}

type Health = 'off' | 'checking' | 'ok' | 'degraded' | 'recovering' | 'down';

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

    const metaParts = [activity.network === 'Неизвестная сеть' ? '' : activity.network];
    if (running && activity.since) metaParts.push(`обход работает с ${formatClock(activity.since.at)}`);
    meta.textContent = metaParts.filter(Boolean).join(' · ');
    meta.classList.toggle('hidden', !meta.textContent);

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

async function act(fn: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  errorEl.classList.add('hidden');
  bypassToggle.disabled = true;
  tgToggle.disabled = true;
  vpnToggle.disabled = true;
  try {
    await fn();
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    // refresh снова заблокирует недоступное; если он упадёт — переключатели не залипнут
    bypassToggle.disabled = false;
    tgToggle.disabled = false;
    vpnToggle.disabled = false;
    await refresh();
  }
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

export {};
