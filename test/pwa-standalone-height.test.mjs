import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createDwellServer } from '../server.mjs';

test('restored fixed shell survives cold launch, first keyboard cycle, background and reload',async()=>{
  const server=createDwellServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    let sends=0;
    await context.route('**/api/runtimes/claude-tmux/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"state":"connected","runtimeId":"claude-main"}'}));
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    await context.route('**/api/chat',route=>{sends++;return route.fulfill({status:200,contentType:'application/x-ndjson',body:'{"type":"turn_done"}\n'})});
    const page=await context.newPage();
    await page.addInitScript(()=>{
      localStorage.setItem('dwell.provider','claude_tmux');localStorage.setItem('dwell.active','height-fixture');localStorage.setItem('dwell.sessions',JSON.stringify([{id:'height-fixture',provider:'claude_tmux',title:'Fixture',messages:[]}]));
      const fake={height:844,offsetTop:0,width:390,scale:1,addEventListener(){}};
      Object.defineProperty(globalThis,'visualViewport',{configurable:true,value:fake});globalThis.__heightFixtureViewport=fake;
    });
    const url=`http://127.0.0.1:${server.address().port}/`;
    const geometry=()=>page.evaluate(()=>{
      const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom}};
      return {app:rect('.app'),main:rect('.app>main'),composer:rect('.composer'),position:getComputedStyle(document.querySelector('.app')).position,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    await page.goto(url);
    let state=await geometry();
    assert.equal(state.position,'fixed');
    assert.ok(Math.abs(state.app.bottom-844)<2,JSON.stringify(state));
    assert.ok(Math.abs(state.main.bottom-844)<2,JSON.stringify(state));
    for(let i=0;i<3;i++){
      await page.locator('#input').focus();
      await page.evaluate(()=>{globalThis.__heightFixtureViewport.height=510;syncVisualViewport()});
      state=await geometry();
      assert.ok(Math.abs(state.app.bottom-510)<2,JSON.stringify(state));
      assert.ok(state.composer.bottom<=510&&510-state.composer.bottom<=18,JSON.stringify(state));
      if(i===0){
        await page.locator('#input').fill('one tap after cold launch');
        const send=await page.locator('#send').boundingBox();
        await page.touchscreen.tap(send.x+send.width/2,send.y+send.height/2);
        await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('dwell.chat-send-diagnostics.v1')||'[]').flatMap(record=>record.events).some(event=>event.event==='fetch_call'));
        assert.equal(sends,1);
        assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#input')),true);
        assert.equal(await page.evaluate(()=>{const box=document.querySelector('#messages');return box.scrollHeight-box.scrollTop-box.clientHeight<3}),true);
      }
      await page.locator('#input').blur();
      await page.evaluate(()=>{globalThis.__heightFixtureViewport.height=844;syncVisualViewport()});
      state=await geometry();
      assert.ok(Math.abs(state.app.bottom-844)<2,JSON.stringify(state));
      assert.ok(Math.abs(state.main.bottom-844)<2,JSON.stringify(state));
      assert.equal(state.overflow,false);
    }
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    state=await geometry();assert.ok(Math.abs(state.app.bottom-844)<2,JSON.stringify(state));
    await page.reload();
    state=await geometry();assert.equal(state.position,'fixed');assert.ok(Math.abs(state.app.bottom-844)<2,JSON.stringify(state));
    await context.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});
