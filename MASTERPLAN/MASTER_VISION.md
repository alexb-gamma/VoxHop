# VoxHop: The Voice That Crosses Languages
## Real-time voice-to-voice translation embedded in Gamma Telecom's live call network

---

### I. MISSION

VoxHop eliminates language as a barrier to human communication over the telephone. It sits invisibly inside Gamma Telecom's voice network, intercepting live calls and translating speech between parties in real time — each person speaks their own language and hears the other in theirs. It is not a service the caller has to think about, configure, or consciously use. Like the BabelFish slipped quietly into the ear, it simply works. VoxHop is built entirely on open-source, self-hosted AI models, making it privately operated, auditable, and free from dependency on commercial AI APIs.

---

### II. THE BABELFISH PERSONA

VoxHop is inspired by the BabelFish from Douglas Adams' *The Hitchhiker's Guide to the Galaxy* — a small, unremarkable creature that, when placed in the ear, instantly translates any language in the universe. The BabelFish doesn't ask you to repeat yourself. It doesn't add friction. It doesn't make you aware of its presence. It simply dissolves the barrier.

*   **Invisible**: The best translation is the one the caller doesn't notice. VoxHop should feel like the other person suddenly speaks your language.
*   **Instantaneous**: Latency is not a technical footnote — it is the user experience. Every millisecond of delay is a crack in the illusion.
*   **Universal**: No language should be a dead end. VoxHop starts with the EU cluster and grows outward.
*   **Unobtrusive**: VoxHop is embedded infrastructure. It has no UI the caller touches, no account to create, no app to download.

---

### III. CORE PHILOSOPHIES (NON-NEGOTIABLE)

1.  **Latency is a feature, not a metric**: The p95 end-to-end latency from VAD end-of-speech detection to first translated audio byte reaching the listener MUST remain at or below 1.5 seconds. This is a hard non-functional requirement. Architecture decisions that endanger this budget are rejected.

2.  **Open-source, self-hosted, always**: VoxHop runs exclusively on open-source AI models deployed on infrastructure we control. No audio, transcript, or translation may be sent to a third-party commercial AI API (OpenAI, Google, Anthropic, etc.). Every model in the pipeline must be hostable on our own GPU.

3.  **Pipeline before intelligence**: Prove each stage of the pipeline independently before adding the next layer of complexity. Infrastructure first. STT → TTS echo before translation. Translation before voice preservation. Never skip a stage to add a feature.

4.  **Graceful degradation over failure**: If any AI service in the pipeline becomes unavailable or exceeds its latency budget, the call must continue — untranslated if necessary, but never dropped. Silence is not an error. A failed translation turn is survivable. A dropped call is not.

5.  **Upstream compatibility**: VoxHop is a PoC that lives alongside `telco-ai-bridge`. Any media-plane changes or protocol extensions developed for VoxHop must be clean enough to propose as pull requests upstream. We do not fork; we contribute.

6.  **Privacy by design**: VoxHop processes speech transiently — transcripts and audio buffers exist only for the duration of the pipeline turn. Post-PoC: no retention by default. During PoC: debug transcription and recording are enabled explicitly and scoped to internal engineering use only. GDPR and compliance assessment is a mandatory pre-production gate.

7.  **Half-duplex honesty**: VoxHop is a turn-based translator, not a simultaneous interpreter. Each leg has an independent `processingTurn` lock. While one party's turn is being processed, the other hears silence. This is honest — it does not pretend to be something it is not yet.

8.  **Telco-grade reliability**: VoxHop inherits the reliability expectations of a voice network. Crashes, panics, and unhanded errors must never bring down the call. Per-turn goroutine/promise recovery, panic injection tests, and chaos resilience are first-class engineering concerns.

9.  **Infrastructure as Code — no exceptions**: Every resource VoxHop touches is defined in code, scripted, and repeatable. No server is manually configured. No deployment step requires SSH and human judgement. A fresh environment — dev, staging, or production — must be reachable from zero with a single command. Terraform owns all cloud infrastructure. Docker Compose owns all service stacks. If it cannot be destroyed and rebuilt in under 30 minutes with identical behaviour, it is not production-ready. This is non-negotiable from day one, not a post-PoC cleanup task.

