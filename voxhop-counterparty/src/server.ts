/**
 * VoxHop Counterparty — HTTP + WebSocket Server
 *
 * Two WebSocketServer instances (noServer: true):
 *   /gamma/audio — telco-ai-bridge wire protocol (audio + lifecycle events)
 *   /events      — metadata stream (transcript, llm_token, turn_latency)
 *
 * Upgrade router dispatches by pathname. All other paths: socket.destroy().
 * GET /health → {"status":"ok"}.
 *
 * Phase 2 single-call constraint: one activeHandler at a time.
 */

import * as http from 'node:http';
import { WebSocketServer } from 'ws';
import pino from 'pino';
import { CounterpartyCallHandler } from './call-handler';
import type { Config } from './config';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// Module-level active handler — Phase 2 single-call constraint
let activeHandler: CounterpartyCallHandler | null = null;

export function startServer(config: Config): http.Server {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
            return;
        }
        res.writeHead(404);
        res.end('Not Found');
    });

    const wssAudio  = new WebSocketServer({ noServer: true });
    const wssEvents = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const { pathname, searchParams } = url;

        if (pathname === '/gamma/audio') {
            wssAudio.handleUpgrade(req, socket, head, ws => wssAudio.emit('connection', ws, req));
        } else if (pathname === '/events') {
            // Validate callId at TCP socket level — before WS upgrade (NEG-P2-09, NEG-P2-10)
            const callId = searchParams.get('callId');
            if (!callId || !activeHandler || activeHandler.getCallId() !== callId) {
                socket.destroy();
                return;
            }
            wssEvents.handleUpgrade(req, socket, head, ws => wssEvents.emit('connection', ws, req));
        } else {
            socket.destroy(); // CP-05: all other paths destroyed
        }
    });

    wssAudio.on('connection', (ws, req) => {
        logger.info({ remoteAddress: req.socket.remoteAddress }, 'New /gamma/audio connection');
        const handler = new CounterpartyCallHandler(ws, config);
        activeHandler = handler;
        handler.start();
        ws.on('close', () => {
            if (activeHandler === handler) activeHandler = null;
            handler.cleanup().catch(err => logger.error({ err }, 'cleanup error on ws.close'));
        });
    });

    wssEvents.on('connection', (ws, req) => {
        // callId already validated in upgrade handler — safe to link
        const callId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('callId');
        logger.info({ callId }, 'New /events connection');
        activeHandler?.setEventsWs(ws);
        ws.on('close', () => logger.debug({ callId }, '/events client disconnected'));
    });

    return server;
}
