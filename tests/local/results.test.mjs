import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPlan } from '../../src/domain/core/plan.ts';
import { shotFromPlan } from '../../src/domain/shots/shot.ts';
import { windowItem } from '../../src/domain/solve/composition.ts';
import { isChatResult, limitChatResult } from '../../src/domain/solve/chat-results.ts';
import { prepare } from '../../scripts/lib/solve-run.mjs';

test('聊天限额保留完整区间，不把路径抽样后冒充完整解；非法数据不供展示', () => {
  const item = windowItem({start:1, end:3, best:2, deviation:0}, {latitude:35,longitude:139}, {azimuth:90,pitch:0}, '2026-11-18');
  const request = prepare({format:'tamatamatori.solve',version:2,targets:[{type:'body',body:'sun'}],camera:{mode:'fixed',aim:{azimuth:90,pitch:0}}}).request;
  const point = {time:1,latitude:35,longitude:139,azimuth:90,elevation:5,cameraGround:10};
  const result = {kind:'solve',id:'test',base:shotFromPlan(initialPlan), request, shape:'lines',
    items:[{...item,points:[point,{...point,time:2,longitude:140}]}],total:1,rings:[],sectors:[],note:''};
  assert.ok(isChatResult(result));
  assert.equal(limitChatResult(result,200,1).items.length,0);
  assert.equal(limitChatResult(result,200,2).items[0].points.length,2);
  assert.equal(limitChatResult(result,0).total,1);
  assert.equal(isChatResult({...result,items:[{...item,best:5}]}),false);
  assert.equal(isChatResult({...result,items:[{...item,points:[]}]}),false);
  assert.equal(isChatResult({...result,items:[null]}),false);
  assert.equal(isChatResult({...result,request:{...request,targets:[null]}}),false);
});
