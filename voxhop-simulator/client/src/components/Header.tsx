import React from 'react';
import { MicStatus, WorkletStatus } from '../types/persona';

interface HeaderProps {
  env: string;
  micStatus: MicStatus;
  workletStatus: WorkletStatus;
}

/**
 * Header — wordmark, env badge, mic indicator, worklet indicator.
 * §6.6: sticky top-0 z-10 h-14 bg-gray-950 border-b border-gray-800
 */
export default function Header({ env, micStatus, workletStatus }: HeaderProps): React.ReactElement {
  return (
    <header className="sticky top-0 z-10 h-14 bg-gray-950 border-b border-gray-800 px-6 flex items-center justify-between">
      {/* Left: wordmark + env badge */}
      <div className="flex items-center gap-3">
        <span className="text-gray-100 font-semibold text-base tracking-tight select-none">
          VoxHop Simulator
        </span>
        <span className="bg-gray-800 text-gray-400 text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide">
          {env}
        </span>
      </div>

      {/* Right: mic indicator | separator | worklet indicator */}
      <div className="flex items-center gap-4">
        <MicIndicator status={micStatus} />
        <div className="w-px h-4 bg-gray-800" aria-hidden="true" />
        <WorkletIndicator status={workletStatus} />
      </div>
    </header>
  );
}

function MicIndicator({ status }: { status: MicStatus }): React.ReactElement {
  const config: Record<MicStatus, { dotClass: string; labelClass: string; label: string }> = {
    none: {
      dotClass: 'w-2 h-2 rounded-full bg-gray-600',
      labelClass: 'text-gray-600 text-xs font-mono',
      label: 'MIC —',
    },
    prompting: {
      dotClass: 'w-2 h-2 rounded-full bg-amber-400',
      labelClass: 'text-amber-400 text-xs font-mono',
      label: 'MIC PENDING',
    },
    granted: {
      dotClass: 'w-2 h-2 rounded-full bg-green-400',
      labelClass: 'text-green-400 text-xs font-mono',
      label: 'MIC ACTIVE',
    },
    denied: {
      dotClass: 'w-2 h-2 rounded-full bg-red-400',
      labelClass: 'text-red-400 text-xs font-mono',
      label: 'MIC DENIED',
    },
  };

  const { dotClass, labelClass, label } = config[status];
  const ariaLabelMap: Record<MicStatus, string> = {
    none: 'Microphone status: inactive',
    prompting: 'Microphone status: pending',
    granted: 'Microphone status: active',
    denied: 'Microphone status: denied',
  };

  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={ariaLabelMap[status]}
    >
      <span className={dotClass} />
      <span className={labelClass}>{label}</span>
    </div>
  );
}

function WorkletIndicator({ status }: { status: WorkletStatus }): React.ReactElement {
  const config: Record<WorkletStatus, { className: string; text: string; ariaLabel: string }> = {
    none: {
      className: 'text-gray-600 text-xs font-mono',
      text: 'WORKLET —',
      ariaLabel: 'AudioWorklet status: none',
    },
    init: {
      className: 'text-amber-400 text-xs font-mono',
      text: 'WORKLET INIT',
      ariaLabel: 'AudioWorklet status: initialising',
    },
    ready: {
      className: 'text-green-400 text-xs font-mono',
      text: 'AudioWorklet Ready ✓',
      ariaLabel: 'AudioWorklet status: ready',
    },
    error: {
      className: 'text-red-400 text-xs font-mono',
      text: 'WORKLET ERROR',
      ariaLabel: 'AudioWorklet status: error',
    },
  };

  const { className, text, ariaLabel } = config[status];

  return (
    <span className={className} aria-label={ariaLabel}>
      {text}
    </span>
  );
}
