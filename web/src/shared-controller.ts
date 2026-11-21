import {
  SC,
  createUnicastChannel,
  deriveNetworkCode,
  encodeMemberLabel,
  generateEcdhIdentity,
  generateSigningIdentity,
  importEcdhPublic,
  signMemberAddition,
  verifyMemberAddition,
  type EcdhIdentity,
  type PairingAppMessage,
  type SigningIdentity,
  type UcastAppMessage,
  type UnicastChannel,
} from '../../packages/protocol/src/shared.ts';
import {
  decodeDisplayText,
  type SharedControlMessage,
  type SharedMemberEntry,
} from '../../packages/protocol/src/shared-control.ts';
import { C, encodeText, randomToken, type AppMessage } from '../../packages/protocol/src/index.ts';
import { Scanner } from './scanner.ts';
import { translate, type Key, type Language } from './i18n.ts';
import { loadLanguage } from './view.ts';
import type { AppPaths } from './paths.ts';
import { SharedContentSession } from './shared-content.ts';
import { SharedContentView } from './shared-content-view.ts';
import { SharedHandoffHost, handoffToController } from './shared-handoff.ts';
import {
  classifyConnectionLink,
  parseSharedFragment,
  type SharedInvitation,
} from './shared-link.ts';
import { SharedMesh } from './shared-mesh.ts';
import { createSharedNetwork, SharedNetworkClient } from './shared-network.ts';
import { SharedPairingSession } from './shared-pairing.ts';
import { Session, type Mode } from './session.ts';
import {
  mountSharedPage,
  renderSharedLanguage,
  renderSharedMembers,
  setSharedStatus,
  sharedElement,
  type SharedMemberView,
} from './shared-view.ts';

type Hello = Extract<PairingAppMessage, { type: 'p.hello' }>;
type Candidate = {
  pairing: SharedPairingSession;
  hello?: Hello;
  entry?: SharedMemberEntry;
  inviteEpoch?: number;
  accepted?: boolean;
};
type PendingControllerJoin = { entry: SharedMemberEntry; identity: EcdhIdentity };
type ForwardedUcast = Extract<SharedControlMessage, { type: 'ucast'; network: string }>;
const LEGACY_TARGET = 'legacy-v1';
type PendingQR = {
  id: string;
  target: string;
  text: string;
  settled: boolean;
  timedOut: boolean;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
};
type LegacyTarget = {
  session: Session;
  connected: boolean;
  closing: boolean;
  mode?: Mode;
};

