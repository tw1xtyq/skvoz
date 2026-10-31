import crypto from 'crypto';
import net from 'net';

/**
 * Проверяет локальный прокси как настоящий клиент Telegram:
 * obfuscated2-рукопожатие с секретом и req_pq_multi, ждём resPQ от DC.
 */
export function probeTgwsProxy(
  host: string,
  port: number,
  secretHex: string,
  dc = 2,
  timeoutMs = 10_000
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const secret = Buffer.from(secretHex, 'hex');
  const startedAt = Date.now();

  let rnd: Buffer;
  do rnd = crypto.randomBytes(64);
  while (
    rnd[0] === 0xef ||
    rnd.readUInt32LE(4) === 0 ||
    [0xdddddddd, 0xeeeeeeee].includes(rnd.readUInt32LE(0))
  );
  Buffer.from([0xdd, 0xdd, 0xdd, 0xdd]).copy(rnd, 56);
  rnd.writeInt16LE(dc, 60);

  const keyIv = rnd.subarray(8, 56);
  const rev = Buffer.from(keyIv).reverse();
  const sha = (a: Buffer): Buffer => crypto.createHash('sha256').update(Buffer.concat([a, secret])).digest();
  const enc = crypto.createCipheriv('aes-256-ctr', sha(keyIv.subarray(0, 32)), keyIv.subarray(32));
  const dec = crypto.createCipheriv('aes-256-ctr', sha(rev.subarray(0, 32)), rev.subarray(32));
  const init = Buffer.concat([rnd.subarray(0, 56), enc.update(rnd).subarray(56)]);

  const nonce = crypto.randomBytes(16);
  const msg = Buffer.alloc(40);
  msg.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)) << 32n, 8);
  msg.writeUInt32LE(20, 16);
  msg.writeUInt32LE(0xbe7e8ef1, 20); // req_pq_multi
  nonce.copy(msg, 24);
  const packet = Buffer.alloc(4 + msg.length);
  packet.writeUInt32LE(msg.length, 0);
  msg.copy(packet, 4);

  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    let got = Buffer.alloc(0);
    let settled = false;
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, ms: Date.now() - startedAt, error });
    };
    const timer = setTimeout(() => finish(false, 'нет ответа от Telegram'), timeoutMs);

    socket.once('connect', () => socket.write(Buffer.concat([init, enc.update(packet)])));
    socket.on('data', (chunk: Buffer) => {
      got = Buffer.concat([got, dec.update(chunk)]);
      if (got.length < 4 || got.length < 4 + (got.readUInt32LE(0) & 0x7fffffff)) return;
      const body = got.subarray(4);
      const ok = body.length >= 40 && body.readUInt32LE(20) === 0x05162463 && body.subarray(24, 40).equals(nonce);
      finish(ok, ok ? undefined : 'неожиданный ответ');
    });
    socket.once('error', (error) => finish(false, error.message));
    socket.once('close', () => finish(false, 'прокси закрыл соединение'));
  });
}
