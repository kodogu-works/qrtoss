import QRCode from 'qrcode';
import { C, decodeText, encodeBase64, encodeText, randomToken, type AppMessage } from '../../packages/protocol/src/index';
import { classify } from './content';
import { chooseLanguage, errorText, translate, type Key, type Language } from './i18n';
import { Scanner } from './scanner';
import { Session, type Mode, type Phase } from './session';
import { createAppPaths } from './paths';
import './style.css';

const paths=createAppPaths(import.meta.env.BASE_URL);
const sender=location.pathname.replace(/\/$/,'')===paths.sender;
// Fragment is removed before any other asynchronous work, including error paths.
let fragment=sender?location.hash:'';
if(sender) history.replaceState(null,'',paths.sender);
let saved:string|null=null;try{saved=localStorage.getItem('qrtoss.language');}catch{/* storage may be disabled */}
let language=chooseLanguage(navigator.languages,saved);
let session:Session|undefined;
let phase:Phase='creating';
let status:Key='creating';
let errorCode='';
let mode:Mode='auto_open';
let peerMode:Mode|undefined;
let preview='';
let hasPreview=false;
let pending:{id:string;text:string;deadline:number;settled:boolean;timedOut:boolean}|undefined;
let senderCount=0;
const senderResults=new Map<string,'received'|'rejected'>();
type Receipt={id:string;hash:string;deadline:number;done:boolean;automatic:boolean;navigated:boolean;timer?:ReturnType<typeof setTimeout>};
const receipts=new Map<string,Receipt>();
let current:Receipt|undefined;
let receiptProcessing=false;
let expiry=0;
let qrGeneration=0;
let navigating=false;
let copied=false;
let manualCopy=false;
let autoCancelled=false;
let cameraStarting=false;
let transferTimer:ReturnType<typeof setTimeout>|undefined;
let connectionGeneration=0;

