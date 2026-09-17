const $ = s => document.querySelector(s); const $$ = s => [...document.querySelectorAll(s)];
const chatIcons={"menu":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 6h14M5 12h14M5 18h14\"/></svg>","file":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"/><path d=\"M14 2v6h6M8 13h8M8 17h5\"/></svg>","check":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\"/><path d=\"m8 12 3 3 5-6\"/></svg>","more":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"5\" r=\"1\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"19\" r=\"1\"/></svg>","plus":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 5v14M5 12h14\"/></svg>","mic":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"9\" y=\"2\" width=\"6\" height=\"13\" rx=\"3\"/><path d=\"M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8\"/></svg>","wave":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4\"/></svg>","arrow":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 19V5m-6 6 6-6 6 6\"/></svg>","stop":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"7\" y=\"7\" width=\"10\" height=\"10\" rx=\"1\"/></svg>","down":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m8 10 4 4 4-4\"/></svg>","cloud":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 2 4 4 0 0 1 0 8Z\"/></svg>","ai":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 17C3 9 8 4 18 5c1 9-3 14-10 12M6 19 16 8M8 14h5\"/></svg>","user":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"8\" r=\"3\"/><path d=\"M5 21v-2a7 7 0 0 1 14 0v2\"/></svg>"};
let generatedIdSequence=0;
function generateId(){const webCrypto=globalThis.crypto;if(typeof webCrypto?.randomUUID==='function')return webCrypto.randomUUID();const sequence=(++generatedIdSequence).toString(36);if(typeof webCrypto?.getRandomValues==='function'){const bytes=new Uint8Array(16);webCrypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}-${sequence}`}return `dwell-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2,12)}`}
const presets = {
  claude:{name:'Claude',icon:'C',base:'https://api.anthropic.com',model:'claude-sonnet-4-5',protocol:'anthropic'},
  relay:{name:'中转站',icon:'↗',base:'https://api.openai.com/v1',model:'gpt-5',protocol:'chat'},
  chatgpt:{name:'ChatGPT',icon:'◎',base:'https://api.openai.com/v1',model:'chat-latest',protocol:'responses'},
  codex:{name:'Codex',icon:'⌘',base:'https://api.openai.com/v1',model:'gpt-5.6-sol',protocol:'responses'}
};
const runtimePresets={claude_tmux:{name:'Claude Code',icon:'C⌁',runtime:'claude_tmux',runtimeId:'claude-main'}};
const providerChoices={...presets,...runtimePresets};
let activeProvider = localStorage.getItem('dwell.provider') || 'claude';
let profiles = JSON.parse(localStorage.getItem('dwell.profiles') || '{}');
let sessions = JSON.parse(localStorage.getItem('dwell.sessions') || '[]');
let activeId = localStorage.getItem('dwell.active') || '';
const assistantProfileDefaults={name:'秋秋',subtitle:'Claude Code',introduction:'Personal assistant'};
function readAssistantProfile(){try{const saved=JSON.parse(localStorage.getItem('dwell.assistantProfile')||'{}');return {...assistantProfileDefaults,...saved,name:String(saved.name||assistantProfileDefaults.name),introduction:String(saved.introduction||assistantProfileDefaults.introduction)}}catch{return {...assistantProfileDefaults}}}
const assistantAvatarKey='dwell.assistantAvatar',userAvatarKey='dwell.userAvatar';
function readSavedAvatar(key){try{const value=localStorage.getItem(key)||'';return /^data:image\/jpeg;base64,\/9j\/[a-z0-9+/]+=*$/i.test(value)&&value.length>100&&value.length<700000?value:''}catch{return ''}}
let assistantProfile=readAssistantProfile(),assistantAvatarUrl=readSavedAvatar(assistantAvatarKey),assistantEditAvatarUrl=assistantAvatarUrl;
const userProfileDefaults={name:'小霏',birthday:'',introduction:''};
function readUserProfile(){try{return {...userProfileDefaults,...JSON.parse(localStorage.getItem('dwell.userProfile')||'{}')}}catch{return {...userProfileDefaults}}}
let userProfile=readUserProfile(),userAvatarUrl=readSavedAvatar(userAvatarKey),userEditAvatarUrl=userAvatarUrl,settingsReturnView='chat';
let activeRequest=null;
let sending = false, stopping = false, controller, continuationSourceId='', activeTurnId='', tmuxStatus={state:'unknown'}, draftImages=[],pendingImageUploads=0;
const profile = id => ({...providerChoices[id], ...(profiles[id] || {})});
const persist = () => { localStorage.setItem('dwell.profiles',JSON.stringify(profiles)); localStorage.setItem('dwell.provider',activeProvider); localStorage.setItem('dwell.sessions',JSON.stringify(sessions)); localStorage.setItem('dwell.active',activeId); };
let toastTimer;
function syncComposerHeight(){
  const footer=$('main>footer');
  if(activeAppView==='memory'||!footer?.getBoundingClientRect)return;
  const height=Math.ceil(footer.getBoundingClientRect().height);
  if(height)document.documentElement?.style?.setProperty('--composer-h',`${height}px`);
  positionToast();
  if(keepBottomThroughViewportResize)scrollMessagesToBottom();
}
function positionToast(){const notice=$('#toast'),footer=$('main>footer');if(!notice||!footer?.getBoundingClientRect)return;const layoutHeight=globalThis.innerHeight||document.documentElement?.clientHeight||800,visual=globalThis.visualViewport,visualTop=visual?.offsetTop||0,visualBottom=visual?visual.offsetTop+visual.height:layoutHeight,anchorTop=Math.min(footer.getBoundingClientRect().top,visualBottom),gap=16;notice.style.bottom=`${Math.max(gap,layoutHeight-anchorTop+gap)}px`;notice.style.maxHeight=`${Math.max(96,Math.min(320,anchorTop-visualTop-gap*1.5))}px`}
let viewportFramePending=false,viewportRevision=0,keepBottomThroughViewportResize=false,activeAppView='chat';
function syncVisualViewport(){const visual=globalThis.visualViewport,height=Math.round(visual?.height||globalThis.innerHeight||document.documentElement?.clientHeight||0),offsetTop=Math.round(visual?.offsetTop||0),bottom=offsetTop+height;if(height)document.documentElement?.style?.setProperty('--vv-height',`${height}px`);document.documentElement?.style?.setProperty('--vv-offset-top',`${offsetTop}px`);document.documentElement?.style?.setProperty('--vv-bottom',`${bottom}px`);positionToast()}
function setViewportBottomAnchor(enabled){keepBottomThroughViewportResize=!!enabled;$('#messages').classList.toggle('bottom-anchored',keepBottomThroughViewportResize)}
function cancelViewportBottomAnchor(){setViewportBottomAnchor(false)}
let keyboardViewportPending=false,keyboardViewportTimer,keyboardViewportRevision=0;
const isIOSViewport=()=>!!globalThis.visualViewport&&(/iPad|iPhone|iPod/.test(globalThis.navigator?.userAgent||'')||(globalThis.navigator?.platform==='MacIntel'&&globalThis.navigator?.maxTouchPoints>1));
function scheduleSettledChatViewport(){
  const revision=++keyboardViewportRevision;
  keyboardViewportPending=true;
  $('#messages').classList.add('is-keyboard-transitioning');
  clearTimeout(keyboardViewportTimer);
  const frame=globalThis.requestAnimationFrame||((callback)=>setTimeout(callback,16));
  const geometry=()=>{const vv=globalThis.visualViewport;return [vv.height,vv.offsetTop,vv.width,vv.scale].join(':')};
  keyboardViewportTimer=setTimeout(()=>{
    frame(()=>{
      if(revision!==keyboardViewportRevision)return;
      const sample=geometry();
      frame(()=>{
        if(revision!==keyboardViewportRevision)return;
        if(sample!==geometry()){scheduleSettledChatViewport();return}
        syncVisualViewport();
        frame(()=>{
          if(revision!==keyboardViewportRevision)return;
          const rect=$('main>footer').getBoundingClientRect();
          frame(()=>{
            if(revision!==keyboardViewportRevision)return;
            const next=$('main>footer').getBoundingClientRect();
            if(sample!==geometry()||Math.abs(rect.top-next.top)>1||Math.abs(rect.height-next.height)>1){scheduleSettledChatViewport();return}
            keyboardViewportPending=false;
            if(activeAppView==='chat'&&keepBottomThroughViewportResize)scrollMessagesToBottom();
            $('#messages').classList.remove('is-keyboard-transitioning');
          });
        });
      });
    });
  },80);
}
function scheduleVisualViewportSync(){const memoryActive=activeAppView==='memory';if(!memoryActive&&!keepBottomThroughViewportResize&&messagesNearBottom())setViewportBottomAnchor(true);if(!memoryActive&&isIOSViewport()){scheduleSettledChatViewport();return}const revision=++viewportRevision;if(viewportFramePending)return;viewportFramePending=true;const schedule=globalThis.requestAnimationFrame||((callback)=>setTimeout(callback,16));schedule(()=>{viewportFramePending=false;const committedRevision=viewportRevision;syncVisualViewport();schedule(()=>{if(committedRevision!==viewportRevision)return;if(memoryActive){const body=$('#memoryBody');if(body)body.scrollTop=Math.min(memoryState.scrollPosition,Math.max(0,body.scrollHeight-body.clientHeight))}else if(keepBottomThroughViewportResize)scrollMessagesToBottom()})})}
const toast=t=>{const notice=$('#toast');notice.textContent=String(t);positionToast();notice.classList.add('on');clearTimeout(toastTimer);const duration=Math.min(8000,Math.max(2200,1400+notice.textContent.length*35));toastTimer=setTimeout(()=>notice.classList.remove('on'),duration)};
function renderProviders(){ $('#providers').innerHTML=Object.entries(providerChoices).map(([id,p])=>`<button class="provider ${id===activeProvider?'on':''}" data-id="${id}" aria-pressed="${id===activeProvider}"><span>${p.icon}</span>${p.name}</button>`).join(''); $$('.provider').forEach(b=>b.onclick=()=>selectProvider(b.dataset.id)); }
function selectProvider(id, saveCurrent=true){ if(saveCurrent)saveDraft(); activeProvider=id; const p=profile(id); const tmux=p.runtime==='claude_tmux'; $('#apiFields').hidden=tmux; $('#tmuxFields').hidden=!tmux; $('#base').value=p.base||''; $('#key').value=p.key||''; $('#model').value=p.model||''; $('#protocol').value=p.protocol||'responses'; $('#system').value=p.system||''; $('#runtimeId').value=p.runtimeId||'claude-main'; $('#testMsg').textContent=''; renderProviders(); if(tmux)refreshRuntimeStatus();else updateStatus(); }
function saveDraft(){ if(!activeProvider)return; const p=profile(activeProvider); profiles[activeProvider]=p.runtime==='claude_tmux'?{runtime:'claude_tmux',runtimeId:$('#runtimeId').value.trim()||'claude-main'}:{base:$('#base').value.trim(),key:$('#key').value.trim(),model:$('#model').value.trim(),protocol:$('#protocol').value,system:$('#system').value.trim()}; }
function openSettings(returnView='chat'){ closeSheets();settingsReturnView=returnView;selectProvider(activeProvider);$('#settings').classList.remove('leaving');$('#shade').classList.add('on');$('#settings').classList.add('on') }
function closeSheets(){ $('#shade').classList.remove('on'); $$('.sheet').forEach(x=>x.classList.remove('on'));$('#addToChatSheet')?.setAttribute?.('aria-hidden','true') }
function closeTransientUI(){closeSheets();closeViewer()}
function closeSettings(){ closeConnections(); }
function configured(){ const p=profile(activeProvider); return p.runtime==='claude_tmux'?tmuxStatus.state==='connected':!!(p.key&&p.model); }
function updateStatus(){ const p=profile(activeProvider),s=current(),canStop=sending&&p.runtime==='claude_tmux',hasDraft=!!$('#input').value.trim()||draftImages.length>0; const label=p.runtime==='claude_tmux'?`${p.name} · ${tmuxStatus.state||'unknown'}`:`${p.name} · ${p.model}`; $('#modelLabel').textContent=p.runtime==='claude_tmux'?'Sonnet 4.6':configured()?p.model:'未接入'; $('#modelBtn').disabled=p.runtime==='claude_tmux'; $('#modelBtn').setAttribute?.('aria-label',p.runtime==='claude_tmux'?'Sonnet 4.6（固定模型）':'模型与接入设置'); $('#modelBtn').setAttribute?.('title',label); $('#statusLine').textContent=configured()?`${p.name} 正在这里`:p.runtime==='claude_tmux'?`Claude runtime：${tmuxStatus.state||'unknown'}`:'选一条路，让他醒来'; $('#providerDot').classList.toggle('on',configured()); $('#send').disabled=canStop?stopping:(!configured()||!hasDraft||sending||pendingImageUploads>0); $('#send').innerHTML=canStop?chatIcons.stop:hasDraft?chatIcons.arrow:chatIcons.wave; $('#send').setAttribute?.('aria-label',canStop?'停止回复':'发送'); $('#continueBtn').hidden=false; $('#continueBtn').innerHTML=chatIcons.file; $('#continueBtn').setAttribute?.('aria-label',s?.bridge&&!s.messages.length?'查看启动包':'续窗'); }
async function refreshRuntimeStatus(){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);try{const r=await fetch('/api/runtimes/claude-tmux/status',{signal:controller.signal}),body=await r.text();let data;try{data=JSON.parse(body)}catch{throw new Error('Claude runtime 状态响应格式无效')}if(!r.ok)throw new Error(data.error||`Claude runtime 状态请求失败（HTTP ${r.status}）`);if(!data||typeof data.state!=='string')throw new Error('Claude runtime 状态响应缺少 state');tmuxStatus=data}catch(e){tmuxStatus={state:'unreachable',error:e.name==='AbortError'?'Claude runtime 状态请求超时':e.message}}finally{clearTimeout(timer)}updateStatus();return tmuxStatus}
function current(){ return sessions.find(s=>s.id===activeId); }
function newChat(){ showChat(); const s={id:generateId(),title:'新的对话',provider:activeProvider,created:Date.now(),messages:[]}; sessions.unshift(s); activeId=s.id; persist(); renderAll(); $('#input').focus(); }
function renderSessions(){ $('#sessions').innerHTML=sessions.map(s=>`<button class="session ${s.id===activeId?'on':''}" data-id="${s.id}"><span>${escapeHtml(s.title)}</span>${s.continuedFrom?'<em>续</em>':s.continuedTo?'<em>原</em>':''}</button>`).join('')||'<div style="padding:8px 12px;color:#aaa;font-size:12px">还没有留下什么</div>'; $$('.session').forEach(b=>b.onclick=()=>{activeId=b.dataset.id;persist();showChat()}); }
const escapeHtml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function markup(s){ let x=escapeHtml(s); x=x.replace(/```([\s\S]*?)```/g,(_,c)=>`<pre><code>${c.trim()}</code></pre>`); x=x.replace(/`([^`]+)`/g,'<code>$1</code>'); x=x.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>'); return x; }
function ordinaryAssistantPresentationText(text){return String(text||'').replace(/<br\s*\/?>/gi,'\n').replace(/^\n+|\n+$/g,'')}
const compact = (text,max=700) => { const clean=String(text||'').replace(/\s+/g,' ').trim(); return clean.length>max?clean.slice(0,max)+'…':clean; };
const unique = items => [...new Set(items.filter(Boolean))];
function getTogetherDays(now=new Date()){const start=Date.UTC(2026,5,15),today=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());return Math.max(1,Math.floor((today-start)/86400000)+1)}
function avatarFallback(image,kind){const node=image?.parentNode;if(!node)return;node.innerHTML=kind==='user'?chatIcons.user:chatIcons.ai;node.classList.remove('has-image')}
function setAssistantAvatar(node,url){if(!node)return;const image=node.querySelector?.('img');if(image){image.hidden=!url;image.onerror=()=>avatarFallback(image,node.classList.contains('user')||node.classList.contains('user-profile-avatar')?'user':'assistant');image.src=url||''}node.classList.toggle('has-image',!!url)}
function prepareAvatar(file){return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(new Error('图片读取失败'));
  reader.onload=()=>{
    const image=new Image();
    image.onerror=()=>reject(new Error('图片格式无法读取'));
    image.onload=()=>{
      const size=256,side=Math.min(image.naturalWidth,image.naturalHeight),sx=(image.naturalWidth-side)/2,sy=(image.naturalHeight-side)/2,canvas=document.createElement('canvas'),context=canvas.getContext('2d');
      canvas.width=canvas.height=size;context.fillStyle='#f5f2ef';context.fillRect(0,0,size,size);context.drawImage(image,sx,sy,side,side,0,0,size,size);resolve(canvas.toDataURL('image/jpeg',.84));
    };
    image.src=String(reader.result);
  };
  reader.readAsDataURL(file);
})}
function persistAvatar(key,value){try{localStorage.setItem(key,value);return true}catch(error){console.warn('Avatar persistence failed',error?.name||'storage error');toast('头像已在本次使用，但浏览器空间不足，刷新后可能无法保留');return false}}
function assistantMessageAvatarMarkup(){return assistantAvatarUrl?`<img src="${escapeHtml(assistantAvatarUrl)}" alt="" onerror="avatarFallback(this,'assistant')">`:chatIcons.ai}
function userMessageAvatarMarkup(){return userAvatarUrl?`<img src="${escapeHtml(userAvatarUrl)}" alt="" onerror="avatarFallback(this,'user')">`:chatIcons.user}
function renderAssistantProfile(){ $('#assistantName').textContent=assistantProfile.name;$('#assistantSubtitle').textContent=assistantProfile.subtitle;$('#assistantIntroduction').textContent=assistantProfile.introduction;$('#assistantRuntime').textContent=assistantProfile.subtitle;$$('.assistant-profile-avatar').forEach(node=>setAssistantAvatar(node,assistantAvatarUrl));setAssistantAvatar($('.anniversary-avatar.assistant'),assistantAvatarUrl);$$('#messages .message:not(.user) .avatar').forEach(node=>{node.innerHTML=assistantMessageAvatarMarkup();node.classList.toggle('has-image',!!assistantAvatarUrl)}) }
function setProfileView(view){closeTransientUI();hidePhotos();activeAppView=view;$('#memoryPage').hidden=true;$('main').classList.remove('memory-mode');$('main').classList.add('assistant-mode');$('main>header.chat-floating').hidden=true;$('#messages').hidden=true;$('main>footer').hidden=true;$('#assistantPage').hidden=view!=='assistant';$('#assistantEditPage').hidden=view!=='assistant-edit';$('#userHubPage').hidden=true;$('#userProfilePage').hidden=true;$('#userProfileEditPage').hidden=true;$('aside').classList.remove('on')}
function openAssistantDetails(){closeSheets();renderAssistantProfile();setProfileView('assistant')}
function openAssistantEdit(){assistantEditAvatarUrl=assistantAvatarUrl;$('#assistantNameInput').value=assistantProfile.name;$('#assistantIntroductionInput').value=assistantProfile.introduction;setAssistantAvatar($('#assistantEditPage .assistant-profile-avatar'),assistantEditAvatarUrl);setProfileView('assistant-edit')}
function cancelAssistantEdit(){assistantEditAvatarUrl=assistantAvatarUrl;openAssistantDetails()}
function saveAssistantEdit(){const name=$('#assistantNameInput').value.trim()||assistantProfileDefaults.name,introduction=$('#assistantIntroductionInput').value.trim()||assistantProfileDefaults.introduction;assistantProfile={...assistantProfile,name,introduction};localStorage.setItem('dwell.assistantProfile',JSON.stringify({name,introduction}));assistantAvatarUrl=assistantEditAvatarUrl;if(assistantAvatarUrl)persistAvatar(assistantAvatarKey,assistantAvatarUrl);renderAssistantProfile();setProfileView('assistant')}
function selectAssistantAvatar(){ $('#assistantAvatarInput').click() }
async function previewAssistantAvatar(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;if(!String(file.type||'').startsWith('image/'))return toast('请选择图片文件');$('#saveAssistantEdit').disabled=true;try{assistantEditAvatarUrl=await prepareAvatar(file);setAssistantAvatar($('#assistantEditPage .assistant-profile-avatar'),assistantEditAvatarUrl)}catch(error){toast(error.message)}finally{$('#saveAssistantEdit').disabled=false}}
function renderUserProfile(){const birthday=userProfile.birthday?userProfile.birthday.replaceAll('-',' · '):'Not set';$('#userHubName').textContent=$('#userProfileName').textContent=userProfile.name;$('#userBirthday').textContent=birthday;$('#userIntroduction').textContent=userProfile.introduction||'Not set';$$('.user-profile-avatar').forEach(n=>setAssistantAvatar(n,userAvatarUrl));setAssistantAvatar($('.anniversary-avatar.user'),userAvatarUrl);$$('#messages .message.user .avatar').forEach(n=>{n.innerHTML=userMessageAvatarMarkup();n.classList.toggle('has-image',!!userAvatarUrl)})}
function openUserPage(view,id){closeTransientUI();hidePhotos();activeAppView=view;$('#memoryPage').hidden=true;$('main').classList.remove('memory-mode');$('main').classList.add('assistant-mode');$('main>header.chat-floating').hidden=true;$('#messages').hidden=true;$('main>footer').hidden=true;['#assistantPage','#assistantEditPage','#userHubPage','#userProfilePage','#userProfileEditPage'].forEach(x=>$(x).hidden=x!==id);$('aside').classList.remove('on')}
function openUserHub(){closeSheets();renderUserProfile();openUserPage('user-hub','#userHubPage')}function openUserProfile(){renderUserProfile();openUserPage('user-profile','#userProfilePage')}
function openUserEdit(){userEditAvatarUrl=userAvatarUrl;$('#userNameInput').value=userProfile.name;$('#userIntroductionInput').value=userProfile.introduction;$('#userBirthdayInput').value=userProfile.birthday;setAssistantAvatar($('#userProfileEditPage .user-profile-avatar'),userEditAvatarUrl);openUserPage('user-edit','#userProfileEditPage')}
function cancelUserEdit(){userEditAvatarUrl=userAvatarUrl;openUserProfile()}
function saveUserEdit(){userProfile={name:$('#userNameInput').value.trim()||userProfileDefaults.name,introduction:$('#userIntroductionInput').value.trim(),birthday:$('#userBirthdayInput').value};localStorage.setItem('dwell.userProfile',JSON.stringify(userProfile));userAvatarUrl=userEditAvatarUrl;if(userAvatarUrl)persistAvatar(userAvatarKey,userAvatarUrl);renderUserProfile();openUserProfile()}
async function previewUserAvatar(e){const file=e.target.files?.[0];e.target.value='';if(!file)return;if(!String(file.type||'').startsWith('image/'))return toast('请选择图片文件');$('#saveUserProfileEdit').disabled=true;try{userEditAvatarUrl=await prepareAvatar(file);setAssistantAvatar($('#userProfileEditPage .user-profile-avatar'),userEditAvatarUrl)}catch(error){toast(error.message)}finally{$('#saveUserProfileEdit').disabled=false}}
function openConnections(){openSettings('user-hub')}function closeConnections(){const sheet=$('#settings'),wasOpen=sheet.classList.contains('on');if(wasOpen){sheet.classList.add('leaving');setTimeout(()=>sheet.classList.remove('leaving'),280)}closeSheets();if(settingsReturnView==='user-hub')openUserHub()}
function buildContinuation(s){
  const clean=s.messages.map(m=>m.toolMessages?.length?{...m,content:[...m.toolMessages.map(item=>item.content),...(m.content&&!ordinaryBodyIsDuplicate(m)?[m.content]:[])].join('\n\n')}:m).filter(m=>!m.pending&&m.content&&!/^没接通：/.test(m.content));
  const user=clean.filter(m=>m.role==='user'), assistant=clean.filter(m=>m.role==='assistant');
  const signal=/不要|必须|希望|需要|保持|以后|偏好|记住|决定|采用|改成|保留|删除|选择|边界|不能|已经|完成|实现|修复|提交|确认/;
  const signals=unique(clean.flatMap(m=>String(m.content).split(/\n+/).map(compact).filter(x=>signal.test(x)))).slice(-10);
  const recent=clean.slice(-12).map(m=>`${m.role==='user'?'用户':'助手'}：${compact(m.content)}`);
  const firstTask=compact(user[0]?.content||s.title,240), currentTask=compact(user.at(-1)?.content||s.title,420);
  const done=assistant.slice(-4).map(m=>compact(m.content,260));
  const system=profile(s.provider||activeProvider).system;
  const parts=['[续窗启动包]',`来源会话：${s.title}`,`生成时间：${new Date().toLocaleString('zh-CN')}`,'','## 身份、偏好与边界',system?`- ${compact(system,500)}`:'- 沿用原会话中的用户偏好、安全边界与表达方式；不确定时先询问。',...signals.slice(0,5).map(x=>`- ${x}`),'','## 当前任务',`- 最初目标：${firstTask}`,`- 当前焦点：${currentTask}`,'','## 已完成与关键决定',...(done.length?done.map(x=>`- ${x}`):['- 暂无可确认的完成项；接手后先核对现状。']),...signals.slice(5).map(x=>`- ${x}`),'','## 未完成与下一步',`- 先回应当前焦点，并根据最近对话确认下一步：${currentTask}`,'- 不把旧窗口中已经结束的排查或工具输出误认为当前任务。','','## 最近的干净对话',...recent.map(x=>`- ${x}`),'','接手规则：先用一句话复述当前任务，再继续工作；缺少关键事实时明确询问，不虚构旧会话内容。'];
  return {text:parts.join('\n').slice(0,24000),kept:clean.length,total:s.messages.length};
}
function updateContinueStats(kept,total){ $('#continueKept').textContent=`保留 ${kept}/${total} 条有效消息`; $('#continueSize').textContent=`${$('#continueDraft').value.length.toLocaleString()} 字`; }
function openContinuation(){ const s=current(); if(!s)return toast('先开始一段对话'); closeSheets(); continuationSourceId=s.id; if(s.bridge&&!s.messages.length){ $('#continueHeading').textContent='查看启动包'; $('#continueDraft').value=s.bridge; $('#startContinue').textContent='保存修改'; $('#continueSheet').dataset.mode='edit'; updateContinueStats(0,0); } else { const pack=buildContinuation(s); $('#continueHeading').textContent='把工作接过去'; $('#continueDraft').value=pack.text; $('#startContinue').textContent='开启新会话'; $('#continueSheet').dataset.mode='create'; updateContinueStats(pack.kept,pack.total); } $('#shade').classList.add('on'); $('#continueSheet').classList.add('on'); }
function startContinuation(){ const source=sessions.find(s=>s.id===continuationSourceId), bridge=$('#continueDraft').value.trim(); if(!source||!bridge)return toast('启动包不能为空'); if($('#continueSheet').dataset.mode==='edit'){source.bridge=bridge;persist();closeSheets();renderAll();return toast('启动包已更新')} const next={id:generateId(),title:`${source.title.replace(/ · 续$/,'')} · 续`,provider:source.provider||activeProvider,created:Date.now(),continuedFrom:source.id,bridge,messages:[]}; source.continuedTo=next.id; source.continuedAt=Date.now(); sessions.unshift(next); activeId=next.id; activeProvider=next.provider; persist(); closeSheets(); renderAll(); $('#input').focus(); toast('新窗口已经接好'); }
function backupContinuation(){ const s=sessions.find(x=>x.id===continuationSourceId); if(!s)return; const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),session:s},null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`dwell-${s.title.replace(/[\\/:*?"<>|]/g,'-').slice(0,36)}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); toast('原会话已导出'); }
const messageViewKeys=new WeakMap();let nextMessageViewKey=0;
function messageViewKey(message){if(!messageViewKeys.has(message))messageViewKeys.set(message,String(++nextMessageViewKey));return messageViewKeys.get(message)}
const safeImageId=id=>/^img_[A-Za-z0-9_-]{43}$/.test(String(id||'')),safePhotoId=id=>/^photo_[A-Za-z0-9_-]{32}$/.test(String(id||''));
function safeMessageImages(images){return Array.isArray(images)?images.filter(image=>safeImageId(image?.imageId)||safePhotoId(image?.photoId)).slice(0,4).map(image=>({...(safeImageId(image.imageId)?{imageId:image.imageId}:{photoId:image.photoId}),mime:['image/jpeg','image/png','image/webp'].includes(image.mime)?image.mime:'image/jpeg',width:Number(image.width)||0,height:Number(image.height)||0,byteSize:Number(image.byteSize)||0,note:String(image.note||'').slice(0,1000),albumName:String(image.albumName||'').slice(0,80),savedAt:Number(image.savedAt)||0})):[]}
function imageContentUrl(image,variant='content'){return image.photoId?`/api/photos/${image.photoId}/${variant}`:`/api/chat/images/${image.imageId}/${variant}`}
function messageImagesMarkup(images){const safe=safeMessageImages(images);if(!safe.length)return '';return `<div class="message-images count-${safe.length}">${safe.map((image,index)=>`<img src="${imageContentUrl(image)}" data-view-image="${index}" ${image.photoId?`data-photo-id="${image.photoId}"`:`data-image-id="${image.imageId}"`} alt="图片 ${index+1}" loading="lazy" decoding="async">`).join('')}</div>`}
function ordinaryBodyIsDuplicate(message){
  const normalize=text=>String(text||'').replace(/\r\n?/g,'\n').trim();
  const body=normalize(ordinaryAssistantPresentationText(message.content)),texts=(message.toolMessages||[]).map(item=>normalize(item.content));
  return !!body&&(texts.includes(body)||['\n','\n\n'].some(separator=>normalize(texts.join(separator))===body));
}
function renderChatMessage(message,previous){
  if(!message.toolMessages?.length)return renderMessageRow(message,previous);
  const visible=message.toolMessages.map((item,index)=>index?item:{...item,thoughtProcess:message.thoughtProcess,turnId:message.turnId});
  if(message.content&&message.bodyComplete&&!ordinaryBodyIsDuplicate(message))visible.push(message);
  return visible.map((item,index)=>renderMessageRow(item,index?visible[index-1]:previous,index===visible.length-1?message:null)).join('');
}
function renderMessageRow(message,previous,connectionOwner=null){
  const user=message.role==='user',newGroup=!previous||previous.role!==message.role||(!user&&message.turnId&&previous.turnId&&message.turnId!==previous.turnId);
  const date=message.createdAt?new Date(message.createdAt):null;
  const valid=date&&Number.isFinite(date.getTime());
  const pad=value=>String(value).padStart(2,'0');
  const time=valid?`${date.getMonth()+1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`:'时间未记录';
  const thought=message.thoughtProcess?.items?.length&&!user,cloud=thought?`<button type="button" class="thought-cloud" data-thought-turn="${escapeHtml(message.turnId||'')}" aria-label="View thought process">${chatIcons.cloud}</button>`:'';
  const stamp=newGroup?`<div class="message-time ${user?'user':''}" aria-label="${user?'你':'秋秋'} · ${time}"><span class="time-dot"></span><span>${time}</span>${cloud}</div>`:'';
  const content=!user&&message.source!=='tool'?ordinaryAssistantPresentationText(message.content):message.content,images=safeMessageImages(message.images),imageMarkup=messageImagesMarkup(images);
  if(!user&&thought&&!content&&!images.length&&!message.pending&&!message.delivery?.notice)return stamp;
  const presented=content?(images.length?`<div class="message-text">${markup(content)}</div>`:markup(content)):message.delivery?.notice?'':images.length?'':'正在想…';
  return stamp+`<article data-message-view="${messageViewKey(message)}" class="message ${user?'user':''}"><div class="avatar${(user?userAvatarUrl:assistantAvatarUrl)?' has-image':''}" aria-hidden="true">${user?userMessageAvatarMarkup():assistantMessageAvatarMarkup()}</div><div class="bubble ${message.pending?'thinking':''} ${images.length?'has-images':''} ${images.length&&!content?'image-only':''}">${imageMarkup}${presented}${connectionMarkup(connectionOwner||message)}</div></article>`;
}
function renderMessages(scrollToEnd=true){ const box=$('#messages'),s=current(); if(s?.bridge&&!s.messages.length){box.innerHTML=`<div class="continuation-welcome"><span>续窗已接好</span><h2>${escapeHtml(s.title)}</h2><p>原会话仍完整保留。第一条消息发送时，启动包会作为背景交给当前模型。</p><button id="reviewBridge">查看或修改启动包</button></div>`; $('#reviewBridge').onclick=openContinuation; $('#chatTitle').textContent=s.title;return} if(!s||!s.messages.length){box.innerHTML='<div class="welcome"><div class="orb"><span></span></div><h2>有些话，不必急着说完。</h2><p>接上你常用的模型。对话会留在这台浏览器里，慢慢长成日子。</p><button id="welcomeSetup">接一条路进来 →</button></div>'; $('#welcomeSetup').onclick=openSettings; $('#chatTitle').textContent='今天，也在这里';return} box.innerHTML=(s.bridge?'<div class="bridge-marker">◇ 已携带续窗启动包</div>':'')+s.messages.map((m,index)=>renderChatMessage(m,index?s.messages[index-1]:null)).join(''); bindRecoveryActions();bindThoughtClouds(); $('#chatTitle').textContent=s.title; if(scrollToEnd){setViewportBottomAnchor(true);scrollMessagesToBottom(box)} }
let openThoughtTurn='',thoughtReturnFocus=null,thoughtDragStart=0,thoughtDragging=false;
function thoughtOwner(turnId){return current()?.messages.find(message=>message.role==='assistant'&&message.turnId===turnId&&message.thoughtProcess?.items?.length)}
function renderThoughtSheet(process){const list=$('#thoughtTimeline');if(!list)return;list.replaceChildren(...(process?.items||[]).map(item=>{const row=document.createElement('div');row.className=`thought-item ${item.type}`;const icon=document.createElement('span');icon.className='thought-item-icon';icon.setAttribute('aria-hidden','true');icon.textContent=item.type==='tool_call'?'✦':'◷';const body=document.createElement('div'),title=document.createElement(item.type==='tool_call'?'strong':'p');title.textContent=item.type==='tool_call'?(item.displayName||'工具'):(item.text||'');body.append(title);if(item.type==='tool_call'){const meta=document.createElement('small');meta.textContent=[item.toolName,item.inputSummary,item.status].filter(Boolean).join(' · ');body.append(meta)}row.append(icon,body);return row}))}
function openThoughtProcess(turnId,button){const owner=thoughtOwner(turnId);if(!owner)return;openThoughtTurn=turnId;thoughtReturnFocus=button;renderThoughtSheet(owner.thoughtProcess);$('#thoughtBackdrop').hidden=false;$('#thoughtSheet').hidden=false;requestAnimationFrame(()=>{$('#thoughtBackdrop').classList.add('on');$('#thoughtSheet').classList.add('on');$('#thoughtSheet').focus({preventScroll:true})});document.body.classList.add('thought-open')}
function closeThoughtProcess(){if(!openThoughtTurn)return;const sheet=$('#thoughtSheet'),backdrop=$('#thoughtBackdrop');sheet.classList.remove('dragging','on');backdrop.classList.remove('on');backdrop.style.removeProperty('--thought-backdrop-opacity');document.body.classList.remove('thought-open');const focus=thoughtReturnFocus;openThoughtTurn='';setTimeout(()=>{sheet.hidden=true;backdrop.hidden=true;sheet.style.removeProperty('--thought-drag');focus?.focus?.({preventScroll:true})},260)}
function bindThoughtClouds(){$$('.thought-cloud').forEach(button=>button.onclick=()=>openThoughtProcess(button.dataset.thoughtTurn,button))}
function setupThoughtSheet(){const sheet=$('#thoughtSheet'),body=$('#thoughtBody'),backdrop=$('#thoughtBackdrop'),handle=$('#thoughtHandle');if(!sheet)return;backdrop.onclick=event=>{if(event.target===backdrop)closeThoughtProcess()};sheet.onclick=event=>event.stopPropagation();sheet.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();closeThoughtProcess()}};const start=event=>{thoughtDragStart=event.clientY;thoughtDragging=true;sheet.classList.add('dragging');handle.setPointerCapture?.(event.pointerId);event.preventDefault?.()};const move=event=>{if(!thoughtDragging)return;const dy=Math.max(0,event.clientY-thoughtDragStart);sheet.style.setProperty('--thought-drag',`${dy}px`);backdrop.style.setProperty('--thought-backdrop-opacity',String(Math.max(.28,1-dy/360)));event.preventDefault?.()};const end=event=>{if(!thoughtDragging)return;thoughtDragging=false;const dy=Math.max(0,event.clientY-thoughtDragStart);sheet.classList.remove('dragging');backdrop.style.removeProperty('--thought-backdrop-opacity');if(dy>90)closeThoughtProcess();else sheet.style.removeProperty('--thought-drag');handle.releasePointerCapture?.(event.pointerId)};handle.onpointerdown=start;handle.onpointermove=move;handle.onpointerup=end;handle.onpointercancel=end}
function renderAll(scrollToEnd=true){renderSessions();renderMessages(scrollToEnd);updateStatus()}

let memoryItems=[],memorySearchResults=null,memorySearchTimer=0,memorySearchRequestSequence=0,memoryLoaded=false;
const memoryState={activePrimaryFilter:'all',secondaryFilters:{status:'all',domain:'',tag:''},sortMode:'recent',searchQuery:'',scrollPosition:0,selectedBucketId:''};
const memoryDate=value=>value?new Date(value).toLocaleDateString('zh-CN'):'—';
const memoryPrimaryMatches=(item,filter)=>filter==='all'||filter==='pinned'&&item.pinned||filter==='archived'&&['archive','archived'].includes(String(item.type||'').toLowerCase())||String(item.type||'').toLowerCase()===filter;
const memorySecondaryMatches=item=>{const filters=memoryState.secondaryFilters;if(filters.status==='unresolved'&&item.resolved!==false)return false;if(filters.status==='resolved'&&item.resolved!==true)return false;if(filters.status==='digested'&&item.digested!==true)return false;if(filters.domain&&!(item.domains||[]).includes(filters.domain))return false;if(filters.tag&&!(item.tags||[]).includes(filters.tag))return false;return true};
const memoryTime=(item,mode)=>{const raw=mode==='recent'?(item.lastActiveAt||item.createdAt):item.createdAt;const parsed=Date.parse(raw||'');return Number.isFinite(parsed)?parsed:0};
function sortMemoryItems(items,mode=memoryState.sortMode){return [...items].sort((a,b)=>mode==='created-asc'?memoryTime(a,'created')-memoryTime(b,'created'):mode==='created-desc'?memoryTime(b,'created')-memoryTime(a,'created'):mode==='importance'?(Number(b.importance)||0)-(Number(a.importance)||0):memoryTime(b,'recent')-memoryTime(a,'recent'))}
function visibleMemoryItems(){return sortMemoryItems((memorySearchResults||memoryItems).filter(item=>memoryPrimaryMatches(item,memoryState.activePrimaryFilter)&&memorySecondaryMatches(item)))}
function updateMemoryCounts(){for(const filter of ['all','dynamic','permanent','archived','pinned']){const target=$(`[data-count="${filter}"]`);if(target)target.textContent=memoryItems.filter(item=>memoryPrimaryMatches(item,filter)).length}const applied=Object.entries(memoryState.secondaryFilters).filter(([key,value])=>value&&(key==='status'?value!=='all':true)).length;$('#memoryFilterCount').textContent=applied?String(applied):''}
function renderMemoryList(){const list=$('#memoryList');if(!list)return;const items=visibleMemoryItems(),savedScroll=memoryState.scrollPosition;updateMemoryCounts();list.innerHTML=items.map(item=>`<button type="button" class="memory-card" data-memory-id="${escapeHtml(item.id)}"><div class="memory-card-top"><h3>${escapeHtml(item.name)}</h3><span class="memory-card-type">${escapeHtml(item.type||'memory')}${item.pinned?' · PINNED':''}</span></div><p>${escapeHtml(item.contentPreview||item.content||'暂无内容')}</p><div class="memory-tags">${[...(item.domains||[]),...(item.tags||[])].slice(0,5).map(tag=>`<span>${escapeHtml(tag)}</span>`).join('')}</div><div class="memory-meta"><span>最近活动 ${escapeHtml(memoryDate(item.lastActiveAt||item.createdAt))}</span><span>重要度 ${item.importance??'—'}</span></div></button>`).join('')||`<div class="memory-empty">${memoryState.searchQuery?'没有找到相关记忆':'这里暂时没有匹配的记忆。'}</div>`;list.querySelectorAll?.('[data-memory-id]').forEach(card=>card.onclick=()=>openMemoryDetail(card.dataset.memoryId));const schedule=globalThis.requestAnimationFrame||((callback)=>setTimeout(callback,16));schedule(()=>{$('#memoryBody').scrollTop=savedScroll})}
function memoryDetailMarkup(item,loading=false){const fields=[['类型',item.type],['Pinned',item.pinned],['Resolved',item.resolved],['已消化',item.digested],['Tags',(item.tags||[]).join(', ')],['Domains',(item.domains||[]).join(', ')],['重要度',item.importance],['Valence',item.valence],['Arousal',item.arousal],['激活次数',item.activationCount],['创建时间',item.createdAt],['最近活跃',item.lastActiveAt],['ID',item.id]];return `<div class="memory-detail-content"><small>正文</small>${escapeHtml(item.content||item.contentPreview||'暂无内容')}</div>${loading?'<div class="memory-loading">正在补全详情…</div>':''}<div class="memory-detail-grid">${fields.map(([label,value])=>`<div><small>${label}</small><span>${escapeHtml(value??'—')}</span></div>`).join('')}</div>`}
async function openMemoryDetail(id){const item=memoryItems.find(memory=>memory.id===id)||memorySearchResults?.find(memory=>memory.id===id);if(!item)return;memoryState.selectedBucketId=id;closeSheets();$('#memoryDetailName').textContent=item.name;$('#memoryDetailBody').innerHTML=memoryDetailMarkup(item,true);$('#shade').classList.add('on');$('#memoryDetail').classList.add('on');try{const response=await fetch(`/api/ombre-dashboard/buckets/${encodeURIComponent(id)}`),detail=await response.json();if(!response.ok)throw new Error(detail.error||'ombre_upstream_error');Object.assign(item,detail);if($('#memoryDetail').classList.contains('on')){$('#memoryDetailName').textContent=item.name;$('#memoryDetailBody').innerHTML=memoryDetailMarkup(item)}}catch(error){if($('#memoryDetail').classList.contains('on'))$('#memoryDetailBody').insertAdjacentHTML('beforeend',`<div class="memory-loading">详情读取失败：${escapeHtml(error.message)}</div>`)}}
async function loadMemoryDashboard(){const list=$('#memoryList');if(list&&!memoryLoaded)list.innerHTML='<div class="memory-empty">正在读取记忆…</div>';const [statusResult,bucketsResult]=await Promise.allSettled([fetch('/api/ombre-dashboard/status').then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);return data}),fetch('/api/ombre-dashboard/buckets').then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);return data.items||[]})]);if(statusResult.status==='fulfilled'){$('#memoryStatus').textContent=`OB ${statusResult.value.version||'online'} · 已连接`;$('#memoryCount').textContent=statusResult.value.memoryCount??'—'}else{$('#memoryStatus').textContent=`未连接 · ${statusResult.reason.message}`;$('#memoryCount').textContent='—'}if(bucketsResult.status==='fulfilled'){memoryItems=bucketsResult.value;memoryLoaded=true;$('#memoryCount').textContent=memoryItems.length;populateMemoryFilterOptions();renderMemoryList()}else if(list)list.innerHTML=`<div class="memory-empty">读取失败：${escapeHtml(bucketsResult.reason.message)}</div>`}
async function searchMemory(query){const searchQuery=query.trim(),requestSequence=++memorySearchRequestSequence;memoryState.searchQuery=searchQuery;if(!searchQuery){memorySearchResults=null;renderMemoryList();return}try{const response=await fetch(`/api/ombre-dashboard/search?q=${encodeURIComponent(searchQuery)}`),data=await response.json();if(requestSequence!==memorySearchRequestSequence)return;if(!response.ok)throw new Error(data.error);memorySearchResults=data.items||[];renderMemoryList()}catch(error){if(requestSequence===memorySearchRequestSequence)$('#memoryList').innerHTML=`<div class="memory-empty">搜索失败：${escapeHtml(error.message)}</div>`}}
async function runBreathDebug(){const query=$('#breathQuery').value.trim();if(!query)return;$('#breathResult').textContent='正在分析…';try{const response=await fetch(`/api/ombre-dashboard/breath-debug?q=${encodeURIComponent(query)}`),data=await response.json();if(!response.ok)throw new Error(data.error);const lines=[`valence: ${data.valence??'—'} · arousal: ${data.arousal??'—'}`,`threshold: ${data.threshold??'—'} · passed: ${data.passedCount??0}/${data.totalCandidates??0}`,...(data.results||[]).slice(0,20).map(item=>`${item.passed?'✓':'·'} ${item.name||item.id} · ${item.finalScore??'—'}\n  ${Object.entries(item.scores||{}).map(([key,value])=>`${key}:${value}`).join(' · ')}`)];$('#breathResult').textContent=lines.join('\n')}catch(error){$('#breathResult').textContent=`读取失败：${error.message}`}}
function populateMemoryFilterOptions(){const values=key=>unique(memoryItems.flatMap(item=>item[key]||[])).sort((a,b)=>String(a).localeCompare(String(b),'zh-CN'));const fill=(selector,label,items)=>{const select=$(selector),current=select.value;select.innerHTML=`<option value="">${label}</option>`+items.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');select.value=current};fill('#memoryDomainFilter','全部 Domain',values('domains'));fill('#memoryTagFilter','全部 Tag',values('tags'))}
function openMemoryFilters(){populateMemoryFilterOptions();$('#memoryStatusFilter').value=memoryState.secondaryFilters.status;$('#memoryDomainFilter').value=memoryState.secondaryFilters.domain;$('#memoryTagFilter').value=memoryState.secondaryFilters.tag;$('#shade').classList.add('on');$('#memoryFilterSheet').classList.add('on')}
function applyMemoryFilters(){memoryState.secondaryFilters={status:$('#memoryStatusFilter').value,domain:$('#memoryDomainFilter').value,tag:$('#memoryTagFilter').value};closeSheets();renderMemoryList()}
function clearMemoryFilters(){memoryState.secondaryFilters={status:'all',domain:'',tag:''};$('#memoryStatusFilter').value='all';$('#memoryDomainFilter').value='';$('#memoryTagFilter').value='';updateMemoryCounts()}
function closeMemoryDetail(){memoryState.selectedBucketId='';closeSheets()}
function hideProfilePages(){['#assistantPage','#assistantEditPage','#userHubPage','#userProfilePage','#userProfileEditPage'].forEach(id=>$(id).hidden=true)}
function showMemory(){closeTransientUI();hidePhotos();activeAppView='memory';hideProfilePages();$('main>header.chat-floating').hidden=false;$('#messages').hidden=false;$('main>footer').hidden=false;$('#memoryPage').hidden=false;$('main').classList.remove('assistant-mode');$('main').classList.add('memory-mode');$('#chatNav').classList.remove('active');$('#memoryNav').classList.add('active');$('aside').classList.remove('on');$('#memorySearch').value=memoryState.searchQuery;$('#memorySort').value=memoryState.sortMode;const schedule=globalThis.requestAnimationFrame||((callback)=>setTimeout(callback,16));schedule(()=>{$('#memoryBody').scrollTop=memoryState.scrollPosition});if(!memoryLoaded)loadMemoryDashboard();else renderMemoryList();scheduleVisualViewportSync()}
function showChat(){memoryState.scrollPosition=$('#memoryBody')?.scrollTop||memoryState.scrollPosition;closeTransientUI();hidePhotos();activeAppView='chat';$('#memoryPage').hidden=true;hideProfilePages();$('main>header.chat-floating').hidden=false;$('#messages').hidden=false;$('main>footer').hidden=false;$('main').classList.remove('memory-mode');$('main').classList.remove('assistant-mode');$('#memoryNav').classList.remove('active');$('#chatNav').classList.add('active');$('aside').classList.remove('on');renderAll(false);scheduleVisualViewportSync()}
let photosAlbums=[],photosItems=[],activeAlbum=null,viewerItems=[],viewerIndex=0,viewerReturnScroll=0,viewerStartX=0,selectedMood='';
const photoDate=value=>value?new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(new Date(value)):'';
function hidePhotos(){if($('#photosPage'))$('#photosPage').hidden=true;if($('#albumPage'))$('#albumPage').hidden=true;$('#photosNav')?.classList.remove('active')}
async function photoJson(url,options){const response=await fetch(url,options),data=await response.json();if(!response.ok)throw new Error(data.error||'Photos unavailable');return data}
async function showPhotos(){closeTransientUI();activeAppView='photos';hideProfilePages();$('#memoryPage').hidden=true;$('main>header.chat-floating').hidden=true;$('#messages').hidden=true;$('main>footer').hidden=true;$('main').classList.remove('memory-mode');$('main').classList.add('assistant-mode');$('#photosPage').hidden=false;$('#albumPage').hidden=true;$$('aside nav button').forEach(button=>button.classList.toggle('active',button.id==='photosNav'));$('aside').classList.remove('on');await loadPhotos()}
async function loadPhotos(){const [albumsData,photosData]=await Promise.all([photoJson('/api/photos/albums'),photoJson('/api/photos?limit=100&offset=0')]);photosAlbums=albumsData.albums||[];photosItems=photosData.photos||[];$('#photosStats').textContent=`${photosItems.length} photos · ${photosAlbums.length} albums`;const keeps=photosItems.filter(photo=>!photo.albumId);const groups=[...(keeps.length?[{albumId:'keeps',name:'Keeps',mood:'',note:'',photoCount:keeps.length,photos:keeps}]:[]),...photosAlbums.map(album=>({...album,photos:photosItems.filter(photo=>photo.albumId===album.albumId)}))];$('#albumList').innerHTML=groups.map(album=>`<button class="album-block" data-album="${album.albumId}"><div class="album-heading"><h2>${escapeHtml(album.name)}</h2>${album.mood?`<em>${escapeHtml(album.mood)}</em>`:''}<span>${album.photoCount||album.photos.length}</span></div>${album.note?`<p>${escapeHtml(album.note)}</p>`:''}<div class="album-previews">${album.photos.slice(0,4).map(photo=>`<img src="${photo.thumbnailUrl}" alt="" loading="lazy">`).join('')}</div></button>`).join('')||'<div class="album-empty">还没有收藏的照片。</div>';$$('[data-album]').forEach(button=>button.onclick=()=>openAlbum(button.dataset.album))}
function openAlbum(id){activeAlbum=id==='keeps'?{albumId:'keeps',name:'Keeps',mood:'',note:'',photos:photosItems.filter(photo=>!photo.albumId)}:{...photosAlbums.find(album=>album.albumId===id),photos:photosItems.filter(photo=>photo.albumId===id)};if(!activeAlbum)return;$('#photosPage').hidden=true;$('#albumPage').hidden=false;$('#albumTitle').textContent=activeAlbum.name;$('#albumMeta').innerHTML=`<h1>${escapeHtml(activeAlbum.name)}</h1><p>${[activeAlbum.mood,activeAlbum.note,`${activeAlbum.photos.length} photos`].filter(Boolean).map(escapeHtml).join(' · ')}</p>`;$('#albumGrid').innerHTML=activeAlbum.photos.map((photo,index)=>`<button class="photo-tile" data-album-photo="${index}"><img src="${photo.thumbnailUrl}" alt="" loading="lazy"><small>Saved ${escapeHtml(photoDate(photo.savedAt))}</small>${photo.note?`<p>${escapeHtml(photo.note)}</p>`:''}</button>`).join('')||'<div class="album-empty">这本相册还是空的。</div>';$$('[data-album-photo]').forEach(button=>button.onclick=()=>openViewer(activeAlbum.photos,Number(button.dataset.albumPhoto)))}
function openAlbumSheet(){selectedMood='';$('#albumName').value='';$('#albumNote').value='';$$('#albumMoods button').forEach(button=>button.classList.remove('on'));$('#shade').classList.add('on');$('#albumSheet').classList.add('on')}
async function createAlbumFromSheet(){const name=$('#albumName').value.trim();if(!name)return toast('先给相册起个名字');await photoJson('/api/photos/albums',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,mood:selectedMood||null,note:$('#albumNote').value.trim()||null})});closeSheets();await loadPhotos();toast('相册建好了')}
function viewerMeta(image){return [image.note,image.albumName,image.savedAt?`Saved ${photoDate(image.savedAt)}`:''].filter(Boolean).map(escapeHtml).join(' · ')}
function renderViewer(){const image=viewerItems[viewerIndex];if(!image)return closeViewer();$('#viewerCount').textContent=`${viewerIndex+1}/${viewerItems.length}`;$('#viewerImage').src=imageContentUrl(image);$('#viewerMeta').innerHTML=viewerMeta(image);$('#saveViewerPhoto').hidden=!!image.photoId;$('#sendViewerPhoto').hidden=!image.photoId}
function openViewer(items,index=0){viewerItems=safeMessageImages(items.length<=4?items:items.map(item=>({...item,photoId:item.photoId})));if(items.length>4&&items.every(item=>safePhotoId(item.photoId)))viewerItems=items.map(item=>({...item}));viewerIndex=Math.max(0,Math.min(index,viewerItems.length-1));viewerReturnScroll=$('#messages')?.scrollTop||0;$('#imageViewer').hidden=false;renderViewer()}
function closeViewer(){$('#imageViewer').hidden=true;$('#viewerImage').removeAttribute('src');if(activeAppView==='chat'&&$('#messages'))$('#messages').scrollTop=viewerReturnScroll}
async function saveViewerToPhotos(){const image=viewerItems[viewerIndex];if(!image?.imageId)return;const saved=await photoJson('/api/photos/promote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({imageId:image.imageId})});Object.assign(image,saved);toast('Saved to Photos');renderViewer()}
async function sendViewerToChat(){const image=viewerItems[viewerIndex];if(!image?.photoId)return;if(draftImages.length>=4)return toast('每次最多发送 4 张图片');const data=await photoJson(`/api/photos/${image.photoId}/attach`,{method:'POST'});draftImages.push(...safeMessageImages([data]));closeViewer();showChat();renderAttachmentDraft();updateStatus();toast('Added to Chat')}
function openAddToChat(){if(activeAppView!=='chat')return;closeSheets();if(document.activeElement===$('#input'))$('#input').blur();$('#shade').classList.add('on');$('#addToChatSheet').classList.add('on');$('#addToChatSheet').setAttribute?.('aria-hidden','false')}
function closeAddToChat(){closeSheets()}
function applyTurnEvent(out,event){
  if(event.type==='turn_started'){activeTurnId=event.turnId||'';out.turnId=event.turnId;}
  if(event.type==='user_images')return;
  if(event.type==='assistant_message'){
    if(!out.turnId||event.turnId!==out.turnId||event.source!=='tool'||typeof event.text!=='string'||!event.text.trim()||typeof event.messageId!=='string')return;
    out.toolMessages??=[];
    if(!out.toolMessages.some(item=>item.id===event.messageId))out.toolMessages.push({id:event.messageId,role:'assistant',content:event.text,images:safeMessageImages(event.images),source:'tool',turnId:out.turnId,createdAt:out.createdAt});
  }
  if(event.type==='thought_process'&&event.turnId===out.turnId){out.thoughtProcess={turnId:event.turnId,hasThoughtProcess:!!event.items?.length,items:Array.isArray(event.items)?event.items:[]};persist();if(openThoughtTurn===event.turnId)renderThoughtSheet(out.thoughtProcess)}
  if(event.type==='segment_delta'||(!event.type&&event.delta)){out.content+=event.delta||'';out.bodyComplete=false;if(out.content)out.pending=false;}
  if(['segment_done','turn_done','turn_stopped','turn_error'].includes(event.type))out.bodyComplete=true;
  if(event.type==='turn_stopped')out.stopped=true;
  if(event.type==='turn_error'){const error=new Error(event.error||'回复中断');error.turnError=true;throw error}
}
function renderAttachmentDraft(){const box=$('#attachmentDraft');box.hidden=!draftImages.length&&!pendingImageUploads;const images=draftImages.map((image,index)=>`<div><img src="/api/chat/images/${image.imageId}/thumbnail" alt="待发送图片 ${index+1}"><button type="button" data-remove-image="${image.imageId}" aria-label="移除图片">×</button></div>`).join('');const loading=Array.from({length:pendingImageUploads},()=>'<div class="attachment-loading" aria-label="图片上传中"></div>').join('');box.innerHTML=images+loading;$$('[data-remove-image]').forEach(button=>button.onclick=()=>{draftImages=draftImages.filter(image=>image.imageId!==button.dataset.removeImage);renderAttachmentDraft();updateStatus();syncComposerHeight()});syncComposerHeight()}
async function uploadImages(event){const files=[...(event.target.files||[])];event.target.value='';if(!files.length)return;if(files.length+draftImages.length+pendingImageUploads>4)return toast('每次最多发送 4 张图片');if(profile(activeProvider).runtime!=='claude_tmux')return toast('图片暂时只支持 Claude Code 会话');pendingImageUploads+=files.length;$('#attachImage').disabled=true;renderAttachmentDraft();updateStatus();const results=await Promise.allSettled(files.map(async file=>{const form=new FormData();form.append('images',file);const response=await fetch('/api/chat/images',{method:'POST',body:form}),data=await response.json();if(!response.ok)throw new Error(data.error==='unsupported_image_type'?'这张图片格式暂不支持，请使用 JPEG、PNG 或 WebP':data.error||'图片上传失败');const image=safeMessageImages(data.images)[0];if(!image)throw new Error('图片上传失败');return image}));draftImages.push(...results.filter(result=>result.status==='fulfilled').map(result=>result.value));for(const result of results)if(result.status==='rejected')toast(result.reason?.message||'图片上传失败');pendingImageUploads-=files.length;$('#attachImage').disabled=pendingImageUploads>0;renderAttachmentDraft();updateStatus()}
function messagesNearBottom(box=$('#messages')){return box.scrollHeight-box.scrollTop-box.clientHeight<96}
function scrollMessagesToBottom(box=$('#messages')){if(keyboardViewportPending)return;box.scrollTop=Math.max(0,box.scrollHeight-box.clientHeight)}
function createStreamingView(out,initialFollow=keepBottomThroughViewportResize||messagesNearBottom()){
  const box=$('#messages'),key=messageViewKey(out);
  // Only the message state survives a view rebuild; never retain its bubble.
  const currentBubble=()=>$('#messages')?.querySelector?.('[data-message-view="'+key+'"] .bubble');
  let framePending=false,frameHandle=0,dirty=false,follow=initialFollow;
  const scheduleFrame=globalThis.requestAnimationFrame?.bind(globalThis)||(fn=>setTimeout(fn,16)),cancelFrame=globalThis.cancelAnimationFrame?.bind(globalThis)||clearTimeout;
  const onScroll=()=>{if(!keepBottomThroughViewportResize)follow=messagesNearBottom(box)};
  const flush=()=>{
    framePending=false;frameHandle=0;if(!dirty)return;dirty=false;
    if(out.toolMessages?.length||out.thoughtProcess?.items?.length){if(current()?.messages.includes(out)){renderMessages(false);if(activeAppView==='chat'&&follow&&keepBottomThroughViewportResize)scrollMessagesToBottom($('#messages'));}return;}
    const bubble=currentBubble();
    if(bubble){bubble.textContent=ordinaryAssistantPresentationText(out.content)||'正在想…';bubble.classList.toggle('thinking',!!out.pending);}
    if(bubble&&activeAppView==='chat'&&follow&&keepBottomThroughViewportResize)scrollMessagesToBottom($('#messages'));
  };
  box.classList.add('streaming');box.addEventListener?.('scroll',onScroll,{passive:true});
  return {
    update(event){if(!['segment_delta','segment_done','assistant_message','thought_process'].includes(event.type)&&!(!event.type&&event.delta))return;dirty=true;if(framePending)return;framePending=true;frameHandle=scheduleFrame(flush)},
    finish(){out.pending=false;out.bodyComplete=true;if(framePending)cancelFrame(frameHandle);framePending=false;dirty=true;flush();const bubble=out.toolMessages?.length||out.thoughtProcess?.items?.length?null:currentBubble();if(bubble){const content=ordinaryAssistantPresentationText(out.content);bubble.innerHTML=content?markup(content):'正在想…'}box.removeEventListener?.('scroll',onScroll);box.classList.remove('streaming')},
    isFollowing:()=>follow
  };
}
async function readTurnStream(response,out,onEvent=()=>{},applyEvent=event=>{applyTurnEvent(out,event);return true}){const reader=response.body.getReader(),dec=new TextDecoder();let buf='';const ndjson=(response.headers.get('content-type')||'').includes('application/x-ndjson');let terminalSeen=false;const consume=event=>{if(['turn_done','turn_stopped','turn_error'].includes(event.type))terminalSeen=true;const applied=applyEvent(event);if(applied!==false)onEvent(event);return applied};while(true){const {done,value}=await reader.read();buf+=dec.decode(value||new Uint8Array(),{stream:!done});const parts=ndjson?buf.split('\n'):buf.split('\n\n');buf=parts.pop()||'';for(const part of parts){const raw=ndjson?part.trim():(part.split('\n').find(x=>x.startsWith('data:'))||'').slice(5).trim();if(!raw)continue;try{const event=JSON.parse(raw);consume(event);if(['turn_done','turn_stopped'].includes(event.type)){try{await reader.cancel?.()}catch{}return}}catch(e){if(e instanceof SyntaxError)continue;throw e}}if(done)break}if(buf.trim()){try{consume(JSON.parse(ndjson?buf.trim():buf.replace(/^data:\s*/,'')))}catch(e){if(!(e instanceof SyntaxError))throw e}}if(ndjson&&!terminalSeen)throw new Error('connection_interrupted')}
function connectionMarkup(message){
  const d=message.delivery;if(!d?.notice)return '';
  const action=d.retryAllowed?'retry':d.phase==='connection_lost'&&d.turnId?'status':'';
  return `<div class="connection-note" role="status">${escapeHtml(d.notice)}${action?`<button type="button" data-recovery="${action}" data-request="${escapeHtml(d.clientRequestId)}">${action==='retry'?'重新发送':'查看状态'}</button>`:''}</div>`;
}
function bindRecoveryActions(){
  $$('[data-recovery]').forEach(button=>button.onclick=()=>{
    if(button.dataset.recovery==='status'){if(activeRequest?.clientRequestId===button.dataset.request)recoverConnection(activeRequest);return}
    if(sending)return;
    const session=current(),index=session?.messages.findIndex(m=>m.delivery?.clientRequestId===button.dataset.request),message=session?.messages[index];
    if(!message?.delivery?.retryAllowed||index<1)return;
    message.delivery.retryAllowed=false;persist();$('#input').value=session.messages[index-1].content;draftImages=safeMessageImages(session.messages[index-1].images);renderAttachmentDraft();autoSize();triggerSend();
  });
}
function connectionLog(event,request,details={}){console.info?.('[dwell connection]',{event,clientRequestId:request.clientRequestId,turnId:request.turnId||null,...details})}
function saveDelivery(request,notice='',retryAllowed=false){
  request.out.delivery={clientRequestId:request.clientRequestId,turnId:request.turnId||null,phase:request.phase,runtimeId:request.runtimeId,lastAppliedSeq:request.lastAppliedSeq||0,notice,retryAllowed};persist();
}
function showConnectionNotice(request,notice,retryAllowed=false){
  saveDelivery(request,notice,retryAllowed);
  if(current()?.id===request.sessionId)renderMessages(false);
}
function applyRequestEvent(request,event){
  if(Number.isSafeInteger(event.seq)){
    if(event.seq<1)throw new Error('invalid_turn_sequence');
    const last=request.lastAppliedSeq||0;if(event.seq<=last)return false;
    if(event.seq!==last+1)throw new Error('turn_sequence_gap');
  }
  applyTurnEvent(request.out,event);
  if(Number.isSafeInteger(event.seq)){request.lastAppliedSeq=event.seq;saveDelivery(request,request.out.delivery?.notice||'',request.out.delivery?.retryAllowed||false)}
  return true;
}
function scheduleRecovery(request){if(activeRequest!==request||request.phase!=='connection_lost')return;clearTimeout(request.recoveryTimer);request.recoveryTimer=setTimeout(()=>recoverConnection(request),1500)}
function unrecoverableTurn(request){request.phase='finished';finishGenerating(request);showConnectionNotice(request,'秋秋已经完成回复，但刚才网络中断，内容没有完整传回来。')}
const requestRecoveryDelays=[0,100,200,400,800,1200];
async function recoverByClientRequestId(request){
  if(activeRequest!==request||request.turnId||!request.clientRequestId||request.runtime!=='claude_tmux')return false;
  let expired=false;
  for(const delay of requestRecoveryDelays){
    if(activeRequest!==request)return false;
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    const check=new AbortController(),timer=setTimeout(()=>check.abort(),2000);
    try{
      const response=await fetch('/api/chat/recovery/by-request/'+encodeURIComponent(request.clientRequestId),{signal:check.signal,cache:'no-store'}),status=await response.json();
      if(activeRequest!==request)return false;
      if(status.status==='FOUND'&&typeof status.turnId==='string'){
        request.turnId=status.turnId;activeTurnId=status.turnId;request.phase='connection_lost';saveDelivery(request);await recoverConnection(request);return true;
      }
      if(status.status==='EXPIRED'){expired=true;break}
      if(!['PENDING','NOT_FOUND'].includes(status.status))break;
    }catch{}
    finally{clearTimeout(timer)}
  }
  if(activeRequest===request){finishGenerating(request);showConnectionNotice(request,expired?'网络刚刚断了一下，这条消息的恢复记录已经过期。重新发送可能重复送达。':'网络刚刚断了一下，这条消息可能没有发出去。重新发送可能重复送达。',true)}
  return false;
}
async function recoverConnection(request){
  if(activeRequest!==request||request.phase!=='connection_lost'||!request.turnId||request.runtime!=='claude_tmux')return;
  if(request.recoveryPromise)return request.recoveryPromise;
  if(request.lastRecoveryAt&&Date.now()-request.lastRecoveryAt<1000)return;
  request.lastRecoveryAt=Date.now();
  request.recoveryPromise=(async()=>{
    const check=new AbortController(),timer=setTimeout(()=>check.abort(),5000);
    try{
      connectionLog('recovery_events_query',request,{afterSeq:request.lastAppliedSeq||0});
      const response=await fetch('/api/chat/turn/'+encodeURIComponent(request.turnId)+'/events?afterSeq='+(request.lastAppliedSeq||0),{signal:check.signal,cache:'no-store'});
      const status=await response.json();
      if(activeRequest!==request)return;
      if(!response.ok||status.turnId!==request.turnId||status.recoverable===false||!Array.isArray(status.events)){unrecoverableTurn(request);return}
      for(const event of status.events){if(activeRequest!==request)return;const applied=applyRequestEvent(request,event);if(applied!==false){if(!request.view&&['turn_started','segment_delta','segment_done','assistant_message'].includes(event.type)){request.out.pending=true;request.view=createStreamingView(request.out)}request.view?.update(event);if(event.type==='segment_delta'||event.type==='assistant_message')request.phase='connection_lost';if(['turn_done','turn_stopped'].includes(event.type)){request.phase='finished';if(request.out.delivery)request.out.delivery.notice='';finishGenerating(request,event.type==='turn_stopped');return}}}
      connectionLog('recovery_result',request,{state:status.state,receivedByRuntime:status.receivedByRuntime,latestSeq:status.latestSeq});
      if(activeRequest!==request)return;
      if(status.state==='not_delivered'&&status.receivedByRuntime===false){request.phase='finished';finishGenerating(request);showConnectionNotice(request,'这条消息没有成功送达。',true)}
      else if(status.finished)unrecoverableTurn(request);
      else{showConnectionNotice(request,status.receivedByRuntime===true?'秋秋已经收到，回复仍在继续。':'连接中断，正在确认这条消息是否已经送达。');scheduleRecovery(request)}
    }catch(error){
      if(activeRequest!==request)return;
      if(error.turnError){request.phase='finished';finishGenerating(request);showConnectionNotice(request,'秋秋的回复遇到了一点问题，请稍后再试。');return}
      showConnectionNotice(request,'网络刚刚断了一下，秋秋还在。暂时无法确认回复状态，可稍后查看状态。');scheduleRecovery(request)
    }finally{clearTimeout(timer)}
  })().finally(()=>{if(request.recoveryPromise)request.recoveryPromise=null});
  return request.recoveryPromise;
}
async function handleConnectionLoss(request,error){
  if(request.stopped||request.finished)return;
  const hadTurn=!!request.turnId;request.phase='connection_lost';
  request.view?.finish();request.view=null;
  connectionLog('connection_lost',request,{hadTurn});
  if(error.turnError){request.phase='finished';finishGenerating(request);showConnectionNotice(request,'秋秋的回复遇到了一点问题，请稍后再试。');return}
  if(!hadTurn){
    await recoverByClientRequestId(request);return;
  }
  showConnectionNotice(request,'连接中断，正在确认这条消息是否已经送达。');
  if(request.runtime==='claude_tmux')await recoverConnection(request);
  else{finishGenerating(request);showConnectionNotice(request,'网络刚刚断了一下，回复没有完整传回来。')}
}
function finishGenerating(request,stopped=false){
  if(activeRequest!==request)return;
  clearTimeout(request.recoveryTimer);
  if(request.phase!=='connection_lost')request.phase='finished';
  if(stopped){request.phase='finished';request.stopped=true;request.out.stopped=true;request.out.pending=false;if(request.out.delivery)request.out.delivery.notice='已停止'}
  request.view?.finish();request.finished=true;saveDelivery(request,request.out.delivery?.notice||'');
  activeRequest=null;sending=false;stopping=false;activeTurnId='';
  persist();renderSessions();updateStatus();
}
async function stopActiveReply(){
  const p=profile(activeProvider),request=activeRequest,turnId=activeTurnId;
  if(!sending||stopping||p.runtime!=='claude_tmux'||!turnId)return;
  stopping=true;updateStatus();
  try{
    const r=await fetch('/api/chat/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runtimeId:p.runtimeId,turnId})});
    const data=await r.json();
    if(!r.ok||!data.ok)throw new Error('暂未确认停止，请稍后重试');
    const terminal=['stopped','already_stopped','no_active_turn'].includes(data.status)||(data.status==='stop_unconfirmed'&&data.turnReleased===true&&data.stopSent===true);
    if(terminal&&request){finishGenerating(request,true);request.controller.abort();toast('已停止')}
  }catch(e){toast('暂未确认停止，请稍后重试')}
  finally{if(activeRequest===request){stopping=false;updateStatus()}}
}
async function send(){ const text=$('#input').value.trim(),images=safeMessageImages(draftImages); if(sending){if(profile(activeProvider).runtime==='claude_tmux')await stopActiveReply();return} if(!text&&!images.length)return; if(!configured())return openSettings(); if(!current())newChat(); const followStream=messagesNearBottom(),s=current(),userMessage={role:'user',content:text,images,createdAt:Date.now()}; s.provider=activeProvider; s.messages.push(userMessage); if(s.messages.filter(m=>m.role==='user').length===1)s.title=(text||'图片').slice(0,22); s.messages.push({role:'assistant',content:'',pending:true,createdAt:Date.now()}); $('#input').value='';draftImages=[];renderAttachmentDraft();autoSize(); sending=true;activeTurnId='';persist();renderAll(followStream); controller=new AbortController(); const request={controller,out:s.messages.at(-1),userMessage,stopped:false,finished:false,phase:'pre_turn',lastAppliedSeq:0,clientRequestId:generateId(),runtime:profile(activeProvider).runtime,runtimeId:profile(activeProvider).runtimeId,sessionId:s.id};activeRequest=request;
  const p=profile(activeProvider); const apiMessages=[]; if(p.system)apiMessages.push({role:'system',content:p.system}); if(s.bridge)apiMessages.push({role:'system',content:`以下是从上一段会话提炼、由用户确认的续窗启动包。把它作为背景，不要声称看过未包含的旧会话。\n\n${s.bridge}`}); apiMessages.push(...s.messages.filter(m=>!m.pending).map(({role,content})=>({role,content})));
  const requestMessages=p.runtime==='claude_tmux'?[{role:'user',content:text}]:apiMessages;
  const out=s.messages.at(-1),streamView=createStreamingView(out,followStream);request.view=streamView;saveDelivery(request);connectionLog('fetch_opened',request);try{ const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json','accept':'application/x-ndjson'},body:JSON.stringify({config:p,messages:requestMessages,clientRequestId:request.clientRequestId,imageIds:images.map(image=>image.imageId)}),signal:controller.signal}); if(!r.ok){const e=await r.json();throw new Error([e.error,e.detail].filter(Boolean).join('\n'))} connectionLog('stream_opened',request); await readTurnStream(r,out,event=>{if(event.type==='turn_started'){request.turnId=event.turnId;request.phase='turn_started';saveDelivery(request);connectionLog('turn_started',request)}if(event.type==='user_images'&&request.userMessage){request.userMessage.images=safeMessageImages(event.images);persist()}if(event.type==='segment_delta'&&request.phase!=='streaming'){request.phase='streaming';saveDelivery(request);connectionLog('first_output',request)}if(event.type==='assistant_message'){request.phase='streaming';saveDelivery(request);persist();}streamView.update(event);if(['turn_done','turn_stopped'].includes(event.type)){request.phase='finished';finishGenerating(request,event.type==='turn_stopped')}},event=>applyRequestEvent(request,event)); if(!out.content&&!out.toolMessages?.length&&!out.thoughtProcess?.items?.length)out.content=out.stopped?'（已停止）':'（对面没有返回文字）';
  }catch(e){out.pending=false;if(!request.turnId&&images.length){draftImages=safeMessageImages(images);renderAttachmentDraft()}await handleConnectionLoss(request,e)}finally{if(!request.finished&&request.phase!=='connection_lost')finishGenerating(request);persist()}}
async function triggerSend(){try{await send()}catch(e){toast('网络刚刚断了一下，请稍后再试。')}}
function preserveComposerFocusOnSend(event){if(document.activeElement===$('#input'))event.preventDefault()}
function autoSize(){const t=$('#input');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,160)+'px';updateStatus();if($('#toast').classList.contains?.('on'))positionToast()}
$('#settingsBtn').onclick=openUserHub; $('#welcomeSetup').onclick=openSettings; $('#modelBtn').onclick=()=>{if(profile(activeProvider).runtime!=='claude_tmux')openSettings()}; $('#closeSettings').onclick=closeConnections; $('#closeContinue').onclick=$('#shade').onclick=closeSheets; $('#menuBtn').onclick=()=>{$('aside').classList.toggle('on')}; $('#asideClose').onclick=()=>{$('aside').classList.remove('on')}; $('#send').onpointerdown=preserveComposerFocusOnSend; $('#send').onclick=triggerSend; $('#continueBtn').onclick=openContinuation; $('#startContinue').onclick=startContinuation; $('#backupContinue').onclick=backupContinuation; $('#continueDraft').oninput=()=>updateContinueStats(buildContinuation(sessions.find(s=>s.id===continuationSourceId)||{messages:[],title:''}).kept,(sessions.find(s=>s.id===continuationSourceId)?.messages||[]).length);
$('#attachImage').onclick=openAddToChat;$('#attachmentInput').onchange=uploadImages;$('#cameraInput').onchange=uploadImages;
$('#input').oninput=$('#input').onchange=$('#input').oncompositionend=autoSize; $('#input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();triggerSend()}}; $$('[data-soon]').forEach(b=>b.onclick=()=>toast('这间屋子还在慢慢盖'));
$('#input').onfocus=()=>{if(messagesNearBottom()||keepBottomThroughViewportResize)setViewportBottomAnchor(true);scheduleVisualViewportSync()};$('#input').onblur=scheduleVisualViewportSync;$('#messages').addEventListener?.('touchmove',cancelViewportBottomAnchor,{passive:true});$('#messages').addEventListener?.('wheel',event=>{if(event.deltaY<0)cancelViewportBottomAnchor()},{passive:true});
$('#chatNav').onclick=showChat;$('#memoryNav').onclick=showMemory;$('#memoryMenu').onclick=()=>{$('aside').classList.toggle('on')};$('#closeMemoryDetail').onclick=closeMemoryDetail;$('#openMemoryFilter').onclick=openMemoryFilters;$('#closeMemoryFilter').onclick=closeSheets;$('#applyMemoryFilter').onclick=applyMemoryFilters;$('#clearMemoryFilter').onclick=clearMemoryFilters;$$('#memoryFilters button').forEach(button=>button.onclick=()=>{memoryState.activePrimaryFilter=button.dataset.filter;$$('#memoryFilters button').forEach(item=>item.classList.toggle('on',item===button));renderMemoryList()});$('#memorySort').onchange=event=>{memoryState.sortMode=event.target.value;renderMemoryList()};$('#memorySearch').oninput=event=>{memoryState.searchQuery=event.target.value;clearTimeout(memorySearchTimer);memorySearchTimer=setTimeout(()=>searchMemory(event.target.value),300)};
$('#memorySearch').onfocus=$('#memorySearch').onblur=scheduleVisualViewportSync;$('#memoryBody').addEventListener?.('scroll',()=>{memoryState.scrollPosition=$('#memoryBody').scrollTop},{passive:true});
$('#runBreath').onclick=runBreathDebug;$('#breathQuery').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();runBreathDebug()}};
$('#photosNav').onclick=()=>showPhotos().catch(error=>toast(error.message));$('#closePhotos').onclick=showChat;$('#closeAlbum').onclick=()=>{$('#albumPage').hidden=true;$('#photosPage').hidden=false};$('#newAlbum').onclick=openAlbumSheet;$('#cancelAlbum').onclick=closeSheets;$('#createAlbum').onclick=()=>createAlbumFromSheet().catch(error=>toast(error.message));$$('#albumMoods button').forEach(button=>button.onclick=()=>{selectedMood=button.dataset.mood;$$('#albumMoods button').forEach(item=>item.classList.toggle('on',item===button))});
$('#closeAssistant').onclick=showChat;$('#editAssistant').onclick=openAssistantEdit;$('#cancelAssistantEdit').onclick=cancelAssistantEdit;$('#saveAssistantEdit').onclick=saveAssistantEdit;$('#changeAssistantAvatar').onclick=selectAssistantAvatar;$('#assistantAvatarInput').onchange=previewAssistantAvatar;
$('#closeUserHub').onclick=showChat;$('#myProfile').onclick=openUserProfile;$('#closeUserProfile').onclick=openUserHub;$('#editUserProfile').onclick=openUserEdit;$('#cancelUserProfileEdit').onclick=cancelUserEdit;$('#saveUserProfileEdit').onclick=saveUserEdit;$('#changeUserAvatar').onclick=()=>$('#userAvatarInput').click();$('#userAvatarInput').onchange=previewUserAvatar;$('#openConnections').onclick=openConnections;$$('[data-profile-soon]').forEach(button=>button.onclick=()=>toast('Coming soon'));
$('#save').onclick=async()=>{saveDraft();const p=profile(activeProvider);if(p.runtime==='claude_tmux'){const d=await refreshRuntimeStatus();if(d.state!=='connected'){ $('#testMsg').className='test-msg bad';$('#testMsg').textContent=d.error||`Claude runtime：${d.state}`;return }}persist();updateStatus();closeSettings();toast('接好了，这条路记住了')};
$('#test').onclick=async()=>{saveDraft();const p=profile(activeProvider);$('#testMsg').className='test-msg';$('#testMsg').textContent='正在敲门…';try{if(p.runtime==='claude_tmux'){const d=await refreshRuntimeStatus();if(d.state!=='connected')throw new Error(`Claude runtime：${d.state}`);persist();updateStatus();$('#testMsg').textContent=`门开了 · ${d.sessionName||p.runtimeId}`;return}const r=await fetch('/api/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:p})});const d=await r.json();if(!r.ok)throw new Error([d.error,d.detail].filter(Boolean).join('\n'));persist();updateStatus();$('#testMsg').textContent=`门开了 · ${d.model}`}catch(e){$('#testMsg').className='test-msg bad';$('#testMsg').textContent=e.message}};
if(activeId&&!current())activeId=''; $('#togetherDays').textContent=String(getTogetherDays());renderAssistantProfile();renderUserProfile();renderProviders();selectProvider(activeProvider,false);renderAttachmentDraft();setupThoughtSheet();renderAll();
globalThis.addEventListener?.('resize',scheduleVisualViewportSync);globalThis.visualViewport?.addEventListener?.('resize',scheduleVisualViewportSync);globalThis.visualViewport?.addEventListener?.('scroll',scheduleVisualViewportSync);if(globalThis.ResizeObserver)new ResizeObserver(syncComposerHeight).observe($('main>footer'));syncVisualViewport();syncComposerHeight();

$('#chatMore').onclick=openAssistantDetails;
$('#closeAddToChat').onclick=closeAddToChat;$('#allPhotos').onclick=$('#openPhotoLibrary').onclick=()=>{$('#attachmentInput').click();closeAddToChat()};$('#openCamera').onclick=()=>{$('#cameraInput').click();closeAddToChat()};
document.addEventListener?.('keydown',event=>{if(event.key==='Escape'&&$('#addToChatSheet').classList.contains('on'))closeAddToChat()});
$('#closeViewer').onclick=closeViewer;$('#saveViewerPhoto').onclick=()=>saveViewerToPhotos().catch(error=>toast(error.message));$('#sendViewerPhoto').onclick=()=>sendViewerToChat().catch(error=>toast(error.message));
$('#messages').addEventListener?.('click',event=>{const target=event.target.closest?.('[data-view-image]');if(!target)return;const group=[...target.closest('.message-images').querySelectorAll('[data-view-image]')],items=group.map(image=>image.dataset.photoId?{photoId:image.dataset.photoId}:{imageId:image.dataset.imageId});openViewer(items,group.indexOf(target))});
$('#viewerStage').addEventListener?.('touchstart',event=>{viewerStartX=event.changedTouches[0]?.clientX||0},{passive:true});$('#viewerStage').addEventListener?.('touchend',event=>{const delta=(event.changedTouches[0]?.clientX||0)-viewerStartX;if(Math.abs(delta)<45)return;viewerIndex=Math.max(0,Math.min(viewerItems.length-1,viewerIndex+(delta<0?1:-1)));renderViewer()},{passive:true});

// Backgrounding and offline events never cancel or resend the chat POST.
const resumeConnectionCheck=()=>{if(document.visibilityState==='hidden'||globalThis.navigator?.onLine===false)return;if(activeRequest?.phase==='connection_lost')recoverConnection(activeRequest)};
globalThis.addEventListener?.('online',resumeConnectionCheck);
globalThis.addEventListener?.('pageshow',resumeConnectionCheck);
globalThis.addEventListener?.('focus',resumeConnectionCheck);
document.addEventListener?.('visibilitychange',resumeConnectionCheck);
// Safari may discard the page while a reply is in flight. Restore only its ID,
// never the POST; expired server metadata must remain an unknown delivery.
function restoreInterruptedConnection(){
  const session=current(),out=session?.messages.at(-1),d=out?.delivery;
  if(activeRequest||!d||d.phase==='finished'||d.retryAllowed||(!d.turnId&&!d.clientRequestId)||profile(session.provider).runtime!=='claude_tmux')return;
  out.pending=true;
  const request={controller:new AbortController(),out,userMessage:[...session.messages].reverse().find(message=>message.role==='user')||null,stopped:false,finished:false,phase:'connection_lost',lastAppliedSeq:Number.isSafeInteger(d.lastAppliedSeq)?d.lastAppliedSeq:0,clientRequestId:d.clientRequestId,turnId:d.turnId,runtime:'claude_tmux',runtimeId:d.runtimeId,sessionId:session.id};
  activeRequest=request;activeTurnId=d.turnId||'';sending=true;updateStatus();
  if(d.turnId)recoverConnection(request);else recoverByClientRequestId(request);
}
restoreInterruptedConnection();
async function recoverLegacySuppressedFinals(){let changed=false;for(const session of sessions)for(const message of session.messages||[]){if(message.role!=='assistant'||message.pending||message.content||message.toolMessages?.length||!message.turnId||!message.thoughtProcess?.items?.length)continue;try{const response=await fetch(`/api/chat/turn/${encodeURIComponent(message.turnId)}/events?afterSeq=0`);if(!response.ok)continue;const replay=await response.json(),events=Array.isArray(replay.events)?replay.events:[],terminal=events.some(event=>['turn_done','turn_stopped'].includes(event.type)),text=events.filter(event=>event.type==='segment_delta'&&typeof event.delta==='string').map(event=>event.delta).join('');if(terminal&&text){message.content=text;message.bodyComplete=true;changed=true}}catch{}}if(changed){persist();renderMessages(false)}return changed}
void recoverLegacySuppressedFinals();
