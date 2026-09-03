import { assertCanonicalFrame } from '../hooks/canonical-frame.mjs';

export function createFrameBuffer(){
  const messages=new Map();
  return {
    push(input){
      const frame=assertCanonicalFrame(input);
      if(frame.kind!=='assistant_frame')return [frame];
      let state=messages.get(frame.messageId);
      if(!state){state={next:0,pending:new Map(),content:''};messages.set(frame.messageId,state)}
      if(frame.sequence<state.next||state.pending.has(frame.sequence))return [];
      state.pending.set(frame.sequence,frame);
      const output=[];
      while(state.pending.has(state.next)){
        const current=state.pending.get(state.next);state.pending.delete(state.next);state.next++;
        let delta=current.text;
        if(current.textMode==='snapshot'){
          if(!current.text.startsWith(state.content)){output.push({kind:'frame_conflict',messageId:current.messageId,sequence:current.sequence});continue}
          delta=current.text.slice(state.content.length);
        }
        state.content+=delta;
        if(delta)output.push({...current,text:delta,textMode:'delta'});
        if(current.final)output.push({kind:'message_final',messageId:current.messageId});
      }
      return output;
    }
  };
}
