/**
 * Multi-User Voice Terminal Server
 * - Linux PAM authentication
 * - Per-user isolated sessions
 * - Admin-managed allowlist
 */

// Prevent unhandled errors from crashing the server
// IMPORTANT: Ignore EPIPE errors to avoid infinite loop when stderr pipe breaks
// (console.error on broken pipe → EPIPE → uncaughtException → console.error → ...)
process.on('SIGPIPE', () => {}); // Ignore broken pipe signals
process.on('uncaughtException', (err) => {
  if ((err as any)?.code === 'EPIPE') return;
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
import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ALLOWLIST_PATH = process.env.ALLOWLIST_PATH || path.join(__dirname, '../allowlist.json');
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT || '3600000'); // 1 hour

// Voice module paths
const VOLCANO_APP_ID = process.env.VOLCANO_APP_ID || '';
const VOLCANO_TOKEN = process.env.VOLCANO_TOKEN || '';
const VOLCANO_ASR_RESOURCE_ID = process.env.VOLCANO_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration';
const ASR_CLI_PATH = path.join(__dirname, 'voice', 'asr.py');
const PYTHON_PATH = process.env.PYTHON_PATH || `${process.env.HOME}/Documents/Coding/shared_venv/bin/python3`;

// User session with PTY
interface UserSession {
  username: string;
  pty: pty.IPty;
  clients: Set<WebSocket>;
  scrollback: string;
  lastActivity: number;
}

// Active sessions: sessionId -> UserSession
const sessions = new Map<string, UserSession>();

// Auth tokens: token -> { username, expires }
const authTokens = new Map<string, { username: string; expires: number }>();

// Voice clients: id -> { ws, sessionId }
const voiceClients = new Map<string, { ws: WebSocket; sessionId: string }>();

// Cached allowlist - loaded once, invalidated on write
let _allowlistCache: string[] | null = null;

function loadAllowlist(): string[] {
  if (_allowlistCache) return _allowlistCache;
  try {
    const data = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
    _allowlistCache = JSON.parse(data);
    return _allowlistCache!;
  } catch {
    _allowlistCache = [];
    return [];
  }
}

function saveAllowlist(users: string[]) {
  _allowlistCache = users;
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(users, null, 2));
}

function isUserAllowed(username: string): boolean {
  return loadAllowlist().includes(username);
}

function addUserToAllowlist(username: string): boolean {
  const allowlist = loadAllowlist();
  if (!allowlist.includes(username)) {
    allowlist.push(username);
    saveAllowlist(allowlist);
    return true;
  }
  return false;
}

function removeUserFromAllowlist(username: string): boolean {
  const allowlist = loadAllowlist();
  const filtered = allowlist.filter(u => u !== username);
  if (filtered.length < allowlist.length) {
    saveAllowlist(filtered);
    return true;
  }
  return false;
}

// PAM authentication using su
async function authenticateUser(username: string, password: string): Promise<boolean> {
  // If server runs as root and username is root, allow any password
  if (username === 'root' && process.getuid?.() === 0) {
    return true;
  }
  
  return new Promise((resolve) => {
    const proc = spawn('su', ['-c', 'exit', username], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    proc.stdin.write(password + '\n');
    proc.stdin.end();
    
    proc.on('close', (code) => {
      resolve(code === 0);
    });
    
    proc.on('error', () => {
      resolve(false);
    });
  });
}

// Get user info
function getUserInfo(username: string): { home: string; shell: string; uid: number; gid: number } | null {
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
    const line = passwd.split('\n').find(l => l.startsWith(username + ':'));
    if (!line) return null;
    
    const parts = line.split(':');
    return {
      home: parts[5] || `/home/${username}`,
      shell: parts[6] || '/bin/bash',
      uid: parseInt(parts[2] || '1000') ?? 1000,
      gid: parseInt(parts[3] || '1000') ?? 1000,
    };
  } catch {
    return null;
  }
}

// Generate auth token
function generateToken(username: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  authTokens.set(token, {
    username,
    expires: Date.now() + 86400000 // 24 hours
  });
  return token;
}

// Validate auth token
function validateToken(token: string): string | null {
  const data = authTokens.get(token);
  if (!data) return null;
  if (Date.now() > data.expires) {
    authTokens.delete(token);
    return null;
  }
  return data.username;
}

