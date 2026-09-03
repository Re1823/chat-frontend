import assert from 'node:assert/strict';
import test from 'node:test';
import { createRawHookCapture } from '../src/hooks/raw-capture.mjs';

test('raw capture is disabled by default and bounded when explicitly enabled',async()=>{
  assert.equal(createRawHookCapture({filePath:'/unused'}),null);
  const writes=[];
  const capture=createRawHookCapture({enabled:true,filePath:'/gitignored/hook.jsonl',maxBytes:10,files:{
    stat:async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'})},
    mkdir:async()=>{},appendFile:async(path,value)=>writes.push({path,value})
  }});
  await capture({event:'MessageDisplay',delta:'你好'});
  assert.equal(writes.length,1);assert.equal(writes[0].path,'/gitignored/hook.jsonl');
  assert.deepEqual(JSON.parse(writes[0].value).payload,{event:'MessageDisplay',delta:'你好'});

  const full=createRawHookCapture({enabled:true,filePath:'/gitignored/hook.jsonl',maxBytes:10,files:{stat:async()=>({size:10}),mkdir:async()=>{},appendFile:async()=>writes.push('unexpected')}});
  await full({secret:'content'});assert.equal(writes.length,1);
});
