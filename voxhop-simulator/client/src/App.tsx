import React, { useEffect, useReducer, useRef } from 'react';
import { appReducer, initialState } from './state/appReducer';
import { MicStatus, WorkletStatus } from './types/persona';
import Header from './components/Header';
import ErrorBanner from './components/ErrorBanner';
import PersonaGrid from './components/PersonaGrid';
import MicPermissionPrompt from './components/MicPermissionPrompt';

/**
 * App — root component; owns useReducer + all useRefs.
 *
 * Boot sequence (§6.4, M-02):
 *   1. [SYNC]  SAB check — FIRST, before any fetch or AudioContext
 *   2. [ASYNC] fetch('/personas')
 *   3. [USER]  MicPermissionPrompt → getUserMedia
 *   4. [AUTO]  AudioWorklet init on status='worklet_init'
 *
 * State: useReducer(appReducer, initialState) — no external state library (§6.1)
 * Refs:  useRef for AudioContext, AudioWorkletNode, MediaStream — no re-render triggers
 */
export default function App(): React.ReactElement {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // useRef for AudioContext and worklet (§6.3: "no external state library")
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // ─── Boot sequence (single useEffect, empty deps — fires once on mount) ────
  // §6.4 §3.4: SAB check FIRST, then fetch('/personas'). No deviation.
  useEffect(() => {
    // Step 1: SAB check — SYNCHRONOUS, MUST BE FIRST (M-02)
    // This is the canary for HTTPS + COOP/COEP configuration.
    if (typeof SharedArrayBuffer === 'undefined') {
      dispatch({ type: 'SAB_MISSING' });
      return; // halt all further initialisation
    }
    dispatch({ type: 'SAB_OK' });

    // Step 2: Persona fetch (async)
    fetch('/personas')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => dispatch({ type: 'PERSONAS_LOADED', payload: data }))
      .catch(() => dispatch({ type: 'PERSONAS_ERROR', payload: 'Could not reach simulator service' }));
  }, []);

  // ─── AudioWorklet init (triggered when status transitions to 'worklet_init') ─
  // §3.4 step 4 / §6.4 boot sequence.
  useEffect(() => {
    if (state.status !== 'worklet_init') return;

    const initWorklet = async (): Promise<void> => {
      try {
        const audioCtx = new AudioContext();
        audioContextRef.current = audioCtx;

        // ER-03: '/pcm-capture-processor.js' resolves in both dev (Vite) and prod (NestJS static)
        await audioCtx.audioWorklet.addModule('/pcm-capture-processor.js');

        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture-processor');
        workletNodeRef.current = workletNode;

        workletNode.port.onmessage = ({ data }: MessageEvent) => {
          if (data.type === 'pcm-capture-ready') {
            dispatch({ type: 'WORKLET_READY' });
          }
        };

        if (micStreamRef.current) {
          const srcNode = audioCtx.createMediaStreamSource(micStreamRef.current);
          srcNode.connect(workletNode);
        }
      } catch {
        dispatch({ type: 'WORKLET_ERROR', payload: 'AudioWorklet failed to initialise' });
      }
    };

    void initWorklet();
  }, [state.status]);

  // ─── Mic grant handler (called by MicPermissionPrompt) ────────────────────
  const handleMicGrant = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;
      dispatch({ type: 'MIC_GRANTED' });
    } catch {
      dispatch({ type: 'MIC_DENIED', payload: 'Microphone access denied — call features unavailable' });
    }
  };

  // ─── Derived UI state ─────────────────────────────────────────────────────
  const micStatus: MicStatus = (() => {
    if (state.micGranted) return 'granted';
    if (state.status === 'mic_denied') return 'denied';
    if (state.status === 'mic_prompt') return 'prompting';
    return 'none';
  })();

  const workletStatus: WorkletStatus = (() => {
    if (state.workletReady) return 'ready';
    if (state.status === 'worklet_error') return 'error';
    if (state.status === 'worklet_init') return 'init';
    return 'none';
  })();

  // Environment badge — 'DEV' in development, 'PROD' in production
  const env = import.meta.env.DEV ? 'DEV' : 'PROD';

  // ─── Layout helpers (§6.2 state-specific layout variants) ────────────────
  const showPersonaSection = !['sab_error', 'network_error', 'initialising'].includes(state.status);
  const isPersonaLoading = state.status === 'loading';
  const showMicPrompt = state.status === 'mic_prompt';

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 antialiased">
      {/* Header — sticky, always visible */}
      <Header env={env} micStatus={micStatus} workletStatus={workletStatus} />

      {/* Main content */}
      <main className="max-w-screen-xl mx-auto px-6 py-8">
        {/* ErrorBanner — rendered when errorMessage is set */}
        {state.errorMessage !== null && <ErrorBanner message={state.errorMessage} />}

        {/* Persona section — hidden during sab_error, network_error, initialising */}
        {showPersonaSection && (
          <>
            <p className="text-gray-400 text-xs font-mono uppercase tracking-widest mb-4">
              Counterparty Personas
            </p>
            <PersonaGrid personas={state.personas} loading={isPersonaLoading} />
          </>
        )}

        {/* Mic permission prompt — only when status === 'mic_prompt' */}
        {showMicPrompt && <MicPermissionPrompt onGrant={handleMicGrant} />}
      </main>
    </div>
  );
}