// Create PTY session for user
function createUserSession(sessionId: string, username: string): UserSession | null {
  const userInfo = getUserInfo(username);
  if (!userInfo) return null;
  
  const ptyProcess = pty.spawn(userInfo.shell, ['--login', '-i'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: userInfo.home,
    env: {
      ...process.env as { [key: string]: string },
      HOME: userInfo.home,
      USER: username,
      LOGNAME: username,
      SHELL: userInfo.shell,
      TERM: 'xterm-256color',
    },
    uid: userInfo.uid,
    gid: userInfo.gid,
  });
  
  const session: UserSession = {
    username,
    pty: ptyProcess,
    clients: new Set(),
    scrollback: '',
    lastActivity: Date.now(),
  };
  
  ptyProcess.onData((data) => {
    session.scrollback += data;
    if (session.scrollback.length > 50000) {
      session.scrollback = session.scrollback.slice(-50000);
    }
    session.lastActivity = Date.now();
    
    const message = JSON.stringify({ type: 'output', data });
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });
  
  ptyProcess.onExit(({ exitCode }) => {
    console.log(`PTY for ${username} exited with code ${exitCode}`);
    sessions.delete(sessionId);
    for (const client of session.clients) {
      client.close();
    }
  });
  
  sessions.set(sessionId, session);
  console.log(`Created session for user: ${username}`);
  return session;
}

// Get or create session
function getSession(sessionId: string, username: string): UserSession | null {
  const existing = sessions.get(sessionId);
  if (existing && existing.username === username) {
    existing.lastActivity = Date.now();
    return existing;
  }
  return createUserSession(sessionId, username);
}

// Run ASR
async function runASR(pcmBuffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const pcmPath = `/tmp/asr-${timestamp}.pcm`;
    fs.writeFileSync(pcmPath, pcmBuffer);
    
    const proc = spawn(PYTHON_PATH, [
      ASR_CLI_PATH,
      '--appid', VOLCANO_APP_ID,
      '--token', VOLCANO_TOKEN,
      '--resource-id', VOLCANO_ASR_RESOURCE_ID,
      '--audio', pcmPath,
      '--format', 'pcm',
      '--sample-rate', '16000'
    ]);
    
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    
    proc.on('close', (code) => {
      fs.unlinkSync(pcmPath);
      const match = stdout.match(/RESULT:(.+)/);
      if (match) {
        resolve(match[1].trim());
      } else {
        reject(new Error(stderr || 'No result'));
      }
    });
  });
}

// Cleanup inactive sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT && session.clients.size === 0) {
      console.log(`Cleaning up inactive session: ${session.username}`);
      session.pty.kill();
      sessions.delete(id);
    }
  }
}, 60000);

