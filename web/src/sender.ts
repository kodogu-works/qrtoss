import { C, encodeText, randomToken, type AppMessage } from '../../packages/protocol/src/index';
import { Scanner } from './scanner';
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
  let cameraFailed = false;
  let photoReading = false;
  let photoError = false;
  let scanGeneration = 0;
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
    const busy = !!pending && !pending.settled;
    const cliDone = peerMode === 'stdout' && !!pending?.settled;
    const reading = status === 'scanning' || photoReading;
    const showPreview = hasPreview && !reading;
    el('sender-instruction').hidden = showPreview;
    el<HTMLButtonElement>('scan').disabled =
      phase !== 'connected' ||
      busy ||
      cliDone ||
      cameraStarting ||
      senderCount >= C.MAX_TRANSFERS_PER_ROOM;
    el('scan').hidden = !hasPreview || busy || cliDone || status === 'scanning' || photoReading;
    el('scan').textContent = text('scanAgain');
    el('camera-retry').hidden = !cameraFailed;
    el<HTMLButtonElement>('camera-retry').disabled =
      phase !== 'connected' || cameraStarting || photoReading;
    el<HTMLButtonElement>('photo').disabled =
      phase !== 'connected' || busy || cliDone || photoReading;
    el('photo-error').hidden = !photoError;
    el('photo-error').textContent = photoError ? text('photoError') : '';
    el('zoom-control').hidden = status !== 'scanning' || cameraStarting || !scanner.zoom();
    el('camera').hidden = status !== 'scanning';
    el('sender-preview').hidden = !showPreview;
    el('copy').hidden = !showPreview;
    if (el('sender-text').textContent !== preview) el('sender-text').textContent = preview;
    el('send').hidden = !showPreview;
    el('send').textContent = text(
      pending?.settled && !errorCode
        ? 'sendDone'
        : pending && !pending.settled
          ? 'sending'
          : 'sendShort',
    );
    el<HTMLButtonElement>('send').disabled = phase !== 'connected' || !showPreview || !!pending;
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
            scanGeneration++;
            scanner.stop();
            cameraStarting = false;
            if (!['delivered', 'displaying'].includes(status) && !pending?.settled)
              status = 'disconnected';
          } else status = next;
          render();
          if (next === 'connected' && !hasPreview && document.visibilityState === 'visible')
            void startScan();
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
    cameraFailed = false;
    photoReading = false;
    photoError = false;
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
      if (document.visibilityState === 'visible') void startScan(true);
    }
  }
  async function startScan(keepError = false): Promise<void> {
    if (
      phase !== 'connected' ||
      cameraStarting ||
      photoReading ||
      senderCount >= C.MAX_TRANSFERS_PER_ROOM ||
      (pending && !pending.settled) ||
      (peerMode === 'stdout' && pending?.settled)
    )
      return;
    cameraStarting = true;
    cameraFailed = false;
    const attempt = ++scanGeneration;
    const generation = connectionGeneration;
    if (!keepError) errorCode = '';
    state('scanning');
    try {
      await session!.send({ type: 'status', state: 'scanning' });
      if (attempt !== scanGeneration || generation !== connectionGeneration) return;
      await scanner.start();
      if (attempt !== scanGeneration || generation !== connectionGeneration) return;
      const zoom = scanner.zoom();
      if (zoom) {
        const input = el<HTMLInputElement>('zoom');
        input.min = String(zoom.min);
        input.max = String(zoom.max);
        input.step = String(zoom.step);
        input.value = String(zoom.value);
        el('zoom-value').textContent = `${zoom.value.toFixed(1)}×`;
      }
    } catch (error) {
      if (generation === connectionGeneration && attempt === scanGeneration) {
        cameraFailed = true;
        state('connected');
        void session?.send({ type: 'status', state: 'ready' }).catch(() => {});
        showError(error instanceof Error ? error.message : 'CAMERA_ERROR');
      }
    } finally {
      if (attempt === scanGeneration) {
        cameraStarting = false;
        render();
      }
    }
  }
  async function sendContent(retry = false): Promise<void> {
    if (
      phase !== 'connected' ||
      !hasPreview ||
      !session ||
      cameraStarting ||
      photoReading ||
      status === 'scanning'
    )
      return;
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
  el('camera-retry').addEventListener('click', () => void startScan());
  el('photo').addEventListener('click', () => el<HTMLInputElement>('photo-input').click());
  el('photo-input').addEventListener('change', async () => {
    const input = el<HTMLInputElement>('photo-input');
    const file = input.files?.[0];
    input.value = '';
    if (!file || phase !== 'connected' || (pending && !pending.settled) || photoReading) return;
    const attempt = ++scanGeneration;
    photoReading = true;
    cameraStarting = false;
    photoError = false;
    scanner.stop();
    state(hasPreview ? 'scanned' : 'connected');
    void session?.send({ type: 'status', state: hasPreview ? 'scanned' : 'ready' }).catch(() => {});
    try {
      await scanner.image(file);
    } catch {
      if (attempt === scanGeneration) photoError = true;
    } finally {
      if (attempt === scanGeneration) {
        photoReading = false;
        render();
        if (!hasPreview && !cameraFailed && document.visibilityState === 'visible')
          void startScan();
      }
    }
  });
  el('zoom').addEventListener('input', async () => {
    const input = el<HTMLInputElement>('zoom');
    try {
      await scanner.setZoom(Number(input.value));
      const zoom = scanner.zoom();
      if (zoom) el('zoom-value').textContent = `${zoom.value.toFixed(1)}×`;
    } catch {
      const zoom = scanner.zoom();
      if (zoom) input.value = String(zoom.value);
    }
  });
  el('send').addEventListener('click', () => void sendContent());
  el('retry').addEventListener('click', () => void sendContent(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      scanGeneration++;
      photoReading = false;
      scanner.stop();
      cameraStarting = false;
      if (status === 'scanning') {
        state(hasPreview ? 'scanned' : 'connected');
        void session
          ?.send({ type: 'status', state: hasPreview ? 'scanned' : 'ready' })
          .catch(() => {});
      }
    } else if (phase === 'connected' && !hasPreview && !cameraFailed && !photoReading)
      void startScan();
  });
  addEventListener('pagehide', () => {
    scanGeneration++;
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
