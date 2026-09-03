import { canonicalFrame } from './canonical-frame.mjs';

const first=(object,names)=>{for(const name of names)if(object?.[name]!==undefined)return object[name]};

export function createClaudeIngress({captureRaw,debug=()=>{}}={}){
  const fallbackSequence=new Map();
  return {
    async adapt(raw,{runtimeId}={}){
      if(captureRaw)try{await captureRaw(raw)}catch(error){debug(`raw hook capture failed: ${error.message}`)}
      const event=String(first(raw,['hook_event_name','hookEventName','event','type'])||'');
      if(['Stop','stop','turn_stop'].includes(event))return canonicalFrame.stop({outcome:'completed'});
      if(['StopFailure','stop_failure'].includes(event))return canonicalFrame.stop({outcome:'failed',reason:String(first(raw,['error','reason','message'])||'')});
      if(['Error','error'].includes(event))return canonicalFrame.error({message:first(raw,['error','message','reason'])});
      if(!['MessageDisplay','message_display','assistant'].includes(event))return null;
      const messageId=String(first(raw,['message_id','messageId','id'])||`${runtimeId||'runtime'}-message`);
      const supplied=Number(first(raw,['index','sequence','frame_index']));
      const sequence=Number.isInteger(supplied)&&supplied>=0?supplied:(fallbackSequence.get(messageId)||0);
      fallbackSequence.set(messageId,Math.max(fallbackSequence.get(messageId)||0,sequence+1));
      const text=first(raw,['delta','text','content','display_content']);
      if(typeof text!=='string')throw new Error('MessageDisplay 候选 payload 中没有文本字段');
      const mode=first(raw,['text_mode','textMode','mode']);
      return canonicalFrame.assistant({messageId,sequence,text,final:Boolean(first(raw,['final','is_final','isFinal'])),textMode:mode==='snapshot'?'snapshot':'delta'});
    }
  };
}
