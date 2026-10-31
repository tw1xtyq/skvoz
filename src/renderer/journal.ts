export type JournalLevel = 'info' | 'success' | 'warn' | 'error';

let lineCount = 0;

function journalEl(): HTMLElement | null {
  return document.getElementById('log');
}

function journalPanel(): HTMLElement | null {
  return document.getElementById('logPanel');
}

export function setJournalTitle(title: string): void {
  const el = document.getElementById('journalTitle');
  if (el) el.textContent = title;
}

export function setJournalStatus(text: string): void {
  const el = document.getElementById('journalStatus');
  if (el) el.textContent = text;
}

export function clearJournal(): void {
  const root = journalEl();
  if (root) root.innerHTML = '';
  lineCount = 0;
  setJournalStatus('');
}

const COLLAPSED_KEY = 'zapret-journal-collapsed';

export function setJournalCollapsed(collapsed: boolean): void {
  const panel = journalPanel();
  const toggle = document.getElementById('btnToggleJournal') as HTMLButtonElement | null;
  if (panel) panel.classList.toggle('collapsed', collapsed);
  toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function isJournalCollapsed(): boolean {
  return journalPanel()?.classList.contains('collapsed') ?? false;
}

export function restoreJournalCollapsed(): void {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    /* ignore */
  }
  setJournalCollapsed(collapsed);
}

export function focusJournal(expanded = true): void {
  const panel = journalPanel();
  const body = journalEl();
  if (expanded) setJournalCollapsed(false);
  if (panel) panel.classList.toggle('focused', expanded);
  if (body) body.classList.toggle('expanded', expanded);
}

const MAX_JOURNAL_LINES = 200;

export function appendJournalLine(text: string, level: JournalLevel = 'info'): void {
  const root = journalEl();
  if (!root) return;

  while (root.childElementCount >= MAX_JOURNAL_LINES) {
    root.firstElementChild?.remove();
  }

  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const badge = document.createElement('span');
  badge.className = `log-badge log-badge-${level}`;
  badge.textContent = level === 'success' ? '✓' : level === 'error' ? '!' : level === 'warn' ? '!' : '·';
  badge.setAttribute('aria-label', level === 'success' ? 'Успех' : level === 'error' ? 'Ошибка' : level === 'warn' ? 'Внимание' : 'Информация');

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = text;

  entry.append(time, badge, msg);
  root.appendChild(entry);
  lineCount += 1;
  if (level === 'warn' || level === 'error') {
    setJournalCollapsed(false);
  }
  if (lineCount <= 8) {
    requestAnimationFrame(() => {
      entry.style.animationDelay = `${Math.min(lineCount * 0.02, 0.2)}s`;
    });
  } else {
    entry.style.animation = 'none';
  }
  root.scrollTop = root.scrollHeight;
}

export async function copyJournal(): Promise<boolean> {
  const root = journalEl();
  if (!root) return false;
  const text = Array.from(root.querySelectorAll('.log-entry'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
