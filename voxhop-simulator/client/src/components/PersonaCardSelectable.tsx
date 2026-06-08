import React from 'react';
import { Persona } from '../types/persona';

interface PersonaCardSelectableProps {
  persona: Persona;
  isSelected: boolean;
  isLocked: boolean;
  compact: boolean;
  onClick: () => void;
}

/**
 * PersonaCardSelectable — interactive persona card for Phase 2.
 * Supports 4 states: unselected, selected, locked (call active), active-partner.
 * data-persona-id for focus restoration (savedFocusRef).
 * PersonaCard.tsx is zero-diff — this is the Phase 2 replacement.
 */
export default function PersonaCardSelectable({
  persona,
  isSelected,
  isLocked,
  compact: _compact,
  onClick,
}: PersonaCardSelectableProps): React.ReactElement {
  const badgeClasses: Record<string, string> = {
    en: 'bg-blue-900/60 text-blue-300 border border-blue-800',
    es: 'bg-red-900/60 text-red-300 border border-red-800',
    fr: 'bg-indigo-900/60 text-indigo-300 border border-indigo-800',
    de: 'bg-yellow-900/60 text-yellow-200 border border-yellow-800',
    it: 'bg-green-900/60 text-green-300 border border-green-800',
  };
  const badgeClass = badgeClasses[persona.language] ?? 'bg-gray-800 text-gray-400 border border-gray-700';
  const langUpper = persona.language.toUpperCase();

  const isInteractive = !isLocked;

  const containerClass = [
    'rounded-lg p-5 transition-colors duration-150',
    isSelected
      ? 'bg-indigo-950/30 border-2 border-indigo-500'
      : isLocked
      ? 'bg-gray-900 border border-gray-700 opacity-60 cursor-not-allowed'
      : 'bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-800/50 cursor-pointer',
  ].join(' ');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isInteractive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role={isInteractive ? 'button' : 'article'}
      aria-pressed={isInteractive ? isSelected : undefined}
      aria-disabled={isLocked}
      tabIndex={isInteractive ? 0 : -1}
      data-persona-id={persona.id}
      className={containerClass}
      onClick={isInteractive ? onClick : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-gray-100 font-medium text-sm leading-snug">{persona.name}</h3>
        <span
          className={`shrink-0 text-xs font-mono px-1.5 py-0.5 rounded ${badgeClass}`}
          title={`Language: ${persona.language}`}
        >
          {langUpper}
        </span>
      </div>
      <p className="text-gray-500 text-xs mt-3 line-clamp-2 leading-relaxed">
        {persona.systemPrompt}
      </p>
    </div>
  );
}
