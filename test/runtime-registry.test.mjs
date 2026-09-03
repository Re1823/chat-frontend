import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRuntimeRegistry } from '../src/runtimes/runtime-registry.mjs';

test('registry persists only stable identity/config and reconciles from tmux truth',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dwell-registry-'));const file=join(dir,'runtime.json');
  let exists=true,alive=true;
  const transport={hasSession:async()=>exists,inspectSession:async()=>({alive,panes:[{paneId:'%0',dead:!alive,currentCommand:'claude'}]})};
  try{
    const registry=createRuntimeRegistry({filePath:file,transport});
    await registry.save({runtimeId:'main',sessionName:'dwell',workspace:'/srv/app',claudeCommand:'claude',busy:true,state:'stale'});
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{runtimeId:'main',sessionName:'dwell',workspace:'/srv/app',claudeCommand:'claude'});
    const restarted=createRuntimeRegistry({filePath:file,transport});await restarted.load();
    assert.equal((await restarted.reconcile()).state,'connected');
    alive=false;assert.equal((await restarted.reconcile()).state,'exited');
    exists=false;assert.equal((await restarted.reconcile()).state,'missing');
  }finally{await rm(dir,{recursive:true,force:true})}
});
