import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createBridgeActiveTurn } from './bridge-active-turn.mjs';

const SOCKET_FD = 3;
const ALLOWED_UID = 999;
const TMUX = '/usr/bin/tmux';
const CLAUDE = '/usr/bin/claude';
const PYTHON = '/usr/bin/python3';
const TMUX_SOCKET = '/run/qiuqiu-claude-bridge/dwell-frontend.sock';
const SESSION = 'dwell-claude';
const WORKSPACE = '/root';
const OMBRE_ENV_FILE = '/root/.config/qiuqiu/ombre.env';
const HOOK_URL = 'http://127.0.0.1:4173/api/internal/claude-code/events';
const HOOK_SECRET_ENV = 'DWELL_CLAUDE_HOOK_SECRET';
const MAX_REQUEST_BYTES = 300 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const TURN_ID = /^[A-Za-z0-9_.-]{1,120}$/;
const PEER_CRED_SCRIPT = [
  'import json,socket,struct',
  's=socket.socket(fileno=3)',
  'pid,uid,gid=struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))',
  'print(json.dumps({"pid":pid,"uid":uid,"gid":gid}))'
].join(';');

const activeTurn = createBridgeActiveTurn();

function sessionSettings() {
  const httpHook = {
    type: 'http',
    url: HOOK_URL,
    timeout: 10,
    headers: { 'x-dwell-hook-secret': `$${HOOK_SECRET_ENV}` },
    allowedEnvVars: [HOOK_SECRET_ENV]
  };
  return JSON.stringify({
    permissions: {
      defaultMode: 'dontAsk',
      allow: ['mcp__ombre-brain__*'],
      deny: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent']
    },
    hooks: {
      MessageDisplay: [{ hooks: [httpHook] }],
      Stop: [{ hooks: [httpHook] }],
      StopFailure: [{ hooks: [httpHook] }]
    }
  });
}

function run(binary, args, { input, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (code === 0) return resolve(result);
      const error = new Error(result.stderr.trim() || `${binary} exited with code ${code}`);
      Object.assign(error, result);
      reject(error);
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input, 'utf8');
  });
}

function peerCredentials(socket) {
  return new Promise((resolve, reject) => {
    const fd = socket?._handle?.fd;
    if (!Number.isInteger(fd) || fd < 0) return reject(new Error('peer credential fd unavailable'));
    const child = spawn(PYTHON, ['-c', PEER_CRED_SCRIPT], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', fd]
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || 'peer credential probe failed'));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('invalid peer credential result')); }
    });
  });
}

