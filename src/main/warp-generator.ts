import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { amneziaVpn, secureDirectory, SKVOZ_PROGRAM_DATA, type VpnConfigSummary } from './amneziawg';
import { runHidden } from './exec';
import { downloadVerified, fetchLatestAsset } from './github-release';
import { httpFetch } from './http';
import { compareVersions } from './version-utils';

/**
 * Бесплатный VPN на Cloudflare WARP с маскировкой AmneziaWG.
 *
 * Параметры маскировки и способ регистрации — из github.com/ImMALWARE/bash-warp-generator:
 * Skvoz периодически читает оттуда актуальные значения (только данные, код не выполняется).
 * Запасной способ регистрации — wgcf (github.com/ViRb3/wgcf), он сам обновляется с GitHub.
 */

export const WARP_ENDPOINTS = [
  { value: '162.159.192.1:500', label: '162.159.192.1:500' },
  { value: '162.159.192.1:4500', label: '162.159.192.1:4500' },
  { value: '162.159.195.1:2408', label: '162.159.195.1:2408' },
  { value: 'engage.cloudflareclient.com:2408', label: 'engage.cloudflareclient.com:2408' },
] as const;

export type WarpPreset = 'quic' | 'light';

export interface WarpCandidate {
  endpoint: string;
  preset: WarpPreset;
}

export interface WarpGenerateOptions {
  endpoint: string | 'auto';
  preset: WarpPreset | 'auto';
}

export interface WarpGenerateResult {
  summary: VpnConfigSummary;
  candidate: WarpCandidate;
  connected: boolean;
}

export type WarpProgress = (text: string) => void;

interface WarpAccount {
  privateKey: string;
  address: string;
  publicKey: string;
}

const PRESET_LABELS: Record<WarpPreset, string> = { quic: 'усиленная маскировка', light: 'лёгкая маскировка' };
const HANDSHAKE_TIMEOUT_MS = 12_000;
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

// ── Актуальные параметры из bash-warp-generator ─────────────────────────────

const UPSTREAM_URL = 'https://raw.githubusercontent.com/ImMALWARE/bash-warp-generator/HEAD/warp_generator.sh';
const UPSTREAM_CACHE = path.join(app.getPath('userData'), 'warp-upstream.json');

/** Всё, что меняется у Cloudflare и в способах обхода, — в одном месте. */
export interface WarpParams {
  api: string;
  obfuscation: Array<[string, string]>;
  i1: string | null;
  mtu: string;
  dns: string;
  endpoint: string;
}

