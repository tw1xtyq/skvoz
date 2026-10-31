import net from 'net';
import tls from 'tls';
import crypto from 'crypto';

/**
 * Minimal raw WebSocket client (binary subprotocol) ported from
 * Flowseal/tg-ws-proxy proxy/raw_websocket.py.
 */

export class WsHandshakeError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, statusLine: string) {
    super('HTTP ' + statusCode + ': ' + statusLine);
    this.name = 'WsHandshakeError';
    this.statusCode = statusCode;
  }
}

export interface RawWebSocketConnectOptions {
  /** TCP host to connect to (may be a pinned IP) */
  host: string;
  /** value for the Host header / TLS SNI (may differ from host) */
  domain: string;
  path?: string;
  sni?: string;
  secure?: boolean;
  timeoutMs?: number;
}

const MAX_MESSAGE_LEN = 16 * 1024 * 1024;
const OP_CONT = 0x0;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

function buildFrame(opcode: number, data: Buffer, mask: boolean): Buffer {
  const length = data.length;
  const fb = 0x80 | opcode;
  const parts: Buffer[] = [];
  const header = Buffer.alloc(10);
  header[0] = fb;

  if (length < 126) {
    header[1] = (mask ? 0x80 : 0) | length;
    parts.push(header.subarray(0, 2));
  } else if (length < 65536) {
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(length, 2);
    parts.push(header.subarray(0, 4));
  } else {
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    parts.push(header);
  }

  if (!mask) {
    parts.push(data);
    return Buffer.concat(parts);
  }

  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) {
    masked[i] ^= maskKey[i & 3];
  }
  parts.push(maskKey, masked);
  return Buffer.concat(parts);
}

export class RawWebSocket {
  private readonly socket: net.Socket;
  private closed = false;
  private recvBuf: Buffer = Buffer.alloc(0);
  private readonly pending: Buffer[] = [];
  private readonly waiters: Array<{
    resolve: (value: Buffer | null) => void;
    reject: (error: Error) => void;
  }> = [];
  private fatal: Error | null = null;
  private messageHandlers: Array<(msg: Buffer) => void> = [];
  private closeHandlers: Array<() => void> = [];

