# FEATURE: Track 1 — Foundation + Pipeline Demo

> **Track**: ~~NOW~~ **DONE**
> **Closed**: 2026-06-06 — SPONSOR APPROVED
> **Target**: Week 1 internal engineering demo ✅
> **Mandate**: Prove the pipe. IaC from the very first resource.
>
> **Delivery**: AMI `ami-0cae9aa0e65457fa4` · Instance `i-0295d1d370d43a642` (`g5.xlarge`, `eu-north-1b`) · EIP `13.62.124.43` · All 5 services healthy on first boot · 55/55 tests passing
> **Archive**: [`DELIVERY_SCHEDULE_ARCHIVE.md`](../DELIVERY_SCHEDULE_ARCHIVE.md)

---

## 1. PROBLEM STATEMENT

**What specific problem is this feature solving?**

VoxHop's mission is real-time voice-to-voice translation on live Gamma PSTN calls. Before translation can be attempted, the underlying audio pipeline must be proven: VoxHop must be able to intercept a live dual-stream call, capture audio from both legs, process it through an AI pipeline, and inject synthesised audio back into the call — without dropping the call under any failure condition.

Without this foundational proof, any failure during the Translation Layer is indistinguishable from an infrastructure problem. Debugging translation quality on top of an unvalidated pipeline is guesswork.

**Who suffers from this problem today?**

The engineering team. There is currently no evidence that VoxHop can connect to `telco-ai-bridge`, receive live PSTN audio, exercise Whisper STT + Ollama LLM + Piper TTS on real codec-degraded audio, and inject audio back to a live caller — on real AWS GPU infrastructure provisioned from code.

**What is the cost of inaction?**

The Translation Layer begins on an unproven foundation. Infrastructure failures, audio format mismatches, VAD misconfiguration, and Prometheus instrumentation gaps surface during Week 4 — when stakeholder pressure is highest and debugging bandwidth is lowest. The PoC deadline is endangered.

**What this feature explicitly does NOT solve:**

- Real-time translation between languages (that is the Translation Layer, NEXT)
- Debug transcript/audio recording infrastructure (`DEBUG_RECORD`, NEXT)
- Developer testing without a real call (Simulator + AI Counterparty, Track 2)
- Language auto-detection or per-DID language configuration

---

## 2. VISION

Track 1 is the BabelFish's skeleton — the nerve pathway before thought. It does not translate. It does not understand. It listens, processes, and speaks back. But it does so on real infrastructure, through real codecs, on a real Gamma PSTN call — proving that every joint in the pipeline flexes before load is applied.

The Week 1 demo is an internal engineering milestone only. A developer dials a Gamma DID. VoxHop intercepts the call via `telco-ai-bridge`. The developer speaks. VoxHop transcribes the speech with Whisper, passes the transcript through Ollama (which echoes it faithfully), synthesises the echo back to audio with Piper, and injects it into the caller's leg. The developer hears their own words spoken back in a synthetic voice.

This is not a user experience. It is proof — that every stage of the pipeline is wired, instrumented, and survivable.

The core philosophies this track directly validates:

- **Pipeline before intelligence**: Each stage proven independently before translation is added.
- **Latency is a feature**: All four pipeline stages are instrumented with Prometheus histograms from day one. Latency is measured — not estimated, not deferred.
- **Graceful degradation over failure**: A downed Whisper, Ollama, or Piper instance must never drop the call. The caller hears a comfort phrase and the call continues.
- **Infrastructure as Code — no exceptions**: Every AWS resource VoxHop touches is defined in Terraform and containerised in Docker Compose from the very first commit. `make deploy` is the single entry point. `make destroy` leaves nothing behind.

---

## 3. CORE CAPABILITIES

### 3.1 Dual-Leg Call Interception

*   **Trigger**: A Gamma DID receives an inbound PSTN call configured for VoxHop interception. `telco-ai-bridge`'s media-worker dials OUT to VoxHop's WebSocket server endpoint — VoxHop is the **server**, not the client.
*   **Input**: `telco-ai-bridge` WebSocket events: `call_initiated` (carrying a bridge-assigned `callId`) followed by `media_started` (carrying `mediaFormat` and a `tracks[]` array identifying each leg by `trackId` and `track` label, plus a `txTrackId` for audio injection).
*   **Output**: VoxHop accepts the inbound WebSocket connection, parses both track IDs from the `tracks[]` array, and enters an active call state. Redis keys are initialised for the call with a 4-hour TTL.
*   **Behaviour**:
    1. On `call_initiated`: VoxHop reads the bridge-assigned `callId` from the event payload — it does **not** generate its own. VoxHop writes `call:{callId}:state = active` to Redis with a 4-hour TTL and initialises per-leg processing lock keys with a 10-second TTL.
    2. On `media_started`: VoxHop validates the `mediaFormat` — asserting `sampleRate=16000`, `channels=1`, `bitDepth=16`, `encoding=audio/x-raw` — and extracts `callerTrackId` and `calledTrackId` from the `tracks[]` array (e.g. `tracks.find(t => t.track === 'caller').trackId`). VoxHop also extracts `txTrackId` — the track on which audio injection frames must be sent. If `txTrackId` is absent, VoxHop closes the WebSocket immediately (audio injection is impossible). All parsing is via Zod schema. A format mismatch emits a structured error log and closes the WebSocket gracefully — this is a fatal configuration error, not a survivable failure.
    3. VoxHop begins accepting `audio` frames on both the `caller` track and `called` track simultaneously and independently, routing each frame to its leg by `trackId`.
    4. On `call_ended` event or WebSocket close: VoxHop explicitly deletes all `call:{callId}:*` Redis keys and emits a structured call-summary log entry.
    5. If neither `call_ended` nor WebSocket close is received (network partition, media-worker crash, `wsSend` full): the 4-hour TTL on call state and 10-second TTL on processing locks ensure Redis self-cleans without human intervention.

---

### 3.2 Per-Leg Voice Activity Detection

*   **Trigger**: Continuous inbound `audio` frames on a given leg's track.
*   **Input**: Base64-decoded S16LE 16kHz mono PCM audio frames (640 bytes / 20ms per frame) from `telco-ai-bridge`. Audio is already in canonical format — no resampling or decoding required at this boundary.
*   **Output**: A VAD fire event carrying the accumulated speech audio buffer for the leg (all frames from speech start to silence threshold), ready for STT processing.
*   **Behaviour**:
    1. Each leg runs a dedicated Silero VAD v5 instance (`avr-vad` npm, ONNX in-process). The two legs are fully independent — VAD on Leg A has no awareness of Leg B's state.
    2. Audio frames are appended to a per-leg ring buffer. Silero VAD is evaluated on each 96ms chunk (1,536 samples at 16kHz — `FRAME_SAMPLES = 1536`, fixed by the `avr-vad` ONNX model configuration).
    3. VAD fires when the following conditions are met simultaneously:
        - At least `VAD_MIN_SPEECH_MS` (default: 250ms, env-var configurable) of speech has been detected
        - At least `VAD_SILENCE_THRESHOLD_MS` (default: 600ms, env-var configurable) of silence has elapsed since the last speech frame
    4. Both env vars are validated at startup via Zod. Out-of-range values (silence threshold < 200ms or > 2000ms, min speech < 50ms or > 1000ms) cause immediate process exit with a descriptive error message.
    5. If the leg's Redis processing lock is currently held (another turn is in flight on this leg), VAD fires on that leg are **silently discarded** — no queuing, no processing. The in-flight turn completes before any new turn begins.
    6. The frame size (96ms) is fixed by the Silero VAD v5 ONNX model configuration and is not env-var configurable.

---

### 3.3 Echo Turn Execution — STT → LLM → TTS

*   **Trigger**: A VAD fire event carrying the speech audio buffer for a leg.
*   **Input**: The accumulated S16LE 16kHz mono PCM audio buffer for the completed speech turn.
*   **Output**: Synthesised audio (24kHz PCM from Piper, downsampled to 16kHz S16LE before injection) delivered back to the originating leg via the `telco-ai-bridge` WebSocket audio channel.
*   **Behaviour**:
    1. **Lock acquisition**: VoxHop attempts to set the Redis processing lock: `SET leg:{trackId}:processing 1 EX 10 NX`. The TTL is configurable via env var. If the lock cannot be acquired (another turn already in flight on this leg), the turn is discarded.
    2. **STT (Whisper)**: The PCM buffer is sent to the faster-whisper HTTP API (`POST /v1/audio/transcriptions`). A per-stage timeout of **1000ms** is applied from the moment the request is dispatched. If the timeout fires, the turn aborts immediately — the comfort clip is injected and `turnFailures_total{stage="whisper"}` is incremented.
    3. **LLM (Ollama echo)**: The Whisper transcript is sent to Ollama with a tightly constrained system prompt: *"You are a transcript relay. Output ONLY the exact text provided. No additions. No changes. No punctuation modifications."* The transcript and Ollama's output are logged side-by-side in a structured JSON log entry per turn (enabling visible drift detection). A per-stage timeout of **500ms** applies. On timeout: comfort clip + `turnFailures_total{stage="ollama"}`.
    4. **TTS (Piper)**: Ollama's output text is sent to the Piper HTTP TTS API. Piper returns 24kHz PCM audio. VoxHop downsamples the 24kHz output to 16kHz S16LE before injection (the only audio format conversion VoxHop performs). A per-stage timeout of **300ms** applies. On timeout: comfort clip + `turnFailures_total{stage="piper"}`.
    5. **Audio injection**: The 16kHz S16LE audio is base64-encoded and sent as a JSON `audio` frame to the `telco-ai-bridge` WebSocket on the originating leg's track. `telco-ai-bridge` handles all downstream resampling (16kHz → 8kHz) and PCMA encoding for RTP. VoxHop does not manage a 20ms send ticker — `telco-ai-bridge` unconditionally drains its Tx queue every 20ms, filling with PCMA silence (`0xD5`) when no AI audio is present.
    6. **Lock release**: On successful completion or any failure path (timeout, error), the Redis processing lock is explicitly deleted. The 10-second TTL is a safety net — it must not be the primary release mechanism.
    7. **Timeout totals**: The sequential per-stage ceiling is **1.8 seconds** (1000ms + 500ms + 300ms). This ceiling is acceptable for a Week 1 internal demo; it will be tuned against real A10G performance data before the Translation Layer.

---

### 3.4 Graceful Degradation with Comfort Audio

