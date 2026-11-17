import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BlockList } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import { C } from '../../packages/protocol/src/constants.ts';
import { hasExactFields } from '../../packages/protocol/src/validation.ts';
import { createRelayCore } from '../../packages/relay-core/src/index.ts';
import { IpLimits, take } from '../../packages/relay-core/src/limits.ts';
import {
  publicOrigin,
  responseHeaders,
  staticPath,
  assetCacheControl,
} from '../../packages/relay-core/src/http.ts';
import { ipLimitKey, normalizeIp } from './ip.ts';

type Json = Record<string, unknown>;
export interface RelayOptions {
  publicOrigin: string;
  staticDir?: string;
  now?: () => number;
  wallNow?: () => number;
  allowHttpLoopback?: boolean;
  maxRooms?: number;
  maxSockets?: number;
  maxUnauthenticatedSockets?: number;
  maxSocketsPerIp?: number;
  ipv6PrefixLength?: number;
  trustProxyCidrs?: string[];
}
const random = (n: number) => randomBytes(n).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest();
/** In-memory, opaque ciphertext relay. No request, capability, or payload logging. */
export function createRelay(options: RelayOptions) {
  const publicUrl = publicOrigin(options.publicOrigin, options.allowHttpLoopback === true);
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const ips = new IpLimits();
  const core = createRelayCore({
    now,
    wallNow,
    random,
    digest: async (value) => digest(value),
    equal: async (a, b) => timingSafeEqual(a, b),
    canAuthenticate: (ip) => ips.canAuthenticate(ip, now()),
    authenticationFailed: (ip) => ips.authenticationFailed(ip, now()),
  });
  const { clients } = core;
  function sweep() {
    core.sweep();
    ips.sweep(now());
  }
  const trusted = new BlockList();
  for (const cidr of options.trustProxyCidrs ?? []) {
    const [address, prefix] = cidr.split('/');
    if (!address || !prefix || !/^\d+$/.test(prefix)) throw new Error('TRUST_PROXY_CIDRS_INVALID');
    trusted.addSubnet(address, Number(prefix), address.includes(':') ? 'ipv6' : 'ipv4');
  }
  let stopping = false;
  const maxRooms = options.maxRooms ?? 1000;
  const maxSockets = options.maxSockets ?? 2200;
  const maxUnauthenticated = options.maxUnauthenticatedSockets ?? 100;
  const maxPerIp = options.maxSocketsPerIp ?? 60;
  const ipv6PrefixLength = options.ipv6PrefixLength ?? 64;
  if (!Number.isInteger(ipv6PrefixLength) || ipv6PrefixLength < 1 || ipv6PrefixLength > 128)
    throw new Error('IPV6_PREFIX_LENGTH_INVALID');
  for (const limit of [maxRooms, maxSockets, maxUnauthenticated, maxPerIp]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('LIMIT_INVALID');
  }
  const server = createServer((req, res) => {
    void http(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, 'SERVER_ERROR');
      else res.destroy();
    });
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: C.MAX_WS_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  function ipOf(req: IncomingMessage) {
    let ip = normalizeIp(req.socket.remoteAddress ?? '') ?? 'unknown';
    if (ip !== 'unknown' && trusted.check(ip, ip.includes(':') ? 'ipv6' : 'ipv4')) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') {
        // The trusted edge must overwrite this header. Use its immediate client.
        const candidate = forwarded.split(',').at(-1)?.trim();
        const normalized = candidate && normalizeIp(candidate);
        if (normalized) ip = normalized;
      }
    }
    return ipLimitKey(ip, ipv6PrefixLength);
  }
  function headers(res: ServerResponse) {
    for (const [name, value] of Object.entries(responseHeaders(publicUrl)))
      res.setHeader(name, value);
  }
  function reply(res: ServerResponse, status: number, code?: string, data?: unknown) {
    headers(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(code ? { v: 1, error: { code } } : data));
  }
  async function http(req: IncomingMessage, res: ServerResponse) {
    const path = req.url?.split('?')[0];
    if (req.url?.includes('?') && path === '/api/v1/rooms')
      return reply(res, 400, 'PROTOCOL_ERROR');
    if (path === '/healthz' || path === '/readyz') {
      if (req.method !== 'GET') return reply(res, 405, 'PROTOCOL_ERROR');
      return path === '/readyz' && stopping
        ? reply(res, 503, 'SERVER_SHUTDOWN')
        : reply(res, 200, undefined, { status: path === '/healthz' ? 'ok' : 'ready' });
    }
    if (path === '/api/v1/rooms') {
      if (req.method !== 'POST') return reply(res, 405, 'PROTOCOL_ERROR');
      if (req.headers.origin !== options.publicOrigin) return reply(res, 403, 'ORIGIN_DENIED');
      if (stopping) return reply(res, 503, 'SERVER_SHUTDOWN');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''))
        return reply(res, 400, 'PROTOCOL_ERROR');
      const ip = ips.record(ipOf(req), now());
      if (!take(ip.create, now(), 10 / 60, 5)) {
        res.setHeader('Retry-After', '6');
        return reply(res, 429, 'RATE_LIMITED');
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > C.MAX_CONTROL_MESSAGE_BYTES) {
          reply(res, 413, 'MESSAGE_TOO_LARGE');
          req.resume();
          return;
        }
        chunks.push(chunk);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(res, 400, 'PROTOCOL_ERROR');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !hasExactFields(body, ['v']))
        return reply(res, 400, 'PROTOCOL_ERROR');
      if ((body as Json).v !== 1) return reply(res, 400, 'VERSION_UNSUPPORTED');
      sweep();
      if (core.stats().rooms >= maxRooms) return reply(res, 503, 'CAPACITY');
      const id = random(16),
        receiverCap = random(32),
        senderJoinCap = random(32);
      const deadlines = core.createRoom(id, digest(receiverCap), digest(senderJoinCap));
      return reply(res, 201, undefined, {
        v: 1,
        room: id,
        receiverCap,
        senderJoinCap,
        ...deadlines,
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'PROTOCOL_ERROR');
    if (!options.staticDir) return reply(res, 404, 'PROTOCOL_ERROR');
    const requested = staticPath(path ?? '');
    if (!requested) return reply(res, 404, 'PROTOCOL_ERROR');
    const root = resolve(options.staticDir),
      file = resolve(root, requested);
    if (!file.startsWith(root + sep)) return reply(res, 404, 'PROTOCOL_ERROR');
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      return reply(res, 404, 'PROTOCOL_ERROR');
    }
    headers(res);
    res.setHeader('Cache-Control', assetCacheControl(requested));
    const ext = requested.split('.').at(-1) ?? '';
    const types: Record<string, string> = {
      html: 'text/html',
      js: 'text/javascript',
      css: 'text/css',
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      wasm: 'application/wasm',
    };
    res.writeHead(200, {
      'Content-Type': `${types[ext] ?? 'application/octet-stream'}${['html', 'js', 'css', 'json'].includes(ext) ? '; charset=utf-8' : ''}`,
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  }
  server.on('upgrade', (req, socket, head) => {
    function reject(status: number, code: string) {
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n${JSON.stringify({ v: 1, error: { code } })}`,
      );
    }
    if (req.url !== '/ws') return reject(404, 'PROTOCOL_ERROR');
    if (req.headers.origin !== options.publicOrigin) return reject(403, 'ORIGIN_DENIED');
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map((x) => x.trim());
    if (protocols?.length !== 1 || protocols[0] !== 'qrtoss.v1')
      return reject(400, 'VERSION_UNSUPPORTED');
    if (stopping) return reject(503, 'SERVER_SHUTDOWN');
    const ip = ipOf(req);
    if (
      clients.size >= maxSockets ||
      [...clients].filter((c) => !c.role).length >= maxUnauthenticated ||
      [...clients].filter((c) => c.ip === ip).length >= maxPerIp
    )
      return reject(503, 'CAPACITY');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = core.connect(ws, ip);
      ws.on('message', (raw, binary) => {
        void core
          .message(client, Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer), binary)
          .catch(() => core.fail(client, 'SERVER_ERROR', 1011));
      });
      ws.on('error', (error) => {
        const oversized =
          (error as Error & { code?: string }).code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
        if (client.room)
          core.fail(
            client,
            oversized ? 'MESSAGE_TOO_LARGE' : 'PROTOCOL_ERROR',
            oversized ? 1009 : 1008,
          );
      });
      ws.on('close', () => core.disconnect(client));
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const interval = setInterval(sweep, 1000);
  interval.unref();
  return {
    server,
    sweep,
    stats: core.stats,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
      return `http://${host}:${address.port}`;
    },
    async close() {
      stopping = true;
      clearInterval(interval);
      core.shutdown();
      const timer = setTimeout(() => {
        for (const c of clients) (c.ws as WebSocket).terminate();
      }, 1000);
      timer.unref();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => wss.close(() => resolve())),
      ]);
      clearTimeout(timer);
    },
  };
}
