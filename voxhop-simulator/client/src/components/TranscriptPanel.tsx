import React, { useEffect, useRef } from 'react';
import { CallStatus, Persona, TranscriptEntry as TranscriptEntryType } from '../types/persona';
import TranscriptEntryComponent from './TranscriptEntry';
import ProcessingIndicator from './ProcessingIndicator';
import LLMStreamEntry from './LLMStreamEntry';

interface TranscriptPanelProps {
  callStatus: CallStatus;
  transcript: TranscriptEntryType[];
  llmTokenBuffer: string;
  processingTurn: boolean;
  persona: Persona | null;
}

/**
 * TranscriptPanel — live conversation transcript with auto-scroll.
 * role="log" aria-live="polite" for accessibility.
 */
export default function TranscriptPanel({
  callStatus,
  transcript,
  llmTokenBuffer,
  processingTurn,
  persona,
}: TranscriptPanelProps): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript.length, processingTurn, llmTokenBuffer]);

  const isEmpty = transcript.length === 0 && !processingTurn && !llmTokenBuffer;

  return (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-atomic="false"
      className="bg-gray-900 border border-gray-800 rounded-lg overflow-y-auto max-h-96 min-h-48"
    >
      {callStatus === 'connecting' && isEmpty && (
        <div className="flex items-center justify-center h-48">
          <div className="flex flex-col items-center gap-3 text-gray-500">
            <div className="w-6 h-6 border-2 border-gray-600 border-t-gray-400 rounded-full animate-spin" />
            <span className="text-xs font-mono uppercase tracking-widest">Establishing Connection</span>
          </div>
        </div>
      )}

      {callStatus === 'active' && isEmpty && (
        <div className="flex items-center justify-center h-48">
          <p className="text-gray-600 text-xs font-mono uppercase tracking-widest">Waiting for speech...</p>
        </div>
      )}

      {/* Transcript entries */}
      <div className="py-3">
        {transcript.map((entry) => (
          <TranscriptEntryComponent key={entry.id} entry={entry} />
        ))}

        {/* Processing indicator — shown when user transcript received but counterparty hasn't responded */}
        {processingTurn && !llmTokenBuffer && <ProcessingIndicator />}

        {/* LLM token stream — shown while Ollama is generating */}
        {llmTokenBuffer && persona && (
          <LLMStreamEntry persona={persona} tokenBuffer={llmTokenBuffer} />
        )}
      </div>

      <div ref={bottomRef} />
    </div>
  );
}
