# FEATURE: Track 2 Phase 2 — AI Counterparty + Direct Mode

> **Track**: NEXT — awaiting Phase 1 DONE
> **Phase**: 2 of 3
> **Umbrella**: [`TRACK2_SIMULATOR.md`](TRACK2_SIMULATOR.md)

---

## 1. PROBLEM STATEMENT

Phase 1 delivers a provably working infrastructure skeleton: HTTPS endpoint, AudioWorklet, persona grid. But no call can be made and no AI responds. Phase 2 turns the infrastructure into a working tool.

**Problem 1 — No Counterparty pipeline.** The `voxhop-counterparty` service is a health-check stub after Phase 1. Engineering cannot validate VAD, Whisper STT, Ollama LLM, or Piper TTS in the Counterparty context without Phase 2.

**Problem 2 — No call flow.** The frontend has no Dial button. The Simulator Backend has no call session management. A developer cannot speak to an AI persona yet.

**Problem 3 — Direct Mode requires a new wire-protocol pattern.** In Direct Mode, the Simulator Backend acts as the caller-side of a `telco-ai-bridge` regular (non-replace) call — but the "callee" is the Counterparty, not `voxhop-app`. This exercises the telco-ai-bridge wire protocol in a new topology that must be defined, implemented, and validated before Phase 3 introduces Replace Mode.

---

## 2. VISION

At the end of Phase 2, a developer can:

1. Select an EU-language persona from the persona grid.
2. Click **Dial (Direct)**.
3. Speak English into the browser mic.
4. Hear the Counterparty's response (in the persona's language) through their speakers.
5. See a live transcript of the conversation in the browser.
6. Click **Hang Up** to end the call cleanly.

The Counterparty runs a full `avr-vad → Whisper → Ollama → Piper` pipeline. `voxhop-app` is **not involved** in Direct Mode. The Simulator Backend speaks to the Counterparty using the same telco-ai-bridge wire protocol used for a regular (non-replace) `telco-ai-bridge` call — this ensures the Counterparty is exercised with production-realistic framing before Replace Mode adds complexity in Phase 3.

---

## 3. CORE CAPABILITIES

### 3.1 Counterparty Pipeline (VAD → Whisper → Ollama → Piper)

- **Trigger**: Audio frames received from Simulator Backend via internal WebSocket.
- **Input**: LPCM16 audio frames from the developer's mic (routed by Simulator Backend).
- **Output**: LPCM16 audio frames of synthesised speech returned to Simulator Backend; transcript text for display.
- **Behaviour**: avr-vad ONNX pre-warmed on startup. VAD fires → buffer collected → POST to Whisper → text → POST to Ollama (persona system prompt + conversation history, 50-turn FIFO) → response text → POST to Piper (persona `piperVoice`) → LPCM audio returned. Per-stage timeout with `StagedError` logging on timeout/5xx. Conversation history held in memory; discarded on call termination.

### 3.2 Direct Mode Call Flow

- **Trigger**: Developer clicks **Dial (Direct)** in the browser.
- **Input**: Selected persona, browser mic stream.
- **Output**: Bidirectional audio conversation. Transcript entries in browser. Clean call termination on Hang Up or disconnect.
- **Behaviour**: The Simulator Backend opens a `telco-ai-bridge`-protocol WebSocket to the Counterparty (using the regular, non-replace mode call framing — not `mode:"replace"`). Audio from the browser mic is relayed to the Counterparty as binary frames. Counterparty's synthesised speech is streamed back and played through the browser AudioWorklet. Both sides of the conversation appear in the transcript panel.

### 3.3 Direct Mode Frontend

- **Trigger**: Phase 1 infrastructure confirmed working.
- **Input**: Persona selection, Dial click, mic audio.
- **Output**: Call state UI (Idle → Connecting → Active → Ended/Error), transcript panel, Hang Up button.
- **Behaviour**: `useReducer` state machine. Dial locks persona selection and mode toggle during active call. Hang Up sends termination signal; UI returns to Idle. Transcript entries appear as turns complete. ErrorBanner on unexpected disconnect.

---

## 4. TECHNICAL IMPLEMENTATION

*To be completed by the Engineering Team during co-sign.*

---

## 5. ACCEPTANCE CRITERIA

### 5.1 Functional (The Happy Path)

*To be defined jointly by Product Owner and Engineering during co-sign.*

### 5.2 Negative (The Unhappy Path)

*To be completed by Integration Test Team during co-sign.*

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
- Track 2 Phase 1 DONE

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
- Phase 1 services must remain healthy after Phase 2 deployment
- `voxhop-counterparty` stub (Phase 1) replaced by full implementation
- All Phase 1 smoke tests must continue to pass
