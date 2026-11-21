import { bucket, SendBudget, take, type Bucket } from './limits.ts';
import { C } from '../../protocol/src/constants.ts';
import { SC } from '../../protocol/src/shared-constants.ts';
import { validateSharedControlMessage } from '../../protocol/src/shared-control.ts';

type Json = Record<string, unknown>;

export const NETWORK_LIMITS = {
  AUTH_TIMEOUT_SECONDS: C.AUTH_TIMEOUT_SECONDS,
  HEARTBEAT_TIMEOUT_SECONDS: C.HEARTBEAT_TIMEOUT_SECONDS,
  MEMBER_CAP_TTL_SECONDS: SC.MEMBER_CAP_TTL_SECONDS,
  MAX_MEMBERS: SC.MAX_MEMBERS,
  MAX_WS_MESSAGE_BYTES: SC.NETWORK_MAX_WS_MESSAGE_BYTES,
  MAX_CONTROL_MESSAGE_BYTES: SC.NETWORK_MAX_CONTROL_MESSAGE_BYTES,
  MAX_SOCKET_BUFFER_BYTES: SC.NETWORK_MAX_SOCKET_BUFFER_BYTES,
  MAX_RECEIVE_QUEUE_MESSAGES: C.MAX_RECEIVE_QUEUE_MESSAGES,
  MAX_OUTSTANDING_BYTES: SC.MAX_OUTSTANDING_BYTES,
  NETWORK_IDLE_SECONDS: SC.NETWORK_IDLE_SECONDS,
  NETWORK_MAX_SECONDS: SC.NETWORK_MAX_SECONDS,
  MESSAGE_RATE: SC.NETWORK_MESSAGE_RATE,
  MESSAGE_BURST: SC.NETWORK_MESSAGE_BURST,
  BCAST_BYTES_PER_SECOND: SC.NETWORK_BCAST_BYTES_PER_SECOND,
  BCAST_BYTES_BURST: SC.NETWORK_BCAST_BURST_BYTES,
  INVITES_PER_MINUTE: SC.MEMBER_INVITES_PER_MINUTE,
  MAX_EPOCH_SNAPSHOTS: SC.MAX_EPOCH_HISTORY,
} as const;

export interface NetworkRelaySocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(message: string): void;
  close(code?: number): void;
}

export type MemberRemovalReason = 'left' | 'kicked' | 'disconnected' | 'slow_peer';

export type NetworkMember = {
  memberId: string;
  idPub: string;
  labelB64: string;
  sig: string;
  client: NetworkClient;
};

type PendingMember = Omit<NetworkMember, 'client'> & {
  capHash: Uint8Array;
  expires: number;
  inviteEpoch: number;
};

type RetiredCapability = {
  code: 'MEMBER_CAP_EXPIRED' | 'MEMBER_CAP_USED';
  forgetAt: number;
};

export type Network = {
  id: string;
  controllerId: string;
  controllerHash?: Uint8Array;
  controller?: NetworkClient;
  controllerEverConnected: boolean;
  controllerMemberId?: string;
  admissionsOpen: boolean;
  epoch: number;
  idle: number;
  maximum: number;
  closed: boolean;
  members: Map<string, NetworkMember>;
  pending: Map<string, PendingMember>;
  retiredCaps: Map<string, RetiredCapability>;
  seen: Set<string>;
  snapshots: Map<number, Set<string>>;
  invites: Bucket;
};

export type NetworkClient = {
  ws: NetworkRelaySocket;
  ip: string;
  connected: number;
  heartbeat: number;
  lastPing: number;
  lastTouchReply: number;
  messages: Bucket;
  bcastBytes: Bucket;
  untrackedSendBudget?: SendBudget;
  authenticating: boolean;
  processing: boolean;
  queue: Promise<void>;
  queuedMessages: number;
  queuedBytes: number;
  closed: boolean;
  role?: 'controller' | 'member';
  network?: Network;
  memberId?: string;
  flowSent: number;
  flowAcked: number;
};

export interface NetworkCoreOptions {
  now(): number;
  wallNow(): number;
  random(bytes: number): string;
  digest(capability: string): Promise<Uint8Array>;
  equal(a: Uint8Array, b: Uint8Array): boolean | Promise<boolean>;
  canAuthenticate(ip: string): boolean | Promise<boolean>;
  authenticationFailed(ip: string): void;
  /** Adapters without bufferedAmount can bound non-flow-controlled server frames. */
  maxUntrackedSendBytes?: number;
  onNetworkClosed?(id: string): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MAX_RETIRED_CAPABILITIES = 64;

function hashKey(hash: Uint8Array) {
  let key = '';
  for (const byte of hash) key += byte.toString(16).padStart(2, '0');
  return key;
}

function isBase64(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value.length !== Math.ceil((bytes * 4) / 3)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const last = alphabet.indexOf(value.at(-1)!);
  return bytes % 3 === 1 ? (last & 15) === 0 : bytes % 3 === 2 ? (last & 3) === 0 : true;
}

function decodedLength(value: unknown, maximum: number, allowEmpty = false): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return false;
  if (!allowEmpty && value.length === 0) return false;
  if (value.length % 4 === 1) return false;
  const bytes = Math.floor((value.length * 3) / 4);
  if (bytes > maximum) return false;
  const last = alphabet.indexOf(value.at(-1) ?? 'A');
  const remainder = bytes % 3;
  return remainder === 1 ? (last & 15) === 0 : remainder === 2 ? (last & 3) === 0 : true;
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const padded =
      value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return;
  }
}

