import React from 'react';
import { Persona } from '../types/persona';

interface CallDialBarProps {
  selectedPersona: Persona | null;
  onDial: (personaId: string) => void;
}

/**
 * CallDialBar — dial action bar shown below the persona grid in idle state.
 * Enabled only when a persona is selected.
 */
export default function CallDialBar({ selectedPersona, onDial }: CallDialBarProps): React.ReactElement {
  const isEnabled = selectedPersona !== null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-5 py-4 mt-6 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        {selectedPersona ? (
          <p className="text-gray-200 text-sm font-medium truncate">
            {selectedPersona.name}
            <span className="ml-2 text-gray-500 text-xs font-mono">
              {selectedPersona.language.toUpperCase()}
            </span>
          </p>
        ) : (
          <p className="text-gray-600 text-sm" id="dial-helper-text">
            Select a persona to enable Direct Mode dial
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={!isEnabled}
        aria-describedby={!isEnabled ? 'dial-helper-text' : undefined}
        onClick={() => selectedPersona && onDial(selectedPersona.id)}
        className={[
          'shrink-0 px-5 py-2 rounded-lg text-sm font-semibold transition-colors',
          isEnabled
            ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
            : 'bg-gray-800 text-gray-600 cursor-not-allowed',
        ].join(' ')}
      >
        Dial (Direct)
      </button>
    </div>
  );
}
