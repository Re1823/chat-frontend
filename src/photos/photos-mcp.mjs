export const photosMcpTools = Object.freeze([
  { name: 'save_frontend_photo_to_photos', description: 'Save an image bound to the current frontend turn into durable Photos.', inputSchema: { type: 'object', properties: { imageId: { type: 'string', pattern:'^img_[A-Za-z0-9_-]{43}$' }, albumId: { type: 'string', pattern:'^alb_[A-Za-z0-9_-]{32}$' }, note: { type: 'string', maxLength: 1000 } }, required: ['imageId'], additionalProperties: false } },
  { name: 'create_photo_album', description: 'Create a Photos album.', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, mood: { type: 'string', maxLength: 24 }, note: { type: 'string', maxLength: 500 } }, required: ['name'], additionalProperties: false } },
  { name: 'list_photo_albums', description: 'List Photos albums without image bytes.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_photos', description: 'List saved photo metadata without image bytes.', inputSchema: { type: 'object', properties: { albumId: { type: 'string', pattern:'^alb_[A-Za-z0-9_-]{32}$' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  { name: 'read_saved_photo', description: 'Read one saved photo by opaque photo ID as MCP ImageContent.', inputSchema: { type: 'object', properties: { photoId: { type: 'string', pattern:'^photo_[A-Za-z0-9_-]{32}$' } }, required: ['photoId'], additionalProperties: false } },
  { name: 'send_saved_photo_to_frontend', description: 'Send one saved photo to the current frontend turn as a structured image message.', inputSchema: { type: 'object', properties: { photoId: { type: 'string', pattern:'^photo_[A-Za-z0-9_-]{32}$' }, text: { type: 'string', maxLength: 16384 } }, required: ['photoId'], additionalProperties: false } }
].map(tool => ({ ...tool, annotations: { readOnlyHint: tool.name.startsWith('list_') || tool.name.startsWith('read_'), destructiveHint: false, idempotentHint: tool.name.startsWith('list_') || tool.name.startsWith('read_'), openWorldHint: false } })));

export function createPhotosMcpHandler({ photosStore, readCurrentTurnImage, currentTurnId, sendSavedPhoto = async () => { throw new Error('Frontend photo delivery unavailable'); } }) {
  return async ({ name, arguments: args = {} }) => {
    const tool = photosMcpTools.find(item => item.name === name); if (!tool) throw new Error('Unknown Photos tool');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !(key in tool.inputSchema.properties))) throw new Error('Invalid Photos tool arguments');
    if((tool.inputSchema.required||[]).some(key=>!(key in args)))throw new Error('Invalid Photos tool arguments');
    for(const [key,value] of Object.entries(args)){const schema=tool.inputSchema.properties[key];if(schema.type==='string'&&(typeof value!=='string'||(schema.pattern&&!new RegExp(schema.pattern).test(value))||(schema.maxLength&&value.length>schema.maxLength)))throw new Error('Invalid Photos tool arguments');if(schema.type==='integer'&&(!Number.isInteger(value)||(schema.minimum!=null&&value<schema.minimum)||(schema.maximum!=null&&value>schema.maximum)))throw new Error('Invalid Photos tool arguments')}
    if (name === 'create_photo_album') return { content: [{ type: 'text', text: JSON.stringify(await photosStore.createAlbum({ ...args, createdBy: 'assistant' })) }] };
    if (name === 'list_photo_albums') return { content: [{ type: 'text', text: JSON.stringify(photosStore.listAlbums()) }] };
    if (name === 'list_photos') return { content: [{ type: 'text', text: JSON.stringify(photosStore.listPhotos(args)) }] };
    if (name === 'read_saved_photo') { const image = await photosStore.readPhoto(args.photoId); return { content: [{ type: 'image', data: image.data.toString('base64'), mimeType: image.mime }] }; }
    if (name === 'send_saved_photo_to_frontend') { const photo = photosStore.getPhoto(args.photoId); if (!photo) throw Object.assign(new Error('photo_not_found'), { statusCode: 404 }); return { content: [{ type: 'text', text: JSON.stringify(await sendSavedPhoto(photo, String(args.text || ''))) }] }; }
    const turnId = currentTurnId(); await readCurrentTurnImage(args.imageId, turnId);
    return { content: [{ type: 'text', text: JSON.stringify(await photosStore.promote({ ...args, sourceTurnId: turnId, savedBy: 'assistant' })) }] };
  };
}
