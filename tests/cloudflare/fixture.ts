import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import {
  Miniflare,
  Log,
  LogLevel,
  convertV4MiniflareOptions,
  type Request as MFRequest,
  Response as MFResponse,
} from 'miniflare';
import { WebSocketServer, WebSocket } from 'ws';
import type { RelayOptions } from '../../server/src/index.ts';
import type { CapacityState } from '../../packages/relay-core/src/capacity.ts';

let bundle: Promise<string> | undefined;
function testBundle() {
  bundle ??= build({
    entryPoints: ['tests/cloudflare/worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    external: ['cloudflare:workers'],
    write: false,
  }).then((result) => result.outputFiles[0].text);
  return bundle;
}
export async function createCloudflareRelay(
  options: RelayOptions,
  settings: { persist?: string; bindings?: Record<string, string> } = {},
) {
  const script = await testBundle();
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8')) as {
    compatibility_date: string;
    compatibility_flags: string[];
  };
  const origin = options.publicOrigin.startsWith('https:')
    ? options.publicOrigin
    : options.publicOrigin.replace('http:', 'https:');
  const logs: string[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      unsafeDirectSockets: [{ host: '127.0.0.1', port: 0, proxy: true }],
      bindings: {
        PUBLIC_ORIGIN: origin,
        MAX_ROOMS: String(options.maxRooms ?? 1000),
        MAX_SOCKETS: String(options.maxSockets ?? 2200),
        MAX_UNAUTHENTICATED_SOCKETS: String(options.maxUnauthenticatedSockets ?? 100),
        MAX_SOCKETS_PER_IP: String(options.maxSocketsPerIp ?? 60),
        IPV6_PREFIX_LENGTH: String(options.ipv6PrefixLength ?? 64),
        TEST_NOW: options.now ? String(options.now()) : 'real',
        TEST_WALL: options.wallNow ? String(options.wallNow()) : 'real',
        ...settings.bindings,
      },
      durableObjects: {
        ROOM: { className: 'RoomDO', useSQLite: true },
        CAPACITY: { className: 'CapacityDO', useSQLite: true },
      },
      resourcePersistencePath: settings.persist,
      telemetry: { enabled: false },
      handleStructuredLogs: (entry) => {
        logs.push(entry.message);
      },
      log: new Log(LogLevel.NONE),
      serviceBindings: {
        ASSETS: async (request: MFRequest) => {
          try {
            const path = new URL(request.url).pathname;
            const content = await readFile(resolve(options.staticDir ?? 'dist/web', '.' + path));
            return new MFResponse(request.method === 'HEAD' ? null : content, {
              headers: {
                'Content-Type': path.endsWith('.html')
                  ? 'text/html; charset=utf-8'
                  : 'text/javascript; charset=utf-8',
              },
            });
          } catch {
            return new MFResponse(null, { status: 404 });
          }
        },
      },
    }),
  );
  await mf.ready;
  let stopped = false;
  async function control(action?: string) {
    if (stopped)
      return {
        rooms: 0,
        sockets: 0,
        capacity: {
          rooms: 0,
          sockets: 0,
          unauthenticated: 0,
          releasedRooms: 0,
          releasedSockets: 0,
          ips: 0,
        },
      };
    const response = await mf.dispatchFetch('https://test.internal/control', {
      method: 'POST',
      body: JSON.stringify({ now: options.now?.(), wall: options.wallNow?.(), action }),
    });
    return (await response.json()) as {
      rooms: number;
      sockets: number;
      capacity: ReturnType<CapacityState['stats']>;
    };
  }
  const server = createServer((req, res) => {
    void (async () => {
      await control();
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await mf.dispatchFetch(origin + req.url, {
        method: req.method,
        headers: {
          ...(Object.fromEntries(
            Object.entries(req.headers).filter((entry) => typeof entry[1] === 'string'),
          ) as Record<string, string>),
          origin: req.headers.origin === options.publicOrigin ? origin : (req.headers.origin ?? ''),
          'CF-Connecting-IP': (req.headers['x-test-ip'] as string) ?? '127.0.0.1',
        },
        body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('qrtoss.v1') ? 'qrtoss.v1' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      await control();
      const response = await mf.dispatchFetch(origin + req.url, {
        headers: {
          ...(Object.fromEntries(
            Object.entries(req.headers).filter((entry) => typeof entry[1] === 'string'),
          ) as Record<string, string>),
          origin: req.headers.origin === options.publicOrigin ? origin : (req.headers.origin ?? ''),
          'CF-Connecting-IP': (req.headers['x-test-ip'] as string) ?? '127.0.0.1',
        },
      });
      if (response.status !== 101 || !response.webSocket) {
        socket.end(`HTTP/1.1 ${response.status} Rejected\r\nConnection: close\r\n\r\n`);
        return;
      }
      const backend = response.webSocket;
      backend.accept();
      wss.handleUpgrade(req, socket, head, (client) => {
        let queue = Promise.resolve();
        client.on('message', (raw, binary) => {
          queue = queue
            .then(async () => {
              await control();
              if (backend.readyState !== 1) return;
              if (binary) backend.send(new Uint8Array(raw as Buffer));
              else backend.send(raw.toString());
            })
            .catch(() => client.close(1011));
        });
        backend.addEventListener('message', (event) => {
          if (client.readyState === WebSocket.OPEN) client.send(event.data);
        });
        backend.addEventListener('close', (event) => {
          if (client.readyState === WebSocket.OPEN)
            client.close([1005, 1006].includes(event.code) ? 1011 : event.code);
        });
        client.on('error', () => {});
        client.on('close', (code) => {
          if (backend.readyState === 1) backend.close([1005, 1006].includes(code) ? 1011 : code);
        });
      });
    })().catch(() => socket.destroy());
  });
  return {
    server,
    mf,
    control,
    origin,
    logs,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise<void>((done) => server.listen(port, host, done));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
      return `http://${host}:${address.port}`;
    },
    stats: () => control(),
    sweep: () => control('sweep'),
    async close() {
      if (stopped) return;
      await control('shutdown');
      stopped = true;
      for (const client of wss.clients) client.terminate();
      await mf.dispose();
      await new Promise<void>((done) => server.close(() => done()));
      wss.close();
    },
  };
}