function isPublicKey(value: unknown): value is string {
  if (!isBase64(value, 65)) return false;
  return decodeBase64(value)?.[0] === 4;
}

function isLabel(value: unknown): value is string {
  if (!decodedLength(value, 32)) return false;
  try {
    const bytes = decodeBase64(value);
    if (!bytes) return false;
    const label = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return (
      label.length > 0 &&
      ![...label].some((character) => {
        const point = character.codePointAt(0)!;
        return (
          point <= 0x1f ||
          (point >= 0x7f && point <= 0x9f) ||
          point === 0x61c ||
          point === 0x200e ||
          point === 0x200f ||
          (point >= 0x202a && point <= 0x202e) ||
          (point >= 0x2066 && point <= 0x2069)
        );
      })
    );
  } catch {
    return false;
  }
}

function isSeq(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
  try {
    return BigInt(value) <= 0xffffffffffffffffn;
  } catch {
    return false;
  }
}

function object(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function exact(value: Json, fields: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

type MemberDeclaration = {
  v: 1;
  memberId: string;
  idPub: string;
  labelB64: string;
  sig: string;
};

type ClientMessage =
  | { v: 1; type: 'auth'; role: 'controller' | 'member'; network: string; cap: string }
  | { v: 1; type: 'hb.ping'; id: number }
  | (MemberDeclaration & { type: 'member.invite' })
  | (MemberDeclaration & { type: 'controller.join' })
  | { v: 1; type: 'member.revoke' | 'member.kick'; memberId: string }
  | { v: 1; type: 'net.admissions'; open: boolean }
  | { v: 1; type: 'net.close' | 'net.leave' | 'net.touch' | 'controller.part' }
  | { v: 1; type: 'ucast'; as: 'controller' | 'member'; to: string; seq: string; ct: string }
  | { v: 1; type: 'bcast'; epoch: number; seq: string; ct: string }
  | { v: 1; type: 'flow.ack'; bytes: number };

function validateMessage(value: unknown): ClientMessage | undefined {
  const m = object(value);
  if (m?.v !== 1 || typeof m.type !== 'string') return;
  switch (m.type) {
    case 'auth':
      if (
        exact(m, ['v', 'type', 'role', 'network', 'cap']) &&
        (m.role === 'controller' || m.role === 'member') &&
        isBase64(m.network, 16) &&
        isBase64(m.cap, 32)
      )
        return m as ClientMessage;
      return;
    case 'hb.ping':
      if (
        exact(m, ['v', 'type', 'id']) &&
        Number.isSafeInteger(m.id) &&
        (m.id as number) >= 0 &&
        (m.id as number) <= 2147483647
      )
        return m as ClientMessage;
      return;
    case 'member.invite':
    case 'controller.join':
      if (
        exact(m, ['v', 'type', 'memberId', 'idPub', 'labelB64', 'sig']) &&
        isBase64(m.memberId, 16) &&
        isPublicKey(m.idPub) &&
        isLabel(m.labelB64) &&
        isBase64(m.sig, 64)
      )
        return m as ClientMessage;
      return;
    case 'member.revoke':
    case 'member.kick':
      if (exact(m, ['v', 'type', 'memberId']) && isBase64(m.memberId, 16))
        return m as ClientMessage;
      return;
    case 'net.admissions':
      if (exact(m, ['v', 'type', 'open']) && typeof m.open === 'boolean') return m as ClientMessage;
      return;
    case 'net.close':
    case 'net.leave':
    case 'net.touch':
    case 'controller.part':
      return exact(m, ['v', 'type']) ? (m as ClientMessage) : undefined;
    case 'ucast':
      if (
        exact(m, ['v', 'type', 'as', 'to', 'seq', 'ct']) &&
        (m.as === 'controller' || m.as === 'member') &&
        isBase64(m.to, 16) &&
        isSeq(m.seq) &&
        decodedLength(m.ct, 22544)
      )
        return m as ClientMessage;
      return;
    case 'bcast':
      if (
        exact(m, ['v', 'type', 'epoch', 'seq', 'ct']) &&
        Number.isSafeInteger(m.epoch) &&
        (m.epoch as number) >= 0 &&
        isSeq(m.seq) &&
        decodedLength(m.ct, 22544)
      )
        return m as ClientMessage;
      return;
    case 'flow.ack':
      if (
        exact(m, ['v', 'type', 'bytes']) &&
        Number.isSafeInteger(m.bytes) &&
        (m.bytes as number) >= 0
      )
        return m as ClientMessage;
      return;
    default:
      return;
  }
}

/** Volatile shared-network state. Adapters own HTTP, upgrade routing, timers and crypto. */
export function createNetworkCore(options: NetworkCoreOptions) {
  const { now, wallNow } = options;
  const networks = new Map<string, Network>();
  const clients = new Set<NetworkClient>();
  const pendingSlowPeers = new Set<NetworkClient>();

  const deadline = (monotonic: number) => Math.round(wallNow() + Math.max(0, monotonic - now()));

  function createNetwork(id: string, controllerId: string, controllerHash: Uint8Array) {
    if (!isBase64(id, 16) || !isBase64(controllerId, 16) || controllerHash.byteLength !== 32)
      throw new Error('INVALID_NETWORK');
    if (networks.has(id)) throw new Error('NETWORK_ALREADY_CREATED');
    const t = now();
    const network: Network = {
      id,
      controllerId,
      controllerHash,
      controllerEverConnected: false,
      admissionsOpen: true,
      epoch: 0,
      idle: t + NETWORK_LIMITS.NETWORK_IDLE_SECONDS * 1000,
      maximum: t + NETWORK_LIMITS.NETWORK_MAX_SECONDS * 1000,
      closed: false,
      members: new Map(),
      pending: new Map(),
      retiredCaps: new Map(),
      seen: new Set(),
      snapshots: new Map([[0, new Set()]]),
      invites: bucket(t, NETWORK_LIMITS.INVITES_PER_MINUTE),
    };
    networks.set(id, network);
    return {
      serverTime: wallNow(),
      idleExpiresAt: deadline(network.idle),
      maxExpiresAt: deadline(network.maximum),
    };
  }

  function connect(ws: NetworkRelaySocket, ip: string): NetworkClient {
    const t = now();
    const client: NetworkClient = {
      ws,
      ip,
      connected: t,
      heartbeat: t,
      lastPing: -1,
      lastTouchReply: Number.NEGATIVE_INFINITY,
      messages: bucket(t, NETWORK_LIMITS.MESSAGE_BURST),
      bcastBytes: bucket(t, NETWORK_LIMITS.BCAST_BYTES_BURST),
      untrackedSendBudget:
        options.maxUntrackedSendBytes === undefined
          ? undefined
          : new SendBudget(
              options.maxUntrackedSendBytes,
              Math.min(
                2 * NETWORK_LIMITS.MAX_CONTROL_MESSAGE_BYTES,
                Math.floor(options.maxUntrackedSendBytes / 2),
              ),
            ),
      authenticating: false,
      processing: false,
      queue: Promise.resolve(),
      queuedMessages: 0,
      queuedBytes: 0,
      closed: false,
      flowSent: 0,
      flowAcked: 0,
    };
    clients.add(client);
    return client;
  }

  function memberView(member: NetworkMember) {
    return {
      memberId: member.memberId,
      idPub: member.idPub,
      labelB64: member.labelB64,
      sig: member.sig,
    };
  }

  function stateView(network: Network) {
    return {
      admissionsOpen: network.admissionsOpen,
      epoch: network.epoch,
      controllerMemberId: network.controllerMemberId ?? null,
      members: [...network.members.values()].map((member) => member.memberId),
      pending: [...network.pending.keys()],
    };
  }

  function sendRaw(client: NetworkClient | undefined, message: Json, trackFlow = false): boolean {
    if (!client || client.closed || client.ws.readyState !== 1) return false;
    const encoded = JSON.stringify(message);
    const bytes = encoder.encode(encoded).byteLength;
    const closing = message.type === 'error' || message.type === 'net.closed';
    if (
      (client.ws.bufferedAmount ?? 0) + bytes > NETWORK_LIMITS.MAX_SOCKET_BUFFER_BYTES ||
      (trackFlow &&
        client.flowSent - client.flowAcked + bytes > NETWORK_LIMITS.MAX_OUTSTANDING_BYTES) ||
      (!trackFlow && client.untrackedSendBudget && !client.untrackedSendBudget.take(bytes, closing))
    ) {
      deferSlowPeer(client);
      return false;
    }
    client.ws.send(encoded);
    if (trackFlow) client.flowSent += bytes;
    return true;
  }

  function notify(client: NetworkClient | undefined, type: string, fields: Json = {}) {
    return sendRaw(client, { v: 1, type, ...fields });
  }

  function touch(network: Network) {
    network.idle = Math.min(network.maximum, now() + NETWORK_LIMITS.NETWORK_IDLE_SECONDS * 1000);
  }

  function snapshot(network: Network) {
    network.snapshots.set(network.epoch, new Set(network.members.keys()));
    while (network.snapshots.size > NETWORK_LIMITS.MAX_EPOCH_SNAPSHOTS)
      network.snapshots.delete(network.snapshots.keys().next().value!);
  }

  function forEachClient(network: Network, callback: (client: NetworkClient) => void) {
    if (network.controller) callback(network.controller);
    for (const member of network.members.values())
      if (member.client !== network.controller) callback(member.client);
  }

  function notifyControllerState(network: Network) {
    notify(network.controller, 'net.state', stateView(network));
  }

  function expireRetiredCapabilities(network: Network) {
    const t = now();
    for (const [hash, retired] of network.retiredCaps)
      if (retired.forgetAt <= t) network.retiredCaps.delete(hash);
  }

  function retireCapability(
    network: Network,
    capHash: Uint8Array,
    code: RetiredCapability['code'],
  ) {
    expireRetiredCapabilities(network);
    const key = hashKey(capHash);
    network.retiredCaps.delete(key);
    network.retiredCaps.set(key, {
      code,
      forgetAt: Math.min(network.maximum, now() + NETWORK_LIMITS.MEMBER_CAP_TTL_SECONDS * 1000),
    });
    while (network.retiredCaps.size > MAX_RETIRED_CAPABILITIES)
      network.retiredCaps.delete(network.retiredCaps.keys().next().value!);
  }

  function retiredCapabilityCode(network: Network, capHash: Uint8Array) {
    expireRetiredCapabilities(network);
    return network.retiredCaps.get(hashKey(capHash))?.code;
  }

  function revokePendingMembers(network: Network, exceptMemberId?: string) {
    for (const memberId of [...network.pending.keys()]) {
      if (memberId === exceptMemberId) continue;
      network.pending.delete(memberId);
      notify(network.controller, 'member.revoked', { memberId, code: 'REVOKED' });
    }
  }

  function closeNetwork(
    network: Network,
    code: 'USER_END' | 'NETWORK_IDLE' | 'NETWORK_MAX' | 'CONTROLLER_GONE' | 'SERVER_SHUTDOWN',
  ) {
    if (network.closed) return;
    network.closed = true;
    networks.delete(network.id);
    const all = new Set<NetworkClient>();
    if (network.controller) all.add(network.controller);
    for (const member of network.members.values()) all.add(member.client);
    for (const client of all) {
      notify(client, 'net.closed', { code });
      client.network = undefined;
      client.memberId = undefined;
      client.role = undefined;
      client.closed = true;
      clients.delete(client);
      client.ws.close(1000);
    }
    network.controllerHash = undefined;
    network.controller = undefined;
    network.controllerMemberId = undefined;
    network.members.clear();
    network.pending.clear();
    network.retiredCaps.clear();
    network.snapshots.clear();
    network.seen.clear();
    options.onNetworkClosed?.(network.id);
  }

  function maybeCloseWithoutController(network: Network) {
    if (
      !network.closed &&
      network.controllerEverConnected &&
      !network.controller &&
      network.members.size <= 1
    )
      closeNetwork(network, 'CONTROLLER_GONE');
  }

  function broadcastMemberRemoved(network: Network, memberId: string, reason: MemberRemovalReason) {
    forEachClient(network, (client) =>
      notify(client, 'member.removed', { epoch: network.epoch, memberId, reason }),
    );
  }

  function removeMember(
    network: Network,
    memberId: string,
    reason: MemberRemovalReason,
    closeSocket: boolean,
  ) {
    const member = network.members.get(memberId);
    if (!member) return false;
    network.members.delete(memberId);
    if (network.controllerMemberId === memberId) network.controllerMemberId = undefined;
    if (member.client.memberId === memberId) member.client.memberId = undefined;
    network.epoch++;
    snapshot(network);
    // A capability is valid only for the exact membership snapshot in which it
    // was issued. Clear invitations before publishing the membership change so
    // the controller cannot distribute keys to a stale candidate.
    revokePendingMembers(network);
    broadcastMemberRemoved(network, memberId, reason);
    notifyControllerState(network);
    if (closeSocket && member.client.role === 'member') {
      member.client.network = undefined;
      member.client.role = undefined;
      member.client.closed = true;
      clients.delete(member.client);
      member.client.ws.close(reason === 'slow_peer' ? 1008 : 1000);
    }
    maybeCloseWithoutController(network);
    return true;
  }

  function detach(client: NetworkClient, reason: MemberRemovalReason) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    const network = client.network;
    client.network = undefined;
    if (!network || network.closed) return;
    if (client.role === 'controller') {
      if (network.controller === client) {
        if (network.controllerMemberId)
          removeMember(network, network.controllerMemberId, reason, false);
        network.controller = undefined;
        network.controllerHash = undefined;
        network.pending.clear();
        for (const member of network.members.values()) notify(member.client, 'controller.gone');
      }
      maybeCloseWithoutController(network);
    } else if (client.memberId) {
      removeMember(network, client.memberId, reason, false);
      maybeCloseWithoutController(network);
    }
    client.memberId = undefined;
    client.role = undefined;
  }

  function disconnect(client: NetworkClient) {
    detach(client, 'disconnected');
  }

  function slowPeer(client: NetworkClient) {
    if (client.closed) return;
    // Avoid recursively applying pressure while reporting the terminal error.
    if (client.ws.readyState === 1)
      client.ws.send(JSON.stringify({ v: 1, type: 'error', code: 'SLOW_PEER', scope: 'network' }));
    detach(client, 'slow_peer');
    client.ws.close(1008);
  }

  // Removing a slow member advances the epoch and emits member.removed. Doing that in the
  // middle of an earlier fan-out can make later recipients observe the new epoch before the
  // event currently being delivered. Drain slow removals only after the current broadcast stack.
  function deferSlowPeer(client: NetworkClient) {
    if (client.closed || pendingSlowPeers.has(client)) return;
    pendingSlowPeers.add(client);
    queueMicrotask(() => {
      pendingSlowPeers.delete(client);
      if (!client.closed) slowPeer(client);
    });
  }

  function fail(client: NetworkClient, code = 'PROTOCOL_ERROR', closeCode = 1008) {
    if (client.closed) return;
    notify(client, 'error', { code, scope: client.network ? 'network' : 'socket' });
    detach(client, 'disconnected');
    client.ws.close(closeCode);
  }

  function deny(client: NetworkClient) {
    notify(client, 'error', { code: 'FORBIDDEN', scope: 'network' });
  }

  function expireInvites(network: Network) {
    const t = now();
    let changed = false;
    for (const [memberId, pending] of network.pending) {
      if (t < pending.expires) continue;
      network.pending.delete(memberId);
      retireCapability(network, pending.capHash, 'MEMBER_CAP_EXPIRED');
      changed = true;
      notify(network.controller, 'member.revoked', { memberId, code: 'INVITE_EXPIRED' });
    }
    if (changed) notifyControllerState(network);
  }

  function live(network: Network) {
    if (network.closed) return false;
    expireRetiredCapabilities(network);
    if (now() >= network.maximum) {
      closeNetwork(network, 'NETWORK_MAX');
      return false;
    }
    if (now() >= network.idle) {
      closeNetwork(network, 'NETWORK_IDLE');
      return false;
    }
    expireInvites(network);
    return networks.has(network.id);
  }

  function sweep() {
    for (const network of [...networks.values()]) live(network);
    const t = now();
    for (const client of [...clients]) {
      if (
        (!client.role && t - client.connected >= NETWORK_LIMITS.AUTH_TIMEOUT_SECONDS * 1000) ||
        (client.role && t - client.heartbeat >= NETWORK_LIMITS.HEARTBEAT_TIMEOUT_SECONDS * 1000)
      )
        fail(client, client.role ? 'NETWORK_DISCONNECTED' : 'AUTH_FAILED');
    }
  }

  async function authenticate(
    client: NetworkClient,
    message: Extract<ClientMessage, { type: 'auth' }>,
  ) {
    if (!(await options.canAuthenticate(client.ip))) return fail(client, 'RATE_LIMITED');
    const actual = await options.digest(message.cap);
    const expectedNetwork = networks.get(message.network);
    if (client.closed || client.ws.readyState !== 1) return;
    if (!expectedNetwork || !live(expectedNetwork)) {
      options.authenticationFailed(client.ip);
      return fail(client, 'AUTH_FAILED');
    }

    if (message.role === 'controller') {
      const expected = expectedNetwork.controllerHash;
      const matches =
        !!expected &&
        expected.byteLength === actual.byteLength &&
        (await options.equal(expected, actual));
      if (client.closed || client.ws.readyState !== 1) return;
      const network = networks.get(message.network);
      if (
        !matches ||
        network !== expectedNetwork ||
        network.closed ||
        network.controllerHash !== expected ||
        network.controller
      ) {
        options.authenticationFailed(client.ip);
        return fail(client, 'AUTH_FAILED');
      }
      network.controller = client;
      network.controllerHash = undefined;
      network.controllerEverConnected = true;
      client.role = 'controller';
      client.network = network;
      client.heartbeat = now();
      notify(client, 'auth.ok', {
        role: 'controller',
        network: network.id,
        controllerId: network.controllerId,
        epoch: network.epoch,
        members: [...network.members.values()].map(memberView),
        controllerPresent: true,
        admissionsOpen: network.admissionsOpen,
        serverTime: wallNow(),
        idleExpiresAt: deadline(network.idle),
        maxExpiresAt: deadline(network.maximum),
      });
      return;
    }

    let expected: PendingMember | undefined;
    for (const pending of expectedNetwork.pending.values()) {
      if (
        pending.expires > now() &&
        pending.capHash.byteLength === actual.byteLength &&
        (await options.equal(pending.capHash, actual))
      ) {
        expected = pending;
        break;
      }
    }
    if (client.closed || client.ws.readyState !== 1) return;
    const network = networks.get(message.network);
    if (network === expectedNetwork && !network.closed) expireInvites(network);
    const pending = expected && network?.pending.get(expected.memberId);
    if (
      !network ||
      network !== expectedNetwork ||
      network.closed ||
      !network.admissionsOpen ||
      !expected ||
      pending !== expected ||
      expected.expires <= now() ||
      expected.inviteEpoch !== network.epoch ||
      network.members.size >= NETWORK_LIMITS.MAX_MEMBERS
    ) {
      options.authenticationFailed(client.ip);
      return fail(
        client,
        network === expectedNetwork && !network.closed
          ? (retiredCapabilityCode(network, actual) ?? 'AUTH_FAILED')
          : 'AUTH_FAILED',
      );
    }
    // Capability consumption and membership change happen synchronously after all awaits.
    network.pending.delete(expected.memberId);
    retireCapability(network, expected.capHash, 'MEMBER_CAP_USED');
    const member: NetworkMember = {
      memberId: expected.memberId,
      idPub: expected.idPub,
      labelB64: expected.labelB64,
      sig: expected.sig,
      client,
    };
    network.members.set(member.memberId, member);
    client.role = 'member';
    client.network = network;
    client.memberId = member.memberId;
    client.heartbeat = now();
    network.epoch++;
    snapshot(network);
    revokePendingMembers(network);
    touch(network);
    notify(client, 'auth.ok', {
      role: 'member',
      network: network.id,
      memberId: member.memberId,
      epoch: network.epoch,
      members: [...network.members.values()].map(memberView),
      controllerPresent: !!network.controller,
      admissionsOpen: network.admissionsOpen,
      serverTime: wallNow(),
      idleExpiresAt: deadline(network.idle),
      maxExpiresAt: deadline(network.maximum),
    });
    forEachClient(network, (target) => {
      if (target !== client)
        notify(target, 'member.added', { epoch: network.epoch, ...memberView(member) });
    });
    notifyControllerState(network);
  }

  async function invite(
    client: NetworkClient,
    message: Extract<ClientMessage, { type: 'member.invite' }>,
  ) {
    const network = client.network!;
    const inviteEpoch = network.epoch;
    if (
      !network.admissionsOpen ||
      network.members.size + network.pending.size >= NETWORK_LIMITS.MAX_MEMBERS ||
      network.seen.has(message.memberId)
    ) {
      return void notify(client, 'error', {
        code: network.seen.has(message.memberId)
          ? 'MEMBER_ID_REUSED'
          : network.admissionsOpen
            ? 'MEMBER_LIMIT'
            : 'ADMISSIONS_CLOSED',
        scope: 'invite',
      });
    }
    if (
      !take(
        network.invites,
        now(),
        NETWORK_LIMITS.INVITES_PER_MINUTE / 60,
        NETWORK_LIMITS.INVITES_PER_MINUTE,
      )
    )
      return void notify(client, 'error', { code: 'RATE_LIMITED', scope: 'invite' });
    const capability = options.random(32);
    if (!isBase64(capability, 32)) throw new Error('INVALID_RANDOM');
    const capHash = await options.digest(capability);
    if (client.closed || client.network !== network || !live(network)) return;
    if (network.epoch !== inviteEpoch)
      return void notify(client, 'error', { code: 'EPOCH_MISMATCH', scope: 'invite' });
    if (network.seen.has(message.memberId))
      return void notify(client, 'error', { code: 'MEMBER_ID_REUSED', scope: 'invite' });
    if (!network.admissionsOpen)
      return void notify(client, 'error', { code: 'ADMISSIONS_CLOSED', scope: 'invite' });
    if (network.members.size + network.pending.size >= NETWORK_LIMITS.MAX_MEMBERS)
      return void notify(client, 'error', { code: 'MEMBER_LIMIT', scope: 'invite' });
    const expires = Math.min(network.maximum, now() + NETWORK_LIMITS.MEMBER_CAP_TTL_SECONDS * 1000);
    const pending: PendingMember = {
      memberId: message.memberId,
      idPub: message.idPub,
      labelB64: message.labelB64,
      sig: message.sig,
      capHash,
      expires,
      inviteEpoch,
    };
    network.seen.add(message.memberId);
    network.pending.set(message.memberId, pending);
    touch(network);
    notify(client, 'member.invited', {
      memberId: message.memberId,
      memberCap: capability,
      memberExpiresAt: deadline(expires),
    });
    notifyControllerState(network);
  }

  function addControllerMember(
    client: NetworkClient,
    message: Extract<ClientMessage, { type: 'controller.join' }>,
  ) {
    const network = client.network!;
    if (
      network.controllerMemberId ||
      network.members.size + network.pending.size >= NETWORK_LIMITS.MAX_MEMBERS ||
      network.seen.has(message.memberId)
    ) {
      notify(client, 'error', {
        code: network.seen.has(message.memberId) ? 'MEMBER_ID_REUSED' : 'MEMBER_LIMIT',
        scope: 'member',
      });
      return;
    }
    const member: NetworkMember = {
      memberId: message.memberId,
      idPub: message.idPub,
      labelB64: message.labelB64,
      sig: message.sig,
      client,
    };
    network.seen.add(member.memberId);
    network.members.set(member.memberId, member);
    network.controllerMemberId = member.memberId;
    client.memberId = member.memberId;
    network.epoch++;
    snapshot(network);
    revokePendingMembers(network);
    touch(network);
    forEachClient(network, (target) =>
      notify(target, 'member.added', { epoch: network.epoch, ...memberView(member) }),
    );
    notifyControllerState(network);
  }

  function forwardUcast(client: NetworkClient, message: Extract<ClientMessage, { type: 'ucast' }>) {
    const network = client.network!;
    let from: string | undefined;
    if (client.role === 'member') {
      if (message.as !== 'member') return deny(client);
      from = client.memberId;
    } else if (message.as === 'controller') from = network.controllerId;
    else from = network.controllerMemberId;
    if (!from) return deny(client);
    let target: NetworkClient | undefined;
    if (message.to === network.controllerId) target = network.controller;
    else target = network.members.get(message.to)?.client;
    if (!target || target === client) {
      notify(client, 'error', { code: 'MEMBER_UNAVAILABLE', scope: 'member' });
      return;
    }
    sendRaw(
      target,
      {
        v: 1,
        type: 'ucast',
        network: network.id,
        from,
        to: message.to,
        seq: message.seq,
        ct: message.ct,
      },
      true,
    );
  }

  function forwardBcast(client: NetworkClient, message: Extract<ClientMessage, { type: 'bcast' }>) {
    const network = client.network!;
    const from = client.role === 'controller' ? network.controllerMemberId : client.memberId;
    const members = network.snapshots.get(message.epoch);
    if (!from || !members?.has(from)) return deny(client);
    const targets = [...members]
      .filter((memberId) => memberId !== from)
      .map((memberId) => network.members.get(memberId)?.client)
      .filter((target): target is NetworkClient => !!target);
    touch(network);
    for (const target of targets) {
      if (network.closed) break;
      sendRaw(
        target,
        {
          v: 1,
          type: 'bcast',
          network: network.id,
          from,
          epoch: message.epoch,
          seq: message.seq,
          ct: message.ct,
        },
        true,
      );
    }
  }

  async function authenticatedMessage(client: NetworkClient, message: ClientMessage) {
    const network = client.network;
    if (!network || !live(network)) return;
    if (message.type === 'auth') return fail(client);
    if (message.type === 'hb.ping') {
      if (message.id <= client.lastPing) return fail(client);
      client.lastPing = message.id;
      client.heartbeat = now();
      notify(client, 'hb.pong', { id: message.id, serverTime: wallNow() });
      return;
    }
    if (message.type === 'flow.ack') {
      if (message.bytes < client.flowAcked || message.bytes > client.flowSent) return fail(client);
      client.flowAcked = message.bytes;
      return;
    }
    if (message.type === 'ucast') return forwardUcast(client, message);
    if (message.type === 'bcast') return forwardBcast(client, message);
    if (message.type === 'net.touch') {
      touch(network);
      const t = now();
      if (t - client.lastTouchReply < C.TOUCH_COALESCE_SECONDS * 1000) return;
      client.lastTouchReply = t;
      notify(client, 'net.touched', {
        serverTime: wallNow(),
        idleExpiresAt: deadline(network.idle),
      });
      return;
    }
    if (client.role !== 'controller') {
      if (message.type === 'net.leave') {
        const memberId = client.memberId!;
        removeMember(network, memberId, 'left', true);
        return;
      }
      return deny(client);
    }
    switch (message.type) {
      case 'member.invite':
        await invite(client, message);
        return;
      case 'member.revoke':
        if (!network.pending.delete(message.memberId))
          return void notify(client, 'error', { code: 'MEMBER_UNAVAILABLE', scope: 'invite' });
        touch(network);
        notify(client, 'member.revoked', { memberId: message.memberId, code: 'REVOKED' });
        notifyControllerState(network);
        return;
      case 'member.kick': {
        const member = network.members.get(message.memberId);
        if (!member || member.client === client)
          return void notify(client, 'error', { code: 'MEMBER_UNAVAILABLE', scope: 'member' });
        touch(network);
        removeMember(network, message.memberId, 'kicked', true);
        return;
      }
      case 'net.admissions':
        network.admissionsOpen = message.open;
        touch(network);
        notifyControllerState(network);
        return;
      case 'net.close':
        closeNetwork(network, 'USER_END');
        return;
      case 'controller.join':
        addControllerMember(client, message);
        return;
      case 'controller.part':
        if (!network.controllerMemberId)
          return void notify(client, 'error', { code: 'MEMBER_UNAVAILABLE', scope: 'member' });
        touch(network);
        removeMember(network, network.controllerMemberId, 'left', false);
        return;
      case 'net.leave':
        return deny(client);
      default:
        return fail(client);
    }
  }

  async function processMessage(client: NetworkClient, raw: Uint8Array | string, binary = false) {
    if (client.closed || client.ws.readyState !== 1) return;
    const bytes = typeof raw === 'string' ? encoder.encode(raw) : raw;
    if (bytes.byteLength > NETWORK_LIMITS.MAX_WS_MESSAGE_BYTES)
      return fail(client, 'MESSAGE_TOO_LARGE', 1009);
    if (binary) return fail(client);
    if (!take(client.messages, now(), NETWORK_LIMITS.MESSAGE_RATE, NETWORK_LIMITS.MESSAGE_BURST))
      return fail(client, 'RATE_LIMITED');
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(bytes));
    } catch {
      return fail(client);
    }
    const candidate = object(parsed);
    if (candidate?.v !== 1) return fail(client, 'VERSION_UNSUPPORTED');
    if (
      candidate.type !== 'ucast' &&
      candidate.type !== 'bcast' &&
      bytes.byteLength > NETWORK_LIMITS.MAX_CONTROL_MESSAGE_BYTES
    )
      return fail(client, 'MESSAGE_TOO_LARGE', 1009);
    let validated: ClientMessage | undefined;
    try {
      validateSharedControlMessage(parsed, 'server');
      validated = validateMessage(parsed);
    } catch {
      validated = undefined;
    }
    if (!validated) return fail(client);
    if (validated.type === 'bcast') {
      if (
        !take(
          client.bcastBytes,
          now(),
          NETWORK_LIMITS.BCAST_BYTES_PER_SECOND,
          NETWORK_LIMITS.BCAST_BYTES_BURST,
          bytes.byteLength,
        )
      )
        return fail(client, 'RATE_LIMITED');
    }
    if (!client.role) {
      if (validated.type !== 'auth') return fail(client);
      client.authenticating = true;
      try {
        await authenticate(client, validated);
      } finally {
        client.authenticating = false;
      }
      return;
    }
    await authenticatedMessage(client, validated);
  }

  function message(client: NetworkClient, raw: Uint8Array | string, binary = false): Promise<void> {
    if (client.closed || client.ws.readyState !== 1) return Promise.resolve();
    const value = typeof raw === 'string' ? raw : new Uint8Array(raw);
    const bytes = typeof value === 'string' ? encoder.encode(value).byteLength : value.byteLength;
    client.queuedMessages++;
    client.queuedBytes += bytes;
    if (
      client.queuedMessages > NETWORK_LIMITS.MAX_RECEIVE_QUEUE_MESSAGES ||
      client.queuedBytes > NETWORK_LIMITS.MAX_OUTSTANDING_BYTES
    ) {
      client.queuedMessages--;
      client.queuedBytes -= bytes;
      fail(client, 'SLOW_PEER', 1008);
      return Promise.resolve();
    }
    const task = client.queue.then(() => processMessage(client, value, binary));
    client.queue = task
      .catch(() => {
        if (!client.closed) fail(client, 'SERVER_ERROR', 1011);
      })
      .finally(() => {
        client.queuedMessages--;
        client.queuedBytes -= bytes;
      });
    return task;
  }

  return {
    createNetwork,
    connect,
    disconnect,
    message,
    fail,
    sweep,
    clients,
    networks,
    stats: () => ({ networks: networks.size, sockets: clients.size }),
    shutdown() {
      for (const network of [...networks.values()]) closeNetwork(network, 'SERVER_SHUTDOWN');
      for (const client of [...clients]) fail(client, 'SERVER_SHUTDOWN', 1000);
    },
  };
}