// Значения на момент сборки — если GitHub недоступен и кэша ещё нет
const BUILTIN_PARAMS: WarpParams = {
  api: 'https://api.cloudflareclient.com/v0i1909051800',
  obfuscation: [
    ['S1', '0'],
    ['S2', '0'],
    ['Jc', '120'],
    ['Jmin', '23'],
    ['Jmax', '911'],
    ['H1', '1'],
    ['H2', '2'],
    ['H3', '3'],
    ['H4', '4'],
  ],
  // Пакет-приманка в виде QUIC Initial: DPI видит «обычный QUIC» перед рукопожатием WireGuard
  i1: '<b 0xc2000000011419fa4bb3599f336777de79f81ca9a8d80d91eeec000044c635cef024a885dcb66d1420a91a8c427e87d6cf8e08b563932f449412cddf77d3e2594ea1c7a183c238a89e9adb7ffa57c133e55c59bec101634db90afb83f75b19fe703179e26a31902324c73f82d9354e1ed8da39af610afcb27e6590a44341a0828e5a3d2f0e0f7b0945d7bf3402feea0ee6332e19bdf48ffc387a97227aa97b205a485d282cd66d1c384bafd63dc42f822c4df2109db5b5646c458236ddcc01ae1c493482128bc0830c9e1233f0027a0d262f92b49d9d8abd9a9e0341f6e1214761043c021d7aa8c464b9d865f5fbe234e49626e00712031703a3e23ef82975f014ee1e1dc428521dc23ce7c6c13663b19906240b3efe403cf30559d798871557e4e60e86c29ea4504ed4d9bb8b549d0e8acd6c334c39bb8fb42ede68fb2aadf00cfc8bcc12df03602bbd4fe701d64a39f7ced112951a83b1dbbe6cd696dd3f15985c1b9fef72fa8d0319708b633cc4681910843ce753fac596ed9945d8b839aeff8d3bf0449197bd0bb22ab8efd5d63eb4a95db8d3ffc796ed5bcf2f4a136a8a36c7a0c65270d511aebac733e61d414050088a1c3d868fb52bc7e57d3d9fd132d78b740a6ecdc6c24936e92c28672dbe00928d89b891865f885aeb4c4996d50c2bbbb7a99ab5de02ac89b3308e57bcecf13f2da0333d1420e18b66b4c23d625d836b538fc0c221d6bd7f566a31fa292b85be96041d8e0bfe655d5dc1afed23eb8f2b3446561bbee7644325cc98d31cea38b865bdcc507e48c6ebdc7553be7bd6ab963d5a14615c4b81da7081c127c791224853e2d19bafdc0d9f3f3a6de898d14abb0e2bc849917e0a599ed4a541268ad0e60ea4d147dc33d17fa82f22aa505ccb53803a31d10a7ca2fea0b290a52ee92c7bf4aab7cea4e3c07b1989364eed87a3c6ba65188cd349d37ce4eefde9ec43bab4b4dc79e03469c2ad6b902e28e0bbbbf696781ad4edf424ffb35ce0236d373629008f142d04b5e08a124237e03e3149f4cdde92d7fae581a1ac332e26b2c9c1a6bdec5b3a9c7a2a870f7a0c25fc6ce245e029b686e346c6d862ad8df6d9b62474fbc31dbb914711f78074d4441f4e6e9edca3c52315a5c0653856e23f681558d669f4a4e6915bcf42b56ce36cb7dd3983b0b1d6fdf0f8efddb68e7ca0ae9dd4570fe6978fbb524109f6ec957ca61f1767ef74eb803b0f16abd0087cf2d01bc1db1c01d97ac81b3196c934586963fe7cf2d310e0739621e8bd00dc23fded18576d8c8f285d7bb5f43b547af3c76235de8b6f757f817683b2151600b11721219212bf27558edd439e73fce951f61d582320e5f4d6c315c71129b719277fc144bbe8ded25ab6d29b6e189c9bd9b16538faf60cc2aab3c3bb81fc2213657f2dd0ceb9b3b871e1423d8d3e8cc008721ef03b28e0ee7bb66b8f2a2ac01ef88df1f21ed49bf1ce435df31ac34485936172567488812429c269b49ee9e3d99652b51a7a614b7c460bf0d2d64d8349ded7345bedab1ea0a766a8470b1242f38d09f7855a32db39516c2bd4bcc538c52fa3a90c8714d4b006a15d9c7a7d04919a1cab48da7cce0d5de1f9e5f8936cffe469132991c6eb84c5191d1bcf69f70c58d9a7b66846440a9f0eef25ee6ab62715b50ca7bef0bc3013d4b62e1639b5028bdf757454356e9326a4c76dabfb497d451a3a1d2dbd46ec283d255799f72dfe878ae25892e25a2542d3ca9018394d8ca35b53ccd94947a8>',
  mtu: '1280',
  dns: '1.1.1.1, 2606:4700:4700::1111, 1.0.0.1, 2606:4700:4700::1001',
  endpoint: '162.159.192.1:500',
};

// Ограничения AmneziaWG на значения: чужие данные проходят только через эти проверки
const PARAM_RULES: Record<string, (value: number) => boolean> = {
  S1: (v) => v >= 0 && v <= 1132,
  S2: (v) => v >= 0 && v <= 1188,
  Jc: (v) => v >= 0 && v <= 128,
  Jmin: (v) => v >= 0 && v <= 1280,
  Jmax: (v) => v >= 0 && v <= 1280,
  H1: (v) => v >= 1 && v <= 0xffffffff,
  H2: (v) => v >= 1 && v <= 0xffffffff,
  H3: (v) => v >= 1 && v <= 0xffffffff,
  H4: (v) => v >= 1 && v <= 0xffffffff,
};
const I1_PATTERN = /^(?:<(?:b 0x(?:[0-9a-f]{2})+|r \d{1,4}|rc \d{1,4}|rd \d{1,4}|t|c)>)+$/i;
const ENDPOINT_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,}):\d{1,5}$/i;
const DNS_PATTERN = /^[0-9a-f:.]+(?:\s*,\s*[0-9a-f:.]+)*$/i;
const API_PATTERN = /^https:\/\/api\.cloudflareclient\.com\/v0[a-z0-9]+$/i;

