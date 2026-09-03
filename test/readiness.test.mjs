import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {qiuqiuReadiness} from '../src/readiness.mjs';

test('QIUQIU readiness reports workspace and CLAUDE.md without exposing its content',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'qiuqiu-'));
  await writeFile(join(workspace,'CLAUDE.md'),'private instructions');
  const result=await qiuqiuReadiness({workspace,ombreConnected:true});
  assert.deepEqual(result,{workspaceConfigured:true,workspaceExists:true,claudeMdExists:true,obDashboardConnected:true,claudeCode:'offline'});
  assert.equal(JSON.stringify(result).includes('private instructions'),false);
});

test('QIUQIU readiness remains offline when unconfigured',async()=>{
  assert.deepEqual(await qiuqiuReadiness(),{workspaceConfigured:false,workspaceExists:false,claudeMdExists:false,obDashboardConnected:false,claudeCode:'offline'});
});
