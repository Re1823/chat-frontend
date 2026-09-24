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
  assert.match(html,/id="continueBtn"/);
});

test('chat search UI follows the visible chat and mobile keyboard contract',()=>{
  assert.match(html,/placeholder="Search in this chat"/);
  assert.match(html,/id="closeChatSearch"/);
  assert.match(html,/id="openChatCalendar"/);
  assert.match(css,/\.chat-search-header input\{[^}]*font:16px/);
  assert.match(css,/\.chat-search-toolbar\{[^}]*--vv-bottom/);
  assert.match(css,/@media\(max-width:390px\)/);
  assert.match(app,/chatSearchTimer=setTimeout\(\(\)=>runChatSearch\(event\.target\.value\),180\)/);
  assert.match(app,/scrollIntoView\?\.\(\{block:'center',behavior:'smooth'\}\)/);
  assert.match(app,/chatSearchState\.scrollTop/);
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
});

test('day dividers are derived at presentation time and never stored as messages',()=>{
  assert.match(app,/function renderChatHistory\(messages\)/);
  assert.match(app,/seenVisible&&previousVisibleDay&&day!==previousVisibleDay/);
  assert.match(app,/class="chat-day-divider"/);
  assert.doesNotMatch(app,/messages\.push\([^\n]*chat-day-divider/);
  assert.match(css,/\.chat-day-divider\{[^}]*grid-template-columns:minmax\(20px,1fr\) auto minmax\(20px,1fr\)/);
});

test('search release bumps both browser assets together',()=>{
  assert.match(html,/style\.css\?v=search1/);
  assert.match(html,/app\.js\?v=search1/);
});
