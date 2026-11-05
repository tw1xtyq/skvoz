import { app, net } from 'electron';
import fs from 'fs';
import { pipeline } from 'stream/promises';

const DEFAULT_TIMEOUT_MS = 20_000;
const DOWNLOAD_STALL_MS = 45_000;
const DOWNLOAD_ATTEMPTS = 3;

/**
 * Все запросы приложения идут через сеть Chromium, а не через fetch из Node:
 * Node не видит системный прокси и хранилище сертификатов Windows, поэтому у тех,
 * кто сидит за прокси или за антивирусом с проверкой HTTPS, падал любой запрос.
 * До готовности Electron и в тестах остаётся обычный fetch.
 */
export function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const options: RequestInit = { cache: 'no-store', signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS), ...init };
  return app?.isReady() ? net.fetch(url, options) : fetch(url, options);
}

/** Переводит сетевую ошибку на понятный язык; исходный код оставляет для отчёта. */
export function describeNetworkError(error: unknown, host = 'GitHub'): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  const text = [name, message, typeof cause === 'string' ? cause : ''].join(' ');
  const code = text.match(/net::ERR_\w+|\bE[A-Z]{4,}\b|\b[A-Z_]*CERT[A-Z_]*\b|HTTP \d{3}/)?.[0];
  const explain = (reason: string): string => (code ? `${reason} (${code})` : reason);

  if (/ERR_INTERNET_DISCONNECTED/.test(text)) return explain('нет подключения к интернету');
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(text)) {
    return explain(`не удалось найти адрес ${host} — проверьте интернет и DNS`);
  }
  if (/ERR_CERT|CERT_|SELF_SIGNED/.test(text)) {
    return explain(`сертификат ${host} не прошёл проверку — проверьте дату и время на компьютере и проверку HTTPS в антивирусе`);
  }
  if (/ERR_PROXY|ERR_TUNNEL/.test(text)) return explain('не удалось подключиться через прокси — проверьте его настройки в Windows');
  if (/HTTP (403|429)/.test(text)) return explain(`${host} временно ограничил запросы с вашего IP — повторите через час или из другой сети`);
  if (/EPERM|EACCES|EBUSY/.test(text)) return explain('файл заблокирован — проверьте антивирус и повторите');
  if (/ENOSPC/.test(text)) return explain('на диске нет места');
  if (/TimeoutError|AbortError|Timeout:|ERR_TIMED_OUT|ERR_CONNECTION|ERR_NETWORK|ERR_SSL|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed/.test(text)) {
    return explain(`${host} не отвечает — похоже, он заблокирован у вашего провайдера`);
  }
  return message;
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  onData?: (downloaded: number, total: number) => void;
  onRetry?: (attempt: number, attempts: number) => void;
  stallMs?: number;
  retryDelayMs?: number;
}

async function downloadOnce(url: string, dest: string, options: DownloadOptions): Promise<void> {
  const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS;
  const controller = new AbortController();
  let stallTimer = setTimeout(() => controller.abort(), stallMs);
  const bump = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), stallMs);
  };

  try {
    const response = await httpFetch(url, { headers: options.headers, redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    const total = parseInt(response.headers.get('content-length') ?? '0', 10);
    const reader = response.body.getReader();
    let downloaded = 0;

    // pipeline сам держит ошибки записи: без него отказ диска или антивируса ронял всё приложение
    await pipeline(async function* () {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        bump();
        downloaded += value.length;
        options.onData?.(downloaded, total);
        yield Buffer.from(value);
      }
    }, fs.createWriteStream(dest));

    if (total > 0 && downloaded !== total) {
      throw new Error(`файл скачан не полностью (${downloaded} из ${total} байт)`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timeout: нет данных ${Math.round(stallMs / 1000)} секунд`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    controller.abort();
  }
}

/** Качает файл с повторами; соединение без данных считается зависшим и рвётся. */
export async function downloadWithRetry(url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await downloadOnce(url, dest, options);
      return;
    } catch (error) {
      lastError = error;
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* файл держит антивирус — следующая попытка перезапишет его */
      }
      if (attempt < DOWNLOAD_ATTEMPTS) {
        options.onRetry?.(attempt + 1, DOWNLOAD_ATTEMPTS);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  throw lastError;
}