10. **Minimal operational overhead**: VoxHop in production must be operable without a dedicated ops team. Auto-scaling handles load. Scale-to-zero handles idle periods. Drain mode handles deployments. Prometheus and structured logging handle observability. The system should be self-healing at the service level — restarts on failure, circuit-breaks on dependency outage — and should require human intervention only for genuine, novel outages. Every manual operational task is a bug to be automated.

---

### IV. TACTICAL OBJECTIVES

*   **Week 1 Demo**: Establish end-to-end STT → LLM → TTS pipeline on a live Gamma PSTN call in echo/synthesis mode (no translation). Demonstrate that VoxHop can intercept a dual-stream call via `telco-ai-bridge`, transcribe speech, and synthesise audio back to the caller. Internal engineering validation only.

*   **Week 4 PoC**: Deliver end-to-end real-time translation between EU cluster language pairs (English, Spanish, French, German, Italian) on a live Gamma call. Sub-1.5s p95 latency. Debug transcription and audio recording active. PoC sign-off gate: VoxHop Sponsor + telco-ai-bridge Sponsor + Gamma CTO.

*   **Pre-Production Gate**: Full GDPR and regulatory compliance assessment for EU voice call interception and transcription processing. Data retention policy defined. Consent model established at DID/network level with Gamma's legal team. No production traffic until this gate is passed.

*   **Production**: Scale-hardened deployment on Gamma's live network. Full EU cluster. Prometheus observability. Horizontal GPU scaling. Redis-backed call state.

*   **Horizon — Voice Cloning *(The True BabelFish)* **: The ultimate expression of VoxHop's mission. Party B does not hear a synthetic voice — they hear Party A's own voice, speaking their language. VoxHop captures a speaker voice embedding from the first seconds of the call and uses it to clone the caller's timbre, accent, and cadence into the translated output. When this is achieved, VoxHop is no longer a translation relay — it is the BabelFish. Every preceding phase is a stepping stone to this moment.

---

### V. OPERATING TONE

VoxHop is **quiet, precise, and dependable.**

It does not announce itself. It does not ask for help. It does not produce errors that surface to callers. It is infrastructure — and infrastructure earns trust by disappearing into the background and never failing.

In engineering culture: VoxHop is rigorous. Every turn in the pipeline is tested at the frame level. Latency is measured, not estimated. Silence between translated turns is a designed behaviour, not a bug.

---

### VI. PRODUCT BOUNDARIES

**VoxHop IS:**
*   A real-time voice-to-voice translation layer embedded in Gamma Telecom's PSTN network
*   An in-path call interceptor using `telco-ai-bridge`'s dual-stream AI agent mode
*   An STT → LLM → TTS translation pipeline (Whisper → Ollama → Piper/XTTS) running on self-hosted GPU infrastructure
*   A half-duplex, turn-based translation system with per-leg VAD and processing locks
*   An EU cluster multilingual service (English, Spanish, French, German, Italian) for the PoC
*   A PoC and platform contribution that feeds learning back into `telco-ai-bridge`
*   A debug-instrumented system with per-call transcription logs and audio recordings (PoC phase)
*   A developer testing suite: a WebRTC browser simulator and an LLM-driven multilingual AI counterparty for full audio round-trip validation without a real second caller

**VoxHop IS NOT:**
*   A SIP proxy, call router, PBX, or telephony infrastructure product
*   A standalone consumer application or user-facing product
*   A call recording or compliance/archival product (post-PoC)
*   A real-time captioning or accessibility service
*   A chatbot, conversational AI agent, or virtual assistant
*   A simultaneous/full-duplex interpreter (initially — this is a Horizon feature)
*   Dependent on any commercial AI API — all models are self-hosted
*   A replacement for `telco-ai-bridge` — it is an application built on top of it

---

### VII. DEVELOPER TESTING TOOLS

VoxHop ships a first-class developer testing suite alongside the translation service. These tools exist to accelerate development, validate translation quality, and enable the PoC demonstration without requiring two human callers on a live network.

