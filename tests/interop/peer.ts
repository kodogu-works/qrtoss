import WebSocket from 'ws';
import {once} from 'node:events';
import {CipherChannel,deriveKeys,randomToken,makeProof,verifyProof,type AppMessage} from '../../packages/protocol/src/index.ts';
export class Peer {
  queue:any[]=[]; private waiters:Array<{test:(m:any)=>boolean,resolve:(m:any)=>void,reject:(e:Error)=>void,timer:NodeJS.Timeout}>=[];
  channel?:CipherChannel;
  constructor(public ws:WebSocket){
    ws.on('message',raw=>{const m=JSON.parse(raw.toString());const i=this.waiters.findIndex(w=>w.test(m)); if(i<0)this.queue.push(m);else{const w=this.waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(m);}});
    ws.on('error',()=>{});
  }
  static async connect(base:string,role:string,room:string,cap:string){
    const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws','qrtoss.v1',{origin:base});const p=new Peer(ws);await once(ws,'open');p.send({type:'auth',role,room,cap});await p.next('auth.ok');return p;
  }
  send(m:Record<string,unknown>){this.ws.send(JSON.stringify({v:1,...m}));}
  next(type:string,test:(m:any)=>boolean=()=>true):Promise<any>{
    const pred=(m:any)=>m.type===type&&test(m),i=this.queue.findIndex(pred);
    if(i>=0)return Promise.resolve(this.queue.splice(i,1)[0]);
    return new Promise((resolve,reject)=>{const w={test:pred,resolve,reject,timer:setTimeout(()=>{this.waiters=this.waiters.filter(x=>x!==w);reject(new Error('Timeout waiting for '+type));},5000)};this.waiters.push(w);});
  }
  async app(m:AppMessage){this.ws.send(JSON.stringify(await this.channel!.encrypt(m)));}
  async receive():Promise<AppMessage>{return this.channel!.decrypt(await this.next('cipher'));}
  close(){for(const w of this.waiters)clearTimeout(w.timer);this.waiters=[];this.ws.terminate();}
}
export async function pair(base:string){
  const response=await fetch(base+'/api/v1/rooms',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{"v":1}'});
  if(response.status!==201)throw new Error('room: '+response.status);
  const room=await response.json() as any,psk=randomToken(32);
  const r=await Peer.connect(base,'receiver',room.room,room.receiverCap);
  const s=await Peer.connect(base,'sender',room.room,room.senderJoinCap);
  const {peer}=await r.next('pair.candidate'),rNonce=randomToken(32),sNonce=randomToken(32);
  r.send({type:'pair.challenge',peer,rNonce});await s.next('pair.challenge');
  const keys=await deriveKeys(psk,room.room,peer,rNonce,sNonce);
  s.send({type:'pair.proof',peer,sNonce,proof:await makeProof(keys,'sender')});
  const proof=await r.next('pair.proof');if(!await verifyProof(keys,'sender',proof.proof))throw Error('proof');
  r.send({type:'pair.commit',peer});await r.next('pair.committed');await s.next('pair.committed');
  r.send({type:'pair.confirm',peer,proof:await makeProof(keys,'receiver')});
  const confirmation=await s.next('pair.confirm');if(!await verifyProof(keys,'receiver',confirmation.proof))throw Error('proof');
  r.channel=new CipherChannel(room.room,peer,'receiver',keys);s.channel=new CipherChannel(room.room,peer,'sender',keys);
  await s.app({type:'ready'});await r.receive();await r.app({type:'ready_ack'});await s.receive();
  r.send({type:'pair.active',peer});await r.next('pair.active');await s.next('pair.active');
  return {r,s,room:room.room,peer,psk};
}
