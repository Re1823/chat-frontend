import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');

test('mobile viewport remains zoomable while using the device width and safe area',()=>{
  assert.match(html,/<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">/);
  assert.doesNotMatch(html,/user-scalable=no|maximum-scale|minimum-scale/);
  assert.match(css,/\.app\{position:fixed;[^}]*top:0;[^}]*height:var\(--vv-bottom,100dvh\)/);
  assert.match(css,/safe-area-inset-bottom/);
  assert.match(css,/overflow-x:hidden/);
});

test('all mobile form controls meet the iOS 16px focus threshold without scaling',()=>{
  assert.match(css,/@media\(max-width:760px\),\(hover:none\) and \(pointer:coarse\)/);
  assert.ok(css.includes('.composer textarea,.form input,.form select,.form textarea,.continue-editor textarea{font-size:16px}'));
  assert.doesNotMatch(css,/\.composer textarea[^}]*transform:\s*scale/);
  assert.match(html,/<button type="button" id="send" class="send" aria-label="发送"/);
});

test('visual viewport resize and scroll drive the shell geometry and toast positioning',()=>{
  assert.match(app,/function syncVisualViewport\(\)/);
  assert.match(app,/visual\?\.height/);
  assert.match(app,/visual\?\.offsetTop/);
  assert.match(app,/setProperty\('--vv-height'/);
  assert.match(app,/setProperty\('--vv-offset-top'/);
  assert.match(app,/setProperty\('--vv-bottom'/);
  assert.match(app,/visualViewport\?\.addEventListener\?\.\('resize',scheduleVisualViewportSync\)/);
  assert.match(app,/visualViewport\?\.addEventListener\?\.\('scroll',scheduleVisualViewportSync\)/);
  assert.match(app,/requestAnimationFrame/);
});

test('header consumes visual top while the shell bottom remains independently anchored',()=>{
  assert.match(css,/\.app\{position:fixed;[^}]*top:0;[^}]*height:var\(--vv-bottom,100dvh\)/);
  assert.match(css,/main\{min-height:0;padding-top:var\(--vv-offset-top,0px\)\}/);
  assert.doesNotMatch(css,/main\{[^}]*transition/);
  assert.doesNotMatch(css,/main>header\{[^}]*transition/);
});

test('bottom intent also aligns short histories and is cancelled only by user scrolling',()=>{
  assert.match(css,/\.messages\.bottom-anchored>:first-child\{margin-top:auto\}/);
  assert.match(app,/keepBottomThroughViewportResize/);
  assert.match(app,/touchmove',cancelViewportBottomAnchor/);
  assert.match(app,/event\.deltaY<0/);
});
