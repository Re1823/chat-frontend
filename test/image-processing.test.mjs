import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_IMAGE_LIMITS, SINGLE_IMAGE_STEPS, MULTI_IMAGE_STEPS, imageBudgetForBatch, scaledSize, extractJpegCapturedAt, compressImageForUpload } from '../public/image-processing.mjs';

test('single images start at 1080px JPEG quality 0.70 and preserve aspect ratio',()=>{
  assert.deepEqual(SINGLE_IMAGE_STEPS[0],{maxEdge:1080,quality:.70});
  assert.deepEqual(scaledSize(8064,6048,1080),{width:1080,height:810});
  assert.deepEqual(scaledSize(3024,4032,1080),{width:810,height:1080});
});

test('multi-image compression follows the adaptive 1600 to 1080 ladder and stays below server caps',()=>{
  assert.deepEqual(MULTI_IMAGE_STEPS.slice(0,4),[{maxEdge:1600,quality:.88},{maxEdge:1440,quality:.82},{maxEdge:1280,quality:.76},{maxEdge:1080,quality:.70}]);
  assert.equal(imageBudgetForBatch(1),CLIENT_IMAGE_LIMITS.safeFileBytes);
  assert.equal(imageBudgetForBatch(4)*4,CLIENT_IMAGE_LIMITS.safeBatchBytes);
  assert(imageBudgetForBatch(4)<CLIENT_IMAGE_LIMITS.serverFileBytes);
  assert(CLIENT_IMAGE_LIMITS.safeBatchBytes<CLIENT_IMAGE_LIMITS.serverBatchBytes);
});

test('a 48MP portrait is orientation-aware, resized before upload, whitened and encoded as JPEG',async()=>{
  const original={createImageBitmap:globalThis.createImageBitmap,document:globalThis.document,File:globalThis.File};
  const calls=[],bitmap={width:6048,height:8064,close(){calls.push(['close'])}};
  globalThis.createImageBitmap=async(file,options)=>{calls.push(['decode',options]);return bitmap};
  globalThis.File=undefined;
  globalThis.document={createElement(name){assert.equal(name,'canvas');const canvas={width:0,height:0,getContext(){return{set fillStyle(value){calls.push(['fillStyle',value])},fillRect(...args){calls.push(['fillRect',...args])},drawImage(...args){calls.push(['drawImage',...args.slice(1)])}}},toBlob(done,type,quality){calls.push(['encode',canvas.width,canvas.height,type,quality]);done({size:900000,type})}};return canvas}};
  try{
    const output=await compressImageForUpload({name:'IMG_0001.HEIC',type:'image/heic'},{count:1});
    assert.equal(output.type,'image/jpeg');
    assert.deepEqual(calls[0],['decode',{imageOrientation:'from-image'}]);
    assert(calls.some(call=>call[0]==='fillStyle'&&call[1]==='#f8f6f2'));
    assert(calls.some(call=>call[0]==='encode'&&call[1]===810&&call[2]===1080&&call[3]==='image/jpeg'&&call[4]===.70));
    assert(calls.some(call=>call[0]==='close'));
  }finally{globalThis.createImageBitmap=original.createImageBitmap;globalThis.document=original.document;globalThis.File=original.File}
});

test('multi-image encoding retries smaller steps until the per-image safety budget is met',async()=>{
  const original={createImageBitmap:globalThis.createImageBitmap,document:globalThis.document,File:globalThis.File};let attempts=0;const qualities=[];
  globalThis.createImageBitmap=async()=>({width:8000,height:6000,close(){}});globalThis.File=undefined;
  globalThis.document={createElement(){const canvas={width:0,height:0,getContext(){return{set fillStyle(value){},fillRect(){},drawImage(){}}},toBlob(done,type,quality){qualities.push(quality);attempts++;done({size:attempts<3?5*1024*1024:3*1024*1024,type})}};return canvas}};
  try{const output=await compressImageForUpload({name:'large.jpg',type:'image/jpeg'},{count:4});assert.equal(output.size,3*1024*1024);assert.deepEqual(qualities,[.88,.82,.76])}
  finally{globalThis.createImageBitmap=original.createImageBitmap;globalThis.document=original.document;globalThis.File=original.File}
});

test('JPEG DateTimeOriginal is read before canvas strips metadata',async()=>{
  const tiff=Buffer.alloc(80);tiff.write('II',0,'ascii');tiff.writeUInt16LE(42,2);tiff.writeUInt32LE(8,4);tiff.writeUInt16LE(1,8);tiff.writeUInt16LE(0x8769,10);tiff.writeUInt16LE(4,12);tiff.writeUInt32LE(1,14);tiff.writeUInt32LE(26,18);tiff.writeUInt32LE(0,22);tiff.writeUInt16LE(1,26);tiff.writeUInt16LE(0x9003,28);tiff.writeUInt16LE(2,30);tiff.writeUInt32LE(20,32);tiff.writeUInt32LE(44,36);tiff.writeUInt32LE(0,40);tiff.write('2025:07:08 09:10:11\0',44,'ascii');
  const payload=Buffer.concat([Buffer.from('Exif\0\0','binary'),tiff]),jpeg=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe1,(payload.length+2)>>8,(payload.length+2)&255]),payload,Buffer.from([0xff,0xd9])]);
  const file={name:'photo.jpg',type:'image/jpeg',slice(start,end){const part=jpeg.subarray(start,end);return{arrayBuffer:async()=>part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength)}}};
  const value=await extractJpegCapturedAt(file),date=new Date(value);assert.equal(date.getFullYear(),2025);assert.equal(date.getMonth(),6);assert.equal(date.getDate(),8);
});
