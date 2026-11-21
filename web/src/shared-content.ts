import {
  SC,
  decodeFileName,
  decodeSharedText,
  encodeFileName,
  encodeSharedText,
  type BcastAppMessage,
  type UcastAppMessage,
} from '../../packages/protocol/src/shared.ts';
import { decodeBase64, encodeBase64 } from '../../packages/protocol/src/validation.ts';
import { randomToken } from '../../packages/protocol/src/index.ts';
import type { SharedMesh } from './shared-mesh.ts';
import {
  DeliveryTracker,
  IncomingFile,
  ReceivedStore,
  validateFiles,
  type ReceivedItem,
} from './shared-store.ts';

type IncomingTransfer = {
  from: string;
  batchId: string;
  file: IncomingFile;
  reserved: number;
  timer?: ReturnType<typeof setTimeout>;
};

type IncomingBatch = {
  batchId: string;
  bytes: number;
  files: number;
  retired: string[];
};

type BroadcastContext = { epoch: number; recipients: string[] };

type OutgoingTransfer = {
  tracker: DeliveryTracker;
  lastProgress: Map<string, number>;
  cancelable: boolean;
  canceled: boolean;
  notify?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type SharedContentHooks = {
  received(items: readonly ReceivedItem[]): void;
  delivery(tracker: DeliveryTracker): void;
};

function hasUnsafeDisplayCharacter(value: string): boolean {
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

const safeMime = (value: string): string =>
  !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, '')) &&
  new TextEncoder().encode(value).byteLength <= SC.MAX_MIME_UTF8_BYTES &&
  !hasUnsafeDisplayCharacter(value)
    ? value
    : 'application/octet-stream';

