import crypto from 'crypto';
import type { Cipher } from 'crypto';

/**
 * MTProto obfuscated2 transport (dd-secret) as used by Flowseal/tg-ws-proxy:
 * the client talks obfuscated2 + secret to us, we talk plain obfuscated2 to Telegram.
 */

export const HANDSHAKE_LEN = 64;
const SKIP_LEN = 8;
const PREKEY_LEN = 32;
const KEY_IV_LEN = 48;
const PROTO_TAG_POS = 56;
const DC_IDX_POS = 60;

export const PROTO_TAG_ABRIDGED = Buffer.from([0xef, 0xef, 0xef, 0xef]);
export const PROTO_TAG_INTERMEDIATE = Buffer.from([0xee, 0xee, 0xee, 0xee]);
export const PROTO_TAG_SECURE = Buffer.from([0xdd, 0xdd, 0xdd, 0xdd]);

export const PROTO_ABRIDGED = 0xefefefef;
export const PROTO_INTERMEDIATE = 0xeeeeeeee;
export const PROTO_PADDED_INTERMEDIATE = 0xdddddddd;

/** First 4 bytes Telegram treats as another protocol (HTTP, TLS, transport tags). */
const RESERVED_STARTS = [
  Buffer.from('HEAD', 'ascii'),
  Buffer.from('POST', 'ascii'),
  Buffer.from('GET ', 'ascii'),
  Buffer.from('OPTI', 'ascii'),
  Buffer.from([0x16, 0x03, 0x01, 0x02]),
  PROTO_TAG_INTERMEDIATE,
  PROTO_TAG_SECURE,
];

function sha256(buf: Buffer): Buffer {
  return crypto.createHash('sha256').update(buf).digest();
}

function ctr(key: Buffer, iv: Buffer): Cipher {
  return crypto.createCipheriv('aes-256-ctr', key, iv);
}

export interface HandshakeResult {
  /** DC number without media / test flags */
  dcId: number;
  isMedia: boolean;
  isTestDc: boolean;
  /** raw signed DC index from the client, forwarded to Telegram as is */
  dcIdx: number;
  protoTag: Buffer;
  proto: number;
  /** client -> proxy stream, already advanced past the handshake */
  cltDec: Cipher;
  /** proxy -> client stream */
  cltEnc: Cipher;
}

export interface RelayInit {
  init: Buffer;
  /** proxy -> Telegram stream, already advanced past the init */
  tgEnc: Cipher;
  /** Telegram -> proxy stream */
  tgDec: Cipher;
}

export function generateSecretHex(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isValidSecretHex(secret: string): boolean {
  return /^[0-9a-fA-F]{32}$/.test(secret);
}

function protoFromTag(tag: Buffer): number | null {
  if (tag.equals(PROTO_TAG_ABRIDGED)) return PROTO_ABRIDGED;
  if (tag.equals(PROTO_TAG_INTERMEDIATE)) return PROTO_INTERMEDIATE;
  if (tag.equals(PROTO_TAG_SECURE)) return PROTO_PADDED_INTERMEDIATE;
  return null;
}

/** Decrypts the client's 64-byte init with our secret; null if it is not ours. */
export function tryHandshake(handshake: Buffer, secret: Buffer): HandshakeResult | null {
  if (handshake.length < HANDSHAKE_LEN) return null;

  const decPrekeyIv = handshake.subarray(SKIP_LEN, SKIP_LEN + KEY_IV_LEN);
  const encPrekeyIv = Buffer.from(decPrekeyIv).reverse();

  const cltDec = ctr(
    sha256(Buffer.concat([decPrekeyIv.subarray(0, PREKEY_LEN), secret])),
    decPrekeyIv.subarray(PREKEY_LEN)
  );
  const cltEnc = ctr(
    sha256(Buffer.concat([encPrekeyIv.subarray(0, PREKEY_LEN), secret])),
    encPrekeyIv.subarray(PREKEY_LEN)
  );

  const decrypted = cltDec.update(handshake.subarray(0, HANDSHAKE_LEN));
  const protoTag = Buffer.from(decrypted.subarray(PROTO_TAG_POS, DC_IDX_POS));
  const proto = protoFromTag(protoTag);
  if (proto === null) return null;

  const dcIdx = decrypted.readInt16LE(DC_IDX_POS);
  let dcId = Math.abs(dcIdx);
  const isTestDc = dcId >= 10_000;
  if (isTestDc) dcId -= 10_000;
  if (dcId < 1) return null;

  return { dcId, isMedia: dcIdx < 0, isTestDc, dcIdx, protoTag, proto, cltDec, cltEnc };
}

/** Builds our own obfuscated2 init for the Telegram side (no secret). */
export function generateRelayInit(protoTag: Buffer, dcIdx: number): RelayInit {
  let rnd: Buffer;
  do {
    rnd = crypto.randomBytes(HANDSHAKE_LEN);
  } while (
    rnd[0] === 0xef ||
    RESERVED_STARTS.some((start) => rnd.subarray(0, 4).equals(start)) ||
    rnd.readUInt32LE(4) === 0
  );

  protoTag.copy(rnd, PROTO_TAG_POS);
  rnd.writeInt16LE(dcIdx, DC_IDX_POS);

  const keyIv = rnd.subarray(SKIP_LEN, SKIP_LEN + KEY_IV_LEN);
  const revKeyIv = Buffer.from(keyIv).reverse();
  const tgEnc = ctr(keyIv.subarray(0, PREKEY_LEN), keyIv.subarray(PREKEY_LEN));
  const tgDec = ctr(revKeyIv.subarray(0, PREKEY_LEN), revKeyIv.subarray(PREKEY_LEN));

  const encrypted = tgEnc.update(rnd);
  const init = Buffer.concat([rnd.subarray(0, PROTO_TAG_POS), encrypted.subarray(PROTO_TAG_POS)]);
  return { init, tgEnc, tgDec };
}

/**
 * Splits the decrypted client stream into whole transport packets:
 * Telegram's WebSocket endpoint expects one packet per frame.
 */
export class MsgSplitter {
  private readonly proto: number;
  private buf: Buffer = Buffer.alloc(0);

  constructor(proto: number) {
    this.proto = proto;
  }

  push(plain: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, plain]) : plain;
    const packets: Buffer[] = [];
    while (true) {
      const size = this.packetSize();
      if (size === null || this.buf.length < size) break;
      packets.push(this.buf.subarray(0, size));
      this.buf = this.buf.subarray(size);
    }
    return packets;
  }

  private packetSize(): number | null {
    if (this.proto === PROTO_ABRIDGED) {
      if (this.buf.length < 1) return null;
      const first = this.buf[0] & 0x7f;
      if (first < 0x7f) return 1 + first * 4;
      if (this.buf.length < 4) return null;
      return 4 + this.buf.readUIntLE(1, 3) * 4;
    }
    if (this.buf.length < 4) return null;
    return 4 + (this.buf.readUInt32LE(0) & 0x7fffffff);
  }
}