async function hasSession() {
  try {
    await run(TMUX, ['-S', TMUX_SOCKET, 'has-session', '-t', SESSION]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function loadRuntimeEnvironment() {
  const text = await readFile(OMBRE_ENV_FILE, 'utf8');
  const allowed = new Set(['OMBRE_MCP_URL', 'OMBRE_HEADER_1']);
  const values = {};
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !allowed.has(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  for (const key of allowed) if (!values[key]) throw new Error(`required runtime environment missing: ${key}`);
  if (!process.env[HOOK_SECRET_ENV]) throw new Error('required hook secret missing');
  return {
    HOME: '/root',
    USER: 'root',
    LOGNAME: 'root',
    PATH: '/root/.bun/bin:/usr/local/bin:/usr/bin:/bin',
    [HOOK_SECRET_ENV]: process.env[HOOK_SECRET_ENV],
    ...values
  };
}

async function ensureSession() {
  if (await hasSession()) return { created: false };
  const env = await loadRuntimeEnvironment();
  await run(TMUX, ['-S', TMUX_SOCKET, 'new-session', '-d', '-s', SESSION, '-c', WORKSPACE, CLAUDE, '--settings', sessionSettings()], { env });
  return { created: true };
}

async function sendPrompt(turnId, prompt) {
  if (!await hasSession()) throw Object.assign(new Error('runtime session is not running'), { status: 409 });
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (!prompt.trim() || bytes > MAX_PROMPT_BYTES) throw Object.assign(new Error('invalid prompt'), { status: 400 });
  const buffer = `dwell-${turnId}`;
  activeTurn.reserve(turnId);
  let loaded = false;
  try {
    await run(TMUX, ['-S', TMUX_SOCKET, 'load-buffer', '-b', buffer, '-'], { input: prompt.replace(/\r\n?/g, '\n') });
    loaded = true;
    await run(TMUX, ['-S', TMUX_SOCKET, 'paste-buffer', '-p', '-b', buffer, '-t', SESSION]);
    await new Promise(resolve => setTimeout(resolve, 900));
    await run(TMUX, ['-S', TMUX_SOCKET, 'send-keys', '-t', SESSION, 'Enter']);
    activeTurn.markSent(turnId);
  } catch (error) {
    activeTurn.failBeforeSent(turnId);
    throw error;
  } finally {
    if (loaded) await run(TMUX, ['-S', TMUX_SOCKET, 'delete-buffer', '-b', buffer]).catch(() => undefined);
  }
}

async function stopTurn(turnId) {
  if (!activeTurn.get() || activeTurn.get().turnId !== turnId) throw Object.assign(new Error('active turn not found'), { status: 404 });
  if (!await hasSession()) {
    activeTurn.clear();
    throw Object.assign(new Error('runtime session is not running'), { status: 409 });
  }
  await run(TMUX, ['-S', TMUX_SOCKET, 'send-keys', '-t', SESSION, 'Escape']);
  activeTurn.complete(turnId);
}

function completeTurn(turnId) {
  activeTurn.complete(turnId);
}

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function dispatch(message) {
  if (message.op === 'status') {
    if (!exactFields(message, ['op'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    const running = await hasSession();
    if (!running) activeTurn.clear();
    return { ok: true, running, ...activeTurn.status(), session: SESSION };
  }
  if (message.op === 'ensure') {
    if (!exactFields(message, ['op'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    const result = await ensureSession();
    return { ok: true, running: true, created: result.created, session: SESSION };
  }
  if (message.op === 'send') {
    if (!exactFields(message, ['op', 'turnId', 'prompt'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    if (!TURN_ID.test(String(message.turnId || '')) || typeof message.prompt !== 'string') throw Object.assign(new Error('invalid request'), { status: 400 });
    await sendPrompt(message.turnId, message.prompt);
    return { ok: true };
  }
  if (message.op === 'stop') {
    if (!exactFields(message, ['op', 'turnId'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    if (!TURN_ID.test(String(message.turnId || ''))) throw Object.assign(new Error('invalid request'), { status: 400 });
    await stopTurn(message.turnId);
    return { ok: true };
  }
  if (message.op === 'complete') {
    if (!exactFields(message, ['op', 'turnId'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    if (!TURN_ID.test(String(message.turnId || ''))) throw Object.assign(new Error('invalid request'), { status: 400 });
    completeTurn(message.turnId);
    return { ok: true };
  }
  throw Object.assign(new Error('unknown op'), { status: 400 });
}

const isClientDisconnect = error => ['EPIPE', 'ECONNRESET'].includes(error?.code);

function reply(socket, value) {
  if (socket.destroyed || !socket.writable) return false;
  try {
    socket.end(JSON.stringify(value) + '\n', error => {
      if (!error) return;
      if (isClientDisconnect(error)) return process.stderr.write(`bridge client disconnected: ${error.code}\n`);
      socket.destroy(error);
    });
    return true;
  } catch (error) {
    if (isClientDisconnect(error)) {
      process.stderr.write(`bridge client disconnected: ${error.code}\n`);
      return false;
    }
    throw error;
  }
}

const server = net.createServer({ allowHalfOpen: true }, socket => {
  let raw = '';
  let rejected = false;
  socket.on('error', error => {
    if (isClientDisconnect(error)) process.stderr.write(`bridge client disconnected: ${error.code}\n`);
    else process.stderr.write(`bridge connection error: ${error.message}\n`);
  });
  socket.setEncoding('utf8');
  socket.setTimeout(5000, () => socket.destroy());
  peerCredentials(socket).then(credentials => {
    if (credentials.uid !== ALLOWED_UID) {
      rejected = true;
      reply(socket, { ok: false, status: 403, error: 'forbidden' });
      return;
    }
    socket.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
        rejected = true;
        reply(socket, { ok: false, status: 413, error: 'request too large' });
      }
    });
    socket.on('end', async () => {
      if (rejected) return;
      try {
        const message = JSON.parse(raw);
        reply(socket, await dispatch(message));
      } catch (error) {
        reply(socket, { ok: false, status: error.status || 400, error: error.message || 'invalid request' });
      }
    });
  }).catch(() => {
    rejected = true;
    reply(socket, { ok: false, status: 403, error: 'peer verification failed' });
  });
});

server.on('error', error => {
  process.stderr.write(`bridge error: ${error.message}\n`);
  process.exitCode = 1;
});

server.listen({ fd: SOCKET_FD });