function phoneLabel(): string {
  const value = crypto.getRandomValues(new Uint8Array(2));
  return `Phone-${[...value]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

export function startSharedController(paths: AppPaths, fragment: string): void {
  let language = loadLanguage();
  let errorCode = '';
  let generation = 0;
  const controllerId = randomToken(16);
  let signing: SigningIdentity | undefined;
  let qrIdentity: EcdhIdentity | undefined;
  let networkId = '';
  let network: SharedNetworkClient | undefined;
  let networkReady: Promise<void> | undefined;
  let resolveNetwork: (() => void) | undefined;
  let rejectNetwork: ((error: Error) => void) | undefined;
  let epoch = 0;
  let admissionsOpen = true;
  let controllerMemberId: string | undefined;
  let memberIdentity: EcdhIdentity | undefined;
  let pendingControllerJoin: PendingControllerJoin | undefined;
  let mesh: SharedMesh | undefined;
  let content: SharedContentSession | undefined;
  let targetId: string | undefined;
  let legacyTarget: LegacyTarget | undefined;
  let pendingAdmissions: boolean | undefined;
  let preview = '';
  let pendingQR: PendingQR | undefined;
  let activePairing: Candidate | undefined;
  let handoffHost: SharedHandoffHost | undefined;
  const members = new Map<string, SharedMemberEntry>();
  const seenMemberIds = new Set<string>();
  const authorizedPending = new Map<string, { entry: SharedMemberEntry; inviteEpoch: number }>();
  // Only IDs acknowledged by member.invited belong in the relay's net.state.pending list.
  // authorizedPending also contains a locally signed request while it is in flight.
  const serverPending = new Set<string>();
  const qrChannels = new Map<string, UnicastChannel>();
  const qrModes = new Map<string, 'auto_open' | 'display_only'>();
  const settledQRIds = new Set<string>();
  const label = phoneLabel();
  let cameraStarting = false;
  let scanGeneration = 0;
  let qrSendQueue = Promise.resolve();
  let qrFinalized = false;
  const discardedLegacySessions = new Set<Session>();

  mountSharedPage('controller', paths);
  const contentView = new SharedContentView(
    () => language,
    (code) => showError(code),
  );
  const scanner = new Scanner(sharedElement<HTMLVideoElement>('shared-video'), scanned);
  const text = (key: Key) => translate(language, key);

  function showError(code: string): void {
    errorCode = code;
    render();
  }
  function views(): SharedMemberView[] {
    return [...members.values()].map((entry) => ({
      memberId: entry.memberId,
      label: decodeDisplayText(entry.labelB64, SC.MAX_LABEL_UTF8_BYTES),
      state: text('sharedJoined'),
      target: entry.memberId === targetId,
      self: entry.memberId === controllerMemberId,
    }));
  }
  function render(): void {
    renderSharedLanguage(language, errorCode);
    sharedElement('shared-network').hidden = !network;
    sharedElement('shared-code').textContent = networkId
      ? sharedElement('shared-code').textContent
      : '';
    const target = targetId ? members.get(targetId) : undefined;
    sharedElement('shared-target').textContent = legacyTarget
      ? text('sharedLegacyTarget')
      : target
        ? decodeDisplayText(target.labelB64, SC.MAX_LABEL_UTF8_BYTES)
        : text('sharedNoTarget');
    sharedElement('shared-network-state').textContent = controllerMemberId
      ? text('sharedParticipating')
      : text('sharedManagementOnly');
    sharedElement('shared-toggle-participation').textContent = text(
      controllerMemberId ? 'sharedPartSelf' : 'sharedJoinSelf',
    );
    sharedElement<HTMLButtonElement>('shared-toggle-participation').disabled =
      !!pendingControllerJoin;
    sharedElement('shared-toggle-admissions').textContent = text(
      admissionsOpen ? 'sharedStopAdmissions' : 'sharedResumeAdmissions',
    );
    sharedElement<HTMLButtonElement>('shared-toggle-admissions').disabled =
      pendingAdmissions !== undefined;
    renderSharedMembers(language, views(), true, kick, setTarget);
    const showPreview = !!preview;
    sharedElement('shared-qr-preview').hidden = !showPreview;
    sharedElement('shared-qr-text').textContent = preview;
    sharedElement('shared-send-qr').hidden = !showPreview;
    sharedElement('shared-send-qr').textContent = text(pendingQR?.timedOut ? 'retry' : 'sendShort');
    sharedElement<HTMLButtonElement>('shared-send-qr').disabled =
      (!targetId && !legacyTarget?.connected) ||
      qrFinalized ||
      (!!pendingQR && !pendingQR.timedOut);
  }

  function cleanupControllerState(closeNetwork: boolean): void {
    scanGeneration++;
    scanner.stop();
    cameraStarting = false;
    sharedElement('shared-camera').hidden = true;
    handoffHost?.close();
    handoffHost = undefined;
    activePairing?.pairing.close(false);
    activePairing = undefined;
    clearLegacyTarget(true);
    for (const session of discardedLegacySessions) session.close();
    discardedLegacySessions.clear();
    clearTimeout(pendingQR?.timer);
    pendingQR = undefined;
    pendingAdmissions = undefined;
    preview = '';
    qrFinalized = true;
    stopControllerMesh();
    qrChannels.clear();
    qrModes.clear();
    settledQRIds.clear();
    authorizedPending.clear();
    serverPending.clear();
    members.clear();
    seenMemberIds.clear();
    pendingControllerJoin = undefined;
    targetId = undefined;
    controllerMemberId = undefined;
    memberIdentity = undefined;
    signing = undefined;
    qrIdentity = undefined;
    const currentNetwork = network;
    network = undefined;
    if (closeNetwork) currentNetwork?.close(false);
    render();
  }

  async function initialize(): Promise<void> {
    const mine = ++generation;
    const nextSigning = await generateSigningIdentity();
    const nextQrIdentity = await generateEcdhIdentity();
    if (mine !== generation) return;
    signing = nextSigning;
    qrIdentity = nextQrIdentity;
    let invitation: SharedInvitation;
    try {
      invitation = parseSharedFragment(fragment);
    } catch {
      showError('PAIR_LINK_INVALID');
      return;
    } finally {
      fragment = '';
    }
    const handoff = await handoffToController(invitation);
    if (mine !== generation) return;
    if (handoff === 'accepted') {
      setSharedStatus(language, 'sharedHandoffAccepted');
      return;
    }
    if (handoff === 'multiple') {
      setSharedStatus(language, 'sharedHandoffMultiple');
      return;
    }
    handoffHost = new SharedHandoffHost((next) => addDevice(next));
    await addDevice(invitation);
  }

  async function addDevice(invitation: SharedInvitation): Promise<void> {
    if (activePairing) throw new Error('PEER_BUSY');
    const mine = generation;
    const pairing = new SharedPairingSession(
      'sender',
      {
        phase(phase) {
          if (mine !== generation) return;
          setSharedStatus(
            language,
            phase === 'connected' ? 'sharedConnecting' : phase === 'pairing' ? 'pairing' : phase,
          );
        },
        async message(message) {
          if (mine !== generation) return;
          if (message.type === 'p.hello') await inviteMember(pairing, message);
          else if (message.type === 'p.accept') {
            const candidate = activePairing;
            if (
              !candidate?.entry ||
              candidate.pairing !== pairing ||
              candidate.entry.memberId !== message.memberId ||
              candidate.accepted
            )
              throw new Error('PROTOCOL_ERROR');
            candidate.accepted = true;
          } else if (message.type === 'p.reject') {
            const candidate = activePairing;
            if (
              !candidate?.entry ||
              candidate.pairing !== pairing ||
              candidate.entry.memberId !== message.memberId
            )
              throw new Error('PROTOCOL_ERROR');
            network?.revoke(candidate.entry.memberId);
            finishPairing();
          }
        },
        error(code) {
          if (mine === generation) {
            const candidate = activePairing;
            if (candidate?.pairing === pairing && candidate.entry)
              network?.revoke(candidate.entry.memberId);
            finishPairing();
            showError(code);
          }
        },
      },
      paths,
    );
    activePairing = { pairing };
    pairing.startSender(invitation);
  }

  async function ensureNetwork(): Promise<void> {
    if (networkReady) return networkReady;
    networkReady = new Promise((resolve, reject) => {
      resolveNetwork = resolve;
      rejectNetwork = reject;
    });
    // A concurrent ensureNetwork() call may already be awaiting this promise before
    // creation/authentication fails. Keep a handler attached until the caller adopts it.
    void networkReady.catch(() => {});
    try {
      const created = await createSharedNetwork(paths.networks, controllerId);
      networkId = created.network;
      const client = new SharedNetworkClient(
        { role: 'controller', network: networkId, cap: created.controllerCap },
        {
          async authenticated(message) {
            if (
              message.role !== 'controller' ||
              message.controllerId !== controllerId ||
              message.epoch !== 0 ||
              message.members.length !== 0 ||
              !message.controllerPresent ||
              !message.admissionsOpen
            )
              throw new Error('AUTH_FAILED');
            epoch = message.epoch;
            admissionsOpen = message.admissionsOpen;
            for (const entry of message.members) members.set(entry.memberId, entry);
            sharedElement('shared-code').textContent = await deriveNetworkCode(
              networkId,
              signing!.publicRaw,
            );
            sharedElement('shared-network').hidden = false;
            resolveNetwork?.();
            resolveNetwork = undefined;
            rejectNetwork = undefined;
            render();
            if (document.visibilityState === 'visible') void startScan();
          },
          message(message) {
            return handleNetwork(message);
          },
          closed(code) {
            rejectNetwork?.(new Error(code));
            resolveNetwork = undefined;
            rejectNetwork = undefined;
            networkReady = undefined;
            cleanupControllerState(false);
            showError(code);
            setSharedStatus(language, 'disconnected');
          },
        },
        paths,
      );
      network = client;
      client.connect();
      return networkReady;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('SERVER_ERROR');
      rejectNetwork?.(failure);
      resolveNetwork = undefined;
      rejectNetwork = undefined;
      networkReady = undefined;
      cleanupControllerState(true);
      showError(/^[A-Z_]+$/.test(failure.message) ? failure.message : 'SERVER_ERROR');
      throw failure;
    }
  }

  async function inviteMember(pairing: SharedPairingSession, hello: Hello): Promise<void> {
    const candidate = activePairing;
    if (!candidate || candidate.pairing !== pairing || candidate.hello)
      throw new Error('PROTOCOL_ERROR');
    candidate.hello = hello;
    // Base64 length is not enough to establish that this is a valid P-256 point.
    await importEcdhPublic(hello.idPub);
    await ensureNetwork();
    const memberId = randomToken(16);
    const addition = {
      network: networkId,
      memberId,
      idPub: hello.idPub,
      labelB64: hello.labelB64,
    };
    const entry: SharedMemberEntry = {
      memberId,
      idPub: hello.idPub,
      labelB64: hello.labelB64,
      sig: await signMemberAddition(signing!.privateKey, addition),
    };
    candidate.entry = entry;
    authorizedPending.set(memberId, { entry, inviteEpoch: epoch });
    try {
      network!.invite(entry);
    } catch (error) {
      authorizedPending.delete(memberId);
      throw error;
    }
  }
  async function sendPairInvite(memberCap: string): Promise<void> {
    const candidate = activePairing;
    if (!candidate?.entry) throw new Error('PROTOCOL_ERROR');
    candidate.inviteEpoch = epoch;
    await candidate.pairing.send({
      type: 'p.invite',
      network: networkId,
      memberId: candidate.entry.memberId,
      memberCap,
      controllerPub: signing!.publicRaw,
      controllerId,
      controllerIdPub: qrIdentity!.publicRaw,
      epoch,
      members: [...members.keys()],
    });
    setSharedStatus(language, 'sharedWaitingApproval');
  }
  function finishPairing(): void {
    activePairing?.pairing.close(false);
    activePairing = undefined;
    setSharedStatus(language, network ? 'connected' : 'disconnected');
    if (network && !preview && document.visibilityState === 'visible') void startScan();
  }

  function sameEntry(left: SharedMemberEntry, right: SharedMemberEntry): boolean {
    return (
      left.memberId === right.memberId &&
      left.idPub === right.idPub &&
      left.labelB64 === right.labelB64 &&
      left.sig === right.sig
    );
  }

  function sameIds(actual: readonly string[], expected: Iterable<string>): boolean {
    const values = new Set(expected);
    return actual.length === values.size && actual.every((id) => values.has(id));
  }

  function abortActivePairing(code = 'EPOCH_MISMATCH'): void {
    const candidate = activePairing;
    if (!candidate) return;
    if (candidate.entry && authorizedPending.has(candidate.entry.memberId))
      network?.revoke(candidate.entry.memberId);
    finishPairing();
    showError(code);
  }

  async function handleNetwork(message: SharedControlMessage): Promise<void> {
    if (message.type === 'member.invited') {
      const pending = authorizedPending.get(message.memberId);
      if (!pending || serverPending.has(message.memberId)) throw new Error('PROTOCOL_ERROR');
      serverPending.add(message.memberId);
      // Membership may have changed while member.invite was crossing the socket. The
      // capability has not left this controller yet, so revoke it instead of disclosing it
      // with a stale p.invite snapshot.
      if (activePairing?.entry?.memberId !== message.memberId || pending.inviteEpoch !== epoch) {
        network?.revoke(message.memberId);
        return;
      }
      await sendPairInvite(message.memberCap);
      return;
    }
    if (message.type === 'member.added') {
      if (message.epoch !== epoch + 1) throw new Error('EPOCH_MISMATCH');
      const { v: _v, type: _type, epoch: _epoch, ...entry } = message;
      const external = authorizedPending.get(entry.memberId);
      const own = pendingControllerJoin?.entry.memberId === entry.memberId;
      const expected = own ? pendingControllerJoin!.entry : external?.entry;
      if (
        !expected ||
        !sameEntry(entry, expected) ||
        seenMemberIds.has(entry.memberId) ||
        members.has(entry.memberId) ||
        !(await verifyMemberAddition(
          signing!.publicKey,
          {
            network: networkId,
            memberId: entry.memberId,
            idPub: entry.idPub,
            labelB64: entry.labelB64,
          },
          entry.sig,
        ))
      )
        throw new Error('AUTH_FAILED');
      const priorEpoch = epoch;
      const staleInvite = !!external && external.inviteEpoch !== priorEpoch;
      // A conforming relay cannot admit a capability from another membership
      // epoch. Check before adding the peer to the mesh so even a faulty relay
      // cannot make us disclose the new sender key to that peer.
      if (staleInvite) throw new Error('EPOCH_MISMATCH');
      const publicKey = own ? undefined : await importEcdhPublic(entry.idPub);
      if (mesh && !own) await mesh.memberAdded(message);

      epoch = message.epoch;
      seenMemberIds.add(entry.memberId);
      members.set(entry.memberId, entry);
      if (external) {
        authorizedPending.delete(entry.memberId);
        serverPending.delete(entry.memberId);
      }
      if (own) {
        memberIdentity = pendingControllerJoin!.identity;
        controllerMemberId = entry.memberId;
        pendingControllerJoin = undefined;
      } else {
        qrChannels.set(
          entry.memberId,
          await createUnicastChannel(
            networkId,
            controllerId,
            qrIdentity!.privateKey,
            entry.memberId,
            publicKey!,
          ),
        );
      }
      if (!own && !targetId && !legacyTarget) await setTarget(entry.memberId);
      if (own) await startControllerMesh();

      const candidateJoined = activePairing?.entry?.memberId === entry.memberId;
      if (candidateJoined) finishPairing();
      else if (activePairing?.inviteEpoch !== undefined) abortActivePairing();
      render();
      return;
    }
    if (message.type === 'member.removed') {
      if (message.epoch !== epoch + 1 || !members.has(message.memberId))
        throw new Error('EPOCH_MISMATCH');
      content?.memberGone(message.memberId);
      if (mesh && message.memberId !== controllerMemberId) await mesh.memberRemoved(message);
      epoch = message.epoch;
      members.delete(message.memberId);
      qrChannels.delete(message.memberId);
      qrModes.delete(message.memberId);
      if (targetId === message.memberId) {
        targetId = undefined;
        if (pendingQR?.target === message.memberId) {
          clearTimeout(pendingQR.timer);
          pendingQR = undefined;
          qrFinalized = true;
          showError('PEER_CLOSED');
        }
      }
      if (controllerMemberId === message.memberId) stopControllerMesh();
      if (activePairing?.inviteEpoch !== undefined) abortActivePairing();
      render();
      return;
    }
    if (message.type === 'member.revoked') {
      if (!authorizedPending.delete(message.memberId)) throw new Error('PROTOCOL_ERROR');
      serverPending.delete(message.memberId);
      if (activePairing?.entry?.memberId === message.memberId) {
        finishPairing();
        showError(message.code);
      }
      return;
    }
    if (message.type === 'net.state') {
      if (
        message.epoch !== epoch ||
        !sameIds(message.members, members.keys()) ||
        !sameIds(message.pending, serverPending) ||
        message.controllerMemberId !== (controllerMemberId ?? null)
      )
        throw new Error('EPOCH_MISMATCH');
      admissionsOpen = message.admissionsOpen;
      if (pendingAdmissions === message.admissionsOpen) pendingAdmissions = undefined;
      render();
      return;
    }
    if (message.type === 'ucast' && 'network' in message) {
      if (controllerMemberId && message.to === controllerMemberId)
        await mesh?.receiveUnicast(message);
      else if (message.to === controllerId) await receiveQRControl(message);
      return;
    }
    if (message.type === 'bcast' && 'network' in message) await mesh?.receiveBroadcast(message);
    else if (message.type === 'error') {
      if (message.scope === 'invite') {
        const candidate = activePairing;
        if (candidate?.entry) {
          authorizedPending.delete(candidate.entry.memberId);
          serverPending.delete(candidate.entry.memberId);
        } else
          for (const memberId of authorizedPending.keys())
            if (!serverPending.has(memberId)) authorizedPending.delete(memberId);
        finishPairing();
      } else if (message.scope === 'member' && pendingControllerJoin) {
        pendingControllerJoin = undefined;
      } else if (message.scope === 'network') {
        pendingAdmissions = undefined;
      }
      showError(message.code);
      render();
    }
  }

  async function receiveQRControl(message: ForwardedUcast): Promise<void> {
    const channel = qrChannels.get(message.from);
    if (!channel) throw new Error('MEMBER_NOT_FOUND');
    const app = await channel.decrypt(message.seq, message.ct);
    if (app.type === 'mode') qrModes.set(message.from, app.value);
    else if (app.type === 'ack') {
      // A user-triggered retry can put another valid ACK in flight. Once one ACK has
      // settled the message, later ACKs for that ID are intentionally ignored.
      if (settledQRIds.has(app.id) || !pendingQR) return;
      if (pendingQR.target !== message.from || pendingQR.id !== app.id) return;
      if (pendingQR.settled) return;
      pendingQR.settled = true;
      clearTimeout(pendingQR.timer);
      await sendQRControl(message.from, { type: 'ack_seen', id: app.id });
      if (settledQRIds.size >= SC.MAX_QR_DEDUPLICATION_IDS)
        settledQRIds.delete(settledQRIds.values().next().value!);
      settledQRIds.add(app.id);
      pendingQR = undefined;
      qrFinalized = true;
      errorCode = app.status === 'rejected' ? 'CONTENT_UNSUPPORTED' : '';
      setSharedStatus(language, app.status === 'received' ? 'delivered' : 'scanned');
      render();
    } else throw new Error('PROTOCOL_ERROR');
  }
  async function sendQRControl(memberId: string, app: UcastAppMessage): Promise<void> {
    const task = qrSendQueue.then(async () => {
      const channel = qrChannels.get(memberId);
      if (!channel || !network) throw new Error('MEMBER_NOT_FOUND');
      const encrypted = await channel.encrypt(app);
      network.ucast('controller', memberId, encrypted.seq, encrypted.ct);
    });
    qrSendQueue = task.catch(() => {});
    return task;
  }

  function clearLegacyTarget(close: boolean): void {
    const current = legacyTarget;
    if (!current) return;
    legacyTarget = undefined;
    current.closing = true;
    if (close) current.session.close();
  }

  function discardLegacyInvitation(fragment: string): void {
    let session: Session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      discardedLegacySessions.delete(session);
      session.close();
    };
    session = new Session(
      'sender',
      {
        phase(next) {
          if (next === 'connected') finish();
        },
        message() {
          throw new Error('PROTOCOL_ERROR');
        },
        error() {
          clearTimeout(timer);
          discardedLegacySessions.delete(session);
        },
      },
      'auto_open',
      paths,
    );
    discardedLegacySessions.add(session);
    timer = setTimeout(finish, (C.AUTH_TIMEOUT_SECONDS + C.CANDIDATE_TTL_SECONDS) * 1000);
    session.startSender(fragment);
  }

  async function handleLegacyMessage(target: LegacyTarget, message: AppMessage): Promise<void> {
    if (legacyTarget !== target || target.closing) return;
    if (message.type === 'mode') {
      target.mode = message.value;
      render();
      return;
    }
    if (message.type !== 'ack') throw new Error('PROTOCOL_ERROR');
    const item = pendingQR;
    if (!item || item.target !== LEGACY_TARGET || item.id !== message.id || item.settled) return;
    item.settled = true;
    clearTimeout(item.timer);
    errorCode = message.status === 'rejected' ? 'CONTENT_UNSUPPORTED' : '';
    setSharedStatus(language, message.status === 'received' ? 'delivered' : 'scanned');
    await target.session.send({ type: 'ack_seen', id: message.id });
    if (pendingQR === item) pendingQR = undefined;
    qrFinalized = true;
    clearLegacyTarget(true);
    render();
  }

  function startLegacyTarget(fragment: string): void {
    if (targetId || legacyTarget || pendingQR) {
      discardLegacyInvitation(fragment);
      showError('FORBIDDEN');
      return;
    }
    const target = {} as LegacyTarget;
    const session = new Session(
      'sender',
      {
        phase(next) {
          if (legacyTarget !== target || target.closing) return;
          target.connected = next === 'connected';
          setSharedStatus(language, next);
          render();
          if (next === 'connected' && !preview && document.visibilityState === 'visible')
            void startScan();
        },
        message(message) {
          return handleLegacyMessage(target, message);
        },
        error(code) {
          if (legacyTarget !== target || target.closing) return;
          if (pendingQR?.target === LEGACY_TARGET) {
            clearTimeout(pendingQR.timer);
            pendingQR = undefined;
          }
          clearLegacyTarget(false);
          showError(code);
          render();
        },
      },
      'auto_open',
      paths,
    );
    target.session = session;
    target.connected = false;
    target.closing = false;
    legacyTarget = target;
    preview = '';
    qrFinalized = false;
    errorCode = '';
    session.startSender(fragment);
    render();
  }

  async function setTarget(memberId: string): Promise<void> {
    if (pendingQR || memberId === targetId || !members.has(memberId)) return;
    network?.activity();
    clearLegacyTarget(true);
    const old = targetId;
    targetId = memberId;
    if (old && qrChannels.has(old)) await sendQRControl(old, { type: 'target', active: false });
    await sendQRControl(memberId, { type: 'target', active: true });
    render();
  }
  function kick(memberId: string): void {
    network?.kick(memberId);
  }

  async function toggleParticipation(): Promise<void> {
    if (!network || pendingControllerJoin) return;
    if (controllerMemberId) {
      network.part();
      return;
    }
    const identity = await generateEcdhIdentity();
    const memberId = randomToken(16);
    const labelB64 = encodeMemberLabel(label);
    const entry: SharedMemberEntry = {
      memberId,
      idPub: identity.publicRaw,
      labelB64,
      sig: await signMemberAddition(signing!.privateKey, {
        network: networkId,
        memberId,
        idPub: identity.publicRaw,
        labelB64,
      }),
    };
    pendingControllerJoin = { entry, identity };
    try {
      network.join(entry);
      render();
    } catch (error) {
      pendingControllerJoin = undefined;
      throw error;
    }
  }
  async function startControllerMesh(): Promise<void> {
    if (!controllerMemberId || !memberIdentity || !network || mesh) return;
    const state = new SharedMesh(
      networkId,
      controllerMemberId,
      memberIdentity,
      signing!.publicKey,
      network,
      {
        members() {
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
    await state.authenticate([...members.values()], epoch);
    content = new SharedContentSession(state, {
      received(items) {
        contentView.renderReceived(items);
      },
      delivery(tracker) {
        contentView.renderDelivery(tracker);
      },
    });
    contentView.attach(content);
    render();
  }
  function stopControllerMesh(): void {
    mesh?.destroy();
    content?.destroy();
    mesh = undefined;
    content = undefined;
    memberIdentity = undefined;
    controllerMemberId = undefined;
    contentView.attach(undefined);
  }

  function scanned(value: string): void {
    cameraStarting = false;
    network?.activity();
    const link = classifyConnectionLink(value, location.origin, paths);
    if (link.kind === 'shared') {
      scanner.stop();
      void addDevice(link.invitation).catch((error) =>
        showError(error instanceof Error ? error.message : 'PROTOCOL_ERROR'),
      );
      return;
    }
    if (link.kind === 'legacy') {
      scanner.stop();
      startLegacyTarget(link.fragment);
      return;
    }
    if (link.kind === 'invalid' || link.kind === 'unsupported') {
      scanner.stop();
      showError(link.kind === 'unsupported' ? 'VERSION_UNSUPPORTED' : 'PAIR_LINK_INVALID');
      return;
    }
    try {
      if (pendingQR && !pendingQR.settled) throw new Error('FORBIDDEN');
      encodeText(value);
      preview = value;
      pendingQR = undefined;
      qrFinalized = false;
      scanner.stop();
      void notifyStatus('scanned');
      render();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'CONTENT_INVALID');
    }
  }
  async function startScan(): Promise<void> {
    if (!network || cameraStarting || activePairing || (pendingQR && !pendingQR.settled)) return;
    network.activity();
    cameraStarting = true;
    const mine = ++scanGeneration;
    preview = '';
    render();
    try {
      await notifyStatus('scanning');
      await scanner.start();
      if (mine !== scanGeneration) scanner.stop();
      else sharedElement('shared-camera').hidden = false;
    } catch (error) {
      showError(error instanceof Error ? error.message : 'CAMERA_ERROR');
    } finally {
      if (mine === scanGeneration) cameraStarting = false;
    }
  }
  async function notifyStatus(state: 'scanning' | 'scanned' | 'ready'): Promise<void> {
    network?.activity();
    if (legacyTarget?.connected) await legacyTarget.session.send({ type: 'status', state });
    else if (targetId && qrChannels.has(targetId))
      await sendQRControl(targetId, { type: 'status', state });
  }
  async function sendPreview(): Promise<void> {
    const destination = legacyTarget?.connected
      ? LEGACY_TARGET
      : targetId && qrChannels.has(targetId)
        ? targetId
        : undefined;
    if (!preview || !destination || qrFinalized) {
      if (!destination) showError('MEMBER_NOT_FOUND');
      return;
    }
    if (pendingQR && (!pendingQR.timedOut || pendingQR.target !== destination)) return;
    const item: PendingQR = pendingQR ?? {
      id: randomToken(16),
      target: destination,
      text: preview,
      settled: false,
      timedOut: false,
      deadline: 0,
    };
    pendingQR = item;
    item.timedOut = false;
    setSharedStatus(language, 'sending');
    try {
      network?.activity();
      const data = {
        type: 'data',
        id: item.id,
        textB64: encodeText(item.text),
      } as const;
      if (destination === LEGACY_TARGET) await legacyTarget!.session.send(data);
      else await sendQRControl(destination, data);
    } catch (error) {
      if (pendingQR === item) item.timedOut = true;
      throw error;
    }
    if (!item.deadline) item.deadline = performance.now() + SC.DELIVERY_ACK_TIMEOUT_SECONDS * 1000;
    clearTimeout(item.timer);
    const timeout = () => {
      if (pendingQR !== item || item.settled) return;
      item.timedOut = true;
      showError('ACK_TIMEOUT');
      render();
    };
    const remaining = item.deadline - performance.now();
    if (remaining <= 0) timeout();
    else item.timer = setTimeout(timeout, remaining);
  }

  sharedElement('shared-scan').addEventListener('click', () => void startScan());
  sharedElement('shared-photo').addEventListener('click', () =>
    sharedElement<HTMLInputElement>('shared-photo-input').click(),
  );
  sharedElement<HTMLInputElement>('shared-photo-input').addEventListener(
    'change',
    async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try {
        await scanner.image(file);
      } catch {
        showError('CONTENT_INVALID');
      }
    },
  );
  sharedElement('shared-send-qr').addEventListener(
    'click',
    () =>
      void sendPreview().catch((error) =>
        showError(error instanceof Error ? error.message : 'NETWORK_DISCONNECTED'),
      ),
  );
  sharedElement('shared-toggle-participation').addEventListener(
    'click',
    () =>
      void toggleParticipation().catch((error) =>
        showError(error instanceof Error ? error.message : 'PROTOCOL_ERROR'),
      ),
  );
  sharedElement('shared-toggle-admissions').addEventListener('click', () => {
    if (!network || pendingAdmissions !== undefined) return;
    pendingAdmissions = !admissionsOpen;
    try {
      network.admissions(pendingAdmissions);
    } catch (error) {
      pendingAdmissions = undefined;
      showError(error instanceof Error ? error.message : 'NETWORK_DISCONNECTED');
    }
    render();
  });
  sharedElement('shared-end-network').addEventListener('click', () => network?.end());
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      scanGeneration++;
      scanner.stop();
      sharedElement('shared-camera').hidden = true;
      void notifyStatus(preview ? 'scanned' : 'ready');
    } else if (network && !preview && !activePairing) void startScan();
  });
  addEventListener('pagehide', () => {
    generation++;
    rejectNetwork?.(new Error('PEER_CLOSED'));
    resolveNetwork = undefined;
    rejectNetwork = undefined;
    networkReady = undefined;
    cleanupControllerState(true);
  });
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    cleanupControllerState(true);
    showError('NETWORK_DISCONNECTED');
    setSharedStatus(language, 'disconnected');
  });
  sharedElement('shared-version').textContent = `${__APP_VERSION__} (${__SOURCE_COMMIT__})`;
  render();
  setSharedStatus(language, 'sharedConnecting');
  if (!isSecureContext || !crypto.subtle) showError('CRYPTO_UNAVAILABLE');
  else
    void initialize().catch((error) =>
      showError(error instanceof Error ? error.message : 'SERVER_ERROR'),
    );
}
