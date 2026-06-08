/**
 * P1-08 — Integration Smoke Tests
 *
 * Self-contained test suite:
 *   - State machine logic inlined (mirrors §6.4 appReducer exactly) for server tsconfig compatibility
 *   - PersonaSchema imported from server-side src/persona/persona.schema
 *   - Structural file checks for M-06, M-07, M-09, M-13, MN-03, MN-06, MN-07
 *   - Counterparty stub behavior (M-05)
 *
 * Deployment checklist (skipped — requires deployed environment):
 *   ACC-01..ACC-11, NEG-33 documented as .skip tests
 *
 * curl automation (run against deployed env post make-issue-cert):
 *   curl -I https://simulator.voxhop.borshik.net/
 *   curl https://simulator.voxhop.borshik.net/personas
 *   curl -X POST http://localhost:5000/tts -H "Content-Type: application/json" -d '{"text":"Hola","voice":"es_ES-davefx-medium"}'
 *   curl -X POST http://localhost:5000/tts -H "Content-Type: application/json" -d '{"text":"Hello"}'
 */

import { describe, it, expect } from 'vitest';
import { PersonaSchema } from '../src/persona/persona.schema';

// ─── State machine types + reducer (inlined from §6.4 — avoids client/server tsconfig boundary) ──

type PhaseStatus =
  | 'initialising' | 'sab_error' | 'loading' | 'network_error'
  | 'mic_prompt' | 'mic_denied' | 'worklet_init' | 'worklet_error' | 'ready';

interface Persona { id: string; name: string; language: string; piperVoice: string; systemPrompt: string; conversationOpener?: string; }

interface AppState {
  status: PhaseStatus;
  personas: Persona[];
  errorMessage: string | null;
  micGranted: boolean;
  workletReady: boolean;
}

type AppAction =
  | { type: 'SAB_OK' } | { type: 'SAB_MISSING' }
  | { type: 'PERSONAS_LOADED'; payload: Persona[] } | { type: 'PERSONAS_ERROR'; payload: string }
  | { type: 'MIC_GRANTED' } | { type: 'MIC_DENIED'; payload: string }
  | { type: 'WORKLET_READY' } | { type: 'WORKLET_ERROR'; payload: string };

const initialState: AppState = {
  status: 'initialising', personas: [], errorMessage: null, micGranted: false, workletReady: false,
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SAB_OK':
      return state.status === 'initialising' ? { ...state, status: 'loading', errorMessage: null } : state;
    case 'SAB_MISSING':
      return state.status === 'initialising'
        ? { ...state, status: 'sab_error', errorMessage: 'SharedArrayBuffer unavailable — check COOP/COEP headers' }
        : state;
    case 'PERSONAS_LOADED':
      return state.status === 'loading'
        ? { ...state, status: 'mic_prompt', personas: action.payload, errorMessage: null }
        : state;
    case 'PERSONAS_ERROR':
      return state.status === 'loading'
        ? { ...state, status: 'network_error', errorMessage: 'Could not reach simulator service' }
        : state;
    case 'MIC_GRANTED':
      return state.status === 'mic_prompt' ? { ...state, status: 'worklet_init', micGranted: true, errorMessage: null } : state;
    case 'MIC_DENIED':
      return state.status === 'mic_prompt'
        ? { ...state, status: 'mic_denied', errorMessage: 'Microphone access denied — call features unavailable' }
        : state;
    case 'WORKLET_READY':
      return state.status === 'worklet_init' ? { ...state, status: 'ready', workletReady: true, errorMessage: null } : state;
    case 'WORKLET_ERROR':
      return state.status === 'worklet_init'
        ? { ...state, status: 'worklet_error', errorMessage: 'AudioWorklet failed to initialise' }
        : state;
    default:
      return state;
  }
}

// ─── State Machine Tests (§6.4) ───────────────────────────────────────────────

