import { SC } from '../../packages/protocol/src/shared-constants.ts';

const encoder = new TextEncoder();
export const MAX_SHARED_SEND_BYTES = SC.MAX_SEND_BYTES;
export const MAX_SHARED_TEXT_BYTES = SC.MAX_SHARED_TEXT_UTF8_BYTES;
export const MAX_RECEIVED_ITEMS = SC.MAX_RECEIVED_ITEMS;
export const MAX_RECEIVED_BYTES = SC.MAX_RECEIVED_BYTES;
export const MAX_FILE_NAME_BYTES = SC.MAX_FILE_NAME_UTF8_BYTES;
export const FILE_CHUNK_BYTES = SC.FILE_CHUNK_BYTES;

function unsafeLabel(value: string): boolean {
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

function wellFormed(value: string): boolean {
  return !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''));
}

export function validateDisplayText(value: string, maximumBytes: number): void {
  if (!wellFormed(value) || !value || encoder.encode(value).byteLength > maximumBytes)
    throw new Error('CONTENT_INVALID');
  if (unsafeLabel(value)) throw new Error('CONTENT_INVALID');
}

export function validateFiles(files: readonly Pick<File, 'name' | 'size'>[]): number {
  if (!files.length) throw new Error('CONTENT_EMPTY');
  if (files.length > MAX_RECEIVED_ITEMS) throw new Error('CONTENT_TOO_LARGE');
  let total = 0;
  for (const file of files) {
    validateDisplayText(file.name, MAX_FILE_NAME_BYTES);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('CONTENT_INVALID');
    total += file.size;
    if (!Number.isSafeInteger(total) || total > MAX_SHARED_SEND_BYTES)
      throw new Error('CONTENT_TOO_LARGE');
  }
  return total;
}

export type ReceivedItem =
  | { id: string; kind: 'text'; text: string; bytes: number; receivedAt: number }
  | {
      id: string;
      kind: 'file';
      name: string;
      mime: string;
      data: Uint8Array<ArrayBuffer>;
      bytes: number;
      receivedAt: number;
      saved: boolean;
    };

export class ReceivedStore {
  private readonly values = new Map<string, ReceivedItem>();
  private bytes = 0;
  get size(): number {
    return this.values.size;
  }
  get byteLength(): number {
    return this.bytes;
  }
  get items(): readonly ReceivedItem[] {
    return [...this.values.values()];
  }
  get hasUnsaved(): boolean {
    return [...this.values.values()].some((item) => item.kind === 'text' || !item.saved);
  }
  canReceive(bytes: number): boolean {
    return (
      Number.isSafeInteger(bytes) &&
      bytes >= 0 &&
      this.values.size < MAX_RECEIVED_ITEMS &&
      this.bytes + bytes <= MAX_RECEIVED_BYTES
    );
  }
  addText(id: string, text: string, receivedAt = Date.now()): ReceivedItem {
    if (!wellFormed(text)) throw new Error('CONTENT_INVALID');
    const bytes = encoder.encode(text).byteLength;
    if (!bytes || bytes > MAX_SHARED_TEXT_BYTES) throw new Error('CONTENT_TOO_LARGE');
    if (this.values.has(id)) return this.values.get(id)!;
    if (!this.canReceive(bytes)) throw new Error('RECEIVER_FULL');
    const item: ReceivedItem = { id, kind: 'text', text, bytes, receivedAt };
    this.values.set(id, item);
    this.bytes += bytes;
    return item;
  }
  addFile(
    id: string,
    name: string,
    mime: string,
    data: Uint8Array,
    receivedAt = Date.now(),
  ): ReceivedItem {
    validateDisplayText(name, MAX_FILE_NAME_BYTES);
    if (this.values.has(id)) return this.values.get(id)!;
    if (!this.canReceive(data.byteLength)) throw new Error('RECEIVER_FULL');
    const copy = new Uint8Array(data);
    const item: ReceivedItem = {
      id,
      kind: 'file',
      name,
      mime,
      data: copy,
      bytes: copy.byteLength,
      receivedAt,
      saved: false,
    };
    this.values.set(id, item);
    this.bytes += copy.byteLength;
    return item;
  }
  markSaved(id: string): void {
    const item = this.values.get(id);
    if (item?.kind === 'file') item.saved = true;
  }
  remove(id: string): boolean {
    const item = this.values.get(id);
    if (!item) return false;
    this.values.delete(id);
    this.bytes -= item.bytes;
    if (item.kind === 'file') item.data.fill(0);
    return true;
  }
  clear(): void {
    for (const id of [...this.values.keys()]) this.remove(id);
  }
}

export class IncomingFile {
  private readonly parts: Uint8Array<ArrayBuffer>[] = [];
  private next = 0;
  private received = 0;
  constructor(
    readonly transferId: string,
    readonly name: string,
    readonly size: number,
    readonly mime: string,
    readonly chunks: number,
  ) {
    validateDisplayText(name, MAX_FILE_NAME_BYTES);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_SHARED_SEND_BYTES ||
      !Number.isSafeInteger(chunks) ||
      chunks !== Math.ceil(size / FILE_CHUNK_BYTES)
    )
      throw new Error('PROTOCOL_ERROR');
  }
  push(index: number, source: Uint8Array): number {
    if (index !== this.next || index >= this.chunks) throw new Error('PROTOCOL_ERROR');
    const expected =
      index === this.chunks - 1 ? this.size - index * FILE_CHUNK_BYTES : FILE_CHUNK_BYTES;
    if (source.byteLength !== expected) throw new Error('PROTOCOL_ERROR');
    const part = new Uint8Array(source);
    this.parts.push(part);
    this.received += part.byteLength;
    this.next++;
    return this.next;
  }
  finish(): Uint8Array<ArrayBuffer> {
    if (this.next !== this.chunks || this.received !== this.size) throw new Error('PROTOCOL_ERROR');
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      result.set(part, offset);
      offset += part.byteLength;
      part.fill(0);
    }
    this.parts.length = 0;
    return result;
  }
  cancel(): void {
    for (const part of this.parts) part.fill(0);
    this.parts.length = 0;
  }
}

export type DeliveryStatus = 'SENDING' | 'COMPLETE' | 'REJECTED' | 'FAILED' | 'CANCELED';
export type Delivery = { memberId: string; upTo: number; status: DeliveryStatus; code?: string };

export class DeliveryTracker {
  readonly recipients = new Map<string, Delivery>();
  constructor(
    readonly id: string,
    members: readonly string[],
  ) {
    for (const memberId of members)
      this.recipients.set(memberId, { memberId, upTo: 0, status: 'SENDING' });
  }
  progress(memberId: string, upTo: number): void {
    const value = this.recipients.get(memberId);
    if (value?.status !== 'SENDING' || !Number.isSafeInteger(upTo) || upTo < value.upTo) return;
    value.upTo = upTo;
  }
  settle(memberId: string, status: Exclude<DeliveryStatus, 'SENDING'>, code?: string): void {
    const value = this.recipients.get(memberId);
    if (value?.status !== 'SENDING') return;
    value.status = status;
    value.code = code;
  }
  cancel(): void {
    for (const value of this.recipients.values())
      if (value.status === 'SENDING') value.status = 'CANCELED';
  }
  get settled(): boolean {
    return [...this.recipients.values()].every((value) => value.status !== 'SENDING');
  }
  get complete(): boolean {
    return (
      this.recipients.size > 0 &&
      [...this.recipients.values()].every((value) => value.status === 'COMPLETE')
    );
  }
}
