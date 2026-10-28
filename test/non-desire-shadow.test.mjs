import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, sep} from 'node:path';
import {openNonStore} from '../src/non/store.mjs';
import {createDesireCore} from '../src/non/desire-engine.mjs';
import {
  DRIVE_KEYS, QIUQIU_DESIRE_CONFIG, initialQiuqiuDrive, advanceQiuqiuDrive,
  satisfyQiuqiuEvent, pickIntent, subjectiveVoice
} from '../src/non/drive.mjs';
import {
  QIUQIU_THOUGHT_CONFIG, addExperienceThought, evolveThoughtsOneTick,
  clearLibidoFixationsOnRelease
} from '../src/non/thoughts.mjs';

const HOUR=3_600_000, TICK=5*60_000;
async function temporaryStore(run) {
  const directory=await mkdtemp(join(tmpdir(),'non-desire-shadow-'));
  const path=join(directory,'non.sqlite');
  try { await run(path); }
  finally {
    const resolved=await realpath(directory), root=await realpath(tmpdir());
    if (!resolved.startsWith(root+sep) || !resolved.split(sep).at(-1).startsWith('non-desire-shadow-')) throw new Error('unsafe temporary cleanup target');
    await rm(resolved,{recursive:true,force:false});
  }
}

test('Qiuqiu values preserve 14 dimensions and bounded elapsed growth', () => {
  const initial=initialQiuqiuDrive();
  assert.deepEqual(Object.keys(initial),DRIVE_KEYS);
  assert.equal(initial.grieve,0);
  const hour=advanceQiuqiuDrive(initial,{},0,1,12);
  assert.equal(hour.values.possess,.10+.105);
  assert.equal(hour.values.touch,.10+QIUQIU_DESIRE_CONFIG.touchGrowPerHour);
  assert.equal(hour.values.joy,.10+QIUQIU_DESIRE_CONFIG.joyGrowPerHour);
  assert.ok(Object.values(hour.values).every(value => value >= 0 && value <= 1));
});

test('night freeze, high-state floor and joy faster high decay', () => {
  const initial={...initialQiuqiuDrive(),possess:.80,joy:.80,touch:.80};
  const night=advanceQiuqiuDrive(initial,{},0,1,2);
  assert.equal(night.values.possess,.80);
  assert.equal(night.values.joy,.68);
  assert.equal(night.values.touch,.74);
  const floor=advanceQiuqiuDrive({...initial,possess:.66}, {possess:true},0,1,12);
  assert.equal(floor.values.possess,.65);
  assert.equal(floor.highModes.possess,false);
  const tired=advanceQiuqiuDrive(initial,{touch:true},0,1,12);
  assert.equal(tired.fatigue,QIUQIU_DESIRE_CONFIG.fatigueGainPerHour);
  const recovered=advanceQiuqiuDrive(initialQiuqiuDrive(),{},.5,1,12);
  assert.equal(recovered.fatigue,.5-QIUQIU_DESIRE_CONFIG.fatigueRecoverPerHour);
});

test('satisfaction is mapped, multiplicative and bounded', () => {
  const initial={...initialQiuqiuDrive(),touch:.8,joy:.8,monitor:.8,duty:.8};
  assert.ok(Math.abs(satisfyQiuqiuEvent(initial,'physical_affection').touch-.32)<1e-12);
  assert.ok(Math.abs(satisfyQiuqiuEvent(initial,'good_event').joy-.28)<1e-12);
  assert.ok(Math.abs(satisfyQiuqiuEvent(initial,'monitor_checked').monitor-.56)<1e-12);
  assert.equal(satisfyQiuqiuEvent(initial,'duty_completed').duty,.4);
  assert.equal(satisfyQiuqiuEvent(initial,'sharing').touch,.8);
  assert.throws(()=>satisfyQiuqiuEvent(initial,'unlisted'),/unknown/);
});

test('Qiuqiu thought flit decay, age promotion, feedback and third-feed exit', () => {
  const base={id:'x',text:'SECRET_THOUGHT',dimension:'crave',source:'experience',
    stage:'flit',strength:.5,bornAt:0,updatedAt:0,ageTicks:0,fedCount:0};
  const flit=evolveThoughtsOneTick([base],TICK).thoughts[0];
  assert.equal(flit.strength,.5*.82);
  const threshold=evolveThoughtsOneTick([{...base,strength:.80,ageTicks:2}],TICK).thoughts[0];
  assert.equal(threshold.stage,'flit');
  const promoted=evolveThoughtsOneTick([{...base,strength:.80001,ageTicks:2}],TICK).thoughts[0];
  assert.equal(promoted.stage,'fixation');
  const below=evolveThoughtsOneTick([{...promoted,strength:.77,fedCount:0}],2*TICK);
  assert.equal(below.feedback.crave,undefined);
  const fed=evolveThoughtsOneTick([{...promoted,strength:.78,fedCount:0}],2*TICK);
  assert.equal(fed.feedback.crave,.18);
  assert.equal(fed.thoughts[0].strength,QIUQIU_THOUGHT_CONFIG.postFeedbackStrength);
  assert.equal(fed.thoughts[0].fedCount,1);
  const exit=evolveThoughtsOneTick([{...promoted,strength:.8,fedCount:2}],3*TICK);
  assert.equal(exit.feedback.crave,.18);
  assert.equal(exit.thoughts.length,0);
});

