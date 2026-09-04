import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/app.js',import.meta.url),'utf8');

function sortingContext(mode='recent'){
  const start=js.indexOf('const memoryTime=');
  const end=js.indexOf('function visibleMemoryItems');
  const context=vm.createContext({memoryState:{sortMode:mode},Date,Number});
  vm.runInContext(js.slice(start,end),context);
  return context;
}

test('sidebar calls the first-class destination OmbreBrain',()=>{
  assert.match(html,/id="memoryNav"[^>]*>[\s\S]*?OmbreBrain<\/button>/);
  assert.doesNotMatch(html,/id="memoryNav"[^>]*>[\s\S]*?>记忆<\/button>/);
});

test('OmbreBrain mode hides all three Chat regions and fills the app view',()=>{
  assert.match(css,/main\.memory-mode>header,main\.memory-mode>#messages,main\.memory-mode>footer\{display:none\}/);
  assert.match(css,/main\.memory-mode>\.memory-page\{[^}]*width:100%;height:100%/);
  assert.match(js,/function showMemory\(\)[^{]*\{[^}]*activeAppView='memory'[^}]*classList\.add\('memory-mode'\)[^}]*classList\.remove\('on'\)/);
});

test('default Memory state is All and recent activity',()=>{
  assert.match(js,/activePrimaryFilter:'all'/);
  assert.match(js,/sortMode:'recent'/);
  assert.match(html,/data-filter="all"[^>]*>All/);
  assert.match(html,/<option value="recent">最近活动<\/option>/);
});

test('recent sort uses lastActiveAt descending with createdAt fallback',()=>{
  const context=sortingContext('recent');
  const result=vm.runInContext(`sortMemoryItems([{id:'fallback',createdAt:'2026-03-02'},{id:'older-active',lastActiveAt:'2026-03-01',createdAt:'2026-04-01'},{id:'latest',lastActiveAt:'2026-03-03'}]).map(x=>x.id)`,context);
  assert.deepEqual([...result],['latest','fallback','older-active']);
});

test('created and importance sort modes change order explicitly',()=>{
  const context=sortingContext();
  const items=`[{id:'a',createdAt:'2026-01-01',importance:.9},{id:'b',createdAt:'2026-02-01',importance:.2}]`;
  assert.deepEqual([...vm.runInContext(`sortMemoryItems(${items},'created-desc').map(x=>x.id)`,context)],['b','a']);
  assert.deepEqual([...vm.runInContext(`sortMemoryItems(${items},'created-asc').map(x=>x.id)`,context)],['a','b']);
  assert.deepEqual([...vm.runInContext(`sortMemoryItems(${items},'importance').map(x=>x.id)`,context)],['a','b']);
});

test('filter, sort, search, scroll and selection live in one retained page state',()=>{
  assert.match(js,/const memoryState=\{activePrimaryFilter:'all',secondaryFilters:\{status:'all',domain:'',tag:''\},sortMode:'recent',searchQuery:'',scrollPosition:0,selectedBucketId:''\}/);
  assert.match(js,/searchMemory\(query\)[\s\S]*memoryState\.searchQuery=searchQuery[\s\S]*memorySearchResults=null;renderMemoryList\(\)/);
  assert.doesNotMatch(js,/searchMemory\(query\)[^{]*\{[^}]*activePrimaryFilter\s*=/);
});

test('stale Memory search responses cannot replace the newest query results',async()=>{
  const start=js.indexOf('async function searchMemory');
  const end=js.indexOf('async function runBreathDebug');
  const pending=[];
  const context=vm.createContext({
    encodeURIComponent,
    memoryState:{searchQuery:''},
    memorySearchResults:null,
    memorySearchRequestSequence:0,
    renderMemoryList(){context.rendered=context.memorySearchResults},
    fetch(url){return new Promise(resolve=>pending.push({url,resolve}))},
    $(){return {innerHTML:''}},
    escapeHtml:String
  });
  vm.runInContext(js.slice(start,end),context);
  const older=vm.runInContext("searchMemory('old')",context);
  const newer=vm.runInContext("searchMemory('new')",context);
  pending[1].resolve({ok:true,json:async()=>({items:[{id:'new'}]})});
  await newer;
  pending[0].resolve({ok:true,json:async()=>({items:[{id:'old'}]})});
  await older;
  assert.equal(pending[0].url,'/api/ombre-dashboard/search?q=old');
  assert.deepEqual(context.rendered,[{id:'new'}]);
});

test('clearing Memory search invalidates a request already in flight',async()=>{
  const start=js.indexOf('async function searchMemory');
  const end=js.indexOf('async function runBreathDebug');
  let resolveSearch;
  const context=vm.createContext({
    encodeURIComponent,
    memoryState:{searchQuery:''},
    memorySearchResults:null,
    memorySearchRequestSequence:0,
    renderMemoryList(){context.rendered=context.memorySearchResults},
    fetch(){return new Promise(resolve=>{resolveSearch=resolve})},
    $(){return {innerHTML:''}},
    escapeHtml:String
  });
  vm.runInContext(js.slice(start,end),context);
  const inFlight=vm.runInContext("searchMemory('old')",context);
  await vm.runInContext("searchMemory('')",context);
  resolveSearch({ok:true,json:async()=>({items:[{id:'old'}]})});
  await inFlight;
  assert.equal(context.memoryState.searchQuery,'');
  assert.equal(context.rendered,null);
});

test('whole cards are 44px touch buttons and open detail from the card',()=>{
  assert.match(js,/<button type="button" class="memory-card" data-memory-id=/);
  assert.match(js,/card\.onclick=\(\)=>openMemoryDetail\(card\.dataset\.memoryId\)/);
  assert.match(css,/\.memory-card\{[^}]*min-height:44px[^}]*touch-action:manipulation/);
});

test('detail is full visual-viewport height and closing does not reset list state',()=>{
  assert.match(css,/\.memory-detail\{[^}]*top:var\(--vv-offset-top[^}]*height:var\(--vv-height/);
  assert.match(js,/function closeMemoryDetail\(\)\{memoryState\.selectedBucketId='';closeSheets\(\)\}/);
  assert.doesNotMatch(js,/function closeMemoryDetail\(\)[^{]*\{[^}]*renderMemoryList/);
});

test('Memory keyboard geometry shares visualViewport sync and survives close',()=>{
  assert.match(js,/function syncVisualViewport\(\)[\s\S]*--vv-height[\s\S]*--vv-offset-top[\s\S]*--vv-bottom/);
  assert.match(js,/memorySearch'\)\.onfocus=\$\('#memorySearch'\)\.onblur=scheduleVisualViewportSync/);
  assert.match(css,/main\.memory-mode\{[^}]*padding-top:var\(--vv-offset-top/);
  assert.match(css,/memory-page\{height:calc\(var\(--vv-bottom[^}]*var\(--vv-offset-top/);
});

test('Memory mobile layout prevents horizontal overflow and form zoom',()=>{
  assert.match(css,/\.memory-body\{[^}]*overflow-y:auto;overflow-x:hidden/);
  assert.match(css,/\.memory-filters\{[^}]*overflow-x:auto/);
  assert.match(css,/\.memory-search input\{font-size:16px\}/);
  assert.match(css,/\.breath-lab input,.memory-filter-form select\{font-size:16px\}/);
});
