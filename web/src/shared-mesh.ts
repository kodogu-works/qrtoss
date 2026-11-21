import {
  SC,
  BroadcastReceiver,
  BroadcastSender,
  createUnicastChannel,
  importEcdhPublic,
  verifyMemberAddition,
  type BcastAppMessage,
  type EcdhIdentity,
  type UcastAppMessage,
  type UnicastChannel,
} from '../../packages/protocol/src/shared.ts';
import { randomToken } from '../../packages/protocol/src/index.ts';
import type {
  SharedControlMessage,
  SharedMemberEntry,
} from '../../packages/protocol/src/shared-control.ts';
import type { SharedNetworkClient } from './shared-network.ts';

type ForwardedUcast = Extract<SharedControlMessage, { type: 'ucast'; network: string }>;
type ForwardedBcast = Extract<SharedControlMessage, { type: 'bcast'; network: string }>;

export type MeshHooks = {
  members(entries: readonly SharedMemberEntry[], epoch: number): void;
  unicast(from: string, message: UcastAppMessage): Promise<void> | void;
  broadcast(from: string, message: BcastAppMessage): Promise<void> | void;
};

type Peer = SharedMemberEntry & { publicKey: CryptoKey; channel: UnicastChannel };

/** Cryptographic member state. The relay-provided member list is never trusted without signatures. */
export class SharedMesh {
  private readonly peers = new Map<string, Peer>();
  private readonly seen = new Set<string>();
  private readonly receivers = new Map<string, { value: BroadcastReceiver; expires?: number }>();
  private receiverExpiryTimer?: ReturnType<typeof setTimeout>;
  private sender?: BroadcastSender;
  private readonly oldSenders = new Map<number, BroadcastSender>();
  private readonly oldSenderExpires = new Map<number, number>();
  private readonly senderTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private epoch = -1;
  private sendQueue = Promise.resolve();
  private broadcastQueue = Promise.resolve();
  private keyDistribution?: {
    pending: Map<string, string>;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  constructor(
    readonly network: string,
    readonly memberId: string,
    private readonly identity: EcdhIdentity,
    private readonly signingPublic: CryptoKey,
    private readonly client: SharedNetworkClient,
    private readonly hooks: MeshHooks,
  ) {}
  get currentEpoch(): number {
    return this.epoch;
  }
  get members(): readonly SharedMemberEntry[] {
    return [...this.peers.values()].map(
      ({ publicKey: _publicKey, channel: _channel, ...entry }) => entry,
    );
  }
  get recipientIds(): readonly string[] {
    return [...this.peers.keys()].filter((id) => id !== this.memberId);
  }
  private key(from: string, epoch: number): string {
    return `${from}\n${epoch}`;
  }
  async authenticate(entries: readonly SharedMemberEntry[], epoch: number): Promise<void> {
    if (this.epoch !== -1 || !Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error('EPOCH_MISMATCH');
    const own = entries.find((entry) => entry.memberId === this.memberId);
    if (!own || own.idPub !== this.identity.publicRaw) throw new Error('AUTH_FAILED');
    for (const entry of entries) await this.addVerified(entry, false);
    this.epoch = epoch;
    await this.rotate();
    this.hooks.members(this.members, this.epoch);
  }
  private async addVerified(entry: SharedMemberEntry, rejectSeen: boolean): Promise<void> {
    if ((rejectSeen && this.seen.has(entry.memberId)) || this.peers.has(entry.memberId))
      throw new Error('DUPLICATE_MEMBER');
    if (
      !(await verifyMemberAddition(
        this.signingPublic,
        {
          network: this.network,
          memberId: entry.memberId,
          idPub: entry.idPub,
          labelB64: entry.labelB64,
        },
        entry.sig,
      ))
    )
      throw new Error('AUTH_FAILED');
    const publicKey = await importEcdhPublic(entry.idPub);
    const channel = await createUnicastChannel(
      this.network,
      this.memberId,
      this.identity.privateKey,
      entry.memberId,
      publicKey,
    );
    this.seen.add(entry.memberId);
    this.peers.set(entry.memberId, { ...entry, publicKey, channel });
  }
  async memberAdded(
    message: Extract<SharedControlMessage, { type: 'member.added' }>,
  ): Promise<void> {
    if (message.epoch !== this.epoch + 1) throw new Error('EPOCH_MISMATCH');
    const { v: _v, type: _type, epoch: _epoch, ...entry } = message;
    await this.addVerified(entry, true);
    this.expireOldReceivers();
    this.epoch = message.epoch;
    await this.rotate();
    this.hooks.members(this.members, this.epoch);
  }
  async memberRemoved(
    message: Extract<SharedControlMessage, { type: 'member.removed' }>,
  ): Promise<void> {
    if (message.epoch !== this.epoch + 1 || !this.peers.has(message.memberId))
      throw new Error('EPOCH_MISMATCH');
    this.peers.delete(message.memberId);
    this.expireOldReceivers();
    this.epoch = message.epoch;
    if (message.memberId !== this.memberId) await this.rotate();
    this.hooks.members(this.members, this.epoch);
  }
  private expireOldReceivers(): void {
    const expires = performance.now() + SC.OLD_EPOCH_KEY_SECONDS * 1000;
    for (const value of this.receivers.values())
      if (value.expires === undefined) value.expires = expires;
    this.scheduleReceiverExpiry();
  }
  private scheduleReceiverExpiry(): void {
    clearTimeout(this.receiverExpiryTimer);
    this.receiverExpiryTimer = undefined;
    const current = performance.now();
    let next = Number.POSITIVE_INFINITY;
    for (const [key, value] of this.receivers) {
      if (value.expires === undefined) continue;
      if (value.expires <= current) this.receivers.delete(key);
      else next = Math.min(next, value.expires);
    }
    if (Number.isFinite(next))
      this.receiverExpiryTimer = setTimeout(
        () => this.scheduleReceiverExpiry(),
        Math.max(0, next - performance.now()) + 10,
      );
  }
  private async rotate(): Promise<void> {
    if (!this.peers.has(this.memberId)) return;
    if (this.sender) {
      const previous = this.sender;
      this.oldSenders.set(previous.epoch, previous);
      this.oldSenderExpires.set(
        previous.epoch,
        performance.now() + SC.OLD_EPOCH_KEY_SECONDS * 1000,
      );
      clearTimeout(this.senderTimers.get(previous.epoch));
      this.senderTimers.set(
        previous.epoch,
        setTimeout(() => {
          this.oldSenders.delete(previous.epoch);
          this.oldSenderExpires.delete(previous.epoch);
          this.senderTimers.delete(previous.epoch);
        }, SC.OLD_EPOCH_KEY_SECONDS * 1000),
      );
    }
    if (this.keyDistribution) {
      clearTimeout(this.keyDistribution.timer);
      this.keyDistribution.reject(new Error('EPOCH_MISMATCH'));
    }
    const sender = await BroadcastSender.create(this.network, this.memberId, this.epoch);
    this.sender = sender;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    void promise.catch(() => {});
    const distribution: NonNullable<SharedMesh['keyDistribution']> = {
      pending: new Map<string, string>(),
      promise,
      resolve,
      reject,
    };
    this.keyDistribution = distribution;
    for (const memberId of this.recipientIds) {
      const id = randomToken(16);
      distribution.pending.set(id, memberId);
      await this.sendTo(memberId, {
        type: 'key.share',
        id,
        epoch: this.epoch,
        senderKey: sender.senderSecret,
      });
    }
    if (!distribution.pending.size) distribution.resolve();
    else
      distribution.timer = setTimeout(
        () => distribution.reject(new Error('ACK_TIMEOUT')),
        SC.DELIVERY_ACK_TIMEOUT_SECONDS * 1000,
      );
  }
  async sendTo(memberId: string, message: UcastAppMessage): Promise<void> {
    const peer = this.peers.get(memberId);
    if (!peer) throw new Error('MEMBER_NOT_FOUND');
    const task = this.sendQueue.then(async () => {
      const encrypted = await peer.channel.encrypt(message);
      this.client.ucast('member', memberId, encrypted.seq, encrypted.ct);
    });
    this.sendQueue = task.catch(() => {});
    return task;
  }
  async broadcast(message: BcastAppMessage): Promise<void> {
    const context = await this.captureBroadcastContext();
    await this.broadcastAt(context.epoch, message);
  }
  async captureBroadcastEpoch(): Promise<number> {
    return (await this.captureBroadcastContext()).epoch;
  }
  async captureBroadcastContext(): Promise<{ epoch: number; recipients: string[] }> {
    const sender = this.sender;
    if (!sender || sender.epoch !== this.epoch) throw new Error('EPOCH_MISMATCH');
    const distribution = this.keyDistribution;
    const recipients = [...this.recipientIds];
    await distribution?.promise;
    if (
      sender !== this.sender ||
      sender.epoch !== this.epoch ||
      distribution !== this.keyDistribution
    )
      throw new Error('EPOCH_MISMATCH');
    return { epoch: sender.epoch, recipients };
  }
  async broadcastAt(epoch: number, message: BcastAppMessage): Promise<void> {
    const task = this.broadcastQueue.then(async () => {
      let sender = epoch === this.sender?.epoch ? this.sender : this.oldSenders.get(epoch);
      if (
        sender !== this.sender &&
        (this.oldSenderExpires.get(epoch) ?? -Infinity) <= performance.now()
      ) {
        this.oldSenders.delete(epoch);
        this.oldSenderExpires.delete(epoch);
        sender = undefined;
      }
      if (!sender) throw new Error('EPOCH_MISMATCH');
      const encrypted = await sender.encrypt(message);
      this.client.bcast(encrypted.epoch, encrypted.seq, encrypted.ct);
    });
    this.broadcastQueue = task.catch(() => {});
    return task;
  }
  async receiveUnicast(message: ForwardedUcast): Promise<void> {
    if (message.network !== this.network || message.to !== this.memberId)
      throw new Error('PROTOCOL_ERROR');
    const peer = this.peers.get(message.from);
    if (!peer) throw new Error('MEMBER_NOT_FOUND');
    const app = await peer.channel.decrypt(message.seq, message.ct);
    if (app.type === 'key.share') {
      if (app.epoch < this.epoch - 63 || app.epoch > this.epoch) throw new Error('EPOCH_MISMATCH');
      const key = this.key(message.from, app.epoch);
      if (this.receivers.has(key)) throw new Error('PROTOCOL_ERROR');
      this.receivers.set(key, {
        value: await BroadcastReceiver.create(this.network, message.from, app.epoch, app.senderKey),
        ...(app.epoch < this.epoch
          ? { expires: performance.now() + SC.OLD_EPOCH_KEY_SECONDS * 1000 }
          : {}),
      });
      if (app.epoch < this.epoch) this.scheduleReceiverExpiry();
      await this.sendTo(message.from, { type: 'receipt', id: app.id, status: 'ok' });
      return;
    }
    if (app.type === 'receipt') {
      const distribution = this.keyDistribution;
      if (distribution?.pending.get(app.id) === message.from) {
        if (app.status !== 'ok') {
          clearTimeout(distribution.timer);
          distribution.reject(new Error(app.code));
        } else {
          distribution.pending.delete(app.id);
          if (!distribution.pending.size) {
            clearTimeout(distribution.timer);
            distribution.resolve();
          }
        }
        return;
      }
    }
    await this.hooks.unicast(message.from, app);
  }
  async receiveBroadcast(message: ForwardedBcast): Promise<void> {
    if (message.network !== this.network || message.from === this.memberId)
      throw new Error('PROTOCOL_ERROR');
    const receiver = this.receivers.get(this.key(message.from, message.epoch));
    if (!receiver || (receiver.expires !== undefined && receiver.expires <= performance.now())) {
      if (receiver) this.receivers.delete(this.key(message.from, message.epoch));
      throw new Error('EPOCH_MISMATCH');
    }
    const app = await receiver.value.decrypt(message.seq, message.ct);
    await this.hooks.broadcast(message.from, app);
  }
  destroy(): void {
    this.peers.clear();
    clearTimeout(this.receiverExpiryTimer);
    this.receiverExpiryTimer = undefined;
    this.receivers.clear();
    this.sender = undefined;
    this.oldSenders.clear();
    this.oldSenderExpires.clear();
    for (const timer of this.senderTimers.values()) clearTimeout(timer);
    this.senderTimers.clear();
    clearTimeout(this.keyDistribution?.timer);
    this.keyDistribution?.reject(new Error('NETWORK_CLOSED'));
    this.keyDistribution = undefined;
  }
}
