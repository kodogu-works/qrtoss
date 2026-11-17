import { C } from '../../../packages/protocol/src/constants.ts';

// Enough for 100 maximum-sized data envelopes plus handshake, ack, activity and
// control traffic. This bounds queued payloads even when a peer never reads.
export const MAX_SOCKET_SEND_BYTES =
  C.MAX_TRANSFERS_PER_ROOM * C.MAX_WS_MESSAGE_BYTES + 1024 * 1024;
export const SOCKET_CLOSING_RESERVE_BYTES = 2 * C.MAX_CONTROL_MESSAGE_BYTES;
