import { SC } from './shared-constants.ts';
import { decodeDisplayText, encodeDisplayText } from './shared-control.ts';
import {
  ProtocolError,
  decodeBase64,
  encodeBase64,
  exact,
  parseSequence,
  type Envelope,
} from './validation.ts';

export { SC, SHARED_ERROR_CODES } from './shared-constants.ts';

export const SHARE_PROTOCOL = 'qrtoss/share/1';
export const SHARE_PAIR_SUBPROTOCOL = 'qrtoss.share-pair.v1';
export const SHARE_NETWORK_SUBPROTOCOL = 'qrtoss.share.v1';
export const SHARE_INVITE_VERSION = '2';

const utf8Encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxUint64 = 0xffffffffffffffffn;
function hasForbiddenDisplayCharacters(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x61c ||
      point === 0x200e ||
      point === 0x200f ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    )
      return true;
  }
  return false;
}

export function sharedUtf8(value: string): Uint8Array<ArrayBuffer> {
  const encoded = utf8Encoder.encode(value);
  const result = new Uint8Array(encoded.byteLength);
  result.set(encoded);
  return result;
}

function wellFormed(value: string): boolean {
  return !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''));
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
    throw new ProtocolError();
}

function token(value: unknown, bytes: number): asserts value is string {
  if (typeof value !== 'string') throw new ProtocolError();
  decodeBase64(value, bytes);
}

function plainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError();
}

function decodeUtf8(value: unknown, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new ProtocolError();
  const bytes = decodeBase64(value);
  if ((!allowEmpty && !bytes.length) || bytes.length > maxBytes) throw new ProtocolError();
  try {
    return fatalDecoder.decode(bytes);
  } catch {
    throw new ProtocolError();
  }
}

function encodeUtf8(value: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || !wellFormed(value)) throw new ProtocolError('CONTENT_INVALID');
  const bytes = sharedUtf8(value);
  if (!allowEmpty && !bytes.length) throw new ProtocolError('CONTENT_EMPTY');
  if (bytes.length > maxBytes) throw new ProtocolError('CONTENT_TOO_LARGE');
  return encodeBase64(bytes);
}

export type SharedInvite = { pair: string; join: string; psk: string };

function validateInvite(invite: SharedInvite): SharedInvite {
  token(invite.pair, 16);
  token(invite.join, 32);
  token(invite.psk, 32);
  return invite;
}

/** Build the exact v2 connection URL. The caller supplies the configured /send URL. */
export function buildSharedInviteUrl(senderUrl: string, invite: SharedInvite): string {
  validateInvite(invite);
  const url = new URL(senderUrl);
  if (url.username || url.password || url.search || url.hash) throw new ProtocolError();
  const fragment = new URLSearchParams({
    v: SHARE_INVITE_VERSION,
    pair: invite.pair,
    join: invite.join,
    psk: invite.psk,
  });
  url.hash = fragment.toString();
  return url.href;
}

/**
 * Recognize a shared invite only at the configured same-origin sender URL. Once this function
 * recognizes v=2, malformed secrets fail closed and must never be treated as ordinary QR text.
 */
export function parseSharedInviteUrl(value: string, configuredSenderUrl: string): SharedInvite {
  if (value.length > 2048) throw new ProtocolError('PAIR_LINK_INVALID');
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(value);
    expected = new URL(configuredSenderUrl);
  } catch {
    throw new ProtocolError('PAIR_LINK_INVALID');
  }
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname ||
    actual.username ||
    actual.password ||
    actual.search ||
    expected.username ||
    expected.password ||
    expected.search ||
    expected.hash
  )
    throw new ProtocolError('PAIR_LINK_INVALID');
  const params = new URLSearchParams(actual.hash.slice(1));
  if (actual.hash.includes('%')) throw new ProtocolError('PAIR_LINK_INVALID');
  const keys = [...params.keys()];
  if (
    keys.length !== 4 ||
    new Set(keys).size !== 4 ||
    !['v', 'pair', 'join', 'psk'].every((key) => params.has(key))
  )
    throw new ProtocolError('PAIR_LINK_INVALID');
  if (params.get('v') !== SHARE_INVITE_VERSION) throw new ProtocolError('VERSION_UNSUPPORTED');
  try {
    return validateInvite({
      pair: params.get('pair')!,
      join: params.get('join')!,
      psk: params.get('psk')!,
    });
  } catch {
    throw new ProtocolError('PAIR_LINK_INVALID');
  }
}

