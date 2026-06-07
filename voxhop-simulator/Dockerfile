FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/

RUN npm run build

# ─── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Copy static client build (built separately by client/ Vite build)
COPY static/ ./static/

# Generate self-signed TLS cert for pre-cert-issuance startup (ER-05)
RUN apk add --no-cache openssl curl && \
    mkdir -p /app/certs && \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout /app/certs/self-signed.key \
      -out /app/certs/self-signed.crt \
      -subj "/CN=simulator.voxhop.borshik.net/O=VoxHop/C=EU" \
      2>/dev/null && \
    echo "[voxhop-simulator] Self-signed cert generated for pre-cert startup"

EXPOSE 443

ENV SIMULATOR_PORT=443

CMD ["node", "dist/main"]
