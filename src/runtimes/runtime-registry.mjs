import { mkdir,readFile,rename,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const stableFields=['runtimeId','sessionName','workspace','claudeCommand','createdAt'];

function stableRuntime(input){
  const runtime={};
  for(const key of stableFields)if(input[key]!==undefined)runtime[key]=input[key];
  if(!runtime.runtimeId||!runtime.sessionName||!runtime.workspace)throw new Error('runtimeId、sessionName 和 workspace 必填');
  return runtime;
}

export function createRuntimeRegistry({filePath,transport,files={mkdir,readFile,rename,writeFile}}){
  let runtime=null;
  return {
    async load(){
      try{runtime=stableRuntime(JSON.parse(await files.readFile(filePath,'utf8')));return runtime}
      catch(error){if(error?.code==='ENOENT'){runtime=null;return null}throw error}
    },
    get(){return runtime},
    async save(input){
      runtime=stableRuntime(input);
      await files.mkdir(dirname(filePath),{recursive:true});
      const temporary=`${filePath}.tmp`;
      await files.writeFile(temporary,`${JSON.stringify(runtime,null,2)}\n`,{encoding:'utf8',mode:0o600});
      await files.rename(temporary,filePath);
      return runtime;
    },
    async reconcile(){
      if(!runtime)return {state:'unconfigured',runtime:null};
      if(!await transport.hasSession(runtime.sessionName))return {state:'missing',runtime};
      const inspection=await transport.inspectSession(runtime.sessionName);
      return {state:inspection.alive?'connected':'exited',runtime,inspection};
    }
  };
}
