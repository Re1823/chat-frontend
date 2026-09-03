import {readFile} from 'node:fs/promises';

const unquote=value=>{
  const text=value.trim();
  if(text.length>=2&&text[0]==='"'&&text.at(-1)==='"')return text.slice(1,-1).replace(/\\n/g,'\n').replace(/\\r/g,'\r').replace(/\\t/g,'\t').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
  if(text.length>=2&&text[0]==="'"&&text.at(-1)==="'")return text.slice(1,-1);
  return text.replace(/\s+#.*$/,'').trim();
};

export function parseLocalEnv(source){
  const values={};
  for(const line of String(source).replace(/^\uFEFF/,'').split(/\r?\n/)){
    const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if(match)values[match[1]]=unquote(match[2]);
  }
  return values;
}

export async function loadLocalEnv(fileUrl,env=process.env){
  let source;
  try{source=await readFile(fileUrl,'utf8')}catch(error){if(error.code==='ENOENT')return false;throw error}
  for(const [key,value] of Object.entries(parseLocalEnv(source)))if(env[key]===undefined)env[key]=value;
  return true;
}
