import { decodeBase64, encodeBase64 } from '../../packages/protocol/src/validation.ts';
import type { SharedInvitation } from './shared-link.ts';

export const SHARED_HANDOFF_CHANNEL = 'qrtoss.shared-controller.v1';
export const SHARED_HANDOFF_WAIT_MS = 1000;

type ChannelMessage =
  | { v: 1; type: 'probe'; request: string }
  | { v: 1; type: 'offer'; request: string; manager: string; nonce: string }
  | {
      v: 1;
      type: 'deliver';
      request: string;
      manager: string;
      nonce: string;
      invitation: SharedInvitation;
    }
  | { v: 1; type: 'accepted'; request: string; manager: string; nonce: string };

export type HandoffResult = 'accepted' | 'none' | 'multiple' | 'unavailable';

export interface ChannelLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}

export type ChannelFactory = (name: string) => ChannelLike;

const defaultFactory: ChannelFactory = (name) => new BroadcastChannel(name);

function token(bytes: number): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(bytes)));
}

function parse(value: unknown): ChannelMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const m = value as Record<string, unknown>;
  if (m.v !== 1 || typeof m.type !== 'string') return;
  try {
    if (typeof m.request !== 'string') return;
    decodeBase64(m.request, 16);
    if (m.type === 'probe' && Object.keys(m).length === 3) return m as ChannelMessage;
    if (typeof m.manager !== 'string' || typeof m.nonce !== 'string') return;
    decodeBase64(m.manager, 16);
    decodeBase64(m.nonce, 16);
    if ((m.type === 'offer' || m.type === 'accepted') && Object.keys(m).length === 5)
      return m as ChannelMessage;
    if (m.type === 'deliver' && Object.keys(m).length === 6) {
      const invitation = m.invitation as Record<string, unknown>;
      if (!invitation || typeof invitation !== 'object' || Array.isArray(invitation)) return;
      if (
        Object.keys(invitation).length !== 3 ||
        !['pair', 'join', 'psk'].every((key) => typeof invitation[key] === 'string')
      )
        return;
      decodeBase64(String(invitation.pair), 16);
      decodeBase64(String(invitation.join), 32);
      decodeBase64(String(invitation.psk), 32);
      return m as ChannelMessage;
    }
  } catch {
    return;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Find an existing controller before making any network request. */
export async function handoffToController(
  source: SharedInvitation,
  factory: ChannelFactory = defaultFactory,
  waitMs = SHARED_HANDOFF_WAIT_MS,
): Promise<HandoffResult> {
  let channel: ChannelLike;
  try {
    channel = factory(SHARED_HANDOFF_CHANNEL);
  } catch {
    return 'unavailable';
  }
  const request = token(16);
  const offers = new Map<string, Extract<ChannelMessage, { type: 'offer' }>>();
  let accepted = false;
  channel.onmessage = (event) => {
    const message = parse(event.data);
    if (!message || message.request !== request) return;
    if (message.type === 'offer') offers.set(message.manager, message);
    if (message.type === 'accepted') {
      const offer = offers.get(message.manager);
      if (offer?.nonce === message.nonce) accepted = true;
    }
  };
  channel.postMessage({ v: 1, type: 'probe', request } satisfies ChannelMessage);
  await delay(waitMs);
  if (offers.size !== 1) {
    channel.close();
    return offers.size ? 'multiple' : 'none';
  }
  const offer = offers.values().next().value!;
  // Copy once so the message can be released immediately after acknowledgement/timeout.
  let invitation: SharedInvitation | undefined = { ...source };
  channel.postMessage({
    v: 1,
    type: 'deliver',
    request,
    manager: offer.manager,
    nonce: offer.nonce,
    invitation,
  } satisfies ChannelMessage);
  await delay(waitMs);
  invitation = undefined;
  channel.close();
  return accepted ? 'accepted' : 'none';
}

/** Controller-side listener. Pending nonces are short lived and never persisted. */
export class SharedHandoffHost {
  private readonly channel: ChannelLike;
  private readonly manager = token(16);
  private readonly pending = new Map<
    string,
    { nonce: string; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private readonly receive: (invitation: SharedInvitation) => Promise<void> | void,
    factory: ChannelFactory = defaultFactory,
    private readonly waitMs = SHARED_HANDOFF_WAIT_MS,
  ) {
    this.channel = factory(SHARED_HANDOFF_CHANNEL);
    this.channel.onmessage = (event) => {
      void this.handle(event.data).catch(() => {});
    };
  }
  private async handle(value: unknown): Promise<void> {
    const message = parse(value);
    if (!message) return;
    if (message.type === 'probe') {
      const old = this.pending.get(message.request);
      if (old) clearTimeout(old.timer);
      const nonce = token(16);
      const timer = setTimeout(() => this.pending.delete(message.request), this.waitMs * 3);
      this.pending.set(message.request, { nonce, timer });
      this.channel.postMessage({
        v: 1,
        type: 'offer',
        request: message.request,
        manager: this.manager,
        nonce,
      } satisfies ChannelMessage);
      return;
    }
    if (message.type !== 'deliver' || message.manager !== this.manager) return;
    const pending = this.pending.get(message.request);
    if (!pending || pending.nonce !== message.nonce) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.request);
    await this.receive({ ...message.invitation });
    this.channel.postMessage({
      v: 1,
      type: 'accepted',
      request: message.request,
      manager: this.manager,
      nonce: message.nonce,
    } satisfies ChannelMessage);
  }
  close(): void {
    for (const value of this.pending.values()) clearTimeout(value.timer);
    this.pending.clear();
    this.channel.close();
  }
}
