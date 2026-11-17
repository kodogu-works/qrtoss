import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityState, LEASE_TTL_MS } from '../../packages/relay-core/src/capacity.ts';
import { IpLimits } from '../../packages/relay-core/src/limits.ts';
const limits = { maxRooms: 1, maxSockets: 2, maxUnauthenticatedSockets: 1, maxSocketsPerIp: 1 };

test('capacity reservations are atomic, count unauthenticated sockets, and use fixed retry seconds', () => {
  const state = new CapacityState(limits, () => 0);
  assert.deepEqual(state.acquireRoom('room-1', 'ip'), { ok: true });
  assert.deepEqual(state.acquireRoom('room-2', 'ip'), { ok: false, status: 503, code: 'CAPACITY' });
  state.releaseRoom('room-1');
  assert.deepEqual(state.acquireRoom('room-2', 'ip'), { ok: true });
  assert.deepEqual(state.acquireSocket('s1', 'ip1'), { ok: true });
  assert.equal(state.acquireSocket('s2', 'ip2').ok, false);
  assert.deepEqual(state.acquireSocket('s3', 'ip1'), {
    ok: false,
    status: 429,
    code: 'RATE_LIMITED',
    retryAfter: 6,
  });
  state.authenticateSocket('s1');
  assert.deepEqual(state.acquireSocket('s2', 'ip2'), { ok: true });
  assert.equal(state.acquireSocket('s3', 'ip3').ok, false);
  state.releaseSocket('s1');
  state.authenticateSocket('s2');
  assert.deepEqual(state.acquireSocket('s3', 'ip3'), { ok: true });
});

test('leases expire at 120 seconds and renewal after restart ignores admission caps', () => {
  let clock = 0;
  const state = new CapacityState(limits, () => clock);
  state.acquireRoom('old', 'ip');
  state.acquireSocket('old', 'ip');
  clock = LEASE_TTL_MS - 1;
  assert.equal(state.stats().rooms, 1);
  clock++;
  assert.equal(state.stats().rooms, 0);
  assert.equal(state.stats().sockets, 0);
  // A fresh CapacityDO has the same state as this new instance.
  const restarted = new CapacityState(limits, () => clock);
  restarted.renewRoom('existing-1');
  restarted.renewRoom('existing-2');
  restarted.renewSocket('s1', { ip: 'ip', authenticated: true });
  restarted.renewSocket('s2', { ip: 'ip', authenticated: true });
  assert.equal(restarted.stats().rooms, 2);
  assert.equal(restarted.stats().sockets, 2);
  assert.equal(restarted.stats().unauthenticated, 0);
  assert.equal(restarted.acquireRoom('new', 'ip').ok, false);
  assert.equal(restarted.acquireSocket('new', 'ip2').ok, false);
});

test('creation and authentication token buckets recover with time and are bounded by LRU', () => {
  let clock = 0;
  const state = new CapacityState({ ...limits, maxRooms: 100 }, () => clock);
  for (let i = 0; i < 5; i++) assert.equal(state.acquireRoom(String(i), 'ip').ok, true);
  assert.deepEqual(state.acquireRoom('rate', 'ip'), {
    ok: false,
    status: 429,
    code: 'RATE_LIMITED',
    retryAfter: 6,
  });
  for (let i = 0; i < 20; i++) {
    assert.equal(state.canAuthenticate('ip'), true);
    state.authenticationFailed('ip');
  }
  assert.equal(state.canAuthenticate('ip'), false);
  clock = 3000;
  assert.equal(state.canAuthenticate('ip'), true);
  assert.equal(state.acquireRoom('rate', 'ip').ok, false);
  clock = 6000;
  assert.equal(state.acquireRoom('rate', 'ip').ok, true);
  const ips = new IpLimits();
  for (let i = 0; i < 4096; i++) ips.authenticationFailed(String(i), clock);
  ips.record('0', clock);
  ips.record('new', clock);
  assert.equal(ips.size, 4096);
  assert.equal(ips.record('0', clock).failures.tokens, 19);
  assert.equal(ips.record('1', clock).failures.tokens, 20);
  ips.sweep(clock + 60_000);
  assert.equal(ips.size, 0);
});
