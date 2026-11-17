import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:https';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createTestRelay } from '../helpers/relay.ts';
import {
  CipherChannel,
  deriveKeys,
  encodeText,
  makeProof,
  randomToken,
  verifyProof,
} from '../../packages/protocol/src/index.ts';
import { Peer } from './peer.ts';
import { socketProxy } from './socket-proxy.ts';

const exec = promisify(execFile);
const cliDirectory = resolve('cli');
const localGo = '/tmp/qrtoss-toolchain/go/bin/go';
const go = process.env.GO ?? (existsSync(localGo) ? localGo : 'go');
const goEnvironment = {
  ...process.env,
  ...(go === localGo
    ? {
        GOCACHE: '/tmp/qrtoss-gocache',
        GOPATH: '/tmp/qrtoss-gopath',
        GOMODCACHE: '/tmp/qrtoss-gopath/pkg/mod',
      }
    : {}),
};
let fixture = '',
  harness = '',
  binary = '',
  certificate: Buffer,
  key: Buffer;

before(
  async () => {
    fixture = await mkdtemp(join(tmpdir(), 'qrtoss-go-interop-'));
    // Keep the test-only source within the Go module's internal import boundary.
    // The shipped executable has no insecure TLS option or test trust hook.
    harness = await mkdtemp(join(cliDirectory, '.interop-'));
    binary = join(fixture, 'receive');
    const source = `package main
import (
  "context"
  "crypto/tls"
  "crypto/x509"
  "net/http"
  "strconv"
  "os"
  "time"
  "github.com/wistaria/qrtoss/cli/internal/client"
)
type delayedWriter struct { delay time.Duration }
func (w delayedWriter) Write(b []byte) (int, error) { time.Sleep(w.delay); return os.Stdout.Write(b) }
func main() {
  ca, err := os.ReadFile(os.Getenv("QRTOSS_TEST_CA")); if err != nil { os.Exit(90) }
  roots := x509.NewCertPool(); if !roots.AppendCertsFromPEM(ca) { os.Exit(91) }
  transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
  defer transport.CloseIdleConnections()
  ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second); defer cancel()
  delay, _ := strconv.Atoi(os.Getenv("QRTOSS_TEST_OUTPUT_DELAY_MS"))
  runner := client.Runner{Out: delayedWriter{time.Duration(delay)*time.Millisecond}, Err: os.Stderr, Env: os.Getenv, HTTPClient: &http.Client{Transport: transport}}
  os.Exit(runner.Run(ctx, os.Args[1:]))
}
`;
    await writeFile(join(harness, 'main.go'), source);
    await exec(go, ['build', '-o', binary, join(harness, 'main.go')], {
      cwd: cliDirectory,
      env: goEnvironment,
      timeout: 120000,
    });
    await writeFile(
      join(fixture, 'openssl.cnf'),
      `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`,
    );
    await exec(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '1',
        '-config',
        join(fixture, 'openssl.cnf'),
        '-keyout',
        join(fixture, 'key.pem'),
        '-out',
        join(fixture, 'cert.pem'),
      ],
      { timeout: 30000 },
    );
    certificate = await readFile(join(fixture, 'cert.pem'));
    key = await readFile(join(fixture, 'key.pem'));
  },
  { timeout: 180000 },
);
after(async () => {
  if (harness) await rm(harness, { recursive: true, force: true });
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

async function start(
  format: 'text' | 'jsonl',
  delay = 0,
  scenario?: 'commit' | 'lateProof' | 'ready' | 'idle',
  timeout = '15',
) {
  const secure = createServer({ key, cert: certificate });
  await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
  const address = secure.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `https://127.0.0.1:${address.port}`;
  let clock = 0,
    firstRoom = true,
    serverExpired = false,
    prematureClose = false,
    touches = 0;
  const delayedProof = Promise.withResolvers<void>();
  const delayedNotification = Promise.withResolvers<void>();
  const relay = await createTestRelay({
    publicOrigin: origin,
    ...(scenario ? { now: () => clock, wallNow: () => 1700000000000 + clock } : {}),
  });
  secure.on('request', (req, res) => {
    if (
      (scenario === 'commit' || scenario === 'lateProof') &&
      firstRoom &&
      req.method === 'POST' &&
      req.url === '/api/v1/rooms'
    ) {
      firstRoom = false;
      // Advance after room creation and before either WebSocket is accepted, so the
      // fake jump cannot accidentally trigger the unauthenticated-socket timeout.
      res.once('finish', () => {
        clock = 299500;
      });
    }
    relay.server.emit('request', req, res);
  });
  const proxy = scenario
    ? socketProxy(secure, await relay.listen(), origin, {
        receiverControl(type) {
          if (type === 'room.close' && !serverExpired) prematureClose = true;
        },
        async receiverMessage(message, forward) {
          // Shorten only the advertised remaining time so these regressions
          // exercise the real CLI without waiting 10 seconds or 30 minutes.
          if (scenario === 'ready' && message.type === 'pair.committed') {
            forward({ ...message, readyExpiresAt: message.serverTime + 250 });
            return;
          }
          if (scenario === 'ready' && message.type === 'pair.active') {
            // ACTIVE was accepted in time; it remains valid after the relay's
            // original ready deadline, even while its notification is delayed.
            clock = 10001;
            await relay.sweep();
            await new Promise((resolve) => setTimeout(resolve, 750));
            forward();
            delayedNotification.resolve();
            return;
          }
          if (scenario === 'idle' && message.type === 'room.touched') {
            touches++;
            if (touches === 1) {
              forward({ ...message, idleExpiresAt: message.serverTime + 250 });
              return;
            }
            if (touches === 2) {
              await new Promise((resolve) => setTimeout(resolve, 750));
              forward();
              delayedNotification.resolve();
              return;
            }
          }
          if (scenario === 'commit' && message.type === 'pair.committed') {
            clock = 300001;
            await relay.sweep();
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
          if (scenario === 'lateProof' && message.type === 'pair.proof' && !serverExpired) {
            // The server forwarded this proof before expiry, but it arrives after both local deadlines.
            await new Promise((resolve) => setTimeout(resolve, 750));
            forward();
            delayedProof.resolve();
            return;
          }
          forward();
        },
      })
    : undefined;
  if (!proxy)
    secure.on('upgrade', (req, socket, head) => relay.server.emit('upgrade', req, socket, head));
  const child = spawn(
    binary,
    [
      '--server',
      origin,
      '--qr',
      'off',
      '--pairing-url',
      '--lang',
      'en',
      '--timeout',
      timeout,
      '--format',
      format,
    ],
    {
      env: {
        ...process.env,
        QRTOSS_TEST_CA: join(fixture, 'cert.pem'),
        QRTOSS_TEST_OUTPUT_DELAY_MS: String(delay),
      },
      stdio: 'pipe',
    },
  );
  let output = '',
    diagnostics = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    output += text;
  });
  child.stderr.on('data', (text) => {
    diagnostics += text;
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
  let sender: Peer | undefined;
  try {
    async function prove(pairing: string) {
      const fragment = new URLSearchParams(new URL(pairing).hash.slice(1));
      const room = fragment.get('r')!,
        cap = fragment.get('j')!,
        psk = fragment.get('k')!;
      const ws = new WebSocket(origin.replace('https:', 'wss:') + '/ws', 'qrtoss.v1', {
        origin,
        ca: certificate,
      });
      sender = new Peer(ws);
      await once(ws, 'open');
      sender.send({ type: 'auth', role: 'sender', room, cap });
      const { peer } = await sender.next('auth.ok');
      const { rNonce } = await sender.next('pair.challenge');
      const sNonce = randomToken(32),
        keys = await deriveKeys(psk, room, peer, rNonce, sNonce);
      sender.send({ type: 'pair.proof', peer, sNonce, proof: await makeProof(keys, 'sender') });
      return { room, peer, keys };
    }
    let proof = await prove(await pairingUrl(child));
    if (scenario === 'lateProof') {
      await delayedProof.promise;
      // Let the serialized receiver loop process the stale proof before the server expires the room.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(prematureClose, false);
      assert.equal(child.exitCode, null);
      assert.doesNotMatch(diagnostics, /PROTOCOL_ERROR|QR_REFRESHED/);
      const renewed = pairingUrl(child);
      serverExpired = true;
      clock = 300001;
      await relay.sweep();
      sender!.close();
      proof = await prove(await renewed);
    }
    const { room, peer, keys } = proof;
    assert.ok(sender);
    await sender.next('pair.committed');
    const confirmation = await sender.next('pair.confirm');
    assert.equal(await verifyProof(keys, 'receiver', confirmation.proof), true);
    sender.channel = new CipherChannel(room, peer, 'sender', keys);
    await sender.app({ type: 'ready' });
    assert.deepEqual(await sender.receive(), { type: 'ready_ack' });
    await sender.next('pair.active');
    if (scenario === 'ready') await delayedNotification.promise;
    assert.deepEqual(await sender.receive(), { type: 'mode', value: 'stdout' });
    if (scenario === 'idle') {
      await sender.next('room.touched');
      await sender.app({ type: 'activity' });
      await delayedNotification.promise;
    }
    if (scenario === 'commit' || scenario === 'ready' || scenario === 'idle') {
      assert.equal(prematureClose, false);
      assert.doesNotMatch(diagnostics, /DISCONNECTED|SESSION_EXPIRED|QR_REFRESHED|PROTOCOL_ERROR/);
    }
    return {
      sender,
      child,
      exited,
      output: () => output,
      diagnostics: () => diagnostics,
      expireIdle() {
        assert.equal(scenario, 'idle');
        serverExpired = true;
        clock += 1800000;
        void relay.sweep();
      },
      async close() {
        sender?.close();
        if (child.exitCode === null) child.kill('SIGTERM');
        await exited;
        await relay.close();
        await new Promise<void>((resolve) => secure.close(() => resolve()));
      },
    };
  } catch (error) {
    sender?.close();
    child.kill('SIGTERM');
    await exited;
    await relay.close();
    await new Promise<void>((resolve) => secure.close(() => resolve()));
    throw error;
  }
}
function pairingUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Go CLI did not show pairing URL'));
    }, 10000);
    const data = (chunk: string) => {
      text += chunk;
      const found = text.match(/^https:\/\/127\.0\.0\.1:\d+\/send#[^\r\n]+$/m);
      if (found) {
        cleanup();
        resolve(found[0]);
      }
    };
    const closed = () => {
      cleanup();
      reject(new Error('Go CLI exited before pairing'));
    };
    function cleanup() {
      clearTimeout(timeout);
      child.stderr.off('data', data);
      child.off('exit', closed);
    }
    child.stderr.on('data', data);
    child.on('exit', closed);
  });
}

