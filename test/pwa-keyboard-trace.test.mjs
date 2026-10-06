import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createDwellServer } from '../server.mjs';

test('iPhone keyboard trace stays local, bounded, numeric and exportable',async()=>{
  const server=createDwellServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',acceptDownloads:true});
    await context.route('**/api/runtimes/claude-tmux/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"state":"connected","runtimeId":"claude-main"}'}));
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    const page=await context.newPage();
    await page.addInitScript(()=>{
      const listeners={};const fake={height:844,offsetTop:0,pageTop:0,width:390,scale:1,addEventListener(type,callback){(listeners[type]??=[]).push(callback)},emit(type){for(const callback of listeners[type]||[])callback()}};
      Object.defineProperty(globalThis,'visualViewport',{configurable:true,value:fake});globalThis.__traceViewport=fake;
      Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});
      localStorage.setItem('dwell.keyboard-trace-optin.v1','1');localStorage.setItem('dwell.provider','claude_tmux');localStorage.setItem('dwell.active','trace-fixture');localStorage.setItem('dwell.sessions',JSON.stringify([{id:'trace-fixture',provider:'claude_tmux',title:'Fixture',messages:[{role:'user',content:'PRIVATE CHAT FIXTURE SHOULD NOT EXPORT',createdAt:Date.now()}]}]));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#input').focus();
    await page.evaluate(()=>{const vv=globalThis.__traceViewport;vv.height=510;vv.emit('resize');vv.emit('scroll')});
    await page.waitForFunction(()=>!keyboardViewportPending&&document.documentElement.style.getPropertyValue('--vv-bottom')==='510px');
    await page.locator('#input').blur();
    await page.evaluate(()=>{const vv=globalThis.__traceViewport;vv.height=844;vv.emit('resize');globalThis.dispatchEvent(new Event('resize'))});
    await page.waitForFunction(()=>!keyboardViewportPending&&document.documentElement.style.getPropertyValue('--vv-bottom')==='844px');
    const result=await page.evaluate(()=>{
      const observed=[...new Set(keyboardTraceRows.map(row=>row.eventType))];
      for(let i=0;i<310;i++)recordKeyboardTrace('fixture_numeric_only');
      persistKeyboardTrace();
      const rows=JSON.parse(localStorage.getItem('dwell.keyboard-geometry-trace.v1'));
      const fieldNames=['t','eventType','generation','frameSeq','visibility','inputFocused','innerHeight','visualHeight','visualOffsetTop','visualPageTop','vvBottom','appRect','mainRect','messagesRect','footerRect','composerRect','scrollTop','scrollHeight','clientHeight','followingBottom','keyboardOpen','keyboardOpenCandidate','geometryCommitGeneration','scrollCorrectionGeneration','anchorRestore'];
      return {rows,observed,fieldNames,exportVisible:!document.querySelector('#keyboardTraceExportCard').hidden,html:JSON.stringify(rows)};
    });
    assert.equal(result.rows.length,300);
    for(const name of result.fieldNames)assert.ok(Object.hasOwn(result.rows.at(-1),name),name);
    for(const type of ['visualViewport.resize','visualViewport.scroll','window.resize','textarea.focus','textarea.blur','geometry_commit_after'])assert.ok(result.observed.includes(type),type);
    assert.equal(result.html.includes('PRIVATE CHAT FIXTURE'),false);
    assert.equal(result.exportVisible,true);
    await page.evaluate(()=>openUserHub());
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#exportKeyboardTrace').click();
    const download=await downloadPromise;
    const exported=JSON.parse(await readFile(await download.path(),'utf8'));
    assert.equal(exported.version,1);
    assert.equal(exported.rows.length,300);
    assert.equal(JSON.stringify(exported).includes('PRIVATE CHAT FIXTURE'),false);
    await page.reload();
    assert.equal(await page.evaluate(()=>keyboardTraceRows.length),300);
    await context.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});
