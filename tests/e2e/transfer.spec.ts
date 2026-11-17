import { test, expect, type Page, type Browser } from '@playwright/test';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { createRelay, type RelayOptions } from '../../server/src/index.ts';

/** Match the production proxy contract: strip the mount from HTTP and WS paths. */
async function deployment(
  basePath: string,
  staticDir: string,
  options: Pick<RelayOptions, 'now' | 'wallNow'> = {},
) {
  let target = '';
  const sockets = new Set<Socket>();
  const proxy = createServer((req, res) => {
    if (!req.url?.startsWith(basePath)) {
      res.writeHead(404).end();
      return;
    }
    const upstream = request(
      target + '/' + req.url.slice(basePath.length),
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith(basePath)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = request(target + '/' + req.url.slice(basePath.length), {
      headers: req.headers,
    });
    upstream.on('upgrade', (response, backend, backendHead) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
      socket.write('\r\n');
      if (backendHead.length) socket.write(backendHead);
      if (head.length) backend.write(head);
      backend.on('error', () => socket.destroy());
      socket.on('error', () => backend.destroy());
      socket.on('close', () => backend.destroy());
      backend.on('close', () => socket.destroy());
      socket.pipe(backend).pipe(socket);
    });
    upstream.on('response', (response) => {
      response.resume();
      socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
  const origin = `http://127.0.0.1:${address.port}`;
  const relay = createRelay({
    publicOrigin: origin,
    allowHttpLoopback: true,
    staticDir,
    ...options,
  });
  target = await relay.listen();
  return {
    base: origin + basePath,
    origin,
    relay,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        relay.close(),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
      ]);
    },
  };
}

for (const basePath of ['/', '/qrtoss/'])
  test.describe(`deployment ${basePath}`, () => {
    let host: Awaited<ReturnType<typeof deployment>>;
    let directory: string;
    let base: string;
    test.beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'qrtoss-e2e-'));
      execFileSync(
        process.execPath,
        [
          'node_modules/vite/bin/vite.js',
          'build',
          '--config',
          'web/vite.config.ts',
          '--outDir',
          directory,
          '--emptyOutDir',
        ],
        {
          env: { ...process.env, QRTOSS_BASE_PATH: basePath },
          stdio: 'pipe',
        },
      );
      host = await deployment(basePath, directory);
      base = host.base;
    });
    test.afterAll(async () => {
      await host?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function pairingURL(page: Page) {
      await expect(page.locator('#status')).toHaveText(/Waiting for your phone/);
      await expect(page.locator('#qr-loading')).toBeHidden();
      // Decode actual canvas pixels without automation injecting screenshot CSS.
      const image = await page.locator('#qr').evaluate((canvas: HTMLCanvasElement) => ({
        width: canvas.width,
        height: canvas.height,
        data: Array.from(
          canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
        ),
      }));
      const qr = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
      expect(qr).toBeTruthy();
      return qr!.data;
    }
    async function fakeCamera(page: Page, payload: string) {
      const data = await QRCode.toDataURL(payload, {
        width: 512,
        margin: 4,
        errorCorrectionLevel: 'M',
      });
      await page.addInitScript(
        ({ data }) => {
          // Exercise the decoder Worker, including its lazy-loaded production chunk.
          Object.defineProperty(window, 'BarcodeDetector', {
            value: { getSupportedFormats: async () => [] },
            configurable: true,
          });
          const fixture = window as unknown as { qrCameraTracks: MediaStreamTrack[] };
          fixture.qrCameraTracks = [];
          // WebKit can collect and recreate the mediaDevices wrapper, losing own properties.
          // Keep the camera override on the prototype so it survives garbage collection.
          Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
            configurable: true,
            value: async () => {
              const img = new Image();
              img.src = data;
              await img.decode();
              const c = document.createElement('canvas');
              c.width = c.height = 512;
              const draw = () => {
                const ctx = c.getContext('2d')!;
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, 512, 512);
                ctx.drawImage(img, 106, 106, 300, 300);
              };
              draw();
              const stream = c.captureStream(15),
                timer = setInterval(() => {
                  if (stream.getTracks().every((track) => track.readyState === 'ended'))
                    clearInterval(timer);
                  else draw();
                }, 66);
              fixture.qrCameraTracks.push(...stream.getTracks());
              for (const track of stream.getTracks())
                track.addEventListener('ended', () => clearInterval(timer));
              return stream;
            },
          });
        },
        { data },
      );
    }
    async function scanQR(page: Page, text: string) {
      await page.bringToFront();
      // The app stops scanning in hidden documents; wait for the sender to be visible.
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      // Exercise the camera fixture after WebKit has had a chance to collect DOM wrappers.
      await page.requestGC();
      await page.locator('#scan').click();
      await expect(page.locator('#sender-text')).toHaveText(text);
    }
    async function pages(browser: Browser, payload: string) {
      const rc = await browser.newContext({ locale: 'en-US' }),
        sc = await browser.newContext({ locale: 'en-US' });
      const r = await rc.newPage(),
        s = await sc.newPage();
      const failures: string[] = [];
      const requestPaths: string[] = [],
        socketPaths: string[] = [];
      let decoderWorkers = 0;
      s.on('worker', () => decoderWorkers++);
      const cspViolations: {
        directive: string;
        blockedURI: string;
        sourceFile: string;
        line: number;
        sample: string;
      }[] = [];
      for (const page of [r, s]) {
        page.on('request', (request) => {
          const url = new URL(request.url());
          if (url.protocol === 'http:' && url.origin === host.origin)
            requestPaths.push(url.pathname);
        });
        page.on('websocket', (socket) => socketPaths.push(new URL(socket.url()).pathname));
        await page.exposeFunction(
          'recordCspViolation',
          (violation: (typeof cspViolations)[number]) => cspViolations.push(violation),
        );
        await page.addInitScript(() =>
          document.addEventListener('securitypolicyviolation', (event) => {
            void (
              window as unknown as { recordCspViolation: (violation: unknown) => Promise<void> }
            ).recordCspViolation({
              directive: event.violatedDirective,
              blockedURI: event.blockedURI,
              sourceFile: event.sourceFile,
              line: event.lineNumber,
              sample: event.sample,
            });
          }),
        );
      }
      r.on('pageerror', (e) => failures.push(e.message));
      s.on('pageerror', (e) => failures.push(e.message));
      await fakeCamera(s, payload);
      await r.goto(base);
      const url = await pairingURL(r);
      expect(new URL(url).origin + new URL(url).pathname).toBe(base + 'send');
      await s.goto(url);
      await expect(s).toHaveURL(base + 'send');
      await expect(s.locator('#status')).toHaveText('Connected securely');
      await expect(r.locator('#status')).toHaveText('Connected securely');
      return {
        r,
        s,
        rc,
        sc,
        failures,
        url,
        cspViolations,
        requestPaths,
        socketPaths,
        decoderWorkers: () => decoderWorkers,
      };
    }
    test('receiver shows scanning and resets after the sender stops', async ({ browser }) => {
      const { r, s, rc, sc } = await pages(browser, 'scan fixture');
      try {
        // Keep the camera starting until Stop is clicked, without decoding a QR.
        await s.evaluate(() => {
          Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
            configurable: true,
            value: () => new Promise(() => {}),
          });
        });
        await s.locator('#scan').click();
        await expect(r.locator('#status')).toHaveText('The sender is scanning a QR code.');
        await s.locator('#stop').click();
        await expect(r.locator('#status')).toHaveText('Connected securely');
      } finally {
        await rc.close();
        await sc.close();
      }
    });
    test('camera QR → explicit confirmation → encrypted transfer to display-only receiver', async ({
      browser,
    }) => {
      const text = 'https://example.org/scan?qrtoss=1';
      const { r, s, rc, sc, failures, cspViolations, requestPaths, socketPaths, decoderWorkers } =
        await pages(browser, text);
      try {
        await r.locator('input[value="display_only"]').check();
        await scanQR(s, text);
        expect(
          await s.evaluate(() => {
            const tracks = (window as unknown as { qrCameraTracks: MediaStreamTrack[] })
              .qrCameraTracks;
            return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
          }),
        ).toBe(true);
        await expect(r.locator('#receiver-text')).toHaveText('');
        await s.locator('#send').click();
        await expect(s.locator('#status')).toHaveText('Received by the other device');
        await expect(r.locator('#receiver-text')).toHaveText(text);
        await expect(r).toHaveURL(base);
        await expect(r.locator('#open')).toBeEnabled();
        expect(failures).toEqual([]);
        expect(cspViolations).toEqual([]);
        expect(
          await r.evaluate(() => ({
            local: Object.keys(localStorage),
            session: Object.keys(sessionStorage),
          })),
        ).toEqual({ local: [], session: [] });
        expect(
          await s.evaluate(() => ({
            local: Object.keys(localStorage),
            session: Object.keys(sessionStorage),
          })),
        ).toEqual({ local: [], session: [] });
        expect(decoderWorkers()).toBeGreaterThan(0);
        expect(requestPaths.every((path) => path.startsWith(basePath))).toBe(true);
        expect(requestPaths).toContain(basePath + 'api/v1/rooms');
        expect(socketPaths).toEqual([basePath + 'ws', basePath + 'ws']);
        await expect(s.locator('a.wordmark')).toHaveAttribute('href', basePath);
        await s.locator('a.wordmark').click();
        await expect(s).toHaveURL(base);
        await expect(s.locator('#qr')).toBeVisible();
      } finally {
        await rc.close();
        await sc.close();
      }
    });
    test('default mode opens an accepted web URL in the same tab after ack_seen', async ({
      browser,
    }) => {
      const text = 'https://example.org/received';
      const { r, s, rc, sc, failures, cspViolations } = await pages(browser, text);
      try {
        await r.route(text, (route) =>
          route.fulfill({ body: 'received destination', contentType: 'text/plain' }),
        );
        await expect(r.locator('input[value="auto_open"]')).toBeChecked();
        await scanQR(s, text);
        await s.locator('#send').click();
        await expect(r).toHaveURL(text);
        await expect(s.locator('#status')).toHaveText('Received by the other device');
        expect(failures).toEqual([]);
        expect(cspViolations).toEqual([]);
      } finally {
        await rc.close();
        await sc.close();
      }
    });
    test('inert content stays literal, language switches and mobile layout fits', async ({
      browser,
    }) => {
      const text = 'javascript:alert("never execute")';
      const { r, s, rc, sc, failures, cspViolations } = await pages(browser, text);
      try {
        await scanQR(s, text);
        await s.locator('#send').click();
        await expect(r.locator('#receiver-text')).toHaveText(text);
        await expect(r.locator('#open')).toBeHidden();
        await r.setViewportSize({ width: 320, height: 740 });
        await r.locator('#language').selectOption('ja');
        await expect(r.locator('h1')).toHaveText('この端末で受信');
        expect(
          await r.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await r.locator('#language').selectOption('es');
        await expect(r.locator('h1')).toHaveText('Recibir en este dispositivo');
        expect(failures).toEqual([]);
        expect(cspViolations).toEqual([]);
      } finally {
        await rc.close();
        await sc.close();
      }
    });
    test('invalid pairing fragment is removed and no connection is attempted', async ({ page }) => {
      let sockets = 0;
      page.on('websocket', () => sockets++);
      await page.goto(base + 'send#v=1&r=secret&j=x&k=x');
      await expect(page).toHaveURL(base + 'send');
      await expect(page.locator('#error')).toBeVisible();
      expect(sockets).toBe(0);
    });

    test('QR countdown reaching zero cannot interrupt an in-flight commit and ready exchange', async ({
      browser,
    }) => {
      let clock = 0;
      const fixture = await deployment(basePath, directory, {
        now: () => clock,
        wallNow: () => 1700000000000 + clock,
      });
      const rc = await browser.newContext({ locale: 'en-US' }),
        sc = await browser.newContext({ locale: 'en-US' });
      const r = await rc.newPage(),
        s = await sc.newPage();
      const committed = Promise.withResolvers<() => void>();
      const controls: string[] = [];
      try {
        await r.addInitScript(() =>
          Object.defineProperty(performance, 'now', { configurable: true, value: () => 0 }),
        );
        await r.route('**/api/v1/rooms', async (route) => {
          const response = await route.fetch();
          // Create the room at zero, then authenticate just before its deadline.
          clock = 299000;
          await route.fulfill({ response });
        });
        await r.routeWebSocket('**/ws', (ws) => {
          const server = ws.connectToServer();
          ws.onMessage((message) => {
            controls.push(JSON.parse(message.toString()).type);
            server.send(message);
          });
          server.onMessage((message) => {
            if (JSON.parse(message.toString()).type === 'pair.committed')
              committed.resolve(() => ws.send(message));
            else ws.send(message);
          });
        });
        await r.goto(fixture.base);
        const url = await pairingURL(r);
        await s.goto(url);
        const release = await committed.promise;
        clock = 300001;
        fixture.relay.sweep();
        await r.evaluate(() => {
          Object.defineProperty(performance, 'now', { configurable: true, value: () => 1001 });
        });
        // The UI timer has run past the advertised deadline while pair.committed is delayed.
        await expect(r.locator('#expiry')).toHaveText('Expires in 0s');
        await expect(r.locator('#error')).toBeHidden();
        expect(controls).not.toContain('room.close');
        release();
        await expect(r.locator('#status')).toHaveText('Connected securely');
        await expect(s.locator('#status')).toHaveText('Connected securely');
        expect(fixture.relay.stats().rooms).toBe(1);
      } finally {
        await rc.close();
        await sc.close();
        await fixture.close();
      }
    });

    for (const expired of ['candidate', 'QR'] as const)
      test(`proof arriving after the local ${expired} deadline waits for the server's expiry decision`, async ({
        browser,
      }) => {
        let clock = 0;
        const fixture = await deployment(basePath, directory, {
          now: () => clock,
          wallNow: () => 1700000000000 + clock,
        });
        const rc = await browser.newContext({ locale: 'en-US' }),
          sc = await browser.newContext({ locale: 'en-US' });
        const r = await rc.newPage(),
          s = await sc.newPage();
        const proof = Promise.withResolvers<() => void>();
        const controls: string[] = [];
        try {
          await r.addInitScript(() =>
            Object.defineProperty(performance, 'now', { configurable: true, value: () => 0 }),
          );
          await r.routeWebSocket('**/ws', (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((message) => {
              controls.push(JSON.parse(message.toString()).type);
              server.send(message);
            });
            server.onMessage((message) => {
              if (JSON.parse(message.toString()).type === 'pair.proof')
                proof.resolve(() => ws.send(message));
              else ws.send(message);
            });
          });
          await r.goto(fixture.base);
          const url = await pairingURL(r);
          await s.goto(url);
          const release = await proof.promise;
          clock = expired === 'candidate' ? 10001 : 300001;
          await r.evaluate((offset) => {
            Object.defineProperty(performance, 'now', { configurable: true, value: () => offset });
          }, clock);
          release();
          // The server notification follows the delayed proof on the same ordered stream.
          fixture.relay.sweep();
          if (expired === 'candidate') {
            await expect(r.locator('#status')).toHaveText('Waiting for your phone');
            await expect(r.locator('#error')).toBeHidden();
            expect(fixture.relay.stats().rooms).toBe(1);
          } else {
            await expect(r.locator('#error')).toHaveText('The connection QR code expired.');
            expect(fixture.relay.stats().rooms).toBe(0);
          }
          expect(controls).not.toContain('pair.commit');
          expect(controls).not.toContain('pair.reject');
        } finally {
          await rc.close();
          await sc.close();
          await fixture.close();
        }
      });
  });