export function isSharedInviteCandidate(value: string, configuredSenderUrl: string): boolean {
  try {
    const actual = new URL(value);
    const expected = new URL(configuredSenderUrl);
    const params = new URLSearchParams(actual.hash.slice(1));
    return (
      actual.origin === expected.origin && actual.pathname === expected.pathname && params.has('v')
    );
  } catch {
    return false;
  }
}

export type PairingAppMessage =
  | { type: 'ready' | 'ready_ack' }
  | { type: 'p.hello'; idPub: string; labelB64: string; client: string }
  | {
      type: 'p.invite';
      network: string;
      memberId: string;
      memberCap: string;
      controllerPub: string;
      controllerId: string;
      controllerIdPub: string;
      epoch: number;
      members: string[];
    }
  | { type: 'p.accept' | 'p.reject'; memberId: string };

export function validatePairingAppMessage(value: unknown): PairingAppMessage {
  plainObject(value);
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
    case 'ready_ack':
      exact(message, ['type']);
      break;
    case 'p.hello': {
      exact(message, ['type', 'idPub', 'labelB64', 'client']);
      token(message.idPub, 65);
      decodeDisplayText(message.labelB64, SC.MAX_LABEL_UTF8_BYTES);
      if (
        typeof message.client !== 'string' ||
        !/^[\x21-\x7e]{1,64}$/u.test(message.client) ||
        sharedUtf8(message.client).length > SC.MAX_CLIENT_LABEL_BYTES
      )
        throw new ProtocolError();
      break;
    }
    case 'p.invite': {
      exact(message, [
        'type',
        'network',
        'memberId',
        'memberCap',
        'controllerPub',
        'controllerId',
        'controllerIdPub',
        'epoch',
        'members',
      ]);
      token(message.network, 16);
      token(message.memberId, 16);
      token(message.memberCap, 32);
      token(message.controllerPub, 65);
      token(message.controllerId, 16);
      token(message.controllerIdPub, 65);
      integer(message.epoch);
      if (!Array.isArray(message.members) || message.members.length > SC.MAX_MEMBERS)
        throw new ProtocolError();
      const seen = new Set<string>();
      for (const member of message.members) {
        token(member, 16);
        if (seen.has(member)) throw new ProtocolError();
        seen.add(member);
      }
      break;
    }
    case 'p.accept':
    case 'p.reject':
      exact(message, ['type', 'memberId']);
      token(message.memberId, 16);
      break;
    default:
      throw new ProtocolError();
  }
  return value as PairingAppMessage;
}

export type SharedPairingKeys = {
  s2r: CryptoKey;
  r2s: CryptoKey;
  proof: CryptoKey;
  transcript: Uint8Array<ArrayBuffer>;
};