*   **Trigger**: Any pipeline stage (Whisper, Ollama, Piper) exceeds its per-stage timeout, or returns an HTTP error response.
*   **Input**: The stage identifier and the originating leg's track ID.
*   **Output**: A pre-baked spoken comfort audio clip injected to the originating leg. The call WebSocket connection remains open and active.
*   **Behaviour**:
    1. The comfort audio file is a pre-synthesised recording of the phrase **"One moment please."** generated from Piper (`en_GB-alan-medium` voice pack) during the AMI build process (`make build-ami`). It is stored as a 16kHz S16LE PCM file on disk at a configurable path (default: `/opt/voxhop/audio/comfort_en.pcm`).
    2. On any stage failure, VoxHop immediately aborts the current turn (no further pipeline stages are attempted), base64-encodes the comfort PCM file, and injects it to the originating leg's WebSocket track.
    3. `turnFailures_total{stage="whisper|ollama|piper"}` Prometheus counter is incremented with the correct `stage` label.
    4. The Redis processing lock is released immediately after comfort clip injection.
    5. The call remains connected. The `telco-ai-bridge` WebSocket is not closed. Subsequent turns on both legs may proceed normally.
    6. The comfort clip is never played for a `mediaFormat` validation failure (§3.1) — that is a fatal configuration error and results in WebSocket closure, not comfort audio.

---

### 3.5 Half-Duplex Per-Leg Processing Lock

*   **Trigger**: Any VAD fire event on either leg.
*   **Input**: The leg's `trackId`.
*   **Output**: A Redis lock entry (`leg:{trackId}:processing`) that prevents concurrent processing jobs on the same leg.
*   **Behaviour**:
    1. The lock is a Redis key with a `NX` (only set if not exists) flag and a configurable TTL (default: 10 seconds).
    2. If `SET leg:{trackId}:processing 1 EX {ttl} NX` returns `nil` (lock already held), the VAD fire is discarded silently. No queuing. No retry.
    3. On successful turn completion (or comfort clip fallback), the lock is explicitly deleted via `DEL leg:{trackId}:processing`.
    4. The TTL is a dead-man switch: if VoxHop crashes mid-turn, the lock expires automatically and the leg recovers within TTL seconds without human intervention.
    5. The two legs are fully independent: Leg A holding its lock does not block Leg B from acquiring its own lock and processing simultaneously.

---

### 3.6 End-to-End Latency Instrumentation

*   **Trigger**: Every completed echo turn (success or failure path).
*   **Input**: Timestamps captured at each pipeline stage boundary.
*   **Output**: Four Prometheus histogram metrics emitted per turn, and a structured per-turn log entry.
*   **Behaviour**:
    1. Four Prometheus histograms are emitted for every turn, regardless of outcome:
        - `voxhop_vad_to_stt_ms` — VAD fire to Whisper response received
        - `voxhop_stt_to_llm_first_token_ms` — Whisper complete to Ollama first token received
        - `voxhop_llm_to_tts_first_byte_ms` — Ollama complete to Piper first audio byte received
        - `voxhop_tts_to_inject_ms` — Piper first byte to WebSocket audio frame sent
    2. All four histograms include a `leg` label (`caller` | `called`) and a `outcome` label (`success` | `whisper_timeout` | `ollama_timeout` | `piper_timeout` | `error`).
    3. Latency is **measured and logged** in Track 1. The 1.5s p95 budget from the MASTER_VISION is **not enforced** as a gate in this track — that enforcement begins with the Translation Layer.
    4. A structured per-turn JSON log entry (via `pino`) is emitted containing: `callId`, `trackId`, `turnId`, `outcome`, and all four latency values in milliseconds.

---

### 3.7 Infrastructure Provisioning and Teardown

*   **Trigger**: `make deploy` (provision) or `make destroy` (teardown).
*   **Input**: Environment variables (AWS credentials, Gamma private link endpoint, Terraform state backend config).
*   **Output (deploy)**: A fully operational VoxHop AI stack on `eu-north-1`, reachable from a Gamma DID, with all services healthy, in under 30 minutes from a fresh environment (after the one-time `make bootstrap`).
*   **Output (destroy)**: Zero VoxHop-tagged AWS resources remaining, verified automatically via AWS Resource Groups Tagging API tag-scan.
*   **Behaviour**:
    1. **Bootstrap (one-time)**: `make bootstrap` creates the Terraform state backend (S3 bucket + DynamoDB lock table). This is the single operation permitted outside of `make deploy`. It is idempotent.
    2. **AMI build**: `make build-ami` runs Packer to build a golden AMI in `eu-north-1` with: CUDA drivers, Docker Engine, Docker Compose, Whisper Large v3 model weights, Ollama + configured model, Piper ONNX + `en_GB-alan-medium` voice pack, and the pre-baked `comfort_en.pcm` clip. `make build-ami` is a distinct step from `make deploy` and is re-run only when model versions or the AMI configuration changes.
    3. **Deploy**: `make deploy` runs `terraform apply` to provision: VPC, subnets, internet gateway, security groups, IAM roles, EC2 A10G GPU instance (from the Packer AMI), Elastic IP, S3 debug bucket, and DynamoDB state lock. All resources carry the tag `Project=voxhop`. A `docker compose up` startup script runs on the instance at boot, bringing up the Whisper, Ollama, Piper, Redis, and VoxHop Node.js services. No SSH or manual post-boot step is required.
    4. **Destroy**: `make destroy` runs `terraform destroy` followed by an automated AWS tag-scan (`aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=voxhop`). If any VoxHop-tagged resources remain, the destroy is declared failed and an error is surfaced. All S3 buckets are configured with `force_destroy = true` in Terraform to prevent object-content blocking. This is a **hard acceptance gate** — Track 1 is not DONE until a clean `make destroy` with zero orphans has been verified.
    5. **Pre-conditions** (outside Terraform scope, documented): Active `telco-ai-bridge` instance with Gamma DID configured; `eu-north-1` A10G GPU quota approved in the AWS account; Terraform state backend bootstrapped via `make bootstrap`; Gamma network private link provisioned by Gamma's infrastructure team.
    6. **Operational commands**: `make start`, `make stop`, `make logs`, `make status` — human-readable entry points for routine operations. No raw Docker or Terraform commands required.

---

## 4. TECHNICAL IMPLEMENTATION

> *Architecture and component overview. Engineering Strategy (§4.4) to be completed by Engineering Team during co-sign.*

### 4.1 Architecture

VoxHop exposes a **WebSocket server** endpoint (`/ws/calls`). `telco-ai-bridge`'s media-worker dials out to this endpoint — VoxHop does not initiate any connections. All pipeline stages communicate via HTTP APIs to containerised inference services. Call state is held in Redis. Observability is via Prometheus metrics and structured `pino` JSON logs.

The Track 1 pipeline on a single call leg:

```
telco-ai-bridge WebSocket
    │ JSON text frames, base64 S16LE 16kHz PCM, 640 bytes / 20ms
    ▼
VoxHop Node.js Service
    ├─ Frame decoder → per-leg ring buffer
    ├─ Silero VAD v5 (avr-vad, ONNX in-process, 96ms chunks)
    │   └─ VAD fire → acquire Redis lock → dispatch turn
    │       ├─ Whisper HTTP API (POST /v1/audio/transcriptions) ─ 1000ms timeout
    │       ├─ Ollama HTTP API (streaming, echo prompt)         ─  500ms timeout
    │       └─ Piper HTTP API (TTS synthesis)                   ─  300ms timeout
    │           └─ 24kHz→16kHz downsample → base64 → WS inject
    └─ Comfort clip fallback (comfort_en.pcm, any stage failure)

Redis
    └─ call:{callId}:state (4h TTL)
    └─ leg:{trackId}:processing (10s TTL, NX lock)

Prometheus
    └─ voxhop_vad_to_stt_ms, stt_to_llm_first_token_ms,
       llm_to_tts_first_byte_ms, tts_to_inject_ms
    └─ turnFailures_total{stage, leg}
```

### 4.2 New Components

*   **VoxHop Node.js Service**: Core application. WebSocket **server** (`/ws/calls`), VAD integration, pipeline orchestration, Redis state, Prometheus metrics.
*   **Docker Compose stack**: Whisper (faster-whisper, CUDA), Ollama (Gemma 4 baseline), Piper TTS (HTTP wrapper, `en_GB-alan-medium`), Redis, VoxHop Node.js service.
*   **Terraform module** (`infra/`): VPC, EC2 A10G, security groups, IAM, S3, DynamoDB, Elastic IP. All tagged `Project=voxhop`.
*   **Packer AMI template** (`infra/packer/`): CUDA drivers, Docker, model weights, comfort clip. Produces `eu-north-1` AMI.
*   **Makefile**: `bootstrap`, `build-ami`, `deploy`, `destroy`, `start`, `stop`, `logs`, `status`.
*   **Zod schemas**: `mediaFormat` validation, VAD env-var config validation, all inter-service config.

### 4.3 Logic Flow — Single Turn (Happy Path)

1. `telco-ai-bridge` dials VoxHop's WebSocket server → VoxHop accepts connection.
2. `telco-ai-bridge` sends `call_initiated` (bridge-assigned `callId`) → VoxHop initialises Redis call state.
3. `telco-ai-bridge` sends `media_started` → Zod validates `mediaFormat`, extracts `callerTrackId`, `calledTrackId`, and `txTrackId` from `tracks[]` array → VAD ring buffers initialised for both legs.
4. Caller speaks → audio frames arrive tagged with `callerTrackId` → Silero VAD buffers frames.
5. Silence threshold reached → VAD fires → Redis `NX` lock acquired on `callerTrackId`.
6. PCM buffer dispatched to Whisper HTTP API → transcript returned within 1000ms.
7. Transcript logged alongside Ollama's echo output (side-by-side). Transcript sent to Ollama → echo output returned within 500ms.
8. Echo text sent to Piper → 24kHz PCM returned within 300ms.
9. VoxHop downsamples 24kHz → 16kHz → base64-encodes → sends JSON `audio` frame addressed to `txTrackId`.
10. Four Prometheus histograms emitted. Per-turn structured log entry emitted.
11. Redis lock explicitly deleted.
12. VAD ring buffer on `callerTrackId` resumes accepting frames.

### 4.4 Engineering Strategy

> **Engineering Team CO-SIGN — 2026-06-05**

---

#### Blocker Spec Errors — Formally Acknowledged

Three BLOCKER errors identified and corrected by the Architect are confirmed understood and reflected in this strategy:

- **RF-01 (VoxHop is a WebSocket SERVER)**: Confirmed. Our implementation uses `WebSocketServer({ noServer: true })` + HTTP `upgrade` routing to `/ws/calls`. There is no `new WebSocket(url)` client in VoxHop. `telco-ai-bridge` dials out to us.
- **RF-02 (`media_started` uses `tracks[]` array)**: Confirmed. The `MediaStartedSchema` uses `z.array(...)` as mandated in C-02. Track IDs are extracted via `tracks.find(t => t.track === 'caller')?.trackId`. No flat `callerTrackId`/`calledTrackId` field references anywhere.
- **RF-03 (`callId` is bridge-assigned)**: Confirmed. The `callId` is read from `frame.callId` on the `call_initiated` event. VoxHop does **not** generate its own ID. No `uuid()`, no `nanoid()`, no timestamp-based ID generation in the call handler.

