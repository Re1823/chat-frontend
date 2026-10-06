import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createDwellServer } from '../server.mjs';

test('keyboard geometry stays pinned through first Send and preserves bottom intent',async()=>{
  const server=createDwellServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    let calls=0;
    await context.route('**/api/runtimes/claude-tmux/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"state":"connected","runtimeId":"claude-main"}'}));
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    await context.route('**/api/chat',route=>{calls++;return route.fulfill({status:200,contentType:'application/x-ndjson',body:'{"type":"turn_done"}\n'})});
    const page=await context.newPage();
    await page.addInitScript(()=>{localStorage.setItem('dwell.provider','claude_tmux');localStorage.setItem('dwell.active','keyboard-fixture');localStorage.setItem('dwell.sessions',JSON.stringify([{id:'keyboard-fixture',provider:'claude_tmux',title:'Fixture',messages:Array.from({length:30},(_,i)=>({role:i%2?'assistant':'user',content:`Earlier ${i} ${'text '.repeat(20)}`,createdAt:Date.now()-30000+i*1000}))}]))});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#input').fill('keyboard first tap');
    const before=await page.evaluate(()=>{
      const fake={height:510,offsetTop:0,width:390,scale:1,addEventListener(){}};
      Object.defineProperty(globalThis,'visualViewport',{configurable:true,value:fake});globalThis.__keyboardViewport=fake;
      syncVisualViewport();const box=document.querySelector('#messages');box.scrollTop=box.scrollHeight;setViewportBottomAnchor(true);
      const button=document.querySelector('#send'),r=button.getBoundingClientRect();
      button.addEventListener('pointerdown',event=>{const first=button.getBoundingClientRect();fake.height=480;scheduleVisualViewportSync();const second=button.getBoundingClientRect();globalThis.__pointerCheck={focused:document.activeElement===document.querySelector('#input'),prevented:event.defaultPrevented,shift:Math.abs(first.top-second.top)+Math.abs(first.left-second.left)}},{once:true});
      return {x:r.left+r.width/2,y:r.top+r.height/2,gap:510-document.querySelector('.composer').getBoundingClientRect().bottom,appBottom:document.querySelector('.app').getBoundingClientRect().bottom,following:keepBottomThroughViewportResize};
    });
    assert.ok(before.gap>=0&&before.gap<=18,JSON.stringify(before));
    assert.ok(Math.abs(before.appBottom-510)<2,JSON.stringify(before));
    assert.equal(before.following,true);
    await page.touchscreen.tap(before.x,before.y);
    await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('dwell.chat-send-diagnostics.v1')||'[]').flatMap(record=>record.events).some(event=>event.event==='fetch_call'));
    await page.waitForFunction(()=>!keyboardViewportPending&&Math.abs(document.querySelector('.app').getBoundingClientRect().bottom-480)<2);
    const after=await page.evaluate(()=>{
      const box=document.querySelector('#messages'),composer=document.querySelector('.composer'),vv=globalThis.__keyboardViewport;
      const events=JSON.parse(sessionStorage.getItem('dwell.chat-send-diagnostics.v1')||'[]').flatMap(record=>record.events.map(item=>item.event));
      const state={pointer:globalThis.__pointerCheck,input:document.querySelector('#input').value,focused:document.activeElement===document.querySelector('#input'),gap:vv.height-composer.getBoundingClientRect().bottom,following:keepBottomThroughViewportResize,bottomGap:box.scrollHeight-box.scrollTop-box.clientHeight,events,overflow:document.documentElement.scrollWidth>innerWidth};
      box.dispatchEvent(new Event('touchmove'));box.scrollTop=0;vv.height=500;scheduleVisualViewportSync();state.detached=keepBottomThroughViewportResize;return state;
    });
    assert.equal(calls,1);assert.equal(after.input,'');assert.equal(after.pointer.focused,true);assert.equal(after.pointer.prevented,true);assert.ok(after.pointer.shift<1,JSON.stringify(after.pointer));
    assert.equal(after.events.filter(event=>event==='send_attempt').length,1);assert.equal(after.events.filter(event=>event==='fetch_call').length,1);
    assert.equal(after.focused,true);assert.ok(after.gap>=0&&after.gap<=18,JSON.stringify(after));assert.equal(after.following,true);assert.ok(after.bottomGap<3,JSON.stringify(after));assert.equal(after.detached,false);assert.equal(after.overflow,false);
    await page.waitForFunction(()=>!keyboardViewportPending);
    assert.equal(await page.evaluate(()=>keepBottomThroughViewportResize),false,'keyboard resize must not reattach detached history');
    await page.waitForTimeout(300);
    await page.evaluate(()=>{const box=document.querySelector('#messages');box.scrollTop=box.scrollHeight-box.clientHeight-80;globalThis.__keyboardViewport.height=490;scheduleVisualViewportSync();box.dispatchEvent(new Event('scroll'))});
    assert.equal(await page.evaluate(()=>keepBottomThroughViewportResize),false,'viewport changes near the end are not user scroll intent');
    await page.evaluate(()=>{const box=document.querySelector('#messages');box.dispatchEvent(new Event('touchmove'));box.scrollTop=box.scrollHeight;box.dispatchEvent(new Event('scroll'))});
    assert.equal(await page.evaluate(()=>keepBottomThroughViewportResize),true);
    await context.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});
