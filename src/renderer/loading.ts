export type LoadStage = 'fetch' | 'download' | 'extract' | 'install' | 'scan' | 'done' | 'error' | 'generic';

export interface LoadProgressInput {
  visible: boolean;
  percent?: number;
  message?: string;
  title?: string;
  stage?: LoadStage;
  indeterminate?: boolean;
  /** false — показать прогресс, не запрещая клики (фоновые загрузки) */
  blocking?: boolean;
}

export interface InlineProgressInput {
  visible: boolean;
  percent?: number;
  label?: string;
}

interface LoadingDom {
  progressWrap: HTMLElement;
  progressFill: HTMLElement;
  progressText: HTMLElement;
  progressTitle: HTMLElement;
  progressPct: HTMLElement;
  progressStages: HTMLElement;
  statusBadge: HTMLElement;
  statusText: HTMLElement;
  heroLoader: HTMLElement;
  heroLogoWrap: HTMLElement;
  btnToggle: HTMLElement;
  powerSpinner: HTMLElement;
  testProgressWrap: HTMLElement;
  testProgressBar: HTMLElement;
  testProgressText: HTMLElement;
  testProgressPct: HTMLElement;
  strategyPickProgressWrap: HTMLElement;
  strategyPickProgressBar: HTMLElement;
  strategyPickProgressText: HTMLElement;
  strategyPickProgressPct: HTMLElement;
  strategyPickSpinner: HTMLElement;
}

const STAGE_ORDER: LoadStage[] = ['fetch', 'download', 'extract', 'install'];
const STAGE_SHORT: Record<LoadStage, string> = {
  fetch: 'GitHub',
  download: 'Скачивание',
  extract: 'Распаковка',
  install: 'Установка',
  scan: 'Поиск',
  done: 'Готово',
  error: 'Ошибка',
  generic: 'Процесс',
};

let dom: LoadingDom | null = null;
let globalVisible = false;
let statusLoading = false;
let actionBusy = false;
let hideTimer: number | null = null;

export function initLoading(elements: LoadingDom): void {
  dom = elements;
  renderStagePills();
}

function requireDom(): LoadingDom {
  if (!dom) throw new Error('Loading UI not initialized');
  return dom;
}

function renderStagePills(): void {
  const root = requireDom().progressStages;
  root.innerHTML = '';
  for (const stage of STAGE_ORDER) {
    const pill = document.createElement('span');
    pill.className = 'load-stage';
    pill.dataset.stage = stage;
    pill.textContent = STAGE_SHORT[stage];
    root.appendChild(pill);
  }
}

