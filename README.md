# Voice Terminal

Web-based terminal with voice input/output support using Volcano Engine (Doubao) TTS/ASR.

## Features

- **Web Terminal**: Browser-based terminal via ttyd
- **Voice Input**: Speech-to-text using Volcano Engine ASR
- **Voice Output**: Text-to-speech using Volcano Engine TTS (BigModel)
- **Real-time**: WebSocket-based voice streaming

## Architecture

```
┌─────────────────────────────────────────┐
│              Browser                     │
│  ┌─────────┐  ┌───────┐  ┌──────────┐  │
│  │ xterm.js│  │ Record│  │ Audio    │  │
│  │ Terminal│  │ Button│  │ Playback │  │
│  └────┬────┘  └───┬───┘  └────┬─────┘  │
│       │           │           │        │
│       └───────────┼───────────┘        │
│                   │ WebSocket          │
└───────────────────┼────────────────────┘
                    │
┌───────────────────┼────────────────────┐
│              Server                     │
│  ┌────────────────┴───────────────┐    │
│  │         Bun.serve()            │    │
│  │  /ws/voice  │  /api/tts|asr    │    │
│  └──────┬──────┴─────────┬────────┘    │
│         │                │             │
│  ┌──────▼──────┐  ┌──────▼──────┐     │
│  │    ttyd     │  │   Volcano   │     │
│  │   (bash)    │  │   TTS/ASR   │     │
│  └─────────────┘  └─────────────┘     │
└────────────────────────────────────────┘
```

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [ttyd](https://github.com/tsl0922/ttyd) - `brew install ttyd`
- Python 3 with `websockets` package (or use shared_venv)
- Volcano Engine account with BigModel TTS/ASR enabled

## Setup

1. Install dependencies:
```bash
bun install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your Volcano Engine credentials
```

3. Start the server:
```bash
bun run start
```

4. Open http://localhost:3000 in your browser

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VOLCANO_APP_ID` | Volcano Engine App ID | - |
| `VOLCANO_TOKEN` | Volcano Engine Access Token | - |
| `VOLCANO_VOICE` | TTS voice name | `zh_female_wanwanxiaohe_moon_bigtts` |
| `PORT` | Web server port | `3000` |
| `TTYD_PORT` | ttyd terminal port | `7681` |
| `TTYD_CMD` | Command to run in terminal | `bash` |

## Usage

### Voice Input (ASR)
- Press and hold the microphone button to record
- Release to send audio for recognition
- Recognized text is sent to the terminal

### Voice Output (TTS)
- Type text in the input field and click "Speak"
- Or use the API: `POST /api/tts` with `{"text": "Hello"}`

### API Endpoints

- `GET /health` - Health check
- `POST /api/tts` - Text-to-speech (returns WAV audio)
- `POST /api/asr` - Speech-to-text (accepts audio file)
- `WS /ws/voice` - Real-time voice WebSocket

## Development

```bash
bun run dev  # Hot reload
```

## Credits

- Voice code adapted from [ghaa](../ghaa) project
- Terminal backend: [ttyd](https://github.com/tsl0922/ttyd)
- TTS/ASR: [Volcano Engine BigModel](https://www.volcengine.com)
