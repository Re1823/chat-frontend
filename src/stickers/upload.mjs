import Busboy from 'busboy';

export function receiveStickerUpload(req){
  return new Promise((resolve,reject)=>{
    let parser;try{parser=Busboy({headers:req.headers,limits:{files:2,fields:5,fileSize:10*1024*1024,fieldSize:4096,parts:6}})}catch{return reject(Object.assign(Error('invalid_multipart'),{statusCode:400}))}
    const fields={},chunks=[];let file=null,invalid=false;
    parser.on('field',(key,value)=>{if(!['owner','name','description','emotion_tags'].includes(key)||key in fields)invalid=true;else fields[key]=value});
    parser.on('file',(key,stream,info)=>{if(key!=='file'||file)invalid=true;file={mime:info.mimeType};stream.on('data',chunk=>chunks.push(chunk));stream.on('limit',()=>invalid=true)});
    parser.on('filesLimit',()=>invalid=true);parser.on('fieldsLimit',()=>invalid=true);parser.on('partsLimit',()=>invalid=true);
    parser.on('error',reject);
    parser.on('finish',()=>{if(invalid||!file)return reject(Object.assign(Error('invalid_sticker_upload'),{statusCode:400}));resolve({...fields,...file,data:Buffer.concat(chunks)})});
    req.pipe(parser);
  });
}