test('TS sender → real Go receiver: HTTPS, mutual proof, one text output, ACK and early exit', {
  timeout: 30000,
}, async () => {
  const session = await start('text');
  try {
    const id = randomToken(16),
      text = 'https://example.org/こんにちは?x=1';
    await session.sender.app({ type: 'data', id, textB64: encodeText(text) });
    assert.deepEqual(await session.sender.receive(), { type: 'ack', id, status: 'received' });
    await session.sender.app({ type: 'ack_seen', id });
    assert.equal(await session.exited, 0);
    assert.equal(session.output(), text + '\n');
    assert.match(session.diagnostics(), /\[RECEIVED\]/);
    assert.doesNotMatch(session.diagnostics(), /ACK_UNCONFIRMED/);
  } finally {
    await session.close();
  }
});

test('TS sender → real Go receiver: JSON Lines preserves BOM, newline, NUL and Unicode', {
  timeout: 30000,
}, async () => {
  const session = await start('jsonl');
  try {
    const id = randomToken(16),
      text = '\ufeffこんにちは😀\nQR\u0000\u202e';
    await session.sender.app({ type: 'data', id, textB64: encodeText(text) });
    assert.deepEqual(await session.sender.receive(), { type: 'ack', id, status: 'received' });
    await session.sender.app({ type: 'ack_seen', id });
    assert.equal(await session.exited, 0);
    assert.deepEqual(JSON.parse(session.output()), { text });
    assert.equal(session.output().split('\n').length, 2);
    assert.match(session.output(), /\\u0000\\u202e/);
  } finally {
    await session.close();
  }
});