// Login page
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
    .admin-link { text-align: center; margin-top: 16px; }
    .admin-link a { color: #888; font-size: 14px; }
    @media (max-width: 400px) {
      .login-box { padding: 24px; }
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Voice Terminal</h1>
    <div class="error" id="error"></div>
    <form onsubmit="return login()">
      <input type="text" id="username" placeholder="Username" autocomplete="username" required>
      <input type="password" id="password" placeholder="Password" autocomplete="current-password" required>
      <button type="submit">Login</button>
    </form>
    <div class="admin-link"><a href="#" onclick="showAdmin()">Admin Panel</a></div>
  </div>
  <script>
    async function login() {
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const error = document.getElementById('error');
      
      const res = await fetch('login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      
      if (data.success) {
        location.reload();
      } else {
        error.textContent = data.error || 'Login failed';
        error.style.display = 'block';
      }
      return false;
    }
    
    function showAdmin() {
      const pwd = prompt('Admin password:');
      if (pwd) {
        location.href = 'admin?password=' + encodeURIComponent(pwd);
      }
    }
  </script>
</body>
</html>`;

// Admin page
const adminHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Terminal - Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; font-family: system-ui; color: #e0e0e0; padding: 40px; }
    @media (max-width: 600px) { body { padding: 16px; } }
    h1 { color: #4ade80; margin-bottom: 24px; }
    .section { background: #16213e; padding: 24px; border-radius: 8px; margin-bottom: 24px; }
    h2 { margin-bottom: 16px; color: #888; font-size: 16px; }
    .user-list { list-style: none; }
    .user-list li { padding: 12px; background: #1a1a2e; margin-bottom: 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; }
    button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; }
    .btn-remove { background: #f87171; color: #000; }
    .btn-add { background: #4ade80; color: #000; margin-top: 12px; }
    input { padding: 12px; border: none; border-radius: 4px; background: #1a1a2e; color: #e0e0e0; margin-right: 8px; }
    .error { color: #f87171; }
    .success { color: #4ade80; }
    a { color: #4ade80; }
  </style>
</head>
<body>
  <h1>Voice Terminal Admin</h1>
  <div class="section">
    <h2>Allowed Users</h2>
    <ul class="user-list" id="userList"></ul>
    <input type="text" id="newUser" placeholder="Username to add">
    <button class="btn-add" onclick="addUser()">Add User</button>
  </div>
  <div class="section">
    <h2>Active Sessions</h2>
    <ul class="user-list" id="sessionList"></ul>
  </div>
  <p id="msg"></p>
  <p><a href="/">Back to Terminal</a></p>
  <script>
    async function loadUsers() {
      const res = await fetch('admin/users');
      const data = await res.json();
      const list = document.getElementById('userList');
      list.innerHTML = data.users.map(u => '<li>' + u + ' <button class="btn-remove" onclick="removeUser(\\''+u+'\\')">Remove</button></li>').join('');
    }
    async function loadSessions() {
      const res = await fetch('admin/sessions');
      const data = await res.json();
      const list = document.getElementById('sessionList');
      list.innerHTML = data.sessions.map(s => '<li>' + s.username + ' (' + s.clients + ' clients)</li>').join('') || '<li>No active sessions</li>';
    }
    async function addUser() {
      const username = document.getElementById('newUser').value;
      if (!username) return;
      const res = await fetch('admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
      const data = await res.json();
      document.getElementById('msg').textContent = data.success ? 'User added' : data.error;
      document.getElementById('msg').className = data.success ? 'success' : 'error';
      loadUsers();
    }
    async function removeUser(username) {
      const res = await fetch('admin/users/' + username, { method: 'DELETE' });
      const data = await res.json();
      document.getElementById('msg').textContent = data.success ? 'User removed' : data.error;
      loadUsers();
    }
    loadUsers();
    loadSessions();
    setInterval(loadSessions, 5000);
  </script>
</body>
</html>`;

// Terminal page
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
    #user-info { color: #4ade80; font-size: 14px; white-space: nowrap; flex-shrink: 0; }
    #logout { background: #333; border: none; color: #f87171; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; min-height: 44px; -webkit-tap-highlight-color: transparent; flex-shrink: 0; }
    @media (max-width: 600px) {
      #voice-bar { padding: 8px 8px; gap: 6px; }
      #status { font-size: 12px; padding: 6px 8px; }
      #text { display: none; }
      #user-info { font-size: 12px; }
    }
  </style>
</head>
<body>
  <div id="container">
    <div id="terminal"></div>
    <div id="voice-bar">
      <div id="status">Hold Option to speak</div>
      <div id="text"></div>
      <span id="user-info"></span>
      <div id="font-controls">
        <button class="font-btn" onclick="changeFontSize(-2)">-</button>
        <span id="font-size">21px</span>
        <button class="font-btn" onclick="changeFontSize(2)">+</button>
        <button id="logout" onclick="logout()">Logout</button>
      </div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
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
    document.getElementById('font-size').textContent = fontSize + 'px';

    function changeFontSize(delta) {
      fontSize = Math.max(10, Math.min(40, fontSize + delta));
      term.options.fontSize = fontSize;
      document.getElementById('font-size').textContent = fontSize + 'px';
      fitAddon.fit();
      if (termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }
    
    function logout() {
      document.cookie = 'auth=; path=/; max-age=0';
      location.reload();
    }
    
    // Show username
    const cookies = document.cookie.split(';').reduce((a, c) => { const [k,v] = c.split('='); a[k.trim()] = v; return a; }, {});
    if (cookies.username) {
      document.getElementById('user-info').textContent = decodeURIComponent(cookies.username);
    }
    
    // Session ID
    let sessionId = sessionStorage.getItem('terminalSessionId');
    if (!sessionId) {
      sessionId = 'sess_' + Math.random().toString(36).substring(2, 10);
      sessionStorage.setItem('terminalSessionId', sessionId);
    }
    
    // Get auth token from cookie
    const authCookie = document.cookie.split(';').find(c => c.trim().startsWith('auth='));
    const authToken = authCookie ? authCookie.split('=')[1] : '';
    
    // Terminal WebSocket
    const basePath = location.pathname.replace(/\\/$/, '');
    const termWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + basePath + '/ws/terminal?session=' + sessionId + '&token=' + authToken);
    termWs.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') term.write(msg.data);
    };
    termWs.onopen = () => {
      termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    termWs.onclose = () => {
      term.write('\\r\\n[Connection closed - reloading...]\\r\\n');
      setTimeout(() => location.reload(), 2000);
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
    
    // Voice setup
    const status = document.getElementById('status');
    const text = document.getElementById('text');
    let voiceWs, mediaRecorder, audioChunks = [], isRecording = false, audioContext;
    
    function connectVoice() {
      voiceWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + basePath + '/ws/voice?session=' + sessionId + '&token=' + authToken);
      voiceWs.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.type === 'asr' && d.text) {
          text.textContent = 'Recognized: ' + d.text;
          status.textContent = 'Sending to terminal...';
          if (termWs.readyState === 1) {
            termWs.send(JSON.stringify({ type: 'asr', text: d.text }));
          }
          setTimeout(() => { status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak'; }, 2000);
        }
      };
      voiceWs.onclose = () => setTimeout(connectVoice, 2000);
    }
    
    async function initAudio() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
        audioContext = new AudioContext({ sampleRate: 16000 });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
          const blob = new Blob(audioChunks, { type: 'audio/webm' });
          audioChunks = [];
          try {
            const buf = await blob.arrayBuffer();
            const audio = await audioContext.decodeAudioData(buf);
            const data = audio.getChannelData(0);
            const pcm = new Int16Array(data.length);
            for (let i = 0; i < data.length; i++) {
              pcm[i] = Math.max(-1, Math.min(1, data[i])) * (data[i] < 0 ? 0x8000 : 0x7FFF);
            }
            if (voiceWs?.readyState === 1) voiceWs.send(pcm.buffer);
            status.textContent = 'Processing...';
          } catch (err) {
            console.error('Audio error:', err);
            status.textContent = 'Error';
            setTimeout(() => { status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak'; }, 2000);
          }
        };
      } catch (e) {
        console.log('Audio not available:', e);
      }
    }
    
    function startRec() {
      if (!mediaRecorder || isRecording) return;
      audioChunks = [];
      mediaRecorder.start(100);
      isRecording = true;
      status.textContent = 'Recording...';
      status.classList.add('recording');
    }
    
    function stopRec() {
      if (!mediaRecorder || !isRecording) return;
      mediaRecorder.stop();
      isRecording = false;
      status.classList.remove('recording');
    }
    
    let altDown = false, altDownTime = 0, altCombined = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Alt' && !altDown) {
        altDown = true;
        altDownTime = Date.now();
        altCombined = false;
        startRec();
        e.preventDefault();
      } else if (altDown && e.key !== 'Alt') {
        altCombined = true;
        if (isRecording) { mediaRecorder.stop(); isRecording = false; audioChunks = []; status.classList.remove('recording'); status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak'; }
      }
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' && altDown) {
        altDown = false;
        const dur = Date.now() - altDownTime;
        if (altCombined || dur < 800) {
          if (isRecording) { mediaRecorder.stop(); isRecording = false; audioChunks = []; status.classList.remove('recording'); status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak'; }
        } else {
          stopRec();
        }
        e.preventDefault();
      }
    }, true);
    
    // Mobile: entire voice bar is hold-to-speak (except font controls)
    const voiceBar = document.getElementById('voice-bar');
    const fontControls = document.getElementById('font-controls');
    function isFontControl(el) {
      return fontControls && fontControls.contains(el);
    }
    voiceBar.addEventListener('touchstart', (e) => {
      if (isFontControl(e.target)) return;
      e.preventDefault();
      startRec();
      voiceBar.classList.add('recording');
    }, { passive: false });
    voiceBar.addEventListener('touchend', (e) => {
      if (isFontControl(e.target)) return;
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

// Parse cookies
function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header) {
    header.split(';').forEach(c => {
      const idx = c.indexOf('=');
      if (idx > 0) {
        cookies[c.substring(0, idx).trim()] = c.substring(idx + 1).trim();
      }
    });
  }
  return cookies;
}