export async function deriveSharedPairingKeys(
  psk: string,
  pair: string,
  peer: string,
  rNonce: string,
  sNonce: string,
): Promise<SharedPairingKeys> {
  token(psk, 32);
  token(pair, 16);
  token(peer, 16);
  token(rNonce, 32);
  token(sNonce, 32);
  const transcript = sharedUtf8(`${SHARE_PROTOCOL}\n${pair}\n${peer}\n${rNonce}\n${sNonce}\n`);
  const salt = await crypto.subtle.digest('SHA-256', transcript);
  const base = await crypto.subtle.importKey('raw', decodeBase64(psk, 32), 'HKDF', false, [
    'deriveKey',
  ]);
  const params = (purpose: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info: sharedUtf8(`${SHARE_PROTOCOL}/${purpose}`),
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

function pairingProofInput(keys: SharedPairingKeys, role: 'sender' | 'receiver') {
  const prefix = sharedUtf8(`${role}\n`);
  const input = new Uint8Array(prefix.length + keys.transcript.length);
  input.set(prefix);
  input.set(keys.transcript, prefix.length);
  return input;
}

export async function makeSharedPairingProof(
  keys: SharedPairingKeys,
  role: 'sender' | 'receiver',
): Promise<string> {
  return encodeBase64(
    new Uint8Array(await crypto.subtle.sign('HMAC', keys.proof, pairingProofInput(keys, role))),
  );
}

export async function verifySharedPairingProof(
  keys: SharedPairingKeys,
  role: 'sender' | 'receiver',
  proof: string,
): Promise<boolean> {
  return crypto.subtle.verify(
    'HMAC',
    keys.proof,
    decodeBase64(proof, 32),
    pairingProofInput(keys, role),
  );
}

function aesParams(aad: Uint8Array<ArrayBuffer>, seq: bigint) {
  if (seq < 0n || seq > maxUint64) throw new ProtocolError();
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, seq, false);
  return { name: 'AES-GCM' as const, iv, additionalData: aad, tagLength: 128 };
}

export class SharedPairingCipher {
  private sendSeq = 0n;
  private receiveSeq = 0n;
  private readonly sendDirection: 's2r' | 'r2s';
  private readonly receiveDirection: 's2r' | 'r2s';

  constructor(
    private readonly pair: string,
    private readonly peer: string,
    role: 'receiver' | 'sender',
    private readonly keys: Pick<SharedPairingKeys, 's2r' | 'r2s'>,
  ) {
    token(pair, 16);
    token(peer, 16);
    this.sendDirection = role === 'sender' ? 's2r' : 'r2s';
    this.receiveDirection = role === 'sender' ? 'r2s' : 's2r';
  }

  private params(direction: 's2r' | 'r2s', seq: bigint) {
    return aesParams(
      sharedUtf8(`${SHARE_PROTOCOL}/cipher\n${this.pair}\n${this.peer}\n${direction}\n${seq}\n`),
      seq,
    );
  }

  private direction(direction: 's2r' | 'r2s', seq: bigint, message: PairingAppMessage): void {
    if (seq === 0n) {
      if (message.type !== (direction === 's2r' ? 'ready' : 'ready_ack')) throw new ProtocolError();
      return;
    }
    if (direction === 's2r') {
      if (seq !== 1n || message.type !== 'p.invite') throw new ProtocolError();
    } else if (
      (seq === 1n && message.type !== 'p.hello') ||
      (seq === 2n && !['p.accept', 'p.reject'].includes(message.type)) ||
      seq > 2n
    )
      throw new ProtocolError();
  }

  async encrypt(message: PairingAppMessage): Promise<Envelope> {
    validatePairingAppMessage(message);
    this.direction(this.sendDirection, this.sendSeq, message);
    const bytes = sharedUtf8(JSON.stringify(message));
    if (bytes.length > SC.NETWORK_MAX_PLAINTEXT_BYTES || this.sendSeq > maxUint64)
      throw new ProtocolError();
    const seq = this.sendSeq++;
    const encrypted = await crypto.subtle.encrypt(
      this.params(this.sendDirection, seq),
      this.keys[this.sendDirection],
      bytes,
    );
    return {
      v: 1,
      type: 'cipher',
      room: this.pair,
      peer: this.peer,
      dir: this.sendDirection,
      seq: String(seq),
      ct: encodeBase64(new Uint8Array(encrypted)),
    };
  }

  async decrypt(value: unknown): Promise<PairingAppMessage> {
    plainObject(value);
    exact(value, ['v', 'type', 'room', 'peer', 'dir', 'seq', 'ct']);
    if (
      value.v !== 1 ||
      value.type !== 'cipher' ||
      value.room !== this.pair ||
      value.peer !== this.peer ||
      value.dir !== this.receiveDirection ||
      parseSequence(value.seq) !== this.receiveSeq ||
      typeof value.ct !== 'string'
    )
      throw new ProtocolError();
    let result: PairingAppMessage;
    try {
      const ciphertext = decodeBase64(value.ct);
      if (ciphertext.length < 16 || ciphertext.length > SC.NETWORK_MAX_PLAINTEXT_BYTES + 16)
        throw new ProtocolError();
      const decrypted = await crypto.subtle.decrypt(
        this.params(this.receiveDirection, this.receiveSeq),
        this.keys[this.receiveDirection],
        ciphertext,
      );
      result = validatePairingAppMessage(
        JSON.parse(fatalDecoder.decode(new Uint8Array(decrypted))),
      );
      this.direction(this.receiveDirection, this.receiveSeq, result);
    } catch {
      throw new ProtocolError('CRYPTO_ERROR');
    }
    this.receiveSeq++;
    return result;
  }
}

export type EcdhIdentity = { privateKey: CryptoKey; publicKey: CryptoKey; publicRaw: string };
export type SigningIdentity = { privateKey: CryptoKey; publicKey: CryptoKey; publicRaw: string };

export async function generateEcdhIdentity(): Promise<EcdhIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicRaw: encodeBase64(
      new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    ),
  };
}

