const value=(source,...paths)=>{
  for(const path of paths){
    const result=path.split('.').reduce((current,key)=>current?.[key],source);
    if(result!==undefined&&result!==null)return result;
  }
  return null;
};

const list=input=>input==null?[]:Array.isArray(input)?input.filter(item=>item!=null):[input];
const boolean=input=>input==null?null:Boolean(input);
const number=input=>input==null||input===''?null:Number.isFinite(Number(input))?Number(input):null;

export function normalizeBucket(raw={}){
  const content=String(value(raw,'content','display_content','text','body','memory.content')??'');
  const preview=value(raw,'contentPreview','content_preview','preview','summary','meta.preview','metadata.preview');
  return {
    id:String(value(raw,'id','bucket_id','bucketId','name')??''),
    name:String(value(raw,'name','title','meta.name','metadata.name')??'未命名记忆'),
    content,
    contentPreview:String(preview??content.slice(0,240)),
    type:value(raw,'type','bucket_type','meta.type','metadata.type'),
    domains:list(value(raw,'domains','domain','meta.domains','meta.domain','metadata.domains','metadata.domain')).map(String),
    tags:list(value(raw,'tags','meta.tags','metadata.tags')).map(String),
    importance:number(value(raw,'importance','score.importance','meta.importance','metadata.importance')),
    valence:number(value(raw,'valence','emotion.valence','meta.valence','metadata.valence')),
    arousal:number(value(raw,'arousal','emotion.arousal','meta.arousal','metadata.arousal')),
    pinned:boolean(value(raw,'pinned','is_pinned','meta.pinned','metadata.pinned')),
    resolved:boolean(value(raw,'resolved','is_resolved','meta.resolved','metadata.resolved')),
    digested:boolean(value(raw,'digested','is_digested','meta.digested','metadata.digested')),
    activationCount:number(value(raw,'activationCount','activation_count','meta.activation_count','metadata.activation_count')),
    createdAt:value(raw,'createdAt','created_at','created','meta.created_at','metadata.created'),
    lastActiveAt:value(raw,'lastActiveAt','last_active_at','last_active','updated_at','meta.last_active_at','metadata.last_active')
  };
}

const records=payload=>{
  if(Array.isArray(payload))return payload;
  for(const key of ['buckets','results','items','data','memories'])if(Array.isArray(payload?.[key]))return payload[key];
  return [];
};

export function normalizeBucketList(payload){return records(payload).map(normalizeBucket).filter(bucket=>bucket.id)}

export function normalizeStatus(payload={}){
  const source=payload?.data&&typeof payload.data==='object'?payload.data:payload;
  const activeCount=number(value(source,'buckets.total'));
  const archiveCount=number(value(source,'archivedCount','archived_count','stats.archived','buckets.archived','buckets.archive'));
  const explicitCount=number(value(source,'memoryCount','memory_count','bucketCount','bucket_count','total','count','stats.total','buckets.count'));
  const count=explicitCount??(activeCount==null?null:activeCount+(archiveCount||0));
  return {
    connected:true,
    status:String(value(source,'status','state')??'online'),
    version:value(source,'version','app_version','ombre_version'),
    memoryCount:count,
    dynamicCount:number(value(source,'dynamicCount','dynamic_count','stats.dynamic','buckets.dynamic')),
    permanentCount:number(value(source,'permanentCount','permanent_count','stats.permanent','buckets.permanent')),
    archivedCount:archiveCount,
    pinnedCount:number(value(source,'pinnedCount','pinned_count','stats.pinned','buckets.pinned'))
  };
}

export function normalizeBreathDebug(payload={}){
  const results=Array.isArray(payload.results)?payload.results:[];
  return {query:String(payload.query??''),valence:number(payload.valence),arousal:number(payload.arousal),threshold:number(payload.threshold),passedCount:number(payload.passed_count),totalCandidates:number(payload.total_candidates),results:results.map(item=>({id:String(item.id??''),name:String(item.name??''),type:item.type??null,domain:item.domain??null,finalScore:number(item.raw_total??item.finalScore??item.final_score),passed:boolean(item.passed_threshold??item.passed),scores:item.scores&&typeof item.scores==='object'?Object.fromEntries(Object.entries(item.scores).filter(([,score])=>number(score)!==null).map(([key,score])=>[key,number(score)])): {}})).filter(item=>item.id)};
}
