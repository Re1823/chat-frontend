import { runCommand } from './command-runner.mjs';

const SAFE_NAME=/^[A-Za-z0-9_.-]{1,120}$/;
const normalizePrompt=value=>String(value??'').replace(/\r\n?/g,'\n');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shellQuote=value=>`'${String(value).replace(/'/g,`'"'"'`)}'`;

function checkedName(value,label){
  const text=String(value||'');
  if(!SAFE_NAME.test(text))throw new Error(`${label} 只能包含字母、数字、点、下划线和短横线`);
  return text;
}

export function createTmuxTransport({binary='tmux',socketName='',runner=runCommand,sleep=wait,submitDelayMs=900}={}){
  const socket=socketName?checkedName(socketName,'tmux socket 名'):'';
  const tmuxArgs=args=>socket?['-L',socket,...args]:args;
  const run=(args,options)=>runner(binary,tmuxArgs(args),options);

  return {
    async hasSession(sessionName){
      const session=checkedName(sessionName,'tmux session 名');
      try{await run(['has-session','-t',session]);return true}catch(error){if(error?.code===1)return false;throw error}
    },

    async inspectSession(sessionName){
      const session=checkedName(sessionName,'tmux session 名');
      const result=await run(['list-panes','-t',session,'-F','#{pane_id}\t#{pane_dead}\t#{pane_current_command}']);
      const panes=result.stdout.trim().split('\n').filter(Boolean).map(line=>{
        const [paneId,dead,currentCommand]=line.replace(/\r$/,'').split('\t');
        return {paneId,dead:dead==='1',currentCommand:currentCommand||''};
      });
      return {exists:true,panes,alive:panes.some(pane=>!pane.dead)};
    },

    async createSession({sessionName,workspace,command,args=[]}){
      const session=checkedName(sessionName,'tmux session 名');
      if(!workspace||!command)throw new Error('workspace 和 Claude Code command 必填');
      if(await this.hasSession(session))return {created:false};
      const shellCommand=[command,...args].map(shellQuote).join(' ');
      await run(['new-session','-d','-s',session,'-c',String(workspace),shellCommand]);
      return {created:true};
    },

    async sendPrompt({sessionName,turnId,prompt,delayMs=submitDelayMs}){
      const session=checkedName(sessionName,'tmux session 名');
      const turn=checkedName(turnId,'turnId');
      const buffer=checkedName(`dwell-${turn}`.slice(0,120),'tmux buffer 名');
      const text=normalizePrompt(prompt);
      if(!text.trim())throw new Error('prompt 不能为空');
      let loaded=false;
      try{
        await run(['load-buffer','-b',buffer,'-'],{input:text});
        loaded=true;
        await run(['paste-buffer','-p','-b',buffer,'-t',session]);
        await sleep(Math.max(250,Number(delayMs)||900));
        await run(['send-keys','-t',session,'Enter']);
      }finally{
        if(loaded)await run(['delete-buffer','-b',buffer]).catch(()=>undefined);
      }
    },

    async interrupt(sessionName){
      const session=checkedName(sessionName,'tmux session 名');
      if(!await this.hasSession(session))throw new Error(`Claude Code tmux session 不存在：${session}`);
      await run(['send-keys','-t',session,'Escape']);
    }
  };
}
