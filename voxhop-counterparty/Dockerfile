# ── Build stage ────────────────────────────────────────────────────────────────
# node:20-slim (Debian/glibc) required — onnxruntime-node ships a glibc native
# binary; Alpine/musl lacks ld-linux-x86-64.so.2 and will crash at startup.
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ───────────────────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
