import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const DEFAULT_ORIGINS=[
  'https://api.anthropic.com',
  'https://api.openai.com',
  'https://api.deepseek.com'
];

const normalizeOrigin=value=>{
  const url=new URL(String(value||'').trim());
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('invalid origin');
  return url.origin.toLowerCase();
};

export function loadModelUpstreamAllowlist(env=process.env){
  const raw=String(env.MODEL_UPSTREAM_ALLOWLIST||'').trim();
  const values=raw?raw.split(',').map(value=>value.trim()).filter(Boolean):DEFAULT_ORIGINS;
  try{return new Set(values.map(normalizeOrigin))}catch{throw new Error('MODEL_UPSTREAM_ALLOWLIST 必须是逗号分隔的完整 http/https origin')}
}

const ipv4Parts=address=>address.split('.').map(Number);
const blockedIpv4=address=>{
  const [a,b]=ipv4Parts(address);
  return a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||a>=224;
};

export function isBlockedAddress(raw){
  let address=String(raw||'').trim().toLowerCase().replace(/^\[|\]$/g,'');
  if(address.startsWith('::ffff:')&&isIP(address.slice(7))===4)address=address.slice(7);
  const version=isIP(address);
  if(version===4)return blockedIpv4(address);
  if(version!==6)return true;
  if(address==='::'||address==='::1')return true;
  const first=parseInt(address.split(':')[0]||'0',16);
  return (first&0xfe00)===0xfc00||(first&0xffc0)===0xfe80;
}

export function createModelUpstreamPolicy({allowlist=loadModelUpstreamAllowlist(),resolve=lookup,allowPrivateForTests=false}={}){
  return async raw=>{
    let url;
    try{url=new URL(String(raw||''))}catch{throw Object.assign(new Error('模型上游地址不合法'),{statusCode:400,code:'upstream_not_allowed'})}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!allowlist.has(url.origin.toLowerCase()))throw Object.assign(new Error('模型上游不在允许列表中'),{statusCode:400,code:'upstream_not_allowed'});
    let addresses;
    try{addresses=isIP(url.hostname)?[{address:url.hostname}]:await resolve(url.hostname,{all:true,verbatim:true})}catch{throw Object.assign(new Error('模型上游地址无法安全解析'),{statusCode:400,code:'upstream_not_allowed'})}
    if(!addresses.length||(!allowPrivateForTests&&addresses.some(item=>isBlockedAddress(item.address))))throw Object.assign(new Error('模型上游解析到了禁止的网络地址'),{statusCode:400,code:'upstream_not_allowed'});
    return url;
  };
}

export {DEFAULT_ORIGINS};
