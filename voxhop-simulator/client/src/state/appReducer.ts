import { Persona } from '../types/persona';

/**
 * appReducer — exact §6.4 state machine implementation.
 *
 * States: initialising → loading → mic_prompt → worklet_init → ready (happy path)
 * Error branches: sab_error, network_error, mic_denied, worklet_error
 * Actions: SAB_OK, SAB_MISSING, PERSONAS_LOADED, PERSONAS_ERROR,
 *          MIC_GRANTED, MIC_DENIED, WORKLET_READY, WORKLET_ERROR
 *
 * Terminal states:
 *   - sab_error (hard — no outbound transitions)
 *   - network_error (hard — no outbound transitions)
 *   - mic_denied (soft — personas remain visible)
 *   - worklet_error (soft — personas remain visible)
 *
 * No external state library. No Zustand, no Redux, no Context API state (§6.1).
 */

export type PhaseStatus =
  | 'initialising'
  | 'sab_error'
  | 'loading'
  | 'network_error'
  | 'mic_prompt'
  | 'mic_denied'
  | 'worklet_init'
  | 'worklet_error'
  | 'ready';

export interface AppState {
  status: PhaseStatus;
  personas: Persona[];
  errorMessage: string | null;
  micGranted: boolean;
  workletReady: boolean;
}

export type AppAction =
  | { type: 'SAB_OK' }
  | { type: 'SAB_MISSING' }
  | { type: 'PERSONAS_LOADED'; payload: Persona[] }
  | { type: 'PERSONAS_ERROR'; payload: string }
  | { type: 'MIC_GRANTED' }
  | { type: 'MIC_DENIED'; payload: string }
  | { type: 'WORKLET_READY' }
  | { type: 'WORKLET_ERROR'; payload: string };

export const initialState: AppState = {
  status: 'initialising',
  personas: [],
  errorMessage: null,
  micGranted: false,
  workletReady: false,
};

/**
 * appReducer — transition table from §6.4:
 *
 * | From          | Action          | To            | errorMessage                                      |
 * |:--------------|:----------------|:--------------|:--------------------------------------------------|
 * | initialising  | SAB_OK          | loading       | —                                                 |
 * | initialising  | SAB_MISSING     | sab_error     | "SharedArrayBuffer unavailable..."                |
 * | loading       | PERSONAS_LOADED | mic_prompt    | —                                                 |
 * | loading       | PERSONAS_ERROR  | network_error | "Could not reach simulator service"               |
 * | mic_prompt    | MIC_GRANTED     | worklet_init  | —                                                 |
 * | mic_prompt    | MIC_DENIED      | mic_denied    | "Microphone access denied..."                     |
 * | worklet_init  | WORKLET_READY   | ready         | —                                                 |
 * | worklet_init  | WORKLET_ERROR   | worklet_error | "AudioWorklet failed to initialise"               |
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SAB_OK':
      if (state.status === 'initialising') {
        return { ...state, status: 'loading', errorMessage: null };
      }
      return state;

    case 'SAB_MISSING':
      if (state.status === 'initialising') {
        return {
          ...state,
          status: 'sab_error',
          errorMessage: 'SharedArrayBuffer unavailable — check COOP/COEP headers',
        };
      }
      return state;

    case 'PERSONAS_LOADED':
      if (state.status === 'loading') {
        return {
          ...state,
          status: 'mic_prompt',
          personas: action.payload,
          errorMessage: null,
        };
      }
      return state;

    case 'PERSONAS_ERROR':
      if (state.status === 'loading') {
        return {
          ...state,
          status: 'network_error',
          errorMessage: 'Could not reach simulator service',
        };
      }
      return state;

    case 'MIC_GRANTED':
      if (state.status === 'mic_prompt') {
        return { ...state, status: 'worklet_init', micGranted: true, errorMessage: null };
      }
      return state;

    case 'MIC_DENIED':
      if (state.status === 'mic_prompt') {
        return {
          ...state,
          status: 'mic_denied',
          errorMessage: 'Microphone access denied — call features unavailable',
        };
      }
      return state;

    case 'WORKLET_READY':
      if (state.status === 'worklet_init') {
        return { ...state, status: 'ready', workletReady: true, errorMessage: null };
      }
      return state;

    case 'WORKLET_ERROR':
      if (state.status === 'worklet_init') {
        return {
          ...state,
          status: 'worklet_error',
          errorMessage: 'AudioWorklet failed to initialise',
        };
      }
      return state;

    default:
      return state;
  }
}
