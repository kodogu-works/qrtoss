import {
  CONTROL_FIELD_TYPES,
  CONTROL_SCHEMAS,
  type ControlMessage,
  type ControlTarget,
} from './control.generated.ts';
import { ProtocolError, decodeBase64, exact } from './validation.ts';

/** Shape and wire values only. Peer binding, authorization and state stay in sessions. */
export function validateControlMessage(value: unknown, target: ControlTarget): ControlMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError();
  const message = value as Record<string, unknown>;
  if (message.v !== 1 || typeof message.type !== 'string') throw new ProtocolError();
  for (const schema of CONTROL_SCHEMAS) {
    if (schema.type !== message.type || !schema.targets.includes(target)) continue;
    try {
      exact(message, ['v', 'type', ...Object.keys(schema.fields)]);
      for (const [field, name] of Object.entries(schema.fields)) {
        const rule = CONTROL_FIELD_TYPES[name]!;
        const input = message[field];
        if (rule.kind === 'base64url') {
          if (typeof input !== 'string') throw new ProtocolError();
          decodeBase64(input, rule.bytes);
        } else if (rule.kind === 'integer') {
          if (
            typeof input !== 'number' ||
            !Number.isSafeInteger(input) ||
            input < rule.min ||
            input > rule.max
          )
            throw new ProtocolError();
        } else if (typeof input !== 'string' || !rule.values.includes(input))
          throw new ProtocolError();
      }
      return message as ControlMessage;
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
    }
  }
  throw new ProtocolError();
}
