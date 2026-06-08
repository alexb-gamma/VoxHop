# VoxHop DELIVERY SCHEDULE

## Summary Table

| Feature | Engineering Status | Verification Status | Notes |
| :--- | :--- | :--- | :--- |
| **Track 1 — Foundation + Pipeline Demo** | `DONE` | `SPONSOR CLOSED 2026-06-06` | See [`DELIVERY_SCHEDULE_ARCHIVE.md`](DELIVERY_SCHEDULE_ARCHIVE.md) |
| **Track 2 Phase 1 — Infrastructure** | `DONE` | `SPONSOR CLOSED 2026-06-07` | Live at `https://simulator.voxhop.borshik.net` · LE cert · 5 personas · AudioWorklet ✅ |
| **Track 2 Phase 2 — AI Counterparty + Direct Mode** | `IMPLEMENTATION COMPLETE` | `AWAITING SPONSOR VERIFICATION` | NOW — Sponsor approved 2026-06-07 · Test gate PASSED 2026-06-07 |
| **Track 2 Phase 3 — Translation + Replace Mode** | `NOT STARTED` | `—` | Awaiting Phase 2 DONE |

---

## Track 2 Phase 1 — Infrastructure — *SPONSOR CLOSED 2026-06-07*

> **Status**: `DONE — SPONSOR VERIFIED 2026-06-07`
> **Feature Spec**: [`MASTERPLAN/FEATURES/TRACK2_PHASE1_INFRASTRUCTURE.md`](FEATURES/TRACK2_PHASE1_INFRASTRUCTURE.md)
> **Dependency**: Track 1 DONE ✅
> **Co-Signs**: Chief Architect (INITIATE) ✅ → UI/UX ✅ → Engineering ✅ → Integration Test ✅ → Chief Architect (REVIEW) ✅ → **Sponsor ✅ APPROVED 2026-06-07**

### Acceptance Verification (all PASS — 2026-06-07)

| Check | Result |
| :--- | :--- |
| ACC-01 HTTPS valid padlock | ✅ PASS — Let's Encrypt YE2, expires 2026-09-05 |
| ACC-02 `GET /personas` → 5 items | ✅ PASS — de-klaus, en-james, es-carlos, fr-camille, it-marco |
| ACC-03 `GET /health` → 200 | ✅ PASS — `{"status":"ok"}` from public internet |
| ACC-04 Mic permission grant | ✅ PASS — Sponsor browser confirmed |
| ACC-05 AudioWorklet Ready | ✅ PASS — Sponsor browser confirmed |
| ACC-06 COOP/COEP headers | ✅ PASS — `same-origin` + `require-corp` (public internet) |
| ACC-07 WS handshake | ✅ PASS — `HTTP 101 Switching Protocols` + `{"type":"ack"}` |
| Track 1 regression gate | ✅ PASS — 55/55 Vitest, zero diffs in Track 1 code |

### Tickets (all DONE)

| Ticket | File(s) | Status | Description |
| :--- | :--- | :--- | :--- |
| **P1-01** | `voxhop/infra/main.tf`, `outputs.tf` | `✅ DONE` | Terraform: Route 53 zone + A record + IAM policy |
| **P1-02** | `voxhop/infra/packer/voxhop-ami.pkr.hcl`, `issue-cert.sh` | `✅ DONE` | AMI rebuild: 4 EU Piper voice packs + certbot |
| **P1-03** | `voxhop/piper-http/main.py` | `✅ DONE` | Piper LRU pool, multi-voice, concurrent-safe |
| **P1-04** | `voxhop/docker-compose.yml`, `voxhop/Makefile` | `✅ DONE` | 7-service compose stack + Makefile targets |
| **P1-05** | `voxhop-simulator/` | `✅ DONE` | NestJS scaffold: COOP/COEP, LE cert, persona loader, WS gateway |
| **P1-06** | `voxhop-simulator/client/` | `✅ DONE` | React/Vite/Tailwind SPA + AudioWorklet |
| **P1-07** | `counterparties/*.json` | `✅ DONE` | 5 EU persona JSONs |
| **P1-08** | `voxhop-simulator/test/smoke.test.ts` | `✅ DONE` | Smoke tests + ACC checks |