test('TS sender → real Go receiver: unsupported text is rejected without stdout and exits 6', {
  timeout: 30000,
}, async () => {
  const session = await start('text');
  try {
    const id = randomToken(16);
    await session.sender.app({ type: 'data', id, textB64: encodeText('line one\nline two') });
    assert.deepEqual(await session.sender.receive(), {
      type: 'ack',
      id,
      status: 'rejected',
      reason: 'unsupported_content',
    });
    await session.sender.app({ type: 'ack_seen', id });
    assert.equal(await session.exited, 6);
    assert.equal(session.output(), '');
    assert.match(session.diagnostics(), /\[REJECTED\]/);
  } finally {
    await session.close();
  }
});

test('TS sender → real Go receiver: slow stdout delays ACK and duplicate data produces one output', {
  timeout: 30000,
}, async () => {
  const session = await start('text', 250);
  try {
    const id = randomToken(16),
      data = { type: 'data' as const, id, textB64: encodeText('one record') };
    await session.sender.app(data);
    let acknowledged = false;
    const receipt = session.sender.receive().then((message) => {
      acknowledged = true;
      return message;
    });
    await session.sender.app(data);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(acknowledged, false);
    assert.equal(session.output(), '');
    assert.deepEqual(await receipt, { type: 'ack', id, status: 'received' });
    await session.sender.app({ type: 'ack_seen', id });
    assert.equal(await session.exited, 0);
    assert.equal(session.output(), 'one record\n');
  } finally {
    await session.close();
  }
});

