import test from 'node:test';
import assert from 'node:assert/strict';
import { parseControl } from '../../web/src/session.ts';
const peer='cHFyc3R1dnd4eXp7fH1-fw';

test('server controls require exact schemas, canonical identifiers and integer times',()=>{
  assert.equal(parseControl({v:1,type:'pair.candidate',peer,serverTime:100,candidateExpiresAt:200}).peer,peer);
  assert.throws(()=>parseControl({v:1,type:'pair.candidate',peer,serverTime:100,candidateExpiresAt:200,psk:'secret'}));
  assert.throws(()=>parseControl({v:1,type:'pair.active',peer:`${peer}=`,serverTime:100,idleExpiresAt:200}));
  assert.throws(()=>parseControl({v:1,type:'pair.active',peer,serverTime:'100',idleExpiresAt:200}));
  assert.throws(()=>parseControl({v:2,type:'room.closed',code:'PEER_CLOSED'}));
  assert.throws(()=>parseControl({v:1,type:'error',code:'SOMETHING_NEW',scope:'room'}));
  assert.throws(()=>parseControl({v:1,type:'error',code:'PROTOCOL_ERROR',scope:'all'}));
  assert.throws(()=>parseControl({v:1,type:'hb.pong',id:-1,serverTime:100}));
});
