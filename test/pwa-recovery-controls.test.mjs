import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createDwellServer} from '../server.mjs';

test('390px recovery buttons are full width and a touch reaches the unlock handler without a write',async()=>{
  const server=createDwellServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    await context.route('**/api/runtimes/claude-tmux/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"state":"connected","runtimeId":"fixture"}'}));
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(()=>openUserHub());
    await page.locator('#toggleLocalRecoveryDiagnostic').click();
    const layout=await page.evaluate(()=>{
      const box=document.querySelector('#chatRecoveryControls'),ids=['chatRecoveryInspect','chatUnlockApply','chatRecoveryApply'];
      return {present:!!box,buttons:ids.map(id=>{const button=document.getElementById(id),style=getComputedStyle(button),rect=button.getBoundingClientRect();return {id,handler:typeof button.onclick,width:rect.width,parentWidth:box.getBoundingClientRect().width,height:rect.height,display:style.display,whiteSpace:style.whiteSpace,disabled:button.disabled}})};
    });
    assert.equal(layout.present,true);
    for(const button of layout.buttons){
      assert.equal(button.handler,'function',button.id);
      assert.ok(button.width>250&&Math.abs(button.width-(button.parentWidth-36))<2,JSON.stringify(button));
      assert.ok(button.height>=44,JSON.stringify(button));
      assert.equal(button.display,'block');assert.equal(button.whiteSpace,'normal');
      assert.equal(button.disabled,false);
    }
    await page.evaluate(()=>{const original=indexedDB.open.bind(indexedDB);window.__recoveryIdbOpens=0;indexedDB.open=(...args)=>{window.__recoveryIdbOpens++;return original(...args)}});
    const button=page.locator('#chatUnlockApply');await button.scrollIntoViewIfNeeded();
    const rect=await button.boundingBox();await page.touchscreen.tap(rect.x+rect.width/2,rect.y+rect.height/2);
    await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('dwell.chat-recovery-ui-events.v1')||'[]').some(item=>item.action==='unlock'&&item.stage==='error'));
    const result=await page.evaluate(()=>({events:JSON.parse(sessionStorage.getItem('dwell.chat-recovery-ui-events.v1')||'[]').filter(item=>item.action==='unlock').map(item=>item.stage),status:document.querySelector('#chatRecoveryStatus').textContent,idbOpens:window.__recoveryIdbOpens,overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.deepEqual(result.events,['click','start','error']);
    assert.match(result.status,/backup_not_confirmed/);
    assert.equal(result.idbOpens,0);
    assert.equal(result.overflow,false);
    assert.deepEqual(errors,[]);
    await context.close();
  }finally{await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}
});