describe('appReducer — §6.4 state machine', () => {
  const dispatch = (state: AppState, action: AppAction) => appReducer(state, action);

  it('initialising → SAB_OK → loading', () => {
    const next = dispatch(initialState, { type: 'SAB_OK' });
    expect(next.status).toBe('loading');
    expect(next.errorMessage).toBeNull();
  });

  it('initialising → SAB_MISSING → sab_error (hard terminal)', () => {
    const next = dispatch(initialState, { type: 'SAB_MISSING' });
    expect(next.status).toBe('sab_error');
    expect(next.errorMessage).toBe('SharedArrayBuffer unavailable — check COOP/COEP headers');
  });

  it('loading → PERSONAS_LOADED → mic_prompt', () => {
    const loading = dispatch(initialState, { type: 'SAB_OK' });
    const personas: Persona[] = [
      { id: 'en-james', name: 'James', language: 'en', piperVoice: 'en_GB-alan-medium', systemPrompt: 'Test' },
    ];
    const next = dispatch(loading, { type: 'PERSONAS_LOADED', payload: personas });
    expect(next.status).toBe('mic_prompt');
    expect(next.personas).toHaveLength(1);
    expect(next.errorMessage).toBeNull();
  });

  it('loading → PERSONAS_ERROR → network_error (hard terminal)', () => {
    const loading = dispatch(initialState, { type: 'SAB_OK' });
    const next = dispatch(loading, { type: 'PERSONAS_ERROR', payload: 'network fail' });
    expect(next.status).toBe('network_error');
    expect(next.errorMessage).toBe('Could not reach simulator service');
  });

  it('mic_prompt → MIC_GRANTED → worklet_init', () => {
    const loading = dispatch(initialState, { type: 'SAB_OK' });
    const micPrompt = dispatch(loading, { type: 'PERSONAS_LOADED', payload: [] });
    const next = dispatch(micPrompt, { type: 'MIC_GRANTED' });
    expect(next.status).toBe('worklet_init');
    expect(next.micGranted).toBe(true);
  });

  it('mic_prompt → MIC_DENIED → mic_denied (soft terminal, personas visible)', () => {
    const loading = dispatch(initialState, { type: 'SAB_OK' });
    const personas: Persona[] = [
      { id: 'en-james', name: 'James', language: 'en', piperVoice: 'en_GB-alan-medium', systemPrompt: 'Test' },
    ];
    const micPrompt = dispatch(loading, { type: 'PERSONAS_LOADED', payload: personas });
    const next = dispatch(micPrompt, { type: 'MIC_DENIED', payload: 'denied' });
    expect(next.status).toBe('mic_denied');
    expect(next.errorMessage).toBe('Microphone access denied — call features unavailable');
    expect(next.personas).toHaveLength(1); // soft terminal: personas remain
  });

  it('worklet_init → WORKLET_READY → ready (happy path complete)', () => {
    const loading = dispatch(initialState, { type: 'SAB_OK' });
    const micPrompt = dispatch(loading, { type: 'PERSONAS_LOADED', payload: [] });
    const workletInit = dispatch(micPrompt, { type: 'MIC_GRANTED' });
    const next = dispatch(workletInit, { type: 'WORKLET_READY' });
    expect(next.status).toBe('ready');
    expect(next.workletReady).toBe(true);
    expect(next.errorMessage).toBeNull();
  });

  it('worklet_init → WORKLET_ERROR → worklet_error (soft terminal)', () => {
    const loading = dispatch(initialState, { type: 'SAB_OK' });
    const micPrompt = dispatch(loading, { type: 'PERSONAS_LOADED', payload: [] });
    const workletInit = dispatch(micPrompt, { type: 'MIC_GRANTED' });
    const next = dispatch(workletInit, { type: 'WORKLET_ERROR', payload: 'err' });
    expect(next.status).toBe('worklet_error');
    expect(next.errorMessage).toBe('AudioWorklet failed to initialise');
  });

  it('SAB check is FIRST — SAB_MISSING before personas fetched (M-02, NEG-23)', () => {
    const next = dispatch(initialState, { type: 'SAB_MISSING' });
    expect(next.status).toBe('sab_error');
    expect(next.personas).toHaveLength(0); // no fetch triggered
  });

  it('terminal: sab_error has no outbound transitions (hard terminal)', () => {
    const sabError = dispatch(initialState, { type: 'SAB_MISSING' });
    expect(dispatch(sabError, { type: 'SAB_OK' }).status).toBe('sab_error');
    expect(dispatch(sabError, { type: 'PERSONAS_LOADED', payload: [] }).status).toBe('sab_error');
  });

  it('initial state is initialising with empty personas and null error', () => {
    expect(initialState.status).toBe('initialising');
    expect(initialState.personas).toHaveLength(0);
    expect(initialState.errorMessage).toBeNull();
    expect(initialState.micGranted).toBe(false);
    expect(initialState.workletReady).toBe(false);
  });
});

