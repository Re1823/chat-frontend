import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {openNonStore} from '../src/non/store.mjs';
import {createDesireCore} from '../src/non/desire-engine.mjs';
import {createDesireDashboard,onWhitelistMention} from '../src/non/desire-dashboard.mjs';
import {createDwellServer} from '../server.mjs';

const at=Date.UTC(2026,9,7,8);
const text='只在自己的念头池里打转的文字';
async function fixture(run) {
  const dir=await mkdtemp(join(tmpdir(),'non-desire-ui-'));
  const path=join(dir,'non.sqlite');
  try {
    const store=await openNonStore({path,now:()=>at});
    const core=createDesireCore({store,now:()=>at});
    const {state}=core.initialize(at);
    store.saveDesire({...state,values:{...state.values,touch:.76},pick:{winner:'touch',pickedAt:at,until:at+300000}},[
      {id:'flit-1',text:'一瞬间的好奇',dimension:'curiosity',strength:.6,stage:'flit',fedCount:0,source:'test',bornAt:at,updatedAt:at,ageTicks:0},
      {id:'fix-1',text,dimension:'touch',strength:.8,stage:'fixation',fedCount:0,source:'test',bornAt:at+1,updatedAt:at+1,ageTicks:1}
    ]);
    store.close();
    await run({path});
  } finally {await rm(dir,{recursive:true,force:true});}
}

test('dashboard reads persisted winner, 14 values and thought order without advancing state',async()=>fixture(async({path})=>{
  const dashboard=createDesireDashboard({path,now:()=>at+3600000});
  const before=await dashboard.snapshot();
  assert.equal(before.available,true);
  assert.equal(Object.keys(before.snapshot.values).length,14);
  assert.equal(before.snapshot.winner,'touch');
  assert.match(before.snapshot.subjectiveVoice,/想/);
  assert.equal(before.snapshot.lastUpdatedAt,at);
  assert.deepEqual(before.thoughts.map(item=>item.stage),['flit','fixation']);
  assert.equal(before.thoughts[1].text,text);
  assert.equal(before.recallEnabled,false);
  assert.equal((await dashboard.snapshot()).snapshot.lastUpdatedAt,at);
  assert.deepEqual(onWhitelistMention('小柴',{}),{status:'skipped',reason:'recall_disabled'});
}));

test('an absent desire database stays absent and produces no invented Mind state',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'non-desire-absent-'));
  const path=join(dir,'missing.sqlite');
  try {
    assert.deepEqual(await createDesireDashboard({path}).snapshot(),{available:false,snapshot:null,thoughts:[],whitelist:[],recallEnabled:false});
    assert.equal(existsSync(path),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('whitelist add/list/remove is normalized, deduplicated and persistent',async()=>fixture(async({path})=>{
  const dashboard=createDesireDashboard({path,now:()=>at});
  assert.deepEqual(await dashboard.addTerm('  Ｃｈａｉ  '),{added:true,terms:['Chai']});
  assert.deepEqual(await dashboard.addTerm('chai'),{added:false,terms:['Chai']});
  assert.deepEqual((await createDesireDashboard({path}).snapshot()).whitelist,['Chai']);
  assert.deepEqual(await dashboard.removeTerm('  CHAI  '),{removed:true,terms:[]});
  await assert.rejects(()=>dashboard.addTerm('x'.repeat(41)),RangeError);
}));

test('narrow HTTP endpoints reject cross-origin writes and do not expose a generic database API',async()=>fixture(async({path})=>{
  const server=createDwellServer({nonDesireDashboard:createDesireDashboard({path,now:()=>at})});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const read=await (await fetch(`${base}/api/non-desire/snapshot`)).json();
    assert.equal(read.snapshot.winner,'touch');
    const bad=await fetch(`${base}/api/non-desire/whitelist`,{method:'POST',headers:{origin:'https://other.example','content-type':'application/json'},body:JSON.stringify({term:'小柴'})});
    assert.equal(bad.status,403);
    const good=await fetch(`${base}/api/non-desire/whitelist`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({term:'小柴'})});
    assert.equal(good.status,200);
    assert.deepEqual((await good.json()).terms,['小柴']);
    const removal=await fetch(`${base}/api/non-desire/whitelist`,{method:'DELETE',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({term:'小柴'})});
    assert.deepEqual((await removal.json()).terms,[]);
    assert.equal((await fetch(`${base}/api/non-desire/arbitrary-sql`)).status,405);
  } finally {server.close();await once(server,'close');}
}));

