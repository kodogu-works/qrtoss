import { SC, SHARED_ERROR_CODES } from './shared-constants.ts';
import { SHARED_CONTROL_SCHEMAS } from './shared-control.generated.ts';
import { ProtocolError, decodeBase64, exact, parseSequence } from './validation.ts';

export type SharedControlTarget = 'server' | 'controller' | 'member';
export type SharedRole = 'controller' | 'member';
export type MemberRemovalReason = 'left' | 'kicked' | 'disconnected' | 'slow_peer';

export type SharedMemberEntry = {
  memberId: string;
  idPub: string;
  labelB64: string;
  sig: string;
};

type AuthOkBase = {
  v: 1;
  type: 'auth.ok';
  role: SharedRole;
  network: string;
  epoch: number;
  members: SharedMemberEntry[];
  controllerPresent: boolean;
  admissionsOpen: boolean;
  serverTime: number;
  idleExpiresAt: number;
  maxExpiresAt: number;
};

export type SharedControlMessage =
  | { v: 1; type: 'auth'; role: SharedRole; network: string; cap: string }
  | (AuthOkBase & { role: 'controller'; controllerId: string })
  | (AuthOkBase & { role: 'member'; memberId: string })
  | { v: 1; type: 'hb.ping'; id: number }
  | { v: 1; type: 'hb.pong'; id: number; serverTime: number }
  | ({ v: 1; type: 'member.invite' } & SharedMemberEntry)
  | {
      v: 1;
      type: 'member.invited';
      memberId: string;
      memberCap: string;
      memberExpiresAt: number;
    }
  | { v: 1; type: 'member.revoke' | 'member.kick'; memberId: string }
  | { v: 1; type: 'member.revoked'; memberId: string; code: 'INVITE_EXPIRED' | 'REVOKED' }
  | ({ v: 1; type: 'controller.join' } & SharedMemberEntry)
  | { v: 1; type: 'controller.part' | 'net.leave' | 'net.close' | 'net.touch' }
  | { v: 1; type: 'net.admissions'; open: boolean }
  | ({ v: 1; type: 'member.added'; epoch: number } & SharedMemberEntry)
  | {
      v: 1;
      type: 'member.removed';
      epoch: number;
      memberId: string;
      reason: MemberRemovalReason;
    }
  | { v: 1; type: 'controller.gone' }
  | {
      v: 1;
      type: 'net.state';
      epoch: number;
      admissionsOpen: boolean;
      controllerMemberId: string | null;
      members: string[];
      pending: string[];
    }
  | { v: 1; type: 'net.touched'; serverTime: number; idleExpiresAt: number }
  | { v: 1; type: 'net.closed'; code: string }
  | { v: 1; type: 'ucast'; as: SharedRole; to: string; seq: string; ct: string }
  | {
      v: 1;
      type: 'ucast';
      network: string;
      from: string;
      to: string;
      seq: string;
      ct: string;
    }
  | { v: 1; type: 'bcast'; epoch: number; seq: string; ct: string }
  | {
      v: 1;
      type: 'bcast';
      network: string;
      from: string;
      epoch: number;
      seq: string;
      ct: string;
    }
  | { v: 1; type: 'flow.ack'; bytes: number }
  | { v: 1; type: 'error'; code: string; scope: string };

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
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

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
    throw new ProtocolError();
}

function boolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new ProtocolError();
}

function token(value: unknown, bytes: number): asserts value is string {
  if (typeof value !== 'string') throw new ProtocolError();
  decodeBase64(value, bytes);
}

function ciphertext(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new ProtocolError();
  const bytes = decodeBase64(value);
  if (bytes.length < 16 || bytes.length > SC.NETWORK_MAX_PLAINTEXT_BYTES + 16)
    throw new ProtocolError();
}

export function decodeDisplayText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') throw new ProtocolError();
  const bytes = decodeBase64(value);
  if (!bytes.length || bytes.length > maxBytes) throw new ProtocolError();
  let result: string;
  try {
    result = fatalDecoder.decode(bytes);
  } catch {
    throw new ProtocolError();
  }
  if (hasForbiddenDisplayCharacters(result)) throw new ProtocolError();
  return result;
}