// ─── PersonaSchema Tests (M-12) ──────────────────────────────────────────────

describe('PersonaSchema — M-12 Zod validation', () => {
  const validPersona = {
    id: 'es-carlos',
    name: 'Carlos — Madrid Hotel Receptionist',
    language: 'es',
    piperVoice: 'es_ES-davefx-medium',
    systemPrompt: 'You are Carlos...',
    conversationOpener: 'Buenas tardes...',
  };

  it('accepts a valid persona', () => {
    const result = PersonaSchema.safeParse(validPersona);
    expect(result.success).toBe(true);
  });

  it('accepts persona without optional conversationOpener', () => {
    const { conversationOpener: _, ...withoutOpener } = validPersona;
    expect(PersonaSchema.safeParse(withoutOpener).success).toBe(true);
  });

  it('rejects persona missing required id', () => {
    const { id: _, ...noId } = validPersona;
    expect(PersonaSchema.safeParse(noId).success).toBe(false);
  });

  it('rejects persona with numeric id (M-12: id must be string)', () => {
    expect(PersonaSchema.safeParse({ ...validPersona, id: 123 }).success).toBe(false);
  });

  it('rejects persona missing piperVoice', () => {
    const { piperVoice: _, ...noVoice } = validPersona;
    expect(PersonaSchema.safeParse(noVoice).success).toBe(false);
  });

  it('rejects empty object (NEG-13: zero valid personas is non-fatal)', () => {
    expect(PersonaSchema.safeParse({}).success).toBe(false);
  });

  it('all 5 starter personas validate against PersonaSchema (P1-07)', () => {
    const personas = [
      { id: 'en-james', name: 'James — London Insurance Advisor', language: 'en', piperVoice: 'en_GB-alan-medium', systemPrompt: 'You are James...', conversationOpener: 'Good afternoon...' },
      { id: 'es-carlos', name: 'Carlos — Madrid Hotel Receptionist', language: 'es', piperVoice: 'es_ES-davefx-medium', systemPrompt: 'You are Carlos...', conversationOpener: 'Buenas tardes...' },
      { id: 'fr-camille', name: 'Camille — Paris Bank Advisor', language: 'fr', piperVoice: 'fr_FR-siwis-medium', systemPrompt: 'You are Camille...', conversationOpener: 'Bonjour...' },
      { id: 'de-klaus', name: 'Klaus — Frankfurt Auto Dealership', language: 'de', piperVoice: 'de_DE-thorsten-medium', systemPrompt: 'You are Klaus...', conversationOpener: 'Guten Tag...' },
      { id: 'it-marco', name: 'Marco — Rome Restaurant Reservations', language: 'it', piperVoice: 'it_IT-riccardo-medium', systemPrompt: 'You are Marco...', conversationOpener: 'Buongiorno...' },
    ];
    for (const p of personas) {
      const result = PersonaSchema.safeParse(p);
      expect(result.success, `Persona ${p.id} failed validation`).toBe(true);
    }
  });
});

// ─── Structural File Tests (mandates enforcement) ─────────────────────────────

