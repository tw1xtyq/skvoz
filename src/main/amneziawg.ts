import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { assertAdmin } from './admin';
import { runHidden } from './exec';

/**
 * VPN на AmneziaWG без установки клиента: amneziawg.exe, awg.exe и wintun.dll едут внутри Skvoz
 * (scripts/fetch-amneziawg.js), копируются в ProgramData и запускают туннель как службу Windows.
 */

const TUNNEL_NAME = 'SkvozVPN';
const SERVICE_NAME = `AmneziaWGTunnel$${TUNNEL_NAME}`;
const BUNDLE_FILES = ['amneziawg.exe', 'awg.exe', 'wintun.dll', 'VERSION'];

const STORE_FILE = path.join(app.getPath('userData'), 'vpn-config.json');
/** Общая папка для служебных файлов, которые запускаются с правами SYSTEM или администратора. */
export const SKVOZ_PROGRAM_DATA = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Skvoz');
const RUNTIME_DIR = path.join(SKVOZ_PROGRAM_DATA, 'amneziawg');
const CONF_DIR = path.join(RUNTIME_DIR, 'conf');
const CONF_PATH = path.join(CONF_DIR, `${TUNNEL_NAME}.conf`);
const EXE_PATH = path.join(RUNTIME_DIR, 'amneziawg.exe');
const AWG_PATH = path.join(RUNTIME_DIR, 'awg.exe');

// SYSTEM и администраторы — полный доступ, пользователи только запускают; конфиг с ключом им не виден
const SID_SYSTEM = '*S-1-5-18';
const SID_ADMINS = '*S-1-5-32-544';
const SID_USERS = '*S-1-5-32-545';

const OBFUSCATION_KEYS = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5'];

export interface VpnSettings {
  enabled: boolean;
  autostart: boolean;
}

export interface VpnConfigSummary {
  endpoint: string;
  address: string;
  dns: string;
  fullTunnel: boolean;
  obfuscated: boolean;
}

export type VpnServiceState = 'NONE' | 'STOPPED' | 'START_PENDING' | 'STOP_PENDING' | 'RUNNING' | 'UNKNOWN';

export interface VpnState {
  bundled: boolean;
  configured: boolean;
  running: boolean;
  busy: boolean;
  serviceState: VpnServiceState;
  summary: VpnConfigSummary | null;
  autostart: boolean;
  handshakeAgoSec: number | null;
  rxBytes: number;
  txBytes: number;
}

type VpnLogLevel = 'info' | 'success' | 'warn' | 'error';
type LogCallback = (level: VpnLogLevel, message: string) => void;

const DEFAULT_SETTINGS: VpnSettings = { enabled: false, autostart: false };

function bundleDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'amneziawg')
    : path.join(__dirname, '..', '..', 'vendor', 'amneziawg');
}

function readTextQuiet(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function capture(command: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await runHidden(command, args, { onLine: (line) => lines.push(line.text), timeoutMs });
  return { code, out: lines.join('\n') };
}

/** Права на папку: SYSTEM и администраторы — полный доступ, пользователи — только чтение и запуск (или ничего). */
export async function secureDirectory(dir: string, usersCanRead: boolean): Promise<void> {
  const grants = [`${SID_SYSTEM}:(OI)(CI)F`, `${SID_ADMINS}:(OI)(CI)F`];
  if (usersCanRead) grants.push(`${SID_USERS}:(OI)(CI)RX`);
  await capture('icacls.exe', [dir, '/inheritance:r', '/grant:r', ...grants, '/Q']);
}

/** Разбор .conf: проверяем обязательные поля и собираем сводку для интерфейса. */
export function parseVpnConfig(raw: string): { text: string; summary: VpnConfigSummary } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const sections: Array<{ name: string; values: Map<string, string> }> = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[(\w+)\]$/);
    if (header) {
      sections.push({ name: header[1].toLowerCase(), values: new Map() });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0 || sections.length === 0) throw new Error(`Непонятная строка в конфиге: ${line.slice(0, 40)}`);
    sections[sections.length - 1].values.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }

  const iface = sections.find((s) => s.name === 'interface');
  const peers = sections.filter((s) => s.name === 'peer');
  if (!iface) throw new Error('В конфиге нет секции [Interface]');
  if (peers.length === 0) throw new Error('В конфиге нет секции [Peer]');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(iface.values.get('privatekey') ?? '')) {
    throw new Error('В [Interface] нет корректного PrivateKey');
  }
  if (!iface.values.get('address')) throw new Error('В [Interface] нет Address');
  const peer = peers[0].values;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(peer.get('publickey') ?? '')) throw new Error('В [Peer] нет корректного PublicKey');
  if (!peer.get('endpoint')) throw new Error('В [Peer] нет Endpoint');

  const allowed = (peer.get('allowedips') ?? '').split(',').map((s) => s.trim());
  return {
    text: `${text}\n`,
    summary: {
      endpoint: peer.get('endpoint')!,
      address: iface.values.get('address')!,
      dns: iface.values.get('dns') ?? '',
      fullTunnel: allowed.includes('0.0.0.0/0'),
      obfuscated: OBFUSCATION_KEYS.some((key) => iface.values.has(key)),
    },
  };
}

