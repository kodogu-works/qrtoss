import QRCode from 'qrcode';
import {
  SC,
  createUnicastChannel,
  deriveNetworkCode,
  encodeMemberLabel,
  generateEcdhIdentity,
  importEcdhPublic,
  importSigningPublic,
  type EcdhIdentity,
  type PairingAppMessage,
  type UcastAppMessage,
  type UnicastChannel,
} from '../../packages/protocol/src/shared.ts';
import { C } from '../../packages/protocol/src/constants.ts';
import {
  decodeDisplayText,
  type SharedControlMessage,
  type SharedMemberEntry,
} from '../../packages/protocol/src/shared-control.ts';
import { decodeText, encodeBase64 } from '../../packages/protocol/src/index.ts';
import { classify } from './content.ts';
import { translate, type Key, type Language } from './i18n.ts';
import { loadLanguage } from './view.ts';
import type { AppPaths } from './paths.ts';
import { SharedContentSession } from './shared-content.ts';
import { SharedContentView } from './shared-content-view.ts';
import { SharedMesh } from './shared-mesh.ts';
import { SharedNetworkClient } from './shared-network.ts';
import { SharedPairingSession } from './shared-pairing.ts';
import {
  mountSharedPage,
  renderSharedLanguage,
  renderSharedMembers,
  setSharedStatus,
  sharedElement,
  type SharedMemberView,
} from './shared-view.ts';

type Invite = Extract<PairingAppMessage, { type: 'p.invite' }>;
type ForwardedUcast = Extract<SharedControlMessage, { type: 'ucast'; network: string }>;