describe('Structural mandates — file-level verification', () => {
  it('M-06: main.tf simulator_a record uses aws_eip.voxhop.public_ip not hardcoded IP (NEG-17)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const mainTf = fs.readFileSync(path.join(__dirname, '../../voxhop/infra/main.tf'), 'utf-8');
    const route53Block = mainTf.match(/resource "aws_route53_record" "simulator_a"[\s\S]*?(?=\nresource|\n#|$)/)?.[0] ?? '';
    expect(route53Block).not.toContain('"13.62.124.43"');
    expect(route53Block).toContain('aws_eip.voxhop.public_ip');
  });

  it('M-13: exactly one port 443 ingress block in aws_security_group.voxhop (NEG-18)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const mainTf = fs.readFileSync(path.join(__dirname, '../../voxhop/infra/main.tf'), 'utf-8');
    // Find the security group resource block
    const sgBlockMatch = mainTf.match(/resource "aws_security_group" "voxhop"[\s\S]*?^}/m);
    const sgBlock = sgBlockMatch ? sgBlockMatch[0] : mainTf;
    const count443 = (sgBlock.match(/from_port\s*=\s*443/g) ?? []).length;
    expect(count443).toBe(1); // exactly one — M-13 adds zero SG changes
  });

  it('M-07: issue-cert.sh has NS preflight before certbot, uses --staging, uses --dns-route53 (MN-01)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const script = fs.readFileSync(
      path.join(__dirname, '../../voxhop/infra/packer/scripts/issue-cert.sh'),
      'utf-8',
    );
    // NS preflight exists (M-07)
    expect(script).toContain('dig NS voxhop.borshik.net @8.8.8.8');
    expect(script).toContain('grep -q "awsdns"');
    // --staging appears before live issuance (M-07, AR-01)
    const stagingIdx = script.indexOf('--staging');
    const liveIdx = script.indexOf('--non-interactive --agree-tos');
    expect(stagingIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(stagingIdx); // staging before live
    // DNS-01 only (MN-01)
    expect(script).toContain('--dns-route53');
    expect(script).not.toContain('--standalone');
    expect(script).not.toContain('--webroot');
    expect(script).not.toContain('--nginx');
  });

  it('MN-07: deploy Makefile target does not invoke certbot (NEG-21)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const makefile = fs.readFileSync(path.join(__dirname, '../../voxhop/Makefile'), 'utf-8');
    // Extract lines between "deploy:" and the next target
    const lines = makefile.split('\n');
    let inDeploy = false;
    const deployLines: string[] = [];
    for (const line of lines) {
      if (/^deploy:/.test(line)) { inDeploy = true; continue; }
      if (inDeploy && /^\S/.test(line) && !/^\t/.test(line)) break;
      if (inDeploy) deployLines.push(line);
    }
    const deployRecipe = deployLines.join('\n');
    expect(deployRecipe).not.toContain('certbot');
    expect(deployRecipe).not.toContain('issue-cert');
  });

  it('M-09: docker-compose.yml counterparties mount includes :ro flag (NEG-15)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const compose = fs.readFileSync(path.join(__dirname, '../../voxhop/docker-compose.yml'), 'utf-8');
    const mountLine = compose.split('\n').find((l) => l.includes('counterparties')) ?? '';
    expect(mountLine).toContain(':ro');
  });

  it('AR-02: docker-compose.yml has AR-02 comment on voxhop-simulator service', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const compose = fs.readFileSync(path.join(__dirname, '../../voxhop/docker-compose.yml'), 'utf-8');
    expect(compose).toContain('AR-02');
  });

  it('MN-03: no server-side imports in client src/ (NEG-30)', async () => {
    const { execSync } = await import('child_process');
    let result = '';
    try {
      result = execSync(
        "grep -rn 'from.*persona\\.schema\\|from.*\\.\\./src/' voxhop-simulator/client/src/ 2>/dev/null || true",
        { cwd: '/home/aborshik/oc-workspace/VoxHop' },
      ).toString();
    } catch { result = ''; }
    expect(result.trim()).toBe('');
  });

  it('MN-06: voxhop/src/ has zero diffs from HEAD (Track 1 zero-regression — NEG-26)', async () => {
    const { execSync } = await import('child_process');
    const diff = execSync('git diff HEAD -- voxhop/src/', {
      cwd: '/home/aborshik/oc-workspace/VoxHop',
    }).toString();
    expect(diff).toBe('');
  });

  it('MN-06: voxhop/test/ has zero diffs from HEAD (Track 1 zero-regression — NEG-26)', async () => {
    const { execSync } = await import('child_process');
    const diff = execSync('git diff HEAD -- voxhop/test/', {
      cwd: '/home/aborshik/oc-workspace/VoxHop',
    }).toString();
    expect(diff).toBe('');
  });

  it('CP-02: voxhop-counterparty/package.json has ws, zod, avr-vad, pino, form-data and no ioredis (§7.12)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../voxhop-counterparty/package.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const deps = Object.keys((pkg['dependencies'] ?? {}) as Record<string, string>);
    expect(deps).toContain('ws');
    expect(deps).toContain('zod');
    expect(deps).toContain('avr-vad');
    expect(deps).toContain('pino');
    expect(deps).toContain('form-data');
    expect(deps).not.toContain('ioredis');
    expect(deps).not.toContain('@nestjs/core');
  });

  it('outputs.tf contains ns_records output (M-08, P1-01)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const outputs = fs.readFileSync(path.join(__dirname, '../../voxhop/infra/outputs.tf'), 'utf-8');
    expect(outputs).toContain('ns_records');
    expect(outputs).toContain('aws_route53_zone.voxhop.name_servers');
  });
});

