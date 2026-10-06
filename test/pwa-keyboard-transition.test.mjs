import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createDwellServer } from '../server.mjs';

test('keyboard transition commits one stable bottom geometry without obscuring the latest bubble',async()=>{
  const server=createDwellServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    await context.route('**/api/runtimes/claude-tmux/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"state":"connected","runtimeId":"claude-main"}'}));
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    const page=await context.newPage();
    await page.addInitScript(()=>{
      const listeners={};const fake={height:844,offsetTop:0,width:390,scale:1,addEventListener(type,callback){(listeners[type]??=[]).push(callback)},emit(type){for(const callback of listeners[type]||[])callback()}};
      Object.defineProperty(globalThis,'visualViewport',{configurable:true,value:fake});globalThis.__transitionViewport=fake;
      localStorage.setItem('dwell.provider','claude_tmux');localStorage.setItem('dwell.active','transition-fixture');localStorage.setItem('dwell.sessions',JSON.stringify([{id:'transition-fixture',provider:'claude_tmux',title:'Fixture',messages:Array.from({length:32},(_,i)=>({role:i%2?'assistant':'user',content:`Message ${i} ${'text '.repeat(12)}`,createdAt:Date.now()-32000+i*1000}))}]));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(()=>{
      const style=document.createElement('style');style.textContent='main:not(.memory-mode)>footer{padding-bottom:48px}.keyboard-open main:not(.memory-mode)>footer{padding-bottom:8px}';document.head.append(style);
      const box=document.querySelector('#messages');box.scrollTop=box.scrollHeight;setViewportBottomAnchor(true);
      globalThis.__transitionTrace=[];const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
      Object.defineProperty(box,'scrollTop',{configurable:true,get(){return descriptor.get.call(this)},set(value){const before=descriptor.get.call(this),stack=new Error().stack||'';descriptor.set.call(this,value);const after=descriptor.get.call(this);globalThis.__transitionTrace.push({kind:'write',source:stack.includes('scrollMessagesToBottom')?'bottom':stack.includes('restoreTimelineScroll')?'restore':'other',before,after})}});
      box.addEventListener('scroll',()=>globalThis.__transitionTrace.push({kind:'scroll',source:'browser_event',top:box.scrollTop}),{passive:true});
    });
    const transition=async(height,{duplicateEvents=false}={})=>{
      await page.evaluate(value=>{const vv=globalThis.__transitionViewport;vv.height=value;vv.emit('resize')},height);
      if(duplicateEvents)await page.evaluate(()=>{const vv=globalThis.__transitionViewport;for(let i=0;i<8;i++)setTimeout(()=>vv.emit('scroll'),i*15)});
      await page.waitForFunction(()=>!keyboardViewportPending,{timeout:2500});
      await page.waitForTimeout(60);
      return page.evaluate(()=>{
        const rect=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};
        const box=document.querySelector('#messages'),footer=document.querySelector('main>footer'),composer=document.querySelector('.composer'),last=box.querySelector('article.message:last-of-type'),main=document.querySelector('main');
        return {vv:{height:visualViewport.height,offsetTop:visualViewport.offsetTop},cssBottom:getComputedStyle(document.documentElement).getPropertyValue('--vv-bottom'),composerHeightVar:getComputedStyle(document.documentElement).getPropertyValue('--composer-h'),paddingBottom:getComputedStyle(box).paddingBottom,main:rect(main),messages:rect(box),footer:rect(footer),composer:rect(composer),last:rect(last),scrollTop:box.scrollTop,scrollHeight:box.scrollHeight,followingBottom:keepBottomThroughViewportResize,gap:composer.getBoundingClientRect().top-last.getBoundingClientRect().bottom,trace:globalThis.__transitionTrace.splice(0)};
      });
    };
    const closed=await transition(844);
    await page.locator('#input').focus();
    const open=await transition(510,{duplicateEvents:true});
    await page.locator('#input').blur();
    const closedAgain=await transition(844);
    if(process.env.QIUQIU_KEYBOARD_TRACE==='1')process.stdout.write(JSON.stringify({closed,open,closedAgain})+'\n');
    const assertCommitted=(state,expectedHeight)=>{
      assert.equal(state.cssBottom.trim(),`${expectedHeight}px`,JSON.stringify(state));
      assert.equal(Number.parseInt(state.composerHeightVar,10),state.footer.height,JSON.stringify(state));
      assert.equal(Number.parseInt(state.paddingBottom,10),state.footer.height+24,JSON.stringify(state));
      assert.ok(Math.abs(state.gap-32)<=1,JSON.stringify(state));
      assert.equal(state.scrollTop,state.scrollHeight-state.messages.height,JSON.stringify(state));
      assert.ok(state.trace.filter(item=>item.kind==='write'&&item.after!==item.before).length<=1,JSON.stringify(state));
    };
    assertCommitted(open,510);
    assertCommitted(closedAgain,844);
    for(let i=0;i<3;i++){
      await page.locator('#input').focus();assertCommitted(await transition(510),510);
      await page.locator('#input').blur();assertCommitted(await transition(844),844);
    }
    await page.evaluate(()=>{const box=document.querySelector('#messages');box.scrollTop-=400;cancelViewportBottomAnchor();globalThis.__transitionTrace.length=0});
    const detachedBefore=await page.locator('#messages article.message').nth(20).evaluate(node=>node.getBoundingClientRect().top);
    await page.locator('#input').focus();const detachedOpen=await transition(510);
    const detachedAfter=await page.locator('#messages article.message').nth(20).evaluate(node=>node.getBoundingClientRect().top);
    assert.equal(detachedOpen.followingBottom,false);
    assert.ok(Math.abs(detachedAfter-detachedBefore)<=1,JSON.stringify({detachedBefore,detachedAfter,detachedOpen}));
    assert.equal(detachedOpen.trace.filter(item=>item.kind==='write'&&item.source==='bottom').length,0,JSON.stringify(detachedOpen));
    await context.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});

