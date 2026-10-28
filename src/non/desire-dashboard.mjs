import {existsSync} from 'node:fs';
import {openNonStore} from './store.mjs';
import {createDesireCore} from './desire-engine.mjs';
import {DRIVE_KEYS, subjectiveVoice} from './drive.mjs';

// The owner dashboard may read thought text. This object is never used by the
// Claude dispatch path, and this module has no OB or prompt dependency.
export function createDesireDashboard({path, now = Date.now} = {}) {
  const configured = typeof path === 'string' && path.length > 0;
  async function withStore(fn, {create = false, readOnly = false} = {}) {
    if (!configured || (!create && !existsSync(path))) return null;
    const store = await openNonStore({path, now, readOnly});
    try { return fn(store); } finally { store.close(); }
  }
  return Object.freeze({
    async snapshot() {
      const result = await withStore(store => {
        const state = createDesireCore({store,now}).snapshot(now());
        const thoughts = store.loadDesire().thoughts.map(({id,text,dimension,stage}) => ({id,text,dimension,stage}));
        const winner = DRIVE_KEYS.includes(state?.winner) ? state.winner : null;
        return {available:Boolean(state),snapshot:state ? {
          values:Object.fromEntries(DRIVE_KEYS.map(key => [key,state.values[key]])),
          winner,subjectiveVoice:winner ? subjectiveVoice(winner) : null,
          lastUpdatedAt:state.lastUpdatedAt
        } : null,thoughts,whitelist:store.listWhitelistTerms(),recallEnabled:false};
      },{readOnly:true});
      return result ?? {available:false,snapshot:null,thoughts:[],whitelist:[],recallEnabled:false};
    },
    async addTerm(term) {
      if (!configured) throw Object.assign(new Error('non_store_unavailable'),{statusCode:503});
      return withStore(store => store.addWhitelistTerm(term),{create:true});
    },
    async removeTerm(term) {
      if (!configured) throw Object.assign(new Error('non_store_unavailable'),{statusCode:503});
      return (await withStore(store => store.removeWhitelistTerm(term))) ?? {removed:false,terms:[]};
    }
  });
}

// Reserved entry point. Deliberately inert until a reviewed OB search boundary
// is connected; it never reads Memory, Mind, or Claude context.
export function onWhitelistMention(_term, _context) {
  return {status:'skipped',reason:'recall_disabled'};
}
