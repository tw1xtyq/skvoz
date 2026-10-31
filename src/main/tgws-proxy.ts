import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { TgwsServer, type TgwsServerOptions, type TgwsServerStats, type TgwsLogLevel } from './tgws/server';
import { generateSecretHex, isValidSecretHex } from './tgws/protocol';

const STORE_FILE = path.join(app.getPath('userData'), 'tgws-config.json');

export interface TgwsProxyConfig {
  enabled: boolean;
  port: number;
  host: string;
  secretHex: string;
  autostart: boolean;
}

export const DEFAULT_CONFIG: TgwsProxyConfig = {
  enabled: false,
  port: 4443,
  host: '127.0.0.1',
  secretHex: generateSecretHex(),
  autostart: false,
};

export interface TgwsProxyState {
  running: boolean;
  config: TgwsProxyConfig;
  stats: TgwsServerStats;
  proxyLink: string | null;
}

type LogCallback = (level: TgwsLogLevel, message: string) => void;

export class TgwsProxyManager {
  private server: TgwsServer | null = null;
  private config: TgwsProxyConfig = { ...DEFAULT_CONFIG };
  private logListeners: Set<LogCallback> = new Set();
  private stateListeners: Set<(state: TgwsProxyState) => void> = new Set();

  constructor() {
    this.loadConfig();
  }

  /** Load persisted config from disk. */
  private loadConfig(): void {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as Partial<TgwsProxyConfig>;
        this.config = {
          ...DEFAULT_CONFIG,
          ...parsed,
          secretHex: (parsed.secretHex !== undefined && isValidSecretHex(parsed.secretHex))
            ? parsed.secretHex!
            : generateSecretHex(),
        };
        if (parsed.secretHex !== this.config.secretHex) this.saveConfig();
      }
    } catch {
      /* keep defaults */
    }
    // фиксируем сгенерированный секрет, иначе ссылка в Telegram сломается после перезапуска
    if (!fs.existsSync(STORE_FILE)) this.saveConfig();
  }

  /** Persist config to disk. */
  private saveConfig(): void {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(this.config, null, 2));
    } catch (err) {
      this.log('error', `Не удалось сохранить конфиг прокси: ${err}`);
    }
  }

  private log(level: TgwsLogLevel, message: string): void {
    for (const cb of this.logListeners) cb(level, message);
  }

  private emitState(): void {
    const state: TgwsProxyState = {
      running: this.server !== null,
      config: { ...this.config },
      stats: this.server?.stats ?? { total: 0, active: 0, ws: 0, tcp: 0, bad: 0 },
      proxyLink: this.buildProxyLink(),
    };
    for (const cb of this.stateListeners) cb(state);
  }

  /** Build a tg://proxy link for Telegram Desktop. */
  buildProxyLink(): string | null {
    if (!this.config.secretHex) return null;
    const secret = this.config.secretHex;
    return `tg://proxy?server=${encodeURIComponent(this.config.host)}&port=${this.config.port}&secret=dd${secret}`;
  }

  onLog(cb: LogCallback): () => void {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }

  onStateChange(cb: (state: TgwsProxyState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  getConfig(): TgwsProxyConfig {
    return { ...this.config };
  }

  async setConfig(updates: Partial<TgwsProxyConfig>): Promise<void> {
    // Автозапуск и флаг восстановления можно менять на ходу, сетевые параметры — только у остановленного
    const changesNetwork =
      (updates.port !== undefined && Number(updates.port) !== this.config.port) ||
      (updates.host !== undefined && (updates.host.trim() || '127.0.0.1') !== this.config.host) ||
      (updates.secretHex !== undefined && updates.secretHex !== this.config.secretHex);
    if (this.server && changesNetwork) {
      throw new Error('Остановите прокси перед изменением адреса, порта или секрета');
    }
    if (updates.port !== undefined) {
      const p = Number(updates.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Неверный порт');
      this.config.port = p;
    }
    if (updates.host !== undefined) this.config.host = updates.host.trim() || '127.0.0.1';
    if (updates.secretHex !== undefined) {
      if (!isValidSecretHex(updates.secretHex)) throw new Error('Неверный секрет (ожидается 32 hex-символа)');
      this.config.secretHex = updates.secretHex;
    }
    if (updates.autostart !== undefined) this.config.autostart = !!updates.autostart;
    if (updates.enabled !== undefined) this.config.enabled = !!updates.enabled;
    this.saveConfig();
    this.emitState();
  }

  async start(): Promise<void> {
    if (this.server) return; // already running
    const cfg = this.config;
    const options: TgwsServerOptions = {
      port: cfg.port,
      host: cfg.host,
      secretHex: cfg.secretHex,
      cfCachePath: path.join(app.getPath('userData'), 'tgws-cf-domains.json'),
      onLog: (level, message) => this.log(level, message),
    };
    this.server = new TgwsServer(options);
    await this.server.start();
    this.log('success', `MTProto→WS прокси запущен на ${cfg.host}:${cfg.port}`);
    this.emitState();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    try {
      await this.server.stop();
    } catch {
      /* ignore stop errors */
    }
    this.server = null;
    this.log('info', 'Прокси остановлен');
    this.emitState();
  }

  /** Запуск с повторами: после перезагрузки или обновления порт может освободиться не сразу. */
  async startWithRetry(attempts = 4, delayMs = 3_000): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.start();
        return;
      } catch (error) {
        lastError = error;
        if (this.server) {
          await this.stop();
        }
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  getStats(): TgwsServerStats {
    return this.server?.stats ?? { total: 0, active: 0, ws: 0, tcp: 0, bad: 0 };
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  // CF domains are refreshed automatically inside TgwsServer.start() and
  // on a timer; no external refresh method is exposed.
}

export const tgwsProxy = new TgwsProxyManager();