/** Разбирает скрипт как текст и забирает из него только проверенные значения. */
export function parseUpstreamScript(raw: string): WarpParams {
  const script = raw.replace(/\r\n?/g, '\n');
  const api = script.match(/^api="([^"]+)"/m)?.[1] ?? '';
  if (!API_PATTERN.test(api)) throw new Error('не найден адрес API');

  const block = script.match(/conf=\$\(cat <<-?EOM\n([\s\S]*?)\nEOM/)?.[1];
  if (!block) throw new Error('не найден шаблон конфига');
  const values = new Map<string, string>();
  for (const line of block.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*=\s*(.+?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }

  const obfuscation: Array<[string, string]> = [];
  for (const [key, valid] of Object.entries(PARAM_RULES)) {
    const raw = values.get(key);
    if (raw === undefined) continue;
    if (!/^\d+$/.test(raw) || !valid(Number(raw))) throw new Error(`недопустимое значение ${key}`);
    obfuscation.push([key, raw]);
  }
  if (!obfuscation.some(([key]) => key === 'Jc')) throw new Error('нет параметров маскировки');

  const i1 = values.get('I1') ?? null;
  if (i1 !== null && !I1_PATTERN.test(i1)) throw new Error('недопустимое значение I1');
  const mtu = values.get('MTU') ?? BUILTIN_PARAMS.mtu;
  if (!/^\d+$/.test(mtu) || Number(mtu) < 1280 || Number(mtu) > 1420) throw new Error('недопустимое значение MTU');
  const dns = values.get('DNS') ?? BUILTIN_PARAMS.dns;
  if (!DNS_PATTERN.test(dns)) throw new Error('недопустимое значение DNS');
  const endpoint = values.get('Endpoint') ?? BUILTIN_PARAMS.endpoint;
  if (!ENDPOINT_PATTERN.test(endpoint)) throw new Error('недопустимый сервер');

  return { api, obfuscation, i1, mtu, dns, endpoint };
}

function readCachedParams(): { fetchedAt: number; params: WarpParams } | null {
  try {
    const cached = JSON.parse(fs.readFileSync(UPSTREAM_CACHE, 'utf8')) as { fetchedAt: number; script: string };
    return { fetchedAt: cached.fetchedAt, params: parseUpstreamScript(cached.script) };
  } catch {
    return null;
  }
}

/** Актуальные параметры: свежие с GitHub, затем кэш, затем встроенные. */
async function loadWarpParams(onProgress: WarpProgress): Promise<WarpParams> {
  const cached = readCachedParams();
  if (cached && Date.now() - cached.fetchedAt < REFRESH_INTERVAL_MS) return cached.params;
  onProgress('Проверяем актуальные параметры маскировки…');
  try {
    const response = await httpFetch(UPSTREAM_URL, { headers: { 'User-Agent': 'zapret-app' }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const script = await response.text();
    const params = parseUpstreamScript(script);
    // Храним исходный текст: при чтении кэша он снова проходит те же проверки
    fs.writeFileSync(UPSTREAM_CACHE, JSON.stringify({ fetchedAt: Date.now(), script }));
    return params;
  } catch {
    return cached?.params ?? BUILTIN_PARAMS;
  }
}

// ── Регистрация, способ 1: напрямую, как в bash-warp-generator ──────────────

class RateLimitedError extends Error {}
/** Запрос не дошёл до Cloudflare: обрыв, таймаут, сброс — так выглядит блокировка РКН */
class NetworkError extends Error {}

/** Открывает путь к API Cloudflare (временно включает обход zapret); возвращает «закрыть» или null */
export type WarpRouteOpener = () => Promise<(() => Promise<void>) | null>;

const RATE_LIMIT_MESSAGE = 'Cloudflare временно ограничил регистрацию (429). Попробуйте через несколько минут или из другой сети';
const BLOCKED_MESSAGE =
  'Cloudflare не отвечает — похоже, РКН блокирует регистрацию WARP. Включите обход zapret и попробуйте снова или создайте конфиг в облаке (подсказка ниже)';

function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const toBase64 = (value: string | undefined): string => Buffer.from(value ?? '', 'base64url').toString('base64');
  return {
    privateKey: toBase64(privateKey.export({ format: 'jwk' }).d),
    publicKey: toBase64(publicKey.export({ format: 'jwk' }).x),
  };
}

async function warpApi<T>(api: string, method: string, route: string, body: unknown, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await httpFetch(`${api}/${route}`, {
      method,
      headers: {
        'User-Agent': 'okhttp/3.12.1',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : String(error));
  }
  if (response.status === 429) throw new RateLimitedError(RATE_LIMIT_MESSAGE);
  if (!response.ok) throw new Error(`Cloudflare ответил HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function registerDirect(params: WarpParams): Promise<WarpAccount> {
  const keys = generateKeyPair();
  const registration = await warpApi<{ result?: { id?: string; token?: string } }>(params.api, 'POST', 'reg', {
    install_id: '',
    tos: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    key: keys.publicKey,
    fcm_token: '',
    type: 'ios',
    locale: 'en_US',
  });
  const id = registration.result?.id;
  const token = registration.result?.token;
  if (!id || !token) throw new Error('Cloudflare не выдал аккаунт');

  const enabled = await warpApi<{
    result?: {
      config?: {
        peers?: Array<{ public_key?: string }>;
        interface?: { addresses?: { v4?: string; v6?: string } };
      };
    };
  }>(params.api, 'PATCH', `reg/${encodeURIComponent(id)}`, { warp_enabled: true }, token);
  const config = enabled.result?.config;
  const peerKey = config?.peers?.[0]?.public_key;
  const v4 = config?.interface?.addresses?.v4;
  const v6 = config?.interface?.addresses?.v6;
  if (!peerKey || !v4) throw new Error('Cloudflare вернул неполный конфиг');
  return { privateKey: keys.privateKey, publicKey: peerKey, address: v6 ? `${v4}, ${v6}` : v4 };
}

// ── Регистрация, способ 2: wgcf со самообновлением ──────────────────────────

const WGCF_REPO = 'ViRb3/wgcf';
const WGCF_ASSET = /^wgcf_[\d.]+_windows_amd64\.exe$/;
const WGCF_DIR = path.join(SKVOZ_PROGRAM_DATA, 'wgcf');
const WGCF_STATE_FILE = path.join(app.getPath('userData'), 'wgcf-update.json');

interface WgcfBinary {
  path: string;
  version: string;
}

function readBinary(dir: string): WgcfBinary | null {
  const exe = path.join(dir, 'wgcf.exe');
  try {
    if (!fs.existsSync(exe)) return null;
    return { path: exe, version: fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() };
  } catch {
    return null;
  }
}

function newestWgcf(): WgcfBinary | null {
  const bundledDir = app.isPackaged
    ? path.join(process.resourcesPath, 'wgcf')
    : path.join(__dirname, '..', '..', 'vendor', 'wgcf');
  const candidates = [readBinary(WGCF_DIR), readBinary(bundledDir)].filter((item): item is WgcfBinary => item !== null);
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] ?? null;
}

function wgcfCheckedAt(): number {
  try {
    return (JSON.parse(fs.readFileSync(WGCF_STATE_FILE, 'utf8')) as { checkedAt?: number }).checkedAt ?? 0;
  } catch {
    return 0;
  }
}

/** Скачивает свежий wgcf, если на GitHub вышла версия новее нашей. Ошибки не мешают генерации. */
async function updateWgcf(onProgress: WarpProgress): Promise<void> {
  try {
    const current = newestWgcf();
    const latest = await fetchLatestAsset(WGCF_REPO, WGCF_ASSET);
    fs.writeFileSync(WGCF_STATE_FILE, JSON.stringify({ checkedAt: Date.now(), latest: latest.version }));
    if (current && compareVersions(latest.version, current.version) <= 0) return;

    onProgress(`Обновляем wgcf до ${latest.version}…`);
    const data = await downloadVerified(latest);
    fs.mkdirSync(WGCF_DIR, { recursive: true });
    await secureDirectory(WGCF_DIR, true);
    const temp = path.join(WGCF_DIR, `wgcf.${process.pid}.tmp`);
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, path.join(WGCF_DIR, 'wgcf.exe'));
    fs.writeFileSync(path.join(WGCF_DIR, 'VERSION'), `${latest.version}\n`);
  } catch {
    /* GitHub недоступен — работаем со встроенной версией */
  }
}

async function resolveWgcf(force: boolean, onProgress: WarpProgress): Promise<WgcfBinary> {
  if (force || Date.now() - wgcfCheckedAt() > REFRESH_INTERVAL_MS) await updateWgcf(onProgress);
  const binary = newestWgcf();
  if (!binary) throw new Error('В этой сборке Skvoz нет wgcf — переустановите приложение');
  return binary;
}

async function runWgcf(exe: string, args: string[], cwd: string): Promise<void> {
  const lines: string[] = [];
  const code = await runHidden(exe, args, { cwd, onLine: (line) => lines.push(line.text), timeoutMs: 60_000 });
  if (code === 0) return;
  const output = lines.join('\n');
  if (/429|too many requests/i.test(output)) throw new RateLimitedError(RATE_LIMIT_MESSAGE);
  if (/no such host|dial tcp|timeout|connection/i.test(output)) {
    throw new NetworkError('Нет связи с Cloudflare');
  }
  const last = lines.filter((line) => !/^\s*\|/.test(line)).slice(-2).join(' ');
  throw new Error(`wgcf не смог получить конфиг${last ? `: ${last}` : ''}`);
}

export function parseWgcfProfile(text: string): WarpAccount {
  const get = (key: string): string => text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'mi'))?.[1] ?? '';
  const account = { privateKey: get('PrivateKey'), address: get('Address'), publicKey: get('PublicKey') };
  if (!account.privateKey || !account.publicKey || !account.address) throw new Error('wgcf вернул неполный профиль WARP');
  return account;
}

async function registerWithWgcf(exe: string): Promise<WarpAccount> {
  // В папке окажется токен аккаунта — после генерации она не нужна и удаляется
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-warp-'));
  try {
    const account = path.join(dir, 'wgcf-account.toml');
    const profile = path.join(dir, 'wgcf-profile.conf');
    await runWgcf(exe, ['register', '--accept-tos', '--config', account], dir);
    await runWgcf(exe, ['generate', '--config', account, '--profile', profile], dir);
    return parseWgcfProfile(fs.readFileSync(profile, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function registerFallback(onProgress: WarpProgress): Promise<WarpAccount> {
  let wgcf = await resolveWgcf(false, onProgress);
  try {
    return await registerWithWgcf(wgcf.path);
  } catch (error) {
    // 429 у wgcf обычно значит, что Cloudflare сменил проверку TLS — пробуем свежую версию
    if (!(error instanceof RateLimitedError)) throw error;
    const before = wgcf.version;
    wgcf = await resolveWgcf(true, onProgress);
    if (wgcf.version === before) throw error;
    onProgress('Повторяем с обновлённым wgcf…');
    return registerWithWgcf(wgcf.path);
  }
}

/**
 * РКН режет запросы к api.cloudflareclient.com. Этот домен есть в списке обхода zapret,
 * поэтому при сетевой ошибке ненадолго включаем обход, повторяем и возвращаем как было.
 */
async function registerWarp(params: WarpParams, onProgress: WarpProgress, openRoute?: WarpRouteOpener): Promise<WarpAccount> {
  onProgress('Регистрируем бесплатный аккаунт Cloudflare WARP…');
  let closeRoute: (() => Promise<void>) | null = null;
  try {
    try {
      return await registerDirect(params);
    } catch (error) {
      if (!(error instanceof NetworkError) || !openRoute) throw error;
      onProgress('Cloudflare недоступен напрямую — включаем обход zapret и пробуем снова…');
      closeRoute = await openRoute();
      if (!closeRoute) throw error;
      return await registerDirect(params);
    }
  } catch (directError) {
    onProgress('Пробуем запасной способ регистрации (wgcf)…');
    try {
      return await registerFallback(onProgress);
    } catch (fallbackError) {
      if (directError instanceof NetworkError || fallbackError instanceof NetworkError) throw new Error(BLOCKED_MESSAGE);
      throw fallbackError;
    }
  } finally {
    if (closeRoute) {
      onProgress('Выключаем обход zapret обратно…');
      await closeRoute().catch(() => undefined);
    }
  }
}

// ── Конфиг и автоподбор ─────────────────────────────────────────────────────

export function buildAmneziaConfig(account: WarpAccount, params: WarpParams, candidate: WarpCandidate): string {
  // «Лёгкая» меняет только мусорные пакеты; S/H должны совпадать с сервером и берутся как есть
  const obfuscation = params.obfuscation.map(([key, value]): [string, string] => {
    if (candidate.preset !== 'light') return [key, value];
    if (key === 'Jc') return [key, '4'];
    if (key === 'Jmin') return [key, '40'];
    if (key === 'Jmax') return [key, '70'];
    return [key, value];
  });
  const lines = [
    '[Interface]',
    `PrivateKey = ${account.privateKey}`,
    ...obfuscation.map(([key, value]) => `${key} = ${value}`),
    `MTU = ${params.mtu}`,
    ...(candidate.preset === 'quic' && params.i1 ? [`I1 = ${params.i1}`] : []),
    `Address = ${account.address}`,
    `DNS = ${params.dns}`,
    '',
    '[Peer]',
    `PublicKey = ${account.publicKey}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    `Endpoint = ${candidate.endpoint}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function buildCandidates(options: WarpGenerateOptions, recommendedEndpoint: string): WarpCandidate[] {
  const known = WARP_ENDPOINTS.map((item) => item.value as string);
  const endpointAuto = options.endpoint === 'auto';
  const presetAuto = options.preset === 'auto';
  if (!endpointAuto && !known.includes(options.endpoint)) throw new Error('Неизвестный сервер WARP');
  if (!presetAuto && options.preset !== 'quic' && options.preset !== 'light') throw new Error('Неизвестный режим маскировки');

  // Рекомендованный сервер из bash-warp-generator идёт первым
  const endpoints = endpointAuto ? [...new Set([recommendedEndpoint, ...known])] : [options.endpoint];
  const presets: WarpPreset[] = presetAuto ? ['quic', 'light'] : [options.preset as WarpPreset];
  if (endpointAuto && presetAuto) {
    // Сначала рекомендованный сервер в обоих режимах, затем остальные с полной маскировкой
    return [
      { endpoint: endpoints[0], preset: 'quic' },
      { endpoint: endpoints[0], preset: 'light' },
      ...endpoints.slice(1).map((endpoint) => ({ endpoint, preset: 'quic' as const })),
    ];
  }
  return endpoints.flatMap((endpoint) => presets.map((preset) => ({ endpoint, preset })));
}

/**
 * Один клик: актуальные параметры → регистрация → перебор серверов до ответа.
 * Аккаунт регистрируется один раз — повторные регистрации быстро упираются в 429.
 */
export async function createWarpVpn(
  options: WarpGenerateOptions,
  onProgress: WarpProgress,
  openRoute?: WarpRouteOpener
): Promise<WarpGenerateResult> {
  const params = await loadWarpParams(onProgress);
  const candidates = buildCandidates(options, params.endpoint);
  const account = await registerWarp(params, onProgress, openRoute);

  let lastError: unknown = null;
  for (const [index, candidate] of candidates.entries()) {
    const step = candidates.length > 1 ? ` (${index + 1} из ${candidates.length})` : '';
    onProgress(`Пробуем ${candidate.endpoint}, ${PRESET_LABELS[candidate.preset]}${step}…`);
    try {
      const summary = await amneziaVpn.importConfig(buildAmneziaConfig(account, params, candidate));
      await amneziaVpn.connect();
      if (await amneziaVpn.waitForHandshake(HANDSHAKE_TIMEOUT_MS)) {
        return { summary, candidate, connected: true };
      }
      lastError = new Error(`${candidate.endpoint} не ответил`);
    } catch (error) {
      lastError = error;
    }
  }

  // Ни один вариант не ответил: выключаем, иначе туннель без ответа блокирует весь интернет
  await amneziaVpn.disconnect().catch(() => undefined);
  const summary = await amneziaVpn.importConfig(buildAmneziaConfig(account, params, candidates[0]));
  const reason = lastError instanceof Error ? ` Последняя ошибка: ${lastError.message}` : '';
  throw new Error(
    `Серверы WARP не ответили — похоже, провайдер их блокирует. Конфиг сохранён (${summary.endpoint}), можно попробовать позже.${reason}`
  );
}
