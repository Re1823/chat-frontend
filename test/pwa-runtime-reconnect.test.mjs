import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createDwellServer } from '../server.mjs';

async function withPage(statusResponder, run) {
  const server = createDwellServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let statusCalls = 0;
  let chatCalls = 0;
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.route('**/api/runtimes/claude-tmux/status', route => {
      statusCalls++;
      const response = statusResponder(statusCalls);
      return route.fulfill({ contentType: 'application/json', ...response });
    });
    await context.route('**/api/chat', route => { chatCalls++; return route.fulfill({ status: 500, body: 'Unexpected chat POST' }); });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('dwell.provider', 'claude_tmux');
      localStorage.setItem('dwell.active', 'runtime-reconnect-fixture');
      localStorage.setItem('dwell.sessions', JSON.stringify([{ id: 'runtime-reconnect-fixture', provider: 'claude_tmux', title: 'Fixture', messages: [] }]));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    try { await run({ page, getStatusCalls: () => statusCalls, getChatCalls: () => chatCalls, errors }); }
    catch (error) { console.error('runtime test detail:', error); throw error; }
    await context.close();
  } catch (error) {
    console.error('runtime setup detail:', error);
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    server.unref();
  }
}

test('504 shows reconnecting and retries without consuming the draft', async () => {
  const callsAt = [];
  await withPage(call => {
    callsAt.push(Date.now());
    return call === 1 ? { status: 504, body: '{"error":"Gateway Timeout"}' } : { status: 200, body: '{"state":"connected","runtimeId":"claude-main"}' };
  }, async ({ page, getStatusCalls, getChatCalls, errors }) => {
    await page.locator('#input').fill('Keep this draft');
    await page.waitForFunction(() => document.querySelector('#statusLine').textContent === '正在重连');
    assert.equal(await page.locator('#send').isDisabled(), true);
    assert.equal(await page.locator('#send').evaluate(element => getComputedStyle(element).opacity), '0.45');
    await page.waitForFunction(() => document.querySelector('#statusLine').textContent.includes('正在这里'), { timeout: 6000 });
    assert.equal(await page.locator('#send').isEnabled(), true);
    assert.equal(await page.locator('#input').inputValue(), 'Keep this draft');
    assert.equal(getStatusCalls(), 2);
    assert.ok(callsAt[1] - callsAt[0] >= 1200, JSON.stringify(callsAt));
    assert.equal(getChatCalls(), 0);
    assert.deepEqual(errors, []);
  });
});

test('focus rechecks a disconnected runtime without sending the draft', async () => {
  await withPage(call => call <= 2 ? { status: 504, body: '{"error":"Gateway Timeout"}' } : { status: 200, body: '{"state":"connected","runtimeId":"claude-main"}' }, async ({ page, getStatusCalls, getChatCalls, errors }) => {
    await page.locator('#input').fill('Keep this draft');
    await page.waitForFunction(() => document.querySelector('#statusLine').textContent === '正在重连');
    await page.waitForTimeout(2100);
    assert.equal(getStatusCalls(), 2);
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('#statusLine').textContent.includes('正在这里'), { timeout: 6000 });
    assert.equal(await page.locator('#send').isEnabled(), true);
    assert.equal(getStatusCalls(), 3);
    assert.equal(await page.locator('#input').inputValue(), 'Keep this draft');
    assert.equal(getChatCalls(), 0);
    assert.deepEqual(errors, []);
  });
});