// HTTP Server
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  console.log(`HTTP ${req.method} ${url.pathname}`);
  
  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }
  
  // Login
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { username, password } = JSON.parse(body);
        
        // Check allowlist first
        if (!isUserAllowed(username)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'User not allowed' }));
          return;
        }
        
        // Authenticate
        const valid = await authenticateUser(username, password);
        if (valid) {
          const token = generateToken(username);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `auth=${token}; Path=/terminal/; Max-Age=86400; SameSite=Lax`
          });
          res.end(JSON.stringify({ success: true, token }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid credentials' }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }
  
  // Admin pages
  if (url.pathname === '/admin') {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.admin_auth !== ADMIN_PASSWORD) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(adminHtml);
    return;
  }
  
  if (url.pathname === '/admin/users' && req.method === 'GET') {
    const adminAuth = url.searchParams.get('password') || parseCookies(req.headers.cookie).admin_auth;
    if (adminAuth !== ADMIN_PASSWORD) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ users: loadAllowlist() }));
    return;
  }
  
  if (url.pathname === '/admin/users' && req.method === 'POST') {
    const adminAuth = url.searchParams.get('password') || parseCookies(req.headers.cookie).admin_auth;
    if (adminAuth !== ADMIN_PASSWORD) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { username } = JSON.parse(body);
      const success = addUserToAllowlist(username);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
    });
    return;
  }
  
  if (url.pathname.startsWith('/admin/users/') && req.method === 'DELETE') {
    const adminAuth = url.searchParams.get('password') || parseCookies(req.headers.cookie).admin_auth;
    if (adminAuth !== ADMIN_PASSWORD) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    const username = decodeURIComponent(url.pathname.substring('/admin/users/'.length));
    const success = removeUserFromAllowlist(username);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
    return;
  }
  
  if (url.pathname === '/admin/sessions') {
    const adminAuth = url.searchParams.get('password') || parseCookies(req.headers.cookie).admin_auth;
    if (adminAuth !== ADMIN_PASSWORD) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    const sessionList = Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      username: s.username,
      clients: s.clients.size
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: sessionList }));
    return;
  }
  
  // Check auth for terminal
  const cookies = parseCookies(req.headers.cookie);
  const username = validateToken(cookies.auth || '');
  
  if (!username) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginHtml);
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(indexHtml);
});

