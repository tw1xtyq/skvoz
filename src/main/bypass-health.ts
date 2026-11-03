import { spawn } from 'child_process';

// Открываются и без обхода — по ним отличаем «нет интернета» от «обход сломался»
const CONTROL_URLS = [
  'https://www.google.com/generate_204',
  'https://cloudflare.com/cdn-cgi/trace',
];

export type BypassProbeResult = 'ok' | 'blocked' | 'offline';

const PROBE_TARGET_PATTERN = /youtube|discord/i;

/** Домен или адрес из настроек → https-URL; мусор отбрасываем */
export function normalizeProbeSite(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Свои сайты из настроек, иначе по одной цели YouTube и Discord из targets.txt.
 * Цели, которые у конфига не открывались и при подборе, пропускаем — иначе сторож
 * будет переключать его без конца.
 */
export function pickProbeUrls(
  targets: { name: string; url?: string }[],
  failedTargets: string[],
  customSites: string[] = []
): string[] {
  const custom = customSites.map(normalizeProbeSite).filter((url): url is string => !!url);
  if (custom.length > 0) return [...new Set(custom)].slice(0, 5);

  const failed = new Set(failedTargets);
  const seenKinds = new Set<string>();
  const urls: string[] = [];
  for (const target of targets) {
    if (!target.url || failed.has(target.name)) continue;
    const kind = target.name.match(PROBE_TARGET_PATTERN)?.[0].toLowerCase();
    if (!kind || seenKinds.has(kind)) continue;
    seenKinds.add(kind);
    urls.push(target.url);
  }
  return urls;
}

async function probeBypassReachability(timeoutMs = 4_500): Promise<boolean> {
  for (const url of CONTROL_URLS) {
    const ok = await curlOk(url, timeoutMs, /^[23]\d\d$/, false);
    if (ok) return true;
  }
  return false;
}

/**
 * Проверяет сайты, которым нужен обход. Любой HTTP-ответ значит, что TLS прошёл
 * через DPI; при блокировке curl получает сброс соединения и код 000.
 */
export async function probeBypassTargets(urls: string[], timeoutMs = 5_000): Promise<BypassProbeResult> {
  if (urls.length > 0) {
    const results = await Promise.all(urls.map((url) => curlOk(url, timeoutMs, /^[1-5]\d\d$/, true)));
    if (results.every(Boolean)) return 'ok';
  }
  const online = await probeBypassReachability(timeoutMs);
  if (!online) return 'offline';
  return urls.length > 0 ? 'blocked' : 'ok';
}

/** Столько тела ответа должно прийти, чтобы считать, что соединение не «замёрзло» */
export const PROBE_BODY_BYTES = 32 * 1024;
const CURL_TIMEOUT_EXIT = 28;

/**
 * ТСПУ часто не рвёт TLS, а «замораживает» соединение после первых ~16 КБ: заголовки
 * приходят, а страница и видео — нет. Поэтому тело качаем и смотрим, сколько успело прийти.
 */
export function judgeProbe(
  writeOut: string,
  exitCode: number | null,
  okCode: RegExp,
  needBody: boolean
): boolean {
  const [code = '', sizeRaw = '0'] = writeOut.trim().split(/\s+/);
  if (!okCode.test(code)) return false;
  if (!needBody || exitCode === 0) return true;
  // curl упёрся в -m: нормально, только если данные шли, а не встали на первых килобайтах
  return exitCode === CURL_TIMEOUT_EXIT && Number(sizeRaw) >= PROBE_BODY_BYTES;
}

function curlOk(url: string, timeoutMs: number, okCode: RegExp, needBody: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['-s', '--ssl-no-revoke', '-m', String(Math.max(2, Math.ceil(timeoutMs / 1000)))];
    // большие страницы дальше нужного объёма не качаем — хватит, чтобы увидеть «заморозку»
    if (needBody) args.push('-r', `0-${PROBE_BODY_BYTES * 2 - 1}`);
    else args.push('-I');
    args.push('-o', 'NUL', '-w', '%{http_code} %{size_download}', url);
    const child = spawn('curl.exe', args, { windowsHide: true, shell: false });

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs + 1_500);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(judgeProbe(stdout, exitCode, okCode, needBody));
    });
  });
}