const root=document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML=`
<div class="shell"><header class="topbar"><a class="wordmark" href="${paths.home}" aria-label="qrtoss home"><span class="brand-symbol" aria-hidden="true">↗</span>qrtoss<span class="brand-dot">.</span></a><label class="language"><span class="sr-only" data-i18n="language"></span><select id="language" aria-label="Language"><option value="en">English</option><option value="ja">日本語</option><option value="es">Español</option></select></label></header>
<main><div class="eyebrow"><span class="little-line"></span><span data-i18n="about"></span></div><h1 data-i18n="${sender?'sendTitle':'receive'}"></h1><p class="intro" data-i18n="${sender?'senderIntro':'receiverIntro'}"></p>
<div class="workspace"><section class="card primary-card"><div class="card-heading"><span class="step">01</span><h2 data-i18n="${sender?'preview':'stepOne'}"></h2><span class="connection-icon" aria-hidden="true">⌁</span></div>
<div class="connection-status" role="status" aria-live="polite"><span id="status-dot" class="status-dot"></span><span id="status"></span></div>
<p id="peer-mode" class="peer-mode" hidden></p><p id="error" class="notice error" role="alert" hidden></p>
${sender?`<div id="camera" class="camera" hidden><video id="video" muted autoplay playsinline></video><div class="camera-reticle" aria-hidden="true"></div></div><div id="scan-placeholder" class="scan-placeholder"><span aria-hidden="true">▧</span><p data-i18n="cameraHelp"></p></div><div id="sender-preview" class="preview" hidden><p id="domain" class="domain"></p><pre id="sender-text" dir="auto" tabindex="0"></pre></div><div class="actions"><button id="scan" class="button accent" data-i18n="scan" disabled></button><button id="stop" class="button secondary" data-i18n="stop" hidden></button><button id="send" class="button accent" data-i18n="send" hidden></button><button id="retry" class="button secondary" data-i18n="retry" hidden></button><button id="copy" class="button secondary" data-i18n="copy" hidden></button></div><p id="cli-done" class="hint" data-i18n="cliDone" hidden></p>`:
`<div id="qr-wrap" class="qr-wrap"><div class="qr-frame"><canvas id="qr" aria-label="Connection QR code" role="img"></canvas><div id="qr-loading" class="qr-loading" aria-hidden="true"><span></span></div></div><div id="expiry" class="expiry"></div></div><div id="connected-art" class="connected-art" hidden aria-hidden="true"><span>✓</span><i></i><span>✓</span></div><p id="qr-help" class="qr-help" data-i18n="qrHelp"></p><p id="secret-hint" class="secret-hint" data-i18n="qrSecret"></p><button id="new-qr" class="button secondary wide" data-i18n="newQR"></button>`}
</section>
${sender?'':`<div class="side-column"><section class="card mode-card"><div class="card-heading"><span class="step">02</span><h2 data-i18n="stepTwo"></h2></div><fieldset id="modes"><legend class="sr-only" data-i18n="stepTwo"></legend><label class="mode-choice"><input type="radio" name="mode" value="auto_open" checked><span><strong data-i18n="auto"></strong><small data-i18n="navigationHelp"></small></span></label><label class="mode-choice"><input type="radio" name="mode" value="display_only"><span><strong data-i18n="display"></strong><small data-i18n="modeHelp"></small></span></label></fieldset></section><section class="card result-card"><div class="card-heading"><span class="step">03</span><h2 data-i18n="stepThree"></h2></div><p id="empty" class="empty" data-i18n="empty"></p><div id="receiver-preview" class="preview" hidden><pre id="receiver-text" dir="auto" tabindex="0"></pre></div><p id="cancelled" class="hint" data-i18n="cancelledAuto" hidden></p><div class="actions"><button id="open" class="button accent" hidden></button><button id="copy" class="button secondary" data-i18n="copy" hidden></button><button id="clear" class="text-button" data-i18n="clear" hidden></button></div></section></div>`}
</div><p id="copy-feedback" role="status" class="copy-feedback"></p><div class="trust-row"><span><i aria-hidden="true">◇</i><span data-i18n="private"></span></span><span><i aria-hidden="true">○</i><span data-i18n="noAccount"></span></span><span><i aria-hidden="true">↝</i><span data-i18n="noHistory"></span></span></div></main><footer><span>qrtoss / <span id="version"></span></span><span data-i18n="license"></span></footer></div>`;
function el<T extends HTMLElement=HTMLElement>(id:string):T {return document.getElementById(id) as T;}
function text(key:Key):string{return translate(language,key);}
function showError(code:string):void {errorCode=code;render();}
function state(key:Key):void {status=key;render();}
const scanner=sender?new Scanner(el<HTMLVideoElement>('video'),scanned):undefined;

function render():void {
  document.documentElement.lang=language;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(node=>{node.textContent=text(node.dataset.i18n as Key);});
  el<HTMLSelectElement>('language').value=language;
  el('status').textContent=text(status);
  el('status-dot').className=`status-dot ${phase==='connected'?'online':''}`;
  el('error').hidden=!errorCode;
  el('error').textContent=errorCode?errorText(language,errorCode):'';
  const modeText:Record<Mode,Key>={auto_open:'peerAuto',display_only:'peerDisplay',stdout:'peerStdout'};
  el('peer-mode').hidden=!sender || !peerMode;
  el('peer-mode').textContent=peerMode?text(modeText[peerMode]):'';
  el('copy').hidden=!hasPreview;
  el('copy-feedback').textContent=copied?text('copied'):manualCopy?text('manualCopy'):'';
  if(sender) {
    const busy=!!pending && !pending.settled;
    const cliDone=peerMode==='stdout' && !!pending?.settled;
    el('cli-done').hidden=!cliDone;
    el<HTMLButtonElement>('scan').disabled=phase!=='connected' || busy || cliDone || cameraStarting || senderCount>=C.MAX_TRANSFERS_PER_ROOM;
    el('scan').textContent=text(hasPreview?'scanAgain':'scan');
    el('stop').hidden=status!=='scanning';
    el('camera').hidden=status!=='scanning';
    el('scan-placeholder').hidden=hasPreview || status==='scanning';
    el('sender-preview').hidden=!hasPreview;
    if(el('sender-text').textContent!==preview) el('sender-text').textContent=preview;
    const category=classify(preview);
    el('domain').textContent=category.host??'';el('domain').hidden=!category.host;
    el('send').hidden=!hasPreview || !!pending;
    el<HTMLButtonElement>('send').disabled=phase!=='connected' || !hasPreview || !!pending;
    el('retry').hidden=!pending?.timedOut || !!pending.settled || phase!=='connected';
  } else {
    const connected=phase==='connected';
    el('qr-wrap').hidden=connected || !['waiting','pairing','creating'].includes(phase);
    el('connected-art').hidden=!connected;
    el('qr-help').hidden=connected;
    el('secret-hint').hidden=connected;
    el<HTMLFieldSetElement>('modes').disabled=receiptProcessing || !!current && !current.done;
    el('receiver-preview').hidden=!hasPreview;if(el('receiver-text').textContent!==preview) el('receiver-text').textContent=preview;
    el('empty').hidden=hasPreview;
    el('clear').hidden=!hasPreview;
    el('cancelled').hidden=!autoCancelled;
    const category=classify(preview);
    el('open').hidden=!hasPreview || !['web','external'].includes(category.kind);
    el('open').textContent=text(category.kind==='external'?'openExternal':'open');
    el<HTMLButtonElement>('open').disabled=!!current && !current.done;
  }
}