export async function generateSigningIdentity(): Promise<SigningIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicRaw: encodeBase64(
      new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    ),
  };
}

async function importPublic(
  value: string,
  algorithm: 'ECDH' | 'ECDSA',
  usages: readonly string[],
): Promise<CryptoKey> {
  const raw = decodeBase64(value, 65);
  if (raw[0] !== 4) throw new ProtocolError();
  try {
    return await crypto.subtle.importKey(
      'raw',
      raw,
      { name: algorithm, namedCurve: 'P-256' } as never,
      true,
      usages as never,
    );
  } catch {
    throw new ProtocolError('CRYPTO_ERROR');
  }
}

export const importEcdhPublic = (value: string) => importPublic(value, 'ECDH', []);
export const importSigningPublic = (value: string) => importPublic(value, 'ECDSA', ['verify']);

export type MemberAddition = {
  network: string;
  memberId: string;
  idPub: string;
  labelB64: string;
};

function validateMemberAddition(value: MemberAddition): void {
  token(value.network, 16);
  token(value.memberId, 16);
  token(value.idPub, 65);
  decodeDisplayText(value.labelB64, SC.MAX_LABEL_UTF8_BYTES);
}

function memberAdditionInput(value: MemberAddition): Uint8Array<ArrayBuffer> {
  validateMemberAddition(value);
  return sharedUtf8(
    `${SHARE_PROTOCOL}/member-add\n${value.network}\n${value.memberId}\n${value.idPub}\n${value.labelB64}\n`,
  );
}

export async function signMemberAddition(
  privateKey: CryptoKey,
  value: MemberAddition,
): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      memberAdditionInput(value),
    ),
  );
  if (signature.length !== 64) throw new ProtocolError('CRYPTO_ERROR');
  return encodeBase64(signature);
}

export async function verifyMemberAddition(
  publicKey: CryptoKey,
  value: MemberAddition,
  signature: string,
): Promise<boolean> {
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    decodeBase64(signature, 64),
    memberAdditionInput(value),
  );
}