test('TS sender → real Go receiver: missing ack_seen preserves successful stdout and bounded exit', {
  timeout: 30000,
}, async () => {
  const session = await start('text');
  try {
    const id = randomToken(16);
    await session.sender.app({ type: 'data', id, textB64: encodeText('delivered') });
    assert.deepEqual(await session.sender.receive(), { type: 'ack', id, status: 'received' });
    const start = performance.now();
    assert.equal(await session.exited, 0);
    assert.ok(performance.now() - start < 2500);
    assert.equal(session.output(), 'delivered\n');
    assert.match(session.diagnostics(), /\[ACK_UNCONFIRMED\]/);
  } finally {
    await session.close();
  }
});

for (const scenario of ['commit', 'lateProof'] as const) {
  test(`real Go receiver: ${scenario === 'commit' ? 'commit notification and ready cross the QR deadline' : 'late proof is ignored until server expiry and QR renewal'}`, {
    timeout: 30000,
  }, async () => {
    const session = await start('text', 0, scenario);
    try {
      const id = randomToken(16);
      await session.sender.app({ type: 'data', id, textB64: encodeText('deadline boundary') });
      assert.deepEqual(await session.sender.receive(), { type: 'ack', id, status: 'received' });
      await session.sender.app({ type: 'ack_seen', id });
      assert.equal(await session.exited, 0);
      assert.equal(session.output(), 'deadline boundary\n');
      assert.doesNotMatch(session.diagnostics(), /PROTOCOL_ERROR/);
      if (scenario === 'lateProof') assert.match(session.diagnostics(), /QR_REFRESHED/);
    } finally {
      await session.close();
    }
  });
}

for (const scenario of ['ready', 'idle'] as const) {
  test(`real Go receiver: delayed ${scenario === 'ready' ? 'ACTIVE' : 'touch'} notification does not expire the session locally`, {
    timeout: 30000,
  }, async () => {
    const session = await start('text', 0, scenario);
    try {
      const id = randomToken(16);
      await session.sender.app({ type: 'data', id, textB64: encodeText('delayed notification') });
      assert.deepEqual(await session.sender.receive(), { type: 'ack', id, status: 'received' });
      await session.sender.app({ type: 'ack_seen', id });
      assert.equal(await session.exited, 0);
      assert.equal(session.output(), 'delayed notification\n');
      assert.doesNotMatch(session.diagnostics(), /DISCONNECTED|SESSION_EXPIRED|PROTOCOL_ERROR/);
    } finally {
      await session.close();
    }
  });
}

test('real Go receiver: server idle expiry reports SESSION_EXPIRED and renews the QR', {
  timeout: 30000,
}, async () => {
  const session = await start('text', 0, 'idle');
  try {
    const renewed = pairingUrl(session.child);
    session.expireIdle();
    await renewed;
    assert.match(session.diagnostics(), /\[SESSION_EXPIRED\]/);
    assert.match(session.diagnostics(), /\[QR_REFRESHED\]/);
    assert.doesNotMatch(session.diagnostics(), /\[DISCONNECTED\]|PROTOCOL_ERROR/);
    assert.equal(session.output(), '');
    assert.equal(session.child.exitCode, null);
  } finally {
    await session.close();
  }
});

test('permanent rejection retains exit 6 after a protocol violation', {
  timeout: 30000,
}, async () => {
  const session = await start('text');
  try {
    const id = randomToken(16);
    await session.sender.app({ type: 'data', id, textB64: encodeText('line one\nline two') });
    assert.deepEqual(await session.sender.receive(), {
      type: 'ack',
      id,
      status: 'rejected',
      reason: 'unsupported_content',
    });
    await session.sender.app({
      type: 'data',
      id: randomToken(16),
      textB64: encodeText('another item'),
    });
    assert.equal(await session.exited, 6);
    assert.equal(session.output(), '');
    assert.match(session.diagnostics(), /PROTOCOL_ERROR/);
  } finally {
    await session.close();
  }
});

test('coalesced CLI activity sends a trailing touch at the next heartbeat', {
  timeout: 30000,
}, async () => {
  const session = await start('text', 0, undefined, '25');
  try {
    await session.sender.next('room.touched');
    await session.sender.app({ type: 'activity' });
    // The initial ACTIVE touch coalesces this activity; heartbeat must flush it.
    await new Promise((resolve) => setTimeout(resolve, 14000));
    await session.sender.next('room.touched');
    assert.equal(session.child.exitCode, null);
  } finally {
    await session.close();
  }
});
