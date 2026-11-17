import { C } from './constants.ts';

export class ProtocolError extends Error {
  constructor(public code = 'PROTOCOL_ERROR') {
    super(code);
  }
}
export function hasExactFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
export function exact(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (!hasExactFields(value, fields)) throw new ProtocolError();
}
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function decodeBase64(value: string, length?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new ProtocolError();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw new ProtocolError();
  }
  if ((length !== undefined && bytes.length !== length) || encodeBase64(bytes) !== value)
    throw new ProtocolError();
  return bytes;
}
export type Envelope = {
  v: 1;
  type: 'cipher';
  room: string;
  peer: string;
  dir: 's2r' | 'r2s';
  seq: string;
  ct: string;
};
export function parseSequence(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new ProtocolError();
  const seq = BigInt(value);
  if (seq > 0xffffffffffffffffn) throw new ProtocolError();
  return seq;
}
export function validateEnvelope(value: unknown): Envelope {
  exact(value, ['v', 'type', 'room', 'peer', 'dir', 'seq', 'ct']);
  if (value.v !== 1 || value.type !== 'cipher' || !['s2r', 'r2s'].includes(value.dir as string))
    throw new ProtocolError();
  decodeBase64(value.room as string, 16);
  decodeBase64(value.peer as string, 16);
  parseSequence(value.seq);
  if (typeof value.ct !== 'string' || value.ct.length > 30059) throw new ProtocolError();
  const ct = decodeBase64(value.ct);
  if (ct.length < 16 || ct.length > C.MAX_PLAINTEXT_BYTES + 16) throw new ProtocolError();
  return value as Envelope;
}
