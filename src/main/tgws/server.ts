import fs from 'fs';
import net from 'net';
import https from 'https';
import crypto from 'crypto';

import {
  HANDSHAKE_LEN,
  MsgSplitter,
  generateRelayInit,
  tryHandshake,
  type HandshakeResult,
  type RelayInit,
} from './protocol';
import { RawWebSocket } from './ws';

/**
 * Local MTProto -> WebSocket Telegram proxy, ported from Flowseal/tg-ws-proxy
 * (proxy/tg_ws_proxy.py + proxy/bridge.py + proxy/pool.py, without CF-worker/H2/FakeTLS extras).
 *
 * Telegram Desktop -> 127.0.0.1:port (obfuscated MTProto, dd-secret)
 *   -> WebSocket (TLS) to kws<dc>.web.telegram.org/apiws
 *   -> fallback: CF-proxy domains -> fallback: direct TCP to the DC.
 */

export type TgwsLogLevel = 'info' | 'success' | 'warn' | 'error';

export interface TgwsServerStats {
  total: number;
  active: number;
  ws: number;
  tcp: number;
  bad: number;
}

export interface TgwsServerOptions {
  port: number;
  host?: string;
  secretHex: string;
  onLog?: (level: TgwsLogLevel, message: string) => void;
  /** when set, CF-proxy domains are refreshed from GitHub and cached here */
  cfCachePath?: string;
}

const DC_DEFAULT_IPS: Record<number, string> = {
  1: '149.154.175.50',
  2: '149.154.167.51',
  3: '149.154.175.100',
  4: '149.154.167.91',
  5: '149.154.171.5',
  203: '91.105.192.100',
};

const DC_TEST_IPS: Record<number, string> = {
  1: '149.154.175.10',
  2: '149.154.167.40',
  3: '149.154.175.117',
};

/** Default DC -> pinned IP for the primary WS route (dc_ip defaults of tg-ws-proxy). */
const DC_REDIRECTS: Record<number, string> = {
  2: '149.154.167.220',
  4: '149.154.167.220',
};

const WS_PATH = '/apiws';
const WS_PATH_TEST = WS_PATH + '_test';

const CFPROXY_DOMAINS_URL =
  'https://raw.githubusercontent.com/Flowseal/tg-ws-proxy/main/.github/cfproxy-domains.txt';

const CFPROXY_ENCODED = [
  'virkgj.com', 'vmmzovy.com', 'mkuosckvso.com', 'zaewayzmplad.com', 'twdmbzcm.com',
  'awzwsldi.com', 'clngqrflngqin.com', 'tjacxbqtj.com', 'bxaxtxmrw.com', 'dmohrsgmohcrwb.com',
  'vwbmtmoi.com', 'khgrre.com', 'ulihssf.com', 'tmhqsdqmfpmk.com', 'xwuwoqbm.com',
  'orgcnunpj.com', 'zhkuldz.com', 'zypoljnslxa.com', 'efabnxaowuzs.com', 'zaftuzsftqdq.com',
];

/** Decodes the obfuscated CF-proxy domain list (config.py _dd). */
function decodeCfDomain(encoded: string): string {
  if (!encoded.endsWith('.com')) return encoded;
  const prefix = encoded.slice(0, -4);
  let shift = 0;
  for (const ch of prefix) {
    if (/[a-zA-Z]/.test(ch)) shift += 1;
  }
  let out = '';
  for (const ch of prefix) {
    if (!/[a-zA-Z]/.test(ch)) {
      out += ch;
      continue;
    }
    const base = ch >= 'a' ? 97 : 65;
    out += String.fromCharCode((((ch.charCodeAt(0) - base - shift) % 26) + 26) % 26 + base);
  }
  return out + '.co.uk';
}

function isDomain(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]+(.[a-z0-9-]+)+$/i.test(value);
}

function wsDomains(dc: number, isMedia: boolean): string[] {
  const mapped = dc === 203 ? 2 : dc;
  if (!isMedia) return ['kws' + mapped + '.web.telegram.org'];
  return ['kws' + mapped + '-1.web.telegram.org', 'kws' + mapped + '.web.telegram.org'];
}

function shuffle<T>(items: T[]): T[] {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function readExactly(
  socket: net.Socket,
  size: number,
  timeoutMs: number
): Promise<{ head: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let timer: NodeJS.Timeout | null = null;

    const finish = (err?: Error, buf?: Buffer): void => {
      if (timer) clearTimeout(timer);
      socket.setTimeout(0);
      socket.pause();
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (err) reject(err);
      else {
        const all = buf ?? Buffer.alloc(0);
        resolve({ head: all.subarray(0, size), rest: all.subarray(size) });
      }
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= size) {
        finish(undefined, Buffer.concat(chunks));
      }
    };

    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error('client disconnected before handshake'));

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
    socket.setTimeout(timeoutMs, () => finish(new Error('handshake timeout')));
  });
}

