import { spawn } from 'child_process';
import { probeTgwsProxy } from './tgws/selftest';
import type { TgwsProxyConfig } from './tgws-proxy';

export type AccessStatus = 'ok' | 'partial' | 'fail';

export interface AccessResult {
  id: 'discord' | 'youtube' | 'telegram';
  name: string;
  status: AccessStatus;
  ms: number | null;
  detail: string;
}

interface Endpoint {
  label: string;
  url: string;
}

const SERVICES: Array<{ id: 'discord' | 'youtube'; name: string; endpoints: Endpoint[] }> = [
  {
    id: 'discord',
    name: 'Discord',
    endpoints: [
      { label: 'сайт', url: 'https://discord.com' },
      { label: 'gateway', url: 'https://gateway.discord.gg' },
      { label: 'медиа', url: 'https://cdn.discordapp.com' },
    ],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    endpoints: [
      { label: 'сайт', url: 'https://www.youtube.com' },
      { label: 'видео', url: 'https://redirector.googlevideo.com' },
      { label: 'превью', url: 'https://i.ytimg.com' },
    ],
  },
];

/** Любой HTTP-ответ значит, что DPI пропустил TLS-соединение. */
function curlProbe(url: string): Promise<{ ok: boolean; ms: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      'curl.exe',
      ['-I', '-s', '-o', 'NUL', '--connect-timeout', '5', '-m', '8', '-w', '%{http_code} %{time_total}', url],
      { windowsHide: true }
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve({ ok: false, ms: 0 }));
    child.on('close', () => {
      const [code, total] = out.trim().split(' ');
      const ok = /^[1-5]\d\d$/.test(code ?? '') && code !== '000';
      resolve({ ok, ms: Math.round(parseFloat(total ?? '0') * 1000) });
    });
  });
}

function summarize(oks: boolean[]): AccessStatus {
  if (oks.every(Boolean)) return 'ok';
  return oks.some(Boolean) ? 'partial' : 'fail';
}

async function checkHttpService(service: (typeof SERVICES)[number]): Promise<AccessResult> {
  const results = await Promise.all(service.endpoints.map((endpoint) => curlProbe(endpoint.url)));
  const status = summarize(results.map((r) => r.ok));
  const okMs = results.filter((r) => r.ok).map((r) => r.ms);
  const failed = service.endpoints.filter((_, i) => !results[i].ok).map((e) => e.label);
  return {
    id: service.id,
    name: service.name,
    status,
    ms: okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null,
    detail: status === 'ok' ? 'всё открывается' : `не открылось: ${failed.join(', ')}`,
  };
}

async function checkTelegram(proxy: { running: boolean; config: TgwsProxyConfig }): Promise<AccessResult> {
  if (proxy.running) {
    const host = proxy.config.host === '0.0.0.0' ? '127.0.0.1' : proxy.config.host;
    const probe = await probeTgwsProxy(host, proxy.config.port, proxy.config.secretHex);
    return {
      id: 'telegram',
      name: 'Telegram',
      status: probe.ok ? 'ok' : 'fail',
      ms: probe.ok ? probe.ms : null,
      detail: probe.ok ? 'через прокси работает' : `прокси: ${probe.error ?? 'ошибка'}`,
    };
  }
  const direct = await curlProbe('https://web.telegram.org');
  return {
    id: 'telegram',
    name: 'Telegram',
    status: direct.ok ? 'partial' : 'fail',
    ms: direct.ok ? direct.ms : null,
    detail: direct.ok ? 'прокси выключен, веб-версия открывается' : 'прокси выключен, веб-версия недоступна',
  };
}

export async function checkAccess(proxy: { running: boolean; config: TgwsProxyConfig }): Promise<AccessResult[]> {
  return Promise.all([...SERVICES.map(checkHttpService), checkTelegram(proxy)]);
}
