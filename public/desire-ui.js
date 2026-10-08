/* Owner dashboard only. Thought text stays in this DOM and never enters chat. */
(() => {
  const $ = selector => document.querySelector(selector);
  const labels = Object.freeze({
    curiosity:'好奇',reflection:'沉淀',social:'热闹',libido:'渴',duty:'挂',
    possess:'占',boredom:'无聊',crave:'嘴馋',monitor:'盯',share:'分享欲',
    grieve:'难过',anger:'气',touch:'触碰',joy:'开心'
  });
  const order = Object.keys(labels);
  const colors = Object.freeze({
    curiosity:'#c7a36b',reflection:'#91a294',social:'#c9a06f',libido:'#bd6861',
    duty:'#83a8bb',possess:'#b890a0',boredom:'#a8aaa4',crave:'#c6ad70',
    monitor:'#9a9a96',share:'#d4936e',grieve:'#a3a3a3',anger:'#ad7774',
    touch:'#d39bb1',joy:'#d4b575'
  });
  let whitelist = [];
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const clamp = value => Math.max(0,Math.min(1,Number.isFinite(value)?value:0));
  function progress(value, color) {
    const track=node('span','desire-progress');
    const fill=node('span','desire-progress-fill');
    fill.style.width=`${clamp(value)*100}%`;
    fill.style.backgroundColor=color;
    track.append(fill);
    return track;
  }
  function renderWinner(snapshot) {
    const root=$('#desireWinner');root.replaceChildren();
    if (!snapshot) {root.append(node('p','desire-unavailable','还没有可观察的欲望状态。'));return;}
    if (!labels[snapshot.winner] || !snapshot.subjectiveVoice) {
      root.append(node('p','desire-unavailable','此刻还没有选出的方向。'));return;
    }
    const card=node('div','desire-winner-card');
    card.append(node('div','desire-winner-eyebrow','●  最想做的一件事'));
    card.append(node('p','desire-winner-voice',snapshot.subjectiveVoice));
    const bottom=node('div','desire-winner-bottom');
    bottom.append(node('span','desire-winner-label',labels[snapshot.winner]));
    bottom.append(progress(snapshot.values?.[snapshot.winner],colors[snapshot.winner]));
    card.append(bottom);root.append(card);
  }
  function renderDrives(snapshot) {
    const root=$('#desireDrives');root.replaceChildren();
    if (!snapshot?.values || !order.every(key => Number.isFinite(snapshot.values[key]))) {
      root.append(node('p','desire-unavailable','还没有可观察的方向。'));return;
    }
    for (const key of order) {
      const row=node('div','desire-drive-row');
      row.append(node('span','desire-drive-label',labels[key]));
      row.append(progress(snapshot.values[key],colors[key]));
      root.append(row);
    }
  }
  function renderThoughts(thoughts) {
    const root=$('#desireThoughts');root.replaceChildren();
    const list=Array.isArray(thoughts)?thoughts:[];
    if (!list.length) {root.append(node('p','desire-thought-empty','现在没有反复打转的念头。'));return;}
    for (const thought of list) {
      if (!thought || typeof thought.text!=='string' || !thought.text.trim()) continue;
      if (thought.stage==='fixation') {
        const card=node('article','desire-fixation');
        const heading=node('div','desire-fixation-heading','● 执念 · 反复浮起');
        if (labels[thought.dimension]) heading.append(node('span','desire-fixation-label',labels[thought.dimension]));
        card.append(heading,node('p','',thought.text));root.append(card);
      } else if (thought.stage==='flit') {
        const item=node('div','desire-flit');
        item.append(node('span','desire-flit-dot','○'),node('p','',thought.text));root.append(item);
      }
    }
    if (!root.childElementCount) root.append(node('p','desire-thought-empty','现在没有反复打转的念头。'));
  }
  function renderWhitelist() {
    const root=$('#whitelistTerms');root.replaceChildren();
    for (const term of whitelist) {
      const chip=node('span','whitelist-chip');chip.append(node('span','',term));
      const remove=node('button','','×');remove.type='button';remove.setAttribute('aria-label',`移除${term}`);
      remove.onclick=()=>mutate('DELETE',term);chip.append(remove);root.append(chip);
    }
  }
  async function load() {
    try {
      const response=await fetch('/api/non-desire/snapshot',{cache:'no-store'});
      if (!response.ok) throw new Error('unavailable');
      const data=await response.json();
      renderWinner(data.available?data.snapshot:null);
      renderDrives(data.available?data.snapshot:null);
      renderThoughts(data.thoughts);
      whitelist=Array.isArray(data.whitelist)?data.whitelist:[];renderWhitelist();
    } catch {
      renderWinner(null);renderDrives(null);renderThoughts([]);
      $('#whitelistStatus').textContent='暂时无法读取名词白名单。';
    }
  }
  async function mutate(method,term) {
    const status=$('#whitelistStatus');status.textContent='';
    const clean=String(term).normalize('NFKC').trim().replace(/\s+/gu,' ');
    if (!clean || [...clean].length>40) {status.textContent='请输入 1 到 40 个字符的名词。';return;}
    try {
      const response=await fetch('/api/non-desire/whitelist',{
        method,headers:{'content-type':'application/json'},body:JSON.stringify({term:clean})
      });
      if (!response.ok) throw new Error('unavailable');
      const data=await response.json();whitelist=data.terms;renderWhitelist();
      if(method==='POST') {$('#whitelistInput').value='';if(!data.added)status.textContent='这个词已经在白名单里。';}
    } catch {status.textContent='暂时无法保存，请稍后再试。';}
  }
  function openSheet() {
    $('#whitelistBackdrop').hidden=false;$('#whitelistSheet').hidden=false;
    $('#whitelistInput').focus();
  }
  function closeSheet() {$('#whitelistSheet').hidden=true;$('#whitelistBackdrop').hidden=true;}
  $('#desireMore').onclick=openSheet;
  $('#closeWhitelist').onclick=closeSheet;
  $('#whitelistBackdrop').onclick=closeSheet;
  $('#whitelistForm').onsubmit=event=>{event.preventDefault();void mutate('POST',$('#whitelistInput').value)};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#whitelistSheet').hidden)closeSheet()});
  globalThis.NonDesireUI=Object.freeze({load,closeSheet});
})();
