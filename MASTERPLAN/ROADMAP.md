# VoxHop ROADMAP

---

## DONE

*Nothing yet. This is day one.*

---

## NOW *(Parallel tracks — both required before NEXT begins)*

> Both tracks run simultaneously. Translation Layer does not start until both are complete.

---

### Track 1: Foundation + Pipeline Demo
**Target: Week 1 internal demo**
*Prove the pipe. IaC from the very first resource.*

-   **Status**: `READY TO START`
-   **Goal**: Establish a live end-to-end STT → LLM → TTS pipeline on a real Gamma PSTN call in echo/synthesis mode — no translation yet. VoxHop intercepts a dual-stream call via `telco-ai-bridge`, transcribes speech with Whisper, passes the transcript through Ollama, and synthesises audio back to the caller with Piper. All infrastructure defined in Terraform from day one. All services containerised via Docker Compose.
-   **Acceptance**:
    1. `make deploy` brings the full VoxHop AI stack on `eu-north-1` from zero — no manual steps
    2. `telco-ai-bridge` WebSocket client connects and receives dual `caller`/`called` audio tracks
    3. Silero VAD detects end-of-speech and fires on both legs independently
    4. Whisper STT produces accurate transcripts from live call audio
    5. Ollama receives transcript and returns synthesised text (echo prompt)
    6. Piper synthesises audio and VoxHop injects it back into the correct call leg
    7. End-to-end round-trip latency measured and logged per turn (Prometheus)
    8. AI service failure (Whisper/Ollama/Piper down) leaves call connected, untranslated
    9. `make destroy` cleanly tears down all resources with no orphans
-   **Dependencies**: Active `telco-ai-bridge` instance with Gamma DID configured; `eu-north-1` A10G GPU quota approved; Terraform state backend configured (S3 + DynamoDB lock)

---

### Track 2: VoxHop Simulator + AI Counterparty
**Target: Week 1 (alongside Track 1) — first-class priority**
*Built in parallel with the foundation. Required before any translation work begins.*

-   **Status**: `READY TO START`
-   **Goal**: A complete developer testing suite that allows a single developer to exercise the full VoxHop pipeline end-to-end without a real second caller. Clean service boundary — the simulator connects to VoxHop only via the public `telco-ai-bridge` WebSocket interface. No shared in-process state. Independently deployable on a separate instance or a developer laptop.
-   **Components**:
    - **VoxHop Simulator UI** (`npx tsx voxhop-simulator.ts`): Zero-build-step browser WebRTC simulator. Developer speaks as Party A; AI Counterparty is Party B. Two-panel layout: VoxHop Panel (dual-leg transcripts, per-turn latency, language labels, pipeline state, `telco-ai-bridge` protocol event timeline) and AI Counterparty Panel (persona card, LLM token stream, transcript log, per-turn STT/LLM/TTS telemetry).
    - **AI Counterparty Voice Agent**: Full audio round-trip pipeline — Silero VAD on VoxHop's Language B TTS output → Whisper STT (Language B) → Ollama LLM (persona prompt + conversation history) → Piper TTS (Language B) → audio injected into Leg B. Ships with 5–8 starter personas covering the EU cluster. In-browser persona editor backed by `counterparties/*.json` library.
-   **Acceptance**:
    1. Developer selects a persona (e.g. "Madrid Hotel Receptionist / ES"), clicks Dial — call connects within 3 seconds
    2. Developer speaks English; hears translated response in their speakers within the 1.5s latency budget
    3. AI Counterparty Panel shows live LLM token stream as the counterparty generates its response
    4. Per-turn telemetry visible inline: STT / LLM / TTS latency breakdown for counterparty pipeline
    5. Simulator runs on a developer laptop without touching the VoxHop GPU instance
    6. New persona created and saved in the UI editor persists across sessions
    7. Simulator deployable via `docker compose up` with no GPU dependency
-   **Dependencies**: Track 1 WebSocket interface reachable; Piper EU voice packs (ES, FR, DE, IT) installed on inference server

---

## NEXT
*Begins only when both NOW tracks are complete.*

### Translation Layer
*The intelligence layer. Add EU cluster translation to the proven pipeline.*

-   **Status**: `AWAITING NOW COMPLETION`
-   **Goal**: Replace the echo/synthesis Ollama prompt with a real-time translation instruction. Each party's speech is transcribed in their source language and synthesised in the counterpart's target language. Language pairs are statically configured per DID in Redis. EU cluster: English, Spanish, French, German, Italian (all combinations). Translation quality validated continuously using the AI Counterparty — no bilingual human required for basic quality assessment.
-   **Key work**:
    - Translation system prompt design and evaluation against EU cluster sentence test suite
    - Piper voice packs installed for ES, FR, DE, IT (in addition to EN)
    - Per-leg language configuration in Redis DID mapping
    - Sentence-level LLM streaming dispatch to TTS (SentenceSplitter pattern from HelloSurgery)
    - Latency tuning to achieve p95 ≤1.5s across all EU language pairs
    - Comfort silence/tone injected to listening leg during processing turn
-   **Dependencies**: NOW (both tracks) DONE

### Debug Instrumentation
*Make the PoC debuggable. Per-call transcription logs and audio recordings.*

-   **Status**: `AWAITING NOW COMPLETION`
-   **Goal**: When `DEBUG_RECORD=true`, VoxHop writes a per-call JSONL transcript log (speaker, language, source transcript, translated transcript, turn latency) and raw LPCM16 audio files (inbound per leg, outbound per leg). Files are named by `callId` and timestamped. Storage path is configurable (`/tmp/debug` locally, S3 in production via existing Terraform bucket). Enabled by default for PoC; disabled by default in production config.
-   **Dependencies**: NOW (both tracks) DONE

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
