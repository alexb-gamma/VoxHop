# VoxHop ROADMAP

---

## DONE

### Track 2 Phase 1 — Infrastructure
**Closed: 2026-06-07 — SPONSOR APPROVED**

- **Feature Spec**: [`FEATURES/TRACK2_PHASE1_INFRASTRUCTURE.md`](FEATURES/TRACK2_PHASE1_INFRASTRUCTURE.md)
- **Live URL**: `https://simulator.voxhop.borshik.net` (Let's Encrypt TLS, expires 2026-09-05)
- **Instance**: `i-0295d1d370d43a642` (`g5.xlarge`, `eu-north-1b`) · EIP `13.62.124.43`
- **Result**: All 7 services healthy (voxhop-simulator, voxhop-counterparty, voxhop-app, voxhop-ollama, voxhop-whisper, voxhop-piper, voxhop-redis). Let's Encrypt cert (DNS-01/Route 53). 5 EU personas loaded. AudioWorklet + mic permission confirmed in browser. COOP/COEP headers verified. WS handshake confirmed. 55/55 Track 1 Vitest tests — zero regressions.

### Track 1 — Foundation + Pipeline Demo
**Closed: 2026-06-06 — SPONSOR APPROVED**

- **Feature Spec**: [`FEATURES/TRACK1_FOUNDATION_PIPELINE.md`](FEATURES/TRACK1_FOUNDATION_PIPELINE.md)
- **Delivery Archive**: [`DELIVERY_SCHEDULE_ARCHIVE.md`](DELIVERY_SCHEDULE_ARCHIVE.md)
- **AMI**: `ami-0cae9aa0e65457fa4` (re-baked 2026-06-06 — compose config fully baked in, zero post-boot SSM required)
- **Instance**: `i-0295d1d370d43a642` (`g5.xlarge`, `eu-north-1b`) · EIP `13.62.124.43` · `wss://13.62.124.43:3000/ws/calls`
- **Result**: All 5 services healthy on first boot (voxhop-app, voxhop-ollama [CUDA A10G gemma4], voxhop-whisper [CUDA large-v3], voxhop-piper, voxhop-redis). TypeScript 0 errors. 55/55 Vitest tests passing.

---

## NOW *(single-feature focus)*

### Track 2 Phase 2 — AI Counterparty + Direct Mode
**Entered NOW: 2026-06-07 — SPONSOR APPROVED**

- **Feature Spec**: [`FEATURES/TRACK2_PHASE2_COUNTERPARTY.md`](FEATURES/TRACK2_PHASE2_COUNTERPARTY.md)
- **Status**: `IMPLEMENTATION COMPLETE — AWAITING SPONSOR VERIFICATION`
- **Goal**: A developer can have a real spoken conversation with an AI Counterparty via Direct Mode. The Counterparty runs a full VAD→Whisper→Ollama→Piper pipeline as a standalone WebSocket server. The Simulator Backend acts as the caller-side bridge speaking the telco-ai-bridge wire protocol. `voxhop-app` is not involved in Direct Mode.
- **Dependencies**: Track 2 Phase 1 DONE ✅
- **Co-Signs**: Chief Architect (INITIATE) ✅ · UI/UX ✅ · Engineering ✅ · Integration Test ✅ · Chief Architect (REVIEW) ✅ · **Sponsor ✅ APPROVED 2026-06-07**
- **Automated Test Gate**: `voxhop-counterparty` 0 errors · 32/32 ✅ · `voxhop-simulator` 0 errors · 29/0 failed ✅ — PASSED 2026-06-07

---

## NEXT
*Phases 3 and beyond are queued. Translation Layer and Debug Instrumentation follow Phase 3.*

### Track 2 Phase 3 — Translation + Replace Mode
**Feature Spec**: [`FEATURES/TRACK2_PHASE3_TRANSLATION.md`](FEATURES/TRACK2_PHASE3_TRANSLATION.md)

-   **Status**: `AWAITING PHASE 2 COMPLETION`
-   **Goal**: Full Translation Mode — Track 1 schema migration (`txTracks[]`), Replace Mode wire-up in `voxhop-app`, cross-routing in the Simulator Backend, and Translation Mode frontend. At the end of Phase 3, the original Track 2 vision is complete.
-   **Dependencies**: Track 2 Phase 2 DONE

### Translation Layer
*The intelligence layer. Add EU cluster translation to the proven pipeline.*

-   **Status**: `AWAITING PHASE 3 COMPLETION`
-   **Goal**: Replace the echo/synthesis Ollama prompt with a real-time translation instruction. Each party's speech is transcribed in their source language and synthesised in the counterpart's target language. Language pairs are statically configured per DID in Redis. EU cluster: English, Spanish, French, German, Italian (all combinations). Translation quality validated continuously using the AI Counterparty — no bilingual human required for basic quality assessment.
-   **Key work**:
    - Translation system prompt design and evaluation against EU cluster sentence test suite
    - Piper voice packs installed for ES, FR, DE, IT (in addition to EN)
    - Per-leg language configuration in Redis DID mapping
    - Sentence-level LLM streaming dispatch to TTS (SentenceSplitter pattern from HelloSurgery)
    - Latency tuning to achieve p95 ≤1.5s across all EU language pairs
    - Comfort silence/tone injected to listening leg during processing turn
-   **Dependencies**: Track 2 Phase 3 DONE

### Debug Instrumentation
*Make the PoC debuggable. Per-call transcription logs and audio recordings.*

-   **Status**: `AWAITING PHASE 3 COMPLETION`
-   **Goal**: When `DEBUG_RECORD=true`, VoxHop writes a per-call JSONL transcript log (speaker, language, source transcript, translated transcript, turn latency) and raw LPCM16 audio files (inbound per leg, outbound per leg). Files are named by `callId` and timestamped. Storage path is configurable (`/tmp/debug` locally, S3 in production via existing Terraform bucket). Enabled by default for PoC; disabled by default in production config.
-   **Dependencies**: Track 2 Phase 3 DONE

### PoC Stakeholder Sign-off Gate
*The Week 4 milestone. Three-stakeholder approval to proceed to pre-production.*

-   **Status**: `AWAITING TRANSLATION LAYER + DEBUG INSTRUMENTATION`
-   **Goal**: Live demonstration to VoxHop Sponsor, telco-ai-bridge Sponsor, and Gamma CTO of a real PSTN call between two EU language pairs with real-time translation, sub-1.5s p95 latency, and debug transcript evidence. All five acceptance gates must pass:
    1. ✅ Integration gate: `telco-ai-bridge` intercepts a real Gamma DID call
    2. ✅ Functional gate: Two parties hear translated audio in their own language
    3. ✅ Quality gate: Translation assessed as "good enough to conduct business" by bilingual testers across 20+ representative sentences per language pair — validated using the AI Counterparty and Simulator UI
    4. ✅ Stability gate: 10-minute conversation survives without dropout, crash, or p95 > 2s
    5. ✅ Stakeholder gate: VoxHop Sponsor + telco-ai-bridge Sponsor + Gamma CTO sign off
-   **Dependencies**: Translation Layer DONE, Debug Instrumentation DONE

---

## LATER
*Operational features unlocked after PoC sign-off. The path from proven prototype to production product.*

---

### Pre-Production: Compliance Gate *(MANDATORY before any production traffic)*
-   **Goal**: Full GDPR and regulatory legal assessment for EU voice call interception and real-time transcription processing. Output: approved data retention policy, consent model at DID/network level, data residency confirmation (`eu-north-1`), legal sign-off from Gamma's compliance team. VoxHop MUST NOT carry production customer traffic without this gate passing.
-   **Dependencies**: PoC Stakeholder Sign-off Gate DONE

### Language Auto-Detection
-   **Goal**: Replace static DID-to-language-pair config with Whisper's built-in language detection on the first 5 seconds of each leg's speech. VoxHop detects the source language automatically per-leg and selects the appropriate TTS voice pack. Enables VoxHop to be deployed on any Gamma DID without pre-configuration. Per-leg language IDs are stored in call state and logged for quality analysis.
-   **Dependencies**: Translation Layer DONE; Whisper language detection evaluated against EU cluster accuracy benchmarks (target ≥95%)

### Production Hardening
-   **Goal**: Scale VoxHop beyond the PoC. Horizontal GPU pool behind a load balancer (Nginx or HAProxy). Redis-backed distributed call state supporting multiple VoxHop instances. Prometheus alerting (PagerDuty integration). ELK log aggregation. Auto-scaling `eu-north-1` GPU group (scale-to-zero during off-peak). Drain mode (reject new calls, finish active calls) for zero-downtime deployments. SIPp load tests at 20+ concurrent calls.
-   **Dependencies**: Compliance Gate DONE

### Extended Language Clusters
-   **Goal**: Expand beyond the EU cluster. Phase A: Extended European (Polish, Dutch, Swedish, Norwegian, Danish, Portuguese, Romanian). Phase B: Global high-resource (Mandarin, Japanese, Korean, Arabic, Hindi, Brazilian Portuguese). Each cluster requires Whisper accuracy validation, LLM translation quality evaluation, and Piper/XTTS voice pack availability assessment.
-   **Dependencies**: Language Auto-Detection DONE; Production Hardening DONE

### telco-ai-bridge Upstream Contributions
-   **Goal**: PR back to `telco-ai-bridge` any protocol extensions, media-worker improvements, or VAD/pipeline patterns developed during VoxHop. Specific candidates: dual-leg `processingTurn` mute commands, per-call latency Prometheus metrics, silence-fill TTS injection pattern documentation.
-   **Dependencies**: PoC Stakeholder Sign-off Gate DONE; changes reviewed with telco-ai-bridge Sponsor

---

## HORIZON
*The north star. Every preceding phase is a stepping stone to this.*

---

### 🎯 Voice Cloning — The True BabelFish *(Defining Stretch Goal)*
> *"Party B does not hear a synthetic voice. They hear Party A's own voice, speaking their language."*

-   **Goal**: VoxHop captures a speaker voice embedding from the first 5–10 seconds of each party's natural speech on the call. Every translated sentence is then synthesised in the speaker's own voice timbre, accent, and cadence using XTTS v2 (Coqui) or equivalent open-source voice cloning model. The voice embedding is computed once per call and cached — subsequent turns carry zero additional overhead. The first-turn latency penalty (~200–400ms for embedding extraction) is masked by a brief "Connecting your call…" comfort phrase. When this feature ships, VoxHop stops being a translation relay and becomes the BabelFish. This is the moment the product becomes genuinely remarkable.
-   **Why it matters**: Fixed synthetic voices (Piper) make translation audible and mechanical — callers are always aware they're being translated. Voice cloning makes translation *invisible*. The caller hears the other person's voice speaking their language. The illusion is complete.
-   **Model candidates**: XTTS v2 (Coqui, 17 languages including all EU cluster), Qwen3-TTS (0.6B, 4-bit quantised, voice cloning from 4s reference — already evaluated in HelloSurgery), F5-TTS (open-source, strong multilingual cloning quality).
-   **Dependencies**: Production Hardening DONE; Language Auto-Detection DONE; GPU headroom assessed for cloning model alongside Whisper + LLM on concurrent calls; open-source voice cloning model benchmarked for EU cluster naturalness and latency

### Full-Duplex / Async Concurrent Translation
-   **Goal**: Remove the strict half-duplex constraint. Both legs run independent VAD-STT-LLM-TTS pipelines simultaneously. Each leg has its own processing queue with backpressure. If both parties speak simultaneously, both translations are queued and dispatched without blocking. Includes collision detection and graceful backoff for simultaneous TTS injection on the same leg.
-   **Dependencies**: Voice Cloning DONE (per-leg independence is natural once voice embeddings are per-leg); Redis per-leg queue implementation
