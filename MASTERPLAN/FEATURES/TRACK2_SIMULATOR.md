# FEATURE: Track 2 — VoxHop Simulator + AI Counterparty (Umbrella)

> **Type**: Umbrella document — reference only. This spec was superseded on 2026-06-07 when the
> original monolithic Track 2 feature was split into three phases to manage implementation context budgets.
>
> The authoritative specs are the three phase specs below. This document explains how the phases
> fit together and why the split was made.

---

## Why Three Phases?

The original Track 2 spec (co-signed 2026-06-06, 18 tickets across 3 new repos) was determined to be too large for a single implementation pass without blowing Engineering context budgets. Each phase is a complete, independently shippable milestone with its own full co-sign sequence.

---

## Phase Breakdown

| Phase | Spec | Status | Delivers |
|:------|:-----|:-------|:---------|
| **Phase 1 — Infrastructure** | [`TRACK2_PHASE1_INFRASTRUCTURE.md`](TRACK2_PHASE1_INFRASTRUCTURE.md) | `NOW` | Live HTTPS endpoint · Piper multi-voice · NestJS scaffold · React/AudioWorklet scaffold · Docker Compose |
| **Phase 2 — AI Counterparty + Direct Mode** | [`TRACK2_PHASE2_COUNTERPARTY.md`](TRACK2_PHASE2_COUNTERPARTY.md) | `NEXT` | Full VAD→Whisper→Ollama→Piper pipeline · Direct Mode call flow using telco-ai-bridge regular-mode wire protocol |
| **Phase 3 — Translation + Replace Mode** | [`TRACK2_PHASE3_TRANSLATION.md`](TRACK2_PHASE3_TRANSLATION.md) | `NEXT` | Track 1 schema migration (`txTracks[]`) · Replace Mode · Cross-routing · Translation Mode frontend |

---

## System Architecture (spans all three phases)

```
┌─────────────────────────────────────────────────────────────────┐
│                     simulator.voxhop.borshik.net                │
│                                                                 │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │  React SPA (Vite + Tailwind + AudioWorklet)              │  │
│   │  Persona Grid | Transcript Panel | Protocol Timeline     │  │
│   └────────────────────────┬─────────────────────────────────┘  │
│                            │ WS /ws/simulator                   │
│   ┌────────────────────────▼─────────────────────────────────┐  │
│   │  NestJS voxhop-simulator                                 │  │
│   │  CallSessionService | PersonaLoader | BrowserWsGateway   │  │
│   └────────────┬──────────────────────────┬──────────────────┘  │
│                │                          │                     │
│    (Phase 2/3) │ telco-ai-bridge WS       │ (Phase 2) internal  │
│                │ /ws/calls                │ WS protocol         │
│   ┌────────────▼──────────┐  ┌───────────▼──────────────────┐  │
│   │  voxhop-app           │  │  voxhop-counterparty         │  │
│   │  (Track 1 — DONE)     │  │  VAD→Whisper→Ollama→Piper   │  │
│   └───────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Phase 1** establishes the left column (NestJS + React + infra). No call flow.

**Phase 2** wires `voxhop-counterparty` (right column) and Direct Mode — the Simulator Backend speaks to the Counterparty using the same telco-ai-bridge wire protocol as a regular (non-replace) call. `voxhop-app` is NOT involved in Direct Mode.

**Phase 3** wires `voxhop-app` (left column) into the full Replace Mode flow, migrates the Track 1 schema (`txTracks[]`), and adds the Translation Mode frontend.

---

## Cross-Phase Dependencies

```
Phase 1 DONE
    └── Phase 2 begins (Counterparty pipeline + Direct Mode)
            └── Phase 2 DONE
                    └── Phase 3 begins (Replace Mode + Translation Mode)
                            └── Phase 3 DONE
                                    └── Translation Layer (NEXT) begins
```

---

## Original Co-Sign Archive

The original monolithic spec was fully co-signed before the phase split decision. Those co-signs are
superseded but preserved here for reference. Each phase spec carries its own independent co-sign sequence.

| Agent | Original Status | Date |
|:------|:----------------|:-----|
| Product Owner | ✅ APPROVED | 2026-06-06 |
| Chief Architect (INITIATE) | ✅ COMPLETE | 2026-06-06 |
| UI/UX Specialist | ✅ COMPLETE | 2026-06-06 |
| Engineering Team | ✅ COMPLETE | 2026-06-06 |
| Integration Test | ✅ COMPLETE | 2026-06-06 |
| Chief Architect (REVIEW) | ✅ APPROVED WITH NOTES | 2026-06-07 |
| Sponsor Approval | ☐ SUPERSEDED — phase split decision taken instead | 2026-06-07 |

> The original spec's 18 delivery tickets (T2-01..T2-18), all architectural mandates (M-01..M-10),
> MUST NOTs (MN-01..MN-05), risks (AR-01..AR-06), engineering risks (ER-01..ER-07), and 25 NEG
> acceptance criteria (NEG-01..NEG-25) are redistributed across the three phase specs. Nothing is lost.
