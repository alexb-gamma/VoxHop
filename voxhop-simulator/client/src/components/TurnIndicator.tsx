import React from 'react';
import { CallStatus } from '../types/persona';

interface TurnIndicatorProps {
  callStatus: CallStatus;
  processingTurn: boolean;
  llmTokenBuffer: string;
  aiSpeaking: boolean;
}

type TurnPhase =
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'generating'
  | 'ai-speaking';

/**
 * Derive the current turn phase from call state.
 *
 * Priority order (higher wins):
 *  generating   — LLM tokens arriving (processingTurn + buffer)
 *  transcribing — Whisper in-flight (processingTurn, no buffer yet)
 *  ai-speaking  — pipeline done, TTS audio playing
 *  listening    — waiting for user speech
 *  connecting   — call not yet active
 */
function deriveTurnPhase(
  callStatus: CallStatus,
  processingTurn: boolean,
  llmTokenBuffer: string,
  aiSpeaking: boolean,
): TurnPhase | null {
  if (callStatus === 'connecting') return 'connecting';
  if (callStatus !== 'active') return null;
  if (processingTurn && llmTokenBuffer) return 'generating';
  if (processingTurn) return 'transcribing';
  if (aiSpeaking) return 'ai-speaking';
  return 'listening';
}

interface PhaseConfig {
  label: string;
  sublabel: string;
  textClass: string;
  bgClass: string;
  borderClass: string;
  indicator: React.ReactElement;
}

const Spinner = ({ color }: { color: string }): React.ReactElement => (
  <div
    className={`w-3.5 h-3.5 rounded-full border-2 ${color} animate-spin`}
    aria-hidden="true"
  />
);

const PulseDot = ({ color }: { color: string }): React.ReactElement => (
  <div
    className={`w-3 h-3 rounded-full ${color} animate-pulse`}
    aria-hidden="true"
  />
);

const PHASE_CONFIG: Record<TurnPhase, PhaseConfig> = {
  connecting: {
    label: 'CONNECTING',
    sublabel: 'Establishing call…',
    textClass: 'text-amber-300',
    bgClass: 'bg-amber-950/40',
    borderClass: 'border-amber-700/50',
    indicator: <Spinner color="border-amber-600 border-t-amber-200" />,
  },
  listening: {
    label: 'LISTENING',
    sublabel: 'Your turn — speak now',
    textClass: 'text-green-300',
    bgClass: 'bg-green-950/40',
    borderClass: 'border-green-700/50',
    indicator: <PulseDot color="bg-green-400" />,
  },
  transcribing: {
    label: 'TRANSCRIBING',
    sublabel: 'Processing your speech…',
    textClass: 'text-amber-300',
    bgClass: 'bg-amber-950/40',
    borderClass: 'border-amber-700/50',
    indicator: <Spinner color="border-amber-600 border-t-amber-200" />,
  },
  generating: {
    label: 'GENERATING',
    sublabel: 'AI composing response…',
    textClass: 'text-indigo-300',
    bgClass: 'bg-indigo-950/40',
    borderClass: 'border-indigo-700/50',
    indicator: <Spinner color="border-indigo-600 border-t-indigo-200" />,
  },
  'ai-speaking': {
    label: 'AI SPEAKING',
    sublabel: 'Playing audio response…',
    textClass: 'text-blue-300',
    bgClass: 'bg-blue-950/40',
    borderClass: 'border-blue-700/50',
    indicator: <PulseDot color="bg-blue-400" />,
  },
};

/**
 * TurnIndicator — persistent, always-visible indicator of whose turn it is.
 *
 * Rendered between the CallPanelHeader and TranscriptPanel during an active
 * or connecting call. Provides at-a-glance debugging of where the pipeline is:
 *
 *   LISTENING    → waiting for user speech
 *   TRANSCRIBING → Whisper STT in-flight
 *   GENERATING   → Ollama streaming tokens
 *   AI SPEAKING  → TTS audio playing
 */
export default function TurnIndicator({
  callStatus,
  processingTurn,
  llmTokenBuffer,
  aiSpeaking,
}: TurnIndicatorProps): React.ReactElement | null {
  const phase = deriveTurnPhase(callStatus, processingTurn, llmTokenBuffer, aiSpeaking);
  if (!phase) return null;

  const { label, sublabel, textClass, bgClass, borderClass, indicator } = PHASE_CONFIG[phase];

  return (
    <div
      className={`${bgClass} border ${borderClass} rounded-lg px-4 py-2.5 flex items-center gap-3`}
      role="status"
      aria-live="polite"
      aria-label={`Turn phase: ${label}`}
    >
      {indicator}
      <span className={`font-mono text-xs font-semibold tracking-widest uppercase ${textClass}`}>
        {label}
      </span>
      <span className="text-gray-500 text-xs font-mono">
        {sublabel}
      </span>
    </div>
  );
}
