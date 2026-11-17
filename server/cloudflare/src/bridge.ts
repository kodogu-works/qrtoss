import { C } from '../../../packages/protocol/src/constants.ts';
import { validateControlMessage } from '../../../packages/protocol/src/control.ts';
import { maintainLease } from '../../../packages/relay-core/src/lease.ts';
import { SendBudget } from '../../../packages/relay-core/src/limits.ts';
import { capacity, type Env } from './env.ts';
import { MAX_SOCKET_SEND_BYTES, SOCKET_CLOSING_RESERVE_BYTES } from './limits.ts';
import { bestEffort, closeSocket, withDeadline } from './runtime.ts';

export interface BridgeClock {
  now(): number;
  timeout(callback: () => void, milliseconds: number): () => void;
}
export const realtime: BridgeClock = {
  now: () => Date.now(),
  timeout(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** Only the first auth and the first backend reply are interpreted by the bridge. */
export function bridge(
  env: Env,
  ctx: ExecutionContext,
  client: WebSocket,
  lease: string,
  ip: string,
  clock: BridgeClock = realtime,
) {
  let backend: WebSocket | undefined;
  let phase: 'auth' | 'connecting' | 'relay' | 'closed' = 'auth';
  let firstReply = true,
    authenticated = false;
  const connected = clock.now();
  const encoder = new TextEncoder();
  const toClient = new SendBudget(MAX_SOCKET_SEND_BYTES, SOCKET_CLOSING_RESERVE_BYTES);
  const toRoom = new SendBudget(MAX_SOCKET_SEND_BYTES, SOCKET_CLOSING_RESERVE_BYTES);
  const cancelAuthTimer = clock.timeout(
    () => reject('PAIR_UNAVAILABLE', 1008),
    C.AUTH_TIMEOUT_SECONDS * 1000,
  );
  const cancelRenew = maintainLease(
    () => {
      ctx.waitUntil(bestEffort(capacity(env).renewSocket(lease, { ip, authenticated })));
    },
    (callback, ms) => clock.timeout(callback, ms),
  );

  function isClosed() {
    return phase === 'closed';
  }
  function finish(code: number, failure?: string) {
    if (isClosed()) return;
    phase = 'closed';
    cancelAuthTimer();
    cancelRenew();
    closeSocket(client, code);
    // Only fixed bridge failures are attached internally. Client-supplied close
    // reasons are never forwarded as trusted room failures.
    closeSocket(backend, code, failure);
    ctx.waitUntil(bestEffort(capacity(env).releaseSocket(lease)));
  }
  function reject(code: string, close: number) {
    if (isClosed()) return;
    try {
      const message = JSON.stringify({ v: 1, type: 'error', code, scope: 'socket' });
      if (toClient.take(encoder.encode(message).byteLength, true)) client.send(message);
    } catch {
      /* The close path also releases admission. */
    }
    finish(close, code);
  }
  function forward(target: WebSocket, data: string, budget: SendBudget) {
    if (!budget.take(encoder.encode(data).byteLength)) return reject('SLOW_PEER', 1008);
    try {
      target.send(data);
    } catch {
      finish(1011);
    }
  }
  function text(data: string | ArrayBuffer, limit: number): data is string {
    if (typeof data !== 'string') {
      reject('PROTOCOL_ERROR', 1008);
      return false;
    }
    if (encoder.encode(data).byteLength > limit) {
      reject('MESSAGE_TOO_LARGE', 1009);
      return false;
    }
    return true;
  }
  async function authenticate(data: string) {
    let auth: ReturnType<typeof validateControlMessage>;
    try {
      auth = validateControlMessage(JSON.parse(data), 'server');
      if (auth.type !== 'auth') return reject('PROTOCOL_ERROR', 1008);
    } catch {
      return reject('PROTOCOL_ERROR', 1008);
    }
    phase = 'connecting';
    cancelAuthTimer();
    try {
      const allowed = await withDeadline(capacity(env).canAuthenticate(ip));
      if (isClosed()) return;
      if (!allowed) return reject('RATE_LIMITED', 1008);
      const stub = env.ROOM.get(env.ROOM.idFromName(auth.room));
      const pending = stub.fetch('https://room.internal/ws', {
        headers: { Upgrade: 'websocket', 'X-Qrtoss-IP': ip, 'Sec-WebSocket-Extensions': '' },
      });
      // A timed-out upgrade can still finish; close it instead of leaking a connection.
      void pending.then(
        (response) => {
          if (phase === 'closed' && response.webSocket) {
            try {
              response.webSocket.accept();
              closeSocket(response.webSocket);
            } catch {
              /* The internal socket may already have closed. */
            }
          }
        },
        () => {},
      );
      const response = await withDeadline(pending);
      if (isClosed()) return;
      backend = response.webSocket ?? undefined;
      if (response.status !== 101 || !backend) return reject('SERVER_ERROR', 1011);
      backend.accept();
      backend.addEventListener('message', (event) => {
        if (phase === 'closed' || !text(event.data, C.MAX_WS_MESSAGE_BYTES)) return;
        if (firstReply) {
          firstReply = false;
          try {
            if (JSON.parse(event.data).type === 'auth.ok') {
              authenticated = true;
              ctx.waitUntil(bestEffort(capacity(env).authenticateSocket(lease)));
            }
          } catch {
            return reject('SERVER_ERROR', 1011);
          }
        }
        forward(client, event.data, toClient);
      });
      backend.addEventListener('close', (event) => finish(event.code));
      backend.addEventListener('error', () => finish(1011));
      phase = 'relay';
      forward(backend, data, toRoom);
    } catch {
      reject('SERVER_ERROR', 1011);
    }
  }
  client.addEventListener('message', (event) => {
    if (isClosed()) return;
    if (phase === 'auth') {
      if (clock.now() - connected >= C.AUTH_TIMEOUT_SECONDS * 1000)
        return reject('PAIR_UNAVAILABLE', 1008);
      if (!text(event.data, C.MAX_CONTROL_MESSAGE_BYTES)) return;
      ctx.waitUntil(authenticate(event.data));
    } else if (phase === 'connecting') {
      // Never queue payloads while routing/authenticating a socket.
      reject('PROTOCOL_ERROR', 1008);
    } else if (text(event.data, C.MAX_WS_MESSAGE_BYTES)) {
      forward(backend!, event.data, toRoom);
    }
  });
  client.addEventListener('close', (event) => finish(event.code));
  client.addEventListener('error', () => finish(1011));
}
