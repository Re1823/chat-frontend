const $ = s => document.querySelector(s); const $$ = s => [...document.querySelectorAll(s)];
const presets = {
  claude:{name:'Claude',icon:'C',base:'https://api.anthropic.com',model:'claude-sonnet-4-5',protocol:'anthropic'},
  relay:{name:'中转站',icon:'↗',base:'https://api.openai.com/v1',model:'gpt-5',protocol:'chat'},
  chatgpt:{name:'ChatGPT',icon:'◎',base:'https://api.openai.com/v1',model:'chat-latest',protocol:'responses'},
  codex:{name:'Codex',icon:'⌘',base:'https://api.openai.com/v1',model:'gpt-5.6-sol',protocol:'responses'}
};
let activeProvider = localStorage.getItem('dwell.provider') || 'claude';
let profiles = JSON.parse(localStorage.getItem('dwell.profiles') || '{}');
let sessions = JSON.parse(localStorage.getItem('dwell.sessions') || '[]');
let activeId = localStorage.getItem('dwell.active') || '';
let sending = false, controller;
const profile = id => ({...presets[id], ...(profiles[id] || {})});
const persist = () => { localStorage.setItem('dwell.profiles',JSON.stringify(profiles)); localStorage.setItem('dwell.provider',activeProvider); localStorage.setItem('dwell.sessions',JSON.stringify(sessions)); localStorage.setItem('dwell.active',activeId); };
const toast = t => { $('#toast').textContent=t; $('#toast').classList.add('on'); setTimeout(()=>$('#toast').classList.remove('on'),1800); };
function renderProviders(){ $('#providers').innerHTML=Object.entries(presets).map(([id,p])=>`<button class="provider ${id===activeProvider?'on':''}" data-id="${id}"><span>${p.icon}</span>${p.name}</button>`).join(''); $$('.provider').forEach(b=>b.onclick=()=>selectProvider(b.dataset.id)); }
function selectProvider(id){ saveDraft(); activeProvider=id; const p=profile(id); $('#base').value=p.base; $('#key').value=p.key||''; $('#model').value=p.model; $('#protocol').value=p.protocol; $('#system').value=p.system||''; $('#testMsg').textContent=''; renderProviders(); }
function saveDraft(){ if(!activeProvider)return; profiles[activeProvider]={base:$('#base').value.trim(),key:$('#key').value.trim(),model:$('#model').value.trim(),protocol:$('#protocol').value,system:$('#system').value.trim()}; }
function openSettings(){ selectProvider(activeProvider); $('#shade').classList.add('on'); $('#settings').classList.add('on'); }
function closeSettings(){ $('#shade').classList.remove('on'); $('#settings').classList.remove('on'); }
function configured(){ const p=profile(activeProvider); return !!(p.key&&p.model); }
function updateStatus(){ const p=profile(activeProvider); $('#modelLabel').textContent=configured()?`${p.name} · ${p.model}`:'未接入'; $('#statusLine').textContent=configured()?`${p.name} 正在这里`:'选一条路，让他醒来'; $('#providerDot').classList.toggle('on',configured()); $('#send').disabled=!configured()||!$('#input').value.trim()||sending; }
function current(){ return sessions.find(s=>s.id===activeId); }
function newChat(){ const s={id:crypto.randomUUID(),title:'新的对话',provider:activeProvider,created:Date.now(),messages:[]}; sessions.unshift(s); activeId=s.id; persist(); renderAll(); $('#input').focus(); }
function renderSessions(){ $('#sessions').innerHTML=sessions.map(s=>`<button class="session ${s.id===activeId?'on':''}" data-id="${s.id}">${escapeHtml(s.title)}</button>`).join('')||'<div style="padding:8px 12px;color:#aaa;font-size:12px">还没有留下什么</div>'; $$('.session').forEach(b=>b.onclick=()=>{activeId=b.dataset.id;persist();renderAll();$('aside').classList.remove('on')}); }
const escapeHtml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function markup(s){ let x=escapeHtml(s); x=x.replace(/```([\s\S]*?)```/g,(_,c)=>`<pre><code>${c.trim()}</code></pre>`); x=x.replace(/`([^`]+)`/g,'<code>$1</code>'); x=x.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>'); return x; }
function renderMessages(){ const box=$('#messages'), s=current(); if(!s||!s.messages.length){box.innerHTML='<div class="welcome"><div class="orb"><span></span></div><h2>有些话，不必急着说完。</h2><p>接上你常用的模型。对话会留在这台浏览器里，慢慢长成日子。</p><button id="welcomeSetup">接一条路进来 →</button></div>'; $('#welcomeSetup').onclick=openSettings; $('#chatTitle').textContent='今天，也在这里';return} box.innerHTML=s.messages.map(m=>m.role==='user'?`<article class="message user"><div class="bubble">${markup(m.content)}</div></article>`:`<article class="message"><div class="avatar">${presets[s.provider]?.icon||'d'}</div><div class="bubble ${m.pending?'thinking':''}">${m.content?markup(m.content):'正在想…'}</div></article>`).join(''); $('#chatTitle').textContent=s.title; box.scrollTop=box.scrollHeight; }
function renderAll(){renderSessions();renderMessages();updateStatus()}
async function send(){ const text=$('#input').value.trim(); if(!text||sending)return; if(!configured())return openSettings(); if(!current())newChat(); const s=current(); s.provider=activeProvider; s.messages.push({role:'user',content:text}); if(s.messages.filter(m=>m.role==='user').length===1)s.title=text.slice(0,22); s.messages.push({role:'assistant',content:'',pending:true}); $('#input').value=''; autoSize(); sending=true;persist();renderAll(); controller=new AbortController();
  const p=profile(activeProvider); const apiMessages=[]; if(p.system)apiMessages.push({role:'system',content:p.system}); apiMessages.push(...s.messages.filter(m=>!m.pending).map(({role,content})=>({role,content})));
  try{ const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:p,messages:apiMessages}),signal:controller.signal}); if(!r.ok){const e=await r.json();throw new Error([e.error,e.detail].filter(Boolean).join('\n'))} const reader=r.body.getReader(),dec=new TextDecoder();let buf=''; const out=s.messages.at(-1); out.pending=false; while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split('\n\n');buf=parts.pop()||'';for(const part of parts){const line=part.split('\n').find(x=>x.startsWith('data:'));if(!line)continue;try{const d=JSON.parse(line.slice(5));if(d.delta){out.content+=d.delta;renderMessages()}}catch{}}} if(!out.content)out.content='（对面没有返回文字）';
  }catch(e){const out=s.messages.at(-1);out.pending=false;out.content=`没接通：${e.message}`;}finally{sending=false;persist();renderAll()}}
function autoSize(){const t=$('#input');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,160)+'px';updateStatus()}
$('#settingsBtn').onclick=$('#modelBtn').onclick=$('#welcomeSetup').onclick=openSettings; $('#closeSettings').onclick=$('#shade').onclick=closeSettings; $('#newChat').onclick=newChat; $('#menuBtn').onclick=()=>{$('aside').classList.toggle('on')}; $('#send').onclick=send;
$('#input').oninput=autoSize; $('#input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}; $$('[data-soon]').forEach(b=>b.onclick=()=>toast('这间屋子还在慢慢盖'));
$('#save').onclick=()=>{saveDraft();persist();updateStatus();closeSettings();toast('接好了，这条路记住了')};
$('#test').onclick=async()=>{saveDraft();const p=profile(activeProvider);$('#testMsg').className='test-msg';$('#testMsg').textContent='正在敲门…';try{const r=await fetch('/api/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:p})});const d=await r.json();if(!r.ok)throw new Error([d.error,d.detail].filter(Boolean).join('\n'));$('#testMsg').textContent=`门开了 · ${d.model}`}catch(e){$('#testMsg').className='test-msg bad';$('#testMsg').textContent=e.message}};
if(activeId&&!current())activeId=''; renderProviders();selectProvider(activeProvider);renderAll();
