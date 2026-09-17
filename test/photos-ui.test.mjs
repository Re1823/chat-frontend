import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { photosMcpTools } from '../src/photos/photos-mcp.mjs';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const server=await readFile(new URL('../server.mjs',import.meta.url),'utf8');

test('Photos menu follows Books and opens a dedicated SPA surface',()=>{assert.match(html,/Books<\/button><button id="photosNav"[^>]*>.*Photos<\/button>/);assert.match(app,/photosNav.*showPhotos/);assert.doesNotMatch(app,/photosNav.*location/)});
test('Photos home has dynamic statistics, albums and Keeps copy',()=>{for(const value of ['QIUQIU · KEEPS','id="photosStats"','id="albumList"'])assert.match(html,new RegExp(value));assert.match(app,/photosItems\.length.*photosAlbums\.length/);assert.match(app,/name:'Keeps'/)});
test('album create and detail controls use API without reload',()=>{for(const value of ['新建相册','心动','想念','安心','好笑','id="albumGrid"'])assert.match(html,new RegExp(value));assert.match(app,/api\/photos\/albums.*method:'POST'/s);assert.doesNotMatch(app,/location\.reload/)});
test('album fields are iOS-safe and mobile grids cannot overflow',()=>{assert.match(css,/album-sheet input[^}]*font:16px/);assert.match(css,/album-grid\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);assert.match(css,/@media\(max-width:390px\)/);assert.match(css,/overflow-x:hidden/)});
test('one shared real-image viewer has safe area and swipe',()=>{assert.equal((html.match(/id="imageViewer"/g)||[]).length,1);assert.match(html,/id="viewerImage"/);assert.match(css,/image-viewer[^}]*safe-area-inset-top/);assert.match(app,/touchstart/);assert.match(app,/touchend/);assert.match(app,/Math\.abs\(delta\)<45/);assert.doesNotMatch(html,/<canvas/)});
test('native long press remains available',()=>{assert.doesNotMatch(app,/contextmenu/);assert.match(css,/image-viewer img\{[^}]*user-select:auto/)});
test('Save promotes only on explicit action and Photos attach does not submit',()=>{assert.match(app,/saveViewerToPhotos.*api\/photos\/promote/s);assert.match(app,/sendViewerToChat.*\/attach/s);const body=app.match(/async function sendViewerToChat\(\)[\s\S]*?\n}/)?.[0]||'';assert.doesNotMatch(body,/triggerSend|send\(\)/)});
test('Add to Chat exposes working Camera and All photos only',()=>{assert.match(html,/id="cameraInput"[^>]*capture="environment"/);assert.match(html,/id="attachmentInput"[^>]*image\/jpeg,image\/png,image\/webp[^>]*multiple/);assert.doesNotMatch(html,/Add files/);assert.match(app,/attachImage.*openAddToChat/)});
test('Add to Chat starts closed and opens only from Chat',()=>{assert.match(html,/id="addToChatSheet"[^>]*aria-hidden="true"/);assert.match(app,/function openAddToChat\(\)\{if\(activeAppView!==['"]chat['"]\)return;closeSheets\(\)/)});
test('Add to Chat closes from X, backdrop, Escape and non-chat navigation',()=>{assert.match(app,/closeAddToChat.*closeSheets/);assert.match(app,/closeAddToChat'\)\.onclick=closeAddToChat/);assert.match(app,/\$\('#shade'\)\.onclick=closeSheets/);assert.match(app,/event\.key===['"]Escape['"].*closeAddToChat/);assert.match(app,/function showMemory\(\)\{closeTransientUI\(\)/);assert.match(app,/async function showPhotos\(\)\{closeTransientUI\(\)/)});
test('closed Add to Chat cannot cover a 390px non-chat view',()=>{assert.match(css,/\.add-chat-sheet:not\(\.on\)\{visibility:hidden;pointer-events:none\}/);assert.match(css,/@media\(max-width:390px\)/)});
test('closed sheets cannot intercept navigation and chat/session routes return to Chat',()=>{assert.match(css,/\.sheet:not\(\.on\)\{pointer-events:none\}/);assert.match(app,/function showChat\(\).*closeTransientUI\(\).*\$\('aside'\)\.classList\.remove\('on'\)/);assert.match(app,/\.session'\).*showChat\(\)/)});
test('failed pre-turn image send restores attachment draft',()=>{assert.match(app,/catch\(e\).*if\(!request\.turnId&&images\.length\).*draftImages=safeMessageImages\(images\)/s)});
test('Photos MCP registry has six strict tools and no path or URL parameters',()=>{assert.deepEqual(photosMcpTools.map(tool=>tool.name),['save_frontend_photo_to_photos','create_photo_album','list_photo_albums','list_photos','read_saved_photo','send_saved_photo_to_frontend']);for(const tool of photosMcpTools){assert.equal(tool.inputSchema.additionalProperties,false);assert(!Object.keys(tool.inputSchema.properties).some(key=>/path|url/i.test(key)))}});
test('saved photo delivery is a structured assistant image event',async()=>{assert.match(server,/photos-tool/);assert.match(await readFile(new URL('../src/runtimes/claude-tmux.mjs',import.meta.url),'utf8'),/assistant_message[^\n]*images:\[photo\]/)});
test('static resources have independent cache versions',()=>{assert.match(html,/style\.css\?v=thought3/);assert.match(html,/app\.js\?v=thought3/)});
