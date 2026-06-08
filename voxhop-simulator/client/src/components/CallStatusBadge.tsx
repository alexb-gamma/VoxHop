import React from 'react';
import { CallStatus } from '../types/persona';

interface CallStatusBadgeProps {
  status: CallStatus;
}

const STATUS_CONFIG: Record<CallStatus, { label: string; className: string; pulse: boolean }> = {
  idle:       { label: 'IDLE',       className: 'text-gray-400',   pulse: false },
  connecting: { label: 'CONNECTING', className: 'text-amber-400',  pulse: true  },
  active:     { label: 'ACTIVE',     className: 'text-green-400',  pulse: true  },
  ended:      { label: 'ENDED',      className: 'text-gray-500',   pulse: false },
  error:      { label: 'ERROR',      className: 'text-red-400',    pulse: false },
};

/**
 * CallStatusBadge — inline status indicator with optional pulsing dot.
 */
export default function CallStatusBadge({ status }: CallStatusBadgeProps): React.ReactElement {
  const { label, className, pulse } = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-mono ${className}`}
      aria-label={`Call status: ${label}`}
    >
      {pulse && (
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}
