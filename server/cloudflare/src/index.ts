import { C } from '../../../packages/protocol/src/constants.ts';
import {
  decodeBase64,
  hasExactFields,
  ProtocolError,
} from '../../../packages/protocol/src/validation.ts';
import {
  SHARE_NETWORK_SUBPROTOCOL,
  SHARE_PAIR_SUBPROTOCOL,
} from '../../../packages/protocol/src/shared.ts';
import {
  publicOrigin,
  responseHeaders,
  staticPath,
  assetCacheControl,
  acceptsWebSocketProtocol,
} from '../../../packages/relay-core/src/http.ts';
import { normalizeIp, ipLimitKey } from '../../../packages/relay-core/src/ip.ts';
import { capacity, capacityOptions, prefixLength, type Env } from './env.ts';
import { random, digest, withDeadline, bestEffort } from './runtime.ts';
import type { Admission } from '../../../packages/relay-core/src/capacity.ts';
import { bridge, networkBridge, realtime, type BridgeClock } from './bridge.ts';
export { PairingDO, RoomDO } from './room.ts';
export { NetworkDO } from './network.ts';
export { CapacityDO } from './capacity.ts';

const oversizedBody = Symbol('oversizedBody');

function reply(
  url: URL | undefined,
  status: number,
  code?: string,
  data?: unknown,
  retryAfter?: number,
) {
  return new Response(JSON.stringify(code ? { v: 1, error: { code } } : data), {
    status,
    headers: {
      ...responseHeaders(url),
      'Content-Type': 'application/json; charset=utf-8',
      ...(retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }),
    },
  });
}
async function roomRequest(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0,
    content = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > C.MAX_CONTROL_MESSAGE_BYTES) {
        void reader.cancel().catch(() => {});
        return oversizedBody;
      }
      content += decoder.decode(value, { stream: true });
    }
    return JSON.parse(content + decoder.decode());
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

