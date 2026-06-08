import React from 'react';
import { Persona, CallStatus } from '../types/persona';
import PersonaCardSelectable from './PersonaCardSelectable';
import SkeletonCard from './SkeletonCard';

interface PersonaGridProps {
  personas: Persona[];
  loading: boolean;
  mode?: 'grid' | 'sidebar';
  selectedPersonaId?: string | null;
  callStatus?: CallStatus;
  onSelectPersona?: (id: string) => void;
}

/**
 * PersonaGrid — 3-column grid in 'grid' mode; single selected card in 'sidebar' mode.
 * §6.6: grid grid-cols-3 gap-6
 *
 * Phase 1 behaviour preserved: loading shows 5 SkeletonCards.
 * Phase 2: mode='grid' renders PersonaCardSelectable; mode='sidebar' shows active persona.
 */
export default function PersonaGrid({
  personas,
  loading,
  mode = 'grid',
  selectedPersonaId = null,
  callStatus = 'idle',
  onSelectPersona = () => {},
}: PersonaGridProps): React.ReactElement {
  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-6">
        {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  if (mode === 'sidebar') {
    // During a call: show only the selected persona (locked/active)
    const activePersona = personas.find((p) => p.id === selectedPersonaId);
    if (!activePersona) return <></>;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-gray-500 text-xs font-mono uppercase tracking-widest">Active Call</p>
        <PersonaCardSelectable
          persona={activePersona}
          isSelected={true}
          isLocked={true}
          compact={false}
          onClick={() => {}}
        />
      </div>
    );
  }

  // Grid mode
  return (
    <div className="grid grid-cols-3 gap-6">
      {personas.map((persona) => (
        <PersonaCardSelectable
          key={persona.id}
          persona={persona}
          isSelected={selectedPersonaId === persona.id}
          isLocked={callStatus !== 'idle'}
          compact={false}
          onClick={() => onSelectPersona(persona.id)}
        />
      ))}
    </div>
  );
}
