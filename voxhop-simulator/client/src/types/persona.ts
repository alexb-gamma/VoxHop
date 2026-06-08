/**
 * Client-side type definitions — duplicated from server per MN-03.
 *
 * MN-03: MUST NOT import from voxhop-simulator/src/. These types are defined
 * independently here and in src/persona/persona.schema.ts (server-side Zod schema).
 * No tsconfig.paths alias, no relative ../../src/ import crosses the boundary.
 */

export interface Persona {
  id: string;
  name: string;
  language: string; // 'en' | 'es' | 'fr' | 'de' | 'it'
  piperVoice: string;
  systemPrompt: string;
  conversationOpener?: string;
}

export type MicStatus = 'none' | 'prompting' | 'granted' | 'denied';
export type WorkletStatus = 'none' | 'init' | 'ready' | 'error';

export type CallStatus = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export interface TranscriptEntry {
  id: string;           // crypto.randomUUID()
  role: 'user' | 'counterparty';
  text: string;
  language: string;     // 'en' | 'es' | 'fr' | 'de' | 'it'
  timestamp: number;    // Date.now()
}

export interface TelemetryRow {
  turnIndex: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}
