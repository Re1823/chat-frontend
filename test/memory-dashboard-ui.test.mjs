import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/app.js',import.meta.url),'utf8');

test('Memory Dashboard has the mobile baseline, filters, search, cards, and detail sheet',()=>{
  for(const text of ['All','Dynamic','Permanent','Archived','Pinned','memorySearch','memoryList','memoryDetail'])assert.match(html,new RegExp(text));
  assert.match(css,/\.memory-list\{[^}]*grid-template-columns/);
  assert.match(css,/@media\(max-width:760px\)[\s\S]*\.memory-list\{grid-template-columns:1fr\}/);
});

test('Memory search waits 300ms instead of requesting on every keystroke',()=>{
  assert.match(js,/memorySearchTimer=setTimeout\(\(\)=>searchMemory\(event\.target\.value\),300\)/);
});

test('list and status load concurrently and detail opens optimistically before fetch',()=>{
  assert.match(js,/Promise\.allSettled\(\[fetch\('\/api\/ombre-dashboard\/status'\)[\s\S]*fetch\('\/api\/ombre-dashboard\/buckets'\)/);
  const detail=js.slice(js.indexOf('async function openMemoryDetail'),js.indexOf('async function loadMemoryDashboard'));
  assert.ok(detail.indexOf("$('#memoryDetail').classList.add('on')")<detail.indexOf('await fetch('));
});

test('frontend never references Ombre or Cloudflare secrets',()=>{
  assert.doesNotMatch(html+css+js,/OMBRE_DASHBOARD_PASSWORD|CF_ACCESS_CLIENT_SECRET|set-cookie|sessionCookie/i);
});

test('Breath Lab stays inside Memory and displays stable debug dimensions',()=>{
  assert.match(html,/memoryPage[\s\S]*Breath Lab[\s\S]*breathResult/);
  assert.match(js,/\/api\/ombre-dashboard\/breath-debug\?q=/);
  assert.match(js,/valence:[\s\S]*arousal:[\s\S]*threshold:[\s\S]*passed:/);
});
