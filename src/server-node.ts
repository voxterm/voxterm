/**
 * Voice Terminal Server (Node.js version)
 * Uses node-pty + xterm.js
 * Full control over terminal input - ASR text goes directly to PTY
 */

// Prevent unhandled errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err: any) => {
  console.error('Unhandled rejection:', err?.message || err);
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
  scrollback: string;
  name: string;
  createdAt: number;
}
const sessions = new Map<string, Session>();
const MAX_SCROLLBACK = 50000;
let sessionCounter = 0;

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
}

function startAsrSession(clientWs: WebSocket): AsrSession {
  const asrSession: AsrSession = { volcanoWs: null, ready: false };

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
    console.log('ASR session connected to Volcano');
  });

  volcanoWs.on('message', (data: Buffer) => {
    const parsed = parseAsrResponse(Buffer.from(data));
    if (parsed.msgType === 15) {
      // Error
      console.error('ASR server error:', parsed.result || parsed.error);
      clientWs.send(JSON.stringify({ type: 'error', message: 'ASR server error' }));
      return;
    }
    if (parsed.msgType === 9 && parsed.result?.result) {
      const res = parsed.result.result;
      const text = (res.text || '').trim().replace(/[.。]$/, '');
      if (text) {
        const utterances = res.utterances || [];
        const definite = utterances.length > 0 && utterances[0].definite;
        // Send partial results for live feedback, and final result
        clientWs.send(JSON.stringify({
          type: definite ? 'asr' : 'asr_partial',
          text,
        }));
        if (definite) {
          console.log(`ASR final: "${text}"`);
        }
      }
    }
  });

  volcanoWs.on('error', (err) => {
    console.error('ASR WebSocket error:', err.message);
    clientWs.send(JSON.stringify({ type: 'error', message: 'ASR connection error' }));
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
    },
  });

  sessionCounter++;
  const session: Session = {
    pty: ptyProcess,
    clients: new Set(),
    scrollback: '',
    name: `Session ${sessionCounter}`,
    createdAt: Date.now(),
  };

  console.log(`Created PTY session: ${id} - ${session.name}`);

  // Broadcast PTY output to all connected clients and save to scrollback
  ptyProcess.onData((data) => {
    // Save to scrollback buffer
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK);
    }

    const message = JSON.stringify({ type: 'output', data });
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`PTY exited with code ${exitCode}`);
    sessions.delete(id);
    for (const client of session.clients) {
      client.close();
    }
  });

  sessions.set(id, session);
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

  return `<!DOCTYPE html>
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
    #back-btn { color: #4ade80; font-size: 13px; text-decoration: none; padding: 6px 10px; background: #1a1a2e; border-radius: 6px; white-space: nowrap; flex-shrink: 0; }
    @media (max-width: 600px) {
      #voice-bar { padding: 8px 8px; gap: 6px; }
      #status { font-size: 12px; padding: 6px 8px; }
      #text { display: none; }
    }
  </style>
</head>
<body>
  <div id="container">
    <div id="terminal"></div>
    <div id="voice-bar">
      <a href="/terminal" id="back-btn">Sessions</a>
      <div id="status">Hold Option to speak</div>
      <div id="text"></div>
      <div id="font-controls">
        <button class="font-btn" onclick="changeFontSize(-2)">−</button>
        <span id="font-size">21px</span>
        <button class="font-btn" onclick="changeFontSize(2)">+</button>
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

    // Terminal WebSocket
    var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws?session=' + sessionId;
    document.getElementById('status').textContent = 'Connecting...';
    const termWs = new WebSocket(wsUrl);
    termWs.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') term.write(msg.data);
    };
    termWs.onopen = () => {
      document.getElementById('status').textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
      termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    termWs.onerror = () => {
      document.getElementById('status').textContent = 'WS error: ' + wsUrl;
      document.getElementById('status').style.background = '#f87171';
    };
    termWs.onclose = (e) => {
      document.getElementById('status').textContent = 'WS closed: ' + e.code + ' ' + (e.reason || wsUrl);
      document.getElementById('status').style.background = '#f97316';
    };

    term.onData((data) => {
      if (termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'input', data }));
      }
    });

    window.addEventListener('resize', () => {
      fitAddon.fit();
      if (termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });

    // Voice setup - streaming ASR (sends PCM in real-time)
    const status = document.getElementById('status');
    const text = document.getElementById('text');
    let voiceWs, audioStream, audioContext, sourceNode, processorNode;
    let isRecording = false, audioReady = false;

    function connectVoice() {
      voiceWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws-voice');
      voiceWs.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.type === 'asr' && d.text) {
          text.textContent = d.text;
          status.textContent = 'Sending to terminal...';
          if (termWs.readyState === 1) {
            termWs.send(JSON.stringify({ type: 'asr', text: d.text }));
          }
          setTimeout(() => { status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak'; }, 2000);
        } else if (d.type === 'asr_partial' && d.text) {
          text.textContent = d.text;
        }
      };
      voiceWs.onclose = () => setTimeout(connectVoice, 2000);
    }

    async function initAudio() {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
      audioContext = new AudioContext({ sampleRate: 16000 });
      sourceNode = audioContext.createMediaStreamSource(audioStream);
      // ScriptProcessor: buffer 4096 samples, 1 input channel, 1 output channel
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
      // Keep processor connected but only send when isRecording
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
      audioReady = true;
    }

    function startRec() {
      if (!audioReady || isRecording) return;
      if (audioContext.state === 'suspended') audioContext.resume();
      isRecording = true;
      // Tell server to start ASR session
      if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_start' }));
      status.textContent = 'Recording...';
      status.classList.add('recording');
      text.textContent = '';
    }

    function stopRec() {
      if (!isRecording) return;
      isRecording = false;
      // Tell server to finalize ASR
      if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_end' }));
      status.classList.remove('recording');
      status.textContent = 'Processing...';
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
          mediaRecorder.stop();
          isRecording = false;
          audioChunks = []; // Discard
          status.classList.remove('recording');
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
            mediaRecorder.stop();
            isRecording = false;
            audioChunks = [];
            status.classList.remove('recording');
            status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
          }
        } else {
          stopRec(); // Normal stop - send audio
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
    function isExcluded(el) {
      return (fontControls && fontControls.contains(el)) || (backBtn && backBtn.contains(el));
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
    initAudio();
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

  console.log(`HTTP ${req.method} ${req.url} - Cookie: ${req.headers.cookie?.substring(0,60) || 'none'}`);

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Handle login POST (accept both direct and proxy-rewritten paths)
  if ((req.url === '/login' || req.url === '/terminal/login') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
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
  console.log(`Terminal client connected: ${sessionId}`);

  // Send scrollback history to new client
  if (session.scrollback) {
    ws.send(JSON.stringify({ type: 'output', data: session.scrollback }));
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
    if (typeof message === 'string' || (message instanceof Buffer && message[0] === 0x7b)) {
      // JSON control message
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
        if (asrSession?.volcanoWs?.readyState === WebSocket.OPEN) {
          asrSession.volcanoWs.send(buildAudioRequest(Buffer.alloc(0), true));
          console.log(`ASR streaming ended for ${id}`);
        }
      }
    } else if (message instanceof Buffer) {
      // Binary = raw PCM audio chunk, forward to Volcano
      if (asrSession?.ready && asrSession.volcanoWs?.readyState === WebSocket.OPEN) {
        asrSession.volcanoWs.send(buildAudioRequest(message, false));
      }
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
});