test('390px Mind and Memory views preserve OB controls, thoughts and safe navigation',async()=>fixture(async({path})=>{
  const server=createDwellServer({nonDesireDashboard:createDesireDashboard({path,now:()=>at})});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const context=await browser.newContext({viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    await context.route('**/api/shopping/approvals',route=>route.fulfill({status:200,contentType:'application/json',body:'{"purchases":[]}'}));
    await context.route('**/api/ombre-dashboard/**',route=>route.fulfill({status:200,contentType:'application/json',body:route.request().url().endsWith('/status')?'{"connected":true,"version":"2.11.0","total":0}':'{"items":[]}'}));
    const page=await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#menuBtn').click();await page.locator('#memoryNav').click();
    await page.locator('#desireWinner .desire-winner-voice').waitFor();
    assert.equal(await page.locator('#desirePage').isVisible(),true);
    assert.equal(await page.locator('#memoryPage').isVisible(),false);
    assert.equal(await page.locator('#desireDrives .desire-drive-row').count(),14);
    assert.equal(await page.locator('#desireWinner .desire-winner-label').textContent(),'触碰');
    assert.equal(await page.locator('#desireThoughts .desire-flit').count(),1);
    assert.equal(await page.locator('#desireThoughts .desire-fixation').count(),1);
    assert.equal(await page.locator('#desireThoughts').getByText(text).count(),1);
    assert.equal(await page.locator('#desirePage').getByText('此刻地表').count(),0);
    assert.equal(await page.locator('#desirePage').getByText('0.76').count(),0);
    assert.equal(await page.locator('#desirePage').evaluate(element=>/\b(?:touch|joy|possess|monitor)\b/.test(element.innerText)),false);
    if(process.env.NON_DESIRE_SCREENSHOT){await page.waitForTimeout(300);await page.screenshot({path:process.env.NON_DESIRE_SCREENSHOT});}
    const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,nav:document.querySelector('#mindBottomNav').getBoundingClientRect().bottom,height:innerHeight}));
    assert.ok(geometry.width<=geometry.viewport,JSON.stringify(geometry));
    assert.ok(geometry.nav<=geometry.height+1,JSON.stringify(geometry));
    await page.locator('#desireMore').click();
    assert.equal(await page.locator('#whitelistSheet').isVisible(),true);
    const sheetGeometry=await page.locator('#whitelistSheet').evaluate(element=>({top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,viewport:innerHeight}));
    assert.ok(sheetGeometry.top>=0 && sheetGeometry.bottom<=sheetGeometry.viewport+1,JSON.stringify(sheetGeometry));
    await page.locator('#whitelistInput').fill('小柴');await page.locator('#whitelistForm button').click();
    await page.locator('.whitelist-chip').waitFor();
    await page.locator('#closeWhitelist').click();
    await page.locator('#mindMemoryTab').click();
    assert.equal(await page.locator('#memoryPage').isVisible(),true);
    for(const selector of ['#memoryStatus','#memoryCount','#memorySearch','#memoryFilters','#memorySort','.breath-lab','#memoryList'])assert.equal(await page.locator(selector).count(),1);
    await page.locator('#mindStrataTab').click();
    assert.equal(await page.locator('#desirePage').isVisible(),true);
    assert.equal(await page.locator('.whitelist-chip').count(),1);
    await page.locator('#desireMore').click();await page.locator('.whitelist-chip button').click();
    await page.waitForFunction(()=>document.querySelectorAll('.whitelist-chip').length===0);
    const empty=await (await fetch(`http://127.0.0.1:${server.address().port}/api/non-desire/snapshot`)).json();
    await page.route('**/api/non-desire/snapshot',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...empty,thoughts:[]})}));
    await page.evaluate(()=>globalThis.NonDesireUI.load());
    assert.equal(await page.locator('#desireThoughts').getByText('现在没有反复打转的念头。').count(),1);
    await context.close();
  } finally {await browser.close();server.close();await once(server,'close');}
}));

test('desire frontend has no Claude request or prompt path',async()=>{
  const ui=await readFile(new URL('../public/desire-ui.js',import.meta.url),'utf8');
  const server=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(ui,/\/api\/chat|\/api\/turn|Claude|prompt|obre-dashboard/i);
  const route=server.slice(server.indexOf("pathname.startsWith('/api/non-desire/')"),server.indexOf('if(ombreRoutes&&'));
  assert.doesNotMatch(route,/claudeRuntime|internalPromptFor|turnQueue|ombreService/);
});