---

#### 4.4.1 Technical Approach

**File Structure**

```
voxhop/
├── src/
│   ├── index.ts              # Entry: env validation, VAD pre-warm, comfort load, server start
│   ├── config.ts             # Zod env-var schema (C-07 schema #1) + Config type export
│   ├── schemas.ts            # Zod: CallInitiated, MediaStarted (C-02), Whisper, Ollama (C-07 schemas #2/#3)
│   ├── web-server.ts         # http.createServer + WebSocketServer({noServer:true}) → /ws/calls (C-01)
│   ├── call-handler.ts       # VoxHopCallHandler — lifecycle, frame routing, Map<trackId,LegState>
│   ├── pipeline.ts           # executeTurn() linear fn (SD-01) + callWhisper/callOllama/callPiper
│   ├── silero-vad.ts         # COPIED from HelloSurgery verbatim; env-var wiring replaced (C-08)
│   ├── audio-utils.ts        # COPIED downsampleTo16k() only from HelloSurgery (C-04 pattern)
│   ├── redis.ts              # ioredis client (C-05) + acquireLock/releaseLock/initCall/cleanupCall
│   ├── metrics.ts            # prom-client: 4 histograms + turnFailures_total counter + /metrics HTTP
│   └── comfort.ts            # readFileSync singleton Buffer at startup (C-09) + injectComfortClip()
├── test/
│   ├── frame-shape.test.ts   # Zod schema parse/reject tests on raw JSON frames
│   ├── vad.test.ts           # VAD unit tests: PCM fixtures, speech detection, silence gating
│   ├── chaos.test.ts         # Whisper/Ollama/Piper killed: comfort clip fires, call stays up
│   └── metrics.test.ts       # All 4 histograms emit values per turn; counter increments on failure
├── infra/
│   ├── main.tf               # VPC, subnet, IGW, SG, IAM, EC2 A10G, EIP, S3, DynamoDB
│   ├── variables.tf          # aws_region, instance_type, ami_id, gamma_bridge_ip, tags
│   ├── outputs.tf            # elastic_ip, instance_id, s3_bucket_name
│   ├── backend.tf            # S3 backend + DynamoDB lock
│   └── packer/
│       └── voxhop-ami.pkr.hcl  # CUDA 12, Docker Engine, Docker Compose, model weights, comfort clip
├── piper-http/               # Sprint 0 unscoped deliverable (ID-01) — BLOCKS pipeline code
│   ├── main.py               # FastAPI: POST /tts → raw 24kHz PCM; piper subprocess kept alive
│   ├── requirements.txt
│   └── Dockerfile
├── docker-compose.yml        # whisper, ollama, piper-http, redis:7-alpine, voxhop
├── Makefile                  # bootstrap, build-ami, deploy, destroy, start, stop, logs, status
├── tsconfig.json             # "module": "commonjs" — per C-11 (avr-vad ESM interop)
├── package.json
└── vitest.config.ts
```

**Module Responsibilities**

`index.ts` — Process entry point. Calls `validateConfig()` (Zod, process.exit on failure per C-07), pre-warms both VAD instances via `ensureLoaded()` before binding the server (C-08), loads `comfortClipBuffer` into memory (C-09), then calls `startWebServer()`. The ordering is strict: validation → VAD warm → comfort load → listen.

`config.ts` — Single Zod schema for all env vars. Key validations: `VAD_SILENCE_THRESHOLD_MS` (min 200, max 2000), `VAD_MIN_SPEECH_MS` (min 50, max 1000), `LOCK_TTL_SECONDS` (default 10), `WHISPER_TIMEOUT_MS` (default 1000), `OLLAMA_TIMEOUT_MS` (default 500), `PIPER_TIMEOUT_MS` (default 300), `REDIS_URL`, `WHISPER_URL`, `OLLAMA_URL`, `PIPER_URL`, `COMFORT_CLIP_PATH` (default `/opt/voxhop/audio/comfort_en.pcm`), `PORT` (default 3000). Process exits with descriptive Zod error on any invalid value.

`schemas.ts` — Three mandatory Zod schemas (C-07):
- `CallInitiatedSchema`: `{ event: 'call_initiated', callId: string, timestamp: string }`
- `MediaStartedSchema`: exactly as C-02 — `tracks[]` array, `txTrackId`, `mediaFormat` with all four literal assertions. If `txTrackId` absent: schema rejects → WS closes immediately (fatal, no comfort clip).
- `WhisperResponseSchema`: `{ text: string }` — failure → comfort clip via `whisper_timeout` stage label.
- `OllamaResponseSchema`: `{ response: string }` — non-streaming (C-12) — failure → comfort clip via `ollama_timeout`.

`web-server.ts` — `http.createServer(httpHandler)` + `WebSocketServer({ noServer: true })`. HTTP handler serves only `/health` and `/metrics`. `server.on('upgrade')` checks pathname: `/ws/calls` → `wss.handleUpgrade(...)` → `wss.emit('connection', ws, req)`. Any other path → `socket.destroy()`. Per C-01.

```typescript
wss.on('connection', (ws, req) => {
    const handler = new VoxHopCallHandler(ws, redis, config, comfortClipBuffer);
    handler.start();
});
```

`call-handler.ts` — `VoxHopCallHandler` class. State: `callId: string`, `txTrackId: string`, `legs: Map<string, LegState>` (SD-02), `isActive: boolean`. On construction: registers `ws.on('message')` dispatcher (SD-03 pattern). Lifecycle event routing:

- `call_initiated`: parse via `CallInitiatedSchema`, read `frame.callId` directly (RF-03 fix, C-03), call `redis.initCallState(callId)`.
- `media_started`: parse via `MediaStartedSchema` (RF-02 fix, C-02), extract `callerTrackId` and `calledTrackId` from `tracks[]`, assert `txTrackId` present or close WS, initialise `LegState` per leg with pre-warmed VAD instance.
- `audio` frames: `legs.get(frame.trackId)` → `legState.vad.feed(pcm)` → if speechBuffer returned: `executeTurn(...).catch(...)` (SD-03, C-14 — no 20ms ticker).
- `call_ended` / `ws.on('close')`: `redis.cleanupCallState(callId)`, emit structured call-summary log, destroy VAD instances.

`pipeline.ts` — Five functions, one `try/catch` (SD-01). Linear `async` flow:

```typescript
async function executeTurn(callId, trackId, txTrackId, leg, speechBuffer, ws, config, redis, metrics) {
    const acquired = await redis.acquireLock(trackId, config.lockTtlSeconds);
    if (!acquired) return;                         // silently discard — lock held
    const t0 = Date.now();
    try {
        const transcript = await callWhisper(speechBuffer, config);  const t1 = Date.now();
        const echoText   = await callOllama(transcript, config);      const t2 = Date.now();
        const piperPcm   = await callPiper(echoText, config);         const t3 = Date.now();
        const pcm16k     = downsampleTo16k(piperPcm, 24000);
        injectAudio(ws, callId, txTrackId, pcm16k);
        const t4 = Date.now();
        metrics.emitTurn({ t0, t1, t2, t3, t4, leg, outcome: 'success' });
    } catch (err: StagedError) {
        injectComfortClip(ws, callId, txTrackId, comfortClipBuffer);
        metrics.emitFailure({ stage: err.stage, leg });
    } finally {
        await redis.releaseLock(trackId);
    }
}
```

`callWhisper()` — Builds `FormData` with WAV-wrapped PCM buffer, POSTs to `WHISPER_URL/v1/audio/transcriptions` with `AbortSignal.timeout(1000)` (C-10). Throws `StagedError('whisper')` on timeout or HTTP error. Validates response via `WhisperResponseSchema`.

`callOllama()` — POSTs `{ model, prompt: text, system: echoSystemPrompt, stream: false }` to `OLLAMA_URL/api/generate` with `AbortSignal.timeout(500)` (C-10, C-12). Validates response via `OllamaResponseSchema`. Logs transcript vs. Ollama output side-by-side (ACC-05).

`callPiper()` — POSTs `{ text }` to `PIPER_URL/tts` with `AbortSignal.timeout(300)` (C-10). Returns raw 24kHz PCM binary body as `Buffer`. Throws `StagedError('piper')` on timeout.

`redis.ts` — `ioredis` client (C-05). Four helpers:
- `acquireLock(trackId, ttl)`: `SET leg:{trackId}:processing 1 EX {ttl} NX` → returns `result === 'OK'`
- `releaseLock(trackId)`: `DEL leg:{trackId}:processing`
- `initCallState(callId)`: `SET call:{callId}:state active EX 14400` (4h TTL)
- `cleanupCallState(callId)`: `DEL call:{callId}:state` + any leg lock keys

`metrics.ts` — `prom-client` Registry. Four `Histogram` instances with buckets tuned for per-stage latency ranges (`[50, 100, 200, 300, 500, 750, 1000, 1500, 2000]`ms). All histograms carry `{ leg: ['caller','called'], outcome: ['success','whisper_timeout','ollama_timeout','piper_timeout','error'] }` labels. `Counter` `turnFailures_total` with `{ stage, leg }`. `/metrics` HTTP endpoint on the main server.

**Piper HTTP Wrapper (ID-01 — Sprint 0 deliverable)**

`piper-http/main.py` — Python FastAPI. Single endpoint `POST /tts`. Accepts `{ "text": "..." }` JSON body. Spawns `piper` subprocess with `--model /models/en_GB-alan-medium.onnx --output-raw` piping stdin/stdout. Returns raw binary response with `Content-Type: audio/L16; rate=24000`. Subprocess is kept alive between requests via `stdin` pipe to avoid per-request startup overhead (~100ms per invocation if re-spawned).

**Infrastructure**

`infra/main.tf` provisions: VPC (`10.0.0.0/16`), single public subnet (`eu-north-1a`), IGW + route table, security group (TCP 3000 inbound from `telco-ai-bridge` private IP; TCP 443 inbound; all egress), IAM instance profile with SSM + S3 + `tag:GetResources` (ID-04), EC2 `g5.xlarge` (A10G, 24GB VRAM) from Packer AMI with user-data `docker compose up -d`, EIP, S3 debug bucket (`force_destroy = true`), DynamoDB lock table. All resources tagged `Project=voxhop`.

