import { C, encodeText, randomToken, type AppMessage } from '../../packages/protocol/src/index';
import { Scanner } from './scanner';
import { classify } from './content';
import { translate, type Key, type Language } from './i18n';
import { Session, type Mode, type Phase } from './session';
import type { AppPaths } from './paths';
import { el, loadLanguage, mountPage, renderChrome } from './view';

export function startSender(paths: AppPaths, fragment: string): void {
  let language = loadLanguage();
  let session: Session | undefined;
  let phase: Phase = 'creating';
  let status: Key = 'creating';
  let errorCode = '';
  let preview = '';
  let hasPreview = false;
  let copied = false;
  let manualCopy = false;
  let connectionGeneration = 0;
  let peerMode: Mode | undefined;
  let pending:
    | { id: string; text: string; deadline: number; settled: boolean; timedOut: boolean }
    | undefined;
  let senderCount = 0;
  const senderResults = new Map<string, 'received' | 'rejected'>();
  let cameraStarting = false;
  let transferTimer: ReturnType<typeof setTimeout> | undefined;
  mountPage(true, paths);
  function text(key: Key): string {
    return translate(language, key);
  }
  function showError(code: string): void {
    errorCode = code;
    render();
  }
  function state(key: Key): void {
    status = key;
    render();
  }
  const scanner = new Scanner(el<HTMLVideoElement>('video'), scanned);
  function render(): void {
    renderChrome(language, status, phase, errorCode, hasPreview, copied, manualCopy);
    const modeText: Record<Mode, Key> = {
      auto_open: 'peerAuto',
      display_only: 'peerDisplay',
      stdout: 'peerStdout',
    };
    el('peer-mode').hidden = !peerMode;
    el('peer-mode').textContent = peerMode ? text(modeText[peerMode]) : '';
    const busy = !!pending && !pending.settled;
    const cliDone = peerMode === 'stdout' && !!pending?.settled;
    el('cli-done').hidden = !cliDone;
    el<HTMLButtonElement>('scan').disabled =
      phase !== 'connected' ||
      busy ||
      cliDone ||
      cameraStarting ||
      senderCount >= C.MAX_TRANSFERS_PER_ROOM;
    el('scan').textContent = text(hasPreview ? 'scanAgain' : 'scan');
    el('stop').hidden = status !== 'scanning';
    el('camera').hidden = status !== 'scanning';
    el('scan-placeholder').hidden = hasPreview || status === 'scanning';
    el('sender-preview').hidden = !hasPreview;
    if (el('sender-text').textContent !== preview) el('sender-text').textContent = preview;
    const category = classify(preview);
    el('domain').textContent = category.host ?? '';
    el('domain').hidden = !category.host;
    el('send').hidden = !hasPreview || !!pending;
    el<HTMLButtonElement>('send').disabled = phase !== 'connected' || !hasPreview || !!pending;
    el('retry').hidden = !pending?.timedOut || !!pending.settled || phase !== 'connected';
  }
  function attach(): Session {
    const mine = ++connectionGeneration;
    const value = new Session(
      'sender',
      {
        phase(next) {
          if (mine !== connectionGeneration) return;
          phase = next;
          if (next === 'disconnected') {
            scanner.stop();
            cameraStarting = false;
            if (!['delivered', 'displaying'].includes(status) && !pending?.settled)
              status = 'disconnected';
          } else status = next;
          render();
        },
        async message(message) {
          if (mine !== connectionGeneration) return;
          await onMessage(message, value);
        },
        error(code) {
          if (mine !== connectionGeneration) return;
          if (!pending?.settled && !hasPreview) errorCode = code;
          else if (!['NETWORK_DISCONNECTED', 'PEER_CLOSED'].includes(code)) errorCode = code;
          render();
        },
      },
      'auto_open',
      paths,
    );
    session = value;
    return value;
  }
  async function onMessage(message: AppMessage, value: Session): Promise<void> {
    if (message.type === 'mode') {
      peerMode = message.value;
      render();
      return;
    }
    if (message.type === 'ack') {
      if (senderResults.has(message.id)) return;
      if (!pending || pending.id !== message.id) throw new Error('PROTOCOL_ERROR');
      pending.settled = true;
      pending.timedOut = false;
      senderResults.set(message.id, message.status);
      senderCount++;
      clearTimeout(transferTimer);
      errorCode = message.status === 'rejected' ? 'CONTENT_UNSUPPORTED' : '';
      status = message.status === 'received' ? 'delivered' : 'scanned';
      render();
      await value.send({ type: 'ack_seen', id: message.id });
      return;
    }
    throw new Error('PROTOCOL_ERROR');
  }
  function scanned(content: string): void {
    cameraStarting = false;
    try {
      encodeText(content);
      preview = content;
      hasPreview = true;
      pending = undefined;
      errorCode = '';
      state('scanned');
      void session?.send({ type: 'status', state: 'scanned' }).catch(() => {});
    } catch (error) {
      state('connected');
      void session?.send({ type: 'status', state: 'ready' }).catch(() => {});
      showError(error instanceof Error ? error.message : 'CONTENT_INVALID');
    }
  }
  async function startScan(): Promise<void> {
    if (
      phase !== 'connected' ||
      cameraStarting ||
      (pending && !pending.settled) ||
      (peerMode === 'stdout' && pending?.settled)
    )
      return;
    cameraStarting = true;
    const generation = connectionGeneration;
    errorCode = '';
    state('scanning');
    try {
      await session!.send({ type: 'status', state: 'scanning' });
      await scanner!.start();
      if (generation !== connectionGeneration) scanner!.stop();
    } catch (error) {
      if (generation === connectionGeneration) {
        state('connected');
        void session?.send({ type: 'status', state: 'ready' }).catch(() => {});
        showError(error instanceof Error ? error.message : 'CAMERA_ERROR');
      }
    } finally {
      cameraStarting = false;
      render();
    }
  }
  async function sendContent(retry = false): Promise<void> {
    if (phase !== 'connected' || !hasPreview || !session) return;
    if (retry) {
      if (!pending || pending.settled || !pending.timedOut) return;
    } else {
      if (pending) return;
      pending = {
        id: randomToken(16),
        text: preview,
        deadline: 0,
        settled: false,
        timedOut: false,
      };
    }
    try {
      const item = pending!;
      item.timedOut = false;
      errorCode = '';
      state('sending');
      await session.send({ type: 'data', id: item.id, textB64: encodeText(item.text) });
      // Retries never extend the original sender deadline.
      if (!item.deadline) item.deadline = performance.now() + C.DELIVERY_ACK_TIMEOUT_SECONDS * 1000;
      clearTimeout(transferTimer);
      const expire = () => {
        if (item !== pending || item.settled) return;
        item.timedOut = true;
        errorCode = 'ACK_TIMEOUT';
        render();
      };
      if (performance.now() >= item.deadline) expire();
      else transferTimer = setTimeout(expire, item.deadline - performance.now());
    } catch (error) {
      showError(error instanceof Error ? error.message : 'NETWORK_DISCONNECTED');
    }
  }

  el<HTMLSelectElement>('language').addEventListener('change', (event) => {
    language = (event.target as HTMLSelectElement).value as Language;
    try {
      localStorage.setItem('qrtoss.language', language);
    } catch {
      /* preference only */
    }
    session?.activity();
    render();
  });
  el('copy').addEventListener('click', async () => {
    if (!hasPreview) return;
    session?.activity();
    try {
      await navigator.clipboard.writeText(preview);
      copied = true;
      manualCopy = false;
    } catch {
      copied = false;
      manualCopy = true;
      const node = el('sender-text');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    render();
    setTimeout(() => {
      copied = false;
      render();
    }, 2000);
  });
  el('scan').addEventListener('click', () => void startScan());
  el('stop').addEventListener('click', () => {
    scanner?.stop();
    cameraStarting = false;
    state(hasPreview ? 'scanned' : 'connected');
    void session?.send({ type: 'status', state: hasPreview ? 'scanned' : 'ready' }).catch(() => {});
  });
  el('send').addEventListener('click', () => void sendContent());
  el('retry').addEventListener('click', () => void sendContent(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      scanner.stop();
      cameraStarting = false;
      if (status === 'scanning') {
        state(hasPreview ? 'scanned' : 'connected');
        void session
          ?.send({ type: 'status', state: hasPreview ? 'scanned' : 'ready' })
          .catch(() => {});
      }
    }
  });
  addEventListener('pagehide', () => {
    connectionGeneration++;
    session?.close();
    scanner.stop();
    hasPreview = false;
    preview = '';
    pending = undefined;
    senderResults.clear();
    senderCount = 0;
    clearTimeout(transferTimer);
    fragment = '';
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) {
      phase = 'disconnected';
      status = 'disconnected';
      errorCode = 'NETWORK_DISCONNECTED';
      render();
    }
  });
  el('version').textContent = `${__APP_VERSION__} (${__SOURCE_COMMIT__})`;
  render();
  if (!isSecureContext || !crypto.subtle) {
    phase = 'disconnected';
    state('disconnected');
    showError('CRYPTO_UNAVAILABLE');
    fragment = '';
  } else {
    attach().startSender(fragment);
    fragment = '';
  }
}