---

## Track 2 Phase 2 — AI Counterparty + Direct Mode — *Entered NOW 2026-06-07*

> **Status**: `IMPLEMENTATION COMPLETE — AWAITING SPONSOR VERIFICATION`
> **Feature Spec**: [`MASTERPLAN/FEATURES/TRACK2_PHASE2_COUNTERPARTY.md`](FEATURES/TRACK2_PHASE2_COUNTERPARTY.md)
> **Dependency**: Track 2 Phase 1 DONE ✅
> **Co-Signs**: Chief Architect (INITIATE) ✅ · UI/UX ✅ · Engineering ✅ · Integration Test ✅ · Chief Architect (REVIEW) ✅ · **Sponsor ✅ APPROVED 2026-06-07**
> **Complexity**: 8/10
> **Key risks**: NDJSON line-buffer split · `processingTurn` lock sync-before-await · `InboundAudioTranscoder` per-session (never singleton) · SSH key `trap` cleanup (KI-002) · Ollama `/api/chat` schema (`chunk.message.content`, not `chunk.response`)

### Automated Test Gate — PASSED ✅ (2026-06-07)

| Package | TypeScript | Tests | Result |
| :--- | :--- | :--- | :--- |
| `voxhop-counterparty` | 0 errors | 32/32 passed | ✅ CLEAR |
| `voxhop-simulator` | 0 errors | 29 passed · 16 skipped · 0 failed | ✅ CLEAR |

### Tickets

#### Group A — Infrastructure (execute first; gates all app builds)

| Ticket | File(s) | Status | Description |
| :--- | :--- | :--- | :--- |
| **P2-T01** | `voxhop/infra/main.tf` [MODIFY] · `voxhop/infra/outputs.tf` [MODIFY] | `✅ DONE` | Add 3 ECR repos (`voxhop-app`, `voxhop-simulator`, `voxhop-counterparty`), EC2 IAM ECR pull policy statement, and 6 new Terraform outputs (ECR URLs, instance ID, EIP, AZ) |
| **P2-T02** | `voxhop/docker-compose.yml` [MODIFY] · `voxhop/Makefile` [MODIFY] | `✅ DONE` | Replace `voxhop-counterparty` stub service definition with Phase 2 ECR image + env + healthcheck; add `COUNTERPARTY_URL` env + `depends_on` to `voxhop-simulator`; switch `voxhop` and `voxhop-simulator` images to ECR; add `make deploy-app` target with `trap` SSH key cleanup (KI-002) |

#### Group B — Counterparty TypeScript Service (built from scratch; sequential within group)