export class AmneziaVpnManager {
  private settings: VpnSettings = { ...DEFAULT_SETTINGS };
  private summary: VpnConfigSummary | null = null;
  private serviceState: VpnServiceState = 'NONE';
  private operation: Promise<unknown> = Promise.resolve();
  private busy = false;
  private logListeners: Set<LogCallback> = new Set();
  private stateListeners: Set<() => void> = new Set();

  constructor() {
    this.loadSettings();
    this.loadSummary();
  }

  private loadSettings(): void {
    try {
      if (fs.existsSync(STORE_FILE)) {
        this.settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as Partial<VpnSettings>) };
      }
    } catch {
      /* keep defaults */
    }
  }

  private saveSettings(): void {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      this.log('error', `Не удалось сохранить настройки VPN: ${err}`);
    }
  }

  private loadSummary(): void {
    const raw = readTextQuiet(CONF_PATH);
    if (!raw) return;
    try {
      this.summary = parseVpnConfig(raw).summary;
    } catch {
      this.summary = null;
    }
  }

  private log(level: VpnLogLevel, message: string): void {
    for (const cb of this.logListeners) cb(level, message);
  }

  private emitState(): void {
    for (const cb of this.stateListeners) cb();
  }

  onLog(cb: LogCallback): () => void {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }

  onStateChange(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  getSettings(): VpnSettings {
    return { ...this.settings };
  }

  setSettings(updates: Partial<VpnSettings>): void {
    if (updates.autostart !== undefined) this.settings.autostart = !!updates.autostart;
    if (updates.enabled !== undefined) this.settings.enabled = !!updates.enabled;
    this.saveSettings();
    this.emitState();
  }

  isBundled(): boolean {
    return BUNDLE_FILES.every((name) => fs.existsSync(path.join(bundleDir(), name)));
  }

  isConfigured(): boolean {
    return this.summary !== null && fs.existsSync(CONF_PATH);
  }

  /** Последнее известное состояние без опроса службы — для меню трея. */
  isRunning(): boolean {
    return this.serviceState === 'RUNNING';
  }

  getSummary(): VpnConfigSummary | null {
    return this.summary ? { ...this.summary } : null;
  }

  /** Операции со службой идут строго по очереди: двойной клик не должен ставить туннель дважды. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operation.then(async () => {
      this.busy = true;
      this.emitState();
      try {
        return await fn();
      } finally {
        this.busy = false;
        this.emitState();
      }
    });
    this.operation = run.catch(() => undefined);
    return run;
  }

  async queryService(): Promise<VpnServiceState> {
    let state: VpnServiceState;
    try {
      const { code, out } = await capture('sc.exe', ['query', SERVICE_NAME]);
      if (code === 1060) state = 'NONE';
      else {
        // sc локализован — опираемся на код и английское имя состояния
        const match = out.match(/:\s*\d\s+(STOPPED|START_PENDING|STOP_PENDING|RUNNING)\b/);
        state = match ? (match[1] as VpnServiceState) : code === 0 ? 'UNKNOWN' : 'NONE';
      }
    } catch {
      state = 'UNKNOWN';
    }
    if (state !== this.serviceState) {
      this.serviceState = state;
      this.emitState();
    }
    return state;
  }

  async getState(): Promise<VpnState> {
    const serviceState = await this.queryService();
    const running = serviceState === 'RUNNING';
    const traffic = running ? await this.readTraffic() : null;
    return {
      bundled: this.isBundled(),
      configured: this.isConfigured(),
      running,
      busy: this.busy,
      serviceState,
      summary: this.getSummary(),
      autostart: this.settings.autostart,
      handshakeAgoSec: traffic?.handshakeAgoSec ?? null,
      rxBytes: traffic?.rx ?? 0,
      txBytes: traffic?.tx ?? 0,
    };
  }

  /** awg show … dump: строка интерфейса, затем пиры (ключ, psk, endpoint, ips, handshake, rx, tx, keepalive). */
  private async readTraffic(): Promise<{ handshakeAgoSec: number | null; rx: number; tx: number } | null> {
    if (!fs.existsSync(AWG_PATH)) return null;
    try {
      const { code, out } = await capture(AWG_PATH, ['show', TUNNEL_NAME, 'dump'], 5_000);
      if (code !== 0) return null;
      let handshake = 0;
      let rx = 0;
      let tx = 0;
      for (const line of out.split('\n').slice(1)) {
        const fields = line.split('\t');
        if (fields.length < 8) continue;
        handshake = Math.max(handshake, Number(fields[4]) || 0);
        rx += Number(fields[5]) || 0;
        tx += Number(fields[6]) || 0;
      }
      return {
        handshakeAgoSec: handshake > 0 ? Math.max(0, Math.round(Date.now() / 1000 - handshake)) : null,
        rx,
        tx,
      };
    } catch {
      return null;
    }
  }

  private async prepareRuntimeDir(): Promise<void> {
    fs.mkdirSync(CONF_DIR, { recursive: true });
    await secureDirectory(RUNTIME_DIR, true);
    await secureDirectory(CONF_DIR, false);
  }

  /** Ждёт ответа сервера: служба может работать, а сервер — молчать (порт закрыт, DPI режет). */
  async waitForHandshake(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const traffic = await this.readTraffic();
      if (traffic?.handshakeAgoSec !== null && traffic?.handshakeAgoSec !== undefined && traffic.handshakeAgoSec < 120) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return false;
  }

  /** Копирует бинарники из сборки, если их нет или версия устарела. Служба при этом должна быть остановлена. */
  private async deployBinaries(): Promise<void> {
    const source = bundleDir();
    if (!this.isBundled()) {
      throw new Error('В этой сборке Skvoz нет файлов AmneziaWG — переустановите приложение');
    }
    await this.prepareRuntimeDir();
    const bundledVersion = readTextQuiet(path.join(source, 'VERSION'))?.trim();
    const deployedVersion = readTextQuiet(path.join(RUNTIME_DIR, 'VERSION'))?.trim();
    const complete = BUNDLE_FILES.every((name) => fs.existsSync(path.join(RUNTIME_DIR, name)));
    if (complete && bundledVersion === deployedVersion) return;
    for (const name of BUNDLE_FILES) {
      fs.copyFileSync(path.join(source, name), path.join(RUNTIME_DIR, name));
    }
    this.log('info', `[VPN] Компоненты AmneziaWG ${bundledVersion ?? ''} подготовлены`);
  }

  /** Сохраняет конфиг; если VPN работал — переподключает уже с новым. */
  importConfig(raw: string): Promise<VpnConfigSummary> {
    assertAdmin();
    const { text, summary } = parseVpnConfig(raw);
    return this.serialize(async () => {
      const state = await this.queryService();
      const wasRunning = state === 'RUNNING' || state === 'START_PENDING';
      if (state !== 'NONE') await this.removeService();
      await this.prepareRuntimeDir();
      fs.writeFileSync(CONF_PATH, text, 'utf8');
      this.summary = summary;
      this.log('success', `[VPN] Конфиг сохранён · сервер ${summary.endpoint}`);
      if (wasRunning) await this.installService();
      return summary;
    });
  }

  /** Текст сохранённого конфига — для экспорта в файл (например, перенести на телефон). */
  readConfigText(): string {
    assertAdmin();
    const text = readTextQuiet(CONF_PATH);
    if (!text) throw new Error('Конфиг VPN ещё не добавлен');
    return text;
  }

  removeConfig(): Promise<void> {
    assertAdmin();
    return this.serialize(async () => {
      if ((await this.queryService()) !== 'NONE') await this.removeService();
      fs.rmSync(CONF_PATH, { force: true });
      this.summary = null;
      this.log('info', '[VPN] Конфиг удалён');
    });
  }

  connect(): Promise<void> {
    assertAdmin();
    return this.serialize(async () => {
      if (!this.isConfigured()) throw new Error('Сначала добавьте конфиг AmneziaWG на странице VPN');
      const state = await this.queryService();
      if (state === 'RUNNING') return;
      // Остановленная служба от прошлого запуска мешает поставить новую
      if (state !== 'NONE') await this.removeService();
      await this.installService();
    });
  }

  disconnect(): Promise<void> {
    return this.serialize(async () => {
      if ((await this.queryService()) === 'NONE') return;
      await this.removeService();
      this.log('info', '[VPN] Отключено');
    });
  }

  /** Подключение с повторами для автозапуска: сразу после входа в Windows сеть может быть ещё не готова. */
  async connectWithRetry(attempts = 3, delayMs = 5_000): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.connect();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async installService(): Promise<void> {
    await this.deployBinaries();
    this.log('info', `[VPN] Подключение к ${this.summary?.endpoint ?? 'серверу'}…`);
    await runHidden(EXE_PATH, ['/installtunnelservice', CONF_PATH], { timeoutMs: 30_000 });
    // AmneziaWG ставит службу на автозапуск с Windows; VPN должен включаться только через Skvoz
    await capture('sc.exe', ['config', SERVICE_NAME, 'start=', 'demand']).catch(() => undefined);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await this.queryService();
      if (state === 'RUNNING') {
        this.log('success', '[VPN] Туннель поднят');
        return;
      }
      if (state === 'STOPPED' || state === 'NONE') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const reason = await this.lastTunnelError();
    await this.removeService().catch(() => undefined);
    throw new Error(reason ? `VPN не запустился: ${reason}` : 'VPN не запустился — проверьте конфиг');
  }

  private async removeService(): Promise<void> {
    if (fs.existsSync(EXE_PATH)) {
      await capture(EXE_PATH, ['/uninstalltunnelservice', TUNNEL_NAME], 20_000).catch(() => undefined);
    } else {
      await capture('sc.exe', ['stop', SERVICE_NAME]).catch(() => undefined);
      await capture('sc.exe', ['delete', SERVICE_NAME]).catch(() => undefined);
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await this.queryService()) === 'NONE') return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  /** Последняя ошибка туннеля из журнала AmneziaWG — понятнее, чем «служба остановилась». */
  private async lastTunnelError(): Promise<string | null> {
    if (!fs.existsSync(EXE_PATH)) return null;
    try {
      const { out } = await capture(EXE_PATH, ['/dumplog'], 8_000);
      const lines = out
        .split('\n')
        .filter((line) => line.includes(`[${TUNNEL_NAME}]`) || line.includes('[TUN]'))
        .map((line) => line.replace(/^\S+\s+\S+\s+/, '').trim());
      const failure = [...lines].reverse().find((line) => /error|fail|unable|invalid|denied/i.test(line));
      return failure ?? null;
    } catch {
      return null;
    }
  }

  /** Синхронная остановка при выходе: асинхронные операции после before-quit не успевают. */
  stopOnQuit(): void {
    if (this.serviceState === 'NONE' || !fs.existsSync(EXE_PATH)) return;
    try {
      spawnSync(EXE_PATH, ['/uninstalltunnelservice', TUNNEL_NAME], { windowsHide: true, timeout: 5_000, stdio: 'pipe' });
    } catch {
      /* служба остановится при следующем запуске Skvoz */
    }
  }
}

export const amneziaVpn = new AmneziaVpnManager();
