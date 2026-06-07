/**
 * VoxHop — Redis Client
 *
 * ioredis client (C-05) with helpers for call state and processing locks.
 *
 * Lock semantics:
 *   acquireLock: SET leg:{trackId}:processing 1 EX {ttl} NX
 *     - Returns true if lock acquired, false if already held
 *     - TTL is a dead-man switch — explicit release is primary mechanism
 *   releaseLock: DEL leg:{trackId}:processing
 *     - Returns number of keys deleted (0 if already expired — safe per NEG-14)
 *
 * Call state:
 *   initCallState: SET call:{callId}:state active EX 14400 (4h TTL)
 *   cleanupCallState: DEL call:{callId}:state
 *     - Leg locks are released separately by VoxHopCallHandler.cleanup() (GAP-04)
 */

import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const CALL_STATE_TTL_SECONDS = 14400; // 4 hours

export class VoxHopRedis {
    private client: Redis;

    constructor(redisUrl: string) {
        this.client = new Redis(redisUrl, {
            maxRetriesPerRequest: 1, // Fail fast — no retry storms on pipeline timeouts
            enableReadyCheck: true,
            lazyConnect: false,
        });

        this.client.on('error', (err: Error) => {
            logger.warn({ err: err.message }, 'Redis connection error');
        });

        this.client.on('connect', () => {
            logger.info('Redis connected');
        });
    }

    /**
     * Acquire a per-leg processing lock.
     * SET leg:{trackId}:processing 1 EX {ttl} NX
     *
     * @returns true if lock acquired, false if already held by another turn
     */
    async acquireLock(trackId: string, ttlSeconds: number): Promise<boolean> {
        const result = await this.client.set(
            `leg:${trackId}:processing`,
            '1',
            'EX',
            ttlSeconds,
            'NX'
        );
        return result === 'OK';
    }

    /**
     * Release a per-leg processing lock.
     * DEL leg:{trackId}:processing
     *
     * Safe to call even if the key has already expired (returns 0 — no throw per NEG-14).
     */
    async releaseLock(trackId: string): Promise<void> {
        // DEL returns 0 if key doesn't exist — this is safe and expected per NEG-14
        await this.client.del(`leg:${trackId}:processing`);
    }

    /**
     * Initialise Redis state for a new call.
     * SET call:{callId}:state active EX 14400 (4h TTL)
     *
     * The TTL is a safety net for network partition / media-worker crash.
     * Explicit cleanup happens on call_ended or ws.on('close').
     */
    async initCallState(callId: string): Promise<void> {
        await this.client.set(`call:${callId}:state`, 'active', 'EX', CALL_STATE_TTL_SECONDS);
        logger.info({ callId }, 'Redis call state initialised (4h TTL)');
    }

    /**
     * Clean up Redis state for an ended call.
     * Deletes call:{callId}:state only.
     *
     * IMPORTANT (GAP-04): Leg locks must be released BEFORE calling this method.
     * VoxHopCallHandler.cleanup() iterates this.legs and calls releaseLock(trackId)
     * for each leg before calling cleanupCallState(callId).
     */
    async cleanupCallState(callId: string): Promise<void> {
        await this.client.del(`call:${callId}:state`);
        logger.info({ callId }, 'Redis call state cleaned up');
    }

    /**
     * Check if a call is active in Redis.
     */
    async isCallActive(callId: string): Promise<boolean> {
        const val = await this.client.get(`call:${callId}:state`);
        return val === 'active';
    }

    /**
     * Check if a leg lock is held.
     */
    async isLockHeld(trackId: string): Promise<boolean> {
        const val = await this.client.exists(`leg:${trackId}:processing`);
        return val === 1;
    }

    /**
     * Close the Redis connection gracefully.
     */
    async disconnect(): Promise<void> {
        await this.client.quit();
    }

    /**
     * Expose the raw ioredis client for testing.
     */
    get raw(): Redis {
        return this.client;
    }
}
