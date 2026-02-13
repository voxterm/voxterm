/**
 * Voice Terminal Server
 * Uses node-pty + xterm.js (no ttyd dependency)
 * Full control over terminal input - ASR text goes directly to PTY
 */

import * as pty from 'node-pty';
import { runASR, runTTS, pcmToWav } from './voice';

const PORT = parseInt(process.env.PORT || '3000');

// Store active PTY sessions and their WebSocket clients
interface Session {
  pty: pty.IPty;
  clients: Set<any>;
}
const sessions = new Map<string, Session>();

// Voice clients
const voiceClients = new Map<string, any>();

// Create a new PTY session
function createSession(id: string): Session {
  const shell = process.env.SHELL || 'bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME || '/',
    env: process.env as { [key: string]: string },
  });

  const session: Session = {
    pty: ptyProcess,
    clients: new Set(),
  };

  // Broadcast PTY output to all connected clients
  ptyProcess.onData((data) => {
    const message = JSON.stringify({ type: 'output', data });
    for (const client of session.clients) {
      try {
        if (client.readyState === 1) {
          client.send(message);
        }
      } catch (e) {
        // Client disconnected
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`PTY exited with code ${exitCode}`);
    sessions.delete(id);
    for (const client of session.clients) {
      try { client.close(); } catch (e) {}
    }
  });

  sessions.set(id, session);
  console.log(`Created PTY session: ${id}`);
  return session;
}

// Get or create the default session
function getDefaultSession(): Session {
  const id = 'default';
  return sessions.get(id) || createSession(id);
}

// Serve static HTML with embedded xterm.js
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
      <div id="status">Hold Ctrl to speak</div>
      <div id="text"></div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    // Terminal setup
    const term = new Terminal({
      cursorBlink: true,
      fontSize: isMobile ? 12 : 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#4ade80',
      }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    // Terminal WebSocket
    const termWs = new WebSocket('ws://' + location.host + '/ws/terminal');
    termWs.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') term.write(msg.data);
    };
    termWs.onopen = () => {
      // Send initial size
      termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    // Terminal input -> server
    term.onData((data) => {
      if (termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle resize
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
      voiceWs = new WebSocket('ws://' + location.host + '/ws/voice');
      voiceWs.onmessage = (e) => {
        if (e.data instanceof Blob) {
          new Audio(URL.createObjectURL(e.data)).play();
          return;
        }
        const d = JSON.parse(e.data);
        if (d.type === 'asr' && d.text) {
          text.textContent = 'Recognized: ' + d.text;
          status.textContent = 'Sending to terminal...';
          // Send ASR result to terminal via WebSocket
          if (termWs.readyState === 1) {
            termWs.send(JSON.stringify({ type: 'asr', text: d.text }));
          }
          setTimeout(() => { status.textContent = isMobile ? 'Hold here to speak' : 'Hold Ctrl to speak'; }, 2000);
        }
      };
      voiceWs.onclose = () => setTimeout(connectVoice, 2000);
    }

    async function initAudio() {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1 }
      });
      audioContext = new AudioContext({ sampleRate: 16000 });
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

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
          console.error('Audio processing error:', err);
          status.textContent = 'Error processing audio';
          setTimeout(() => { status.textContent = isMobile ? 'Hold here to speak' : 'Hold Ctrl to speak'; }, 2000);
        }
      };
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

    // Global Ctrl key capture (works even when terminal has focus)
    let ctrlDown = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Control' && !ctrlDown) {
        ctrlDown = true;
        startRec();
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    document.addEventListener('keyup', (e) => {
      if (e.key === 'Control' && ctrlDown) {
        ctrlDown = false;
        stopRec();
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    // Mobile: entire voice bar is hold-to-speak
    const voiceBar = document.getElementById('voice-bar');
    voiceBar.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startRec();
      voiceBar.classList.add('recording');
    }, { passive: false });
    voiceBar.addEventListener('touchend', (e) => {
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

    // Focus terminal
    term.focus();

    // Initialize
    connectVoice();
    initAudio();
  </script>
</body>
</html>`;

// Start server
console.log(`
╔════════════════════════════════════════════════╗
║           Voice Terminal Server                ║
╠════════════════════════════════════════════════╣
║  Web UI:    http://localhost:${PORT}              ║
║  Terminal:  ws://localhost:${PORT}/ws/terminal    ║
║  Voice:     ws://localhost:${PORT}/ws/voice       ║
║  TTS API:   POST /api/tts                      ║
║  ASR API:   POST /api/asr                      ║
╚════════════════════════════════════════════════╝
`);

Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === '/ws/terminal') {
      const upgraded = server.upgrade(req, { data: { type: 'terminal', id: crypto.randomUUID() } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    if (url.pathname === '/ws/voice') {
      const upgraded = server.upgrade(req, { data: { type: 'voice', id: crypto.randomUUID() } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    // TTS API
    if (url.pathname === '/api/tts' && req.method === 'POST') {
      return (async () => {
        try {
          const body = await req.json();
          const pcm = await runTTS(body.text, body.voice);
          const wav = pcmToWav(pcm);
          return new Response(wav, {
            headers: { 'Content-Type': 'audio/wav' }
          });
        } catch (e) {
          console.error('TTS error:', e);
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      })();
    }

    // ASR API
    if (url.pathname === '/api/asr' && req.method === 'POST') {
      return (async () => {
        try {
          const buf = Buffer.from(await req.arrayBuffer());
          const text = await runASR(buf);
          return Response.json({ text });
        } catch (e) {
          console.error('ASR error:', e);
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      })();
    }

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', sessions: sessions.size });
    }

    // Serve index
    return new Response(indexHtml, {
      headers: { 'Content-Type': 'text/html' }
    });
  },

  websocket: {
    open(ws) {
      const { type, id } = ws.data as { type: string; id: string };

      if (type === 'terminal') {
        const session = getDefaultSession();
        session.clients.add(ws);
        console.log(`Terminal client connected: ${id}`);
      } else if (type === 'voice') {
        voiceClients.set(id, ws);
        console.log(`Voice client connected: ${id}`);
      }
    },

    async message(ws, message) {
      const { type, id } = ws.data as { type: string; id: string };

      if (type === 'terminal') {
        const session = getDefaultSession();

        if (typeof message === 'string') {
          try {
            const msg = JSON.parse(message);

            if (msg.type === 'input') {
              // User typing in terminal
              session.pty.write(msg.data);
            } else if (msg.type === 'resize') {
              // Terminal resize
              session.pty.resize(msg.cols, msg.rows);
            } else if (msg.type === 'asr') {
              // ASR text -> write to PTY as input!
              console.log(`Writing ASR text to PTY: "${msg.text}"`);
              session.pty.write(msg.text);
            }
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      } else if (type === 'voice') {
        // Voice client sent audio data
        if (message instanceof ArrayBuffer || message instanceof Buffer) {
          const pcmBuffer = Buffer.from(message);
          console.log(`Received ${pcmBuffer.length} bytes audio from ${id}`);

          try {
            const text = await runASR(pcmBuffer);
            ws.send(JSON.stringify({ type: 'asr', text }));
          } catch (err: any) {
            console.error('ASR error:', err);
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
          }
        }
      }
    },

    close(ws) {
      const { type, id } = ws.data as { type: string; id: string };

      if (type === 'terminal') {
        const session = sessions.get('default');
        if (session) {
          session.clients.delete(ws);
        }
        console.log(`Terminal client disconnected: ${id}`);
      } else if (type === 'voice') {
        voiceClients.delete(id);
        console.log(`Voice client disconnected: ${id}`);
      }
    },
  },
});

console.log('=== Server ready ===');
