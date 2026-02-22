# voxterm

> Share your terminal over the web, with voice control.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<!-- TODO: Add GIF demo here -->
<!-- ![voxterm demo](docs/demo.gif) -->

## Features

- **Voice input** — talk to your terminal (hold Option/Alt key)
- **Access from anywhere** — built-in Cloudflare Tunnel (`--tunnel`)
- **Mobile-friendly** — special keys, touch controls, responsive UI
- **Session persistence** — reconnect without losing state
- **Password protection** — simple auth out of the box
- **Zero config** — works immediately, voice is optional

## Quick Start

```bash
# Install
npm install

# Start
npx tsx src/server-node.ts

# Open
open http://localhost:3000
```

Default password: `success1000` (change with `AUTH_PASSWORD` env var)

## Docker

```bash
docker run -p 3000:3000 -e AUTH_PASSWORD=mysecret voxterm
```

Build it yourself:

```bash
docker build -t voxterm .
docker run -p 3000:3000 -e AUTH_PASSWORD=mysecret voxterm
```

## Remote Access

Use the `--tunnel` flag to expose your terminal over a Cloudflare Tunnel (requires [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)):

```bash
npx tsx src/server-node.ts --tunnel
```

This prints a public URL anyone can use to access your terminal (password-protected).

## Voice Setup (Optional)

Voice input uses [Volcano Engine](https://www.volcengine.com/) for speech recognition. It's entirely optional — voxterm works perfectly as a plain web terminal without it.

To enable voice:

1. Create a Volcano Engine account
2. Get your App ID and Token
3. Set environment variables:

```bash
VOLCANO_APP_ID=your_app_id
VOLCANO_TOKEN=your_token
```

Hold **Option** (Mac) or **Alt** (Windows/Linux) to record, release to send.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `AUTH_PASSWORD` | `success1000` | Login password |
| `SHELL_CMD` | `bash` | Shell to spawn |
| `VOLCANO_APP_ID` | — | Volcano Engine app ID (for voice) |
| `VOLCANO_TOKEN` | — | Volcano Engine token (for voice) |
| `VOLCANO_ASR_RESOURCE_ID` | `volc.bigasr.sauc.duration` | ASR resource ID |
| `CLOUDFLARE_TUNNEL` | — | Set to `1` to enable tunnel without flag |

## Architecture

```
Browser (xterm.js)
    │
    ├── WebSocket /ws/terminal ──→ node-pty (bash/zsh)
    │
    └── WebSocket /ws/voice ──→ Volcano ASR ──→ text ──→ PTY
                                   (optional)

Server: Node.js + node-pty + xterm-headless (session persistence)
Tunnel: cloudflared (optional, --tunnel flag)
```

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
