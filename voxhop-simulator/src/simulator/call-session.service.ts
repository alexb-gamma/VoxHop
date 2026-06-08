/**
 * VoxHop Simulator — Call Session Service
 *
 * Manages per-browser-WS call session state.
 * One CallSession per browser WebSocket connection at a time.
 * InboundAudioTranscoder is instantiated per session (NOT singleton).
 */
import { Injectable, Logger } from '@nestjs/common';
import type WebSocket from 'ws';
import { InboundAudioTranscoder } from './audio-transcoder';
import type { Persona } from '../persona/persona.schema';

export interface CallSession {
  callId: string;
  rxTrackId: string;
  txTrackId: string;
  persona: Persona;
  counterpartyAudioWs: WebSocket | null;
  counterpartyEventsWs: WebSocket | null;
  transcoder: InboundAudioTranscoder;
  connectingTimeout: ReturnType<typeof setTimeout> | null;
  isActive: boolean;
}

@Injectable()
export class CallSessionService {
  private readonly logger = new Logger(CallSessionService.name);
  private readonly sessions = new Map<WebSocket, CallSession>();

  create(
    client: WebSocket,
    data: Omit<CallSession, 'transcoder' | 'connectingTimeout' | 'isActive'>,
  ): CallSession {
    const session: CallSession = {
      ...data,
      transcoder: new InboundAudioTranscoder(), // new instance per session
      connectingTimeout: null,
      isActive: true,
    };
    this.sessions.set(client, session);
    return session;
  }

  get(client: WebSocket): CallSession | undefined {
    return this.sessions.get(client);
  }

  async teardown(client: WebSocket): Promise<void> {
    const session = this.sessions.get(client);
    if (!session) return;
    if (!session.isActive) return;

    session.isActive = false;

    // Clear connecting timeout if still pending
    if (session.connectingTimeout) {
      clearTimeout(session.connectingTimeout);
      session.connectingTimeout = null;
    }

    // Send call_ended to counterparty audio WS
    if (session.counterpartyAudioWs && session.counterpartyAudioWs.readyState === 1 /* OPEN */) {
      try {
        session.counterpartyAudioWs.send(
          JSON.stringify({ event: 'call_ended', callId: session.callId, timestamp: new Date().toISOString() }),
        );
      } catch {
        // ignore send errors on teardown
      }
    }

    // Close counterparty connections
    if (session.counterpartyAudioWs) {
      try { session.counterpartyAudioWs.close(); } catch { /* ignore */ }
      session.counterpartyAudioWs = null;
    }
    if (session.counterpartyEventsWs) {
      try { session.counterpartyEventsWs.close(); } catch { /* ignore */ }
      session.counterpartyEventsWs = null;
    }

    this.sessions.delete(client);
    this.logger.log(`[teardown] Session closed — callId: ${session.callId}`);
  }
}
