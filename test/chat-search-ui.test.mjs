import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');

test('Assistant Details has four frosted shortcuts and Conversations reuses the existing continuation flow',()=>{
  for(const id of ['assistantSearch','assistantConversations','assistantMute','assistantMore'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(css,/\.assistant-quick-actions\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css,/backdrop-filter:blur\(18px\)/);
  assert.match(app,/\$\('#assistantConversations'\)\.onclick=\(\)=>\{showChat\(\);openContinuation\(\)\}/);
  assert.match(html,/<button id="continueBtn" class="continue-pill" type="button" aria-label="暂未开放"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"\/><path d="M14 2v6h6M8 13h8M8 17h5"\/><\/svg><\/button>/);
  assert.doesNotMatch(html,/id="continueBtn"[^>]*(?:hidden|data-soon|title=)/);
  assert.doesNotMatch(app,/#continueBtn/);
  assert.match(css,/\.chat-floating #menuBtn,\.chat-floating #continueBtn\{[^}]*width:44px[^}]*border-radius:50%[^}]*padding:11px[^}]*display:grid[^}]*place-items:center/);
  assert.match(css,/\.chat-floating #menuBtn,\.chat-floating #continueBtn,\.top-capsule\{[^}]*height:44px[^}]*backdrop-filter:blur\(20px\)[^}]*box-shadow:0 2px 8px/);
  assert.doesNotMatch(css,/\.header-empty-slot/);
  assert.doesNotMatch(app,/continueBtn[^\n]*(?:openContinuation|fetch|rotation|rsc)/i);
});

test('chat search UI follows the visible chat and mobile keyboard contract',()=>{
  assert.match(html,/placeholder="Search in this chat"/);
  assert.match(html,/id="closeChatSearch"/);
  assert.match(html,/id="openChatCalendar"/);
  const inputRule=css.match(/\.chat-search-header input\{([^}]*)\}/)?.[1]||'';
  const effectiveSize=Number(inputRule.match(/font-size:([\d.]+)px/)?.[1]);
  assert.ok(effectiveSize>=16,`search input effective font-size must be at least 16px, got ${effectiveSize}`);
  assert.match(inputRule,/font-family:inherit/);
  assert.doesNotMatch(inputRule,/font:/);
  const viewport=html.match(/<meta name="viewport" content="([^"]+)"/)?.[1]||'';
  assert.doesNotMatch(viewport,/maximum-scale|user-scalable/i);
  assert.doesNotMatch(css,/chat-searching[^{}]*\.app\{[^}]*transform/);
  assert.match(css,/\.chat-search-toolbar\{[^}]*--vv-bottom/);
  assert.match(css,/@media\(max-width:390px\)/);
  assert.match(app,/chatSearchTimer=setTimeout\(\(\)=>runChatSearch\(event\.target\.value\),180\)/);
  assert.match(app,/scrollIntoView\?\.\(\{block:'center',behavior:'smooth'\}\)/);
  assert.match(app,/chatSearchState\.scrollTop/);
  assert.match(app,/focus\?\.\(\{preventScroll:true\}\)/);
});

test('keyword index is built only from visible user and assistant presentation text',()=>{
  assert.match(app,/function visibleMessageSearchText\(message\)/);
  assert.match(app,/message\.toolMessages\|\|\[\]/);
  assert.doesNotMatch(app.match(/function visibleMessageSearchText[\s\S]*?\n}/)?.[0]||'',/thoughtProcess|signature|tool_result|metadata/);
  assert.match(app,/toLocaleLowerCase\(\)/);
  assert.match(app,/normalize\('NFC'\)/);
  assert.match(css,/\.chat-search-mark/);
  assert.match(app,/jumpChatSearchResult\(-1\)/);
  assert.match(app,/jumpChatSearchResult\(1\)/);
});

test('calendar is a real visual-viewport bottom sheet with month navigation and no-message state',()=>{
  for(const id of ['chatCalendarSheet','calendarMonthTitle','previousCalendarMonth','nextCalendarMonth','calendarDays','confirmChatDate'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(css,/\.chat-calendar-sheet\{[^}]*--vv-bottom/);
  assert.match(css,/grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(css,/env\(safe-area-inset-bottom/);
  assert.match(app,/function changeCalendarMonth\(delta\)/);
  assert.match(app,/No messages on this date/);
  assert.match(app,/localDayKey\(time\)===key/);
  assert.match(css,/\.calendar-days button\.selected\{[^}]*background:var\(--bubble-user,#EFE9E6\)[^}]*color:var\(--text,var\(--ink\)\)/);
  assert.match(css,/\.calendar-done\{[^}]*var\(--bubble-user,#EFE9E6\)[^}]*var\(--accent\)/);
  assert.match(css,/\.calendar-month-row button\{[^}]*color:var\(--text-muted,var\(--muted\)\)/);
  assert.doesNotMatch(css,/#a9c3d0|#90aebc/i);
});

test('day dividers are derived at presentation time and never stored as messages',()=>{
  assert.match(app,/function renderChatHistory\(messages\)/);
  assert.match(app,/seenVisible&&previousVisibleDay&&day!==previousVisibleDay/);
  assert.match(app,/class="chat-day-divider"/);
  assert.doesNotMatch(app,/messages\.push\([^\n]*chat-day-divider/);
  assert.match(css,/\.chat-day-divider\{[^}]*grid-template-columns:minmax\(20px,1fr\) auto minmax\(20px,1fr\)/);
});

test('search release bumps both browser assets together',()=>{
  assert.match(html,/style\.css\?v=pwa2/);
  assert.match(html,/app\.js\?v=pwa2/);
});
