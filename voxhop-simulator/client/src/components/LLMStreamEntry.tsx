import React from 'react';
import { Persona } from '../types/persona';

interface LLMStreamEntryProps {
  persona: Persona;
  tokenBuffer: string;
}

const LANG_BORDER: Record<string, string> = {
  en: 'border-blue-600 bg-blue-950/20',
  es: 'border-red-600 bg-red-950/20',
  fr: 'border-indigo-600 bg-indigo-950/20',
  de: 'border-yellow-600 bg-yellow-950/20',
  it: 'border-green-600 bg-green-950/20',
};

const LANG_BADGE: Record<string, string> = {
  en: 'bg-blue-900/60 text-blue-300 border border-blue-800',
  es: 'bg-red-900/60 text-red-300 border border-red-800',
  fr: 'bg-indigo-900/60 text-indigo-300 border border-indigo-800',
  de: 'bg-yellow-900/60 text-yellow-200 border border-yellow-800',
  it: 'bg-green-900/60 text-green-300 border border-green-800',
};

/**
 * LLMStreamEntry — real-time Ollama token streaming display.
 * aria-live="off" prevents screen reader spam during token stream.
 * Cursor ▌ indicates active generation.
 */
export default function LLMStreamEntry({ persona, tokenBuffer }: LLMStreamEntryProps): React.ReactElement {
  const accentClass = LANG_BORDER[persona.language] ?? 'border-gray-600 bg-gray-800/30';
  const badgeClass = LANG_BADGE[persona.language] ?? 'bg-gray-800 text-gray-400 border border-gray-700';
  const firstName = persona.name.split(' ')[0];

  return (
    <div
      className={`border-l-2 ${accentClass} rounded-r-lg mx-3 px-4 py-3 mb-2`}
      aria-live="off"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-gray-500 text-xs font-mono">{firstName.toUpperCase()}</span>
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${badgeClass}`}>
          {persona.language.toUpperCase()}
        </span>
        <span className="text-amber-500 text-xs font-mono ml-2 uppercase tracking-widest">Generating</span>
      </div>
      <p className="text-gray-300 text-sm leading-relaxed">
        {tokenBuffer}
        <span className="text-indigo-400 animate-pulse ml-0.5" aria-hidden="true">▌</span>
      </p>
    </div>
  );
}
