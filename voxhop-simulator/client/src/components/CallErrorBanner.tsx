import React from 'react';

interface CallErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

/**
 * CallErrorBanner — shown inside CallPanel when callStatus === 'error'.
 * role="alert" for immediate screen reader announcement.
 * Distinct from global ErrorBanner.tsx.
 */
export default function CallErrorBanner({ message, onDismiss }: CallErrorBannerProps): React.ReactElement {
  return (
    <div
      role="alert"
      className="bg-red-950/40 border border-red-800 rounded-lg px-4 py-3 flex items-start gap-3"
    >
      <span className="text-red-400 text-sm mt-0.5" aria-hidden="true">⚠</span>
      <div className="flex-1 min-w-0">
        <p className="text-red-300 text-sm">{message}</p>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-red-400 hover:text-red-300 font-mono uppercase tracking-widest"
        >
          Try Again
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-gray-500 hover:text-gray-400 font-mono uppercase tracking-widest"
        >
          Close
        </button>
      </div>
    </div>
  );
}