export function encodeDisplayText(value: string, maxBytes: number): string {
  if (typeof value !== 'string' || hasForbiddenDisplayCharacters(value))
    throw new ProtocolError('CONTENT_INVALID');
  // TextEncoder replaces lone surrogates, so reject them before encoding.
  if (/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, '')))
    throw new ProtocolError('CONTENT_INVALID');
  const bytes = encoder.encode(value);
  if (!bytes.length) throw new ProtocolError('CONTENT_EMPTY');
  if (bytes.length > maxBytes) throw new ProtocolError('CONTENT_TOO_LARGE');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function validateSharedMemberEntry(value: unknown): SharedMemberEntry {
  exact(value, ['memberId', 'idPub', 'labelB64', 'sig']);
  token(value.memberId, 16);
  token(value.idPub, 65);
  decodeDisplayText(value.labelB64, SC.MAX_LABEL_UTF8_BYTES);
  token(value.sig, 64);
  return value as SharedMemberEntry;
}

function members(value: unknown): asserts value is SharedMemberEntry[] {
  if (!Array.isArray(value) || value.length > SC.MAX_MEMBERS) throw new ProtocolError();
  const seen = new Set<string>();
  for (const item of value) {
    const entry = validateSharedMemberEntry(item);
    if (seen.has(entry.memberId)) throw new ProtocolError();
    seen.add(entry.memberId);
  }
}

function base(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError();
  const message = value as Record<string, unknown>;
  if (message.v !== 1 || typeof message.type !== 'string') throw new ProtocolError();
}

function validateAuthOk(message: Record<string, unknown>): void {
  const fields = [
    'v',
    'type',
    'role',
    'network',
    'epoch',
    'members',
    'controllerPresent',
    'admissionsOpen',
    'serverTime',
    'idleExpiresAt',
    'maxExpiresAt',
  ];
  if (message.role === 'member') fields.push('memberId');
  else if (message.role === 'controller') fields.push('controllerId');
  else throw new ProtocolError();
  exact(message, fields);
  token(message.network, 16);
  if (message.role === 'controller') token(message.controllerId, 16);
  if (message.role === 'member') token(message.memberId, 16);
  integer(message.epoch);
  members(message.members);
  boolean(message.controllerPresent);
  boolean(message.admissionsOpen);
  integer(message.serverTime);
  integer(message.idleExpiresAt);
  integer(message.maxExpiresAt);
}

