/**
 * Voice Terminal Server (Node.js version)
 * Uses node-pty + xterm.js
 * Full control over terminal input - ASR text goes directly to PTY
 */

// Prevent unhandled errors from crashing the server
// IMPORTANT: Ignore EPIPE errors to avoid infinite loop when stderr pipe breaks
// (console.error on broken pipe → EPIPE → uncaughtException → console.error → ...)
process.on('SIGPIPE', () => {}); // Ignore broken pipe signals
process.on('uncaughtException', (err) => {
  if ((err as any)?.code === 'EPIPE') return; // Silently ignore broken pipes
  try { console.error('Uncaught exception:', err.message); } catch {}
});
process.on('unhandledRejection', (err: any) => {
  if (err?.code === 'EPIPE') return;
  try { console.error('Unhandled rejection:', err?.message || err); } catch {}
});

import 'dotenv/config';
import * as http from 'http';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import xtermHeadless from '@xterm/headless';
const HeadlessTerminal = xtermHeadless.Terminal;
import { SerializeAddon } from '@xterm/addon-serialize';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000');
const PASSWORD = process.env.AUTH_PASSWORD || 'success1000';
const AUTH_TOKEN = 'voice_terminal_auth_' + Buffer.from(PASSWORD).toString('base64');

// Voice/ASR config
const VOLCANO_APP_ID = process.env.VOLCANO_APP_ID || '';
const VOLCANO_TOKEN = process.env.VOLCANO_TOKEN || '';
const VOLCANO_ASR_RESOURCE_ID = process.env.VOLCANO_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration';
const VOLCANO_ASR_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

// Store active PTY sessions and their WebSocket clients
interface Session {
  pty: pty.IPty;
  clients: Set<WebSocket>;
  headlessTerm: InstanceType<typeof HeadlessTerminal>;
  serializeAddon: InstanceType<typeof SerializeAddon>;
  name: string;
  createdAt: number;
}
const sessions = new Map<string, Session>();
let sessionCounter = 0;

// Sessions HTML cache - invalidated when sessions change
let sessionsHtmlCache: string | null = null;
function invalidateSessionsCache() { sessionsHtmlCache = null; }

// --- Volcano ASR streaming protocol (native TypeScript) ---

function buildFullClientRequest(payload: object): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
  const gzipped = zlib.gzipSync(jsonBytes);
  // Header: version=1|header_size=1, msg_type=1(FullClient)|flags=0, serial=1(JSON)|compress=1(gzip), reserved=0
  const header = Buffer.from([0x11, 0x10, 0x11, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(gzipped.length);
  return Buffer.concat([header, size, gzipped]);
}

function buildAudioRequest(audioData: Buffer, isLast: boolean): Buffer {
  // msg_type=0b0010(AudioOnly), flags: 0b0010=final, 0b0000=non-final
  const flags = isLast ? 0b0010 : 0b0000;
  const msgTypeFlags = (0b0010 << 4) | flags;
  const header = Buffer.from([0x11, msgTypeFlags, 0x00, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(audioData.length);
  return Buffer.concat([header, size, audioData]);
}

function parseAsrResponse(data: Buffer): { msgType: number; result?: any; error?: string } {
  if (data.length < 12) return { msgType: 0, error: 'Response too short' };
  const msgType = (data[1] >> 4) & 0x0F;
  const compression = data[2] & 0x0F;
  const payloadSize = data.readUInt32BE(8);
  let payload = data.subarray(12, 12 + payloadSize);
  if (compression === 1) {
    try { payload = zlib.gunzipSync(payload); } catch {}
  }
  try {
    const result = JSON.parse(payload.toString('utf-8'));
    return { msgType, result };
  } catch {
    return { msgType, error: 'Parse error' };
  }
}

interface AsrSession {
  volcanoWs: WebSocket | null;
  ready: boolean;
  pendingChunks: Buffer[];
}

function startAsrSession(clientWs: WebSocket): AsrSession {
  const asrSession: AsrSession = { volcanoWs: null, ready: false, pendingChunks: [] };

  const headers = {
    'X-Api-App-Key': VOLCANO_APP_ID,
    'X-Api-Access-Key': VOLCANO_TOKEN,
    'X-Api-Resource-Id': VOLCANO_ASR_RESOURCE_ID,
    'X-Api-Connect-Id': randomUUID(),
  };

  const volcanoWs = new WebSocket(VOLCANO_ASR_ENDPOINT, { headers });
  asrSession.volcanoWs = volcanoWs;

  volcanoWs.on('open', () => {
    // Send init payload
    const initPayload = {
      user: { uid: randomUUID() },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
      request: {
        model_name: 'bigmodel',
        language: 'zh',
        enable_itn: true,
        enable_punc: true,
        result_type: 'full',
        show_utterances: true,
      },
    };
    volcanoWs.send(buildFullClientRequest(initPayload));
    asrSession.ready = true;
    // Flush any audio chunks that arrived while connecting
    const pending = asrSession.pendingChunks;
    asrSession.pendingChunks = [];
    for (const chunk of pending) {
      const isLast = chunk.length === 0; // empty buffer = final sentinel
      volcanoWs.send(buildAudioRequest(chunk, isLast));
    }
    console.log(`ASR session connected to Volcano (flushed ${pending.length} buffered chunks)`);
  });

  volcanoWs.on('message', (data: Buffer) => {
    try {
      const parsed = parseAsrResponse(Buffer.from(data));
      if (parsed.msgType === 15) {
        console.error('ASR server error:', parsed.result || parsed.error);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'ASR server error' }));
        }
        return;
      }
      if (parsed.msgType === 9 && parsed.result?.result) {
        const res = parsed.result.result;
        const text = (res.text || '').trim().replace(/[.。]$/, '');
        if (text && clientWs.readyState === WebSocket.OPEN) {
          const utterances = res.utterances || [];
          const definite = utterances.length > 0 && utterances[0].definite;
          // Always send the full cumulative text; client decides when to submit
          clientWs.send(JSON.stringify({
            type: definite ? 'asr' : 'asr_partial',
            text,
          }));
          if (definite) {
            console.log(`ASR final: "${text}"`);
          }
        }
      }
    } catch (e) {
      console.error('ASR response error:', (e as Error).message);
    }
  });

  volcanoWs.on('error', (err) => {
    console.error('ASR WebSocket error:', err.message);
    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'ASR connection error' }));
      }
    } catch {}
  });

  volcanoWs.on('close', () => {
    asrSession.ready = false;
    console.log('ASR session closed');
  });

  return asrSession;
}