| Ticket | File(s) | Status | Description |
| :--- | :--- | :--- | :--- |
| **P2-T03** | `voxhop-counterparty/package.json` [NEW] · `voxhop-counterparty/tsconfig.json` [NEW] · `voxhop-counterparty/Dockerfile` [NEW] | `✅ DONE` | Delete `index.js` stub. Scaffold Phase 2 package: deps (`avr-vad`, `ws`, `zod`, `pino`, `form-data`), no `ioredis`/NestJS; CommonJS tsconfig mirroring Track 1; multi-stage Dockerfile |
| **P2-T04** | `voxhop-counterparty/src/config.ts` [NEW] · `voxhop-counterparty/src/schemas.ts` [NEW] | `✅ DONE` | `validateConfig()` with Zod env schema (PORT, WHISPER/OLLAMA/PIPER URLs + timeouts, VAD params); all wire-protocol Zod schemas local to Counterparty (`PersonaSchema`, `CallInitiatedSchema`, `MediaStartedSchema`, `AudioEventSchema`, `OllamaStreamChunkSchema` using `/api/chat` shape) |
| **P2-T05** | `voxhop-counterparty/src/audio-utils.ts` [NEW] · `voxhop-counterparty/src/silero-vad.ts` [NEW] | `✅ DONE` | Copy `buildWav()` + `downsampleTo16k()` from `voxhop/src/audio-utils.ts`; copy `SileroVAD` class verbatim from `voxhop/src/silero-vad.ts` — no imports from `voxhop/` permitted |
| **P2-T06** | `voxhop-counterparty/src/pipeline.ts` [NEW] | `✅ DONE` | `callWhisper()`, `callOllamaStream()` (NDJSON `lineBuffer` accumulator, `TextDecoder { stream: true }`, `/api/chat` endpoint, token yield via async generator), `callPiper()`; `StagedError` with `stage` + `message`; `AbortSignal` per stage with correct timeout values |
| **P2-T07** | `voxhop-counterparty/src/call-handler.ts` [NEW] | `✅ DONE` | `CallHandler` class: `handleCallInitiated()`, `handleMediaStarted()` (VAD init + `injectOpener()`), `handleAudioFrame()` (VAD feed + `processingTurn` guard set **synchronously** before `void this.runTurn()`), `runTurn()` (full pipeline with `finally` lock release), `cleanup()`; 50-turn FIFO conversation history (100-entry cap); `/events` WS emit helpers |
| **P2-T08** | `voxhop-counterparty/src/server.ts` [NEW] · `voxhop-counterparty/src/index.ts` [NEW] | `✅ DONE` | `node:http` server + two `WebSocketServer({ noServer: true })` instances; upgrade router dispatching `/gamma/audio` → audio WSS, `/events?callId=` → events WSS (callId validation + `socket.destroy()` on mismatch), all other paths → `socket.destroy()`; `GET /health` → `{"status":"ok"}`; startup sequence: `validateConfig → new SileroVAD → ensureLoaded → destroy → server.listen` |
| **P2-T09** | `voxhop-counterparty/test/config.test.ts` [NEW] · `voxhop-counterparty/test/schemas.test.ts` [NEW] · `voxhop-counterparty/test/audio-utils.test.ts` [NEW] · `voxhop-counterparty/test/pipeline.test.ts` [NEW] · `voxhop-counterparty/test/call-handler.test.ts` [NEW] | `✅ DONE` | Full unit test suite per §4.7: config defaults + validation; schema accept/reject cases incl. `OllamaStreamChunkSchema` `/api/chat` shape + `z.literal('caller')` enforcement; audio-utils edge cases; pipeline mock-fetch tests incl. NDJSON split across chunk boundary; call-handler `processingTurn` lock, history cap, cleanup |

#### Group C — NestJS Simulator Extensions (depends on P2-T03 package.json for type reference)

| Ticket | File(s) | Status | Description |
| :--- | :--- | :--- | :--- |
| **P2-T10** | `voxhop-simulator/src/simulator/audio-transcoder.ts` [NEW] · `voxhop-simulator/src/simulator/call-session.service.ts` [NEW] | `✅ DONE` | `InboundAudioTranscoder` plain class (NOT `@Injectable()`) with stateful `sampleAccumulator` per session; `processInbound()` (Float32 48kHz → S16LE 16kHz, 3:1 decimation) + `static upsampleToFloat32()` (S16LE 16kHz → Float32 48kHz, 1:3 linear interpolation); `CallSessionService` `@Injectable()` with `Map<WebSocket, CallSession>`, `create()`, `get()`, `teardown()` |
| **P2-T11** | `voxhop-simulator/src/simulator/simulator.gateway.ts` [MODIFY] | `✅ DONE` | Full Phase 2 rewrite: inject `PersonaLoader` + `CallSessionService`; `handleConnection` → send `ack`; binary message → inbound audio relay via `InboundAudioTranscoder`; `dial` JSON → `handleDial()` (load persona, open `/gamma/audio` WS client, send protocol sequence with delays, open `/events?callId=` WS client, set 10s connecting timeout); `hangup` JSON → `handleHangup()` (send `call_ended`, close both counterparty WS); outbound audio relay (base64 S16LE → Float32 48kHz → browser binary); metadata relay (counterparty `/events` → browser JSON with `source: "counterparty"`) |
| **P2-T12** | `voxhop-simulator/test/smoke.test.ts` [MODIFY] | `✅ DONE` | Remove `M-05` stub tests; add `CP-02` boundary test (deps present, no `ioredis`); add `.skip` deployment checklist block for CP-01, CP-03, CP-04, CP-05; retain all MN-06 and Phase 1 tests unchanged |