export async function deriveNetworkCode(network: string, controllerPub: string): Promise<string> {
  token(network, 16);
  const publicBytes = decodeBase64(controllerPub, 65);
  if (publicBytes[0] !== 4) throw new ProtocolError();
  const prefix = sharedUtf8(`${SHARE_PROTOCOL}/network-code\n${network}\n`);
  const input = new Uint8Array(prefix.length + publicBytes.length);
  input.set(prefix);
  input.set(publicBytes, prefix.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let bits = 0n;
  for (const byte of hash.slice(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let shift = 35n; shift >= 0n; shift -= 5n) code += alphabet[Number((bits >> shift) & 31n)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function hkdfAes(
  keyMaterial: BufferSource,
  salt: BufferSource,
  info: BufferSource,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', keyMaterial, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function deriveUnicastKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  network: string,
  from: string,
  to: string,
): Promise<CryptoKey> {
  token(network, 16);
  token(from, 16);
  token(to, 16);
  const [lo, hi] = [from, to].sort();
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey } as never,
    privateKey,
    256,
  );
  const transcript = sharedUtf8(`${SHARE_PROTOCOL}/pair-key\n${network}\n${lo}\n${hi}\n`);
  const salt = await crypto.subtle.digest('SHA-256', transcript);
  return hkdfAes(secret, salt, sharedUtf8(`${SHARE_PROTOCOL}/ucast/${from}>${to}`));
}

export type UcastAppMessage =
  | { type: 'key.share'; id: string; epoch: number; senderKey: string }
  | { type: 'receipt'; id: string; status: 'ok' }
  | { type: 'receipt'; id: string; status: 'rejected'; code: string }
  | { type: 'progress'; transferId: string; upTo: number }
  | { type: 'target'; active: boolean }
  | { type: 'mode'; value: 'auto_open' | 'display_only' }
  | { type: 'status'; state: 'scanning' | 'scanned' | 'ready' }
  | { type: 'activity' }
  | { type: 'data'; id: string; textB64: string }
  | { type: 'ack'; id: string; status: 'received' }
  | { type: 'ack'; id: string; status: 'rejected'; reason: 'unsupported_content' }
  | { type: 'ack_seen'; id: string };

export function validateUcastAppMessage(value: unknown): UcastAppMessage {
  plainObject(value);
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'key.share':
      exact(message, ['type', 'id', 'epoch', 'senderKey']);
      token(message.id, 16);
      integer(message.epoch);
      token(message.senderKey, 32);
      break;
    case 'receipt':
      if (message.status === 'ok') exact(message, ['type', 'id', 'status']);
      else if (message.status === 'rejected') {
        exact(message, ['type', 'id', 'status', 'code']);
        if (
          typeof message.code !== 'string' ||
          !['RECEIVER_FULL', 'CONTENT_INVALID', 'CONTENT_TOO_LARGE', 'CANCELED'].includes(
            message.code,
          )
        )
          throw new ProtocolError();
      } else throw new ProtocolError();
      token(message.id, 16);
      break;
    case 'progress':
      exact(message, ['type', 'transferId', 'upTo']);
      token(message.transferId, 16);
      integer(message.upTo, Math.ceil(SC.MAX_SEND_BYTES / SC.FILE_CHUNK_BYTES));
      break;
    case 'target':
      exact(message, ['type', 'active']);
      if (typeof message.active !== 'boolean') throw new ProtocolError();
      break;
    case 'mode':
      exact(message, ['type', 'value']);
      if (!['auto_open', 'display_only'].includes(message.value as string))
        throw new ProtocolError();
      break;
    case 'status':
      exact(message, ['type', 'state']);
      if (!['scanning', 'scanned', 'ready'].includes(message.state as string))
        throw new ProtocolError();
      break;
    case 'activity':
      exact(message, ['type']);
      break;
    case 'data':
      exact(message, ['type', 'id', 'textB64']);
      token(message.id, 16);
      decodeUtf8(message.textB64, 16384);
      break;
    case 'ack':
      if (message.status === 'received') exact(message, ['type', 'id', 'status']);
      else if (message.status === 'rejected' && message.reason === 'unsupported_content')
        exact(message, ['type', 'id', 'status', 'reason']);
      else throw new ProtocolError();
      token(message.id, 16);
      break;
    case 'ack_seen':
      exact(message, ['type', 'id']);
      token(message.id, 16);
      break;
    default:
      throw new ProtocolError();
  }
  return value as UcastAppMessage;
}

export class UnicastChannel {
  private sendSequence = 0n;
  private receiveSequence = 0n;

  private constructor(
    private readonly network: string,
    private readonly self: string,
    private readonly peer: string,
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
  ) {}

  static async create(
    network: string,
    self: string,
    privateKey: CryptoKey,
    peer: string,
    peerPublicKey: CryptoKey,
  ): Promise<UnicastChannel> {
    const [sendKey, receiveKey] = await Promise.all([
      deriveUnicastKey(privateKey, peerPublicKey, network, self, peer),
      deriveUnicastKey(privateKey, peerPublicKey, network, peer, self),
    ]);
    return new UnicastChannel(network, self, peer, sendKey, receiveKey);
  }

  private params(from: string, to: string, sequence: bigint) {
    return aesParams(
      sharedUtf8(`${SHARE_PROTOCOL}/ucast\n${this.network}\n${from}\n${to}\n${sequence}\n`),
      sequence,
    );
  }

  async encrypt(message: UcastAppMessage): Promise<{ seq: string; ct: string }> {
    validateUcastAppMessage(message);
    const plaintext = sharedUtf8(JSON.stringify(message));
    if (plaintext.length > SC.NETWORK_MAX_PLAINTEXT_BYTES || this.sendSequence > maxUint64)
      throw new ProtocolError();
    const sequence = this.sendSequence++;
    const ciphertext = await crypto.subtle.encrypt(
      this.params(this.self, this.peer, sequence),
      this.sendKey,
      plaintext,
    );
    return { seq: String(sequence), ct: encodeBase64(new Uint8Array(ciphertext)) };
  }

  async decrypt(sequenceValue: unknown, ciphertextValue: unknown): Promise<UcastAppMessage> {
    const sequence = parseSequence(sequenceValue);
    if (sequence !== this.receiveSequence || typeof ciphertextValue !== 'string')
      throw new ProtocolError();
    try {
      const ciphertext = decodeBase64(ciphertextValue);
      if (ciphertext.length < 16 || ciphertext.length > SC.NETWORK_MAX_PLAINTEXT_BYTES + 16)
        throw new ProtocolError();
      const plaintext = await crypto.subtle.decrypt(
        this.params(this.peer, this.self, sequence),
        this.receiveKey,
        ciphertext,
      );
      const message = validateUcastAppMessage(
        JSON.parse(fatalDecoder.decode(new Uint8Array(plaintext))),
      );
      this.receiveSequence++;
      return message;
    } catch {
      throw new ProtocolError('CRYPTO_ERROR');
    }
  }
}

export const createUnicastChannel = UnicastChannel.create;

export type BcastAppMessage =
  | { type: 'text'; id: string; textB64: string }
  | {
      type: 'file.offer';
      transferId: string;
      batchId: string;
      nameB64: string;
      size: number;
      mime: string;
      chunks: number;
    }
  | { type: 'file.chunk'; transferId: string; index: number; dataB64: string }
  | { type: 'file.end' | 'file.cancel'; transferId: string };

function validateFileName(value: unknown): void {
  const name = decodeUtf8(value, SC.MAX_FILE_NAME_UTF8_BYTES);
  if (hasForbiddenDisplayCharacters(name)) throw new ProtocolError();
}

function validateMime(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !wellFormed(value) ||
    sharedUtf8(value).length > SC.MAX_MIME_UTF8_BYTES ||
    hasForbiddenDisplayCharacters(value)
  )
    throw new ProtocolError();
}