`infra/packer/voxhop-ami.pkr.hcl` builds on Ubuntu 22.04 in `eu-north-1`: installs CUDA 12.x + NVIDIA Container Toolkit, Docker Engine + Compose v2, pulls faster-whisper Large v3 weights, Ollama + Gemma 4, Piper ONNX + `en_GB-alan-medium` voice pack, bakes `comfort_en.pcm` via `piper --model ... --output-file comfort_en.pcm < <(echo "One moment please.")`, runs GPU smoke test (`docker run --gpus all nvidia/cuda:12.2.0-runtime nvidia-smi`). `make build-ami` wraps `packer build`.

---

#### 4.4.2 Complexity Score

**8 / 10**

| Factor | Weight | Assessment |
|:-------|:-------|:-----------|
| Week 1 deadline | High | 5 business days for IaC + 4 AI services + full test suite is aggressive |
| IaC from scratch | High | Terraform VPC + EC2 + Packer AMI with GPU drivers is non-trivial |
| GPU quota (ID-03) | High | 24–48h lead time is out of engineering control; could block live test |
| Piper HTTP wrapper (ID-01) | High | Unscoped, blocks TTS stage, unknown piper subprocess latency under 300ms budget |
| Four AI service integrations | Medium | Patterns are clear (HelloSurgery), but each has its own failure mode |
| Dual-leg VAD (avr-vad ONNX) | Medium | `SileroVAD` is a direct copy; callback timing under burst delivery is an unknown |
| Prometheus instrumentation | Low | `prom-client` is well-understood; four histograms + one counter |
| `make destroy` tag-scan gate | Low | Scripting the tag-scan is ~20 lines; correct IAM policy is the risk |
| CommonJS/ESM constraint | Low | `avr-vad` interop is known; tsconfig is a one-line fix |

**Why not 9**: The `executeTurn()` linear architecture (SD-01) keeps pipeline code straightforward. HelloSurgery provides battle-tested `SileroVAD` and `downsampleTo16k()`. The spec is unambiguous — no design decisions deferred to Engineering.

**Why not 7**: The Piper wrapper is a blocking dependency that Engineering must build from scratch before the TTS stage can be coded or tested. GPU quota timing is a genuine Week 1 threat. The acceptance criteria include a verified clean `make destroy` with tag-scan — this has burned past projects when IAM policies are misconfigured.

---

#### 4.4.3 Risks

In addition to the Risk Flags in §7.5 (RF-04 through RF-08), Engineering flags the following:

| ID | Severity | Risk | Mitigation |
|:---|:---------|:-----|:-----------|
| RE-01 | ⚠️ HIGH | **Piper subprocess latency under 300ms budget** — FastAPI subprocess startup overhead per request (~80–150ms cold) may cause systematic `piper_timeout` failures on the live demo. | Keep `piper` process alive across requests via persistent stdin pipe. Benchmark locally before AMI bake. If 300ms is unachievable, raise PIPER_TIMEOUT_MS to 500ms and adjust total ceiling. |
| RE-02 | ⚠️ HIGH | **A10G quota denied or delayed (EU-North-1)** — If quota approval takes >48h, the Week 1 live test is blocked. We cannot validate GPU performance without real hardware. | Terraform variables support `eu-west-1` fallback (ID-03). Prepare `g5.xlarge` → `g4dn.xlarge` instance type variable as secondary fallback. Begin Terraform testing in `eu-west-1` on CPU instances from Day 1. |
| RE-03 | ⚠️ MEDIUM | **avr-vad callback timing under burst frame delivery** — The `SileroVAD.feed()` contract returns `completedSegment` on the *next* `feed()` call after `onSpeechEnd` fires. If frames arrive faster than 20ms (network jitter), the segment may be consumed out of sequence. | Add Vitest fixture tests at 10ms and 40ms inter-frame intervals in addition to the standard 20ms cadence. This validates the callback handoff under abnormal timing. |
| RE-04 | ⚠️ MEDIUM | **Docker Compose GPU passthrough silently degraded** — If NVIDIA Container Toolkit is not correctly installed in the Packer AMI, Whisper and Ollama containers start on CPU without error, producing correct but 10–30× slower inference. First-turn 1000ms Whisper timeout will fire systematically. | Packer provisioner includes `docker run --gpus all nvidia/cuda:12.2.0-runtime nvidia-smi` as a build-time smoke test. If this fails, `packer build` fails — the bad AMI is never produced. |
| RE-05 | ⚠️ MEDIUM | **Redis lock not released on VoxHop process crash mid-turn** — The 10-second TTL is the safety net. However, if the process crash happens *immediately* after lock acquisition, the leg is blocked for up to 10 seconds on restart. | This is acceptable per §3.5 (TTL is the dead-man switch). Tested explicitly in `chaos.test.ts` (ACC-11). |
| RE-06 | ℹ️ LOW | **`make destroy` tag-scan fails due to IAM policy missing `tag:GetResources`** — `AccessDeniedException` on the tag-scan is a silent destroy failure (ACC-14 hard gate). | `infra/main.tf` IAM policy includes `tag:GetResources` on `*` resource (ID-04). This is tested in isolation before live deploy. |
| RE-07 | ℹ️ LOW | **Whisper WAV wrapping** — faster-whisper `/v1/audio/transcriptions` expects a valid audio file, not raw PCM. We must wrap the PCM buffer in a minimal WAV header before POSTing. Forgetting this produces a 400 response which triggers the comfort clip. | `buildWav()` pattern exists in `HelloSurgery/audio-utils.ts:146`. Include it in VoxHop `audio-utils.ts` alongside `downsampleTo16k()`. |

---

#### 4.4.4 Sprint 0 Blockers

The following must be resolved **before any pipeline code (`call-handler.ts`, `pipeline.ts`) can be written or tested**. These are not Day 1 tasks — they are pre-conditions for Day 1 pipeline work.

| Order | Blocker | Why It Blocks | Owner |
|:------|:--------|:--------------|:------|
| S0-1 | **Submit A10G GPU quota** (`eu-north-1`, `g5.xlarge`) | Without quota approval, no live test is possible. 24–48h lead time means this must be submitted before any other work begins. Also prepare `eu-west-1` fallback Terraform variables. | DevOps, ~2 hours |
| S0-2 | **Build and validate Piper HTTP wrapper** (`piper-http/`) | `callPiper()` in `pipeline.ts` cannot be implemented or tested until the HTTP wrapper exists and responds correctly. The `docker-compose.yml` depends on `piper-http/Dockerfile`. | Eng-B, Day 1 |
| S0-3 | **Validate all three Zod schemas against `telco-ai-bridge` source** | `call-handler.ts` frame routing depends on correct schema shapes. Schemas must be verified against `media-worker/rx.go buildMediaStartedFrame` and `buildLifecycleFrame` before any handler code trusts them. | Eng-B, Day 1–2 |
| S0-4 | **Terraform state backend bootstrapped** (`make bootstrap`) | `make deploy` cannot run without the S3 backend bucket and DynamoDB lock table. This is a one-time idempotent operation per account. | Eng-A, Day 1 |
| S0-5 | **Packer AMI built and AMI ID recorded** | `infra/main.tf` `ami` variable must be populated before `make deploy`. AMI build takes 30–60 minutes. It cannot be started until CUDA driver versions and model weight URLs are confirmed. | Eng-A, Day 2–3 |

**ID-01 (Piper HTTP wrapper) is the critical path blocker** — it gates every pipeline integration test.

---

#### 4.4.5 Ticket Breakdown

Twelve engineering tickets, ordered by dependency. Two engineers working in parallel: **Eng-A** (Infrastructure track) and **Eng-B** (Pipeline track). Day numbering assumes Monday start.

| Ticket | Day | Eng | Title | Deliverable | Dependencies |
|:-------|:----|:----|:------|:------------|:-------------|
| **T-00** | Day 0 | DevOps | Submit A10G GPU quota | `eu-north-1` quota request submitted; `eu-west-1` fallback documented | None |
| **T-01** | Day 1 | A | Project scaffold + Makefile skeleton | `package.json`, `tsconfig.json` (`"module":"commonjs"`, C-11), `vitest.config.ts`, `Makefile` (`bootstrap`, `build-ami`, `deploy`, `destroy`, `start`, `stop`, `logs`, `status` targets — bodies stubbed) | None |
| **T-02** | Day 1 | B | Zod schemas + frame-shape tests | `config.ts` (env-var schema, process.exit on fail), `schemas.ts` (CallInitiated, MediaStarted w/ `tracks[]`, Whisper, Ollama), `test/frame-shape.test.ts` (parse/reject against real telco-ai-bridge frame samples) | None |
| **T-03** | Day 2 | B | Piper HTTP wrapper **(Sprint 0 blocker ID-01)** | `piper-http/main.py` (FastAPI, persistent subprocess), `piper-http/Dockerfile`, `docker-compose.yml` with whisper/ollama/piper-http/redis/voxhop services + health checks | T-01 |
| **T-04** | Day 2 | A | Terraform IaC — base infrastructure | `infra/main.tf` (VPC, subnet, IGW, SG, IAM w/ `tag:GetResources`, EIP, S3, DynamoDB), `variables.tf`, `outputs.tf`, `backend.tf`; `make bootstrap` validated | T-01 |
| **T-05** | Day 3 | A | Packer AMI template | `infra/packer/voxhop-ami.pkr.hcl` (CUDA 12, Docker Engine + Compose, faster-whisper weights, Ollama + Gemma 4, Piper + `en_GB-alan-medium`, comfort clip bake, GPU smoke test); `make build-ami` validated | T-04 |
| **T-06** | Day 3 | B | VAD + audio-utils + VAD unit tests | `src/silero-vad.ts` (copy from HelloSurgery, replace `loadLocalVoiceConfig()` with Zod config), `src/audio-utils.ts` (copy `downsampleTo16k()` + add `buildWav()` for Whisper WAV wrapping), `test/vad.test.ts` (PCM fixtures at 10ms/20ms/40ms cadence, speech detection, silence gating, discard on lock held) | T-02 |
| **T-07** | Day 4 | B | Redis + Prometheus metrics | `src/redis.ts` (ioredis, acquireLock/releaseLock/initCall/cleanupCall), `src/metrics.ts` (4 histograms + turnFailures_total counter, `/metrics` HTTP endpoint) | T-02, T-06 |
| **T-08** | Day 4 | B | Pipeline execution + comfort clip | `src/comfort.ts` (readFileSync singleton, injectComfortClip), `src/pipeline.ts` (executeTurn linear SD-01, callWhisper/callOllama/callPiper with AbortSignal.timeout, StagedError typed throws) | T-03, T-06, T-07 |
| **T-09** | Day 4 | A | Terraform EC2 + `make deploy` (fallback region) | Add EC2 `g5.xlarge` + user-data `docker compose up -d` to `main.tf`; validate `make deploy`/`make destroy` end-to-end in `eu-west-1` (CPU mode while A10G quota pending); verify tag-scan returns zero post-destroy | T-04, T-05 |
| **T-10** | Day 5 | B | Call handler + web server + `index.ts` | `src/call-handler.ts` (VoxHopCallHandler, lifecycle events, Map<trackId,LegState> SD-02, frame router SD-03), `src/web-server.ts` (WS server per C-01), `src/index.ts` (startup sequence: config → VAD pre-warm C-08 → comfort load C-09 → listen); integration smoke test with mock WS frames | T-06, T-07, T-08 |
| **T-11** | Day 5 | A | Chaos + latency instrumentation tests | `test/chaos.test.ts` (Whisper killed: comfort fires, call stays open, `turnFailures_total{stage="whisper"}` increments, leg resumes; repeat for ollama/piper; lock TTL expiry → leg recovers within 10s; dual-leg independence ACC-09), `test/metrics.test.ts` (all 4 histograms emit per turn, outcome labels correct) | T-10 |
| **T-12** | Day 5 (stretch) | Both | Live A10G deploy + ACC checklist | `make deploy` on real `eu-north-1` A10G; Whisper health gate (ID-05) implemented in `make start`; live Gamma DID call with developer echo test; ACC-01 through ACC-15 checklist sweep; `make destroy` + tag-scan zero-orphan verification (ACC-14 hard gate); `telco-ai-bridge` customer config updated (ID-02) | T-09, T-10, T-11, GPU quota |