export class TgwsServer {
  private readonly options: TgwsServerOptions;
  private readonly host: string;
  private readonly secret: Buffer;
  private server: net.Server | null = null;
  private readonly sockets: Set<net.Socket> = new Set();
  private cfDomains: string[] = [];
  private cfRefreshTimer: NodeJS.Timeout | null = null;
  private cfRefreshing = false;

  readonly stats: TgwsServerStats = { total: 0, active: 0, ws: 0, tcp: 0, bad: 0 };

  constructor(options: TgwsServerOptions) {
    this.options = options;
    this.host = options.host ?? '127.0.0.1';
    this.secret = Buffer.from(options.secretHex, 'hex');
    this.cfDomains = this.loadCfCache() ?? CFPROXY_ENCODED.map(decodeCfDomain);
  }

  /** Последний скачанный список — чтобы резервный маршрут работал и без GitHub. */
  private loadCfCache(): string[] | null {
    if (!this.options.cfCachePath) return null;
    try {
      const cached = JSON.parse(fs.readFileSync(this.options.cfCachePath, 'utf8')) as { domains?: unknown };
      const domains = Array.isArray(cached.domains) ? cached.domains.filter(isDomain) : [];
      return domains.length ? domains : null;
    } catch {
      return null;
    }
  }

  private log(level: TgwsLogLevel, message: string): void {
    this.options.onLog?.(level, message);
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (this.secret.length !== 16) {
      return Promise.reject(new Error('Secret должен быть 32 hex-символами'));
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        void this.handleClient(socket);
      });
      server.once('error', reject);
      server.listen(this.options.port, this.host, () => {
        server.off('error', reject);
        this.server = server;
        this.log('info', 'MTProto-прокси запущен: ' + this.host + ':' + this.options.port);
        void this.refreshCfDomains();
        this.cfRefreshTimer = setInterval(() => void this.refreshCfDomains(), 3_600_000);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.cfRefreshTimer) {
      clearInterval(this.cfRefreshTimer);
      this.cfRefreshTimer = null;
    }
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.log('info', 'MTProto-прокси остановлен');
  }

  get listening(): boolean {
    return this.server !== null;
  }

  private async handleClient(socket: net.Socket): Promise<void> {
    this.stats.total += 1;
    this.stats.active += 1;
    const label = (socket.remoteAddress ?? '?') + ':' + (socket.remotePort ?? '?');
    socket.setNoDelay(true);
    this.sockets.add(socket);
    // буферизуем данные клиента, пока не готов апстрим
    socket.pause();

    try {
      const read = await readExactly(socket, HANDSHAKE_LEN, 10_000).catch(() => null);
      if (!read) {
        return;
      }

      const hs = tryHandshake(read.head, this.secret);
      if (!hs) {
        this.stats.bad += 1;
        this.log('warn', '[' + label + '] Неверный handshake (не совпал секрет или неверный формат)');
        return;
      }

      const dcTag = 'DC' + hs.dcId + (hs.isMedia ? 'm' : '') + (hs.isTestDc ? 't' : '');
      const relay = generateRelayInit(hs.protoTag, hs.dcIdx);

      const upstream = await this.connectUpstream(hs.dcId, hs.isMedia, hs.isTestDc);
      if (!upstream) {
        this.log('warn', '[' + label + '] ' + dcTag + ': нет доступного маршрута к Telegram');
        return;
      }

      if (upstream.kind === 'ws') {
        this.stats.ws += 1;
        this.log('info', '[' + label + '] ' + dcTag + ' -> WebSocket (' + upstream.label + ')');
        upstream.ws.send(relay.init);
        await this.bridgeWs(socket, upstream.ws, hs, relay, read.rest);
      } else {
        this.stats.tcp += 1;
        this.log('warn', '[' + label + '] ' + dcTag + ' -> прямой TCP (' + upstream.socket.remoteAddress + ')');
        upstream.socket.write(relay.init);
        await this.bridgeTcp(socket, upstream.socket, hs, relay, read.rest);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/handshake timeout|клиент отключился/i.test(message)) {
        this.log('error', '[' + label + '] ошибка: ' + message);
      }
    } finally {
      this.stats.active -= 1;
      this.sockets.delete(socket);
      socket.destroy();
    }
  }