export function validateBcastAppMessage(value: unknown): BcastAppMessage {
  plainObject(value);
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'text':
      exact(message, ['type', 'id', 'textB64']);
      token(message.id, 16);
      decodeUtf8(message.textB64, SC.MAX_SHARED_TEXT_UTF8_BYTES);
      break;
    case 'file.offer': {
      exact(message, ['type', 'transferId', 'batchId', 'nameB64', 'size', 'mime', 'chunks']);
      token(message.transferId, 16);
      token(message.batchId, 16);
      validateFileName(message.nameB64);
      integer(message.size, SC.MAX_SEND_BYTES);
      validateMime(message.mime);
      integer(message.chunks, Math.ceil(SC.MAX_SEND_BYTES / SC.FILE_CHUNK_BYTES));
      if (message.chunks !== Math.ceil((message.size as number) / SC.FILE_CHUNK_BYTES))
        throw new ProtocolError();
      break;
    }
    case 'file.chunk': {
      exact(message, ['type', 'transferId', 'index', 'dataB64']);
      token(message.transferId, 16);
      integer(message.index, Math.ceil(SC.MAX_SEND_BYTES / SC.FILE_CHUNK_BYTES) - 1);
      if (typeof message.dataB64 !== 'string') throw new ProtocolError();
      const bytes = decodeBase64(message.dataB64);
      if (!bytes.length || bytes.length > SC.FILE_CHUNK_BYTES) throw new ProtocolError();
      break;
    }
    case 'file.end':
    case 'file.cancel':
      exact(message, ['type', 'transferId']);
      token(message.transferId, 16);
      break;
    default:
      throw new ProtocolError();
  }
  return value as BcastAppMessage;
}

