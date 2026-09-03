import assert from 'node:assert/strict';
import test from 'node:test';
import { createTmuxTransport } from '../src/runtimes/tmux-transport.mjs';

function fakeRunner(handler=()=>({code:0,stdout:'',stderr:''})){
  const calls=[];
  const runner=async(binary,args,options={})=>{calls.push({binary,args:[...args],...options});return handler(binary,args,options,calls)};
  return {calls,runner};
}

test('injects multiline Unicode and shell-like text only through load-buffer stdin',async()=>{
  const fake=fakeRunner();const waits=[];
  const transport=createTmuxTransport({binary:'/usr/bin/tmux',runner:fake.runner,sleep:async ms=>waits.push(ms)});
  const prompt="中文第一行\r\n## Markdown\r`code` 'single' \"double\" $HOME \\ path 😀\r\n```js\r\nconsole.log(`x`)\r\n```"+'x'.repeat(20000);
  await transport.sendPrompt({sessionName:'dwell-main',turnId:'turn-123',prompt});
  assert.deepEqual(fake.calls.map(call=>call.args),[
    ['load-buffer','-b','dwell-turn-123','-'],
    ['paste-buffer','-p','-b','dwell-turn-123','-t','dwell-main'],
    ['send-keys','-t','dwell-main','Enter'],
    ['delete-buffer','-b','dwell-turn-123']
  ]);
  assert.equal(fake.calls[0].input,prompt.replace(/\r\n?/g,'\n'));
  assert.ok(fake.calls.slice(1).every(call=>!JSON.stringify(call.args).includes('中文第一行')));
  assert.deepEqual(waits,[900]);
});

test('cleans the prompt buffer when paste or Enter fails',async()=>{
  const fake=fakeRunner((binary,args)=>{if(args[0]==='paste-buffer')throw Object.assign(new Error('paste failed'),{code:2});return {code:0,stdout:'',stderr:''}});
  const transport=createTmuxTransport({runner:fake.runner,sleep:async()=>{}});
  await assert.rejects(transport.sendPrompt({sessionName:'dwell',turnId:'t1',prompt:'hello'}),/paste failed/);
  assert.deepEqual(fake.calls.at(-1).args,['delete-buffer','-b','dwell-t1']);
});

test('uses structured tmux metadata and Escape for lifecycle operations',async()=>{
  const fake=fakeRunner((binary,args)=>({code:0,stdout:args[0]==='list-panes'?'%0\t0\tclaude\n%1\t1\tbash\n':'',stderr:''}));
  const transport=createTmuxTransport({runner:fake.runner});
  assert.equal(await transport.hasSession('dwell'),true);
  assert.deepEqual(await transport.inspectSession('dwell'),{exists:true,alive:true,panes:[{paneId:'%0',dead:false,currentCommand:'claude'},{paneId:'%1',dead:true,currentCommand:'bash'}]});
  await transport.interrupt('dwell');
  assert.deepEqual(fake.calls.at(-1).args,['send-keys','-t','dwell','Escape']);
  assert.ok(fake.calls.every(call=>call.args[0]!=='capture-pane'));
});

test('reports a missing session and rejects unsafe identifiers',async()=>{
  const missing=fakeRunner((binary,args)=>{if(args[0]==='has-session')throw Object.assign(new Error('missing'),{code:1});return {code:0,stdout:'',stderr:''}});
  const transport=createTmuxTransport({runner:missing.runner});
  assert.equal(await transport.hasSession('dwell'),false);
  await assert.rejects(transport.interrupt('dwell'),/session 不存在/);
  await assert.rejects(transport.sendPrompt({sessionName:'bad;name',turnId:'t',prompt:'x'}),/只能包含/);
});

test('creates a detached session through argv and safely quotes launch arguments',async()=>{
  const fake=fakeRunner((binary,args)=>{if(args[0]==='has-session')throw Object.assign(new Error('missing'),{code:1});return {code:0,stdout:'',stderr:''}});
  const transport=createTmuxTransport({runner:fake.runner});
  assert.deepEqual(await transport.createSession({sessionName:'dwell',workspace:'/srv/my app',command:'/usr/bin/claude',args:['--settings',`{"text":"it's $safe"}`]}),{created:true});
  const call=fake.calls.at(-1);
  assert.deepEqual(call.args.slice(0,7),['new-session','-d','-s','dwell','-c','/srv/my app',call.args[6]]);
  assert.equal(call.args[6],`'/usr/bin/claude' '--settings' '{"text":"it'"'"'s $safe"}'`);
  assert.ok(!call.args.includes('--settings'));
});