  private async connectUpstream(
    dc: number,
    isMedia: boolean,
    isTestDc: boolean
  ): Promise<{ kind: 'ws'; ws: RawWebSocket; label: string } | { kind: 'tcp'; socket: net.Socket } | null> {
    const path = isTestDc ? WS_PATH_TEST : WS_PATH;

    // 1) primary route: kws<dc>.web.telegram.org via pinned IP (or DNS when no redirect)
    for (const domain of wsDomains(dc, isMedia)) {
      const pinnedIp = DC_REDIRECTS[dc];
      try {
        const ws = await RawWebSocket.connect({
          host: pinnedIp ?? domain,
          domain,
          path,
          timeoutMs: 8_000,
        });
        return { kind: 'ws', ws, label: pinnedIp ? domain + ' -> ' + pinnedIp : domain };
      } catch {
        /* try next domain */
      }
    }

    // 2) CF-proxy fallback: kws<dc>.<cf-domain>
    if (!isTestDc) {
      for (const cfDomain of shuffle(this.cfDomains)) {
        const host = 'kws' + dc + '.' + cfDomain;
        try {
          const ws = await RawWebSocket.connect({
            host,
            domain: host,
            path: WS_PATH,
            timeoutMs: 8_000,
          });
          return { kind: 'ws', ws, label: host };
        } catch {
          /* try next cf domain */
        }
      }
    }

    // 3) direct TCP fallback to the DC
    const ipTable = isTestDc ? DC_TEST_IPS : DC_DEFAULT_IPS;
    const dst = ipTable[dc];
    if (dst) {
      const sock = await new Promise<net.Socket | null>((resolve) => {
        const socket = net.connect({ host: dst, port: 443 });
        const timer = setTimeout(() => {
          socket.destroy();
          resolve(null);
        }, 10_000);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.setNoDelay(true);
          resolve(socket);
        });
        socket.once('error', () => {
          clearTimeout(timer);
          socket.destroy();
          resolve(null);
        });
      });
      if (sock) return { kind: 'tcp', socket: sock };
    }

    return null;
  }

  /** Relays until either side closes. */
  private bridgeWs(
    client: net.Socket,
    upstream: RawWebSocket,
    hs: HandshakeResult,
    relay: RelayInit,
    early: Buffer
  ): Promise<void> {
    return new Promise((resolve) => {
      const splitter = new MsgSplitter(hs.proto);
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        upstream.close();
        resolve();
      };

      const fromClient = (chunk: Buffer): void => {
        for (const packet of splitter.push(hs.cltDec.update(chunk))) {
          try {
            upstream.send(relay.tgEnc.update(packet));
          } catch {
            finish();
            return;
          }
        }
      };

      upstream.onMessage((msg) => {
        if (!done) client.write(hs.cltEnc.update(relay.tgDec.update(msg)));
      });
      upstream.onClose(finish);
      client.on('data', fromClient);
      client.once('close', finish);
      client.once('error', finish);
      if (early.length) fromClient(early);
      client.resume();
    });
  }

  private bridgeTcp(
    client: net.Socket,
    upstream: net.Socket,
    hs: HandshakeResult,
    relay: RelayInit,
    early: Buffer
  ): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        upstream.destroy();
        resolve();
      };

      const fromClient = (chunk: Buffer): void => {
        upstream.write(relay.tgEnc.update(hs.cltDec.update(chunk)));
      };

      upstream.on('data', (chunk: Buffer) => {
        if (!done) client.write(hs.cltEnc.update(relay.tgDec.update(chunk)));
      });
      upstream.once('close', finish);
      upstream.once('error', finish);
      client.on('data', fromClient);
      client.once('close', finish);
      client.once('error', finish);
      if (early.length) fromClient(early);
      client.resume();
    });
  }

  private async refreshCfDomains(): Promise<void> {
    if (this.cfRefreshing) return;
    this.cfRefreshing = true;
    try {
      const res = await fetch(CFPROXY_DOMAINS_URL);
      if (!res.ok) return;
      const text = await res.text();
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const decoded = lines.map(decodeCfDomain).filter(isDomain);
      if (decoded.length === 0) return;
      this.cfDomains = decoded;
      if (this.options.cfCachePath) {
        fs.writeFileSync(
          this.options.cfCachePath,
          JSON.stringify({ updatedAt: new Date().toISOString(), domains: decoded }, null, 2)
        );
      }
      this.log('info', 'Обновлено CF-прокси: ' + decoded.length + ' доменов');
    } catch {
      /* keep existing domains */
    } finally {
      this.cfRefreshing = false;
    }
  }
}