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
  checkAccess(): Promise<Array<{ id: string; status: 'ok' | 'partial' | 'fail'; detail: string }>>;
  showMainWindow(): Promise<unknown>;
}

const trayApi = (window as unknown as { zapretApi: TrayApi }).zapretApi;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const bypassRow = $('tpBypass');
const bypassText = $('tpBypassText');
const bypassToggle = $<HTMLInputElement>('tpBypassToggle');
const tgRow = $('tpTg');
const tgText = $('tpTgText');
const tgToggle = $<HTMLInputElement>('tpTgToggle');
const summary = $('tpSummary');
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
    const [{ config, status }, tg] = await Promise.all([trayApi.getDashboardState({ light: true }), trayApi.tgwsStatus()]);
    const running = status.bypass.running;
    const strategy = (config.selectedStrategy ?? status.selectedStrategy ?? '').replace(/\.bat$/i, '');
    bypassRow.classList.toggle('is-live', running);
    bypassToggle.checked = running;
    bypassToggle.disabled = !status.pathsValid;
    bypassText.textContent = !status.pathsValid
      ? 'zapret не найден'
      : `${running ? 'Включён' : 'Выключен'}${strategy ? ` · ${strategy}` : ''}`;

    tgRow.classList.toggle('is-live', tg.running);
    tgToggle.checked = tg.running;
    tgText.textContent = tg.running
      ? `${tg.config.host}:${tg.config.port} · ${tg.stats.active} подкл.`
      : 'Выключен';

    const live = Number(running) + Number(tg.running);
    summary.textContent = live === 2 ? 'всё работает' : live === 1 ? 'работает частично' : 'выключено';
    summary.dataset.state = String(live);
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
  try {
    await fn();
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    tgToggle.disabled = false;
    await refresh();
  }
}

bypassToggle.addEventListener('change', () =>
  void act(() => (bypassToggle.checked ? trayApi.startBypass() : trayApi.stopBypass()))
);
tgToggle.addEventListener('change', () => void act(() => (tgToggle.checked ? trayApi.tgwsStart() : trayApi.tgwsStop())));
$('tpOpen').addEventListener('click', () => void trayApi.showMainWindow());

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
window.addEventListener('focus', () => {
  // каждое открытие — короткая анимация появления
  document.body.classList.remove('reveal');
  void document.body.offsetWidth;
  document.body.classList.add('reveal');
  startPolling();
});
startPolling();

export {};
