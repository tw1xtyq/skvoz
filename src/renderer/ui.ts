export type ToastType = 'info' | 'success' | 'error';

export interface UserErrorView {
  title: string;
  message: string;
  hint?: string;
}

const IPC_ERROR_RE = /^Error invoking remote method '[^']+': (?:Error: )?/;

export function formatUserError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(IPC_ERROR_RE, '').replace(/^Error: /, '').trim();
}

export function humanizeError(err: unknown, fallbackTitle = 'Что-то пошло не так'): UserErrorView {
  const raw = formatUserError(err);
  const lower = raw.toLowerCase();

  if (/eperm|eacces|operation not permitted|отказано в доступе|занят другим процессом/i.test(raw)) {
    const fileName = lockedFileName(raw);
    return {
      title: 'Файл занят',
      message: fileName
        ? `Не удалось изменить «${fileName}» — файл используется другим процессом.`
        : 'Windows не даёт изменить файлы zapret, пока они заняты.',
      hint: 'Нажмите «Стоп» в приложении, закройте другие окна zapret и повторите. Если ошибка останется — перезагрузите компьютер.',
    };
  }

  if (/enotempty|ebusy|directory not empty/i.test(raw)) {
    return {
      title: 'Папка занята',
      message: 'Не удалось очистить или удалить папку zapret.',
      hint: 'Остановите обход и повторите операцию через минуту.',
    };
  }

  if (/enoent|not found|не найден/i.test(raw)) {
    return {
      title: 'Не найдено',
      message: raw.length > 180 ? 'Нужный файл или папка не найдены.' : raw,
      hint: 'Проверьте путь к zapret или скачайте сборку заново.',
    };
  }

  if (/timeout|таймаут/i.test(raw)) {
    return {
      title: 'Превышено время ожидания',
      message: 'Операция заняла слишком много времени.',
      hint: 'Проверьте интернет и повторите попытку.',
    };
  }

  if (/admin|администратор|uac|eacces.*winws/i.test(lower)) {
    return {
      title: 'Нужны права администратора',
      message: raw.length > 160 ? 'Для этой операции нужны права администратора.' : raw,
      hint: 'Запустите Skvoz от имени администратора и подтвердите UAC.',
    };
  }

  if (/network|fetch|github|http/i.test(lower)) {
    return {
      title: 'Ошибка сети',
      message: raw.length > 180 ? 'Не удалось связаться с сервером или скачать файлы.' : raw,
      hint: 'Проверьте интернет, VPN и доступ к GitHub.',
    };
  }

  return {
    title: fallbackTitle,
    message: raw || 'Произошла неизвестная ошибка.',
    hint: 'Подробности в журнале.',
  };
}

/**
 * Имя занятого файла из ошибки Node/PowerShell: «EPERM: ..., rename 'C:\a\b' -> 'C:\a\c'».
 * Берём путь в кавычках (у rename — исходный), а не «всё после двоеточия»: из пути
 * с хвостовым «\» раньше получалась одна кавычка.
 */
export function lockedFileName(raw: string): string {
  const quoted = [...raw.matchAll(/'([A-Za-z]:\\[^']*|\\\\[^']+|\/[^']+)'/g)].map((m) => m[1]);
  const bare = raw.match(/([A-Za-z]:\\[^\s'"<>|]*[^\s'"<>|\\.,;:)])/);
  const candidate = quoted[0] ?? bare?.[1] ?? '';
  const name = pathBasename(candidate);
  return /[\p{L}\p{N}]/u.test(name) ? name : '';
}

function pathBasename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

const OVERLAY_CLOSE_MS = 320;

function openOverlay(overlay: HTMLElement): void {
  overlay.classList.remove('hidden', 'is-closing');
  requestAnimationFrame(() => overlay.classList.add('is-open'));
}

function closeOverlay(overlay: HTMLElement, onClosed: () => void): void {
  overlay.classList.remove('is-open');
  overlay.classList.add('is-closing');
  window.setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('is-closing');
    onClosed();
  }, OVERLAY_CLOSE_MS);
}

export function toast(message: string, type: ToastType = 'info'): void {
  const root = document.getElementById('toasts');
  if (!root) return;

  const text = message.trim();
  // Одинаковый тост уже на экране — не плодим копии
  for (const existing of Array.from(root.children) as HTMLElement[]) {
    if (existing.textContent === text && !existing.classList.contains('hide')) return;
  }
  // Не больше 4 одновременно: убираем самый старый
  const alive = Array.from(root.children).filter((node) => !node.classList.contains('hide'));
  if (alive.length >= 4) alive[0].dispatchEvent(new Event('dismiss'));

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = text;
  el.title = text.length > 96 ? `${text}

Нажмите, чтобы закрыть` : 'Нажмите, чтобы закрыть';
  root.appendChild(el);

  const duration = Math.min(5200, Math.max(3200, 2200 + text.length * 18));
  let timer = 0;
  const dismiss = (): void => {
    if (el.classList.contains('hide')) return;
    window.clearTimeout(timer);
    el.classList.remove('show');
    el.classList.add('hide');
    window.setTimeout(() => el.remove(), 320);
  };
  const arm = (ms: number): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(dismiss, ms);
  };

  el.addEventListener('dismiss', dismiss);
  el.addEventListener('click', dismiss);
  el.addEventListener('mouseenter', () => window.clearTimeout(timer));
  el.addEventListener('mouseleave', () => arm(1600));

  requestAnimationFrame(() => el.classList.add('show'));
  arm(duration);
}