function clampPercent(value: number | undefined, indeterminate: boolean): number {
  if (indeterminate) return 0;
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function updateStagePills(stage: LoadStage | undefined, percent: number, indeterminate: boolean): void {
  const root = requireDom().progressStages;
  const pills = root.querySelectorAll<HTMLElement>('.load-stage');
  const activeIndex =
    stage === 'scan'
      ? -1
      : stage && STAGE_ORDER.includes(stage)
        ? STAGE_ORDER.indexOf(stage)
        : indeterminate
          ? -1
          : percent >= 100
            ? STAGE_ORDER.length
            : Math.min(STAGE_ORDER.length - 1, Math.floor((percent / 100) * STAGE_ORDER.length));

  pills.forEach((pill, index) => {
    pill.classList.toggle('is-done', activeIndex >= 0 && index < activeIndex);
    pill.classList.toggle('is-active', activeIndex === index);
  });

  root.classList.toggle('is-scanning', stage === 'scan');
}

function resolveDownloadDisplay(
  stage: LoadStage,
  percent: number,
  indeterminateInput: boolean
): { displayPct: number; showIndeterminate: boolean; showDots: boolean } {
  if (stage === 'done') {
    return { displayPct: 100, showIndeterminate: false, showDots: false };
  }
  if (stage === 'error') {
    return { displayPct: Math.max(percent, 5), showIndeterminate: false, showDots: false };
  }
  if (stage === 'scan' || indeterminateInput) {
    return { displayPct: 12, showIndeterminate: true, showDots: true };
  }

  switch (stage) {
    case 'fetch':
      return {
        displayPct: percent > 0 ? 14 : 8,
        showIndeterminate: percent === 0,
        showDots: percent === 0,
      };
    case 'download': {
      const mapped = 18 + Math.round(clampPercent(percent, false) * 0.52);
      return { displayPct: mapped, showIndeterminate: false, showDots: false };
    }
    case 'extract':
      if (percent >= 100) {
        return { displayPct: 78, showIndeterminate: false, showDots: false };
      }
      return { displayPct: 72, showIndeterminate: true, showDots: true };
    case 'install':
      if (percent >= 100) {
        return { displayPct: 100, showIndeterminate: false, showDots: false };
      }
      if (percent > 0) {
        const mapped = 82 + Math.round(clampPercent(percent, false) * 0.17);
        return { displayPct: mapped, showIndeterminate: false, showDots: false };
      }
      return { displayPct: 88, showIndeterminate: true, showDots: true };
    default:
      return {
        displayPct: clampPercent(percent, false),
        showIndeterminate: percent === 0,
        showDots: percent === 0,
      };
  }
}

export function setGlobalLoad(input: LoadProgressInput): void {
  const els = requireDom();

  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  if (!input.visible) {
    els.progressWrap.classList.add('is-hiding');
    hideTimer = window.setTimeout(() => {
      els.progressWrap.classList.add('hidden');
      els.progressWrap.classList.remove('is-open', 'is-hiding', 'is-indeterminate', 'is-error', 'is-done');
      document.body.classList.remove('global-load-active');
      globalVisible = false;
      hideTimer = null;
    }, 280);
    return;
  }

  const stage = input.stage ?? 'generic';
  globalVisible = true;
  // Ошибка и «готово» — уже не процесс: блокировать интерфейс под ними нельзя,
  // иначе после неудачной загрузки ничего не нажимается
  const blocking = input.blocking !== false && stage !== 'error' && stage !== 'done';
  document.body.classList.toggle('global-load-active', blocking);
  els.progressWrap.classList.remove('hidden', 'is-hiding', 'is-done', 'is-error');
  requestAnimationFrame(() => els.progressWrap.classList.add('is-open'));

  const rawIndeterminate = !!input.indeterminate || input.stage === 'scan';
  const rawPct = clampPercent(input.percent, rawIndeterminate);
  const display = resolveDownloadDisplay(stage, rawPct, rawIndeterminate);

  els.progressTitle.textContent = input.title ?? (stage === 'scan' ? 'Поиск zapret' : 'Загрузка zapret');
  els.progressText.textContent = input.message ?? 'Подождите...';
  els.progressPct.textContent = display.showDots ? '···' : `${display.displayPct}%`;
  els.progressFill.style.width = `${display.displayPct}%`;
  els.progressWrap.classList.toggle('is-indeterminate', display.showIndeterminate);
  els.progressWrap.classList.toggle('is-done', stage === 'done');
  els.progressWrap.classList.toggle('is-error', stage === 'error');
  if (stage === 'extract' || stage === 'install' || stage === 'fetch') {
    els.progressWrap.dataset.stage = stage;
  } else {
    delete els.progressWrap.dataset.stage;
  }

  updateStagePills(stage, display.displayPct, display.showIndeterminate);
}

export function setHeroLoading(active: boolean): void {
  const els = requireDom();
  els.heroLoader.classList.toggle('hidden', !active);
  els.heroLogoWrap.classList.toggle('is-loading', active);
}

export function setStatusLoading(active: boolean, text = 'Загрузка...'): void {
  const els = requireDom();
  statusLoading = active;
  els.statusBadge.classList.toggle('is-loading', active);
  if (active) {
    els.statusText.textContent = text;
  }
}

export function setActionBusy(active: boolean): void {
  const els = requireDom();
  actionBusy = active;
  els.btnToggle.classList.toggle('is-busy', active);
  els.powerSpinner.classList.toggle('hidden', !active);
  if (active) {
    els.statusBadge.classList.add('is-loading');
  } else if (!statusLoading && !globalVisible) {
    els.statusBadge.classList.remove('is-loading');
  }
}

export function isUiLoading(): boolean {
  return globalVisible || statusLoading || actionBusy;
}

export function setInlineTestProgress(input: InlineProgressInput): void {
  const els = requireDom();
  if (!input.visible) {
    els.testProgressWrap.classList.add('hidden');
    els.testProgressWrap.classList.remove('is-open');
    return;
  }

  const pct = clampPercent(input.percent, false);
  els.testProgressWrap.classList.remove('hidden');
  els.testProgressWrap.classList.add('is-open');
  els.testProgressBar.style.width = `${pct}%`;
  els.testProgressText.textContent = input.label ?? 'Проверка...';
  els.testProgressPct.textContent = `${pct}%`;
}

export function setPickProgress(input: InlineProgressInput): void {
  const els = requireDom();
  const wrap = els.strategyPickProgressWrap;
  const pct = clampPercent(input.percent, false);

  if (!input.visible) {
    wrap.classList.remove('is-open', 'is-preparing');
    els.strategyPickSpinner.classList.remove('hidden');
    return;
  }

  wrap.classList.add('is-open');
  wrap.classList.toggle('is-preparing', pct <= 0);
  els.strategyPickSpinner.classList.toggle('hidden', pct > 8);
  els.strategyPickProgressBar.style.width = pct > 0 ? `${pct}%` : '36%';
  els.strategyPickProgressText.textContent = input.label ?? 'Подготовка...';
  els.strategyPickProgressPct.textContent = pct > 0 ? `${pct}%` : '···';
}

export function mapDownloadStage(stage: string): LoadStage {
  if (stage === 'fetch' || stage === 'download' || stage === 'extract' || stage === 'install') {
    return stage;
  }
  if (stage === 'done') return 'done';
  if (stage === 'error') return 'error';
  return 'generic';
}