**Parallelism notes**:
- Eng-A (T-01 → T-04 → T-05 → T-09 → T-11 → T-12): Infrastructure-first track. Not blocked by Piper wrapper.
- Eng-B (T-02 → T-03 → T-06 → T-07 → T-08 → T-10 → T-12): Pipeline-first track. T-03 (Piper wrapper) is the critical path item — complete it before any `callPiper()` integration tests.
- T-12 (live test) requires both engineers and GPU quota approval. If GPU quota is delayed, T-09 (`eu-west-1` CPU fallback) allows all other acceptance criteria to be validated in CPU mode before the live demo.

*ENGINEERING CO-SIGN: ✅ COMPLETE — 2026-06-05*

---

## 5. ACCEPTANCE CRITERIA

### 5.1 Functional (The Happy Path)

| ID | Criterion | Verified |
|:---|:----------|:---------|
| ACC-01 | `make deploy` provisions the full VoxHop AI stack on `eu-north-1` from a fresh environment with no manual steps beyond environment variable configuration. The deployed stack is reachable and all services report healthy within 30 minutes of `make deploy` completing. | ☐ |
| ACC-02 | `telco-ai-bridge`'s media-worker successfully connects to VoxHop's WebSocket server endpoint (`/ws/calls`). VoxHop receives `call_initiated` (with bridge-assigned `callId`) and `media_started` (with `tracks[]` array containing both `caller` and `called` entries, and a `txTrackId` for audio injection). | ☐ |
| ACC-03 | Silero VAD detects end-of-speech and fires independently on both the `caller` leg and the `called` leg during a single live call. VAD firing on one leg does not suppress VAD processing on the other leg. | ☐ |
| ACC-04 | Whisper STT achieves ≥90% Word Error Rate accuracy on a 20-phrase PSTN codec test set (G.711 A-law → 16kHz PCM, representative EU English phrases). This test set is committed as a regression fixture. | ☐ |
| ACC-05 | Ollama receives the Whisper transcript via the tightly constrained echo prompt and returns output within the 500ms timeout. The STT transcript and Ollama output are logged side-by-side in a structured JSON log entry for every turn. | ☐ |
| ACC-06 | Piper synthesises the Ollama echo output to audio. VoxHop downsamples from 24kHz to 16kHz S16LE and injects the audio frame to the originating leg's WebSocket track. The caller hears synthesised audio within the 1.8s ceiling. | ☐ |
| ACC-07 | All four Prometheus histogram metrics (`voxhop_vad_to_stt_ms`, `voxhop_stt_to_llm_first_token_ms`, `voxhop_llm_to_tts_first_byte_ms`, `voxhop_tts_to_inject_ms`) emit real numeric values for every completed turn. Metrics are visible on the Prometheus endpoint (`/metrics`). | ☐ |
| ACC-08 | When Whisper, Ollama, or Piper is killed mid-call: the call WebSocket connection remains open, the comfort clip ("One moment please.") is injected to the affected leg within 2× the per-stage timeout, `turnFailures_total` increments with the correct `stage` label, and subsequent turns on both legs resume normally. | ☐ |
| ACC-09 | Both legs operate simultaneously and independently during a live call. A processing turn on Leg A does not prevent Leg B from concurrently acquiring its own Redis lock and executing its own echo turn. | ☐ |
| ACC-10 | The Redis processing lock (`leg:{trackId}:processing`) prevents concurrent processing jobs on the same leg. If VAD fires on a leg that is already processing, the new fire is discarded silently. | ☐ |
| ACC-11 | If a processing job crashes without explicitly releasing the lock, the 10-second TTL causes the lock to expire automatically. The leg resumes accepting new VAD fires within 10 seconds of the crash. | ☐ |
| ACC-12 | On `call_ended` event or WebSocket close, all `call:{callId}:*` Redis keys are explicitly deleted. A structured call-summary log entry is emitted with `callId` and call duration. | ☐ |
| ACC-13 | `VAD_SILENCE_THRESHOLD_MS` and `VAD_MIN_SPEECH_MS` environment variables override the VAD defaults. An invalid value (outside documented range) causes VoxHop to exit at startup with a descriptive Zod validation error, not silently. | ☐ |
| ACC-14 | `make destroy` successfully tears down all VoxHop AWS resources. The automated post-destroy tag-scan (`Project=voxhop`) returns zero results. This criterion is a **hard gate** — Track 1 is not DONE without a verified clean destroy. | ☐ |
| ACC-15 | All four mandatory test categories pass: (a) frame-shape tests, (b) VAD unit tests with PCM fixtures, (c) chaos resilience tests (Whisper/Ollama/Piper each killed independently), (d) latency instrumentation tests asserting all four histograms emit values. | ☐ |

### 5.2 Negative (The Unhappy Path)

> **Integration Test Co-Sign — 2026-06-05**
> *22 adversarial criteria covering protocol violations, AI service degradation, concurrent stress, infrastructure failures, audio edge cases, call lifecycle edge cases, and comfort clip failure modes.*

#### Category A: Protocol Violations

| ID | Criterion | Test Scenario | Verified |
|:---|:----------|:-------------|:---------|
| NEG-01 | When `media_started` is received with `txTrackId` absent, VoxHop MUST close the WebSocket immediately and emit a structured error log. No comfort clip is injected. No Redis `call:{callId}:*` state is initialised. `turnFailures_total` MUST NOT be incremented — this is a fatal configuration error, not a turn failure. | Send a valid `call_initiated` followed by a `media_started` frame with the `txTrackId` field omitted. Assert: WebSocket closes within 100ms. Assert: `call:{callId}:state` is absent from Redis. Assert: `turnFailures_total` counter is unchanged. Assert: Structured pino error log emitted naming `txTrackId` as the missing field. | ☐ |
| NEG-02 | When `media_started` arrives with a non-canonical `mediaFormat` (e.g., `sampleRate: 8000`, `encoding: "audio/pcma"`, or `channels: 2`), VoxHop MUST close the WebSocket immediately with a structured Zod validation error log. No VAD ring buffers are initialised. No comfort clip is played. This is a fatal misconfiguration, not a degradable runtime failure. | Send `media_started` with `mediaFormat.sampleRate = 8000` (all other fields valid). Assert: WebSocket closes within 100ms. Assert: No Prometheus metric increments. Assert: Structured error log contains the Zod validation failure detail (field path + received vs. expected value). Assert: Redis has no leg lock keys. | ☐ |
| NEG-03 | When `media_started` arrives on a connection that has NOT yet received `call_initiated` (out-of-order delivery), VoxHop MUST discard the frame without initialising VAD state or Redis keys. VoxHop MUST NOT crash or emit an unhandled error. The missing `callId` context must not cause a JavaScript `TypeError` (e.g., accessing `.callId` on undefined). | Send `media_started` as the very first frame on a fresh WebSocket connection (skip `call_initiated`). Assert: No `call:*` or `leg:*` keys created in Redis. Assert: No VAD ring buffers instantiated. Assert: VoxHop process remains running. Assert: No unhandled promise rejection logged. | ☐ |
| NEG-04 | When a second `call_initiated` frame (with a different `callId`) arrives on an already-active, fully-configured connection, VoxHop MUST NOT re-initialise call state or create a second call context. Only the first `callId` remains active. Existing VAD state and Redis keys for the first call are not destroyed. | After full call setup (`call_initiated` → `media_started` → VAD active with audio frames flowing), send a second `call_initiated` with `callId = "INTRUDER-999"`. Assert: `call:INTRUDER-999:state` is absent from Redis. Assert: `call:{original-callId}:state` remains intact with original TTL. Assert: VAD continues processing on the original call legs. | ☐ |
| NEG-05 | Audio frames arriving with a `trackId` not present in the established `legs` Map (i.e., a trackId that was not in the `tracks[]` array from `media_started`) MUST be silently discarded per frame. VoxHop MUST NOT crash, MUST NOT create spurious VAD or Redis state for unknown track IDs, and MUST NOT log an error per frame (which would flood pino at 50fps). | After valid call setup, send 200 consecutive audio frames tagged with a random UUID `trackId` not from `tracks[]`. Assert: No crash. Assert: No new Redis keys created. Assert: Zero Whisper HTTP requests dispatched. Assert: `turnFailures_total` unchanged. Assert: No per-frame error log lines emitted (log volume must not scale with frame count). | ☐ |
| NEG-06 | When a valid `audio` frame arrives carrying a `payload` that is not valid base64 (invalid characters, truncated padding), `Buffer.from(payload, 'base64')` silently produces a truncated or empty buffer in Node.js. VoxHop MUST guard the VAD feed path: a zero-length or demonstrably malformed decoded buffer MUST be discarded before being fed into the Silero VAD ring buffer. Feeding corrupted bytes into VAD can cause spurious fires and phantom transcript turns. | Send an audio frame with `payload: "NOT!VALID@@BASE64###"`. Assert: No VAD fire triggered. Assert: No Whisper request dispatched. Assert: No comfort clip injected. Assert: Subsequent valid audio frames with correct base64 PCM are processed normally (VAD state not corrupted). | ☐ |

#### Category B: AI Service Degradation