/** File/text semantics layered on top of the encrypted mesh. */
export class SharedContentSession {
  readonly store = new ReceivedStore();
  private readonly incoming = new Map<string, IncomingTransfer>();
  private readonly incomingBatches = new Map<string, IncomingBatch>();
  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly outgoingCleanup = new Map<string, ReturnType<typeof setTimeout>>();
  private reservedBytes = 0;
  private sendingFiles = false;
  constructor(
    private readonly mesh: SharedMesh,
    private readonly hooks: SharedContentHooks,
  ) {}
  get hasUnsaved(): boolean {
    return (
      this.store.hasUnsaved ||
      this.incoming.size > 0 ||
      this.sendingFiles ||
      [...this.outgoing.values()].some((value) => !value.tracker.settled)
    );
  }
  get deliveries(): readonly DeliveryTracker[] {
    return [...this.outgoing.values()].map((value) => value.tracker);
  }
  private createOutgoing(
    id: string,
    recipients: readonly string[],
    cancelable = false,
  ): OutgoingTransfer {
    if (this.outgoing.size >= SC.MAX_RECEIVED_ITEMS) {
      const settled = [...this.outgoing].find(([, value]) => value.tracker.settled);
      if (!settled) throw new Error('RECEIVER_FULL');
      clearTimeout(this.outgoingCleanup.get(settled[0]));
      this.outgoingCleanup.delete(settled[0]);
      this.outgoing.delete(settled[0]);
    }
    const tracker = new DeliveryTracker(id, recipients);
    const now = performance.now();
    const value: OutgoingTransfer = {
      tracker,
      lastProgress: new Map(recipients.map((memberId) => [memberId, now])),
      cancelable,
      canceled: false,
    };
    this.outgoing.set(id, value);
    this.hooks.delivery(tracker);
    return value;
  }
  private scheduleTimeout(value: OutgoingTransfer): void {
    clearTimeout(value.timer);
    if (value.tracker.settled) return;
    value.timer = setTimeout(() => {
      const now = performance.now();
      for (const [memberId, at] of value.lastProgress)
        if (
          value.tracker.recipients.get(memberId)?.status === 'SENDING' &&
          now - at >= SC.DELIVERY_ACK_TIMEOUT_SECONDS * 1000
        )
          value.tracker.settle(memberId, 'FAILED', 'ACK_TIMEOUT');
      value.notify?.();
      this.hooks.delivery(value.tracker);
      this.scheduleCleanup(value);
      this.scheduleTimeout(value);
    }, 250);
  }
  private scheduleCleanup(value: OutgoingTransfer): void {
    if (!value.tracker.settled || this.outgoingCleanup.has(value.tracker.id)) return;
    this.outgoingCleanup.set(
      value.tracker.id,
      setTimeout(() => {
        this.outgoing.delete(value.tracker.id);
        this.outgoingCleanup.delete(value.tracker.id);
      }, 60_000),
    );
  }
  async sendText(text: string): Promise<DeliveryTracker> {
    const context = await this.mesh.captureBroadcastContext();
    if (!context.recipients.length) throw new Error('MEMBER_NOT_FOUND');
    const id = randomToken(16);
    const outgoing = this.createOutgoing(id, context.recipients);
    try {
      await this.mesh.broadcastAt(context.epoch, {
        type: 'text',
        id,
        textB64: encodeSharedText(text),
      });
      this.scheduleTimeout(outgoing);
      return outgoing.tracker;
    } catch (error) {
      this.failOutgoing(outgoing, error);
      throw error;
    }
  }
  async sendFiles(files: readonly File[]): Promise<DeliveryTracker[]> {
    if (this.sendingFiles) throw new Error('FORBIDDEN');
    validateFiles(files);
    this.sendingFiles = true;
    const batchId = randomToken(16);
    const results: DeliveryTracker[] = [];
    try {
      // One file-selection action is one transfer batch. Freeze both the epoch and recipients
      // before its first offer so a member joining between files never receives only a suffix.
      const context = await this.mesh.captureBroadcastContext();
      if (!context.recipients.length) throw new Error('MEMBER_NOT_FOUND');
      for (const file of files) results.push(await this.sendFile(file, batchId, context));
      return results;
    } finally {
      this.sendingFiles = false;
    }
  }
  private async sendFile(
    file: File,
    batchId: string,
    context: BroadcastContext,
  ): Promise<DeliveryTracker> {
    const transferId = randomToken(16);
    const outgoing = this.createOutgoing(transferId, context.recipients, true);
    const chunks = Math.ceil(file.size / SC.FILE_CHUNK_BYTES);
    const transferEpoch = context.epoch;
    try {
      await this.mesh.broadcastAt(transferEpoch, {
        type: 'file.offer',
        transferId,
        batchId,
        nameB64: encodeFileName(file.name),
        size: file.size,
        mime: safeMime(file.type),
        chunks,
      });
      this.scheduleTimeout(outgoing);
      let abandoned = false;
      for (let index = 0; index < chunks; index++) {
        await this.waitForWindow(outgoing, index);
        if (outgoing.canceled || outgoing.tracker.settled) {
          abandoned = true;
          break;
        }
        const start = index * SC.FILE_CHUNK_BYTES;
        const bytes = new Uint8Array(
          await file.slice(start, start + SC.FILE_CHUNK_BYTES).arrayBuffer(),
        );
        await this.mesh.broadcastAt(transferEpoch, {
          type: 'file.chunk',
          transferId,
          index,
          dataB64: encodeBase64(bytes),
        });
        bytes.fill(0);
      }
      if (outgoing.canceled || abandoned)
        await this.mesh.broadcastAt(transferEpoch, { type: 'file.cancel', transferId });
      else await this.mesh.broadcastAt(transferEpoch, { type: 'file.end', transferId });
      await this.waitForSettlement(outgoing);
      return outgoing.tracker;
    } catch (error) {
      this.failOutgoing(outgoing, error);
      throw error;
    }
  }
  private failOutgoing(value: OutgoingTransfer, error: unknown): void {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SERVER_ERROR';
    for (const memberId of value.tracker.recipients.keys())
      value.tracker.settle(memberId, 'FAILED', code);
    value.notify?.();
    this.hooks.delivery(value.tracker);
    this.scheduleCleanup(value);
  }
  private async waitForSettlement(value: OutgoingTransfer): Promise<void> {
    while (!value.tracker.settled) {
      await new Promise<void>((resolve) => {
        value.notify = resolve;
        setTimeout(resolve, 250);
      });
      value.notify = undefined;
    }
  }
  private async waitForWindow(value: OutgoingTransfer, nextIndex: number): Promise<void> {
    while (!value.canceled) {
      const pending = [...value.tracker.recipients.values()].filter(
        (recipient) => recipient.status === 'SENDING',
      );
      if (!pending.length) return;
      const slowest = Math.min(...pending.map((recipient) => recipient.upTo));
      if (nextIndex - slowest < SC.SEND_WINDOW_CHUNKS) return;
      await new Promise<void>((resolve) => {
        value.notify = resolve;
        setTimeout(resolve, 250);
      });
      value.notify = undefined;
    }
  }
  cancel(transferId: string): void {
    const value = this.outgoing.get(transferId);
    if (!value?.cancelable || value.tracker.settled) return;
    value.canceled = true;
    value.tracker.cancel();
    value.notify?.();
    this.hooks.delivery(value.tracker);
    this.scheduleCleanup(value);
  }
  canCancel(transferId: string): boolean {
    const value = this.outgoing.get(transferId);
    return Boolean(value?.cancelable && !value.tracker.settled);
  }
  memberGone(memberId: string): void {
    for (const [transferId, incoming] of this.incoming) {
      if (incoming.from !== memberId) continue;
      incoming.file.cancel();
      this.releaseIncoming(transferId);
    }
    for (const value of this.outgoing.values()) {
      value.tracker.settle(memberId, 'FAILED', 'MEMBER_NOT_FOUND');
      value.notify?.();
      this.hooks.delivery(value.tracker);
      this.scheduleCleanup(value);
    }
    this.incomingBatches.delete(memberId);
  }
  async onUnicast(from: string, message: UcastAppMessage): Promise<void> {
    if (message.type === 'receipt') {
      const value = this.outgoing.get(message.id);
      if (!value) return;
      value.tracker.settle(
        from,
        message.status === 'ok' ? 'COMPLETE' : 'REJECTED',
        message.status === 'rejected' ? message.code : undefined,
      );
      value.lastProgress.set(from, performance.now());
      value.notify?.();
      this.hooks.delivery(value.tracker);
      this.scheduleCleanup(value);
      return;
    }
    if (message.type === 'progress') {
      const value = this.outgoing.get(message.transferId);
      if (!value) return;
      value.tracker.progress(from, message.upTo);
      value.lastProgress.set(from, performance.now());
      value.notify?.();
      this.hooks.delivery(value.tracker);
      return;
    }
    throw new Error('PROTOCOL_ERROR');
  }
  async onBroadcast(from: string, message: BcastAppMessage): Promise<void> {
    if (message.type === 'text') {
      try {
        const text = decodeSharedText(message.textB64);
        const bytes = new TextEncoder().encode(text).byteLength;
        if (
          this.store.size + this.incoming.size >= SC.MAX_RECEIVED_ITEMS ||
          !this.store.canReceive(this.reservedBytes + bytes)
        )
          throw new Error('RECEIVER_FULL');
        this.store.addText(message.id, text);
      } catch (error) {
        await this.mesh.sendTo(from, {
          type: 'receipt',
          id: message.id,
          status: 'rejected',
          code:
            error instanceof Error && error.message === 'RECEIVER_FULL'
              ? 'RECEIVER_FULL'
              : 'CONTENT_INVALID',
        });
        return;
      }
      this.hooks.received(this.store.items);
      await this.mesh.sendTo(from, { type: 'receipt', id: message.id, status: 'ok' });
      return;
    }
    if (message.type === 'file.offer') {
      const priorBatch = this.incomingBatches.get(from);
      const sameBatch = priorBatch?.batchId === message.batchId;
      const hasOpenTransfer = [...this.incoming.values()].some((value) => value.from === from);
      if (
        (!sameBatch && hasOpenTransfer) ||
        (!sameBatch && priorBatch?.retired.includes(message.batchId))
      ) {
        await this.mesh.sendTo(from, {
          type: 'receipt',
          id: message.transferId,
          status: 'rejected',
          code: 'CONTENT_INVALID',
        });
        return;
      }
      const retired = sameBatch
        ? priorBatch.retired
        : priorBatch
          ? [...priorBatch.retired, priorBatch.batchId].slice(-SC.MAX_QR_DEDUPLICATION_IDS)
          : [];
      const batch = sameBatch
        ? priorBatch
        : { batchId: message.batchId, bytes: 0, files: 0, retired };
      if (batch.files >= SC.MAX_RECEIVED_ITEMS || batch.bytes + message.size > SC.MAX_SEND_BYTES) {
        await this.mesh.sendTo(from, {
          type: 'receipt',
          id: message.transferId,
          status: 'rejected',
          code: 'CONTENT_TOO_LARGE',
        });
        return;
      }
      if (
        this.incoming.has(message.transferId) ||
        hasOpenTransfer ||
        this.store.size + this.incoming.size >= SC.MAX_RECEIVED_ITEMS ||
        !this.store.canReceive(this.reservedBytes + message.size)
      ) {
        await this.mesh.sendTo(from, {
          type: 'receipt',
          id: message.transferId,
          status: 'rejected',
          code: 'RECEIVER_FULL',
        });
        return;
      }
      try {
        const file = new IncomingFile(
          message.transferId,
          decodeFileName(message.nameB64),
          message.size,
          safeMime(message.mime),
          message.chunks,
        );
        this.incoming.set(message.transferId, {
          from,
          batchId: message.batchId,
          file,
          reserved: message.size,
        });
        this.incomingBatches.set(from, {
          batchId: message.batchId,
          bytes: batch.bytes + message.size,
          files: batch.files + 1,
          retired,
        });
        this.reservedBytes += message.size;
        this.armIncomingTimeout(message.transferId);
      } catch {
        await this.mesh.sendTo(from, {
          type: 'receipt',
          id: message.transferId,
          status: 'rejected',
          code: 'CONTENT_INVALID',
        });
      }
      return;
    }
    const incoming = this.incoming.get(message.transferId);
    if (!incoming || incoming.from !== from) return;
    if (message.type === 'file.cancel') {
      incoming.file.cancel();
      this.releaseIncoming(message.transferId);
      return;
    }
    if (message.type === 'file.chunk') {
      let upTo: number;
      try {
        upTo = incoming.file.push(message.index, decodeBase64(message.dataB64));
        this.armIncomingTimeout(message.transferId);
      } catch {
        incoming.file.cancel();
        this.releaseIncoming(message.transferId);
        await this.mesh.sendTo(from, {
          type: 'receipt',
          id: message.transferId,
          status: 'rejected',
          code: 'CONTENT_INVALID',
        });
        return;
      }
      if (upTo % SC.PROGRESS_INTERVAL_CHUNKS === 0)
        await this.mesh.sendTo(from, { type: 'progress', transferId: message.transferId, upTo });
      return;
    }
    if (message.type === 'file.end') {
      let data: Uint8Array<ArrayBuffer> | undefined;
      let invalid = false;
      try {
        data = incoming.file.finish();
        this.store.addFile(message.transferId, incoming.file.name, incoming.file.mime, data);
      } catch {
        invalid = true;
      } finally {
        data?.fill(0);
        this.releaseIncoming(message.transferId);
      }
      if (invalid) {
        await this.mesh.sendTo(from, {
          type: 'receipt',
          id: message.transferId,
          status: 'rejected',
          code: 'CONTENT_INVALID',
        });
        return;
      }
      this.hooks.received(this.store.items);
      await this.mesh.sendTo(from, {
        type: 'progress',
        transferId: message.transferId,
        upTo: incoming.file.chunks,
      });
      await this.mesh.sendTo(from, { type: 'receipt', id: message.transferId, status: 'ok' });
    }
  }
  private armIncomingTimeout(transferId: string): void {
    const value = this.incoming.get(transferId);
    if (!value) return;
    clearTimeout(value.timer);
    value.timer = setTimeout(() => {
      const current = this.incoming.get(transferId);
      if (current !== value) return;
      current.timer = undefined;
      current.file.cancel();
      this.releaseIncoming(transferId);
      void this.mesh
        .sendTo(current.from, {
          type: 'receipt',
          id: transferId,
          status: 'rejected',
          code: 'CANCELED',
        })
        .catch(() => {});
    }, SC.DELIVERY_ACK_TIMEOUT_SECONDS * 1000);
  }
  private releaseIncoming(transferId: string): void {
    const value = this.incoming.get(transferId);
    if (!value) return;
    clearTimeout(value.timer);
    this.reservedBytes -= value.reserved;
    this.incoming.delete(transferId);
  }
  remove(id: string): void {
    this.store.remove(id);
    this.hooks.received(this.store.items);
  }
  save(id: string): { blob: Blob; name: string } | undefined {
    const item = this.store.items.find((value) => value.id === id);
    if (item?.kind !== 'file') return;
    this.store.markSaved(id);
    this.hooks.received(this.store.items);
    return { blob: new Blob([item.data], { type: safeMime(item.mime) }), name: item.name };
  }
  destroy(): void {
    for (const value of this.incoming.values()) {
      clearTimeout(value.timer);
      value.file.cancel();
    }
    this.incoming.clear();
    this.incomingBatches.clear();
    this.reservedBytes = 0;
    for (const value of this.outgoing.values()) clearTimeout(value.timer);
    for (const timer of this.outgoingCleanup.values()) clearTimeout(timer);
    this.outgoingCleanup.clear();
    this.outgoing.clear();
    this.store.clear();
  }
}