export function createWorker(clock: BridgeClock = realtime) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      let origin: URL, prefix: number;
      try {
        origin = publicOrigin(env.PUBLIC_ORIGIN);
        capacityOptions(env);
        prefix = prefixLength(env);
      } catch {
        return reply(undefined, 500, 'SERVER_ERROR');
      }
      const url = new URL(request.url),
        path = url.pathname;
      if (url.origin !== origin.origin) return reply(origin, 404, 'PROTOCOL_ERROR');
      try {
        if (path === '/healthz' || path === '/readyz') {
          if (request.method !== 'GET') return reply(origin, 405, 'PROTOCOL_ERROR');
          return reply(origin, 200, undefined, { status: path === '/healthz' ? 'ok' : 'ready' });
        }
        const ip = ipLimitKey(
          normalizeIp(request.headers.get('CF-Connecting-IP') ?? '') ?? 'unknown',
          prefix,
        );
        const createPath =
          path === '/api/v1/rooms' || path === '/api/v2/pairings' || path === '/api/v2/networks';
        if (createPath) {
          if (url.search) return reply(origin, 400, 'PROTOCOL_ERROR');
          if (request.method !== 'POST') return reply(origin, 405, 'PROTOCOL_ERROR');
          if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN)
            return reply(origin, 403, 'ORIGIN_DENIED');
          if (
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              request.headers.get('Content-Type') ?? '',
            )
          )
            return reply(origin, 400, 'PROTOCOL_ERROR');
          const body = await withDeadline(roomRequest(request), 15_000);
          if (body === oversizedBody) return reply(origin, 413, 'MESSAGE_TOO_LARGE');
          const expectedFields = path === '/api/v2/networks' ? ['v', 'controllerId'] : ['v'];
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            !hasExactFields(body, expectedFields)
          )
            return reply(origin, 400, 'PROTOCOL_ERROR');
          if ((body as { v: unknown }).v !== 1) return reply(origin, 400, 'VERSION_UNSUPPORTED');
          if (path === '/api/v2/networks') {
            try {
              decodeBase64((body as { controllerId: string }).controllerId, 16);
            } catch (error) {
              if (error instanceof ProtocolError) return reply(origin, 400, 'PROTOCOL_ERROR');
              throw error;
            }
          }
          const id = random(16);
          const capacityKey =
            path === '/api/v1/rooms' ? id : path === '/api/v2/pairings' ? `pair:${id}` : id;
          let reservation: Admission;
          try {
            reservation = await withDeadline<Admission>(
              path === '/api/v2/networks'
                ? capacity(env).acquireNetwork(capacityKey, ip)
                : capacity(env).acquireRoom(capacityKey, ip),
            );
          } catch {
            ctx.waitUntil(
              bestEffort(
                path === '/api/v2/networks'
                  ? capacity(env).releaseNetwork(capacityKey)
                  : capacity(env).releaseRoom(capacityKey),
              ),
            );
            return reply(origin, 503, 'CAPACITY');
          }
          if (!reservation.ok)
            return reply(
              origin,
              reservation.status,
              reservation.code,
              undefined,
              reservation.retryAfter,
            );
          try {
            if (path === '/api/v2/networks') {
              const controllerCap = random(32);
              const controllerHash = await digest(controllerCap);
              const controllerId = (body as { controllerId: string }).controllerId;
              const stub = env.NETWORK.get(env.NETWORK.idFromName(id));
              const deadlines = await withDeadline(
                stub.create(id, controllerId, controllerHash, capacityKey),
              );
              return reply(origin, 201, undefined, {
                v: 1,
                network: id,
                controllerCap,
                ...deadlines,
              });
            }
            const receiverCap = random(32);
            const joinCap = random(32);
            const receiverHash = await digest(receiverCap);
            const joinHash = await digest(joinCap);
            const namespace = path === '/api/v1/rooms' ? env.ROOM : env.PAIRING;
            const stub = namespace.get(namespace.idFromName(id));
            const deadlines = await withDeadline(
              stub.create(id, receiverHash, joinHash, capacityKey),
            );
            return reply(
              origin,
              201,
              undefined,
              path === '/api/v1/rooms'
                ? { v: 1, room: id, receiverCap, senderJoinCap: joinCap, ...deadlines }
                : {
                    v: 1,
                    pair: id,
                    receiverCap,
                    controllerJoinCap: joinCap,
                    ...deadlines,
                  },
            );
          } catch {
            ctx.waitUntil(
              bestEffort(
                path === '/api/v2/networks'
                  ? capacity(env).releaseNetwork(capacityKey)
                  : capacity(env).releaseRoom(capacityKey),
              ),
            );
            return reply(origin, 503, 'CAPACITY');
          }
        }
        const socketProtocol =
          path === '/ws'
            ? 'qrtoss.v1'
            : path === '/api/v2/pairings/socket'
              ? SHARE_PAIR_SUBPROTOCOL
              : path === '/api/v2/networks/socket'
                ? SHARE_NETWORK_SUBPROTOCOL
                : undefined;
        if (socketProtocol) {
          if (url.search) return reply(origin, 404, 'PROTOCOL_ERROR');
          if (request.method !== 'GET') return reply(origin, 405, 'PROTOCOL_ERROR');
          if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN)
            return reply(origin, 403, 'ORIGIN_DENIED');
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
            return reply(origin, 400, 'PROTOCOL_ERROR');
          if (
            !acceptsWebSocketProtocol(request.headers.get('Sec-WebSocket-Protocol'), socketProtocol)
          )
            return reply(origin, 400, 'VERSION_UNSUPPORTED');
          const lease = random(16);
          let reservation: Admission;
          try {
            reservation = await withDeadline<Admission>(capacity(env).acquireSocket(lease, ip));
          } catch {
            ctx.waitUntil(bestEffort(capacity(env).releaseSocket(lease)));
            return reply(origin, 503, 'CAPACITY');
          }
          if (!reservation.ok)
            return reply(
              origin,
              reservation.status,
              reservation.code,
              undefined,
              reservation.retryAfter,
            );
          try {
            const [client, server] = Object.values(new WebSocketPair());
            server.accept();
            if (path === '/api/v2/networks/socket')
              networkBridge(env, ctx, server, lease, ip, clock);
            else
              bridge(
                env,
                ctx,
                server,
                lease,
                ip,
                clock,
                path === '/api/v2/pairings/socket' ? env.PAIRING : env.ROOM,
              );
            return new Response(null, {
              status: 101,
              webSocket: client,
              headers: {
                ...responseHeaders(origin),
                'Sec-WebSocket-Protocol': socketProtocol,
              },
            });
          } catch {
            ctx.waitUntil(bestEffort(capacity(env).releaseSocket(lease)));
            return reply(origin, 503, 'CAPACITY');
          }
        }
        if (request.method !== 'GET' && request.method !== 'HEAD')
          return reply(origin, 405, 'PROTOCOL_ERROR');
        const requested = staticPath(path);
        if (!requested) return reply(origin, 404, 'PROTOCOL_ERROR');
        const assetUrl = new URL('/' + requested, origin);
        const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }));
        if (asset.status !== 200) return reply(origin, 404, 'PROTOCOL_ERROR');
        const headers = new Headers(asset.headers);
        for (const [key, value] of Object.entries(responseHeaders(origin))) headers.set(key, value);
        headers.set('Cache-Control', assetCacheControl(requested));
        return new Response(request.method === 'HEAD' ? null : asset.body, {
          status: 200,
          headers,
        });
      } catch {
        return reply(origin, 503, 'CAPACITY');
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
