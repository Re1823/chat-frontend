import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createDwellServer } from '../server.mjs';

test('one timeline owner follows streaming but preserves detached reading and overlays',async()=>{
  const server=createDwellServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    await context.route('**/api/runtimes/claude-tmux/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"state":"connected","runtimeId":"claude-main"}'}));
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    const page=await context.newPage();
    await page.addInitScript(()=>{const messages=Array.from({length:24},(_,i)=>({role:i%2?'assistant':'user',content:`History ${i} ${'long text '.repeat(20)}`,createdAt:Date.now()-100000+i*1000}));messages.push({role:'assistant',turnId:'thought-fixture',content:'A thought',thoughtProcess:{items:[{type:'tool_call',displayName:'fixture'}]},createdAt:Date.now()-1000});localStorage.setItem('dwell.provider','claude_tmux');localStorage.setItem('dwell.active','scroll-fixture');localStorage.setItem('dwell.sessions',JSON.stringify([{id:'scroll-fixture',provider:'claude_tmux',title:'Fixture',messages}]))});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result=await page.evaluate(async()=>{
      const box=document.querySelector('#messages');box.style.scrollBehavior='auto';box.scrollTop=box.scrollHeight;setViewportBottomAnchor(true);
      const out={role:'assistant',turnId:'stream-fixture',content:'initial',pending:true,createdAt:Date.now()};current().messages.push(out);renderMessages(false);
      const root=box.querySelector(`[data-message-view="${messageViewKey(out)}"]`),text=root.querySelector('[data-stream-text]');
      let writes=0;const observer=new MutationObserver(()=>writes++);observer.observe(text,{childList:true,characterData:true,subtree:true});
      const view=createStreamingView(out,true);
      for(let i=0;i<120;i++){out.content+='delta ';view.update({type:'segment_delta',delta:'delta '})}
      for(let i=0;i<20&&keyboardViewportPending;i++)await new Promise(resolve=>setTimeout(resolve,50));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));observer.disconnect();
      const stable=root===box.querySelector(`[data-message-view="${messageViewKey(out)}"]`),followGap=box.scrollHeight-box.scrollTop-box.clientHeight,pending=keyboardViewportPending,following=keepBottomThroughViewportResize;
      box.dispatchEvent(new Event('touchmove'));box.scrollTop=0;await new Promise(resolve=>setTimeout(resolve,20));
      for(let i=0;i<20;i++){out.content+='more ';view.update({type:'segment_delta',delta:'more '})}
      await new Promise(resolve=>setTimeout(resolve,50));const detachedTop=box.scrollTop;
      const thought=document.querySelector('.thought-cloud');openThoughtProcess('thought-fixture',thought);const afterThoughtOpen=box.scrollTop;closeThoughtProcess();await new Promise(resolve=>setTimeout(resolve,300));const afterThoughtClose=box.scrollTop;
      preserveTimelineScroll(()=>{out.albumEvents=[{type:'album_saved',photo:{photoId:'photo_'+ 'a'.repeat(32),albumName:'你',note:'caption',savedBy:'assistant'}}];renderMessages(false)});
      const afterCard=box.scrollTop,cardHeight=box.querySelector('.album-save-card')?.getBoundingClientRect().height;
      const photo={role:'user',content:'',images:[{imageId:'img_'+ 'a'.repeat(43),width:1200,height:800,mime:'image/jpeg'}],createdAt:Date.now()-10};
      current().messages.splice(-1,0,photo);renderMessages(false);
      const image=box.querySelector(`[data-message-view="${messageViewKey(photo)}"] img`),reservedHeight=image.getBoundingClientRect().height,reservedWidth=image.getBoundingClientRect().width;
      await new Promise(resolve=>setTimeout(resolve,150));image.dispatchEvent(new Event('load'));
      const afterImageLoad=box.scrollTop;
      view.finish();
      return {stable,writes,followGap,pending,following,detachedTop,afterThoughtOpen,afterThoughtClose,afterCard,afterImageLoad,reservedHeight,reservedWidth,cardHeight,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.equal(result.stable,true);
    assert.ok(result.writes<=2,`120 deltas caused ${result.writes} text mutations`);
    assert.ok(result.followGap<3,`follow gap ${result.followGap}; pending=${result.pending}; following=${result.following}`);
    assert.ok(result.detachedTop<3);
    assert.ok(Math.abs(result.afterThoughtOpen-result.detachedTop)<3);
    assert.ok(Math.abs(result.afterThoughtClose-result.detachedTop)<3);
    assert.ok(Math.abs(result.afterCard-result.detachedTop)<3);
    assert.ok(result.reservedHeight>100,JSON.stringify(result));
    assert.ok(Math.abs(result.afterImageLoad-result.detachedTop)<3);
    assert.ok(result.cardHeight<=78);
    assert.equal(result.overflow,false);
    await context.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});