test('single real-iPhone viewport change commits matching inner geometry before the next frame',async()=>{
  const server=createDwellServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:894},screen:{width:390,height:894},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    await context.route('**/api/runtimes/claude-tmux/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"state":"connected","runtimeId":"claude-main"}'}));
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    const page=await context.newPage();
    await page.addInitScript(()=>{
      const listeners={};const fake={height:894,offsetTop:0,width:390,scale:1,addEventListener(type,callback){(listeners[type]??=[]).push(callback)},emit(type){for(const callback of listeners[type]||[])callback()}};
      Object.defineProperty(globalThis,'visualViewport',{configurable:true,value:fake});globalThis.__iphoneViewport=fake;
      localStorage.setItem('dwell.keyboard-trace-optin.v1','1');
      localStorage.setItem('dwell.provider','claude_tmux');localStorage.setItem('dwell.active','iphone-fixture');localStorage.setItem('dwell.sessions',JSON.stringify([{id:'iphone-fixture',provider:'claude_tmux',title:'Fixture',messages:Array.from({length:32},(_,i)=>({role:i%2?'assistant':'user',content:`Message ${i} ${'text '.repeat(12)}`,createdAt:Date.now()-32000+i*1000}))}]));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#input').focus();
    await page.waitForFunction(()=>!keyboardViewportPending);
    await page.evaluate(()=>{const box=document.querySelector('#messages');box.scrollTop=box.scrollHeight;setViewportBottomAnchor(true)});
    const change=async(height,offsetTop)=>page.evaluate(({height,offsetTop})=>{
      const box=document.querySelector('#messages'),composer=document.querySelector('.composer'),root=document.documentElement;
      const staleMessageReads=[];const original=Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect=function(...args){if(this===box&&height===894&&root.style.getPropertyValue('--vv-offset-top')==='414px')staleMessageReads.push(true);return original.apply(this,args)};
      const vv=globalThis.__iphoneViewport;vv.height=height;vv.offsetTop=offsetTop;try{vv.emit('resize')}finally{Element.prototype.getBoundingClientRect=original}
      const messages=box.getBoundingClientRect(),composerRect=composer.getBoundingClientRect();
      return {generation:keyboardViewportRevision,height:messages.height,top:messages.top,bottom:messages.bottom,appHeight:document.querySelector('.app').getBoundingClientRect().height,composerTop:composerRect.top,composerBottom:composerRect.bottom,composerHeight:composerRect.height,vvHeight:root.style.getPropertyValue('--vv-height'),vvOffset:root.style.getPropertyValue('--vv-offset-top'),pending:keyboardViewportPending,scrollTop:box.scrollTop,scrollHeight:box.scrollHeight,clientHeight:box.clientHeight,staleMessageReads:staleMessageReads.length};
    },{height,offsetTop});
    const open=await change(480,414);
    assert.equal(open.vvHeight,'480px');assert.equal(open.vvOffset,'414px');assert.equal(open.height,480,JSON.stringify(open));assert.equal(open.top,414,JSON.stringify(open));
    assert.equal(open.composerHeight,102,JSON.stringify(open));
    assert.equal(open.pending,true);
    await page.waitForFunction(()=>!keyboardViewportPending);
    const close=await change(894,0);
    assert.equal(close.vvHeight,'894px');assert.equal(close.vvOffset,'0px');assert.equal(close.appHeight,894,JSON.stringify(close));assert.equal(close.height,894,JSON.stringify(close));assert.equal(close.top,0,JSON.stringify(close));assert.equal(close.bottom,894,JSON.stringify(close));
    assert.equal(close.composerHeight,102,JSON.stringify(close));
    assert.equal(close.staleMessageReads,0,JSON.stringify(close));
    assert.equal(close.pending,true);
    await page.waitForFunction(()=>!keyboardViewportPending);
    const closeEvents=await page.evaluate(generation=>keyboardTraceRows.filter(row=>row.generation===generation).map(row=>({eventType:row.eventType,anchorRestore:row.anchorRestore})),close.generation);
    assert.ok(closeEvents.filter(row=>row.eventType==='scroll_correction_after').length<=1,JSON.stringify(closeEvents));
    assert.equal(closeEvents.some(row=>row.anchorRestore),false,JSON.stringify(closeEvents));
    await context.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});
