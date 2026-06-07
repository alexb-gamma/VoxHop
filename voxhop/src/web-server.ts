/**
 * VoxHop — HTTP Server + WebSocket Server
 *
 * C-01: VoxHop is a WebSocket SERVER.
 * Pattern: http.createServer + WebSocketServer({ noServer: true }) + upgrade routing.
 * telco-ai-bridge dials OUT to VoxHop — VoxHop never creates a WebSocket client.
 *
 * Endpoints:
 *   GET /health  — returns 200 OK when service is ready
 *   GET /metrics — Prometheus metrics (prom-client registry)
 *   WS  /ws/calls — WebSocket upgrade → VoxHopCallHandler
 *
 * Any WebSocket upgrade to a path other than /ws/calls → socket.destroy().
 */

import http from 'http';
import { WebSocketServer } from 'ws';
import pino from 'pino';
import { VoxHopCallHandler } from './call-handler';
import type { VoxHopRedis } from './redis';
import type { VoxHopMetrics } from './metrics';
import type { Config } from './config';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export function startWebServer(
    config: Config,
    redis: VoxHopRedis,
    metrics: VoxHopMetrics,
    comfortClipBuffer: Buffer
): http.Server {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

        if (url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
            return;
        }

        if (url.pathname === '/metrics') {
            try {
                const metricsText = await metrics.getMetrics();
                res.writeHead(200, { 'Content-Type': metrics.getContentType() });
                res.end(metricsText);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                logger.error({ error: message }, 'Failed to generate metrics');
                res.writeHead(500);
                res.end('Internal Server Error');
            }
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    // C-01: WebSocketServer with noServer: true — upgrade routing controls path
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

        if (url.pathname === '/ws/calls') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        } else {
            // Any other WS path → reject immediately
            socket.destroy();
        }
    });

    wss.on('connection', (ws, req) => {
        const remoteAddress = req.socket.remoteAddress ?? 'unknown';
        logger.info({ remoteAddress }, 'New WebSocket connection → creating VoxHopCallHandler');

        const handler = new VoxHopCallHandler(ws, redis, config, comfortClipBuffer, metrics);
        handler.start();
    });

    server.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'VoxHop HTTP/WebSocket server listening');
    });

    return server;
}
