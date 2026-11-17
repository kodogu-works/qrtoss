import {
  ProtocolError,
  exact,
  encodeBase64,
  decodeBase64,
  parseSequence,
  validateEnvelope,
  type Envelope,
} from './validation.ts';
export {
  ProtocolError,
  exact,
  encodeBase64,
  decodeBase64,
  parseSequence,
  validateEnvelope,
  type Envelope,
} from './validation.ts';
export { validateControlMessage } from './control.ts';
export type { ControlMessage, ControlTarget } from './control.generated.ts';
import { C } from './constants.ts';
export { C };
export { ERROR_CODES, CLOSE_REASONS } from './constants.ts';
export const PROTOCOL = 'qrtoss/1';
export const SUBPROTOCOL = 'qrtoss.v1';
export function randomToken(bytes: number): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(bytes)));
}
export const utf8 = (s: string) => new TextEncoder().encode(s);
export function encodeText(text: string): string {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new ProtocolError('CONTENT_INVALID');
  const bytes = utf8(text);
  if (!bytes.length) throw new ProtocolError('CONTENT_EMPTY');
  if (bytes.length > C.MAX_TEXT_UTF8_BYTES) throw new ProtocolError('CONTENT_TOO_LARGE');
  return encodeBase64(bytes);
}
export function decodeText(value: string): string {
  const bytes = decodeBase64(value);
  if (!bytes.length || bytes.length > C.MAX_TEXT_UTF8_BYTES) throw new ProtocolError();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ProtocolError();
  }
}
export type Mode = 'auto_open' | 'display_only' | 'stdout';
export type AppMessage =
  | { type: 'ready' | 'ready_ack' | 'activity' }
  | { type: 'mode'; value: Mode }
  | { type: 'status'; state: 'scanning' | 'scanned' | 'ready' }
  | { type: 'data'; id: string; textB64: string }
  | { type: 'ack'; id: string; status: 'received' }
  | { type: 'ack'; id: string; status: 'rejected'; reason: 'unsupported_content' }
  | { type: 'ack_seen'; id: string };
