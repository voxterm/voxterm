FROM node:22-bookworm-slim AS base

# Install build tools for node-pty and curl for cloudflared
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install cloudflared for optional tunnel support
RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --omit=dev && npm install tsx

# Copy source
COPY src/ src/

EXPOSE 3000

ENV PORT=3000
ENV AUTH_PASSWORD=voxterm

CMD ["npx", "tsx", "src/server-node.ts"]
