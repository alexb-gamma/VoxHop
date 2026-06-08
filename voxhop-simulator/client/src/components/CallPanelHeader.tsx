import React from 'react';
import { CallStatus, Persona } from '../types/persona';
import CallStatusBadge from './CallStatusBadge';

interface CallPanelHeaderProps {
  callStatus: CallStatus;
  persona: Persona | null;
  hangUpRef: React.RefObject<HTMLButtonElement>;
  onHangUp: () => void;
  onDismiss: () => void;
}

/**
 * CallPanelHeader — shows status badge, persona name, and context action button.
 */
export default function CallPanelHeader({
  callStatus,
  persona,
  hangUpRef,
  onHangUp,
  onDismiss,
}: CallPanelHeaderProps): React.ReactElement {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap">
      <CallStatusBadge status={callStatus} />
      {persona && (
        <span className="text-gray-300 text-sm font-medium">{persona.name}</span>
      )}
      <div className="ml-auto">
        {(callStatus === 'connecting' || callStatus === 'active') && (
          <button
            ref={hangUpRef}
            type="button"
            onClick={onHangUp}
            className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
          >
            Hang Up
          </button>
        )}
        {(callStatus === 'ended' || callStatus === 'error') && (
          <button
            type="button"
            onClick={onDismiss}
            className="px-4 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold transition-colors"
          >
            New Call
          </button>
        )}
      </div>
    </div>
  );
}