export function validateAppMessage(value: unknown): AppMessage {
  if (!value || typeof value !== 'object') throw new ProtocolError();
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'ready_ack':
    case 'activity':
      exact(m, ['type']);
      break;
    case 'mode':
      exact(m, ['type', 'value']);
      if (typeof m.value !== 'string' || !['auto_open', 'display_only', 'stdout'].includes(m.value))
        throw new ProtocolError();
      break;
    case 'status':
      exact(m, ['type', 'state']);
      if (typeof m.state !== 'string' || !['scanning', 'scanned', 'ready'].includes(m.state))
        throw new ProtocolError();
      break;
    case 'data':
      exact(m, ['type', 'id', 'textB64']);
      decodeBase64(m.id as string, 16);
      decodeText(m.textB64 as string);
      break;
    case 'ack':
      if (m.status === 'received') exact(m, ['type', 'id', 'status']);
      else if (m.status === 'rejected' && m.reason === 'unsupported_content')
        exact(m, ['type', 'id', 'status', 'reason']);
      else throw new ProtocolError();
      decodeBase64(m.id as string, 16);
      break;
    case 'ack_seen':
      exact(m, ['type', 'id']);
      decodeBase64(m.id as string, 16);
      break;
    default:
      throw new ProtocolError();
  }
  return value as AppMessage;
}
export type Keys = {
  s2r: CryptoKey;
  r2s: CryptoKey;
  proof: CryptoKey;
  transcript: Uint8Array<ArrayBuffer>;
};
export async function deriveKeys(
  psk: string,
  room: string,
  peer: string,
  rNonce: string,
  sNonce: string,
): Promise<Keys> {
  decodeBase64(room, 16);
  decodeBase64(peer, 16);
  decodeBase64(rNonce, 32);
  decodeBase64(sNonce, 32);
  const transcript = utf8(`${PROTOCOL}\n${room}\n${peer}\n${rNonce}\n${sNonce}\n`);
  const salt = await crypto.subtle.digest('SHA-256', transcript);
  const base = await crypto.subtle.importKey('raw', decodeBase64(psk, 32), 'HKDF', false, [
    'deriveKey',
  ]);
  const params = (purpose: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info: utf8(`${PROTOCOL}/${purpose}`),
  });
  const [proof, s2r, r2s] = await Promise.all([
    crypto.subtle.deriveKey(
      params('proof'),
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify'],
    ),
    crypto.subtle.deriveKey(params('s2r'), base, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
    crypto.subtle.deriveKey(params('r2s'), base, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  ]);
  return { proof, s2r, r2s, transcript };
}
const proofInput = (keys: Keys, role: string) => {
  const prefix = utf8(`${role}\n`);
  const b = new Uint8Array(prefix.length + keys.transcript.length);
  b.set(prefix);
  b.set(keys.transcript, prefix.length);
  return b;
};
export async function makeProof(keys: Keys, role: 'sender' | 'receiver'): Promise<string> {
  return encodeBase64(
    new Uint8Array(await crypto.subtle.sign('HMAC', keys.proof, proofInput(keys, role))),
  );
}
export async function verifyProof(
  keys: Keys,
  role: 'sender' | 'receiver',
  proof: string,
): Promise<boolean> {
  return crypto.subtle.verify('HMAC', keys.proof, decodeBase64(proof, 32), proofInput(keys, role));
}
export class CipherChannel {
  private sendSeq = 0n;
  private recvSeq = 0n;
  private sendDir: 's2r' | 'r2s';
  private recvDir: 's2r' | 'r2s';
  private keys: Pick<Keys, 's2r' | 'r2s'>;
  constructor(
    private room: string,
    private peer: string,
    role: 'receiver' | 'sender',
    keys: Keys,
  ) {
    this.keys = { s2r: keys.s2r, r2s: keys.r2s };
    this.sendDir = role === 'sender' ? 's2r' : 'r2s';
    this.recvDir = role === 'sender' ? 'r2s' : 's2r';
  }
  private params(dir: string, seq: bigint) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, seq, false);
    return {
      name: 'AES-GCM',
      iv,
      additionalData: utf8(`${PROTOCOL}/cipher\n${this.room}\n${this.peer}\n${dir}\n${seq}\n`),
      tagLength: 128,
    };
  }
  private direction(dir: 's2r' | 'r2s', seq: bigint, message: AppMessage) {
    if (seq === 0n) {
      if (message.type !== (dir === 's2r' ? 'ready' : 'ready_ack')) throw new ProtocolError();
    } else if (
      !(dir === 's2r' ? ['activity', 'status', 'data', 'ack_seen'] : ['mode', 'ack']).includes(
        message.type,
      )
    )
      throw new ProtocolError();
  }
  async encrypt(message: AppMessage): Promise<Envelope> {
    validateAppMessage(message);
    this.direction(this.sendDir, this.sendSeq, message);
    const bytes = utf8(JSON.stringify(message));
    if (bytes.length > C.MAX_PLAINTEXT_BYTES || this.sendSeq > 0xffffffffffffffffn)
      throw new ProtocolError();
    const seq = this.sendSeq++;
    const ct = await crypto.subtle.encrypt(
      this.params(this.sendDir, seq),
      this.keys[this.sendDir],
      bytes,
    );
    return {
      v: 1,
      type: 'cipher',
      room: this.room,
      peer: this.peer,
      dir: this.sendDir,
      seq: String(seq),
      ct: encodeBase64(new Uint8Array(ct)),
    };
  }
  async decrypt(value: unknown): Promise<AppMessage> {
    const e = validateEnvelope(value);
    if (
      e.room !== this.room ||
      e.peer !== this.peer ||
      e.dir !== this.recvDir ||
      parseSequence(e.seq) !== this.recvSeq
    )
      throw new ProtocolError();
    let message: AppMessage;
    try {
      const bytes = await crypto.subtle.decrypt(
        this.params(this.recvDir, this.recvSeq),
        this.keys[this.recvDir],
        decodeBase64(e.ct),
      );
      message = validateAppMessage(
        JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)),
      );
      this.direction(this.recvDir, this.recvSeq, message);
    } catch {
      throw new ProtocolError('CRYPTO_ERROR');
    }
    this.recvSeq++;
    return message;
  }
}
