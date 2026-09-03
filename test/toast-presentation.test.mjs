import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');

test('toast uses a wide light rectangular treatment with readable wrapping',()=>{
  assert.match(css,/\.toast\{[^}]*width:min\(82vw,420px\)/);
  assert.match(css,/\.toast\{[^}]*background:#e7e3dc/);
  assert.match(css,/\.toast\{[^}]*color:#302e2a/);
  assert.match(css,/\.toast\{[^}]*border-radius:14px/);
  assert.match(css,/\.toast\{[^}]*white-space:pre-wrap/);
  assert.match(css,/\.toast\{[^}]*overflow-wrap:anywhere/);
  assert.match(css,/\.toast\{[^}]*overflow-y:auto/);
});

test('toast has a safe-area fallback and dynamic positioning hooks',()=>{
  assert.match(css,/bottom:calc\(96px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(app,/footer\.getBoundingClientRect\(\)\.top/);
  assert.match(app,/globalThis\.visualViewport/);
  assert.match(app,/ResizeObserver/);
});
