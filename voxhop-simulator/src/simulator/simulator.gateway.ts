/**
 * VoxHop Simulator — WebSocket Gateway (Phase 2)
 *
 * Handles browser WebSocket connections on /ws/simulator.
 * Routes:
 *   - text "dial"   → open counterparty connections, relay audio/metadata
 *   - text "hangup" → close counterparty connections, signal browser
 *   - binary        → inbound audio relay (Float32 48kHz → S16LE 16kHz → counterparty)
 *
 * Phase 2 architecture:
 *   Browser <--> NestJS Gateway <--> Counterparty /gamma/audio (audio)
 *                                <--> Counterparty /events     (metadata)
 *
 * voxhop-app is NOT involved in Direct Mode.
 */
import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { PersonaLoader } from '../persona/persona.loader';
import { CallSessionService } from './call-session.service';
import { InboundAudioTranscoder } from './audio-transcoder';

const COUNTERPARTY_URL = process.env.COUNTERPARTY_URL ?? 'ws://voxhop-counterparty:3001';

@WebSocketGateway({ path: '/ws/simulator', transports: ['websocket'] })
export class SimulatorGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SimulatorGateway.name);

  constructor(
    private readonly personaLoader: PersonaLoader,
    private readonly callSessionService: CallSessionService,
  ) {}

  handleConnection(client: WebSocket): void {
    this.logger.log('[simulator] browser connected');
    client.send(JSON.stringify({ type: 'ack' }));

    client.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        this.handleBinaryAudio(client, data as Buffer);
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as { type?: string; personaId?: string };
        if (msg.type === 'dial') {
          void this.handleDial(client, msg.personaId ?? '');
        } else if (msg.type === 'hangup') {
          void this.handleHangup(client);
        }
      } catch {
        // ignore malformed JSON
      }
    });
  }

  handleDisconnect(client: WebSocket): void {
    this.logger.log('[simulator] browser disconnected');
    void this.callSessionService.teardown(client);
  }

  private async handleDial(client: WebSocket, personaId: string): Promise<void> {
    // Reject if session already active
    const existing = this.callSessionService.get(client);
    if (existing) {
      client.send(JSON.stringify({ type: 'error', reason: 'call_already_active' }));
      return;
    }

    // Find persona
    const persona = this.personaLoader.getPersonas().find((p) => p.id === personaId);
    if (!persona) {
      client.send(JSON.stringify({ type: 'error', reason: `persona_not_found: ${personaId}` }));
      return;
    }

    const callId = randomUUID();
    const rxTrackId = randomUUID();
    const txTrackId = randomUUID();

    // Open WS to counterparty /gamma/audio
    const audioWs = new WebSocket(`${COUNTERPARTY_URL}/gamma/audio`);

    // Create session immediately so binary audio relay knows the session exists
    const session = this.callSessionService.create(client, {
      callId,
      rxTrackId,
      txTrackId,
      persona,
      counterpartyAudioWs: audioWs,
      counterpartyEventsWs: null,
    });

    // Set 10-second connecting timeout
    session.connectingTimeout = setTimeout(() => {
      this.logger.warn(`[dial] Connecting timeout — no audio received in 10s — callId: ${callId}`);
      client.send(JSON.stringify({ type: 'error', reason: 'connection_timeout' }));
      void this.callSessionService.teardown(client);
    }, 10000);

    audioWs.on('open', async () => {
      this.logger.log(`[dial] /gamma/audio open — callId: ${callId}`);

      // Send protocol sequence with required delays
      audioWs.send(
        JSON.stringify({
          event: 'call_initiated',
          callId,
          timestamp: new Date().toISOString(),
          customData: { persona },
        }),
      );

      await delay(50);

      audioWs.send(
        JSON.stringify({ event: 'call_answered', callId, timestamp: new Date().toISOString() }),
      );

      await delay(100);

      audioWs.send(
        JSON.stringify({
          event: 'media_started',
          callId,
          tracks: [{ trackId: rxTrackId, track: 'caller' }],
          txTrackId,
          mediaFormat: {
            encoding: 'audio/x-raw',
            sampleRate: 16000,
            channels: 1,
            bitDepth: 16,
            payloadEncoding: 'base64',
          },
          timestamp: new Date().toISOString(),
        }),
      );

      // Open /events WebSocket after media_started sent
      const eventsWs = new WebSocket(`${COUNTERPARTY_URL}/events?callId=${callId}`);
      session.counterpartyEventsWs = eventsWs;

      eventsWs.on('open', () => {
        this.logger.log(`[dial] /events open — callId: ${callId}`);
      });

      eventsWs.on('message', (data: Buffer | string) => {
        // Forward all metadata events to browser with source: "counterparty"
        try {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          if (client.readyState === 1 /* OPEN */) {
            client.send(JSON.stringify({ ...parsed, source: 'counterparty' }));
          }
        } catch {
          // ignore malformed JSON
        }
      });

      eventsWs.on('error', (err) => {
        this.logger.warn(`[dial] /events error — callId: ${callId} — ${err.message}`);
      });

      eventsWs.on('close', () => {
        this.logger.debug(`[dial] /events closed — callId: ${callId}`);
      });
    });

    audioWs.on('message', (data: Buffer | string) => {
      try {
        const frame = JSON.parse(data.toString()) as { event?: string; trackId?: string; payload?: string };

        if (frame.event === 'audio' && frame.trackId === txTrackId && frame.payload) {
          // First binary audio = call active — clear connecting timeout
          const currentSession = this.callSessionService.get(client);
          if (currentSession?.connectingTimeout) {
            clearTimeout(currentSession.connectingTimeout);
            currentSession.connectingTimeout = null;
            // Signal browser that call is active
            if (client.readyState === 1 /* OPEN */) {
              client.send(JSON.stringify({ type: 'call_active' }));
            }
          }

          // Upsample S16LE 16kHz → Float32 48kHz and send as binary to browser
          const float32Buffer = InboundAudioTranscoder.upsampleToFloat32(frame.payload);
          if (client.readyState === 1 /* OPEN */) {
            client.send(Buffer.from(float32Buffer));
          }
        } else if (frame.event === 'call_ended') {
          void this.callSessionService.teardown(client);
          if (client.readyState === 1 /* OPEN */) {
            client.send(JSON.stringify({ type: 'call_ended' }));
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    audioWs.on('error', (err) => {
      this.logger.error(`[dial] /gamma/audio error — callId: ${callId} — ${err.message}`);
      if (client.readyState === 1 /* OPEN */) {
        client.send(JSON.stringify({ type: 'error', reason: `counterparty_error: ${err.message}` }));
      }
      void this.callSessionService.teardown(client);
    });

    audioWs.on('close', () => {
      this.logger.debug(`[dial] /gamma/audio closed — callId: ${callId}`);
    });
  }

  private handleBinaryAudio(client: WebSocket, data: Buffer): void {
    const session = this.callSessionService.get(client);
    if (!session?.isActive) return;
    if (!session.counterpartyAudioWs || session.counterpartyAudioWs.readyState !== 1 /* OPEN */) return;

    const pcm16k = session.transcoder.processInbound(data);
    if (pcm16k === null) return; // accumulating — not enough samples yet

    session.counterpartyAudioWs.send(
      JSON.stringify({
        event: 'audio',
        callId: session.callId,
        trackId: session.rxTrackId,
        payload: pcm16k.toString('base64'),
      }),
    );
  }

  private async handleHangup(client: WebSocket): Promise<void> {
    const session = this.callSessionService.get(client);
    if (!session) return;

    this.logger.log(`[hangup] callId: ${session.callId}`);

    // Send call_ended to counterparty
    if (session.counterpartyAudioWs && session.counterpartyAudioWs.readyState === 1 /* OPEN */) {
      session.counterpartyAudioWs.send(
        JSON.stringify({ event: 'call_ended', callId: session.callId, timestamp: new Date().toISOString() }),
      );
    }

    await this.callSessionService.teardown(client);

    // Signal browser that call ended
    if (client.readyState === 1 /* OPEN */) {
      client.send(JSON.stringify({ type: 'call_ended' }));
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