| ID | Criterion | Test Scenario | Verified |
|:---|:----------|:-------------|:---------|
| NEG-07 | When Whisper returns a valid HTTP 200 response at exactly 1001ms (1ms past the 1000ms `AbortSignal.timeout()` boundary), the abort signal MUST have already fired. The comfort clip MUST be injected. `turnFailures_total{stage="whisper"}` MUST be incremented. Critically, the late-arriving Whisper response MUST NOT be forwarded to Ollama — no partial double-pipeline execution (comfort clip sent AND then synthesised audio arriving seconds later). | Mock Whisper HTTP endpoint to delay exactly 1001ms then return a valid `{"text": "hello"}`. Assert: Comfort clip injected to WebSocket (not synthesised audio). Assert: Zero Ollama HTTP requests. Assert: `turnFailures_total{stage="whisper"}` incremented by exactly 1. Assert: Redis lock released after comfort injection. Assert: The 1001ms response, when it arrives, is fully ignored (no second WebSocket send). | ☐ |
| NEG-08 | When Whisper returns HTTP 200 with an empty transcript (`"text": ""`), VoxHop MUST treat this as an inference-response Zod validation failure (empty string is not a valid transcript). The comfort clip MUST be injected, `turnFailures_total{stage="whisper"}` MUST be incremented, and Ollama MUST NOT be called with an empty string input. | Mock Whisper to return `{"text": "", "language": "en"}`. Assert: Comfort clip injected. Assert: Zero Ollama requests. Assert: `turnFailures_total{stage="whisper"}` incremented. Assert: `voxhop_vad_to_stt_ms` histogram STILL emits a value for this aborted turn (latency measurement captured even on failure). | ☐ |
| NEG-09 | When Ollama returns a response body that fails the Zod inference-response schema — e.g., a valid JSON object with missing `response` field, or an HTTP 200 with non-JSON body — VoxHop MUST inject the comfort clip, increment `turnFailures_total{stage="ollama"}`, release the Redis lock, and MUST NOT call Piper. | Mock Ollama to return HTTP 200 with body `{"error": "model not loaded"}` (valid JSON, wrong schema). Assert: Comfort clip injected. Assert: Zero Piper HTTP requests. Assert: `turnFailures_total{stage="ollama"}` incremented by 1. Assert: Redis lock released (next VAD fire is accepted). | ☐ |
| NEG-10 | When Piper returns HTTP 200 with a zero-byte audio body (empty response body, `Content-Length: 0`), VoxHop MUST inject the comfort clip rather than forwarding a zero-length audio payload to the WebSocket. Sending zero-length audio produces silence indistinguishable from a hung pipeline — the caller MUST hear "One moment please." not silence. `turnFailures_total{stage="piper"}` MUST be incremented. | Mock Piper to return `HTTP 200` with empty body and `Content-Length: 0`. Assert: Comfort clip injected (non-zero base64 payload). Assert: Zero-length audio frame NOT sent to WebSocket. Assert: `turnFailures_total{stage="piper"}` incremented. Assert: Redis lock released. | ☐ |

#### Category C: Concurrent Stress

| ID | Criterion | Test Scenario | Verified |
|:---|:----------|:-------------|:---------|
| NEG-11 | When VAD fires on Leg A (`callerTrackId`) and Leg B (`calledTrackId`) within the same Node.js event loop microtask queue drain (simultaneous speech detection), each leg MUST independently and successfully acquire its own Redis lock. Neither leg's `SET NX EX NX` MUST return `nil` due to the other leg's lock. Both turns MUST process concurrently without interference. | Inject simultaneous VAD fires on both legs at t=0ms using `Promise.all([fireLegA(), fireLegB()])`. Assert: Both Redis lock keys (`leg:{callerTrackId}:processing` AND `leg:{calledTrackId}:processing`) exist concurrently in Redis. Assert: Two concurrent Whisper HTTP requests are in-flight simultaneously. Assert: `voxhop_vad_to_stt_ms` emits exactly two histogram observations. Assert: `turnFailures_total` NOT incremented for either leg. | ☐ |
| NEG-12 | When VAD fires 3 times in rapid succession on the same leg (t=0ms, t=50ms, t=100ms) while the first turn's Redis lock is still held, ONLY the first turn MUST be processed. The second and third fires MUST be silently discarded — they MUST NOT increment `turnFailures_total` (a discarded VAD fire due to lock contention is a designed behaviour, not a failure). No queuing of discarded fires. After the first turn completes and the lock is released, the next NEW VAD fire IS processed normally. | Fire VAD 3× at 50ms intervals on one leg while mocking Whisper to take 400ms. Assert: Exactly 1 Whisper HTTP request made. Assert: Exactly 1 `voxhop_vad_to_stt_ms` histogram observation. Assert: `turnFailures_total` NOT incremented (discards are silent). Assert: After the 400ms turn completes, a fresh (4th) VAD fire IS accepted and processed. | ☐ |

#### Category D: Infrastructure Failures

| ID | Criterion | Test Scenario | Verified |
|:---|:----------|:-------------|:---------|
| NEG-13 | When the Redis connection drops after `call_initiated` (call state written successfully) but before a VAD fire triggers lock acquisition, the `SET NX EX NX` ioredis call MUST throw a connection error. VoxHop MUST catch this error, discard the turn, emit a structured pino error log (with `callId` and the ioredis error message), and MUST NOT crash. The WebSocket connection and all call processing MUST remain active. Comfort clip MUST NOT be injected — a Redis infrastructure failure is not a pipeline stage timeout. | Kill the Redis Docker container 500ms after `media_started`. Trigger a VAD fire. Assert: VoxHop Node.js process remains running (no process exit). Assert: WebSocket connection remains open. Assert: pino error log contains `callId`, `trackId`, and ioredis connection error. Assert: No unhandled promise rejection emitted to `process.on('unhandledRejection')`. Assert: Comfort clip NOT injected. | ☐ |
| NEG-14 | When the Redis processing lock TTL (10s dead-man switch) fires BEFORE the pipeline turn completes and the explicit `DEL leg:{trackId}:processing` is issued (e.g., lock acquired at t=0, Whisper takes 9.5s and times out, lock TTL fires at t=10s, then `DEL` is issued at t=10.1s), the `DEL` command MUST return 0 (key already gone). VoxHop MUST handle `DEL` returning 0 without throwing, crashing, or emitting an unhandled rejection. The leg MUST resume accepting new VAD fires. | Configure lock TTL env var to 1s in test. Mock Whisper to delay 1.5s (Whisper timeout fires at 1s, then comfort clip path runs, THEN `DEL` is issued when the lock key has already expired). Assert: No exception thrown from `redis.del()` returning 0. Assert: No unhandled promise rejection. Assert: No process crash. Assert: A subsequent VAD fire on the same leg IS processed (new `NX` lock can be acquired). | ☐ |
| NEG-15 | After `make destroy` exits with code 0 (Terraform destroy complete), the automated post-destroy AWS tag-scan MUST declare the destroy FAILED if `aws resourcegroupstaggingapi get-resources` returns ANY resource tagged `Project=voxhop` — including resources in `deleting`, `shutting-down`, or `terminating` transient states. The destroy script MUST NOT interpret transitional-state resources as a clean result. The "CLEAN DESTROY" success confirmation MUST NOT be emitted while any tagged resource remains visible to the Tagging API. | Mock `aws resourcegroupstaggingapi get-resources` to return one EC2 instance ARN in `shutting-down` state after Terraform destroy exits 0. Assert: `make destroy` exits with non-zero status code. Assert: Error message references the orphaned resource ARN. Assert: The clean-destroy success message is NOT emitted to stdout. | ☐ |

#### Category E: Audio Edge Cases

| ID | Criterion | Test Scenario | Verified |
|:---|:----------|:-------------|:---------|
| NEG-16 | When the VAD produces a zero-length PCM speech buffer (edge case where `vad.feed()` returns `Buffer.alloc(0)` — a truthy non-null object but with zero bytes), VoxHop MUST abort the turn BEFORE dispatching to Whisper. No HTTP request to the Whisper endpoint MUST be made. The comfort clip MUST be injected, `turnFailures_total{stage="whisper"}` MUST be incremented, and the Redis lock MUST be released. Sending a 0-byte FormData body to Whisper produces undefined behaviour on the server side. | Monkey-patch `vad.feed()` in the test harness to return `Buffer.alloc(0)` (empty buffer, truthy). Trigger VAD. Assert: Zero HTTP requests to Whisper endpoint. Assert: Comfort clip injected. Assert: `turnFailures_total{stage="whisper"}` incremented by 1. Assert: Redis lock released (verified by subsequent VAD fire being accepted). | ☐ |
| NEG-17 | When Piper returns a valid non-empty audio body that is entirely zero-valued bytes (all-zero PCM — electrical silence, e.g., a synthesiser that produces silence for an empty text edge case), VoxHop MUST inject it as a valid audio frame WITHOUT crashing. The `downsampleTo16k()` function MUST NOT produce NaN samples, a divide-by-zero, or throw a JavaScript `TypeError` or `RangeError` on all-zero input. Prometheus MUST emit `outcome=success`. This is a correctness test — all-zero PCM is valid audio. | Mock Piper to return `Buffer.alloc(48000)` (1 second of 24kHz silence, 48000 zero bytes). Assert: Audio frame sent to WebSocket with non-zero-length base64 payload. Assert: `voxhop_tts_to_inject_ms` emits a histogram value. Assert: Histogram `outcome=success` label applied. Assert: No JavaScript TypeError, RangeError, or NaN in the downsampled output buffer. | ☐ |
| NEG-18 | A 30-second speech turn produces approximately 960KB of S16LE PCM (30s × 16,000 samples/s × 2 bytes/sample). When this buffer is dispatched to Whisper, the 1000ms `AbortSignal.timeout()` MUST fire well before Whisper can transcribe 30s of audio. The comfort clip MUST be injected. VoxHop MUST NOT OOM-crash or exhibit unbounded memory growth from the large buffer being held across the pipeline stages. The 960KB buffer MUST be eligible for GC after the turn aborts. | Feed 30 seconds of synthetic 16kHz mono PCM (all-zero or sine-wave) through the VAD ring buffer until VAD fires. Assert: Whisper timeout fires within 1000ms of dispatch. Assert: Comfort clip injected. Assert: `turnFailures_total{stage="whisper"}` incremented. Assert: VoxHop Node.js `process.memoryUsage().rss` returns within 30% of pre-turn baseline within 5 seconds of turn cleanup (large buffer must not be retained). | ☐ |

#### Category F: Call Lifecycle Edge Cases

