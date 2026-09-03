export const canonicalFrame={
  assistant:({messageId,sequence,text,final=false,textMode='delta'})=>({kind:'assistant_frame',messageId:String(messageId),sequence:Number(sequence),text:String(text??''),final:Boolean(final),textMode}),
  stop:({outcome='completed',reason=''})=>({kind:'turn_stop',outcome,reason:String(reason||'')}),
  error:({message})=>({kind:'turn_error',message:String(message||'Claude Code hook error')})
};

export function assertCanonicalFrame(frame){
  if(frame?.kind==='assistant_frame'){
    if(!frame.messageId||!Number.isInteger(frame.sequence)||frame.sequence<0)throw new Error('canonical assistant frame 无效');
    if(!['delta','snapshot'].includes(frame.textMode))throw new Error('canonical textMode 无效');
    return frame;
  }
  if(frame?.kind==='turn_stop'||frame?.kind==='turn_error')return frame;
  throw new Error('未知 canonical frame');
}
