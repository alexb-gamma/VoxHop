# FEATURE: Track 2 Phase 3 — Translation + Replace Mode

> **Track**: NEXT — awaiting Phase 2 DONE
> **Phase**: 3 of 3
> **Umbrella**: [`TRACK2_SIMULATOR.md`](TRACK2_SIMULATOR.md)

---

## 1. PROBLEM STATEMENT

Phase 2 delivers Direct Mode: a developer can have a spoken conversation with an AI Counterparty without `voxhop-app` involvement. But the core VoxHop value proposition — real-time translation across two legs — cannot be developed or validated without a Replace Mode connection through `voxhop-app`.

**Problem 1 — Track 1 schema is not Replace-Mode-ready.** `voxhop-app` currently uses a scalar `txTrackId` in `media_started`. Replace Mode requires `txTracks[]` (an array with `target:"caller"` and `target:"called"` entries) so the Simulator Backend can route audio to the correct recipient on each leg. This migration is a prerequisite for Translation Mode.

**Problem 2 — No cross-routing in the Simulator Backend.** Translation Mode requires the Simulator Backend to maintain a `txTracksMap` (immutable after `media_started`) that routes `target:"caller"` frames to the browser and `target:"called"` frames to the Counterparty. This routing logic does not exist yet.

**Problem 3 — No Translation Mode frontend.** Phase 2's Direct Mode UI does not expose the dual-leg transcript, the Replace Mode call flow, or the protocol event timeline. Phase 3 adds the Translation Mode frontend that is the original Track 2 vision.

---

## 2. VISION

At the end of Phase 3, the original Track 2 feature is complete. A developer can:

1. Select an EU-language persona and click **Dial (Translation)**.
2. Speak English into the browser mic.
3. Hear the persona's language synthesised by Piper through the browser speakers — routed via `voxhop-app`'s Replace Mode pipeline (echo in Track 2; real translation in the Translation Layer feature).
4. See a dual-leg transcript (developer leg + counterparty leg) with source and translated text labels.
5. See a protocol event timeline showing `call_initiated (mode:replace)`, `call_ringing`, `call_answered`, `media_started`, and `clear` events as they occur.

Phase 3 also completes the Track 1 schema migration (`txTracks[]`), making `voxhop-app` production-ready for the Translation Layer feature that follows.

---

## 3. CORE CAPABILITIES

### 3.1 Track 1 Schema Migration (`txTracks[]`)

- **Trigger**: T3 Sprint 0 (first ticket, blocks all others).
- **Input**: `voxhop/src/schemas.ts`, `voxhop/src/call-handler.ts`, `voxhop/src/pipeline.ts`, `voxhop/test/` (17 fixture sites).
- **Output**: `media_started` frame uses `txTracks: [{ trackId, target:"caller" }, { trackId, target:"called" }]` instead of scalar `txTrackId`. `ClearCommandSchema`, `CallRingingSchema`, `CallAnsweredSchema` added. All 55 Track 1 tests remain green.
- **Behaviour**: Atomic — all 17 fixture sites updated in a single commit. No partial state. Zod schemas updated first; call-handler and pipeline follow. Post-Zod cardinality assert: exactly one `target:"caller"` and one `target:"called"`. Fatal WS close on violation. `sendClearCommand()` called before every `injectAudio()`. `ECHO_SYSTEM_PROMPT` preserved unchanged (echo mode for Track 2). Pre-event-switch `if ('command' in parsed)` guard for `clear` frames in both `call-handler.ts` and Simulator Backend.

### 3.2 Cross-Routing in Simulator Backend

- **Trigger**: `media_started` received from `voxhop-app` during a Replace Mode call.
- **Input**: `txTracks[]` array from `media_started`.
- **Output**: Immutable `txTracksMap` (`Map<trackId, 'browser'|'counterparty'>`).
- **Behaviour**: Built once from `txTracks[]` on `media_started`. Never rebuilt or mutated during call lifetime. `target:"caller"` frames → browser AudioWorklet. `target:"called"` frames → Counterparty receive buffer. `clear` frame detected pre-switch; flushes appropriate buffer; logged to browser protocol timeline.

### 3.3 Translation Mode Frontend

- **Trigger**: Developer selects Translation mode and clicks Dial.
- **Input**: Persona, mode toggle set to Translation.
- **Output**: Dual-leg transcript panel, protocol event timeline, call state UI (Idle → Connecting → Active → Ended/Error).
- **Behaviour**: Protocol timeline shows `call_initiated (mode:replace)`, `call_ringing`, `call_answered`, `media_started`, `clear` events. Transcript shows both legs with speaker labels and language tags. Conversation opener (if configured) plays within 3s of Active state, before developer speaks.

---

## 4. TECHNICAL IMPLEMENTATION

*To be completed by the Engineering Team during co-sign.*

---

## 5. ACCEPTANCE CRITERIA

### 5.1 Functional (The Happy Path)

*To be defined jointly by Product Owner and Engineering during co-sign. Directly inherits the intent of the original Track 2 ACC-01..ACC-15 criteria, adapted to Phase 3 scope.*

### 5.2 Negative (The Unhappy Path)

*To be completed by Integration Test Team during co-sign. Directly inherits the intent of NEG-01..NEG-25 from the original Track 2 spec, scoped to Replace Mode and cross-routing.*

---

## 6. UI/UX DESIGN

*To be completed by UI/UX Specialist during co-sign.*

---

## 7. ARCHITECTURAL GUIDANCE

*To be completed by Chief Architect during INITIATE co-sign.*

---

## 8. DELIVERY & STATUS

### Phase
`NEXT`

### Dependencies
- Track 2 Phase 2 DONE
- `voxhop-app` reachable on the GPU instance

### Co-Signs

| Agent | Status | Date |
|:------|:-------|:-----|
| Product Owner | ☐ PENDING | — |
| Chief Architect (INITIATE) | ☐ PENDING | — |
| UI/UX Specialist | ☐ PENDING | — |
| Engineering Team | ☐ PENDING | — |
| Integration Test | ☐ PENDING | — |
| Chief Architect (REVIEW) | ☐ PENDING | — |
| Sponsor Approval | ☐ PENDING | — |

### Regression Radius
- `voxhop/src/` — Track 1 schema migration; all 55 Track 1 tests must remain green (atomic T3 Sprint 0)
- Phase 1 and Phase 2 smoke tests must pass after Phase 3 deployment
- `voxhop-app` Replace Mode must not break existing regular-mode call handling