function makeLabel(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return `PC-${[...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

export function startSharedReceiver(paths: AppPaths): void {
  let language = loadLanguage();
  let errorCode = '';
  let generation = 0;
  let pairing: SharedPairingSession | undefined;
  let network: SharedNetworkClient | undefined;
  let mesh: SharedMesh | undefined;
  let content: SharedContentSession | undefined;
  let identity: EcdhIdentity | undefined;
  let invite: Invite | undefined;
  let controllerChannel: UnicastChannel | undefined;
  let controllerId = '';
  let mode: 'auto_open' | 'display_only' = 'auto_open';
  let qrTarget = false;
  let qrPreview = '';
  let qrMessageId = '';
  let qrReceipt:
    | {
        id: string;
        hash: string;
        status: 'received' | 'rejected';
        reason?: 'unsupported_content';
        confirmed: boolean;
        automatic: boolean;
        deadline: number;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const qrReceipts = new Map<
    string,
    {
      hash: string;
      status: 'received' | 'rejected';
      reason?: 'unsupported_content';
    }
  >();
  let members: SharedMemberEntry[] = [];
  let expiry = 0;
  let expiryTimer: ReturnType<typeof setInterval> | undefined;
  let controllerSendQueue = Promise.resolve();
  const label = makeLabel();

  mountSharedPage('member', paths);
  const contentView = new SharedContentView(
    () => language,
    (code) => showError(code),
  );
  const text = (key: Key) => translate(language, key);

  function showError(code: string): void {
    errorCode = code;
    render();
  }
  function memberViews(): SharedMemberView[] {
    return members.map((entry) => ({
      memberId: entry.memberId,
      label: decodeDisplayText(entry.labelB64, SC.MAX_LABEL_UTF8_BYTES),
      state: text('sharedJoined'),
      self: entry.memberId === network?.ownMemberId,
    }));
  }
  function render(): void {
    renderSharedLanguage(language, errorCode);
    sharedElement('shared-confirm-members').textContent = translate(
      language,
      'sharedConfirmMembers',
      { count: invite?.members.length ?? 0 },
    );
    sharedElement('shared-target').textContent = qrTarget ? label : text('sharedNoTarget');
    renderSharedMembers(language, memberViews(), false);
    contentView.renderReceived(content?.store.items ?? []);
    const result = sharedElement('shared-qr-result');
    result.hidden = !qrPreview;
    sharedElement('shared-qr-result-text').textContent = qrPreview;
    const web = classify(qrPreview);
    const open = sharedElement<HTMLButtonElement>('shared-open-qr');
    open.hidden = !qrPreview || !['web', 'external'].includes(web.kind) || !web.href;
    open.textContent = text(web.kind === 'external' ? 'openExternal' : 'open');
    sharedElement<HTMLButtonElement>('shared-open-qr').disabled =
      !!qrReceipt && !qrReceipt.confirmed;
    sharedElement('shared-qr-unsaved-warning').hidden = !content?.hasUnsaved;
    document.querySelectorAll<HTMLInputElement>('input[name="shared-mode"]').forEach((input) => {
      input.disabled = !!qrReceipt && !qrReceipt.confirmed;
    });
  }
  function destroyState(): void {
    pairing?.close(false);
    network?.close(false);
    mesh?.destroy();
    content?.destroy();
    pairing = undefined;
    network = undefined;
    mesh = undefined;
    content = undefined;
    identity = undefined;
    invite = undefined;
    controllerChannel = undefined;
    controllerId = '';
    members = [];
    qrTarget = false;
    qrPreview = qrMessageId = '';
    clearTimeout(qrReceipt?.timer);
    qrReceipt = undefined;
    qrReceipts.clear();
    contentView.attach(undefined);
  }

  async function beginPairing(preserveError = false): Promise<void> {
    const mine = ++generation;
    destroyState();
    if (!preserveError) errorCode = '';
    sharedElement('shared-network').hidden = true;
    sharedElement('shared-confirm').hidden = true;
    sharedElement('shared-qr-wrap').hidden = false;
    sharedElement('shared-qr-loading').hidden = false;
    render();
    identity = await generateEcdhIdentity();
    if (mine !== generation) return;
    const value = new SharedPairingSession(
      'receiver',
      {
        phase(phase) {
          if (mine !== generation) return;
          const key: Key =
            phase === 'connected'
              ? 'sharedConnecting'
              : phase === 'waiting'
                ? 'waiting'
                : phase === 'pairing'
                  ? 'pairing'
                  : phase;
          setSharedStatus(language, key);
          if (phase === 'connected')
            void value.send({
              type: 'p.hello',
              idPub: identity!.publicRaw,
              labelB64: encodeMemberLabel(label),
              client: `qrtoss-web/${__APP_VERSION__}`,
            });
        },
        invitation(url, deadline) {
          if (mine !== generation) return;
          expiry = deadline;
          void drawQR(url, mine);
        },
        message(message) {
          if (mine === generation && message.type === 'p.invite')
            return receiveInvite(message, mine);
        },
        error(code) {
          if (mine === generation) showError(code);
        },
      },
      paths,
    );
    pairing = value;
    await value.startReceiver();
  }
  async function drawQR(url: string, mine: number): Promise<void> {
    const canvas = document.createElement('canvas');
    try {
      await QRCode.toCanvas(canvas, [{ data: new TextEncoder().encode(url), mode: 'byte' }], {
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 256 * Math.max(1, devicePixelRatio),
        color: { dark: '#000000', light: '#ffffff' },
      });
      if (mine !== generation) return;
      const target = sharedElement<HTMLCanvasElement>('shared-qr');
      target.width = canvas.width;
      target.height = canvas.height;
      target.getContext('2d')!.drawImage(canvas, 0, 0);
      sharedElement('shared-qr-loading').hidden = true;
    } catch {
      showError('SERVER_ERROR');
    }
  }
  async function receiveInvite(value: Invite, mine: number): Promise<void> {
    if (invite) throw new Error('PROTOCOL_ERROR');
    invite = value;
    controllerId = value.controllerId;
    const code = await deriveNetworkCode(value.network, value.controllerPub);
    if (mine !== generation) return;
    sharedElement('shared-confirm-code').textContent = code;
    sharedElement('shared-code').textContent = code;
    consumeQR();
    if (value.epoch === 0 && value.members.length === 0) await acceptInvite(mine);
    else {
      sharedElement('shared-confirm').hidden = false;
      setSharedStatus(language, 'sharedWaitingApproval');
    }
  }
  async function acceptInvite(mine: number): Promise<void> {
    const value = invite;
    if (!value || !identity || mine !== generation) return;
    sharedElement('shared-confirm').hidden = true;
    await pairing?.send({ type: 'p.accept', memberId: value.memberId });
    const signingPublic = await importSigningPublic(value.controllerPub);
    const controllerPublic = await importEcdhPublic(value.controllerIdPub);
    controllerChannel = await createUnicastChannel(
      value.network,
      value.memberId,
      identity.privateKey,
      value.controllerId,
      controllerPublic,
    );
    const client = new SharedNetworkClient(
      { role: 'member', network: value.network, cap: value.memberCap },
      {
        async authenticated(message) {
          if (
            mine !== generation ||
            message.role !== 'member' ||
            message.memberId !== value.memberId ||
            message.epoch !== value.epoch + 1 ||
            !message.controllerPresent ||
            !message.admissionsOpen
          )
            throw new Error('AUTH_FAILED');
          const authIds = new Set(message.members.map((entry) => entry.memberId));
          const expected = new Set([...value.members, value.memberId]);
          if (
            expected.size !== value.members.length + 1 ||
            authIds.size !== expected.size ||
            [...expected].some((memberId) => !authIds.has(memberId))
          )
            throw new Error('EPOCH_MISMATCH');
          const state = new SharedMesh(
            value.network,
            value.memberId,
            identity!,
            signingPublic,
            client,
            {
              members(entries, _nextEpoch) {
                members = [...entries];
                render();
              },
              unicast(from, app) {
                return content?.onUnicast(from, app);
              },
              broadcast(from, app) {
                return content?.onBroadcast(from, app);
              },
            },
          );
          mesh = state;
          await state.authenticate(message.members, message.epoch);
          content = new SharedContentSession(state, {
            received(items) {
              contentView.renderReceived(items);
              render();
            },
            delivery(tracker) {
              contentView.renderDelivery(tracker);
            },
          });
          contentView.attach(content);
          pairing?.close(false);
          pairing = undefined;
          sharedElement('shared-qr-wrap').hidden = true;
          sharedElement('shared-network').hidden = false;
          setSharedStatus(language, 'sharedJoined');
          await sendController({ type: 'mode', value: mode });
          render();
        },
        message(message) {
          return handleNetwork(message, mine);
        },
        closed(code) {
          if (mine !== generation) return;
          errorCode = code;
          void beginPairing(true);
        },
      },
      paths,
    );
    network = client;
    client.connect();
  }
  async function handleNetwork(message: SharedControlMessage, mine: number): Promise<void> {
    if (mine !== generation || !mesh) return;
    if (message.type === 'member.added') await mesh.memberAdded(message);
    else if (message.type === 'member.removed') {
      content?.memberGone(message.memberId);
      if (message.memberId === network?.ownMemberId) return void beginPairing();
      await mesh.memberRemoved(message);
    } else if (message.type === 'ucast' && 'network' in message) {
      if (message.from === controllerId) await receiveController(message);
      else await mesh.receiveUnicast(message);
    } else if (message.type === 'bcast' && 'network' in message)
      await mesh.receiveBroadcast(message);
    else if (message.type === 'controller.gone') showError('CONTROLLER_GONE');
    else if (message.type === 'error') showError(message.code);
  }
  async function sendController(message: UcastAppMessage): Promise<void> {
    const task = controllerSendQueue.then(async () => {
      if (!controllerChannel || !network) throw new Error('PROTOCOL_ERROR');
      const encrypted = await controllerChannel.encrypt(message);
      network.ucast('member', controllerId, encrypted.seq, encrypted.ct);
    });
    controllerSendQueue = task.catch(() => {});
    return task;
  }
  async function receiveController(message: ForwardedUcast): Promise<void> {
    if (!controllerChannel) throw new Error('PROTOCOL_ERROR');
    const app = await controllerChannel.decrypt(message.seq, message.ct);
    if (app.type === 'target') {
      qrTarget = app.active;
      render();
    } else if (app.type === 'status') {
      if (!qrReceipt || qrReceipt.confirmed)
        setSharedStatus(
          language,
          app.state === 'scanning'
            ? 'peer_scanning'
            : app.state === 'scanned'
              ? 'peer_scanned'
              : 'connected',
        );
    } else if (app.type === 'activity') {
      // The controller sends this only for an actual user action. Its own coalesced
      // net.touch is authoritative; there is no automatic response here.
      return;
    } else if (app.type === 'data') {
      const next = decodeText(app.textB64);
      const digest = encodeBase64(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(next))),
      );
      const known = qrReceipts.get(app.id);
      if (known) {
        if (known.hash !== digest) throw new Error('PROTOCOL_ERROR');
        await sendController(
          known.status === 'received'
            ? { type: 'ack', id: app.id, status: 'received' }
            : {
                type: 'ack',
                id: app.id,
                status: 'rejected',
                reason: known.reason!,
              },
        );
        return;
      }
      if (qrReceipt && !qrReceipt.confirmed) throw new Error('PROTOCOL_ERROR');
      if (qrReceipts.size >= SC.MAX_QR_DEDUPLICATION_IDS)
        qrReceipts.delete(qrReceipts.keys().next().value!);
      if (!qrTarget) {
        const rejected = {
          hash: digest,
          status: 'rejected' as const,
          reason: 'unsupported_content' as const,
        };
        qrReceipts.set(app.id, rejected);
        await sendController({
          type: 'ack',
          id: app.id,
          status: 'rejected',
          reason: rejected.reason,
        });
        return;
      }
      qrReceipts.set(app.id, { hash: digest, status: 'received' });
      qrPreview = next;
      qrMessageId = app.id;
      const receipt: NonNullable<typeof qrReceipt> = {
        id: app.id,
        hash: digest,
        status: 'received',
        confirmed: false,
        automatic: canOpenAutomatically(),
        deadline: Number.POSITIVE_INFINITY,
      };
      qrReceipt = receipt;
      await sendController({ type: 'ack', id: app.id, status: 'received' });
      receipt.deadline = performance.now() + C.ACK_SEEN_TIMEOUT_SECONDS * 1000;
      receipt.timer = setTimeout(() => {
        if (qrReceipt !== receipt || receipt.confirmed) return;
        receipt.confirmed = true;
        receipt.automatic = false;
        showError('FINAL_ACK_TIMEOUT');
      }, C.ACK_SEEN_TIMEOUT_SECONDS * 1000);
      render();
    } else if (app.type === 'ack_seen') {
      if (!qrReceipts.has(app.id)) throw new Error('PROTOCOL_ERROR');
      if (app.id !== qrMessageId) return;
      if (!qrReceipt || qrReceipt.id !== app.id) throw new Error('PROTOCOL_ERROR');
      clearTimeout(qrReceipt.timer);
      qrReceipt.confirmed = true;
      const inTime = performance.now() < qrReceipt.deadline;
      if (!inTime) {
        qrReceipt.automatic = false;
        showError('FINAL_ACK_TIMEOUT');
      } else if (qrReceipt.automatic && canOpenAutomatically()) openQR();
      else render();
    } else throw new Error('PROTOCOL_ERROR');
  }
  function canOpenAutomatically(): boolean {
    const value = classify(qrPreview);
    return (
      mode === 'auto_open' &&
      value.kind === 'web' &&
      !!value.href &&
      document.visibilityState === 'visible' &&
      !content?.hasUnsaved
    );
  }
  function openQR(): void {
    if (qrReceipt && !qrReceipt.confirmed) return;
    const value = classify(qrPreview);
    if (!['web', 'external'].includes(value.kind) || !value.href) return;
    try {
      network?.leave();
    } catch {
      /* best effort */
    }
    location.assign(value.href);
  }
  function consumeQR(): void {
    const canvas = sharedElement<HTMLCanvasElement>('shared-qr');
    const context = canvas.getContext('2d');
    if (!context || !canvas.width) return;
    const snapshot = document.createElement('canvas');
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    snapshot.getContext('2d')!.drawImage(canvas, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const radius = (5 * canvas.width) / 256;
    if ('filter' in CanvasRenderingContext2D.prototype) {
      context.filter = `blur(${radius}px)`;
      context.drawImage(snapshot, 0, 0);
    } else {
      const small = shrink(snapshot, Math.ceil(canvas.width / (2 * radius)));
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(small, 0, 0, canvas.width, canvas.height);
      small.width = 0;
      small.height = 0;
    }
    context.restore();
    snapshot.width = snapshot.height = 0;
  }

  sharedElement('shared-accept').addEventListener('click', () => void acceptInvite(generation));
  sharedElement('shared-new-qr').addEventListener('click', () => void beginPairing());
  sharedElement('shared-reject').addEventListener('click', () => {
    const current = pairing;
    const memberId = invite?.memberId;
    void (async () => {
      try {
        if (current && memberId) await current.send({ type: 'p.reject', memberId });
      } catch {
        // A failed rejection cannot be retried with the same short-lived pairing.
      } finally {
        if (current === pairing) await beginPairing();
      }
    })();
  });
  document.querySelectorAll<HTMLInputElement>('input[name="shared-mode"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      mode = input.value as typeof mode;
      network?.activity();
      if (controllerChannel) void sendController({ type: 'mode', value: mode });
    });
  });
  sharedElement('shared-open-qr').addEventListener('click', () => {
    network?.activity();
    openQR();
  });
  sharedElement('shared-copy-qr').addEventListener('click', () => {
    network?.activity();
    void navigator.clipboard.writeText(qrPreview).catch(() => showError('CONTENT_UNSUPPORTED'));
  });
  sharedElement('shared-clear-qr').addEventListener('click', () => {
    network?.activity();
    qrPreview = qrMessageId = '';
    render();
  });
  sharedElement('shared-leave').addEventListener('click', () => {
    try {
      network?.leave();
    } finally {
      void beginPairing();
    }
  });
  sharedElement<HTMLSelectElement>('shared-language').addEventListener('change', (event) => {
    language = (event.target as HTMLSelectElement).value as Language;
    try {
      localStorage.setItem('qrtoss.language', language);
    } catch {
      /* preference only */
    }
    network?.activity();
    render();
  });
  addEventListener('pagehide', () => {
    generation++;
    clearInterval(expiryTimer);
    destroyState();
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) {
      errorCode = 'NETWORK_DISCONNECTED';
      void beginPairing(true);
    }
  });
  expiryTimer = setInterval(() => {
    if (!expiry || sharedElement('shared-qr-wrap').hidden) return;
    sharedElement('shared-expiry').textContent = translate(language, 'qrRemaining', {
      seconds: Math.max(0, Math.ceil((expiry - performance.now()) / 1000)),
    });
  }, 500);
  sharedElement('shared-version').textContent = `${__APP_VERSION__} (${__SOURCE_COMMIT__})`;
  render();
  if (!isSecureContext || !crypto.subtle) showError('CRYPTO_UNAVAILABLE');
  else void beginPairing();
}

/** Halve repeatedly so every source pixel contributes before scaling the QR back up. */
function shrink(source: HTMLCanvasElement, size: number): HTMLCanvasElement {
  let current = source;
  while (current.width > size || current.height > size) {
    const next = document.createElement('canvas');
    next.width = Math.max(Math.min(size, current.width), Math.ceil(current.width / 2));
    next.height = Math.max(Math.min(size, current.height), Math.ceil(current.height / 2));
    const context = next.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(current, 0, 0, next.width, next.height);
    if (current !== source) {
      current.width = 0;
      current.height = 0;
    }
    current = next;
  }
  return current;
}
