/**
 * VoxHop — Comfort Clip
 *
 * Pre-baked comfort audio ("One moment please.") loaded once at startup (C-09).
 * Never read from disk during a call turn.
 *
 * Startup validation:
 *   - File must exist (process.exit on missing — NEG-21)
 *   - File must be non-zero bytes (process.exit on empty — NEG-22)
 *
 * C-04: Audio injection uses txTrackId, not the caller/called trackId.
 */

import fs from 'fs';
import type WebSocket from 'ws';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Load the comfort clip from disk at startup.
 * Exits the process with an error if the file is missing or empty.
 *
 * Called ONCE during startup sequence, BEFORE binding the WebSocket server.
 *
 * @param clipPath - Absolute path to the comfort PCM file
 * @returns Buffer containing the comfort audio (never empty)
 */
export function loadComfortClip(clipPath: string): Buffer {
    let buffer: Buffer;

    try {
        buffer = fs.readFileSync(clipPath);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
            { clipPath, error: message },
            'VoxHop startup failed: comfort clip file not found (NEG-21)'
        );
        process.exit(1);
    }

    if (buffer.length === 0) {
        logger.error(
            { clipPath },
            'VoxHop startup failed: comfort clip is 0 bytes — graceful degradation impossible (NEG-22)'
        );
        process.exit(1);
    }

    logger.info(
        { clipPath, bytes: buffer.length },
        'Comfort clip loaded successfully'
    );

    return buffer;
}

/**
 * Inject the comfort clip to the WebSocket on a given leg.
 *
 * C-04: MUST use txTrackId — not the caller/called trackId.
 *
 * The comfort clip is the pre-loaded Buffer from loadComfortClip().
 * It is never read from disk here.
 */
export function injectComfortClip(
    ws: WebSocket,
    callId: string,
    txTrackId: string,
    comfortClipBuffer: Buffer
): void {
    if (ws.readyState !== ws.OPEN) {
        // WebSocket is closing — do not attempt to send
        return;
    }

    try {
        ws.send(
            JSON.stringify({
                event: 'audio',
                callId,
                trackId: txTrackId, // C-04: MUST be txTrackId
                payload: comfortClipBuffer.toString('base64'),
            })
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Log but do not rethrow — comfort clip failure must never crash the process
        logger.warn({ callId, txTrackId, error: message }, 'Failed to inject comfort clip');
    }
}
