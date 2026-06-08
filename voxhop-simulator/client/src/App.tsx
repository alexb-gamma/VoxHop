import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { appReducer, initialState } from './state/appReducer';
import { MicStatus, WorkletStatus } from './types/persona';
import Header from './components/Header';
import ErrorBanner from './components/ErrorBanner';
import PersonaGrid from './components/PersonaGrid';
import MicPermissionPrompt from './components/MicPermissionPrompt';
import CallDialBar from './components/CallDialBar';
import CallPanel from './components/CallPanel';

/**
 * App — root component; owns useReducer + all useRefs.
 *
 * Phase 1 boot sequence preserved unchanged.
 * Phase 2 adds: dial/hangup/dismiss handlers, WS message routing,
 * audio scheduling, split-pane layout during active call.
 */
export default function App(): React.ReactElement {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // ─── Phase 1 refs ───────────────────────────────────────────────────────────
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // ─── Phase 2 refs ───────────────────────────────────────────────────────────
  const hangUpRef = useRef<HTMLButtonElement>(null);
  const savedFocusRef = useRef<HTMLElement | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  // Ref mirror for callStatus — avoids stale closure in worklet onmessage handler
  const callStatusRef = useRef(state.callStatus);

  // ─── Boot sequence (Phase 1 — unchanged) ────────────────────────────────────
  useEffect(() => {
    if (typeof SharedArrayBuffer === 'undefined') {
      dispatch({ type: 'SAB_MISSING' });
      return;
    }
    dispatch({ type: 'SAB_OK' });

    fetch('/personas')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => dispatch({ type: 'PERSONAS_LOADED', payload: data }))
      .catch(() => dispatch({ type: 'PERSONAS_ERROR', payload: 'Could not reach simulator service' }));
  }, []);

  // ─── Keep callStatusRef in sync so worklet onmessage always sees current value ─
  useEffect(() => {
    callStatusRef.current = state.callStatus;
  }, [state.callStatus]);

  // ─── AudioWorklet init (Phase 1 — unchanged logic, Phase 2 extends onmessage) ─
  useEffect(() => {
    if (state.status !== 'worklet_init') return;

    const initWorklet = async (): Promise<void> => {
      try {
        const audioCtx = new AudioContext();
        audioContextRef.current = audioCtx;

        await audioCtx.audioWorklet.addModule('/pcm-capture-processor.js');

        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture-processor');
        workletNodeRef.current = workletNode;

        workletNode.port.onmessage = ({ data }: MessageEvent) => {
          if (data.type === 'pcm-capture-ready') {
            dispatch({ type: 'WORKLET_READY' });
          } else if (data.type === 'audio-frame' && callStatusRef.current === 'active') {
            // Phase 2: stream mic audio to backend during active call
            // NOTE: use callStatusRef (not state.callStatus) to avoid stale closure —
            // this handler is registered once at worklet_init time.
            if (wsRef.current?.readyState === 1) {
              wsRef.current.send((data.data as Float32Array).buffer);
            }
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

  // ─── WebSocket setup (persistent connection once worklet is ready) ───────────
  useEffect(() => {
    if (state.status !== 'ready') return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/simulator`);
    ws.binaryType = 'arraybuffer'; // required: default 'blob' breaks instanceof ArrayBuffer check
    wsRef.current = ws;

    ws.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary: counterparty TTS audio — dispatch CALL_ACTIVE (idempotent guard in reducer)
        dispatch({ type: 'CALL_ACTIVE' });
        scheduleAudioPlayback(new Float32Array(event.data));
        return;
      }

      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;

        if (msg.source === 'counterparty') {
          const evt = msg.event as string;
          if (evt === 'transcript') {
            dispatch({
              type: 'TRANSCRIPT_RECEIVED',
              payload: {
                role: msg.role as 'user' | 'counterparty',
                text: msg.text as string,
                timestamp: (msg.timestamp as number) ?? Date.now(),
              },
            });
          } else if (evt === 'llm_token') {
            dispatch({ type: 'LLM_TOKEN_RECEIVED', payload: msg.token as string });
          } else if (evt === 'turn_latency') {
            dispatch({
              type: 'TURN_LATENCY_RECEIVED',
              payload: {
                sttMs: msg.sttMs as number,
                llmMs: msg.llmMs as number,
                ttsMs: msg.ttsMs as number,
                totalMs: msg.totalMs as number,
              },
            });
          } else if (evt === 'pipeline_error') {
            dispatch({ type: 'CALL_ERROR', payload: `Pipeline error (${msg.stage as string}): ${msg.message as string}` });
          }
        } else if (msg.type === 'call_ended') {
          dispatch({ type: 'CALL_ENDED' });
        } else if (msg.type === 'call_active') {
          dispatch({ type: 'CALL_ACTIVE' });
        } else if (msg.type === 'error') {
          dispatch({ type: 'CALL_ERROR', payload: msg.reason as string });
        }
      } catch {
        // ignore malformed JSON
      }
    });

    ws.addEventListener('close', () => {
      wsRef.current = null;
    });

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [state.status]);

  // ─── Audio scheduling helper ─────────────────────────────────────────────────
  const scheduleAudioPlayback = useCallback((float32: Float32Array<ArrayBuffer>) => {
    const audioCtx = audioContextRef.current;
    if (!audioCtx) return;

    const audioBuffer = audioCtx.createBuffer(1, float32.length, 48000);
    audioBuffer.copyToChannel(float32, 0);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    const startAt = Math.max(audioCtx.currentTime, nextPlayTimeRef.current);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + audioBuffer.duration;
  }, []);

  // ─── Hang Up auto-focus (Phase 2) ────────────────────────────────────────────
  useEffect(() => {
    if (state.callStatus === 'active') {
      setTimeout(() => hangUpRef.current?.focus(), 50);
    }
  }, [state.callStatus]);

  // ─── Phase 2 handlers ────────────────────────────────────────────────────────
  const handleSelectPersona = useCallback((personaId: string) => {
    if (state.selectedPersonaId === personaId) {
      dispatch({ type: 'PERSONA_DESELECT' });
    } else {
      dispatch({ type: 'PERSONA_SELECT', payload: personaId });
    }
  }, [state.selectedPersonaId]);

  const handleDial = useCallback((personaId: string) => {
    savedFocusRef.current = document.querySelector(`[data-persona-id="${personaId}"]`) as HTMLElement | null;
    dispatch({ type: 'DIAL_INITIATED' });
    wsRef.current?.send(JSON.stringify({ type: 'dial', personaId }));
  }, []);

  const handleHangup = useCallback(() => {
    dispatch({ type: 'HANG_UP_INITIATED' });
    wsRef.current?.send(JSON.stringify({ type: 'hangup' }));
  }, []);

  const handleDismiss = useCallback(() => {
    dispatch({ type: 'DISMISS_CALL_RESULT' });
    savedFocusRef.current?.focus();
  }, []);

  // ─── Mic grant handler (Phase 1 — unchanged) ─────────────────────────────────
  const handleMicGrant = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;
      dispatch({ type: 'MIC_GRANTED' });
    } catch {
      dispatch({ type: 'MIC_DENIED', payload: 'Microphone access denied — call features unavailable' });
    }
  };

  // ─── Derived UI state (Phase 1 — unchanged) ──────────────────────────────────
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

  const env = import.meta.env.DEV ? 'DEV' : 'PROD';
  const showPersonaSection = !['sab_error', 'network_error', 'initialising'].includes(state.status);
  const isPersonaLoading = state.status === 'loading';
  const showMicPrompt = state.status === 'mic_prompt';

  const selectedPersona = state.personas.find((p) => p.id === state.selectedPersonaId) ?? null;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 antialiased">
      <Header env={env} micStatus={micStatus} workletStatus={workletStatus} />

      <main className="max-w-screen-xl mx-auto px-6 py-8">
        {state.errorMessage !== null && <ErrorBanner message={state.errorMessage} />}

        {showPersonaSection && (
          <>
            {state.callStatus === 'idle' ? (
              <>
                <p className="text-gray-400 text-xs font-mono uppercase tracking-widest mb-4">
                  Counterparty Personas
                </p>
                <PersonaGrid
                  personas={state.personas}
                  loading={isPersonaLoading}
                  mode="grid"
                  selectedPersonaId={state.selectedPersonaId}
                  callStatus={state.callStatus}
                  onSelectPersona={handleSelectPersona}
                />
                {state.status === 'ready' && (
                  <CallDialBar selectedPersona={selectedPersona} onDial={handleDial} />
                )}
              </>
            ) : (
              <div className="flex gap-6 items-start">
                <div className="w-72 shrink-0 flex flex-col gap-3">
                  <PersonaGrid
                    personas={state.personas}
                    loading={false}
                    mode="sidebar"
                    selectedPersonaId={state.selectedPersonaId}
                    callStatus={state.callStatus}
                    onSelectPersona={() => {}}
                  />
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-4">
                  <CallPanel
                    callStatus={state.callStatus}
                    persona={selectedPersona}
                    transcript={state.transcript}
                    llmTokenBuffer={state.llmTokenBuffer}
                    processingTurn={state.processingTurn}
                    aiSpeaking={state.aiSpeaking}
                    telemetry={state.telemetry}
                    callErrorMessage={state.callErrorMessage}
                    hangUpRef={hangUpRef}
                    onHangUp={handleHangup}
                    onDismiss={handleDismiss}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {showMicPrompt && <MicPermissionPrompt onGrant={handleMicGrant} />}
      </main>
    </div>
  );
}
