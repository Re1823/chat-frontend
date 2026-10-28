import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';

export const STICKER_ID=/^stk_[A-Za-z0-9_-]{32}$/;
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const publicRecord=record=>({id:record.id,owner:record.owner,status:record.status,name:record.name,description:record.description,emotion_tags:record.emotion_tags,mime:record.mime,width:record.width,height:record.height,url:`/api/stickers/${record.id}/media`,thumbnail:`/api/stickers/${record.id}/thumbnail`});
const checkText=(value,max,label)=>{const text=String(value||'').trim();if(!text||text.length>max)throw fail(`invalid_${label}`);return text};
const checkTags=value=>{const tags=Array.isArray(value)?value:String(value||'').split(/[,，]/);if(tags.length>5||tags.some(tag=>typeof tag!=='string'||tag.trim().length>32))throw fail('invalid_emotion_tags');return tags.map(tag=>tag.trim()).filter(Boolean)};

export async function createStickerStore({dir}={}){
  if(!dir)throw new Error('Sticker storage directory required');
  await mkdir(dir,{recursive:true,mode:0o700});
  let records=[];try{const saved=JSON.parse(await readFile(join(dir,'index.json'),'utf8'));if(!Array.isArray(saved))throw Error('invalid sticker index');records=saved}catch(error){if(error.code!=='ENOENT')throw error}
  let tail=Promise.resolve();
  const locked=operation=>{const result=tail.then(operation);tail=result.catch(()=>{});return result};
  const persist=async()=>{const temp=join(dir,'index.json.tmp');await writeFile(temp,JSON.stringify(records),{mode:0o600});await rename(temp,join(dir,'index.json'))};
  const find=(id,owner)=>{if(!STICKER_ID.test(String(id||'')))throw fail('invalid_sticker_id');const record=records.find(item=>item.id===id&&item.status==='active'&&(!owner||item.owner===owner));if(!record)throw fail('sticker_not_found',404);return record};
  return {
    list(owner){return records.filter(item=>item.status==='active'&&(!owner||item.owner===owner)).map(publicRecord)},
    get(id,owner){return publicRecord(find(id,owner))},
    async add({data,mime,owner,name,description,emotion_tags}){return locked(async()=>{
      if(!['user','assistant'].includes(owner))throw fail('invalid_sticker_owner');
      name=checkText(name,80,'sticker_name');description=checkText(description,1000,'sticker_description');emotion_tags=checkTags(emotion_tags);
      if(!Buffer.isBuffer(data)||data.length<16||data.length>10*1024*1024)throw fail('invalid_sticker_size',413);
      const actual=data.subarray(0,6).toString('ascii').startsWith('GIF8')?'image/gif':data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP'?'image/webp':null;
      if(!actual||mime!==actual)throw fail('unsupported_sticker_type',415);
      let meta,thumb;try{meta=await sharp(data,{limitInputPixels:16_000_000}).metadata();if(meta.width>4096||meta.height>4096||!meta.width||!meta.height)throw Error();thumb=await sharp(data,{pages:1,limitInputPixels:16_000_000}).resize(256,256,{fit:'inside',withoutEnlargement:true}).png().toBuffer()}catch{throw fail('invalid_sticker_image',415)}
      if(!((actual==='image/gif'&&meta.format==='gif')||(actual==='image/webp'&&meta.format==='webp')))throw fail('invalid_sticker_image',415);
      const id=`stk_${randomBytes(24).toString('base64url')}`,extension=actual==='image/gif'?'gif':'webp';
      await writeFile(join(dir,`${id}.${extension}`),data,{flag:'wx',mode:0o600});await writeFile(join(dir,`${id}.png`),thumb,{flag:'wx',mode:0o600});
      const record={id,owner,status:'active',name,description,emotion_tags,mime:actual,width:meta.width,height:meta.height,extension};records.push(record);await persist();return publicRecord(record)
    })},
    async update(id,changes){return locked(async()=>{const record=find(id);if(Object.keys(changes).some(key=>!['name','description','emotion_tags'].includes(key)))throw fail('invalid_sticker_update');if('name'in changes)record.name=checkText(changes.name,80,'sticker_name');if('description'in changes)record.description=checkText(changes.description,1000,'sticker_description');if('emotion_tags'in changes)record.emotion_tags=checkTags(changes.emotion_tags);await persist();return publicRecord(record)})},
    async delete(id){return locked(async()=>{const record=find(id);record.status='deleted';await persist();return {ok:true}})},
    async media(id,variant='media'){if(!STICKER_ID.test(String(id||'')))throw fail('invalid_sticker_id');const record=records.find(item=>item.id===id);if(!record)throw fail('sticker_not_found',404);return {data:await readFile(join(dir,`${id}.${variant==='thumbnail'?'png':record.extension}`)),mime:variant==='thumbnail'?'image/png':record.mime}},
    async thumbnailForContext(id){return (await this.media(id,'thumbnail')).data}
  }
}
