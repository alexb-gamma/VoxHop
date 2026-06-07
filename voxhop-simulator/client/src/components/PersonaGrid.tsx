import React from 'react';
import { Persona } from '../types/persona';
import PersonaCard from './PersonaCard';
import SkeletonCard from './SkeletonCard';

interface PersonaGridProps {
  personas: Persona[];
  loading: boolean;
}

/**
 * PersonaGrid — 3-column grid; shows 5 SkeletonCards while loading, real cards after.
 * §6.6: grid grid-cols-3 gap-6
 */
export default function PersonaGrid({ personas, loading }: PersonaGridProps): React.ReactElement {
  return (
    <div className="grid grid-cols-3 gap-6">
      {loading
        ? Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)
        : personas.map((persona) => <PersonaCard key={persona.id} persona={persona} />)}
    </div>
  );
}