// Terminal WebSocket
const terminalWss = new WebSocketServer({ noServer: true });
terminalWss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session') || 'default';
  
  // Get auth from URL token param or cookie
  const tokenParam = url.searchParams.get('token');
  const cookieHeader = req.headers.cookie || '';
  const cookies = parseCookies(cookieHeader);
  const token = tokenParam || cookies.auth || '';
  const username = validateToken(token);
  
  if (!username) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  
  const session = getSession(sessionId, username);
  if (!session) {
    ws.close(1011, 'Failed to create session');
    return;
  }
  
  session.clients.add(ws);
  console.log(`Terminal client connected: ${username} (${sessionId})`);
  
  if (session.scrollback) {
    ws.send(JSON.stringify({ type: 'output', data: session.scrollback }));
  }
  
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'input') {
        session.pty.write(data.data);
      } else if (data.type === 'resize' && data.cols > 0 && data.rows > 0) {
        try { session.pty.resize(data.cols, data.rows); } catch {}
      } else if (data.type === 'asr') {
        session.pty.write(data.text + '\r');
      }
    } catch {}
  });
  
  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`Terminal client disconnected: ${username} (${session.clients.size} remaining)`);
    
    // Delay PTY kill to allow for page reloads
    if (session.clients.size === 0) {
      setTimeout(() => {
        if (session.clients.size === 0) {
          console.log(`No clients remaining, killing session: ${sessionId}`);
          session.pty.kill();
          sessions.delete(sessionId);
        }
      }, 5000);
    }
  });
});

// Voice WebSocket
const voiceWss = new WebSocketServer({ noServer: true });
voiceWss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session') || 'default';
  
  // Get auth from URL token param or cookie
  const tokenParam = url.searchParams.get('token');
  const cookieHeader = req.headers.cookie || '';
  const cookies = parseCookies(cookieHeader);
  const token = tokenParam || cookies.auth || '';
  const username = validateToken(token);
  
  if (!username) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  
  const id = Math.random().toString(36).substring(7);
  voiceClients.set(id, { ws, sessionId });
  console.log(`Voice client connected: ${username}`);
  
  ws.on('message', async (msg) => {
    if (msg instanceof Buffer) {
      try {
        const text = await runASR(msg);
        ws.send(JSON.stringify({ type: 'asr', text }));
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }
  });
  
  ws.on('close', () => {
    voiceClients.delete(id);
  });
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  
  if (url.pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/ws/voice') {
    voiceWss.handleUpgrade(req, socket, head, (ws) => {
      voiceWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Start
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║      Multi-User Voice Terminal Server          ║
╠════════════════════════════════════════════════╣
║  Web UI:    http://localhost:${PORT}              ║
║  Admin:     http://localhost:${PORT}/admin        ║
╚════════════════════════════════════════════════╝

Allowlist: ${ALLOWLIST_PATH}
Admin password: ${ADMIN_PASSWORD === 'admin123' ? 'admin123 (default!)' : 'configured'}

=== Server ready ===
  `);
});
