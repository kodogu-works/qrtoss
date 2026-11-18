import QRCode from 'qrcode';
import { C, decodeText, encodeBase64, type AppMessage } from '../../packages/protocol/src/index';
import { classify } from './content';
import { translate, type Key, type Language } from './i18n';
import { Session, type Phase } from './session';
import type { AppPaths } from './paths';
import { el, loadLanguage, mountPage, renderChrome } from './view';

export function startReceiver(paths: AppPaths): void {
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
  let qrConsumed = false;
  type Receipt = {
    id: string;
    hash: string;
    deadline: number;
    done: boolean;
    automatic: boolean;
    navigated: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  const receipts = new Map<string, Receipt>();
  let current: Receipt | undefined;
  let receiptProcessing = false;
  let expiry = 0;
  let qrGeneration = 0;
  let navigating = false;
  let autoCancelled = false;
  mountPage(false, paths);
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
  function render(): void {
    renderChrome(language, status, phase, errorCode, hasPreview, copied, manualCopy);
    const category = classify(preview);
    const showContent =
      hasPreview &&
      !navigating &&
      (phase === 'disconnected' ||
        category.kind !== 'web' ||
        autoCancelled ||
        !!errorCode ||
        (!!current?.done && !current.automatic));
    el('qr-help').textContent = text(qrConsumed ? 'receiverConnectedPrompt' : 'receiverPrompt');
    el('qr').setAttribute('aria-label', text(qrConsumed ? 'connectionQRUsed' : 'connectionQR'));
    renderExpiry();
    el('receiver-result').hidden = !showContent;
    if (el('receiver-text').textContent !== preview) el('receiver-text').textContent = preview;
    el('copy').hidden = !showContent;
    el('clear').hidden = !showContent;
    el('cancelled').hidden = !autoCancelled;
    el('open').hidden = !showContent || category.kind !== 'web';
    el<HTMLButtonElement>('open').disabled = !!current && !current.done;
  }
  function renderExpiry(): void {
    const deadline = qrConsumed ? session?.sendDeadline : expiry;
    el('expiry').textContent = translate(language, 'qrRemaining', {
      seconds: deadline ? Math.max(0, Math.ceil((deadline - performance.now()) / 1000)) : 0,
    });
  }
  function consumeQR(): void {
    if (qrConsumed) return;
    qrConsumed = true;
    qrGeneration++;
    // Destroy the capability-bearing bitmap. This blurred replacement encodes nothing.
    const target = el<HTMLCanvasElement>('qr');
    const placeholder = document.createElement('canvas');
    placeholder.width = target.width;
    placeholder.height = target.height;
    const context = placeholder.getContext('2d')!;
    context.scale(placeholder.width / 256, placeholder.height / 256);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = '#171717';
    // A decorative matrix with finder patterns, but no encoded data or timing patterns.
    const modules = 41;
    const cell = 256 / (modules + 8);
    for (let y = 0; y < modules; y++) {
      for (let x = 0; x < modules; x++) {
        const finder = [
          [0, 0],
          [modules - 7, 0],
          [0, modules - 7],
        ].find(([left, top]) => x >= left - 1 && x <= left + 7 && y >= top - 1 && y <= top + 7);
        let dark = (x * 17 + y * 29 + x * y) % 7 < 3;
        if (finder) {
          const dx = x - finder[0];
          const dy = y - finder[1];
          dark =
            dx >= 0 &&
            dx < 7 &&
            dy >= 0 &&
            dy < 7 &&
            (dx === 0 ||
              dx === 6 ||
              dy === 0 ||
              dy === 6 ||
              (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        }
        if (dark) context.fillRect((4 + x) * cell, (4 + y) * cell, cell, cell);
      }
    }
    // Burn a light blur into unrelated pixels; the original capability is destroyed.
    const output = target.getContext('2d')!;
    output.clearRect(0, 0, target.width, target.height);
    output.filter = `blur(${(1.5 * target.width) / 256}px)`;
    output.drawImage(placeholder, 0, 0);
    output.filter = 'none';
    el('qr-loading').hidden = true;
  }

  function clearReceiptRecords(): void {
    for (const receipt of receipts.values()) clearTimeout(receipt.timer);
    receipts.clear();
    current = undefined;
    receiptProcessing = false;
  }
  function resetData(): void {
    clearReceiptRecords();
    hasPreview = false;
    preview = '';
    autoCancelled = false;
  }
  function attach(): Session {
    const mine = ++connectionGeneration;
    const value = new Session(
      'receiver',
      {
        phase(next) {
          if (mine !== connectionGeneration) return;
          phase = next;
          if (next === 'connected') consumeQR();
          if (next === 'disconnected') {
            if (current && !current.done) finishReceipt(current, false);
            clearReceiptRecords();
            if (!['delivered', 'displaying'].includes(status)) status = 'disconnected';
          } else status = next;
          render();
        },
        async pairing(url, deadline) {
          if (mine !== connectionGeneration) return;
          const qr = ++qrGeneration;
          expiry = deadline;
          el('qr-loading').hidden = false;
          // Generate into a detached canvas, then copy only if this generation survives.
          const canvas = document.createElement('canvas');
          try {
            await QRCode.toCanvas(canvas, [{ data: new TextEncoder().encode(url), mode: 'byte' }], {
              errorCorrectionLevel: 'M',
              margin: 4,
              width: 256 * Math.max(1, devicePixelRatio),
              color: { dark: '#000000', light: '#ffffff' },
            });
            if (mine !== connectionGeneration || qr !== qrGeneration) return;
            const target = el<HTMLCanvasElement>('qr');
            target.width = canvas.width;
            target.height = canvas.height;
            target.getContext('2d')!.drawImage(canvas, 0, 0);
            el('qr-loading').hidden = true;
          } catch {
            if (mine === connectionGeneration) showError('SERVER_ERROR');
          }
        },
        async message(message) {
          if (mine !== connectionGeneration) return;
          await onMessage(message, value, mine);
        },
        error(code) {
          if (mine !== connectionGeneration) return;
          if (!hasPreview) errorCode = code;
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
  async function newReceiver(): Promise<void> {
    qrGeneration++;
    connectionGeneration++;
    session?.close('user_reset');
    resetData();
    errorCode = '';
    expiry = 0;
    render();
    const value = attach();
    await value.startReceiver();
  }

  async function onMessage(message: AppMessage, value: Session, generation: number): Promise<void> {
    if (message.type === 'status') {
      if (!receiptProcessing && (!current || current.done))
        state(
          message.state === 'scanning'
            ? 'peer_scanning'
            : message.state === 'scanned'
              ? 'peer_scanned'
              : 'connected',
        );
      return;
    }
    if (message.type === 'activity') return;
    if (message.type === 'data') {
      const content = decodeText(message.textB64);
      receiptProcessing = true;
      render();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      if (generation !== connectionGeneration || value !== session) return;
      const hash = encodeBase64(new Uint8Array(digest));
      const known = receipts.get(message.id);
      if (known) {
        receiptProcessing = false;
        if (known.hash !== hash) throw new Error('PROTOCOL_ERROR');
        await value.send({ type: 'ack', id: message.id, status: 'received' });
        render();
        return;
      }
      if ((current && !current.done) || receipts.size >= C.MAX_TRANSFERS_PER_ROOM)
        throw new Error('PROTOCOL_ERROR');
      preview = content;
      hasPreview = true;
      autoCancelled = false;
      errorCode = '';
      const receipt: Receipt = {
        id: message.id,
        hash,
        deadline: Infinity,
        done: false,
        automatic: classify(content).kind === 'web' && document.visibilityState === 'visible',
        navigated: false,
      };
      current = receipt;
      receipts.set(receipt.id, receipt);
      receiptProcessing = false;
      state('received_waiting_confirm');
      await value.send({ type: 'ack', id: message.id, status: 'received' });
      if (generation !== connectionGeneration || value !== session) return;
      receipt.deadline = performance.now() + C.ACK_SEEN_TIMEOUT_SECONDS * 1000;
      receipt.timer = setTimeout(
        () => finishReceipt(receipt, false),
        C.ACK_SEEN_TIMEOUT_SECONDS * 1000,
      );
      return;
    }
    if (message.type === 'ack_seen') {
      const receipt = receipts.get(message.id);
      if (!receipt) throw new Error('PROTOCOL_ERROR');
      if (!receipt.done) finishReceipt(receipt, performance.now() < receipt.deadline);
      return;
    }
    throw new Error('PROTOCOL_ERROR');
  }
  function finishReceipt(receipt: Receipt, confirmed: boolean): void {
    if (receipt.done) return;
    clearTimeout(receipt.timer);
    receipt.done = true;
    if (receipt !== current) return;
    if (!confirmed) {
      receipt.automatic = false;
      if (phase === 'connected') errorCode = 'FINAL_ACK_TIMEOUT';
    }
    state('displaying');
    if (confirmed && receipt.automatic && document.visibilityState === 'visible') {
      openContent();
      return;
    }
    if (document.visibilityState === 'visible' && !el('receiver-result').hidden)
      el('receiver-result').scrollIntoView({ block: 'start' });
    if (receipts.size >= C.MAX_TRANSFERS_PER_ROOM) {
      session?.close('transfer_limit');
      showError('TRANSFER_LIMIT');
    }
  }
  function openContent(): void {
    if (!hasPreview || (current && !current.done) || navigating) return;
    const category = classify(preview);
    if (!category.href || category.kind !== 'web') return;
    if (current?.navigated && category.kind === 'web') return;
    if (current) current.navigated = true;
    navigating = true;
    // Set the guard before notifying/closing; external schemes stay in the click event.
    connectionGeneration++;
    qrGeneration++;
    session?.close('navigating');
    clearReceiptRecords();
    phase = 'disconnected';
    state('navigating');
    location.assign(category.href);
    navigating = false;
    status = 'displaying';
    render();
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
      const node = el('receiver-text');
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
  el('open').addEventListener('click', openContent);
  el('clear').addEventListener('click', () => {
    if (current && !current.done) return;
    session?.activity();
    preview = '';
    hasPreview = false;
    autoCancelled = false;
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && current && !current.done && current.automatic) {
      current.automatic = false;
      autoCancelled = true;
      render();
    }
  });
  addEventListener('pagehide', () => {
    connectionGeneration++;
    qrGeneration++;
    session?.close();
    resetData();
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) {
      phase = 'disconnected';
      status = 'disconnected';
      errorCode = 'NETWORK_DISCONNECTED';
      render();
    }
  });
  setInterval(renderExpiry, 500);
  el('version').textContent = `${__APP_VERSION__} (${__SOURCE_COMMIT__})`;
  render();
  if (!isSecureContext || !crypto.subtle) {
    phase = 'disconnected';
    state('disconnected');
    showError('CRYPTO_UNAVAILABLE');
  } else void newReceiver();
}