// Voice clients
const voiceClients = new Map<string, WebSocket>();

// Create a new PTY session (direct bash, no tmux)
function createSession(id: string): Session {
  // Direct bash shell - interactive login shell
  const ptyProcess = pty.spawn('/bin/bash', ['--login', '-i'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME || '/',
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE')
      ) as { [key: string]: string },
      TERM: 'xterm-256color',
      SHELL: '/bin/bash',
      PS1: '\\[\\033[32m\\]\\u\\[\\033[0m\\]:\\[\\033[34m\\]\\W\\[\\033[0m\\]\\$ ',
    },
  });

  sessionCounter++;

  // Headless terminal tracks screen state for efficient reconnection
  const headlessTerm = new HeadlessTerminal({ cols: 120, rows: 30, scrollback: 500, allowProposedApi: true });
  const serializeAddon = new SerializeAddon();
  headlessTerm.loadAddon(serializeAddon);

  const session: Session = {
    pty: ptyProcess,
    clients: new Set(),
    headlessTerm,
    serializeAddon,
    name: `Session ${sessionCounter}`,
    createdAt: Date.now(),
  };

  console.log(`Created PTY session: ${id} - ${session.name}`);

  // Broadcast PTY output to all connected clients and feed headless terminal
  ptyProcess.onData((data) => {
    session.headlessTerm.write(data);

    const message = JSON.stringify({ type: 'output', data });
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`PTY exited with code ${exitCode}`);
    session.headlessTerm.dispose();
    sessions.delete(id);
    invalidateSessionsCache();
    for (const client of session.clients) {
      client.close();
    }
  });

  sessions.set(id, session);
  invalidateSessionsCache();
  return session;
}

// Get or create a session by ID
function getSession(id: string): Session {
  return sessions.get(id) || createSession(id);
}