| ID | Criterion | Test Scenario | Verified |
|:---|:----------|:-------------|:---------|
| NEG-19 | When `call_ended` arrives while a pipeline turn is mid-flight (e.g., Whisper has completed but the Ollama HTTP request is pending), VoxHop MUST: (1) prevent synthesised audio or comfort clip from being sent to the already-closing WebSocket, (2) release the Redis lock, (3) delete all `call:{callId}:*` Redis keys, and (4) emit the call-summary log entry. CRITICALLY: no `"send to closed WebSocket"` error (`ERR_STREAM_WRITE_AFTER_END` or equivalent) MUST escape to `process.on('unhandledRejection')` — this would crash the process and drop ALL concurrent calls on the instance. | Open a call, trigger a VAD fire, mock Ollama to delay 400ms, inject `call_ended` at t=200ms (mid-Ollama-wait). Assert: No unhandled rejection emitted (verify via `process.on('unhandledRejection')` spy). Assert: All `call:{callId}:*` keys deleted from Redis within 500ms of `call_ended`. Assert: Call-summary pino log entry emitted. Assert: `leg:{trackId}:processing` lock is released (`Redis.EXISTS` returns 0). | ☐ |
| NEG-20 | When the WebSocket closes abruptly — TCP disconnect, media-worker crash, network partition — with NO `call_ended` frame received, VoxHop's `ws.on('close')` handler MUST perform identical cleanup to `call_ended`: delete all `call:{callId}:*` Redis keys and emit the call-summary log. The 4-hour Redis TTL is the safety net of last resort — explicit cleanup MUST occur on every observed close event. If a processing lock is held at time of WebSocket close, it MUST also be released explicitly. | Establish a full active call (Redis call state set, VAD processing), then call `ws.terminate()` on the bridge side (abrupt TCP close, no `call_ended` sent). Assert: `call:{callId}:state` key deleted from Redis within 500ms of `close` event. Assert: Call-summary pino log entry emitted with `callId` and `durationMs`. Assert: If a lock was held, `leg:{trackId}:processing` is also deleted (not left to expire via TTL). | ☐ |

#### Category G: Comfort Clip Failure

| ID | Criterion | Test Scenario | Verified |
|:---|:----------|:-------------|:---------|
| NEG-21 | When VoxHop starts with `COMFORT_CLIP_PATH` pointing to a file that does not exist on disk, `fs.readFileSync` at startup MUST throw. VoxHop MUST catch this, emit a structured pino error log naming the missing file path, and exit with a non-zero exit code BEFORE binding the WebSocket server port. The service MUST NOT start accepting connections in a state where graceful degradation is impossible — starting without a comfort clip means the first pipeline failure will produce an unhandled error instead of "One moment please." | Start VoxHop with `COMFORT_CLIP_PATH=/nonexistent/path/comfort_en.pcm`. Assert: Process exits with non-zero exit code. Assert: pino error log emitted referencing the missing file path before exit. Assert: No `listening` event on the HTTP server (port never bound). Assert: `make start` health-poll detects the non-zero exit and surfaces the failure. | ☐ |
| NEG-22 | When the comfort clip file exists at `COMFORT_CLIP_PATH` but has zero bytes (empty file), VoxHop MUST detect this at startup and exit with a non-zero exit code and descriptive error — NOT silently load an empty Buffer and start accepting calls. Injecting a zero-length comfort clip during a pipeline failure produces silence on the caller's line: indistinguishable from a hung call, and a direct violation of the graceful degradation contract ("One moment please." MUST be audible). | Create an empty file (0 bytes) at `COMFORT_CLIP_PATH` and start VoxHop. Assert: Process exits with non-zero code. Assert: Structured pino error log emitted stating the comfort clip is empty (0 bytes). Assert: No HTTP server `listening` event (port never bound). Assert: Comfort clip size validation is explicit — `comfortClipBuffer.length === 0` MUST be a startup fatal condition. | ☐ |

---

## 6. UI/UX DESIGN

> *Not applicable. Track 1 is a backend infrastructure feature with no user-facing interface. The Simulator UI is Track 2.*

---

## 7. ARCHITECTURAL GUIDANCE

> **Chief Architect INITIATE Co-Sign — 2026-06-05**
> *This section is authoritative. Engineering MUST follow these directives. Deviations require explicit Chief Architect approval before implementation.*

---

### 7.1 Alignment with Established Patterns

**VoxHop is architecturally aligned with two proven codebases. The following patterns are confirmed for direct reuse or close adaptation.**

#### From `HelloSurgery/gpu-voice-agent/src/`

| Module | Reuse Disposition | Notes |
|:-------|:-----------------|:------|
| `silero-vad.ts` (`SileroVAD` class) | **COPY INTO VOXHOP SOURCE** | Copy verbatim. Replace `loadLocalVoiceConfig()` wiring with Zod-validated env vars. The `feed(pcm16k: Buffer): Buffer \| null` contract and `avr-vad` ONNX integration are directly correct. |
| `audio-utils.ts` (`downsampleTo16k`) | **COPY INTO VOXHOP SOURCE** | Copy the single function verbatim. This is the ONLY audio conversion VoxHop performs: 24kHz Piper output → 16kHz for injection. No other functions from this file are needed in Track 1. |
| `gamma-audio-bridge.ts` (`GammaAudioBridge`) | **PATTERN — ADAPT, DO NOT IMPORT** | Structural pattern only: receive established `ws: WebSocket`, parse JSON text frames, route by `event` field, maintain `isActive` guard. VoxHop's handler is substantially different (dual-leg, Redis locks, echo pipeline) — do not subclass or import. |
| `web-server.ts` (WebSocketServer setup) | **PATTERN ONLY** | `WebSocketServer({ noServer: true })` + HTTP `upgrade` event routing. VoxHop's WS endpoint is `/ws/calls`. |
| `sentence-splitter.ts` | **NOT USED IN TRACK 1** | Scoped to Translation Layer (NEXT). Do not implement. |

#### From `telco-ai-bridge/` — Protocol facts confirmed by source inspection

| Source File | Confirmed Fact |
|:------------|:--------------|
| `docs/DEVELOPER.md` | `telco-ai-bridge` dials OUT to VoxHop's WS URL. VoxHop is the server. |
| `media-worker/rx.go` `buildMediaStartedFrame` | `media_started` uses `tracks[]` array, not flat `callerTrackId`/`calledTrackId` fields. |
| `media-worker/rx.go` `buildAudioFrame` | Inbound audio frames carry `event`, `callId`, `trackId`, `track`, `sequence`, `timestamp`, `payload` (base64 S16LE). |
| `media-worker/session.go` `handleInboundAudio` | Outbound injection requires `trackId` set to `txTrackId`. Wrong `trackId` = silent drop. |
| `media-worker/session.go` `buildLifecycleFrame` | `call_initiated` carries the canonical `callId` (bridge-assigned). VoxHop must NOT generate its own. |
| `ai-bridge/server.js` | `pino` + `ioredis` are the established patterns for logging and Redis. |

---

### 7.2 Constraints — MANDATORY

Engineering MUST follow every constraint below. Deviations require explicit Chief Architect approval.

#### C-01: VoxHop is a WebSocket SERVER

VoxHop MUST expose a WebSocket server endpoint. `telco-ai-bridge`'s media worker dials out to VoxHop's configured `wsUrl`. The correct server pattern (from `HelloSurgery/web-server.ts`):

```typescript
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';

const server = http.createServer(httpHandler);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;
    if (pathname === '/ws/calls') {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws, req) => {
    const callHandler = new VoxHopCallHandler(ws, redis, config);
    callHandler.start();
});
```

VoxHop's URL must be registered in `telco-ai-bridge`'s `customers.json`:
```json
{
  "+44<gamma-did>": {
    "mode": "ai_agent",
    "audioStream": "both",
    "wsUrl": "wss://<voxhop-elastic-ip>:3000/ws/calls"
  }
}
```

#### C-02: `media_started` Zod schema uses `tracks[]` array

```typescript
const MediaStartedSchema = z.object({
    event: z.literal('media_started'),
    callId: z.string(),
    tracks: z.array(z.object({
        trackId: z.string(),
        track: z.enum(['caller', 'called']),
    })).min(1),
    txTrackId: z.string(),
    mediaFormat: z.object({
        encoding: z.literal('audio/x-raw'),
        sampleRate: z.literal(16000),
        channels: z.literal(1),
        bitDepth: z.literal(16),
        payloadEncoding: z.literal('base64'),
    }),
    timestamp: z.string(),
});
```

If `txTrackId` is absent, close the WebSocket immediately — audio injection is impossible.

#### C-03: `call_initiated` callId is bridge-assigned — never generate your own

Use `frame.callId` from the `call_initiated` event directly.

#### C-04: Audio injection frame `trackId` must be `txTrackId`

```typescript
ws.send(JSON.stringify({
    event: 'audio',
    callId,
    trackId: txTrackId,   // MUST be txTrackId — NOT the caller/called trackId
    payload: pcm16kBuffer.toString('base64'),
}));
```

#### C-05: `ioredis` for Redis — NOT the `redis` npm package

```typescript
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);
const result = await redis.set(`leg:${trackId}:processing`, '1', 'EX', lockTtlSeconds, 'NX');
const acquired = result === 'OK';
await redis.del(`leg:${trackId}:processing`);
```

#### C-06: `pino` for all structured logging — child loggers per call and per leg

```typescript
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const callLog = logger.child({ callId });
const legLog = callLog.child({ trackId, leg: 'caller' });
// No console.log in any production code path
```

#### C-07: Three mandatory Zod schemas

1. **Startup env-var config** — validates all env vars; process exits with descriptive error on failure
2. **`media_started` frame** — (see C-02); validation failure closes the WebSocket, no comfort clip
3. **Inference service responses** — Whisper transcript, Ollama text; validation failure triggers comfort clip path

#### C-08: `avr-vad` VAD instances pre-warmed before accepting connections

```typescript
// During server startup, BEFORE listening for WebSocket connections:
await Promise.all([callerVad.ensureLoaded(), calledVad.ensureLoaded()]);
logger.info('Silero VAD ONNX model loaded — ready to accept calls');
```

Do NOT initialise VAD lazily on first call. Cold ONNX initialisation silently drops early audio frames.

#### C-09: Comfort clip loaded once at startup — cached as `Buffer`

```typescript
const comfortClipBuffer: Buffer = fs.readFileSync(config.comfortClipPath);
```

Never read the comfort clip from disk during a failure turn.

#### C-10: `AbortSignal.timeout()` for all per-stage HTTP timeouts

```typescript
const resp = await fetch(config.whisperUrl + '/v1/audio/transcriptions', {
    method: 'POST', body: formData,
    signal: AbortSignal.timeout(1000),
});
```

Use this pattern for all three inference services.

