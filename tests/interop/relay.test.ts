import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRelay} from '../../server/src/index.ts';
import {pair} from './peer.ts';
import {randomToken,encodeText,decodeText} from '../../packages/protocol/src/index.ts';
test('real relay: mutual proof, ready, mode, Unicode transfer, ack and ack_seen',async()=>{
  const relay=createRelay({publicOrigin:'http://127.0.0.1:18971',allowHttpLoopback:true});
  await relay.listen(18971);
  let peers:Awaited<ReturnType<typeof pair>>|undefined;
  try{
    peers=await pair('http://127.0.0.1:18971');const {r,s,room,peer}=peers;
    await r.app({type:'mode',value:'stdout'});assert.deepEqual(await s.receive(),{type:'mode',value:'stdout'});
    const id=randomToken(16),text='\ufeffこんにちは😀\nQR\u0000';
    await s.app({type:'data',id,textB64:encodeText(text)});
    const m=await r.receive();assert.equal(m.type,'data');if(m.type==='data')assert.equal(decodeText(m.textB64),text);
    await r.app({type:'ack',id,status:'received'});assert.deepEqual(await s.receive(),{type:'ack',id,status:'received'});
    await s.app({type:'ack_seen',id});assert.deepEqual(await r.receive(),{type:'ack_seen',id});
    r.send({type:'room.close',reason:'user_end'});assert.equal((await s.next('room.closed')).code,'PEER_CLOSED');
  }finally{peers?.r.close();peers?.s.close();await relay.close();}
});