function clearReceiptRecords():void {
  for(const receipt of receipts.values()) clearTimeout(receipt.timer);
  receipts.clear();current=undefined;receiptProcessing=false;
}
function resetData():void {
  clearReceiptRecords();hasPreview=false;preview='';pending=undefined;senderResults.clear();senderCount=0;clearTimeout(transferTimer);autoCancelled=false;
}
function attach(role:'receiver'|'sender'):Session {
  const mine=++connectionGeneration;
  const value=new Session(role,{
    phase(next) {
      if(mine!==connectionGeneration) return;
      phase=next;
      if(next==='disconnected') {
        scanner?.stop();cameraStarting=false;
        if(current&&!current.done) finishReceipt(current,false);
        clearReceiptRecords();
        if(!['delivered','displaying'].includes(status) && !pending?.settled) status='disconnected';
      } else status=next;
      render();
    },
    async pairing(url,deadline) {
      if(mine!==connectionGeneration) return;
      const qr=++qrGeneration;expiry=deadline;el('qr-loading').hidden=false;
      // Generate into a detached canvas, then copy only if this generation survives.
      const canvas=document.createElement('canvas');
      try {
        await QRCode.toCanvas(canvas,[{data:new TextEncoder().encode(url),mode:'byte'}],{errorCorrectionLevel:'M',margin:4,width:256*Math.max(1,devicePixelRatio),color:{dark:'#000000',light:'#ffffff'}});
        if(mine!==connectionGeneration || qr!==qrGeneration) return;
        const target=el<HTMLCanvasElement>('qr');target.width=canvas.width;target.height=canvas.height;target.getContext('2d')!.drawImage(canvas,0,0);
        el('qr-loading').hidden=true;
      }catch{if(mine===connectionGeneration) showError('SERVER_ERROR');}
    },
    async message(message) {if(mine!==connectionGeneration) return;await onMessage(message,value,mine);},
    error(code) {if(mine!==connectionGeneration) return;if(!pending?.settled && !hasPreview) errorCode=code;else if(!['NETWORK_DISCONNECTED','PEER_CLOSED'].includes(code)) errorCode=code;render();},
  },mode,paths);
  session=value;return value;
}
async function newReceiver():Promise<void> {
  qrGeneration++;connectionGeneration++;session?.close('user_reset');resetData();errorCode='';expiry=0;
  render();const value=attach('receiver');await value.startReceiver();
}