// Login page HTML
const loginHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Voice Terminal - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; background: #1a1a2e; display: flex; align-items: center; justify-content: center; font-family: system-ui; padding: 16px; }
    .login-box { background: #16213e; padding: 40px; border-radius: 12px; border: 2px solid #0f3460; width: 100%; max-width: 400px; }
    h1 { color: #4ade80; margin-bottom: 24px; font-size: 24px; text-align: center; }
    input { width: 100%; padding: 12px 16px; font-size: 16px; border: none; border-radius: 8px; background: #1a1a2e; color: #e0e0e0; margin-bottom: 16px; }
    input:focus { outline: 2px solid #4ade80; }
    button { width: 100%; padding: 12px; font-size: 16px; border: none; border-radius: 8px; background: #4ade80; color: #000; cursor: pointer; font-weight: bold; }
    button:hover { background: #22c55e; }
    .error { color: #f87171; font-size: 14px; margin-bottom: 16px; text-align: center; display: none; }
    @media (max-width: 400px) {
      .login-box { padding: 24px; }
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Voice Terminal</h1>
    <div class="error" id="error">Incorrect password</div>
    <form onsubmit="return login()">
      <input type="password" id="password" placeholder="Password" autofocus>
      <button type="submit">Login</button>
    </form>
  </div>
  <script>
    function login() {
      const pwd = document.getElementById('password').value;
      fetch('/terminal/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) })
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            document.cookie = 'auth=' + d.token + '; path=/; max-age=86400';
            location.reload();
          } else {
            document.getElementById('error').style.display = 'block';
          }
        });
      return false;
    }
  </script>
</body>
</html>`;

// Session chooser HTML page - generated dynamically with server-side rendering
function buildSessionsHtml(): string {
  if (sessionsHtmlCache) return sessionsHtmlCache;
  const sessionList = Array.from(sessions.entries()).map(([id, s]) => ({
    id, name: s.name, createdAt: s.createdAt, clients: s.clients.size,
  }));
  sessionList.sort((a, b) => b.createdAt - a.createdAt);

  function fmtAge(ts: number): string {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let cardsHtml = '';
  if (sessionList.length === 0) {
    cardsHtml = '<div class="empty-state"><p>No active sessions</p><a class="new-btn" href="/terminal?action=new">Create your first session</a></div>';
  } else {
    for (const s of sessionList) {
      const cl = s.clients === 0 ? 'idle' : s.clients === 1 ? '1 client' : s.clients + ' clients';
      const badgeClass = s.clients > 0 ? ' active' : '';
      cardsHtml += `<a class="session-card" href="/terminal?session=${encodeURIComponent(s.id)}">
        <div class="session-info"><div class="session-name">${esc(s.name)}</div>
        <div class="session-meta">Created ${fmtAge(s.createdAt)}</div></div>
        <span class="session-badge${badgeClass}">${cl}</span></a>`;
    }
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta http-equiv="refresh" content="5">
  <title>Voice Terminal - Sessions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { min-height: 100%; background: #1a1a2e; font-family: system-ui; color: #e0e0e0; }
    .container { max-width: 700px; margin: 0 auto; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    h1 { color: #4ade80; font-size: 24px; }
    .new-btn {
      padding: 10px 20px; background: #4ade80; color: #000; border: none;
      border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;
      text-decoration: none; display: inline-block;
      -webkit-tap-highlight-color: transparent;
    }
    .new-btn:hover { background: #22c55e; }
    .session-list { display: grid; gap: 12px; }
    .session-card {
      background: #16213e; border: 2px solid #0f3460; border-radius: 12px;
      padding: 20px; cursor: pointer; transition: border-color 0.2s;
      display: flex; justify-content: space-between; align-items: center;
      text-decoration: none; color: inherit;
      -webkit-tap-highlight-color: transparent;
    }
    .session-card:hover, .session-card:active { border-color: #4ade80; }
    .session-info { flex: 1; min-width: 0; }
    .session-name { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
    .session-meta { font-size: 13px; color: #888; }
    .session-badge {
      padding: 4px 10px; border-radius: 12px; font-size: 12px;
      background: #1a1a2e; color: #888; white-space: nowrap; margin-left: 12px;
    }
    .session-badge.active { background: #4ade80; color: #000; }
    .empty-state { text-align: center; padding: 60px 20px; color: #666; }
    .empty-state p { margin-bottom: 16px; font-size: 18px; }
    @media (max-width: 500px) {
      .container { padding: 16px; }
      .session-name { font-size: 16px; }
      .session-card { padding: 16px; }
      h1 { font-size: 20px; }
      .new-btn { padding: 8px 14px; font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Voice Terminal</h1>
      <a class="new-btn" href="/terminal?action=new">+ New Session</a>
    </div>
    <div class="session-list">${cardsHtml}</div>
  </div>
</body>
</html>`;
  sessionsHtmlCache = html;
  return html;
}

// Terminal HTML page
const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Voice Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; background: #1a1a2e; overflow: hidden; touch-action: manipulation; }
    #container { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
    #terminal { flex: 1; padding: 8px; min-height: 0; overflow: hidden; }
    #voice-bar {
      background: #16213e; padding: 10px 16px; display: flex; align-items: center; gap: 10px;
      border-top: 2px solid #0f3460; color: #fff; font-family: system-ui; flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }
    #voice-bar.recording { background: #1a3a2e; border-top-color: #4ade80; }
    #status { padding: 6px 12px; background: #333; border-radius: 20px; font-size: 14px; white-space: nowrap; text-align: center; }
    #status.recording { background: #4ade80; color: #000; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
    #text { flex: 1; font-size: 14px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 60px; }
    .font-btn { background: #333; border: none; color: #fff; width: 44px; height: 44px; border-radius: 6px; cursor: pointer; font-size: 18px; -webkit-tap-highlight-color: transparent; flex-shrink: 0; }
    .font-btn:hover { background: #444; }
    #font-size { color: #888; font-size: 12px; min-width: 36px; text-align: center; }
    #font-controls { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    #back-btn { color: #4ade80; font-size: 11px; text-decoration: none; padding: 4px 6px; background: #1a1a2e; border-radius: 6px; white-space: nowrap; flex-shrink: 0; }
    .key-btn { background: #333; border: none; color: #fff; min-width: 40px; height: 36px; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: system-ui; -webkit-tap-highlight-color: transparent; flex-shrink: 0; padding: 0 8px; }
    .key-btn:active { background: #4ade80; color: #000; }
    #special-keys { display: none; align-items: center; gap: 4px; flex: 1; }
    #bar-row1 { display: contents; }
    #bar-row2 { display: contents; }
    #scroll-bottom { background: #333; border: none; color: #fff; min-width: 36px; height: 36px; border-radius: 6px; cursor: pointer; font-size: 16px; -webkit-tap-highlight-color: transparent; flex-shrink: 0; padding: 0; }
    #scroll-bottom:active { background: #4ade80; color: #000; }
    #copy-overlay { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 100; background: #1a1a2e; color: #e0e0e0; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; padding: 8px; border: none; resize: none; white-space: pre; overflow: auto; -webkit-user-select: text; user-select: text; }
    #copy-overlay.active { display: block; }
    body.mobile #voice-bar { padding: 6px 6px; gap: 0; flex-direction: column; }
    body.mobile #bar-row1 { display: flex; align-items: center; gap: 4px; width: 100%; }
    body.mobile #bar-row2 { display: flex; align-items: center; width: 100%; margin-top: 5px; }
    body.mobile #special-keys { display: flex; }
    body.mobile #status { font-size: 13px; padding: 8px; flex: 1; text-align: center; border-radius: 8px; }
    body.mobile #text { display: none; }
    body.mobile #font-controls { display: none; }
    body.mobile .key-btn { min-width: 0; flex: 1; padding: 0 4px; height: 34px; font-size: 12px; }
    body.mobile #back-btn { padding: 4px 5px; font-size: 10px; }
    body.mobile #scroll-bottom { min-width: 34px; height: 34px; font-size: 14px; }
  </style>
</head>
<body>
  <div id="container">
    <div id="terminal"></div>
    <textarea id="copy-overlay" readonly></textarea>
    <div id="voice-bar">
      <div id="bar-row1">
        <a href="/terminal" id="back-btn">Sess</a>
        <div id="special-keys">
          <button class="key-btn" data-key="esc">Esc</button>
          <button class="key-btn" data-key="tab">Tab</button>
          <button class="key-btn" data-key="up">&#x25B2;</button>
          <button class="key-btn" data-key="down">&#x25BC;</button>
          <button class="key-btn" data-key="1">1</button>
          <button class="key-btn" data-key="2">2</button>
          <button class="key-btn" data-key="3">3</button>
          <button class="key-btn" id="copy-btn">Sel</button>
        </div>
        <button id="scroll-bottom" title="Scroll to bottom">&#x21E9;</button>
        <div id="font-controls">
          <button class="font-btn" onclick="changeFontSize(-2)">&#x2212;</button>
          <span id="font-size">21px</span>
          <button class="font-btn" onclick="changeFontSize(2)">+</button>
        </div>
      </div>
      <div id="bar-row2">
        <div id="status">Hold Option to speak</div>
        <div id="text"></div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    window.onerror = function(msg, src, line) {
      document.getElementById('status').textContent = 'JS Error: ' + msg;
      document.getElementById('status').style.background = '#f87171';
    };

    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isMobile) document.body.classList.add('mobile');
    let fontSize = isMobile ? 14 : 21;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#4ade80' }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    function changeFontSize(delta) {
      fontSize = Math.max(10, Math.min(40, fontSize + delta));
      term.options.fontSize = fontSize;
      document.getElementById('font-size').textContent = fontSize + 'px';
      fitAddon.fit();
      if (typeof termWs !== 'undefined' && termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }

    // Session ID from URL
    const sessionId = new URLSearchParams(location.search).get('session');
    if (!sessionId) { location.href = '/terminal'; }

    // Terminal WebSocket with auto-reconnect
    var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws?session=' + sessionId;
    var termWs = null;
    var isReconnect = false;

    function connectTerminal() {
      document.getElementById('status').textContent = isReconnect ? 'Reconnecting...' : 'Connecting...';
      termWs = new WebSocket(wsUrl);
      termWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'scrollback') {
          // Scrollback replay: write with terminal hidden to avoid visual flicker
          const termEl = document.getElementById('terminal');
          termEl.style.visibility = 'hidden';
          if (isReconnect) term.reset();
          term.write(msg.data, () => {
            termEl.style.visibility = '';
            term.scrollToBottom();
          });
        } else if (msg.type === 'output') {
          term.write(msg.data);
        }
      };
      termWs.onopen = () => {
        document.getElementById('status').textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
        document.getElementById('status').style.background = '';
        termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };
      termWs.onerror = () => {
        document.getElementById('status').textContent = 'WS error';
        document.getElementById('status').style.background = '#f87171';
      };
      termWs.onclose = (e) => {
        document.getElementById('status').textContent = 'Disconnected - reconnecting...';
        document.getElementById('status').style.background = '#f97316';
        isReconnect = true;
        setTimeout(connectTerminal, 2000);
      };
    }
    connectTerminal();

    function sendInput(data) {
      if (termWs && termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'input', data: data }));
      }
    }

    term.onData((data) => { sendInput(data); });

    // Debounced resize to avoid PTY redraw storms (e.g. mobile keyboard toggle)
    var resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        if (termWs && termWs.readyState === 1) {
          termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }, 300);
    });

    // Special key buttons for mobile
    var keyMap = { esc: String.fromCharCode(27), tab: String.fromCharCode(9), up: String.fromCharCode(27) + '[A', down: String.fromCharCode(27) + '[B', '1': '1', '2': '2', '3': '3' };
    document.querySelectorAll('.key-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        var seq = keyMap[btn.getAttribute('data-key')];
        if (seq) sendInput(seq);
        term.focus();
      });
    });


    // Scroll to bottom button
    document.getElementById('scroll-bottom').addEventListener('click', function(e) {
      e.preventDefault();
      term.scrollToBottom();
      term.focus();
    });

    // Select/Copy mode: show terminal text in a selectable overlay
    var copyOverlay = document.getElementById('copy-overlay');
    var copyBtn = document.getElementById('copy-btn');
    copyBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (copyOverlay.classList.contains('active')) {
        // Close overlay
        copyOverlay.classList.remove('active');
        copyBtn.textContent = 'Sel';
        copyBtn.style.background = '';
        term.focus();
      } else {
        // Extract visible terminal text from buffer
        var buf = term.buffer.active;
        var lines = [];
        for (var i = 0; i < buf.length; i++) {
          var line = buf.getLine(i);
          if (line) lines.push(line.translateToString(true));
        }
        copyOverlay.value = lines.join(String.fromCharCode(10));
        copyOverlay.classList.add('active');
        copyOverlay.scrollTop = copyOverlay.scrollHeight;
        copyBtn.textContent = 'Back';
        copyBtn.style.background = '#4ade80';
        copyBtn.style.color = '#000';
      }
    });

    // Voice setup - streaming ASR (sends PCM in real-time)
    const status = document.getElementById('status');
    const text = document.getElementById('text');
    let voiceWs, audioStream, audioContext, sourceNode, processorNode;
    let isRecording = false, audioReady = false;
    var pendingAsrText = ''; // Accumulate ASR text, send only when recording ends
    var asrFlushed = false; // Prevent flushing more than once per recording

    function flushAsrText() {
      if (asrFlushed) return;
      if (pendingAsrText && termWs && termWs.readyState === 1) {
        asrFlushed = true;
        text.textContent = pendingAsrText;
        status.textContent = 'Sending to terminal...';
        termWs.send(JSON.stringify({ type: 'asr', text: pendingAsrText }));
        setTimeout(function() { status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak'; }, 2000);
      } else {
        status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
      }
      pendingAsrText = '';
    }

    function connectVoice() {
      voiceWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws-voice');
      voiceWs.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.type === 'asr' && d.text) {
          clearTimeout(processingTimeout);
          pendingAsrText = d.text;
          text.textContent = d.text;
          // Don't send to terminal yet - wait for recording to fully end
          // If recording already ended (Processing state), flush now
          if (!isRecording && !stopRecTimer) {
            flushAsrText();
          }
        } else if (d.type === 'asr_partial' && d.text) {
          pendingAsrText = d.text;
          text.textContent = d.text;
        }
      };
      voiceWs.onclose = () => {
        // Reset all recording state
        clearTimeout(stopRecTimer);
        stopRecTimer = null;
        isRecording = false;
        releaseMic();
        status.classList.remove('recording');
        if (status.textContent === 'Processing...' || status.textContent === 'Finishing...' || status.textContent === 'Recording...') {
          status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
        }
        setTimeout(connectVoice, 2000);
      };
    }

    async function acquireMic() {
      if (audioReady) return true;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
        audioContext = new AudioContext({ sampleRate: 16000 });
        sourceNode = audioContext.createMediaStreamSource(audioStream);
        processorNode = audioContext.createScriptProcessor(4096, 1, 1);
        processorNode.onaudioprocess = function(e) {
          if (!isRecording || !voiceWs || voiceWs.readyState !== 1) return;
          var input = e.inputBuffer.getChannelData(0);
          var pcm = new Int16Array(input.length);
          for (var i = 0; i < input.length; i++) {
            pcm[i] = Math.max(-1, Math.min(1, input[i])) * (input[i] < 0 ? 0x8000 : 0x7FFF);
          }
          voiceWs.send(pcm.buffer);
        };
        sourceNode.connect(processorNode);
        processorNode.connect(audioContext.destination);
        audioReady = true;
        return true;
      } catch (e) {
        status.textContent = 'Mic error';
        return false;
      }
    }

    function releaseMic() {
      audioReady = false;
      if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
      if (processorNode) { try { processorNode.disconnect(); } catch {} processorNode = null; }
      if (audioStream) { audioStream.getTracks().forEach(function(t) { t.stop(); }); audioStream = null; }
      if (audioContext) { try { audioContext.close(); } catch {} audioContext = null; }
    }

    async function startRec() {
      if (isRecording) return;
      var ok = await acquireMic();
      if (!ok) return;
      if (audioContext.state === 'suspended') audioContext.resume();
      isRecording = true;
      asrFlushed = false;
      pendingAsrText = '';
      if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_start' }));
      status.textContent = 'Recording...';
      status.classList.add('recording');
      text.textContent = '';
    }

    var processingTimeout = null;
    var stopRecTimer = null;
    var stopRecRequestedAt = 0;
    function stopRec() {
      if (!isRecording) return;
      // Keep recording for 1000ms to capture trailing sound, then finalize
      if (!stopRecTimer) {
        stopRecRequestedAt = Date.now();
        status.textContent = 'Finishing...';
        status.classList.remove('recording');
        stopRecTimer = setTimeout(function() {
          stopRecTimer = null;
          if (!isRecording) return;
          isRecording = false;
          if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_end' }));
          releaseMic();
          status.textContent = 'Processing...';
          clearTimeout(processingTimeout);
          processingTimeout = setTimeout(function() {
            // Safety: if no final ASR result after 10s, flush whatever we have
            if (status.textContent === 'Processing...') {
              flushAsrText();
            }
          }, 10000);
        }, 1000);
      }
    }

    let altDown = false, altDownTime = 0, altCombined = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Alt' && !altDown) {
        altDown = true;
        altDownTime = Date.now();
        altCombined = false;
        startRec();
        e.preventDefault();
        e.stopPropagation();
      } else if (altDown && e.key !== 'Alt') {
        // Option combined with another key - cancel recording
        altCombined = true;
        if (isRecording) {
          stopRec();
          status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
        }
      }
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' && altDown) {
        altDown = false;
        const holdDuration = Date.now() - altDownTime;
        if (altCombined || holdDuration < 800) {
          // Combined with other key or too short - discard
          if (isRecording) {
            stopRec();
            status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
          }
        } else {
          stopRec();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    // Update font size display to match initial value
    document.getElementById('font-size').textContent = fontSize + 'px';

    // Mobile: entire voice bar is hold-to-speak (except font controls and back button)
    const voiceBar = document.getElementById('voice-bar');
    const fontControls = document.getElementById('font-controls');
    const backBtn = document.getElementById('back-btn');
    var specialKeys = document.getElementById('special-keys');
    var scrollBtn = document.getElementById('scroll-bottom');
    function isExcluded(el) {
      return (fontControls && fontControls.contains(el)) || (backBtn && backBtn.contains(el)) || (specialKeys && specialKeys.contains(el)) || el === scrollBtn;
    }
    voiceBar.addEventListener('touchstart', (e) => {
      if (isExcluded(e.target)) return;
      e.preventDefault();
      startRec();
      voiceBar.classList.add('recording');
    }, { passive: false });
    voiceBar.addEventListener('touchend', (e) => {
      if (isExcluded(e.target)) return;
      e.preventDefault();
      stopRec();
      voiceBar.classList.remove('recording');
    }, { passive: false });
    voiceBar.addEventListener('touchcancel', () => {
      stopRec();
      voiceBar.classList.remove('recording');
    });

    // Update status text for mobile
    if (isMobile) {
      status.textContent = 'Hold here to speak';
    }

    term.focus();
    connectVoice();
  </script>
</body>
</html>`;

// Helper: parse cookies
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const idx = c.indexOf('=');
      if (idx > 0) {
        const k = c.substring(0, idx).trim();
        const v = c.substring(idx + 1).trim();
        cookies[k] = v;
      }
    });
  }
  return cookies;
}

// Helper: check auth
function isAuthenticated(req: http.IncomingMessage): boolean {
  const cookies = parseCookies(req.headers.cookie);
  return cookies.auth === AUTH_TOKEN;
}

// HTTP server
const server = http.createServer((req, res) => {
  // CORS headers for cross-origin requests
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Only log non-routine requests
  if (req.url !== '/health' && !req.url?.startsWith('/terminal?session=')) {
    console.log(`HTTP ${req.method} ${req.url}`);
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Handle login POST (accept both direct and proxy-rewritten paths)
  if ((req.url === '/login' || req.url === '/terminal/login') && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        const { password } = JSON.parse(body);
        if (password === PASSWORD) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `auth=${AUTH_TOKEN}; Path=/; Max-Age=86400; SameSite=Lax`
          });
          res.end(JSON.stringify({ success: true, token: AUTH_TOKEN }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false }));
        }
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    req.resume(); // Ensure data flows even if buffered
    return;
  }

  // Check authentication
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.auth !== AUTH_TOKEN) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginHtml);
    return;
  }

  // --- Authenticated routes below ---
  // Everything goes through /terminal so the reverse proxy forwards it
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const action = url.searchParams.get('action');
  const sessionId = url.searchParams.get('session');

  // Create new session: /terminal?action=new
  if (action === 'new') {
    const id = 'sess_' + Math.random().toString(36).substring(2, 10);
    createSession(id);
    res.writeHead(302, { 'Location': '/terminal?session=' + encodeURIComponent(id) });
    res.end();
    return;
  }

  // Terminal page: /terminal?session=xxx
  if (sessionId) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(indexHtml);
    return;
  }

  // Session chooser (default for /terminal with no params, or any other path)
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(buildSessionsHtml());
});

// Terminal WebSocket server
const terminalWss = new WebSocketServer({ noServer: true });
terminalWss.on('connection', (ws, req) => {
  // Extract session ID from URL query
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session') || 'default';

  const session = getSession(sessionId);
  session.clients.add(ws);
  invalidateSessionsCache();
  console.log(`Terminal client connected: ${sessionId}`);

  // Send serialized terminal state (current screen + some scrollback) instead of raw replay
  try {
    const serialized = session.serializeAddon.serialize({ scrollback: 500 });
    if (serialized) {
      ws.send(JSON.stringify({ type: 'scrollback', data: serialized }));
    }
  } catch (e) {
    console.error('Serialize error:', e);
  }

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.type === 'input') {
        session.pty.write(msg.data);
      } else if (msg.type === 'resize') {
        try {
          if (msg.cols > 0 && msg.rows > 0) {
            session.pty.resize(msg.cols, msg.rows);
            session.headlessTerm.resize(msg.cols, msg.rows);
          }
        } catch (e) {
          // Ignore resize errors (can happen during session transitions)
        }
      } else if (msg.type === 'asr') {
        console.log(`ASR input: "${msg.text}"`);
        // Direct write: text + carriage return
        session.pty.write(msg.text + '\r');
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    invalidateSessionsCache();
    console.log(`Terminal client disconnected: ${sessionId}`);
  });
});

// Voice WebSocket server - streaming ASR
const voiceWss = new WebSocketServer({ noServer: true });
voiceWss.on('connection', (ws) => {
  const id = Math.random().toString(36).substring(7);
  voiceClients.set(id, ws);
  console.log(`Voice client connected: ${id}`);

  let asrSession: AsrSession | null = null;

  ws.on('message', (message) => {
    try {
      // Detect JSON control messages: must be a string type, or a short Buffer starting with '{'
      const isJson = typeof message === 'string' ||
        (message instanceof Buffer && message.length < 512 && message[0] === 0x7b);
      if (isJson) {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'asr_start') {
          // Start a new streaming ASR session
          if (asrSession?.volcanoWs) {
            try { asrSession.volcanoWs.close(); } catch {}
          }
          asrSession = startAsrSession(ws);
          console.log(`ASR streaming started for ${id}`);
        } else if (msg.type === 'asr_end') {
          // Send empty final chunk to signal end of audio
          if (asrSession) {
            if (asrSession.ready && asrSession.volcanoWs?.readyState === WebSocket.OPEN) {
              asrSession.volcanoWs.send(buildAudioRequest(Buffer.alloc(0), true));
              console.log(`ASR streaming ended for ${id}`);
            } else {
              // Volcano not ready yet - mark pending end so it's sent after flush
              asrSession.pendingChunks.push(Buffer.alloc(0)); // sentinel for final
              console.log(`ASR end queued (Volcano not ready yet) for ${id}`);
            }
          }
        }
      } else if (message instanceof Buffer) {
        // Binary = raw PCM audio chunk, forward to Volcano
        if (asrSession) {
          if (asrSession.ready && asrSession.volcanoWs?.readyState === WebSocket.OPEN) {
            asrSession.volcanoWs.send(buildAudioRequest(message, false));
          } else {
            // Buffer chunks while Volcano WebSocket is still connecting
            asrSession.pendingChunks.push(Buffer.from(message));
          }
        }
      }
    } catch (e) {
      // Don't let parse errors kill the voice connection
      console.error(`Voice message error for ${id}:`, (e as Error).message);
    }
  });

  ws.on('close', () => {
    if (asrSession?.volcanoWs) {
      try { asrSession.volcanoWs.close(); } catch {}
    }
    voiceClients.delete(id);
    console.log(`Voice client disconnected: ${id}`);
  });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  // Skip auth check for WebSocket (browsers don't auto-send cookies on WS)
  const url = new URL(request.url!, `http://${request.headers.host}`);

  // Accept both direct paths and proxy-rewritten paths:
  // Direct: /terminal/ws, /terminal/ws-voice
  // Via proxy (strips /terminal): /ws, /ws-voice
  // Legacy: /ws/terminal, /ws/voice
  const p = url.pathname;
  if (p === '/ws' || p === '/terminal/ws' || p === '/ws/terminal') {
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      terminalWss.emit('connection', ws, request);
    });
  } else if (p === '/ws-voice' || p === '/terminal/ws-voice' || p === '/ws/voice') {
    voiceWss.handleUpgrade(request, socket, head, (ws) => {
      voiceWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Start
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║           Voice Terminal Server                ║
╠════════════════════════════════════════════════╣
║  Web UI:    http://localhost:${PORT}              ║
║  Terminal:  ws://localhost:${PORT}/ws/terminal    ║
║  Voice:     ws://localhost:${PORT}/ws/voice       ║
╚════════════════════════════════════════════════╝

=== Server ready ===
`);

  // Start Cloudflare Tunnel if requested via --tunnel flag or CLOUDFLARE_TUNNEL env
  const wantTunnel = process.argv.includes('--tunnel') || process.env.CLOUDFLARE_TUNNEL === '1';
  if (wantTunnel) {
    startCloudflareTunnel();
  }
});

function startCloudflareTunnel() {
  const tunnelProc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tunnelUrl = '';

  function parseLine(line: string) {
    // cloudflared prints the URL like: "https://xxx-yyy-zzz.trycloudflare.com"
    const match = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[1];
      console.log(`
╔════════════════════════════════════════════════╗
║         Cloudflare Tunnel Active              ║
╠════════════════════════════════════════════════╣
║  Public URL: ${tunnelUrl}
╚════════════════════════════════════════════════╝
`);
    }
  }

  tunnelProc.stdout.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(parseLine);
  });
  tunnelProc.stderr.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(parseLine);
  });

  tunnelProc.on('error', (err) => {
    console.error('Failed to start cloudflared:', err.message);
    console.error('Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  });

  tunnelProc.on('exit', (code) => {
    console.error(`cloudflared exited with code ${code}`);
  });

  // Clean up tunnel on server exit
  process.on('SIGINT', () => { tunnelProc.kill(); process.exit(); });
  process.on('SIGTERM', () => { tunnelProc.kill(); process.exit(); });
}
