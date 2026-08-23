#!/usr/bin/env node

const httpUrl = process.env.BOBO_RUN_HTTP_URL || 'http://127.0.0.1:3100/';
const wsUrl = process.env.BOBO_RUN_WS_URL || 'ws://127.0.0.1:3101/ws';
const terminalUrl = process.env.BOBO_RUN_TERMINAL_URL || 'ws://127.0.0.1:3101/terminal';
const token = process.env.BOBO_RUN_TOKEN || '';
const folderName = process.env.BOBO_RUN_FOLDER_NAME || 'tryjava';
const folderKey = process.env.BOBO_RUN_FOLDER_KEY || 'pqwvdum';
const runtime = process.env.BOBO_RUN_RUNTIME || 'python:3.10';
const filePath = process.env.BOBO_RUN_FILE || 'nmsl.py';
const iterations = Number(process.env.BOBO_RUN_ITERATIONS || 3);
const timeoutMs = Number(process.env.BOBO_RUN_TIMEOUT_MS || 60000);
const holdTerminal = process.env.BOBO_RUN_HOLD_TERMINAL === '1';

if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
  throw new Error('Node.js 22 or newer is required');
}
if (!token) throw new Error('BOBO_RUN_TOKEN is required');
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
  throw new Error('BOBO_RUN_ITERATIONS must be between 1 and 20');
}

async function startRun() {
  const startedAt = performance.now();
  const response = await fetch(httpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'runCode',
      folderName,
      folderKey,
      filePath,
      runtime,
    }),
  });
  const handshake = await response.json();
  if (!response.ok || !handshake.success || !handshake.runId || !handshake.token) {
    throw new Error(`Run handshake failed: ${handshake.error || response.status}`);
  }
  return {
    runId: handshake.runId,
    runToken: handshake.token,
    handshakeMs: Math.round(performance.now() - startedAt),
    startedAt,
  };
}

async function attachRun(run) {
  const socket = new WebSocket(wsUrl);
  const transcript = [];
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for run result')), timeoutMs);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'attach', runId: run.runId, token: run.runToken }));
      });
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          reject(error);
          return;
        }
        if (['status', 'stdout', 'stderr', 'error'].includes(message.type)) {
          transcript.push(String(message.line || message.message || ''));
          if (transcript.length > 30) transcript.shift();
        }
        if (message.type === 'error') {
          reject(new Error(message.message || 'Run stream failed'));
          return;
        }
        if (message.type !== 'result') return;
        resolve({
          success: message.success === true,
          returnCode: Number(message.returncode || 0),
          handshakeMs: run.handshakeMs,
          totalMs: Math.round(performance.now() - run.startedAt),
          transcript,
        });
      });
      socket.addEventListener('error', () => reject(new Error('Run WebSocket failed')));
      socket.addEventListener('close', () => reject(new Error('Run WebSocket closed before result')));
    });
  } finally {
    clearTimeout(timer);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, 'smoke complete');
    }
  }
}

async function openTerminal() {
  const startedAt = performance.now();
  const socket = new WebSocket(terminalUrl);
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening cloud terminal')), timeoutMs);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        type: 'terminal.start',
        protocol: 1,
        token,
        runtimeId: runtime,
        workspace: { kind: 'personal', folderName, folderKey },
        setupCommands: [],
        cols: 120,
        rows: 32,
      }));
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (message.type === 'terminal.error') {
        clearTimeout(timer);
        reject(new Error(message.message || 'Cloud terminal failed'));
      } else if (message.type === 'terminal.ready') {
        clearTimeout(timer);
        resolve({ readyMs: Math.round(performance.now() - startedAt) });
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Cloud terminal WebSocket failed'));
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error('Cloud terminal closed before ready'));
    });
  });
  return { socket, readyMs: ready.readyMs };
}

async function closeTerminal(terminal) {
  if (!terminal || terminal.socket.readyState !== WebSocket.OPEN) return false;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out closing cloud terminal')), timeoutMs);
    terminal.socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data);
        if (message.type !== 'terminal.exit') return;
        clearTimeout(timer);
        resolve(message.cleanupConfirmed !== false);
      } catch (_) {}
    });
    terminal.socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Cloud terminal failed during close'));
    });
    terminal.socket.send(JSON.stringify({ type: 'terminal.close' }));
  });
  terminal.socket.close(1000, 'smoke complete');
  return result;
}

const terminal = holdTerminal ? await openTerminal() : null;
const runs = [];
let terminalCleanupConfirmed = null;
try {
  for (let index = 0; index < iterations; index += 1) {
    const result = await attachRun(await startRun());
    if (!result.success) {
      throw new Error(`Run ${index + 1} failed with exit code ${result.returnCode}: ${result.transcript.join('\n')}`);
    }
    runs.push(result);
  }
} finally {
  if (terminal) terminalCleanupConfirmed = await closeTerminal(terminal);
}

console.log(JSON.stringify({
  success: true,
  folderName,
  runtime,
  filePath,
  iterations,
  terminalHeldOpen: holdTerminal,
  terminalReadyMs: terminal?.readyMs || null,
  terminalCleanupConfirmed,
  totalMs: runs.map((run) => run.totalMs),
  handshakeMs: runs.map((run) => run.handshakeMs),
}));
