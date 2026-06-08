import React from 'react';

/**
 * ProcessingIndicator — shown while Counterparty pipeline is in-flight.
 * Mounted/unmounted (not hidden) — causes a single announcement per turn.
 */
export default function ProcessingIndicator(): React.ReactElement {
  return (
    <div
      className="mx-3 px-4 py-3 mb-2 flex items-center gap-3"
      aria-live="polite"
      aria-label="Pipeline processing"
    >
      <div className="w-4 h-4 border-2 border-amber-600 border-t-amber-300 rounded-full animate-spin" aria-hidden="true" />
      <span className="text-amber-400 font-mono text-xs uppercase tracking-widest">Pipeline processing</span>
      <span className="text-amber-500 text-sm animate-pulse" aria-hidden="true">● ● ●</span>
    </div>
  );
}
