import React from 'react';

interface MicPermissionPromptProps {
  onGrant: () => void;
}

/**
 * MicPermissionPrompt — rendered only when status === 'mic_prompt'.
 * §6.6: bg-gray-900 border border-gray-800 rounded-lg px-5 py-4 mt-6
 * §6.7: aria-label on button
 */
export default function MicPermissionPrompt({ onGrant }: MicPermissionPromptProps): React.ReactElement {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-5 py-4 mt-6 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="text-xl" aria-hidden="true">🎤</span>
        <div>
          <p className="text-gray-100 text-sm font-medium">Microphone Access Required</p>
          <p className="text-gray-500 text-xs mt-0.5">
            Required for audio capture and call features.
          </p>
        </div>
      </div>
      <button
        onClick={onGrant}
        aria-label="Grant microphone access for audio capture"
        className="bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-gray-100 text-sm font-medium px-4 py-2 rounded-md transition-colors duration-150 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-gray-400 shrink-0"
      >
        Allow Microphone
      </button>
    </div>
  );
}