  constructor(socket: net.Socket, initial?: Buffer) {
    this.socket = socket;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.onFatal(error));
    socket.on('close', () => this._onClose());
    if (initial?.length) {
      // кадры, пришедшие вместе с ответом 101; обработаем после подписки на onMessage
      this.recvBuf = Buffer.from(initial);
      setImmediate(() => this.onData(Buffer.alloc(0)));
    }
  }

  static async connect(options: RawWebSocketConnectOptions): Promise<RawWebSocket> {
    const { host, domain, path = '/apiws', sni, secure = true, timeoutMs = 10000 } = options;
    const timeout = Math.min(timeoutMs, 10_000);

    const socket: net.Socket = secure
      ? tls.connect({ host, port: 443, servername: sni ?? domain, rejectUnauthorized: true })
      : net.connect({ host, port: 80 });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onConnect = (): void => {
        cleanup();
        socket.setTimeout(0);
        resolve();
      };
      const cleanup = (): void => {
        socket.off('error', onError);
        socket.off(secure ? 'secureConnect' : 'connect', onConnect);
      };

      socket.once('error', onError);
      socket.once(secure ? 'secureConnect' : 'connect', onConnect);
      socket.setTimeout(timeout, () => {
        cleanup();
        socket.destroy();
        reject(new Error('WebSocket handshake timeout'));
      });
    });

    // Send HTTP upgrade request
    const request = [
      'GET ' + path + ' HTTP/1.1',
      'Host: ' + domain,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64'),
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: binary',
      'Origin: https://web.telegram.org',
      '',
      '',
    ].join('\r\n');

    socket.write(request);

    // Read handshake response
    const response = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let done = false;
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const data = Buffer.concat(chunks);
        if (data.includes('\r\n\r\n')) {
          done = true;
          socket.off('data', onData);
          socket.off('error', onError);
          socket.off('close', onClose);
          resolve(data);
        }
      };
      const onError = (error: Error) => {
        socket.off('data', onData);
        socket.off('close', onClose);
        reject(error);
      };
      const onClose = () => {
        socket.off('data', onData);
        socket.off('error', onError);
        reject(new Error('connection closed during WS handshake'));
      };

      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
    });

    const responseStr = response.toString('latin1');
    const statusMatch = responseStr.match(/^HTTP\/1\.1 (\d+) /);
    if (!statusMatch) {
      socket.destroy();
      throw new Error('Invalid WebSocket handshake response');
    }
    const statusCode = parseInt(statusMatch[1], 10);
    if (statusCode !== 101) {
      const statusLine = responseStr.split('\r\n')[0];
      socket.destroy();
      throw new WsHandshakeError(statusCode, statusLine);
    }

    const headerEnd = response.indexOf('\r\n\r\n') + 4;
    return new RawWebSocket(socket, response.subarray(headerEnd));
  }

  onMessage(cb: (msg: Buffer) => void): void {
    this.messageHandlers.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  send(data: Buffer): void {
    if (this.closed) throw new Error('WebSocket closed');
    try {
      this.socket.write(buildFrame(OP_BINARY, data, true));
    } catch {
      /* ignore */
    }
  }

  close(code: number = 1000, reason: string = ''): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const payload = Buffer.alloc(2 + reason.length);
      payload.writeUInt16BE(code, 0);
      if (reason) payload.write(reason, 2);
      this.socket.write(buildFrame(OP_CLOSE, payload, true));
    } catch {
      /* ignore */
    }
    this.socket.destroy();
    this.drainWaiters(null);
  }

  private onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);

    while (true) {
      const frame = this.takeFrame();
      if (!frame) break;

      if (frame.opcode === OP_CLOSE) {
        try {
          this.socket.write(buildFrame(OP_CLOSE, frame.payload.subarray(0, 2), true));
        } catch {
          /* ignore */
        }
        this.socket.destroy();
        this.drainWaiters(null);
        for (const cb of this.closeHandlers) cb();
        return;
      }
      if (frame.opcode === OP_PING) {
        try {
          this.socket.write(buildFrame(OP_PONG, frame.payload, true));
        } catch {
          /* ignore */
        }
        continue;
      }
      if (frame.opcode === OP_PONG) continue;

      if (frame.opcode === OP_CONT || frame.opcode === 0x1 || frame.opcode === OP_BINARY) {
        let message: Buffer;
        if (frame.fin && this.messageAcc.length === 0) {
          message = frame.payload;
        } else {
          message = Buffer.concat([this.messageAcc, frame.payload]);
        }
        if (!frame.fin) {
          this.messageAcc = message;
          continue;
        }
        this.messageAcc = Buffer.alloc(0);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.pending.push(message);
        for (const cb of this.messageHandlers) cb(message);
      }
    }
  }

  private messageAcc: Buffer = Buffer.alloc(0);

  private takeFrame(): Frame | null {
    if (this.recvBuf.length < 2) return null;
    const fin = (this.recvBuf[0] & 0x80) !== 0;
    const opcode = this.recvBuf[0] & 0x0f;
    let length = this.recvBuf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (this.recvBuf.length < 4) return null;
      length = this.recvBuf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.recvBuf.length < 10) return null;
      const big = this.recvBuf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_LEN)) {
        this.onFatal(new Error('WS frame too large: ' + big + ' bytes'));
        return null;
      }
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_MESSAGE_LEN) {
      this.onFatal(new Error('WS frame too large: ' + length + ' bytes'));
      return null;
    }

    const masked = (this.recvBuf[1] & 0x80) !== 0;
    let maskKey: Buffer | null = null;
    if (masked) {
      if (this.recvBuf.length < offset + 4) return null;
      maskKey = this.recvBuf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.recvBuf.length < offset + length) return null;

    const payload = Buffer.from(this.recvBuf.subarray(offset, offset + length));
    this.recvBuf = Buffer.from(this.recvBuf.subarray(offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i & 3];
      }
    }
    return { fin, opcode, payload };
  }

  private drainWaiters(value: Buffer | null): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve(value);
    }
  }

  private onFatal(error: Error): void {
    this.fatal = error;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  private _onClose(): void {
    this.closed = true;
    this.drainWaiters(null);
    for (const cb of this.closeHandlers) cb();
  }
}