#### Group D — Frontend (depends on Group C for WS message contract)

| Ticket | File(s) | Status | Description |
| :--- | :--- | :--- | :--- |
| **P2-T13** | `voxhop-simulator/client/src/types/persona.ts` [MODIFY] · `voxhop-simulator/client/src/state/appReducer.ts` [MODIFY] | `✅ DONE` | Append `CallStatus`, `TranscriptEntry`, `TelemetryRow` types; extend `AppState` with 7 Phase 2 fields; extend `AppAction` union with 11 new action types; extend `initialState`; add all reducer rules per §4.4 incl. idle/ended guards and `DISMISS_CALL_RESULT` reset |
| **P2-T14** | `voxhop-simulator/client/src/App.tsx` [MODIFY] · `voxhop-simulator/client/src/components/PersonaGrid.tsx` [MODIFY] | `✅ DONE` | Add 5 new refs (`hangUpRef`, `savedFocusRef`, `connectingTimeoutRef`, `nextPlayTimeRef`, `wsRef`); add Hang Up auto-focus `useEffect`; add `handleDial()`, `handleHangup()`, `handleDismiss()`; extend WS `message` handler for binary audio (schedule playback + idempotent `CALL_ACTIVE`) and JSON metadata routing; idle/call layout branch in JSX; extend `PersonaGrid` with `mode`, `selectedPersonaId`, `callStatus`, `onSelectPersona` props — render `PersonaCardSelectable` in both modes. `PersonaCard.tsx` — zero modifications |
| **P2-T15** | `voxhop-simulator/client/src/components/PersonaCardSelectable.tsx` [NEW] · `CallDialBar.tsx` [NEW] · `CallPanel.tsx` [NEW] · `CallPanelHeader.tsx` [NEW] · `CallStatusBadge.tsx` [NEW] · `TranscriptPanel.tsx` [NEW] · `TranscriptEntry.tsx` [NEW] · `ProcessingIndicator.tsx` [NEW] · `LLMStreamEntry.tsx` [NEW] · `TelemetryPanel.tsx` [NEW] · `CallErrorBanner.tsx` [NEW] | `✅ DONE` | All 11 new UI components per §6 wireframes and §6.4–§6.15 specs; WCAG 2.1 AA ARIA requirements; auto-scroll; threshold colour coding in TelemetryPanel; `role="alert"` on CallErrorBanner; `aria-live="off"` on LLMStreamEntry; focus management (`data-persona-id` attrs, `tabIndex={-1}` on locked cards) |

---

## Track 2 Phase 3 — Translation + Replace Mode (NEXT)

> **Status**: `AWAITING PHASE 2 DONE`
> **Feature Spec**: [`MASTERPLAN/FEATURES/TRACK2_PHASE3_TRANSLATION.md`](FEATURES/TRACK2_PHASE3_TRANSLATION.md)

*Tickets defined after Phase 3 spec is co-signed.*

---

> **Archived DONE items**: See [DELIVERY_SCHEDULE_ARCHIVE.md](DELIVERY_SCHEDULE_ARCHIVE.md)