async function onMessage(message:AppMessage,value:Session,generation:number):Promise<void> {
  if(message.type==='mode') {if(!sender) throw new Error('PROTOCOL_ERROR');peerMode=message.value;render();return;}
  if(message.type==='status') {
    if(!receiptProcessing && (!current || current.done)) state(message.state==='scanning'?'peer_scanning':message.state==='scanned'?'peer_scanned':'connected');
    return;
  }
  if(message.type==='activity') return;
  if(message.type==='data') {
    if(sender) throw new Error('PROTOCOL_ERROR');
    const content=decodeText(message.textB64);
    receiptProcessing=true;render();
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content));
    if(generation!==connectionGeneration || value!==session) return;
    const hash=encodeBase64(new Uint8Array(digest));
    const known=receipts.get(message.id);
    if(known) {
      receiptProcessing=false;
      if(known.hash!==hash) throw new Error('PROTOCOL_ERROR');
      await value.send({type:'ack',id:message.id,status:'received'});render();return;
    }
    if(current&&!current.done || receipts.size>=C.MAX_TRANSFERS_PER_ROOM) throw new Error('PROTOCOL_ERROR');
    preview=content;hasPreview=true;autoCancelled=false;errorCode='';
    const receipt:Receipt={id:message.id,hash,deadline:Infinity,done:false,automatic:mode==='auto_open'&&classify(content).kind==='web'&&document.visibilityState==='visible',navigated:false};
    current=receipt;receipts.set(receipt.id,receipt);receiptProcessing=false;state('received_waiting_confirm');
    await value.send({type:'ack',id:message.id,status:'received'});
    if(generation!==connectionGeneration || value!==session) return;
    receipt.deadline=performance.now()+C.ACK_SEEN_TIMEOUT_SECONDS*1000;
    receipt.timer=setTimeout(()=>finishReceipt(receipt,false),C.ACK_SEEN_TIMEOUT_SECONDS*1000);
    return;
  }
  if(message.type==='ack_seen') {
    const receipt=receipts.get(message.id);if(sender||!receipt) throw new Error('PROTOCOL_ERROR');
    if(!receipt.done) finishReceipt(receipt,performance.now()<receipt.deadline);
    return;
  }
  if(message.type==='ack') {
    if(!sender) throw new Error('PROTOCOL_ERROR');
    if(senderResults.has(message.id)) return;
    if(!pending || pending.id!==message.id) throw new Error('PROTOCOL_ERROR');
    pending.settled=true;pending.timedOut=false;senderResults.set(message.id,message.status);senderCount++;
    clearTimeout(transferTimer);errorCode=message.status==='rejected'?'CONTENT_UNSUPPORTED':'';status=message.status==='received'?'delivered':'scanned';render();
    await value.send({type:'ack_seen',id:message.id});return;
  }
  throw new Error('PROTOCOL_ERROR');
}
function finishReceipt(receipt:Receipt,confirmed:boolean):void {
  if(receipt.done) return;
  clearTimeout(receipt.timer);receipt.done=true;
  if(receipt!==current) return;
  if(!confirmed) {receipt.automatic=false;if(phase==='connected') errorCode='FINAL_ACK_TIMEOUT';}
  state('displaying');
  if(confirmed && receipt.automatic && document.visibilityState==='visible') {openContent();return;}
  if(receipts.size>=C.MAX_TRANSFERS_PER_ROOM) {session?.close('transfer_limit');showError('TRANSFER_LIMIT');}
}
function openContent():void {
  if(!hasPreview || current&&!current.done || navigating) return;
  const category=classify(preview);
  if(!category.href || !['web','external'].includes(category.kind)) return;
  if(current?.navigated && category.kind==='web') return;
  if(current) current.navigated=true;
  navigating=true;
  // Set the guard before notifying/closing; external schemes stay in the click event.
  connectionGeneration++;qrGeneration++;session?.close('navigating');scanner?.stop();clearReceiptRecords();phase='disconnected';state('navigating');
  location.assign(category.href);
  navigating=false;status='displaying';render();
}
function scanned(content:string):void {
  cameraStarting=false;
  try {encodeText(content);preview=content;hasPreview=true;pending=undefined;errorCode='';state('scanned');void session?.send({type:'status',state:'scanned'}).catch(()=>{});}
  catch(error) {state('connected');void session?.send({type:'status',state:'ready'}).catch(()=>{});showError(error instanceof Error?error.message:'CONTENT_INVALID');}
}
async function startScan():Promise<void> {
  if(phase!=='connected' || cameraStarting || pending&&!pending.settled || peerMode==='stdout'&&pending?.settled) return;
  cameraStarting=true;const generation=connectionGeneration;errorCode='';state('scanning');
  try {await session!.send({type:'status',state:'scanning'});await scanner!.start();if(generation!==connectionGeneration) scanner!.stop();}
  catch(error) {if(generation===connectionGeneration) {state('connected');void session?.send({type:'status',state:'ready'}).catch(()=>{});showError(error instanceof Error?error.message:'CAMERA_ERROR');}}
  finally{cameraStarting=false;render();}
}
async function sendContent(retry=false):Promise<void> {
  if(phase!=='connected' || !hasPreview || !session) return;
  if(retry) {if(!pending || pending.settled || !pending.timedOut) return;}
  else {if(pending) return;pending={id:randomToken(16),text:preview,deadline:0,settled:false,timedOut:false};}
  try {
    const item=pending!;item.timedOut=false;errorCode='';state('sending');
    await session.send({type:'data',id:item.id,textB64:encodeText(item.text)});
    // Retries never extend the original sender deadline.
    if(!item.deadline) item.deadline=performance.now()+C.DELIVERY_ACK_TIMEOUT_SECONDS*1000;
    clearTimeout(transferTimer);
    const expire=()=>{if(item!==pending || item.settled) return;item.timedOut=true;errorCode='ACK_TIMEOUT';render();};
    if(performance.now()>=item.deadline) expire();else transferTimer=setTimeout(expire,item.deadline-performance.now());
  }catch(error){showError(error instanceof Error?error.message:'NETWORK_DISCONNECTED');}
}