#### VoxHop Simulator UI
A browser-based WebRTC simulator that allows a single developer to test the full VoxHop pipeline. Inspired by HelloSurgery's `gamma-simulator-web` pattern — a zero-build-step single TypeScript file serving an embedded SPA.

**Workflow**: Developer opens the simulator, selects a virtual counterparty persona from the library, clicks Dial. The simulator establishes a WebRTC connection to the VoxHop service (injecting the developer's browser mic as Leg A) and connects the AI counterparty as Leg B. The developer speaks in Language A and hears VoxHop's translation of the counterparty's Language B response through their speakers.

**Two-panel layout**:
- **VoxHop Panel**: Live dual-leg transcript display — what each party said in their source language, what VoxHop translated it to, per-turn latency inline with each exchange, language pair labels, VAD and pipeline state indicators.
- **AI Counterparty Panel**: Four-section view — *Persona card* (active name, language, voice, current state: listening / processing / speaking), *LLM stream* (token-by-token output as the counterparty generates its response in real time), *Transcript log* (what it heard via Whisper STT of VoxHop's Language B audio vs. what it said), *Pipeline telemetry* (per-turn: STT latency, LLM time-to-first-token, TTS synthesis time, total counterparty turn time).

**Protocol event timeline**: Color-coded log of all `telco-ai-bridge` WebSocket events (call_initiated, media_started, audio frames, command_ack) — the same pattern as gamma-simulator-web.

#### AI Counterparty Voice Agent
An autonomous voice agent that occupies Leg B of any VoxHop test call. Runs the **full audio round-trip** — no transcript shortcut. Hears VoxHop's synthesised Language B TTS output via the `telco-ai-bridge` WebSocket, runs Silero VAD to detect end-of-speech, transcribes with Whisper STT in Language B, generates a contextually responsive reply via Ollama (with persona system prompt + full conversation history), synthesises the reply to Language B audio via Piper TTS, and injects it back into Leg B. The human hears VoxHop's translation of the counterparty's Language B response. Tests the full translation chain including TTS→STT quality degradation.

**Deployment independence**: The AI Counterparty and Simulator UI are **first-class citizens with clean service boundaries**. They are independently deployable — they may run on the same GPU instance as VoxHop initially but must never be architecturally entangled with it. The counterparty connects to VoxHop's `telco-ai-bridge` WebSocket as any other application would. No shared in-process state. No shared module imports across the service boundary. The testing stack must be deployable on a separate instance — or a developer laptop — without modifying the VoxHop service.

**Persona library**: Named, saved counterparty configurations stored as JSON files in `counterparties/`. Each persona defines: display name, target language, Piper voice pack, Ollama system prompt (character, professional context, conversational style), and optional conversation opener. A UI editor within the simulator allows creating, editing, and saving personas. Ships with 5–8 starter personas covering the EU cluster — one per language, with realistic professional scenarios (hotel receptionist, customer support, sales contact, travel booking agent).

**Counterparty intelligence**: The LLM receives a full conversation history — what it has heard (from its own Whisper STT of VoxHop's output) and what it has said — enabling contextually coherent multi-turn dialogue. The counterparty speaks only in its configured language. It does not know it is being translated; it behaves as a natural Language B speaker would on a real call.

---

## TECHNICAL DIRECTIVES (STRICT)

**Runtime**: Node.js 20 + TypeScript 5 (ESM) — primary application layer, following HelloSurgery conventions. Go 1.23 for any media-worker extensions contributed upstream to `telco-ai-bridge`.

**Stack**:
- **Telephony**: `telco-ai-bridge` (Kamailio + RTPEngine + Go media-worker + Node.js control plane) — consumed as-is, not forked
- **Connectivity**: WebSocket client to `telco-ai-bridge`'s customer-facing WS protocol (JSON text frames, base64 audio, track UUIDs)
- **VAD**: Silero VAD v5 via `avr-vad` npm (ONNX, in-process, 96ms frames at 16kHz, 600ms silence threshold, 250ms min speech)
- **STT**: faster-whisper (Whisper Large v3, CTranslate2, CUDA) — OpenAI-compatible HTTP API (`POST /v1/audio/transcriptions`)
- **LLM**: Ollama (multilingual model TBD — Gemma 4 as baseline, evaluate Aya-23 or Mistral multilingual for EU cluster quality) — streaming, sentence-level dispatch
- **TTS**: Piper ONNX with per-language voice packs (EN, ES, FR, DE, IT) — streaming HTTP response, 24kHz PCM output; upgrade path to XTTS v2 for voice preservation phase
- **Audio canonical format**: 16kHz, 16-bit signed LE, mono PCM at all internal boundaries
- **Outbound pacing**: 20ms ticker with silence fill, matching `telco-ai-bridge` RTP cadence
- **Call state**: Redis (per-call hash, DID-to-language-pair mapping, processingTurn flags)
- **Debug instrumentation**: Per-call JSONL transcript log + LPCM16 audio recording files (PoC phase, gated by `DEBUG_RECORD=true`)
- **Simulator UI**: ~~Zero-build-step single TypeScript file~~ **[OVERRIDDEN — Track 2 Sponsor directive 2026-06-06]** React 18 + TypeScript + Vite + Tailwind CSS SPA, served by a NestJS backend. Vite build is baked into the Docker image — operator ergonomics unchanged (`docker compose up`). Web Audio API dual AudioWorklet (capture + ring-buffer playback), NestJS WebSocket gateway to VoxHop, protocol event timeline log. The zero-build-step constraint is retired for this component.
- **AI counterparty**: Node.js TypeScript service; Silero VAD v5 (`avr-vad`) on VoxHop's Language B TTS output; Whisper STT (shared inference server); Ollama LLM with persona system prompt + conversation history; Piper TTS (language-matched voice pack); persona configs as JSON in `counterparties/` directory

**Deployment**:
- **Media plane**: Inside Gamma Telecom's network boundary (co-located with `telco-ai-bridge`)
- **AI inference**: AWS `eu-north-1` (Stockholm) — A10G GPU instance, private link to Gamma network
- **Simulator / counterparty**: Independently deployable — same GPU instance initially with clean service boundary; separate instance or developer laptop in later phases
- **Scale target (PoC)**: <5 concurrent translated calls on a single A10G

**Infrastructure as Code (NON-NEGOTIABLE)**:
- **Terraform**: All AWS resources defined as code — VPC, subnets, security groups, EC2 GPU instances, IAM roles, private link to Gamma network, S3 buckets (debug recordings). No resource created via AWS Console.
- **Docker Compose**: All AI inference services (Whisper, Ollama, Piper, TTS) containerised. `docker compose up` brings the full AI stack from zero. Same compose file used in dev and production.
- **Makefile**: `make deploy`, `make destroy`, `make start`, `make stop`, `make logs` — human-readable entry points to all operational tasks. No raw Terraform or Docker commands required for routine operations.
- **Environment parity**: Dev, staging, and production differ only in environment variables and instance size. Same scripts. Same images. Same config structure.
- **Rebuild guarantee**: Any instance can be terminated and rebuilt to identical state in under 30 minutes. No snowflake configuration. No manual post-boot steps.

**Schema**: Zod runtime validation for all inter-service configuration, language pair mappings, and debug output schemas.

**Testing**: Vitest unit tests. Frame-shape tests for the `telco-ai-bridge` WebSocket protocol. Per-turn latency assertions. VAD/STT/LLM/TTS pipeline unit tests with recorded audio fixtures. Chaos resilience: AI service unavailability must not drop the call.

**Latency Budget (HARD NFR)**: p95 ≤ 1.5s from VAD end-of-speech to first translated audio byte at the listener. Measured per-turn, per-call, reported via Prometheus.

**Observability**: Prometheus metrics on all services. Per-call counters: `rxFrames`, `txFrames`, `vadFires`, `sttCalls`, `llmCalls`, `ttsCalls`, `turnLatencyMs` (histogram). Structured JSON logging (`pino`) with `callId` and `trackId` on every log line.
