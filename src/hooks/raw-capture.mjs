import { appendFile,mkdir,stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createRawHookCapture({enabled=false,filePath,maxBytes=50_000_000,files={appendFile,mkdir,stat}}={}){
  if(!enabled)return null;
  return async raw=>{
    try{if((await files.stat(filePath)).size>=maxBytes)return}catch(error){if(error?.code!=='ENOENT')throw error}
    await files.mkdir(dirname(filePath),{recursive:true});
    await files.appendFile(filePath,`${JSON.stringify({capturedAt:new Date().toISOString(),payload:raw})}\n`,'utf8');
  };
}
