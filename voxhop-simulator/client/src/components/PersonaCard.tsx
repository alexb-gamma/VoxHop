import React from 'react';
import { Persona } from '../types/persona';

interface PersonaCardProps {
  persona: Persona;
}

/**
 * PersonaCard — displays a single persona (name, language badge, excerpt).
 * §6.6: bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-gray-700
 * §6.7: role="article"
 */
export default function PersonaCard({ persona }: PersonaCardProps): React.ReactElement {
  const badgeClasses: Record<string, string> = {
    en: 'bg-blue-900/60 text-blue-300 border border-blue-800',
    es: 'bg-red-900/60 text-red-300 border border-red-800',
    fr: 'bg-indigo-900/60 text-indigo-300 border border-indigo-800',
    de: 'bg-yellow-900/60 text-yellow-200 border border-yellow-800',
    it: 'bg-green-900/60 text-green-300 border border-green-800',
  };

  const badgeClass = badgeClasses[persona.language] ?? 'bg-gray-800 text-gray-400 border border-gray-700';
  const langUpper = persona.language.toUpperCase();

  return (
    <div
      role="article"
      className="bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-gray-700 hover:bg-gray-800/50 transition-colors duration-150"
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