test('thought dedup uses normalized text; cap evicts weakest oldest; release clears libido fixation', () => {
  let pool=[];
  pool=addExperienceThought(pool,{id:'first',text:'ＡＢＣ  test',dimension:'touch',source:'chat',at:0});
  pool=addExperienceThought(pool,{id:'duplicate',text:'abc test',dimension:'touch',source:'chat',at:1});
  assert.equal(pool.length,1);
  assert.equal(pool[0].strength,.65);
  for (let index=0;index<9;index++) pool=addExperienceThought(pool,
    {id:`id-${index}`,text:`experience-${index}`,dimension:'touch',source:'chat',at:index+2});
  assert.equal(pool.filter(item=>item.stage==='flit').length,8);
  assert.equal(pool.some(item=>item.id==='first'),true); // reinforced thought outlives weaker new flits.
  const fixation={...pool[0],stage:'fixation',dimension:'libido'};
  assert.equal(clearLibidoFixationsOnRelease([...pool,fixation]).length,pool.length);
});

test('pickIntent uses injected randomness, fixation bonus and short stability', () => {
  const values={...initialQiuqiuDrive(),touch:.70,joy:.69};
  const selected=pickIntent(values,{random:()=>.99,at:10,fixations:[{dimension:'joy',stage:'fixation',strength:1}]});
  assert.equal(selected.winner,'joy');
  assert.equal(pickIntent(values,{random:()=>0,at:20,previous:selected}),selected);
  assert.equal(pickIntent(values,{random:()=>0,at:selected.until,previous:selected}).winner,'touch');
  assert.equal(selected.until-selected.pickedAt,5*60_000);
});

test('elapsed catch-up is capped, repeated timestamp is idempotent, and reload persists', async () => temporaryStore(async path => {
  let store=await openNonStore({path});
  let core=createDesireCore({store,now:()=>0,random:()=>0});
  core.initialize(0);
  const after=core.advance(10*HOUR);
  assert.equal(after.appliedElapsedMs,6*HOUR);
  assert.ok(after.values.possess <= .80);
  assert.deepEqual(core.advance(10*HOUR),after);
  core.experience({id:'thought-1',text:'SECRET_THOUGHT',dimension:'touch',source:'chat',at:10*HOUR});
  core.satisfy('physical_affection',{id:'event-1',at:10*HOUR});
  const snapshot=core.snapshot(10*HOUR);
  assert.equal(snapshot.thoughtPoolSize,1);
  assert.equal(snapshot.satisfactionEvents.length,1);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_THOUGHT'),false);
  store.close();
  store=await openNonStore({path});
  core=createDesireCore({store,now:()=>10*HOUR,random:()=>0});
  assert.deepEqual(core.snapshot(10*HOUR),snapshot);
  assert.equal(core.satisfy('physical_affection',{id:'event-1',at:10*HOUR}).values.touch,snapshot.values.touch);
  store.close();
}));

test('Beijing frozen interval applies in persisted engine without a scheduler', async () => temporaryStore(async path => {
  const store=await openNonStore({path});
  const start=Date.UTC(2026,0,1,17); // Beijing 01:00.
  const core=createDesireCore({store,now:()=>start});
  core.initialize(start);
  const after=core.advance(start+HOUR);
  assert.equal(after.values.possess,.1);
  assert.equal(after.values.libido,.1);
  assert.ok(after.values.touch>.1);
  store.close();
}));

test('thought evolution uses persisted discrete elapsed ticks across reload', async () => temporaryStore(async path => {
  let store=await openNonStore({path});
  let core=createDesireCore({store,now:()=>0});
  core.initialize(0);
  core.experience({id:'flit-1',text:'private material',dimension:'touch',source:'experience',at:0});
  core.advance(2*TICK);
  assert.equal(store.loadDesire().thoughts[0].strength,.5*.82*.82);
  store.close();
  store=await openNonStore({path});
  core=createDesireCore({store,now:()=>3*TICK});
  core.advance(3*TICK);
  assert.ok(Math.abs(store.loadDesire().thoughts[0].strength-.5*.82**3)<1e-12);
  assert.equal(core.snapshot(3*TICK).thoughtPoolSize,1);
  store.close();
}));

test('voice and diagnostics expose no thought text or raw Drive numbers to a prompt', async () => {
  for (const key of DRIVE_KEYS) {
    const voice=subjectiveVoice(key);
    assert.ok(voice.length>0);
    assert.equal(/\d|%|SECRET_THOUGHT|你必须|必须/.test(voice),false);
  }
  const source=await import('../src/non/desire-engine.mjs');
  assert.equal(typeof source.createDesireCore,'function');
});
