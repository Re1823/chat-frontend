import {access} from 'node:fs/promises';
import {join} from 'node:path';

const exists=path=>access(path).then(()=>true,()=>false);
export async function qiuqiuReadiness({workspace='',ombreConnected=false}={}){
  const workspaceConfigured=Boolean(String(workspace).trim());
  const workspaceExists=workspaceConfigured&&await exists(workspace);
  return {
    workspaceConfigured,
    workspaceExists,
    claudeMdExists:Boolean(workspaceExists&&await exists(join(workspace,'CLAUDE.md'))),
    obDashboardConnected:Boolean(ombreConnected),
    claudeCode:'offline'
  };
}
