export type AppTheme = 'dark' | 'light';

const STORAGE_KEY = 'zapret-theme';

export function getAppliedTheme(): AppTheme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }

  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.classList.toggle('is-light', theme === 'light');
    toggle.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    toggle.setAttribute('aria-label', theme === 'light' ? 'Тёмная тема' : 'Светлая тема');
  }
}