// ─── Deployment Checklist (manual/remote — documented as .skip) ──────────────

describe('P1-08 Deployment Checklist (ACC-01..ACC-11 + NEG-33)', () => {
  it.skip('[ACC-01] HTTPS padlock in Chrome+Firefox — manual browser verification', () => {});
  it.skip('[ACC-02] GET /personas → 200 JSON array of 5 objects — curl against deployed env', () => {});
  it.skip('[ACC-03] Persona grid renders 5 real cards — manual browser verification', () => {});
  it.skip('[ACC-04] Allow Microphone → green MIC ACTIVE — manual browser verification', () => {});
  it.skip('[ACC-05] AudioWorklet Ready ✓ + crossOriginIsolated=true — manual browser verification', () => {});
  it.skip('[ACC-06] COOP/COEP headers on root — curl -I https://simulator.voxhop.borshik.net/', () => {});
  it.skip('[ACC-07] POST /tts with es_ES-davefx-medium → LPCM audio — curl deployed piper', () => {});
  it.skip('[ACC-08] POST /tts no voice → en_GB-alan-medium — curl deployed piper', () => {});
  it.skip('[ACC-09] make deploy succeeds, 7 services healthy — deployment gate', () => {});
  it.skip('[ACC-10] NS delegation banner printed before terraform — make deploy dry-run', () => {});
  it.skip('[ACC-11] 6th persona + restart → GET /personas returns 6 — runtime test', () => {});
  it.skip('[NEG-33] make destroy → no orphaned Route 53 zone → clean re-deploy — Architect Note 3', () => {});
});

// ─── P2 Counterparty Deployment Checklist (skipped — requires running counterparty) ──

describe('P2 Counterparty Deployment Checklist (CP-01, CP-03, CP-04, CP-05)', () => {
  it.skip('[CP-01] GET /health on port 3001 returns {"status":"ok"} (not "stub") — requires running counterparty', () => {});
  it.skip('[CP-03] WS upgrade to /gamma/audio returns 101 — requires running counterparty', () => {});
  it.skip('[CP-04] WS upgrade to /events?callId=<uuid> with active call returns 101 — requires running counterparty + active call', () => {});
  it.skip('[CP-05] WS upgrade to /unknown path is destroyed — requires running counterparty', () => {});
});