el<HTMLSelectElement>('language').addEventListener('change',event=>{
  language=(event.target as HTMLSelectElement).value as Language;
  try{localStorage.setItem('qrtoss.language',language);}catch{/* preference only */}
  session?.activity();render();
});
el('copy').addEventListener('click',async()=>{
  if(!hasPreview) return;session?.activity();
  try {await navigator.clipboard.writeText(preview);copied=true;manualCopy=false;} catch {copied=false;manualCopy=true;const node=el(sender?'sender-text':'receiver-text');const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);}
  render();setTimeout(()=>{copied=false;render();},2000);
});
if(sender) {
  el('scan').addEventListener('click',()=>void startScan());
  el('stop').addEventListener('click',()=>{scanner?.stop();cameraStarting=false;state(hasPreview?'scanned':'connected');void session?.send({type:'status',state:hasPreview?'scanned':'ready'}).catch(()=>{});});
  el('send').addEventListener('click',()=>void sendContent());el('retry').addEventListener('click',()=>void sendContent(true));
} else {
  el('new-qr').addEventListener('click',()=>void newReceiver());
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(input=>input.addEventListener('change',()=>{mode=input.value as Mode;void session?.setMode(mode).catch(()=>{});render();}));
  el('open').addEventListener('click',openContent);
  el('clear').addEventListener('click',()=>{if(current&&!current.done) return;session?.activity();preview='';hasPreview=false;autoCancelled=false;render();});
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden') {
    scanner?.stop();cameraStarting=false;
    if(status==='scanning') {state(hasPreview?'scanned':'connected');void session?.send({type:'status',state:hasPreview?'scanned':'ready'}).catch(()=>{});}
    if(current&&!current.done&&current.automatic) {current.automatic=false;autoCancelled=true;render();}
  }
});
addEventListener('pagehide',()=>{connectionGeneration++;qrGeneration++;session?.close();scanner?.stop();resetData();fragment='';});
addEventListener('pageshow',event=>{if(event.persisted) {phase='disconnected';status='disconnected';errorCode='NETWORK_DISCONNECTED';render();}});
setInterval(()=>{
  if(!sender && expiry) {
    el('expiry').textContent=translate(language,'expires',{seconds:Math.max(0,Math.ceil((expiry-performance.now())/1000))});
    // The server's atomic commit decides expiry, including while commit/ready is in flight.
  }
},500);
el('version').textContent=`${__APP_VERSION__} (${__SOURCE_COMMIT__})`;
render();
if(!isSecureContext || !crypto.subtle) {phase='disconnected';state('disconnected');showError('CRYPTO_UNAVAILABLE');fragment='';}
else if(sender) {attach('sender').startSender(fragment);fragment='';}
else void newReceiver();
