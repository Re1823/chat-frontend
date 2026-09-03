import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadLocalEnv,parseLocalEnv} from '../src/local-env.mjs';

test('local env parser supports comments and quoted values',()=>{
  assert.deepEqual(parseLocalEnv('A=one\nB="two three"\n# ignored\nexport C=three # note\n'),{A:'one',B:'two three',C:'three'});
});

test('.env.local loader never overwrites an existing service environment value',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dwell-env-')),path=join(dir,'.env.local'),env={OMBRE_DASHBOARD_PASSWORD:'service-secret'};
  await writeFile(path,'OMBRE_DASHBOARD_PASSWORD=file-secret\nOMBRE_DASHBOARD_URL=http://localhost:18001/\n');
  assert.equal(await loadLocalEnv(path,env),true);
  assert.equal(env.OMBRE_DASHBOARD_PASSWORD,'service-secret');
  assert.equal(env.OMBRE_DASHBOARD_URL,'http://localhost:18001/');
});