export const encodeSharedText = (value: string) => encodeUtf8(value, SC.MAX_SHARED_TEXT_UTF8_BYTES);
export const decodeSharedText = (value: string) => decodeUtf8(value, SC.MAX_SHARED_TEXT_UTF8_BYTES);
export const encodeFileName = (value: string) => {
  if (hasForbiddenDisplayCharacters(value)) throw new ProtocolError('CONTENT_INVALID');
  return encodeUtf8(value, SC.MAX_FILE_NAME_UTF8_BYTES);
};
export const decodeFileName = (value: string) => {
  const result = decodeUtf8(value, SC.MAX_FILE_NAME_UTF8_BYTES);
  if (hasForbiddenDisplayCharacters(result)) throw new ProtocolError();
  return result;
};
export const encodeMemberLabel = (value: string) =>
  encodeDisplayText(value, SC.MAX_LABEL_UTF8_BYTES);

export function generateSenderSecret(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function deriveBroadcastKey(
  senderSecret: string,
  network: string,
  from: string,
  epoch: number,
): Promise<CryptoKey> {
  token(senderSecret, 32);
  token(network, 16);
  token(from, 16);
  integer(epoch);
  const salt = await crypto.subtle.digest(
    'SHA-256',
    sharedUtf8(`${SHARE_PROTOCOL}/bcast\n${network}\n${from}\n${epoch}\n`),
  );
  return hkdfAes(decodeBase64(senderSecret, 32), salt, sharedUtf8(`${SHARE_PROTOCOL}/bcast`));
}

function broadcastParams(network: string, from: string, epoch: number, sequence: bigint) {
  return aesParams(
    sharedUtf8(`${SHARE_PROTOCOL}/bcast\n${network}\n${epoch}\n${from}\n${sequence}\n`),
    sequence,
  );
}

export class BroadcastSender {
  private sequence = 0n;

  private constructor(
    private readonly network: string,
    private readonly from: string,
    readonly epoch: number,
    readonly senderSecret: string,
    private readonly key: CryptoKey,
  ) {}

  static async create(
    network: string,
    from: string,
    epoch: number,
    senderSecret = generateSenderSecret(),
  ): Promise<BroadcastSender> {
    return new BroadcastSender(
      network,
      from,
      epoch,
      senderSecret,
      await deriveBroadcastKey(senderSecret, network, from, epoch),
    );
  }

  async encrypt(message: BcastAppMessage): Promise<{ epoch: number; seq: string; ct: string }> {
    validateBcastAppMessage(message);
    const plaintext = sharedUtf8(JSON.stringify(message));
    if (plaintext.length > SC.NETWORK_MAX_PLAINTEXT_BYTES || this.sequence > maxUint64)
      throw new ProtocolError();
    const sequence = this.sequence++;
    const ciphertext = await crypto.subtle.encrypt(
      broadcastParams(this.network, this.from, this.epoch, sequence),
      this.key,
      plaintext,
    );
    return {
      epoch: this.epoch,
      seq: String(sequence),
      ct: encodeBase64(new Uint8Array(ciphertext)),
    };
  }
}

export class BroadcastReceiver {
  private sequence = 0n;

  private constructor(
    private readonly network: string,
    private readonly from: string,
    readonly epoch: number,
    private readonly key: CryptoKey,
  ) {}

  static async create(
    network: string,
    from: string,
    epoch: number,
    senderSecret: string,
  ): Promise<BroadcastReceiver> {
    return new BroadcastReceiver(
      network,
      from,
      epoch,
      await deriveBroadcastKey(senderSecret, network, from, epoch),
    );
  }

  async decrypt(sequenceValue: unknown, ciphertextValue: unknown): Promise<BcastAppMessage> {
    const sequence = parseSequence(sequenceValue);
    if (sequence !== this.sequence || typeof ciphertextValue !== 'string')
      throw new ProtocolError();
    try {
      const ciphertext = decodeBase64(ciphertextValue);
      if (ciphertext.length < 16 || ciphertext.length > SC.NETWORK_MAX_PLAINTEXT_BYTES + 16)
        throw new ProtocolError();
      const plaintext = await crypto.subtle.decrypt(
        broadcastParams(this.network, this.from, this.epoch, sequence),
        this.key,
        ciphertext,
      );
      const message = validateBcastAppMessage(
        JSON.parse(fatalDecoder.decode(new Uint8Array(plaintext))),
      );
      this.sequence++;
      return message;
    } catch {
      throw new ProtocolError('CRYPTO_ERROR');
    }
  }
}