#### C-11: `"module": "commonjs"` in tsconfig

Follow `HelloSurgery/gpu-voice-agent/tsconfig.json`. The `avr-vad` package has ESM interop issues in Node.js 20. ESM migration is a future track concern.

#### C-12: Ollama uses non-streaming mode in Track 1

Use `stream: false`. The echo prompt returns one sentence — streaming upgrade (with `SentenceSplitter`) is scoped to the Translation Layer.

#### C-13: Vitest — not Jest

#### C-14: No 20ms send ticker in VoxHop

Send the complete synthesised audio as a single JSON frame. `telco-ai-bridge` handles the 20ms drain cadence and silence fill internally (PCMA `0xD5`).

---

### 7.3 Simplicity Directives

Track 1 is a Week 1 internal demo. Avoid these complexity traps.

#### SD-01: Linear `async` function for the turn pipeline — no event-driven stage chaining

```typescript
async function executeTurn(callId, trackId, txTrackId, leg, speechBuffer, ws) {
    const acquired = await acquireLock(trackId);
    if (!acquired) return;
    const t0 = Date.now();
    try {
        const transcript = await callWhisper(speechBuffer);   const t1 = Date.now();
        const echoText   = await callOllama(transcript);      const t2 = Date.now();
        const piperPcm   = await callPiper(echoText);         const t3 = Date.now();
        injectAudio(ws, callId, txTrackId, downsampleTo16k(piperPcm, 24000));
        const t4 = Date.now();
        emitMetrics({ t0, t1, t2, t3, t4, leg, outcome: 'success' });
    } catch (err) {
        injectComfortClip(ws, callId, txTrackId);
        emitMetrics({ t0, t1: Date.now(), leg, outcome: `${err.stage}_timeout` });
    } finally {
        await releaseLock(trackId);
    }
}
```

Five functions. One `try/catch`. This is the complete pipeline.

#### SD-02: `Map<trackId, LegState>` — not a leg management class hierarchy

```typescript
interface LegState { vad: SileroVAD; leg: 'caller' | 'called'; txTrackId: string; }
const legs = new Map<string, LegState>();
```

#### SD-03: Direct `vad.feed()` return value — no EventEmitter between decoder and dispatcher

```typescript
ws.on('message', (raw) => {
    const frame = parseFrame(raw);
    if (frame.event !== 'audio') { handleLifecycleEvent(frame); return; }
    const legState = legs.get(frame.trackId);
    if (!legState) return;
    const speechBuffer = legState.vad.feed(Buffer.from(frame.payload, 'base64'));
    if (speechBuffer) {
        executeTurn(callId, frame.trackId, legState.txTrackId, legState.leg, speechBuffer, ws)
            .catch(err => callLog.error({ err }, 'executeTurn unhandled error'));
    }
});
```

#### SD-04: No retry logic — timeouts trigger comfort clip immediately

On any stage timeout or HTTP error: inject comfort clip, release lock, emit metric, return. No retry. No exponential backoff. No circuit breaker.

#### SD-05: No WebSocket reconnect logic in VoxHop

`telco-ai-bridge` manages connection lifecycle. `ws.on('close')` cleans up Redis and destroys VAD instances. The next call is a new WebSocket connection.

---

### 7.4 Infrastructure Dependencies

#### ID-01: Piper HTTP wrapper — unscoped sub-deliverable, BLOCKS implementation

Piper ONNX is a CLI tool. Engineering must build a thin HTTP wrapper as Sprint 0 work before the TTS stage can be implemented. Minimum viable API:

```
POST /tts
Body:     { "text": "..." }
Response: raw binary 24kHz PCM (Content-Type: audio/L16; rate=24000)
```

Recommended: Python FastAPI container wrapping the `piper` subprocess. Must be in `docker-compose.yml` before pipeline code begins.

#### ID-02: `telco-ai-bridge` customer config — operational step

Register VoxHop in `customers.json` with `mode: "ai_agent"`, `audioStream: "both"`, and VoxHop's WSS URL. Without this, no calls are routed to VoxHop.

#### ID-03: A10G GPU quota — submit immediately, Day 1

`eu-north-1` quota requests take 24–48 hours minimum. Prepare `eu-west-1` fallback variables in Terraform.

#### ID-04: IAM — `tag:GetResources` permission required for destroy gate

```hcl
statement {
  actions   = ["tag:GetResources"]
  resources = ["*"]
}
```

Without this, the ACC-14 tag-scan fails with `AccessDeniedException`.

#### ID-05: Whisper startup health gate

Implement a `/health` endpoint that returns `503` until a test Whisper transcription succeeds. `make start` must poll this before declaring the service ready. Whisper Large v3 takes 10–30 seconds to load into VRAM on first start — the first real turn's 1000ms timeout would otherwise trigger the comfort clip on every first call.

---

### 7.5 Risk Flags

| ID | Severity | Risk | Mitigation |
|:---|:---------|:-----|:-----------|
| RF-01 | 🚨 BLOCKER | ~~§4.1 described VoxHop as WebSocket CLIENT~~ | **CORRECTED in this spec** |
| RF-02 | 🚨 BLOCKER | ~~§3.1 described flat track ID fields~~ | **CORRECTED in this spec** |
| RF-03 | 🚨 BLOCKER | ~~§3.1 said VoxHop allocates callId~~ | **CORRECTED in this spec** |
| RF-04 | ⚠️ HIGH | `avr-vad` ONNX cold start drops early frames if not pre-warmed | See C-08 |
| RF-05 | ⚠️ HIGH | Piper HTTP wrapper is unscoped — blocks TTS stage | See ID-01 |
| RF-06 | ⚠️ MEDIUM | Whisper first-request VRAM load exceeds 1000ms — comfort clip on first turn without health gate | See ID-05 |
| RF-07 | ⚠️ MEDIUM | `eu-north-1` A10G quota — 24–48hr lead time | See ID-03 |
| RF-08 | ℹ️ LOW | MASTER_VISION mentions ESM; established pattern is CommonJS | See C-11 |

*ARCHITECT CO-SIGN: ✅ INITIATE COMPLETE — 2026-06-05*

---

### 7.7 REVIEW Outcome

> **Chief Architect REVIEW Co-Sign — 2026-06-05**

**ARCHITECT CO-SIGN: ✅ REVIEW COMPLETE — APPROVED**

#### Verdict Summary

The specification is architecturally sound and cleared for Sponsor presentation. All three BLOCKER corrections (RF-01/02/03) are properly integrated at every layer — §3, §4.4, and §5.2 are mutually consistent on the WS server role, `tracks[]` schema shape, and bridge-assigned `callId`. HelloSurgery pattern reuse is correctly scoped: `silero-vad.ts` and `downsampleTo16k()` copied verbatim; `GammaAudioBridge` and `web-server.ts` adapted by pattern only; `sentence-splitter.ts` explicitly excluded. IaC coverage is comprehensive. The `make destroy` tag-scan is correctly modelled as a hard gate (ACC-14). The 22 negative criteria cover all critical failure modes with precise, executable test scenarios — particularly NEG-19 (mid-turn `call_ended` → unhandled WS rejection, which would crash the process and drop all concurrent calls). All 10 MASTER_VISION non-negotiable philosophies are satisfied. No upstream compatibility risk with `telco-ai-bridge` — VoxHop interacts exclusively via the public JSON WebSocket protocol.

#### Engineering Clarifications (mandatory pre-implementation reading — no co-sign redo required)

| ID | Ticket | Clarification |
|:---|:-------|:--------------|
| GAP-01 | T-02 | `WhisperResponseSchema` must use `z.string().min(1)` — not `z.string()`. NEG-08 requires empty transcripts to trigger the comfort clip. `z.string()` accepts `""` as valid and will silently pass empty transcripts to Ollama. |
| GAP-02 | T-08 | TypeScript does not permit type annotations on catch clause variables (`catch (err: StagedError)` is a compile error TS1196). Use `instanceof` narrowing: `const stage = err instanceof StagedError ? err.stage : 'unknown'`. |
| GAP-03 | T-08 | `callPiper()` must explicitly check for zero-byte response: `if (piperPcm.length === 0) throw new StagedError('piper')`. Required for NEG-10 to pass. |
| GAP-04 | T-07/T-10 | `cleanupCallState(callId)` cannot locate `leg:{trackId}:processing` keys via the `call:{callId}:*` pattern. `VoxHopCallHandler.cleanup()` must iterate `this.legs` and call `redis.releaseLock(trackId)` for each active leg **before** calling `cleanupCallState(callId)`. NEG-20 requires explicit deletion, not TTL expiry. |
| GAP-05 | Docs | §3.2 arithmetic error (documentation only, no code impact): "4 × 20ms = 3,072 samples" is wrong. The correct value is **1,536 samples** (96ms × 16,000Hz / 1,000 = 1,536). Engineering copies `FRAME_SAMPLES = 1536` directly from HelloSurgery and will not be misled, but §3.2 should be corrected in a future documentation pass. |

*ARCHITECT CO-SIGN: ✅ REVIEW COMPLETE — APPROVED — 2026-06-05*

---

## 8. DELIVERY & STATUS

### Phase
`NOW`

### Dependencies

*   Active `telco-ai-bridge` instance with a Gamma DID configured for VoxHop interception
*   `eu-north-1` A10G GPU instance quota approved in the AWS account
*   Terraform state backend bootstrapped (`make bootstrap` run once)
*   Gamma network private link provisioned by Gamma's infrastructure team
*   Piper `en_GB-alan-medium` voice pack available for AMI build
*   Whisper Large v3 model weights available for AMI build
*   Ollama + Gemma 4 model available for AMI build

### Co-Signs

| Agent | Status | Date |
|:------|:-------|:-----|
| Product Owner | ✅ COMPLETE | 2026-06-05 |
| Chief Architect (INITIATE) | ✅ COMPLETE | 2026-06-05 |
| UI/UX Specialist | ⏭ SKIPPED — backend only | — |
| Engineering Team | ✅ COMPLETE | 2026-06-05 |
| Integration Test | ✅ COMPLETE | 2026-06-05 |
| Chief Architect (REVIEW) | ✅ COMPLETE | 2026-06-05 |
| Sponsor Approval | ✅ APPROVED | 2026-06-06 |

### Regression Radius

*Track 1 is the foundational feature. No existing VoxHop features to regress against — this is the first. All subsequent features depend on Track 1 completing.*

*   Track 2 (Simulator + AI Counterparty) — depends on the `telco-ai-bridge` WebSocket interface established here
*   Translation Layer (NEXT) — depends on the STT → LLM → TTS pipeline proven here
*   Debug Instrumentation (NEXT) — depends on the Redis call state and structured logging patterns established here
