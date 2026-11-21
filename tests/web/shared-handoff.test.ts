import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  SharedHandoffHost,
  handoffToController,
  type ChannelFactory,
  type ChannelLike,
} from '../../web/src/shared-handoff.ts';

const invitation = {
  pair: 'AAECAwQFBgcICQoLDA0ODw',
  join: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  psk: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
};

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

function bus(): ChannelFactory {
  const channels = new Set<ChannelLike>();
  return () => {
    const channel: ChannelLike = {
      onmessage: null,
      postMessage(value) {
        for (const other of channels)
          if (other !== channel)
            other.onmessage?.({ data: structuredClone(value) } as MessageEvent);
      },
      close() {
        channels.delete(channel);
      },
    };
    channels.add(channel);
    return channel;
  };
}

test('one controller receives the secret only after a nonce-bound offer', async () => {
  const factory = bus();
  const received: unknown[] = [];
  const host = new SharedHandoffHost(
    (value) => {
      received.push(value);
    },
    factory,
    2,
  );
  assert.equal(await handoffToController(invitation, factory, 2), 'accepted');
  assert.deepEqual(received, [invitation]);
  host.close();
});

test('zero and multiple controllers do not receive an ambiguous delivery', async () => {
  const factory = bus();
  assert.equal(await handoffToController(invitation, factory, 1), 'none');
  const received: unknown[] = [];
  const one = new SharedHandoffHost(
    (value) => {
      received.push(value);
    },
    factory,
    2,
  );
  const two = new SharedHandoffHost(
    (value) => {
      received.push(value);
    },
    factory,
    2,
  );
  assert.equal(await handoffToController(invitation, factory, 2), 'multiple');
  assert.deepEqual(received, []);
  one.close();
  two.close();
});
