import { test, expect, type Page, type Browser } from '@playwright/test';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { createRelay, type RelayOptions } from '../../server/src/index.ts';
import { translate } from '../../web/src/i18n.ts';

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
    });
    // Keep each case's room creation bucket and session state independent.
    test.beforeEach(async () => {
      host = await deployment(basePath, directory);
      base = host.base;
    });
    test.afterEach(async () => {
      await host?.close();
    });
    test.afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function pairingURL(page: Page) {
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
    async function fakeCamera(page: Page, payload: string, zoom = false) {
      const data = await QRCode.toDataURL(payload, {
        // Render at the displayed size so dense test codes are not resampled.
        width: 300,
        margin: 4,
        errorCorrectionLevel: 'M',
      });
      await page.addInitScript(
        ({ data, zoom }) => {
          // Exercise the decoder Worker, including its lazy-loaded production chunk.
          Object.defineProperty(window, 'BarcodeDetector', {
            value: { getSupportedFormats: async () => [] },
            configurable: true,
          });
          const fixture = window as unknown as {
            qrCameraTracks: MediaStreamTrack[];
            cameraReady: boolean;
            cameraDebug: {
              draws: number;
              ticks: number;
              lastReady: boolean;
              stopped: boolean;
              canvas?: WeakRef<HTMLCanvasElement>;
            };
          };
          fixture.qrCameraTracks = [];
          fixture.cameraReady = false;
          const debug = (fixture.cameraDebug = {
            draws: 0,
            ticks: 0,
            lastReady: false,
            stopped: false,
          });
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
              fixture.cameraDebug.canvas = new WeakRef(c);
              const ctx = c.getContext('2d')!;
              const draw = () => {
                debug.draws++;
                debug.lastReady = fixture.cameraReady;
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, 512, 512);
                if (fixture.cameraReady) ctx.drawImage(img, 106, 106, 300, 300);
              };
              draw();
              const stream = c.captureStream(15), timer = setInterval(() => {
                  debug.ticks++;
                  if (stream.getTracks().every((track) => track.readyState === 'ended')) {
                    debug.stopped = true;
                    clearInterval(timer);
                  } else draw();
              }, 66);
              if (zoom) {
                for (const track of stream.getVideoTracks()) {
                  let value = 1;
                  Object.defineProperties(track, {
                    getCapabilities: { value: () => ({ zoom: { min: 1, max: 4, step: 0.5 } }) },
                    getSettings: { value: () => ({ zoom: value }) },
                    applyConstraints: {
                      value: async (constraints: { advanced: { zoom: number }[] }) => {
                        value = constraints.advanced[0].zoom;
                      },
                    },
                  });
                }
              }
              fixture.qrCameraTracks.push(...stream.getTracks());
              for (const track of stream.getTracks())
                track.addEventListener('ended', () => clearInterval(timer));
              return stream;
            },
          });
        },
        { data, zoom },
      );
    }
    async function scanQR(page: Page, text: string) {
      await page.bringToFront();
      // The app stops scanning in hidden documents; wait for the sender to be visible.
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      await expect.poll(() => page.locator('#video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
      // Exercise the camera fixture after WebKit has had a chance to collect DOM wrappers.
      await page.requestGC();
      await page.evaluate(() => {
        (window as unknown as { cameraReady: boolean }).cameraReady = true;
      });
      try {
        await expect(page.locator('#sender-text')).toHaveText(text);
      } catch (error) {
        const media = await page.locator('#video').evaluate((video: HTMLVideoElement) => {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          if (canvas.width && canvas.height) canvas.getContext('2d')!.drawImage(video, 0, 0);
          return {
            debug: (window as unknown as { cameraDebug: unknown }).cameraDebug,
            source: (
              window as unknown as { cameraDebug: { canvas?: WeakRef<HTMLCanvasElement> } }
            ).cameraDebug.canvas?.deref()?.toDataURL(),
            ready: (window as unknown as { cameraReady: boolean }).cameraReady,
            visibility: document.visibilityState,
            hidden: document.hidden,
            paused: video.paused,
            ended: video.ended,
            readyState: video.readyState,
            width: video.videoWidth,
            height: video.videoHeight,
            currentTime: video.currentTime,
            tracks: (video.srcObject as MediaStream | null)?.getTracks().map((track) => ({
              readyState: track.readyState,
              enabled: track.enabled,
              muted: track.muted,
            })),
            frame: canvas.toDataURL(),
          };
        });
        console.log('camera failure diagnostics', { ...media, frame: undefined, source: undefined });
        if (media.source)
          await test.info().attach('camera-source.png', {
            body: Buffer.from(media.source.split(',')[1], 'base64'),
            contentType: 'image/png',
          });
        await test.info().attach('camera-frame.png', {
          body: Buffer.from(media.frame.split(',')[1], 'base64'),
          contentType: 'image/png',
        });
        throw error;
      }
    }
    async function pages(browser: Browser, payload: string, zoom = false) {
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
      await fakeCamera(s, payload, zoom);
      await r.goto(base);
      const url = await pairingURL(r);
      expect(new URL(url).origin + new URL(url).pathname).toBe(base + 'send');
      await s.goto(url);
      await expect(s).toHaveURL(base + 'send');
      await expect(s.locator('#camera')).toBeVisible();
      await expect(r.locator('#qr')).toHaveAccessibleName('Used connection QR code');
      await expect(r.locator('#expiry')).toHaveText('0 seconds');
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
    test('minimal receiver keeps QR and expiry in view in every language', async ({ page }) => {
      await page.goto(base);
      await pairingURL(page);
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1280, height: 720 },
        { width: 1024, height: 768 },
        { width: 390, height: 844 },
        { width: 375, height: 667 },
        { width: 320, height: 740 },
      ]) {
        await page.setViewportSize(viewport);
        for (const language of ['ja', 'en', 'es'] as const) {
          await page.locator('#language').selectOption(language);
          await expect(page.locator('#qr-help')).toHaveText(translate(language, 'receiverPrompt'));
          await expect(page.locator('#qr')).toHaveAccessibleName(
            translate(language, 'connectionQR'),
          );
          await expect(page.locator('#receiver-result')).toBeHidden();
          await expect(page.locator('#modes, #new-qr, #secret-hint, #status')).toHaveCount(0);
          await expect(page.locator('#marketing-title')).toHaveText(
            translate(language, 'marketingTitle'),
          );
          await expect(page.locator('.feature-grid article')).toHaveCount(7);
          const layout = await page.evaluate(() => {
            const rect = (selector: string) => {
              const r = document.querySelector(selector)!.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
            };
            return {
              width: document.documentElement.scrollWidth,
              qr: rect('#qr'),
              expiry: rect('.expiry'),
              header: rect('.topbar'),
              font: parseFloat(getComputedStyle(document.querySelector('#expiry')!).fontSize),
            };
          });
          expect(layout.width).toBeLessThanOrEqual(viewport.width);
          expect(layout.qr.width).toBeGreaterThanOrEqual(180);
          expect(layout.qr.width).toBeLessThanOrEqual(260);
          expect(layout.qr.bottom).toBeLessThan(viewport.height);
          expect(layout.expiry.bottom).toBeLessThanOrEqual(viewport.height);
          expect(layout.font).toBeGreaterThanOrEqual(14);
          expect(layout.header.height).toBeGreaterThanOrEqual(56);
          expect(layout.header.height).toBeLessThanOrEqual(64);
          const image = PNG.sync.read(await page.locator('#qr').screenshot());
          expect(jsQR(new Uint8ClampedArray(image.data), image.width, image.height)).toBeTruthy();
          await page.screenshot({
            path: test.info().outputPath(`receiver-${language}-${viewport.width}.png`),
            fullPage: true,
          });
        }
      }
    });

    test('language keyboard focus, reload and GitHub link are usable', async ({ page }) => {
      await page.goto(base);
      const original = await pairingURL(page);
      await page.locator('#language').focus();
      await expect(page.locator('#language')).toHaveCSS('outline-style', 'solid');
      await page.locator('#language').selectOption('ja');
      await expect(page.locator('#qr-help')).toHaveText(translate('ja', 'receiverPrompt'));
      await page.locator('#language').selectOption('en');
      await page.reload();
      expect(await pairingURL(page)).not.toBe(original);
      const github = page.getByRole('link', { name: translate('en', 'githubLabel') });
      await expect(github).toHaveAttribute('href', 'https://github.com/kodogu-works/qrtoss');
      await expect(github).toHaveAttribute('target', '_blank');
      await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
      await page
        .context()
        .route('https://github.com/kodogu-works/qrtoss', (route) =>
          route.fulfill({ body: 'qrtoss source', contentType: 'text/plain' }),
        );
      const opened = page.waitForEvent('popup');
      await github.click();
      const popup = await opened;
      await expect(popup).toHaveURL('https://github.com/kodogu-works/qrtoss');
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await popup.close();
    });

    test('pairing replaces QR pixels without moving the layout or allowing rejoin', async ({
      browser,
    }) => {
      const rc = await browser.newContext({ locale: 'en-US' }),
        sc = await browser.newContext({ locale: 'en-US' });
      const r = await rc.newPage(),
        s = await sc.newPage();
      try {
        await r.setViewportSize({ width: 375, height: 667 });
        await r.goto(base);
        const original = await pairingURL(r);
        const geometry = () =>
          r.evaluate(() =>
            Array.from(document.querySelectorAll('#qr-help,#qr,.expiry,.marketing'), (node) => {
              const rect = node.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }),
          );
        const before = await geometry();
        await fakeCamera(s, 'fixture');
        await s.goto(original);
        await expect(r.locator('#qr')).toHaveAccessibleName('Used connection QR code');
        await expect(r.locator('#expiry')).toHaveText('0 seconds');
        expect(await geometry()).toEqual(before);
        const image = PNG.sync.read(await r.locator('#qr').screenshot());
        expect(jsQR(new Uint8ClampedArray(image.data), image.width, image.height)).toBeNull();
        for (const language of ['ja', 'en', 'es'] as const) {
          await r.locator('#language').selectOption(language);
          await expect(r.locator('#qr-help')).toHaveText(
            translate(language, 'receiverConnectedPrompt'),
          );
          await expect(r.locator('#expiry')).toHaveText(
            translate(language, 'qrRemaining', { seconds: 0 }),
          );
        }
        await r.screenshot({
          path: test.info().outputPath('receiver-connected.png'),
          fullPage: true,
        });
        const other = await sc.newPage();
        await other.goto(original);
        await expect(other.locator('#error')).toBeVisible();
        await expect(other.locator('#camera')).toBeHidden();
      } finally {
        await rc.close();
        await sc.close();
      }
    });

    test('long non-URL content wraps, scrolls, copies and clears', async ({ browser }) => {
      const text = 'QR content\n' + '0123456789'.repeat(65);
      const { r, s, rc, sc, failures } = await pages(browser, text);
      try {
        await scanQR(s, text);
        await s.locator('#send').click();
        await expect(r.locator('#receiver-result')).toBeVisible();
        await expect(r.locator('#receiver-text')).toHaveText(text);
        await expect(r.locator('#open')).toBeHidden();
        await expect(r).toHaveURL(base);
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 1280, height: 720 },
          { width: 1024, height: 768 },
          { width: 390, height: 844 },
          { width: 375, height: 667 },
        ]) {
          await r.setViewportSize(viewport);
          for (const language of ['ja', 'en', 'es']) {
            await r.locator('#language').selectOption(language);
            const content = await r.locator('#receiver-text').evaluate((node) => ({
              width: node.scrollWidth,
              visibleWidth: node.clientWidth,
              height: node.scrollHeight,
              visibleHeight: node.clientHeight,
              pageWidth: document.documentElement.scrollWidth,
            }));
            expect(content.width).toBeLessThanOrEqual(content.visibleWidth);
            if (viewport.width <= 390)
              expect(content.height).toBeGreaterThan(content.visibleHeight);
            else expect(content.height).toBeGreaterThanOrEqual(content.visibleHeight);
            expect(content.pageWidth).toBeLessThanOrEqual(viewport.width);
          }
        }
        await r.evaluate(() =>
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async (value: string) => {
                (window as unknown as { copiedText: string }).copiedText = value;
              },
            },
          }),
        );
        await r.locator('#copy').click();
        expect(
          await r.evaluate(() => (window as unknown as { copiedText: string }).copiedText),
        ).toBe(text);
        await expect(r.locator('#copy-feedback')).toHaveText(translate('es', 'copied'));
        await r.locator('#clear').click();
        await expect(r.locator('#receiver-result')).toBeHidden();
        expect(failures).toEqual([]);
      } finally {
        await rc.close();
        await sc.close();
      }
    });

    test('camera starts automatically and stops when the sender leaves', async ({ browser }) => {
      const { r, s, rc, sc } = await pages(browser, 'scan fixture');
      try {
        await expect(s.locator('#scan')).toBeHidden();
        await expect(s.locator('#camera-retry')).toBeHidden();
        await expect(s.locator('#zoom-control')).toBeHidden();
        await expect(s.locator('#sender-instruction')).toHaveText(
          'Scan the QR code you want to send',
        );
        await expect(r.locator('#expiry')).toHaveText('0 seconds');
        for (const viewport of [
          { width: 390, height: 844 },
          { width: 375, height: 667 },
        ]) {
          await s.setViewportSize(viewport);
          await s.locator('#language').selectOption('ja');
          expect(await s.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
            viewport.width,
          );
          const photo = await s.locator('#photo').boundingBox();
          expect(photo!.y + photo!.height).toBeLessThanOrEqual(viewport.height);
          await s.screenshot({
            path: test.info().outputPath(`sender-${viewport.width}.png`),
            fullPage: true,
          });
        }
        await s.goto(base);
        expect(await s.evaluate(() => document.querySelector('video'))).toBeNull();
        await expect(r.locator('#expiry')).toHaveText('0 seconds');
      } finally {
        await rc.close();
        await sc.close();
      }
    });

    test('camera survives a rapid visibility cycle before scanning', async ({ browser }) => {
      const text = 'QR after camera restart';
      const { s, rc, sc, failures } = await pages(browser, text);
      try {
        await expect
          .poll(() =>
            s
              .locator('#video')
              .evaluate(
                (video: HTMLVideoElement) =>
                  !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
              ),
          )
          .toBe(true);
        await s.evaluate(() => {
          for (const state of ['hidden', 'visible']) {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              value: state,
            });
            Object.defineProperty(document, 'hidden', {
              configurable: true,
              value: state === 'hidden',
            });
            document.dispatchEvent(new Event('visibilitychange'));
          }
          Reflect.deleteProperty(document, 'visibilityState');
          Reflect.deleteProperty(document, 'hidden');
        });
        // Playback must keep advancing after the previous scanner's delayed cleanup.
        await expect
          .poll(() => s.locator('#video').evaluate((video: HTMLVideoElement) => video.currentTime))
          .toBeGreaterThan(0.5);
        await scanQR(s, text);
        expect(failures).toEqual([]);
      } finally {
        await rc.close();
        await sc.close();
      }
    });

    test('sender preview has only content, four actions and shared marketing', async ({
      browser,
    }) => {
      const text = 'https://example.org/review';
      const { r, s, rc, sc } = await pages(browser, text);
      try {
        await expect(s.locator('#status, #peer-mode, #domain, #cli-done')).toHaveCount(0);
        await expect(s.locator('.feature-grid article')).toHaveCount(7);
        await expect(s.locator('#sender-instruction')).toBeVisible();
        await scanQR(s, text);
        await expect(s.locator('#sender-instruction')).toBeHidden();
        for (const viewport of [
          { width: 1280, height: 720 },
          { width: 390, height: 844 },
          { width: 375, height: 667 },
        ]) {
          await s.setViewportSize(viewport);
          for (const language of ['ja', 'en', 'es'] as const) {
            await s.locator('#language').selectOption(language);
            await expect(s.locator('#send')).toHaveText(translate(language, 'sendShort'));
            for (const id of ['send', 'scan', 'photo', 'copy'])
              await expect(s.locator('#' + id)).toBeVisible();
            expect(
              await s.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(viewport.width);
            await s.screenshot({
              path: test.info().outputPath(`sender-preview-${language}-${viewport.width}.png`),
              fullPage: true,
            });
          }
        }
        await expect(r.locator('#receiver-result')).toBeHidden();
        await s.evaluate(() => {
          (window as unknown as { cameraReady: boolean }).cameraReady = false;
        });
        await s.locator('#scan').click();
        await expect(s.locator('#camera')).toBeVisible();
        await expect(s.locator('#sender-preview')).toBeHidden();
        await expect(s.locator('#send')).toBeHidden();
      } finally {
        await rc.close();
        await sc.close();
      }
    });

    test('supported zoom remains live while QR detection continues', async ({ browser }) => {
      const { r, s, rc, sc } = await pages(browser, 'zoom fixture', true);
      try {
        await expect(s.locator('#zoom-control')).toBeVisible();
        await s.locator('#zoom').press('End');
        await expect(s.locator('#zoom-value')).toHaveText('4.0×');
        await expect(s.locator('#camera')).toBeVisible();
        await scanQR(s, 'zoom fixture');
        await expect(s.locator('#zoom-control')).toBeHidden();
        await expect(s.locator('#camera')).toBeHidden();
        await expect(r.locator('#receiver-text')).toHaveText('');
      } finally {
        await rc.close();
        await sc.close();
      }
    });

    test('camera failure offers retry and photos are decoded locally before explicit send', async ({
      browser,
    }) => {
      const { r, s, rc, sc, requestPaths, cspViolations, failures } = await pages(
        browser,
        'unused',
      );
      try {
        await s.evaluate(() => {
          Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
            configurable: true,
            value: async () => {
              throw new DOMException('denied', 'NotAllowedError');
            },
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        // A visibility cycle releases the active stream, then exercises a denied restart.
        await s.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect(s.locator('#camera-retry')).toBeVisible();
        await expect(s.locator('#error')).toContainText('Camera permission was not granted');
        await s.locator('#camera-retry').click();
        await expect(s.locator('#camera-retry')).toBeVisible();
        await s.locator('#photo-input').setInputFiles({
          name: 'blank.png',
          mimeType: 'image/png',
          buffer: PNG.sync.write(new PNG({ width: 64, height: 64 })),
        });
        await expect(s.locator('#photo-error')).toBeVisible();
        const content = 'Photo content: https://example.org/local-photo';
        const image = await QRCode.toBuffer(content, { width: 300, margin: 4 });
        await s
          .locator('#photo-input')
          .setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: image });
        await expect(s.locator('#sender-text')).toHaveText(content);
        await expect(r.locator('#receiver-text')).toHaveText('');
        await expect(s.locator('#photo-error')).toBeHidden();
        expect(
          await s.evaluate(() =>
            (window as unknown as { qrCameraTracks: MediaStreamTrack[] }).qrCameraTracks.every(
              (track) => track.readyState === 'ended',
            ),
          ),
        ).toBe(true);
        await s.locator('#send').click();
        await expect(r.locator('#receiver-text')).toHaveText(content);
        expect(requestPaths.every((path) => path.startsWith(basePath))).toBe(true);
        expect(cspViolations).toEqual([]);
        expect(failures).toEqual([]);
      } finally {
        await rc.close();
        await sc.close();
      }
    });

    test('camera QR → explicit confirmation → encrypted transfer displays non-URL content', async ({
      browser,
    }) => {
      const text = 'QR scan fixture: https://example.org/scan?qrtoss=1';
      const { r, s, rc, sc, failures, cspViolations, requestPaths, socketPaths, decoderWorkers } =
        await pages(browser, text);
      try {
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
        await expect(s.locator('#send')).toHaveText('Sent');
        await expect(s.locator('#send')).toBeDisabled();
        await expect(r.locator('#receiver-text')).toHaveText(text);
        await expect(r).toHaveURL(base);
        await expect(r.locator('#open')).toBeHidden();
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
        await expect(r.locator('#receiver-result')).toBeHidden();
        await scanQR(s, text);
        await s.locator('#send').click();
        await expect(r).toHaveURL(text);
        await expect(s.locator('#send')).toHaveText('Sent');
        await expect(s.locator('#send')).toBeDisabled();
        expect(failures).toEqual([]);
        expect(cspViolations).toEqual([]);
      } finally {
        await rc.close();
        await sc.close();
      }
    });
    test('background web receipts require a manual open after returning', async ({ browser }) => {
      const text = 'https://example.org/background-receipt';
      const { r, s, rc, sc, failures } = await pages(browser, text);
      try {
        await r.route(text, (route) =>
          route.fulfill({ body: 'manual destination', contentType: 'text/plain' }),
        );
        await r.evaluate(() =>
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          }),
        );
        await scanQR(s, text);
        await s.locator('#send').click();
        await expect(r.locator('#receiver-result')).toBeVisible();
        await expect(r.locator('#receiver-text')).toHaveText(text);
        await expect(r).toHaveURL(base);
        await r.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect(r).toHaveURL(base);
        await s.close();
        await expect(r.locator('#receiver-result')).toBeVisible();
        await expect(r.locator('#open')).toBeVisible();
        await expect(r.locator('#open')).toBeEnabled();
        await r.locator('#open').click();
        await expect(r).toHaveURL(text);
        expect(failures).toEqual([]);
      } finally {
        await rc.close();
        await sc.close();
      }
    });

    test('non-web URLs are displayed as literal text without an app link', async ({ browser }) => {
      const text = 'mailto:hello@example.org';
      const { r, s, rc, sc } = await pages(browser, text);
      try {
        await scanQR(s, text);
        await s.locator('#send').click();
        await expect(r.locator('#receiver-result')).toBeVisible();
        await expect(r.locator('#receiver-text')).toHaveText(text);
        await expect(r.locator('#open')).toBeHidden();
        await expect(r).toHaveURL(base);
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
        await expect(r.locator('h1')).toHaveText(translate('ja', 'receiverConnectedPrompt'));
        expect(
          await r.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await r.locator('#language').selectOption('es');
        await expect(r.locator('h1')).toHaveText(translate('es', 'receiverConnectedPrompt'));
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
        await expect(r.locator('#expiry')).toHaveText('0 seconds');
        await expect(r.locator('#error')).toBeHidden();
        expect(controls).not.toContain('room.close');
        release();
        await expect(r.locator('#qr')).toHaveAccessibleName('Used connection QR code');
        await expect(s.locator('#sender-instruction')).toBeVisible();
        await expect(s.locator('#status, #peer-mode')).toHaveCount(0);
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
            await expect(r.locator('#qr')).toHaveAccessibleName('Connection QR code');
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