/** Validate only the wire shape. Authorization and sequence ownership stay in the network core. */
export function validateSharedControlMessage(
  value: unknown,
  target: SharedControlTarget,
): SharedControlMessage {
  base(value);
  const message = value as Record<string, unknown>;
  const schema = SHARED_CONTROL_SCHEMAS.find(
    (candidate) =>
      candidate.type === message.type &&
      (candidate.targets as readonly string[]).includes(target) &&
      (!('when' in candidate) ||
        Object.entries(candidate.when).every(([field, expected]) => message[field] === expected)),
  );
  if (!schema) throw new ProtocolError();
  exact(message, ['v', 'type', ...schema.fields]);
  switch (message.type) {
    case 'auth':
      exact(message, ['v', 'type', 'role', 'network', 'cap']);
      if (!['controller', 'member'].includes(message.role as string)) throw new ProtocolError();
      token(message.network, 16);
      token(message.cap, 32);
      break;
    case 'auth.ok':
      validateAuthOk(message);
      if (message.role !== target) throw new ProtocolError();
      break;
    case 'hb.ping':
      exact(message, ['v', 'type', 'id']);
      integer(message.id, 0x7fffffff);
      break;
    case 'hb.pong':
      exact(message, ['v', 'type', 'id', 'serverTime']);
      integer(message.id, 0x7fffffff);
      integer(message.serverTime);
      break;
    case 'member.invite':
    case 'controller.join':
      exact(message, ['v', 'type', 'memberId', 'idPub', 'labelB64', 'sig']);
      validateSharedMemberEntry({
        memberId: message.memberId,
        idPub: message.idPub,
        labelB64: message.labelB64,
        sig: message.sig,
      });
      break;
    case 'member.invited':
      exact(message, ['v', 'type', 'memberId', 'memberCap', 'memberExpiresAt']);
      token(message.memberId, 16);
      token(message.memberCap, 32);
      integer(message.memberExpiresAt);
      break;
    case 'member.revoke':
    case 'member.kick':
      exact(message, ['v', 'type', 'memberId']);
      token(message.memberId, 16);
      break;
    case 'member.revoked':
      exact(message, ['v', 'type', 'memberId', 'code']);
      token(message.memberId, 16);
      if (!['INVITE_EXPIRED', 'REVOKED'].includes(message.code as string))
        throw new ProtocolError();
      break;
    case 'controller.part':
    case 'net.leave':
    case 'net.close':
    case 'net.touch':
    case 'controller.gone':
      exact(message, ['v', 'type']);
      break;
    case 'net.admissions':
      exact(message, ['v', 'type', 'open']);
      boolean(message.open);
      break;
    case 'member.added':
      exact(message, ['v', 'type', 'epoch', 'memberId', 'idPub', 'labelB64', 'sig']);
      integer(message.epoch);
      validateSharedMemberEntry({
        memberId: message.memberId,
        idPub: message.idPub,
        labelB64: message.labelB64,
        sig: message.sig,
      });
      break;
    case 'member.removed':
      exact(message, ['v', 'type', 'epoch', 'memberId', 'reason']);
      integer(message.epoch);
      token(message.memberId, 16);
      if (!['left', 'kicked', 'disconnected', 'slow_peer'].includes(message.reason as string))
        throw new ProtocolError();
      break;
    case 'net.state':
      exact(message, [
        'v',
        'type',
        'admissionsOpen',
        'epoch',
        'controllerMemberId',
        'members',
        'pending',
      ]);
      integer(message.epoch);
      boolean(message.admissionsOpen);
      if (message.controllerMemberId !== null) token(message.controllerMemberId, 16);
      for (const field of ['members', 'pending'] as const) {
        const ids = message[field];
        if (!Array.isArray(ids) || ids.length > SC.MAX_MEMBERS) throw new ProtocolError();
        const seen = new Set<string>();
        for (const id of ids) {
          token(id, 16);
          if (seen.has(id)) throw new ProtocolError();
          seen.add(id);
        }
      }
      break;
    case 'net.touched':
      exact(message, ['v', 'type', 'serverTime', 'idleExpiresAt']);
      integer(message.serverTime);
      integer(message.idleExpiresAt);
      break;
    case 'net.closed':
      exact(message, ['v', 'type', 'code']);
      if (
        typeof message.code !== 'string' ||
        !(SHARED_ERROR_CODES as readonly string[]).includes(message.code)
      )
        throw new ProtocolError();
      break;
    case 'ucast':
      if (target === 'server') {
        exact(message, ['v', 'type', 'as', 'to', 'seq', 'ct']);
        if (!['controller', 'member'].includes(message.as as string)) throw new ProtocolError();
      } else {
        exact(message, ['v', 'type', 'network', 'from', 'to', 'seq', 'ct']);
        token(message.network, 16);
        token(message.from, 16);
      }
      token(message.to, 16);
      parseSequence(message.seq);
      ciphertext(message.ct);
      break;
    case 'bcast':
      if (target === 'server') exact(message, ['v', 'type', 'epoch', 'seq', 'ct']);
      else {
        exact(message, ['v', 'type', 'network', 'from', 'epoch', 'seq', 'ct']);
        token(message.network, 16);
        token(message.from, 16);
      }
      integer(message.epoch);
      parseSequence(message.seq);
      ciphertext(message.ct);
      break;
    case 'flow.ack':
      exact(message, ['v', 'type', 'bytes']);
      integer(message.bytes);
      break;
    case 'error':
      exact(message, ['v', 'type', 'code', 'scope']);
      if (
        typeof message.code !== 'string' ||
        !(SHARED_ERROR_CODES as readonly string[]).includes(message.code) ||
        !['socket', 'network', 'invite', 'member', 'transfer'].includes(message.scope as string)
      )
        throw new ProtocolError();
      break;
    default:
      throw new ProtocolError();
  }
  return value as SharedControlMessage;
}
