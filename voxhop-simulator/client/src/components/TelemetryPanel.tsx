import React, { useState } from 'react';
import { TelemetryRow } from '../types/persona';

interface TelemetryPanelProps {
  telemetry: TelemetryRow[];
}

/**
 * TelemetryPanel — collapsible per-turn pipeline latency display.
 * Threshold colours: totalMs ≤ 2000 green, ≤ 3000 amber, > 3000 red.
 * Collapsed by default.
 */
export default function TelemetryPanel({ telemetry }: TelemetryPanelProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  const totalClass = (ms: number): string => {
    if (ms <= 2000) return 'text-green-400';
    if (ms <= 3000) return 'text-amber-400';
    return 'text-red-400';
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="telemetry-table-body"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left"
      >
        <span className="text-gray-400 text-xs font-mono uppercase tracking-widest">
          Pipeline Telemetry — {telemetry.length} turn(s)
        </span>
        <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div id="telemetry-table-body" className="border-t border-gray-800 overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-gray-600 border-b border-gray-800">
                <th className="px-4 py-2 text-left">#</th>
                <th className="px-4 py-2 text-right">STT</th>
                <th className="px-4 py-2 text-right">LLM</th>
                <th className="px-4 py-2 text-right">TTS</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {telemetry.map((row) => (
                <tr key={row.turnIndex} className="border-b border-gray-800/50">
                  <td className="px-4 py-2 text-gray-500">{row.turnIndex + 1}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{row.sttMs.toLocaleString()}ms</td>
                  <td className="px-4 py-2 text-right text-gray-300">{row.llmMs.toLocaleString()}ms</td>
                  <td className="px-4 py-2 text-right text-gray-300">{row.ttsMs.toLocaleString()}ms</td>
                  <td className={`px-4 py-2 text-right font-semibold ${totalClass(row.totalMs)}`}>
                    {(row.totalMs / 1000).toFixed(2)}s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
