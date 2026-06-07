import React from 'react';

/**
 * SkeletonCard — animate-pulse placeholder for loading state.
 * §6.6: bg-gray-900 border border-gray-800 rounded-lg p-5 animate-pulse
 * §6.7: aria-busy="true" + aria-label="Loading persona"
 */
export default function SkeletonCard(): React.ReactElement {
  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-lg p-5 animate-pulse"
      aria-busy="true"
      aria-label="Loading persona"
    >
      {/* Name placeholder */}
      <div className="h-3.5 w-36 bg-gray-800 rounded" />
      {/* Language badge placeholder */}
      <div className="h-3.5 w-7 bg-gray-800 rounded mt-2" />
      {/* Excerpt placeholder lines */}
      <div className="h-3 w-full bg-gray-800 rounded mt-4" />
      <div className="h-3 w-2/3 bg-gray-800 rounded mt-2" />
    </div>
  );
}
