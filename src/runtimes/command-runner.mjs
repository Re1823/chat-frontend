import { spawn } from 'node:child_process';

export function runCommand(binary, args, {input, env}={}) {
  return new Promise((resolve, reject) => {
    const child=spawn(binary,args,{shell:false,windowsHide:true,env:env||process.env,stdio:['pipe','pipe','pipe']});
    const stdout=[],stderr=[];
    child.stdout.on('data',chunk=>stdout.push(chunk));
    child.stderr.on('data',chunk=>stderr.push(chunk));
    child.once('error',reject);
    child.once('close',(code,signal)=>{
      const result={code,signal,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')};
      if(code===0)return resolve(result);
      const error=new Error(result.stderr.trim()||`${binary} exited with code ${code}`);
      Object.assign(error,result);
      reject(error);
    });
    if(input!==undefined)child.stdin.end(input,'utf8');else child.stdin.end();
  });
}
