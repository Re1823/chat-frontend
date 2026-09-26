const FRONTEND_MCP='qiuqiu-frontend';

const fatalPatterns=[
  [/No conversation found with session ID/i,'FAILED_RESUME_NOT_FOUND'],
  [/(?:failed|unable) to (?:load|resume|open).{0,80}(?:conversation|session)/i,'FAILED_RESUME'],
  [/(?:conversation|session).{0,80}(?:resume).{0,40}(?:failed|error|not found)/i,'FAILED_RESUME'],
  [/\bfatal(?: error)?\b/i,'FAILED_STARTUP_FATAL']
];

export function transcriptTextEvidence(text,sessionId){
  const value=String(text??''),lastNewline=value.lastIndexOf('\n'),stable=lastNewline>=0?value.slice(0,lastNewline+1):'',tail=lastNewline>=0?value.slice(lastNewline+1):value,writeInProgress=tail.trim().length>0;
  const lines=stable.split(/\r?\n/).filter(line=>line.trim());
  if(lines.length===0)return {valid:false,parseable:!writeInProgress,hardFailure:false,writeInProgress,stablePrefixBytes:Buffer.byteLength(stable),recordCount:0,sessionRecordCount:0,dialogueRecordCount:0,reason:writeInProgress?'WRITE_IN_PROGRESS':'WAITING_FOR_TRANSCRIPT',records:[]};
  const records=[];
  try{for(const line of lines)records.push(JSON.parse(line))}catch{return {valid:false,parseable:false,hardFailure:true,writeInProgress,stablePrefixBytes:Buffer.byteLength(stable),recordCount:records.length,sessionRecordCount:0,dialogueRecordCount:0,reason:'MALFORMED_STABLE_RECORD',records}}
  const sessionRecords=records.filter(record=>record?.sessionId===sessionId||record?.session_id===sessionId);
  const dialogueRecords=records.filter(record=>['user','assistant'].includes(record?.type));
  const wrongSessionRecord=records.some(record=>(record?.sessionId||record?.session_id)&&(record.sessionId||record.session_id)!==sessionId);
  const valid=sessionRecords.length>0&&dialogueRecords.length>0&&!wrongSessionRecord;
  return {valid,parseable:true,hardFailure:false,writeInProgress,stablePrefixBytes:Buffer.byteLength(stable),recordCount:records.length,sessionRecordCount:sessionRecords.length,dialogueRecordCount:dialogueRecords.length,wrongSessionRecord,reason:valid?null:'WAITING_FOR_STARTUP_EVIDENCE',records};
}

export function startupLogEvidence(text){
  const value=String(text??'');
  const fatal=fatalPatterns.find(([pattern])=>pattern.test(value));
  const connected=new RegExp(`MCP server ["']${FRONTEND_MCP}["']:\\s*Successfully connected`, 'i').test(value)&&
    new RegExp(`MCP server ["']${FRONTEND_MCP}["']:\\s*Connection established`, 'i').test(value);
  const disconnected=new RegExp(`MCP server ["']${FRONTEND_MCP}["'].{0,100}(?:exited|disconnected|connection failed|failed after)`, 'i').test(value);
  return {fatal:Boolean(fatal),fatalReason:fatal?.[1]||null,frontendMcpConnected:connected&&!disconnected,frontendMcpDisconnected:disconnected};
}

export function candidateHealthEvidence({running,sessionId,expectedSessionId,processAlive,helperAlive,transcript,startup}={}){
  let reason=null;
  if(!running)reason='FAILED_TMUX_DISAPPEARED';
  else if(sessionId!==expectedSessionId)reason='FAILED_SESSION_MISMATCH';
  else if(!processAlive)reason='FAILED_PROCESS_EXIT';
  else if(!helperAlive)reason='FAILED_HELPER_EXIT';
  else if(startup?.fatal)reason=startup.fatalReason||'FAILED_STARTUP_FATAL';
  else if(startup?.frontendMcpDisconnected)reason='FAILED_MCP_DISCONNECTED';
  else if(startup?.frontendMcpConnected!==true)reason='FAILED_MCP_NOT_CONNECTED';
  else if(transcript?.valid!==true)reason=transcript?.reason||'FAILED_TRANSCRIPT_INVALID';
  return {healthy:reason===null,reason};
}
