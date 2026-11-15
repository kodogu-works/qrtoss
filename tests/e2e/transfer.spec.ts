import {test,expect,type Page,type Browser} from '@playwright/test';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import {createRelay} from '../../server/src/index.ts';
const base='http://127.0.0.1:18972';
let relay:ReturnType<typeof createRelay>;
test.beforeAll(async()=>{relay=createRelay({publicOrigin:base,allowHttpLoopback:true,staticDir:'dist/web'});await relay.listen(18972);});
test.afterAll(async()=>{await relay.close();});
async function pairingURL(page:Page){
  await expect(page.locator('#status')).toHaveText(/Waiting for your phone/);
  await expect(page.locator('#qr-loading')).toBeHidden();
  // Decode actual canvas pixels without automation injecting screenshot CSS.
  const image=await page.locator('#qr').evaluate((canvas:HTMLCanvasElement)=>({width:canvas.width,height:canvas.height,data:Array.from(canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data)}));
  const qr=jsQR(new Uint8ClampedArray(image.data),image.width,image.height);
  expect(qr).toBeTruthy();return qr!.data;
}
async function fakeCamera(page:Page,payload:string){
  const data=await QRCode.toDataURL(payload,{width:512,margin:4,errorCorrectionLevel:'M'});
  await page.addInitScript(({data})=>{
    const fixture=window as unknown as {qrCameraTracks:MediaStreamTrack[]};fixture.qrCameraTracks=[];
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
      const img=new Image();img.src=data;await img.decode();const c=document.createElement('canvas');c.width=c.height=512;
      const draw=()=>{const ctx=c.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,512,512);ctx.drawImage(img,106,106,300,300);};draw();
      const stream=c.captureStream(15),timer=setInterval(()=>{if(stream.getTracks().every(track=>track.readyState==='ended'))clearInterval(timer);else draw();},66);
      fixture.qrCameraTracks.push(...stream.getTracks());
      for(const track of stream.getTracks())track.addEventListener('ended',()=>clearInterval(timer));return stream;
    }});
  },{data});
}
async function pages(browser:Browser,payload:string){
  const rc=await browser.newContext({locale:'en-US'}),sc=await browser.newContext({locale:'en-US'});
  const r=await rc.newPage(),s=await sc.newPage();const failures:string[]=[];
  const cspViolations:{directive:string;blockedURI:string;sourceFile:string;line:number;sample:string}[]=[];
  for(const page of [r,s]) {
    await page.exposeFunction('recordCspViolation',(violation:typeof cspViolations[number])=>cspViolations.push(violation));
    await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>{
      void (window as unknown as {recordCspViolation:(violation:unknown)=>Promise<void>}).recordCspViolation({directive:event.violatedDirective,blockedURI:event.blockedURI,sourceFile:event.sourceFile,line:event.lineNumber,sample:event.sample});
    }));
  }
  r.on('pageerror',e=>failures.push(e.message));s.on('pageerror',e=>failures.push(e.message));
  await fakeCamera(s,payload);await r.goto(base);const url=await pairingURL(r);
  await s.goto(url);await expect(s).toHaveURL(base+'/send');
  await expect(s.locator('#status')).toHaveText('Connected securely');await expect(r.locator('#status')).toHaveText('Connected securely');
  return {r,s,rc,sc,failures,url,cspViolations};
}
test('camera QR → explicit confirmation → encrypted transfer to display-only receiver',async({browser})=>{
  const text='https://example.org/scan?qrtoss=1';const {r,s,rc,sc,failures,cspViolations}=await pages(browser,text);
  try{
    await r.locator('input[value="display_only"]').check();
    await s.bringToFront();await s.locator('#scan').click();await expect(s.locator('#sender-text')).toHaveText(text);
    expect(await s.evaluate(()=>{const tracks=(window as unknown as {qrCameraTracks:MediaStreamTrack[]}).qrCameraTracks;return tracks.length>0&&tracks.every(track=>track.readyState==='ended');})).toBe(true);
    await expect(r.locator('#receiver-text')).toHaveText('');
    await s.locator('#send').click();await expect(s.locator('#status')).toHaveText('Received by the other device');
    await expect(r.locator('#receiver-text')).toHaveText(text);await expect(r).toHaveURL(base+'/');
    await expect(r.locator('#open')).toBeEnabled();expect(failures).toEqual([]);expect(cspViolations).toEqual([]);
    expect(await r.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
    expect(await s.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
  }finally{await rc.close();await sc.close();}
});
test('default mode opens an accepted web URL in the same tab after ack_seen',async({browser})=>{
  const text='https://example.org/received';const {r,s,rc,sc,failures,cspViolations}=await pages(browser,text);
  try{
    await r.route(text,route=>route.fulfill({body:'received destination',contentType:'text/plain'}));
    await expect(r.locator('input[value="auto_open"]')).toBeChecked();
    await s.locator('#scan').click();await expect(s.locator('#sender-text')).toHaveText(text);await s.locator('#send').click();
    await expect(r).toHaveURL(text);await expect(s.locator('#status')).toHaveText('Received by the other device');expect(failures).toEqual([]);expect(cspViolations).toEqual([]);
  }finally{await rc.close();await sc.close();}
});
test('inert content stays literal, language switches and mobile layout fits',async({browser})=>{
  const text='javascript:alert("never execute")';const {r,s,rc,sc,failures,cspViolations}=await pages(browser,text);
  try{
    await s.locator('#scan').click();await expect(s.locator('#sender-text')).toHaveText(text);await s.locator('#send').click();
    await expect(r.locator('#receiver-text')).toHaveText(text);await expect(r.locator('#open')).toBeHidden();
    await r.setViewportSize({width:320,height:740});await r.locator('#language').selectOption('ja');await expect(r.locator('h1')).toHaveText('この端末で受信');
    expect(await r.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await r.locator('#language').selectOption('es');await expect(r.locator('h1')).toHaveText('Recibir en este dispositivo');expect(failures).toEqual([]);expect(cspViolations).toEqual([]);
  }finally{await rc.close();await sc.close();}
});
test('invalid pairing fragment is removed and no connection is attempted',async({page})=>{
  let sockets=0;page.on('websocket',()=>sockets++);await page.goto(base+'/send#v=1&r=secret&j=x&k=x');
  await expect(page).toHaveURL(base+'/send');await expect(page.locator('#error')).toBeVisible();expect(sockets).toBe(0);
});
