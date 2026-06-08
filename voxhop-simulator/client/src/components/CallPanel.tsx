import React from 'react';
import { CallStatus, Persona, TranscriptEntry, TelemetryRow } from '../types/persona';
import CallPanelHeader from './CallPanelHeader';
import CallErrorBanner from './CallErrorBanner';
import TranscriptPanel from './TranscriptPanel';
import TelemetryPanel from './TelemetryPanel';
import TurnIndicator from './TurnIndicator';

interface CallPanelProps {
  callStatus: CallStatus;
  persona: Persona | null;
  transcript: TranscriptEntry[];
  llmTokenBuffer: string;
  processingTurn: boolean;
  aiSpeaking: boolean;
  telemetry: TelemetryRow[];
  callErrorMessage: string | null;
  hangUpRef: React.RefObject<HTMLButtonElement>;
  onHangUp: () => void;
  onDismiss: () => void;
}

/**
 * CallPanel — main call view container.
 * Composes header + turn indicator + error banner + transcript + telemetry.
 */
export default function CallPanel({
  callStatus,
  persona,
  transcript,
  llmTokenBuffer,
  processingTurn,
  aiSpeaking,
  telemetry,
  callErrorMessage,
  hangUpRef,
  onHangUp,
  onDismiss,
}: CallPanelProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <CallPanelHeader
        callStatus={callStatus}
        persona={persona}
        hangUpRef={hangUpRef}
        onHangUp={onHangUp}
        onDismiss={onDismiss}
      />
      <TurnIndicator
        callStatus={callStatus}
        processingTurn={processingTurn}
        llmTokenBuffer={llmTokenBuffer}
        aiSpeaking={aiSpeaking}
      />
      {callStatus === 'error' && callErrorMessage && (
        <CallErrorBanner message={callErrorMessage} onDismiss={onDismiss} />
      )}
      <TranscriptPanel
        callStatus={callStatus}
        transcript={transcript}
        llmTokenBuffer={llmTokenBuffer}
        processingTurn={processingTurn}
        persona={persona}
      />
      {telemetry.length > 0 && <TelemetryPanel telemetry={telemetry} />}
    </div>
  );
}