export function showErrorModal(err: unknown, fallbackTitle?: string): void {
  const view = humanizeError(err, fallbackTitle);
  showErrorDialog(view);
}

export function showErrorDialog(view: UserErrorView): void {
  const overlay = document.getElementById('errorOverlay');
  const titleEl = document.getElementById('errorTitle');
  const bodyEl = document.getElementById('errorBody');
  const hintEl = document.getElementById('errorHint');
  const closeBtn = document.getElementById('errorClose') as HTMLButtonElement | null;
  if (!overlay || !titleEl || !bodyEl || !hintEl || !closeBtn) return;

  titleEl.textContent = view.title;
  bodyEl.textContent = view.message;
  hintEl.textContent = view.hint ?? '';
  hintEl.classList.toggle('hidden', !view.hint);
  openOverlay(overlay);

  const onClose = () => {
    closeOverlay(overlay, () => {
      closeBtn.removeEventListener('click', onClose);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown);
    });
  };

  const onBackdrop = (event: MouseEvent) => {
    if (event.target === overlay) onClose();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };

  closeBtn.addEventListener('click', onClose);
  overlay.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKeydown);
}

export function confirmModal(title: string, message: string, hint?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const hintEl = document.getElementById('modalHint');
    const okBtn = document.getElementById('modalOk') as HTMLButtonElement | null;
    const cancelBtn = document.getElementById('modalCancel') as HTMLButtonElement | null;
    if (!overlay || !titleEl || !bodyEl || !okBtn || !cancelBtn) {
      resolve(false);
      return;
    }

    titleEl.textContent = title;
    bodyEl.textContent = message;
    if (hintEl) {
      hintEl.textContent = hint ?? '';
      hintEl.classList.toggle('hidden', !hint);
    }
    overlay.classList.remove('hidden');
    openOverlay(overlay);

    const cleanup = (result: boolean) => {
      closeOverlay(overlay, () => {
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKeydown);
        resolve(result);
      });
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (event: MouseEvent) => {
      if (event.target === overlay) cleanup(false);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cleanup(false);
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeydown);
  });
}

export function showInfoModal(title: string, message: string, hint?: string): void {
  const overlay = document.getElementById('infoOverlay');
  const titleEl = document.getElementById('infoTitle');
  const bodyEl = document.getElementById('infoBody');
  const hintEl = document.getElementById('infoHint');
  const closeBtn = document.getElementById('infoClose') as HTMLButtonElement | null;
  if (!overlay || !titleEl || !bodyEl || !closeBtn) return;

  titleEl.textContent = title;
  bodyEl.textContent = message;
  if (hintEl) {
    hintEl.textContent = hint ?? '';
    hintEl.classList.toggle('hidden', !hint);
  }
  openOverlay(overlay);

  const onClose = () => {
    closeOverlay(overlay, () => {
      closeBtn.removeEventListener('click', onClose);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown);
    });
  };

  const onBackdrop = (event: MouseEvent) => {
    if (event.target === overlay) onClose();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };

  closeBtn.addEventListener('click', onClose);
  overlay.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKeydown);
}

export function bindOverlayDismiss(
  overlay: HTMLElement,
  onDismiss: () => void,
  options?: { closeButton?: HTMLElement | null }
): () => void {
  openOverlay(overlay);

  const cleanup = () => {
    closeOverlay(overlay, () => {
      options?.closeButton?.removeEventListener('click', onDismissClick);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown);
      onDismiss();
    });
  };

  const onDismissClick = () => cleanup();
  const onBackdrop = (event: MouseEvent) => {
    if (event.target === overlay) cleanup();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };

  options?.closeButton?.addEventListener('click', onDismissClick);
  overlay.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKeydown);

  return cleanup;
}

export function initUi(): void {
  /* journal controls wired in app.ts */
}
