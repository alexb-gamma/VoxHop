import React from 'react';

interface ErrorBannerProps {
  message: string;
}

/**
 * ErrorBanner — persistent, non-dismissible error display.
 *
 * §6.1: All ErrorBanner instances are persistent and non-dismissible.
 * §6.7: role="alert" — announced immediately on render.
 * §6.6: bg-red-900/50 border border-red-800 rounded-lg
 */
export default function ErrorBanner({ message }: ErrorBannerProps): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 bg-red-900/50 border border-red-800 rounded-lg px-4 py-3 mb-6"
    >
      {/* Error icon */}
      <svg
        className="w-4 h-4 text-red-400 shrink-0 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.734 0L4.07 16.5c-.77.833.192 2.5 1.732 2.5z"
        />
      </svg>
      <p className="text-red-200 text-sm">{message}</p>
    </div>
  );
}
