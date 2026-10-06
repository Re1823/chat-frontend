import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createDwellServer } from '../server.mjs';

test('assistant bubble appears only for real text or frontend delivery',async()=>{
  const server=createDwellServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    await context.route('**/api/runtimes/claude-tmux/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"state":"connected","runtimeId":"claude-main"}'}));
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    const page=await context.newPage();
    await page.addInitScript(()=>{localStorage.setItem('dwell.provider','claude_tmux');localStorage.setItem('dwell.active','no-placeholder-fixture');localStorage.setItem('dwell.sessions',JSON.stringify([{id:'no-placeholder-fixture',provider:'claude_tmux',title:'Fixture',messages:[]}]))});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(()=>{
      const nativeFetch=globalThis.fetch.bind(globalThis);globalThis.__streams=[];
      globalThis.fetch=(url,options)=>url==='/api/chat'?Promise.resolve(new Response(new ReadableStream({start(controller){globalThis.__streams.push(controller)}}),{status:200,headers:{'content-type':'application/x-ndjson'}})):nativeFetch(url,options);
      globalThis.__emit=(index,event)=>globalThis.__streams[index].enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n'));
    });
    const assistant=page.locator('#messages article.message:not(.user)');
    await page.locator('#input').fill('First message');await page.locator('#send').click();
    await page.waitForFunction(()=>globalThis.__streams.length===1);
    assert.equal(await assistant.count(),0);
    assert.equal(await page.locator('#messages article.message.user').count(),1);
    assert.equal(await page.locator('#messages').getByText('正在想…').count(),0);
    await page.evaluate(()=>__emit(0,{type:'turn_started',turnId:'text-turn'}));
    await page.evaluate(()=>__emit(0,{type:'thought_process',turnId:'text-turn',items:[{id:'thought-1',type:'thinking',text:'private reasoning'}]}));
    await page.waitForTimeout(50);
    assert.equal(await assistant.count(),0);
    assert.equal(await page.locator('#messages').getByText('private reasoning').count(),0);
    await page.evaluate(()=>__emit(0,{type:'segment_delta',turnId:'text-turn',delta:'Hello'}));
    await page.waitForFunction(()=>document.querySelectorAll('#messages article.message:not(.user)').length===1);
    await page.evaluate(()=>globalThis.__firstAssistant=document.querySelector('#messages article.message:not(.user)'));
    await page.evaluate(()=>__emit(0,{type:'segment_delta',turnId:'text-turn',delta:' world'}));
    await page.waitForFunction(()=>document.querySelector('#messages article.message:not(.user) .bubble')?.textContent?.includes('Hello world'));
    assert.equal(await page.evaluate(()=>globalThis.__firstAssistant===document.querySelector('#messages article.message:not(.user)')),true);
    assert.equal(await assistant.count(),1);
    await page.evaluate(()=>__emit(0,{type:'turn_done',turnId:'text-turn'}));
    await page.waitForFunction(()=>!document.querySelector('#messages article.message:not(.user) .bubble')?.classList.contains('thinking'));
    assert.equal(await page.locator('#messages').getByText('正在想…').count(),0);
    await page.locator('#input').fill('Second message');await page.locator('#send').click();
    await page.waitForFunction(()=>globalThis.__streams.length===2);
    assert.equal(await assistant.count(),1,'second send must not create an empty assistant bubble');
    await page.evaluate(()=>__emit(1,{type:'turn_started',turnId:'tool-turn'}));
    await page.evaluate(()=>__emit(1,{type:'assistant_message',turnId:'tool-turn',messageId:'delivery-1',source:'tool',text:'真实前端消息'}));
    await page.waitForFunction(()=>document.querySelectorAll('#messages article.message:not(.user)').length===2);
    assert.equal(await assistant.last().textContent().then(value=>value.includes('真实前端消息')),true);
    await page.evaluate(()=>__emit(1,{type:'turn_done',turnId:'tool-turn'}));
    assert.equal(await page.locator('#messages').getByText('正在想…').count(),0);
    await context.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});
