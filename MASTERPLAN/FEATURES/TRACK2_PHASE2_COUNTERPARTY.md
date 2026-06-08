# FEATURE: Track 2 Phase 2 — AI Counterparty + Direct Mode

> **Track**: NEXT — Phase 1 DONE, Phase 2 ready to start
> **Phase**: 2 of 3
> **Umbrella**: [`TRACK2_SIMULATOR.md`](TRACK2_SIMULATOR.md)

---

## 1. PROBLEM STATEMENT

Phase 1 delivers a provably working infrastructure skeleton: HTTPS endpoint, AudioWorklet, persona grid. But no call can be made and no AI responds. Phase 2 turns the infrastructure into a working tool.

**Problem 1 — No Counterparty pipeline.** The `voxhop-counterparty` service is a health-check stub after Phase 1. Engineering cannot validate VAD, Whisper STT, Ollama LLM, or Piper TTS in the Counterparty context without Phase 2.

**Problem 2 — No call flow.** The frontend has no Dial button. The Simulator Backend has no call session management. A developer cannot speak to an AI persona yet.

**Problem 3 — Direct Mode requires a new wire-protocol topology.** The Counterparty must implement the telco-ai-bridge non-replace wire protocol as a standalone WebSocket server — so that in future phases, telco-ai-bridge itself can connect to the Counterparty directly to simulate the B-leg of a live PSTN call. The topology must be validated in Direct Mode before Phase 3 introduces the full Replace Mode chain.

**Problem 4 — No app-layer deploy pipeline.** Today, any application code change requires a full AMI rebuild (~25 minutes). With three application services (`voxhop-app`, `voxhop-simulator`, `voxhop-counterparty`) all changing frequently across phases, AMI-per-commit is unsustainable. A fast, repeatable app-layer deploy path is required before Phase 2 development begins.

---

## 2. VISION

At the end of Phase 2, a developer can:

1. Select an EU-language persona from the persona grid.
2. Click **Dial (Direct)**.
3. Immediately hear the persona greet them in its language (conversation opener).
4. Speak into the browser mic.
5. Hear the persona's contextually coherent response in its language.
6. See a live transcript of both sides of the conversation in the browser.
7. See per-turn pipeline telemetry (STT latency, LLM time-to-first-token, TTS time, total).
8. Click **Hang Up** to end the call cleanly.

The Counterparty runs a full `avr-vad → Whisper → Ollama → Piper` pipeline as a **standalone WebSocket server** speaking the standard telco-ai-bridge non-replace wire protocol. `voxhop-app` is **not involved** in Direct Mode. The Simulator Backend acts as the caller-side bridge — connecting to the Counterparty as a WebSocket client, sending `call_initiated` / `media_started`, relaying audio, and aggregating metadata — exactly as `gamma-simulator-web.ts` does in the HelloSurgery pattern.

The `/gamma/audio` WebSocket between Simulator Backend and Counterparty carries **only** standard telco-ai-bridge protocol frames. All transcript and pipeline metadata flows on a **separate `/events` WebSocket** on the Counterparty, aggregated by the NestJS Simulator Backend and forwarded to the browser on the existing single `/ws/simulator` connection. This separation keeps the gamma wire protocol clean and scales cleanly to Phase 3, where `voxhop-app` will add its own metadata stream through the same aggregation channel.

A new **ECR app-layer deploy pipeline** replaces AMI rebuilds for application code changes. The AMI is stabilised as a base layer (CUDA, Ollama, Whisper, Piper, models only). App images are pushed to ECR and reloaded on the instance via EC2 Instance Connect SSH — from any `make deploy-app` invocation in under five minutes.

---

## 3. CORE CAPABILITIES

### 3.1 Counterparty AI Pipeline (VAD → Whisper → Ollama → Piper)

- **Trigger**: `media_started` received on `/gamma/audio` WebSocket (call session established). Per-turn trigger: VAD fires on incoming audio frames after previous turn's `processingTurn` lock is released.
- **Input**: Persona config from `call_initiated.customData` (name, language, piperVoice, systemPrompt, conversationOpener). LPCM16 16kHz mono audio frames arriving as JSON `audio` events on `rxTrackId`.
- **Output**: LPCM16 16kHz mono audio frames injected as JSON `audio` events on `txTrackId`. Metadata events emitted on the separate `/events` WebSocket per turn.
- **Behaviour**:
  - On `call_initiated`: parse and store persona config from `customData`.
  - On `media_started`: if `conversationOpener` is present in the persona config, immediately synthesise it via Piper (persona `piperVoice`) and inject as `audio` frames on `txTrackId`. This is the first audio the developer hears — no speech required to trigger it.
  - Per turn (VAD → pipeline): avr-vad feeds incoming audio frames → VAD fires and collects completed speech buffer → POST to Whisper STT (persona language) → emit `{ event: "transcript", role: "user", text, timestamp }` on `/events` → POST to Ollama (persona `systemPrompt` + 50-turn FIFO conversation history) → stream tokens, emitting `{ event: "llm_token", token, timestamp }` per token on `/events` → collect full response text → emit `{ event: "transcript", role: "counterparty", text, timestamp }` on `/events` → POST to Piper (persona `piperVoice`) → inject LPCM audio frames on `txTrackId` → emit `{ event: "turn_latency", sttMs, llmMs, ttsMs, totalMs }` on `/events`.
  - `processingTurn` lock: while a turn is in-flight, incoming audio frames are silently discarded. No comfort audio injected. Lock releases when Piper audio frames have been fully injected.
  - Per-stage `StagedError` on timeout or 5xx: pipeline aborts cleanly, lock released, error event emitted on `/events`.
  - Conversation history (50-turn FIFO) held in memory for the duration of the call. Discarded on `call_ended` or WebSocket close.
  - avr-vad ONNX model pre-warmed on service startup before WebSocket server begins accepting connections.

### 3.2 Direct Mode Call Flow (Simulator Backend)

- **Trigger**: Browser sends `{ type: "dial", personaId: "<id>" }` JSON message over the existing `/ws/simulator` WebSocket.
- **Input**: `personaId` (resolved to full persona config from `counterparties/` directory). Browser mic audio as raw binary `ArrayBuffer` (Float32 48kHz frames) over `/ws/simulator`.
- **Output**: Counterparty synthesised speech as raw binary `ArrayBuffer` (Float32 48kHz frames) to browser. Transcript and metadata events as JSON frames to browser on `/ws/simulator`. Clean teardown on `{ type: "hangup" }` or browser disconnect.
- **Behaviour**:
  - On `{ type: "dial", personaId }`: load persona JSON; assign `callId` (UUID), `rxTrackId` (UUID), `txTrackId` (UUID).
  - Open WebSocket CLIENT connection to `ws://voxhop-counterparty:3001/gamma/audio`.
  - Send in sequence: `{ event: "call_initiated", callId, timestamp, customData: { persona: <full persona object> } }` → wait 50ms → `{ event: "call_answered", callId, timestamp }` → wait 100ms → `{ event: "media_started", callId, tracks: [{ trackId: rxTrackId, track: "caller" }], txTrackId, mediaFormat: { encoding: "audio/x-raw", sampleRate: 16000, channels: 1, bitDepth: 16, payloadEncoding: "base64" }, timestamp }`.
  - Open a second WebSocket CLIENT connection to `ws://voxhop-counterparty:3001/events`.
  - Audio relay — inbound (browser → Counterparty): browser binary frames (Float32 48kHz) → downsample + convert to base64 S16LE 16kHz → send as `{ event: "audio", callId, trackId: rxTrackId, payload }`.
  - Audio relay — outbound (Counterparty → browser): receive `{ event: "audio", payload }` on `txTrackId` → decode base64 S16LE 16kHz → upsample to Float32 48kHz → send as raw binary `ArrayBuffer` to browser.
  - Metadata relay: all events received on `/events` WebSocket forwarded to browser as JSON with `source: "counterparty"` field added.
  - On `{ type: "hangup" }` or browser WS close: send `{ event: "call_ended", callId }` on `/gamma/audio`; close both Counterparty WebSocket connections; release session state.
  - Only one active Direct Mode call per browser WebSocket session. A second `{ type: "dial" }` while a call is active is rejected with `{ type: "error", reason: "call_already_active" }`.
  - Future extensibility: Phase 3 Replace Mode will open a third connection to `voxhop-app`; its `/events` stream will flow through the same aggregation channel with `source: "voxhop"`.

### 3.3 Direct Mode Frontend

- **Trigger**: Phase 1 persona grid rendered in `ready` state; user selects a persona card and clicks **Dial (Direct)**.
- **Input**: Persona selection, Dial click, browser mic audio (from existing `pcm-capture-processor` AudioWorklet), Hang Up click.
- **Output**: Call state UI (`idle → connecting → active → ended | error`), live transcript panel, pipeline telemetry panel, Hang Up button active during call.
- **Behaviour**:
  - **Dial**: lock persona selection and mode toggle; send `{ type: "dial", personaId }` over `/ws/simulator`; transition to `connecting`; begin streaming mic AudioWorklet frames as binary to backend.
  - **State transitions**: `connecting → active` on first binary audio frame received from backend (Counterparty opener or first response); `active → ended` on clean `{ type: "call_ended" }` or successful hangup; `active → error` on unexpected WS close or `{ type: "error" }`.
  - **Transcript panel**: append entries on `{ event: "transcript" }` — `role: "user"` shows developer speech in source language; `role: "counterparty"` shows persona response in persona language, with language badge.
  - **LLM token stream**: real-time token-by-token rendering on `{ event: "llm_token" }` in the telemetry panel as Ollama generates the response.
  - **Telemetry panel**: per-turn row appended on `{ event: "turn_latency" }` showing STT / LLM / TTS / total milliseconds.
  - **Hang Up**: send `{ type: "hangup" }`; transition to `ended`; unlock persona selection.
  - **ErrorBanner**: displayed on `error` state with reason; UI allows re-dial after error.
  - `processingTurn` state: visual indicator shown while Counterparty pipeline is in-flight (between VAD fire and first TTS audio frame received).

### 3.4 Metadata Stream (Counterparty `/events` → NestJS → Browser)

- **Trigger**: Active Direct Mode call session.
- **Input**: Counterparty pipeline events (transcript turns, LLM token stream, per-turn latency, pipeline errors).
- **Output**: Live transcript and telemetry data in browser panels, independent of audio framing.
- **Behaviour**:
  - Counterparty exposes a second WebSocket server at `/events` on port 3001 (alongside `/gamma/audio`).
  - Events emitted on `/events` per turn: `transcript` (user, after Whisper), `llm_token` (per token, during Ollama), `transcript` (counterparty, after Ollama), `turn_latency` (after Piper injection complete), `pipeline_error` (on `StagedError`).
  - Simulator Backend connects to `/events` at call start, alongside `/gamma/audio`. Both connections share the same `callId` scope.
  - All `/events` frames forwarded to browser on `/ws/simulator` as JSON, tagged `source: "counterparty"`. Binary (audio) and JSON (metadata) coexist on the single browser WebSocket — distinguished by frame type (`instanceof ArrayBuffer` vs parsed JSON).
  - This channel is additive: Phase 3 will add `source: "voxhop"` events from `voxhop-app`'s own `/events` endpoint. No browser-side changes required.

### 3.5 ECR App-Layer Deploy Pipeline

- **Trigger**: Developer makes application code changes to any of `voxhop-app`, `voxhop-simulator`, or `voxhop-counterparty` and runs `make deploy-app`.
- **Input**: Updated source code in the monorepo.
- **Output**: Updated application images running on the EC2 instance. Deployment completes in under 5 minutes. No AMI rebuild required.
- **Behaviour**:
  - Three ECR repositories provisioned via Terraform (one per app service). IAM role on the EC2 instance granted `ecr:GetAuthorizationToken` + `ecr:BatchCheckLayerAvailability` + `ecr:GetDownloadUrlForLayer` + `ecr:PullImage`. Developer workstations granted `ecr:PushImage`.
  - `make deploy-app` sequence: `docker build` → `docker push` to ECR → `aws ec2-instance-connect send-ssh-public-key` (temporary 60-second key) → `ssh` to instance → `docker compose pull <services> && docker compose up -d <services>`.
  - Docker Compose updated: app-layer services pull images from ECR tags. Slow-layer services (Ollama, Whisper, Piper) remain AMI-baked and are not affected by `make deploy-app`.
  - AMI layer stabilises at: CUDA runtime, Docker Engine, Ollama + Gemma4 model, faster-whisper + large-v3 model, Piper + all EU voice packs. AMI is rebuilt only when these base dependencies change.
  - Any developer with AWS CLI credentials and the `ec2-instance-connect:SendSSHPublicKey` + ECR push IAM policies can deploy. No permanent SSH keys required.

---

## 4. TECHNICAL IMPLEMENTATION

**Engineering Team CO-SIGN — 2026-06-07**

This section is the binding technical implementation plan. All architectural constraints from §7 are incorporated. Deviations and corrections are flagged explicitly.

---

### 4.1 Complexity Assessment

**Complexity score: 8 / 10**

**Justification**: This feature spans five distinct systems simultaneously — a new Node.js TypeScript service built from scratch, a major NestJS gateway rebuild, a 7-field state machine extension with 11 new React components, an ECR deploy pipeline, and coordinated Docker Compose + Terraform additions. The non-trivial risks are concentrated in three areas: (1) streaming NDJSON buffer management for Ollama, (2) per-session stateful audio transcoding in NestJS, and (3) the synchronicity requirements of the `processingTurn` lock.

**Key risks and mitigations**:

| Risk | Severity | Mitigation |
|:-----|:---------|:-----------|
| **Ollama NDJSON line buffer split** — TCP chunks can split across JSON line boundaries; naïve `JSON.parse(chunk)` corrupts parsing | High | Maintain a `lineBuffer: string` accumulator; split on `\n`; keep the last incomplete line for the next chunk. Use `TextDecoder` with `{ stream: true }` for multi-byte safety. |
| **`processingTurn` lock race** — VAD fires while `runTurn()` is at first `await`; if lock is set after `await`, two turns launch concurrently | High | Set `this.processingTurn = true` synchronously in `handleAudioFrame()` BEFORE calling `runTurn()`. JavaScript single-thread guarantees no concurrent message event can fire until current synchronous code completes. The `finally` block in `runTurn()` releases the lock. |
| **`InboundAudioTranscoder` singleton corruption** — a module-level singleton accumulator would corrupt concurrent browser sessions | High | `InboundAudioTranscoder` is a plain `class` instantiated `new InboundAudioTranscoder()` inside each `CallSession` object. It is never registered as a NestJS `@Injectable()`. |
| **10-second connecting timeout fires after call active** — if timeout ref not cleared on `CALL_ACTIVE`, error fires during live call | Medium | `clearTimeout(session.connectingTimeout)` called immediately when the first binary audio frame is forwarded to the browser. Timeout ref stored on `CallSession`. |
| **`/events` callId validation timing** — Simulator opens `/events` after 150ms+ delay; if `call_initiated` not yet processed, `activeHandler.getCallId()` is null and socket is destroyed | Low | The 50ms + 100ms delays in the Simulator dial sequence (§3.2) provide >150ms buffer before `/events` upgrade. In the upgrade handler, `activeHandler` must expose `getCallId(): string | null`. The validation is at TCP socket level (before WS upgrade), so a destroyed socket is clean — the Simulator retries on error. Additionally, the connection ordering (`/gamma/audio` open → `call_initiated` sent → delays → `/events` open) makes this a very narrow window. |
| **`OllamaStreamChunkSchema` shape mismatch** — §7.4 specifies `{ response: string, done: boolean }` which is the `/api/generate` streaming format; `/api/chat` streaming returns `{ message: { role, content }, done: boolean }` | Medium | **Engineering correction**: Use the `/api/chat` schema shape for `OllamaStreamChunkSchema` per §7.11's explicit mandate of the chat API. See §4.2 `schemas.ts` for the corrected schema. The token field referenced as `chunk.response` in §7.6 maps to `chunk.message.content` in `/api/chat` streaming. This is a schema label correction only — the behaviour (emit token per chunk, accumulate fullResponse) is unchanged. |
| **VAD per-call warm-up** — `new SileroVAD()` inside `handleMediaStarted()` calls `ensureLoaded()` without await; if ONNX model is not yet cached, early audio frames are silently dropped | Low | Startup warmup (`validateConfig → new SileroVAD → ensureLoaded() → destroy → server.listen`) guarantees the ONNX model is resident in memory before any connection is accepted. avr-vad caches the model after first load. Per-call `ensureLoaded()` returns in microseconds on warm cache. |
| **ECR deploy 5-minute budget** — three parallel docker builds + three ECR pushes + SSH + compose up must complete in <5 minutes | Medium | Build stages must use multi-stage Dockerfiles with `--omit=dev` in production stage. Layer caching (consistent `COPY package.json` before `npm ci`) is critical. App-only images are small (~200MB). Compose `pull` on instance only pulls layers changed since last push. |

---

### 4.2 `voxhop-counterparty` — Full TypeScript Service

The Phase 1 `index.js` stub is **deleted in full**. The new service is a TypeScript package following the Track 1 pattern. No NestJS. No Redis. No cross-package imports from `voxhop/`.

#### `package.json`

```json
{
  "name": "voxhop-counterparty",
  "version": "2.0.0",
  "description": "VoxHop Counterparty — Phase 2 full AI pipeline (VAD → Whisper → Ollama → Piper)",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "avr-vad": "^1.x",
    "form-data": "^4.x",
    "pino": "^9.x",
    "ws": "^8.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/ws": "^8.x",
    "tsx": "^4.x",
    "typescript": "^5",
    "vitest": "^2.x"
  }
}
```

**Banned dependencies**: `ioredis`, `@nestjs/*`, `express`, `fastify`. Lock exact versions from `voxhop/package.json` for `avr-vad`, `pino`, `zod`, `ws`.

#### `tsconfig.json`

Mirror Track 1 exactly — CommonJS output required for avr-vad ESM interop (per C-11 comment in `voxhop/src/silero-vad.ts`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

#### `src/config.ts`

Mirror `voxhop/src/config.ts` pattern exactly. Remove Redis/lock/comfort clip fields. Timeout defaults are **longer** than Track 1 — real LLM generation takes seconds, not milliseconds.

```typescript
const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // Inference service URLs
  WHISPER_URL: z.string().url().default('http://localhost:8001'),
  OLLAMA_URL:  z.string().url().default('http://localhost:11434'),
  PIPER_URL:   z.string().url().default('http://localhost:5000'),

  // Ollama model
  OLLAMA_MODEL: z.string().default('gemma4'),

  // Timeouts (ms) — realistic for conversational pipeline (NOT echo-mode)
  WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  OLLAMA_TIMEOUT_MS:  z.coerce.number().int().positive().default(30000),
  PIPER_TIMEOUT_MS:   z.coerce.number().int().positive().default(10000),

  // VAD (same validated ranges as Track 1)
  VAD_SILENCE_THRESHOLD_MS: z.coerce.number().int().min(200).max(2000).default(600),
  VAD_MIN_SPEECH_MS:        z.coerce.number().int().min(50).max(1000).default(250),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function validateConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    logger.error({ errors: result.error.flatten() }, 'Counterparty startup failed: invalid configuration');
    process.exit(1);
  }
  return result.data;
}
```

**No** `REDIS_URL`, `LOCK_TTL_SECONDS`, or `COMFORT_CLIP_PATH`.

#### `src/schemas.ts`

All schemas are Counterparty-local per §7.4. No import from `voxhop/src/schemas.ts`.

```typescript
// PersonaSchema — MUST be identical to voxhop-simulator/src/persona/persona.schema.ts
// Deliberately duplicated per service boundary law (§7.1).
// When persona fields change, both files must be updated in the same commit.
export const PersonaSchema = z.object({
  id:                   z.string().min(1),
  name:                 z.string().min(1),
  language:             z.string().min(1),
  piperVoice:           z.string().min(1),
  systemPrompt:         z.string().min(1),
  conversationOpener:   z.string().optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

// CallInitiatedSchema — extends base with required customData.persona (§7.4)
// If customData is absent or persona fails validation, handler closes WS with code 1008.
export const CallInitiatedSchema = z.object({
  event:      z.literal('call_initiated'),
  callId:     z.string().min(1),
  timestamp:  z.string(),
  customData: z.object({
    persona: PersonaSchema,
  }),
});
export type CallInitiated = z.infer<typeof CallInitiatedSchema>;

// MediaStartedSchema — SINGLE caller track only (§7.4).
// Uses z.literal('caller') — NOT z.enum(['caller', 'called']).
// The Counterparty IS the called party; only the caller's track arrives.
export const MediaStartedSchema = z.object({
  event:      z.literal('media_started'),
  callId:     z.string().min(1),
  tracks:     z.array(z.object({
    trackId:  z.string().min(1),
    track:    z.literal('caller'),
  })).min(1),
  txTrackId:  z.string().min(1),
  mediaFormat: z.object({
    encoding:        z.literal('audio/x-raw'),
    sampleRate:      z.literal(16000),
    channels:        z.literal(1),
    bitDepth:        z.literal(16),
    payloadEncoding: z.literal('base64'),
  }),
  timestamp: z.string(),
});
export type MediaStarted = z.infer<typeof MediaStartedSchema>;

// AudioFrameSchema — incoming caller audio
export const AudioFrameSchema = z.object({
  event:     z.literal('audio'),
  callId:    z.string(),
  trackId:   z.string(),
  payload:   z.string(), // base64-encoded S16LE 16kHz PCM
  timestamp: z.string().optional(),
  sequence:  z.number().optional(),
});
export type AudioFrame = z.infer<typeof AudioFrameSchema>;

// OllamaStreamChunkSchema — Engineering correction to §7.4:
// /api/chat streaming returns { message: { role, content }, done } NOT { response, done }.
// { response, done } is the /api/generate format.
// §7.11 mandates /api/chat — this schema matches it.
export const OllamaStreamChunkSchema = z.object({
  message: z.object({
    role:    z.string(),
    content: z.string(),
  }),
  done: z.boolean(),
});
export type OllamaStreamChunk = z.infer<typeof OllamaStreamChunkSchema>;

// WhisperResponseSchema — identical to Track 1 (min(1) rejects empty transcripts)
export const WhisperResponseSchema = z.object({
  text: z.string().min(1, { message: 'Whisper returned empty transcript' }),
});
export type WhisperResponse = z.infer<typeof WhisperResponseSchema>;

// GenericFrameSchema — for event-type routing before full parse
export const GenericFrameSchema = z.object({
  event:   z.string(),
  callId:  z.string().optional(),
  trackId: z.string().optional(),
  payload: z.string().optional(),
});
```

#### `src/audio-utils.ts`

Copy `downsampleTo16k()` and `buildWav()` **verbatim** from `voxhop/src/audio-utils.ts`. Add file header noting origin. No other functions. The Counterparty uses:
- `buildWav()` — to wrap speech PCM in WAV header for Whisper POST
- `downsampleTo16k()` — to convert Piper 24kHz output to 16kHz for injection

No Float32 ↔ S16LE transcoding here; NestJS owns all transcoding (§7.8).

#### `src/silero-vad.ts`

Copy **verbatim** from `voxhop/src/silero-vad.ts`. Zero adaptations required. The `SileroVADConfig` interface, `SileroVAD` class, `feed()` return contract, `ensureLoaded()`, `reset()`, and `destroy()` are identical to Track 1 needs.

#### `src/pipeline.ts`

The Counterparty pipeline shares the structure of Track 1 (`StagedError`, `callWhisper`, `callPiper`, `injectAudio`) but replaces `callOllama` with `callOllamaStream` and removes `executeTurn`. Orchestration moves to `CounterpartyCallHandler.runTurn()`.

**`StagedError`** — copy verbatim from `voxhop/src/pipeline.ts`. Stages: `'whisper' | 'ollama' | 'piper' | 'unknown'`.

**`injectAudio(ws, callId, txTrackId, pcm16k)`** — copy verbatim from `voxhop/src/pipeline.ts` (C-04: must use `txTrackId`).

**`callWhisper(speechBuffer: Buffer, config: Config): Promise<string>`** — copy verbatim from Track 1. Same WAV wrapping, same 10s timeout (overridden in config), same `WhisperResponseSchema` validation, same `StagedError('whisper')` on failure.

**`callOllamaStream(messages: OllamaMessage[], config: Config, onToken: (token: string) => void): Promise<string>`** — Streaming deviation per §7.6:

```typescript
type OllamaMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function callOllamaStream(
  messages: OllamaMessage[],
  config: Config,
  onToken: (token: string) => void,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.OLLAMA_MODEL, messages, stream: true }),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new StagedError('ollama', `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new StagedError('ollama', `Ollama HTTP ${response.status}`);
  if (!response.body) throw new StagedError('ollama', 'Ollama response body is null');

  // NDJSON streaming — critical: split on '\n', keep incomplete tail across reads
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let fullResponse = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? ''; // keep incomplete last line
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const chunk = OllamaStreamChunkSchema.safeParse(parsed);
      if (!chunk.success) continue;
      if (chunk.data.message.content) {
        onToken(chunk.data.message.content);
        fullResponse += chunk.data.message.content;
      }
      if (chunk.data.done) return fullResponse;
    }
  }
  if (!fullResponse) throw new StagedError('ollama', 'Ollama stream ended with empty response');
  return fullResponse;
}
```

**`callPiper(text: string, config: Config, voice: string): Promise<Buffer>`** — adapts Track 1 `callPiper` to accept a `voice` parameter. Body: `{ text, voice }`. Per §7.7, Piper already supports `{ text, voice }` from Phase 1 M-04. GAP-03 zero-byte check retained.

#### `src/call-handler.ts`

```typescript
export class CounterpartyCallHandler {
  // ── Call session identity ────────────────────────────────────────────────
  private callId: string | null = null;
  private txTrackId: string | null = null;
  private rxTrackId: string | null = null;
  private persona: Persona | null = null;
  private isActive: boolean = true;
  private startTime: number = Date.now();
  private callLog: pino.Logger;

  // ── Pipeline half-duplex lock (§7.5) ─────────────────────────────────────
  // Must be set SYNCHRONOUSLY before any await in handleAudioFrame().
  // Released in the finally block of runTurn().
  private processingTurn: boolean = false;

  // ── Conversation history — 50-turn FIFO (§7.11) ──────────────────────────
  // Array<{ role: 'user' | 'assistant'; content: string }>
  // Cap at 100 entries (50 exchanges × 2 roles). shift() from front when exceeded.
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // ── Per-call VAD instance ────────────────────────────────────────────────
  // Instantiated in handleMediaStarted(). ensureLoaded() called without await
  // (ONNX model is cached from startup warmup — returns in microseconds).
  private vad: SileroVAD | null = null;

  // ── /events WebSocket reference ──────────────────────────────────────────
  // Set by server.ts when the Simulator connects to /events?callId=<uuid>.
  // Events emitted only when this is non-null and OPEN.
  private eventsWs: WebSocket | null = null;

  constructor(
    private readonly audioWs: WebSocket,
    private readonly config: Config,
  ) {
    this.callLog = logger.child({ handler: 'CounterpartyCallHandler' });
  }

  /** Called by server.ts when an /events client connects with matching callId. */
  setEventsWs(ws: WebSocket): void { this.eventsWs = ws; }

  /** Expose callId for /events upgrade routing validation (§7.10). */
  getCallId(): string | null { return this.callId; }

  start(): void { /* attach ws.on('message'), ws.on('close'), ws.on('error') */ }

  private handleMessage(raw: unknown): void {
    const frame = parseFrame(raw); // GenericFrameSchema.safeParse
    if (!frame) return;
    if (frame.event === 'audio') { this.handleAudioFrame(frame); return; }
    this.handleLifecycleEvent(frame, raw);
  }

  private handleCallInitiated(raw: unknown): void {
    // NEG-04 equivalent: ignore if callId already set
    // Parse CallInitiatedSchema — if customData.persona absent/invalid → ws.close(1008) (§7.4)
    // On success: this.callId = result.data.callId; this.persona = result.data.customData.persona
  }

  private handleMediaStarted(raw: unknown): void {
    // Parse MediaStartedSchema — validates z.literal('caller') track
    // Extract: this.rxTrackId = tracks[0].trackId; this.txTrackId = result.data.txTrackId
    // Instantiate VAD: this.vad = new SileroVAD({ vadSilenceDurationMs, vadMinSpeechDurationMs })
    // this.vad.ensureLoaded().catch(err => logger.error(err)) — fire-and-forget (ONNX cached)
    // Fire opener injection (fire-and-forget, does NOT set processingTurn):
    this.injectOpener().catch(err =>
      this.emitEvent({ event: 'pipeline_error', stage: 'opener', message: String(err) })
    );
  }

  // Conversation opener — synthesised immediately on media_started.
  // Does NOT set processingTurn. Failure emits pipeline_error but does NOT abort call.
  private async injectOpener(): Promise<void> {
    if (!this.persona?.conversationOpener || !this.isActive) return;
    const piperPcm = await callPiper(this.persona.conversationOpener, this.config, this.persona.piperVoice);
    const pcm16k = downsampleTo16k(piperPcm, 24000);
    injectAudio(this.audioWs, this.callId!, this.txTrackId!, pcm16k);
  }

  private handleAudioFrame(frame: GenericFrame): void {
    if (!this.callId || !this.txTrackId || !this.rxTrackId || !this.vad) return;
    if (frame.trackId !== this.rxTrackId) return; // discard non-caller tracks
    if (!frame.payload) return;

    // ── HALF-DUPLEX LOCK CHECK — top of handler, before any async ───────────
    if (this.processingTurn) return; // silently discard (§7.5)

    const decoded = Buffer.from(frame.payload, 'base64');
    if (decoded.length === 0) return;

    const speechBuffer = this.vad.feed(decoded);
    if (speechBuffer) {
      // ── SET LOCK SYNCHRONOUSLY before any await ──────────────────────────
      // JavaScript single-thread: no concurrent message event fires until
      // this synchronous frame completes. This is the only safe set point.
      this.processingTurn = true;
      void this.runTurn(speechBuffer);
    }
  }

  private async runTurn(speechBuffer: Buffer): Promise<void> {
    const t0 = Date.now();
    try {
      // Stage 1: Whisper STT
      let transcript: string;
      try {
        transcript = await callWhisper(speechBuffer, this.config);
      } catch (err) {
        const stage = err instanceof StagedError ? err.stage : 'unknown';
        this.emitEvent({ event: 'pipeline_error', stage, message: String(err), timestamp: Date.now() });
        return;
      }
      const t1 = Date.now();
      this.emitEvent({ event: 'transcript', role: 'user', text: transcript, timestamp: Date.now() });

      // Build chat messages: system prompt + 50-turn FIFO history + current input (§7.11)
      const messages: OllamaMessage[] = [
        { role: 'system', content: this.persona!.systemPrompt },
        ...this.conversationHistory,
        { role: 'user', content: transcript },
      ];

      // Stage 2: Ollama streaming
      let fullResponse: string;
      try {
        fullResponse = await callOllamaStream(
          messages,
          this.config,
          (token) => this.emitEvent({ event: 'llm_token', token, timestamp: Date.now() }),
        );
      } catch (err) {
        const stage = err instanceof StagedError ? err.stage : 'unknown';
        this.emitEvent({ event: 'pipeline_error', stage, message: String(err), timestamp: Date.now() });
        return;
      }
      const t2 = Date.now();
      this.emitEvent({ event: 'transcript', role: 'counterparty', text: fullResponse, timestamp: Date.now() });

      // Update 50-turn FIFO history (§7.11)
      this.conversationHistory.push({ role: 'user', content: transcript });
      this.conversationHistory.push({ role: 'assistant', content: fullResponse });
      while (this.conversationHistory.length > 100) this.conversationHistory.shift();

      // Stage 3: Piper TTS
      let piperPcm: Buffer;
      try {
        piperPcm = await callPiper(fullResponse, this.config, this.persona!.piperVoice);
      } catch (err) {
        const stage = err instanceof StagedError ? err.stage : 'unknown';
        this.emitEvent({ event: 'pipeline_error', stage, message: String(err), timestamp: Date.now() });
        return;
      }
      const t3 = Date.now();

      const pcm16k = downsampleTo16k(piperPcm, 24000);
      injectAudio(this.audioWs, this.callId!, this.txTrackId!, pcm16k);
      const t4 = Date.now();

      this.emitEvent({
        event: 'turn_latency',
        sttMs: t1 - t0, llmMs: t2 - t1, ttsMs: t3 - t2, totalMs: t4 - t0,
        timestamp: Date.now(),
      });
    } finally {
      // ALWAYS release lock — even on early return from stage failure
      this.processingTurn = false;
    }
  }

  private emitEvent(payload: unknown): void {
    if (this.eventsWs?.readyState === WebSocket.OPEN) {
      this.eventsWs.send(JSON.stringify(payload));
    }
  }

  async cleanup(): Promise<void> {
    if (!this.isActive) return;
    this.isActive = false;
    this.conversationHistory = [];
    if (this.vad) { await this.vad.destroy(); this.vad = null; }
    const durationMs = Date.now() - this.startTime;
    this.callLog.info({ callId: this.callId, durationMs }, 'Call ended — cleanup complete');
  }
}
```

#### `src/server.ts`

Two-WSS `noServer: true` upgrade router per §7.3. `/health` HTTP endpoint. Module-level `activeHandler` reference (Phase 2: one call at a time).

```typescript
// Module-level active handler — Phase 2 single-call constraint
let activeHandler: CounterpartyCallHandler | null = null;

export function startServer(config: Config): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  const wssAudio  = new WebSocketServer({ noServer: true });
  const wssEvents = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const { pathname, searchParams } = url;

    if (pathname === '/gamma/audio') {
      wssAudio.handleUpgrade(req, socket, head, ws => wssAudio.emit('connection', ws, req));
    } else if (pathname === '/events') {
      // §7.10: validate callId at TCP socket level — before WS upgrade
      const callId = searchParams.get('callId');
      if (!callId || !activeHandler || activeHandler.getCallId() !== callId) {
        socket.destroy();
        return;
      }
      wssEvents.handleUpgrade(req, socket, head, ws => wssEvents.emit('connection', ws, req));
    } else {
      socket.destroy();  // CP-05: all other paths destroyed
    }
  });

  wssAudio.on('connection', (ws, req) => {
    logger.info({ remoteAddress: req.socket.remoteAddress }, 'New /gamma/audio connection');
    const handler = new CounterpartyCallHandler(ws, config);
    activeHandler = handler;
    handler.start();
    ws.on('close', () => {
      if (activeHandler === handler) activeHandler = null;
      handler.cleanup().catch(err => logger.error({ err }, 'cleanup error on ws.close'));
    });
  });

  wssEvents.on('connection', (ws, req) => {
    // callId already validated in upgrade handler — safe to link
    const callId = new URL(req.url ?? '/', `http://localhost`).searchParams.get('callId');
    logger.info({ callId }, 'New /events connection');
    activeHandler?.setEventsWs(ws);
    ws.on('close', () => logger.debug({ callId }, '/events client disconnected'));
  });

  return server;
}
```

#### `src/index.ts`

Startup sequence per §7.9: `validateConfig → ensureLoaded → server.listen`. Port MUST NOT bind if either step fails.

```typescript
async function main(): Promise<void> {
  logger.info('voxhop-counterparty starting...');

  // Step 1: Config validation
  const config = validateConfig();

  // Step 2: VAD ONNX warm-up (BEFORE port bind — §7.9)
  logger.info('Pre-warming Silero VAD ONNX model...');
  const warmupVad = new SileroVAD({
    vadSilenceDurationMs: config.VAD_SILENCE_THRESHOLD_MS,
    vadMinSpeechDurationMs: config.VAD_MIN_SPEECH_MS,
  });
  try {
    await warmupVad.ensureLoaded();
  } catch (err: unknown) {
    logger.error({ err }, 'VAD ONNX model failed to load — aborting startup');
    process.exit(1);
  }
  await warmupVad.destroy();
  logger.info('Silero VAD ONNX model pre-warmed successfully');

  // Step 3: Start server (port binds here — after all pre-conditions satisfied)
  const server = startServer(config);
  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'voxhop-counterparty listening');
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch(err => { logger.error({ err }, 'main() threw'); process.exit(1); });
```

#### `Dockerfile`

Multi-stage build. Delete Phase 1 `index.js` and stub `Dockerfile` entirely.

```dockerfile
# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ───────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

---

### 4.3 `voxhop-simulator` — NestJS Extensions

#### New files

**`src/simulator/audio-transcoder.ts`** — Plain class (NOT `@Injectable()`). One instance per call session. Stateful sample accumulator for frame-boundary alignment.

```typescript
export class InboundAudioTranscoder {
  // Stateful accumulator — holds cross-frame Float32 remainders
  // Critical per §7.8: must be per-session instance, not singleton
  private sampleAccumulator: number[] = [];

  /**
   * Inbound: Float32 48kHz binary frame → S16LE 16kHz Buffer
   * Reference: HelloSurgery/scripts/gamma-simulator-web.ts lines 658–692
   * Algorithm: 3:1 decimation (take every 3rd sample, scale to int16)
   */
  processInbound(data: Buffer): Buffer | null {
    const float32 = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
    for (let i = 0; i < float32.length; i++) this.sampleAccumulator.push(float32[i]);
    if (this.sampleAccumulator.length < 3) return null;
    const outSamplesCount = Math.floor(this.sampleAccumulator.length / 3);
    const pcmBuffer = Buffer.alloc(outSamplesCount * 2);
    for (let i = 0; i < outSamplesCount; i++) {
      const val = this.sampleAccumulator[i * 3];
      const intVal = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
      pcmBuffer.writeInt16LE(intVal, i * 2);
    }
    // Preserve remainder to prevent sample boundary phase clicks
    this.sampleAccumulator = this.sampleAccumulator.slice(outSamplesCount * 3);
    return pcmBuffer;
  }

  /**
   * Outbound: base64 S16LE 16kHz → Float32 48kHz ArrayBuffer (for browser)
   * Reference: HelloSurgery/scripts/gamma-simulator-web.ts lines 602–619
   * Algorithm: 1:3 linear interpolation upsampling
   */
  static upsampleToFloat32(payload: string): ArrayBuffer {
    const pcmBuffer = Buffer.from(payload, 'base64');
    const inputSamplesCount = pcmBuffer.length / 2;
    const outFloat32 = new Float32Array(inputSamplesCount * 3);
    for (let i = 0; i < inputSamplesCount; i++) {
      const current = pcmBuffer.readInt16LE(i * 2) / 32768;
      const next = i < inputSamplesCount - 1 ? pcmBuffer.readInt16LE((i + 1) * 2) / 32768 : current;
      outFloat32[i * 3]     = current;
      outFloat32[i * 3 + 1] = current + (next - current) * (1 / 3);
      outFloat32[i * 3 + 2] = current + (next - current) * (2 / 3);
    }
    return outFloat32.buffer;
  }

  reset(): void { this.sampleAccumulator = []; }
}
```

**`src/simulator/call-session.service.ts`** — `@Injectable()` service holding per-client-WS call session state via `Map<WebSocket, CallSession>`.

```typescript
interface CallSession {
  callId: string;
  rxTrackId: string;
  txTrackId: string;
  persona: Persona;
  counterpartyAudioWs: WebSocket | null;
  counterpartyEventsWs: WebSocket | null;
  transcoder: InboundAudioTranscoder;  // new instance per session (§7.8)
  connectingTimeout: NodeJS.Timeout | null;
  isActive: boolean;
}

@Injectable()
export class CallSessionService {
  private readonly sessions = new Map<WebSocket, CallSession>();

  create(client: WebSocket, data: Omit<CallSession, 'transcoder' | 'connectingTimeout' | 'isActive'>): CallSession;
  get(client: WebSocket): CallSession | undefined;
  teardown(client: WebSocket): Promise<void>;
  // teardown: sends call_ended to counterpartyAudioWs, closes both counterparty WS,
  // clears connectingTimeout, removes from Map
}
```

#### Modified: `src/simulator/simulator.gateway.ts`

Replace Phase 1 stub entirely. Key design points:

**Constructor**: inject `PersonaLoader` and `CallSessionService`.

**`handleConnection(client: WebSocket)`**: send `{ type: "ack" }`; attach `client.on('message', ...)` and `client.on('close', ...)` handlers.

**`client.on('message', data, isBinary)`**:
- If `isBinary`: relay audio to counterparty (see inbound audio relay below)
- If text: parse JSON → route by `type`:
  - `"dial"` → `handleDial(client, payload)`
  - `"hangup"` → `handleHangup(client)`

**`handleDial(client, { personaId })`**:
1. Reject if session already active: `client.send(JSON.stringify({ type: "error", reason: "call_already_active" }))`
2. Find persona via `personaLoader.getPersonas().find(p => p.id === personaId)`; error if not found
3. Generate IDs: `callId = randomUUID()`, `rxTrackId = randomUUID()`, `txTrackId = randomUUID()`
4. Open WS to `${COUNTERPARTY_URL}/gamma/audio` (read from `process.env.COUNTERPARTY_URL ?? 'ws://voxhop-counterparty:3001'`)
5. On counterparty audio WS `open`: send protocol sequence:
   - `call_initiated` (with `customData: { persona }`) → wait 50ms
   - `call_answered` → wait 100ms
   - `media_started` (with `tracks: [{ trackId: rxTrackId, track: 'caller' }]`, `txTrackId`, `mediaFormat`)
6. Open WS to `${COUNTERPARTY_URL}/events?callId=${callId}`
7. Start 10-second connecting timeout (stored in session): `session.connectingTimeout = setTimeout(() => { client.send(JSON.stringify({ type: "error", reason: "connection_timeout" })); sessionService.teardown(client); }, 10000)`
8. Create `CallSession` via `callSessionService.create(...)`

**Counterparty audio WS `message` handler**:
- Parse JSON frame
- If `event === 'audio'` and `trackId === txTrackId`:
  - Clear connecting timeout (first audio frame = call active)
  - Send `{ type: "call_active" }` to browser (triggers `CALL_ACTIVE`)
  - `InboundAudioTranscoder.upsampleToFloat32(frame.payload)` → `client.send(float32Buffer)` as binary
- If `event === 'call_ended'`: `sessionService.teardown(client)`; send `{ type: "call_ended" }` to browser

**Counterparty events WS `message` handler**:
- Forward JSON to browser with `source: "counterparty"` field added:
  `client.send(JSON.stringify({ ...parsed, source: 'counterparty' }))`

**Inbound audio relay** (browser binary → counterparty):
- `const pcm16k = session.transcoder.processInbound(data as Buffer)`
- If `pcm16k === null`: accumulating (not enough samples yet)
- Else: `counterpartyAudioWs.send(JSON.stringify({ event: 'audio', callId, trackId: rxTrackId, payload: pcm16k.toString('base64') }))`

**`handleHangup(client)`**:
- `counterpartyAudioWs.send(JSON.stringify({ event: 'call_ended', callId, timestamp: new Date().toISOString() }))`
- `sessionService.teardown(client)`
- `client.send(JSON.stringify({ type: "call_ended" }))` — signals `HANG_UP_INITIATED` → `ended` transition

**`handleDisconnect(client)`**: `sessionService.teardown(client)` if session exists.

**Environment variable**: `COUNTERPARTY_URL` — added to `voxhop-simulator` docker-compose service env and read in gateway/service. Default: `ws://voxhop-counterparty:3001`.

#### Modified: `src/simulator/simulator.module.ts`

```typescript
@Module({
  imports: [PersonaModule],  // add — exports PersonaLoader (already done in persona.module.ts)
  providers: [SimulatorGateway, CallSessionService],  // add CallSessionService
})
export class SimulatorModule {}
```

#### `public/pcm-capture-processor.js` — changes

Phase 1 behaviour: the worklet's `process()` method captures mic audio. In Phase 1, the processor sends `{ type: 'pcm-capture-ready' }` on init but does not stream audio.

Phase 2 change: add audio frame posting in `process()`:

```javascript
// In the process() method — add after existing ready signal logic:
process(inputs, outputs, parameters) {
  const input = inputs[0];
  if (input && input[0] && input[0].length > 0) {
    // Transfer ownership for zero-copy — do NOT read buffer after this
    const channelData = input[0].slice(); // copy needed — input is reused by AudioWorklet
    this.port.postMessage({ type: 'audio-frame', data: channelData }, [channelData.buffer]);
  }
  return true;
}
```

In `App.tsx`, the `workletNode.port.onmessage` handler routes:
- `data.type === 'pcm-capture-ready'` → `dispatch({ type: 'WORKLET_READY' })`
- `data.type === 'audio-frame'` → if `callStatus === 'active'`, send `data.data` as binary ArrayBuffer over WS

**Audio playback** (received Float32 from server): use `AudioContext` + `AudioBufferSourceNode` scheduling queue. For each received binary frame in `App.tsx`:
```typescript
const float32 = new Float32Array(event.data);
const audioBuffer = audioContext.createBuffer(1, float32.length, 48000);
audioBuffer.copyToChannel(float32, 0);
const source = audioContext.createBufferSource();
source.buffer = audioBuffer;
source.connect(audioContext.destination);
source.start(nextPlayTime);
nextPlayTime = Math.max(audioContext.currentTime, nextPlayTime) + audioBuffer.duration;
```
`nextPlayTime` is a `useRef<number>` tracking the end of the last scheduled buffer to achieve gapless playback.

---

### 4.4 Frontend Changes

#### `src/types/persona.ts` — additions

Append to existing file (do not modify existing `Persona`, `MicStatus`, `WorkletStatus` types):

```typescript
export type CallStatus = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export interface TranscriptEntry {
  id: string;           // crypto.randomUUID()
  role: 'user' | 'counterparty';
  text: string;
  language: string;     // 'en' | 'es' | 'fr' | 'de' | 'it'
  timestamp: number;    // Date.now()
}

export interface TelemetryRow {
  turnIndex: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}
```

#### `src/state/appReducer.ts` — extensions

Extend `AppState` interface with 7 Phase 2 fields (do not remove Phase 1 fields):

```typescript
// Add to AppState:
callStatus: CallStatus;           // initial: 'idle'
selectedPersonaId: string | null; // initial: null
transcript: TranscriptEntry[];    // initial: []
llmTokenBuffer: string;           // initial: ''
processingTurn: boolean;          // initial: false
telemetry: TelemetryRow[];        // initial: []
callErrorMessage: string | null;  // initial: null
```

Extend `AppAction` union with all 11 new actions from §6.3.

Extend `initialState` with Phase 2 initial values.

**Reducer rules**:
- `PERSONA_SELECT` / `PERSONA_DESELECT`: only processed when `callStatus === 'idle'`
- `DIAL_INITIATED`: only from `callStatus === 'idle'`; sets `callStatus = 'connecting'`
- `CALL_ACTIVE`: only from `callStatus === 'connecting'`; sets `callStatus = 'active'`
- `TRANSCRIPT_RECEIVED (user)`: only in `active`; appends entry with `crypto.randomUUID()` id; sets `processingTurn = true`
- `LLM_TOKEN_RECEIVED`: only in `active`; `llmTokenBuffer += payload`
- `TRANSCRIPT_RECEIVED (counterparty)`: only in `active`; appends entry; `processingTurn = false`; `llmTokenBuffer = ''`
- `TURN_LATENCY_RECEIVED`: appends `TelemetryRow` with `turnIndex = telemetry.length`
- `HANG_UP_INITIATED`: only in `active`; `callStatus = 'ended'`
- `CALL_ENDED`: sets `callStatus = 'ended'`
- `CALL_ERROR`: `callStatus = 'error'`; `callErrorMessage = payload`
- `DISMISS_CALL_RESULT`: resets **all 7 Phase 2 fields** to initial values; Phase 1 fields (`status`, `personas`, etc.) are **not** reset

**Guard**: Ignore `TRANSCRIPT_RECEIVED`, `LLM_TOKEN_RECEIVED`, `TURN_LATENCY_RECEIVED` when `callStatus` is `'ended'` or `'error'` — race condition safety.

#### `src/App.tsx` — changes

New refs (add to existing set):
- `hangUpRef = useRef<HTMLButtonElement>(null)` — for Hang Up auto-focus
- `savedFocusRef = useRef<HTMLElement | null>(null)` — for focus restoration
- `connectingTimeoutRef = useRef<NodeJS.Timeout | null>(null)` — managed by NestJS, cleared on CALL_ACTIVE
- `nextPlayTimeRef = useRef<number>(0)` — AudioBufferSourceNode scheduling queue
- `wsRef = useRef<WebSocket | null>(null)` — persistent WS reference for dial/hangup sends

**Boot sequence**: unchanged — existing `useEffect([], [])` not modified.

**New useEffect: Hang Up auto-focus** (per §6.8):
```typescript
useEffect(() => {
  if (state.callStatus === 'active') {
    setTimeout(() => hangUpRef.current?.focus(), 50);
  }
}, [state.callStatus]);
```

**New `handleDial(personaId: string)`**:
1. `savedFocusRef.current = document.querySelector(`[data-persona-id="${personaId}"]`) as HTMLElement`
2. `dispatch({ type: 'DIAL_INITIATED' })`
3. `wsRef.current?.send(JSON.stringify({ type: 'dial', personaId }))`

**New `handleHangup()`**:
1. `dispatch({ type: 'HANG_UP_INITIATED' })`
2. `wsRef.current?.send(JSON.stringify({ type: 'hangup' }))`

**New `handleDismiss()`**:
1. `dispatch({ type: 'DISMISS_CALL_RESULT' })`
2. `savedFocusRef.current?.focus()`

**WS `message` handler additions** (add to existing handler setup):
```typescript
ws.addEventListener('message', (event) => {
  if (event.data instanceof ArrayBuffer) {
    // Binary: counterparty TTS audio — schedule for playback
    dispatch({ type: 'CALL_ACTIVE' });  // First binary = call active (idempotent)
    const float32 = new Float32Array(event.data);
    // Schedule via AudioBufferSourceNode (see §4.3 audio playback)
    scheduleAudioPlayback(float32);
    return;
  }
  // Text: JSON metadata
  const msg = JSON.parse(event.data);
  if (msg.source === 'counterparty') {
    switch (msg.event) {
      case 'transcript':    dispatch({ type: 'TRANSCRIPT_RECEIVED', payload: msg }); break;
      case 'llm_token':     dispatch({ type: 'LLM_TOKEN_RECEIVED', payload: msg.token }); break;
      case 'turn_latency':  dispatch({ type: 'TURN_LATENCY_RECEIVED', payload: msg }); break;
      case 'pipeline_error': dispatch({ type: 'CALL_ERROR', payload: `Pipeline error (${msg.stage}): ${msg.message}` }); break;
    }
  } else if (msg.type === 'call_ended') {
    dispatch({ type: 'CALL_ENDED' });
  } else if (msg.type === 'error') {
    dispatch({ type: 'CALL_ERROR', payload: msg.reason });
  }
});
```

**Layout branch** in JSX:
```tsx
{state.callStatus === 'idle' ? (
  <>
    <p className="text-gray-400 text-xs font-mono uppercase tracking-widest mb-4">Counterparty Personas</p>
    <PersonaGrid personas={state.personas} loading={isPersonaLoading}
      mode="grid" selectedPersonaId={state.selectedPersonaId}
      callStatus={state.callStatus} onSelectPersona={handleSelectPersona} />
    <CallDialBar
      selectedPersona={state.personas.find(p => p.id === state.selectedPersonaId) ?? null}
      onDial={handleDial} />
  </>
) : (
  <div className="flex gap-6 items-start">
    <div className="w-72 shrink-0 flex flex-col gap-3">
      <PersonaGrid personas={state.personas} loading={false}
        mode="sidebar" selectedPersonaId={state.selectedPersonaId}
        callStatus={state.callStatus} onSelectPersona={() => {}} />
    </div>
    <div className="flex-1 min-w-0 flex flex-col gap-4">
      <CallPanel
        callStatus={state.callStatus}
        persona={state.personas.find(p => p.id === state.selectedPersonaId)!}
        transcript={state.transcript}
        llmTokenBuffer={state.llmTokenBuffer}
        processingTurn={state.processingTurn}
        telemetry={state.telemetry}
        callErrorMessage={state.callErrorMessage}
        hangUpRef={hangUpRef}
        onHangUp={handleHangup}
        onDismiss={handleDismiss} />
    </div>
  </div>
)}
```

**`PersonaGrid.tsx` changes**: add props `mode: 'grid' | 'sidebar'`, `selectedPersonaId: string | null`, `callStatus: CallStatus`, `onSelectPersona: (id: string) => void`. In grid mode, render `PersonaCardSelectable`; in sidebar mode, render one selected `PersonaCardSelectable` (active call partner) + remaining personas as locked.

**`PersonaCard.tsx`**: zero modifications. Diff must be empty.

#### 11 New Component Files

| Component file | Key implementation notes |
|:---------------|:------------------------|
| `components/PersonaCardSelectable.tsx` | Props: `persona`, `isSelected`, `isLocked`, `compact`, `onClick`. Renders `role="button"` `aria-pressed={isSelected}` when interactive; `role="article"` when locked or active partner. `data-persona-id={persona.id}` on root for focus restoration. `onKeyDown` handles Enter/Space. All four states per §6.6. |
| `components/CallDialBar.tsx` | `className="bg-gray-900 border border-gray-800 rounded-lg px-5 py-4 mt-6 flex items-center justify-between gap-4"`. Left: persona summary or placeholder. Right: Dial button enabled/disabled per §6.7. `aria-describedby="dial-helper-text"` when disabled. |
| `components/CallPanel.tsx` | Outer container — composes `CallPanelHeader` + conditional `CallErrorBanner` + `TranscriptPanel` + `TelemetryPanel`. Passes `hangUpRef` to `CallPanelHeader`. |
| `components/CallPanelHeader.tsx` | `className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap"`. Context button varies by `callStatus` per §6.8. `hangUpRef` forwarded to active Hang Up button. |
| `components/CallStatusBadge.tsx` | `inline-flex items-center gap-1.5 text-xs font-mono [status-class]`. Pulsing dot for `connecting` and `active` only. `aria-label="Call status: [LABEL]"`. |
| `components/TranscriptPanel.tsx` | `role="log" aria-live="polite" aria-relevant="additions" aria-atomic="false"`. Auto-scroll `useEffect` on `[transcript.length, processingTurn, llmTokenBuffer]`. Three empty states: connecting spinner, active waiting, content (per §6.10). |
| `components/TranscriptEntry.tsx` | `border-l-2 [lang-border] [lang-bg] rounded-r-lg mx-3 px-4 py-3`. Language badge from §6.1 palette. Timestamp via `toLocaleTimeString()`. User entries always `border-blue-600 bg-blue-950/20`. |
| `components/ProcessingIndicator.tsx` | `animate-spin` SVG + `text-amber-400 font-mono uppercase "Pipeline processing"` + `animate-pulse "● ● ●"`. `aria-live="polite"` `aria-label`. Mounted/unmounted (not hidden) — causes a single announcement per turn. |
| `components/LLMStreamEntry.tsx` | Same border/bg as counterparty TranscriptEntry. Persona first name + language badge + amber `GENERATING`. Body: `{tokenBuffer}` + `▌` (`text-indigo-400 animate-pulse aria-hidden="true"`). Container: `aria-live="off"`. |
| `components/TelemetryPanel.tsx` | Internal `useState<boolean>(false)` (collapsed by default). `aria-expanded` `aria-controls="telemetry-table-body"`. Threshold colours per §6.11. Total in `toFixed(2)s`; others `toLocaleString()ms`. Only rendered when `telemetry.length > 0`. |
| `components/CallErrorBanner.tsx` | `role="alert"`. Rendered INSIDE `CallPanel` between `CallPanelHeader` and `TranscriptPanel` only when `callStatus === 'error'`. Try Again + Close both call `onDismiss`. Distinct from global `ErrorBanner.tsx`. |

---

### 4.5 ECR Deploy Pipeline

#### Terraform additions to `voxhop/infra/main.tf`

Three ECR repositories (append to main.tf — `force_delete = true` to allow `make destroy`):

```hcl
resource "aws_ecr_repository" "voxhop_app" {
  name                 = "voxhop-app"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags = { Name = "voxhop-app-ecr" }
}

resource "aws_ecr_repository" "voxhop_simulator" {
  name                 = "voxhop-simulator"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags = { Name = "voxhop-simulator-ecr" }
}

resource "aws_ecr_repository" "voxhop_counterparty" {
  name                 = "voxhop-counterparty"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags = { Name = "voxhop-counterparty-ecr" }
}
```

Add EC2 instance IAM pull permissions to `aws_iam_role_policy.voxhop_ec2` existing policy (add new statement to the existing array):

```json
{
  "Effect": "Allow",
  "Action": [
    "ecr:GetAuthorizationToken",
    "ecr:BatchCheckLayerAvailability",
    "ecr:GetDownloadUrlForLayer",
    "ecr:BatchGetImage"
  ],
  "Resource": "*"
}
```

Note: `ecr:GetAuthorizationToken` must be on `"Resource": "*"` (it is an IAM-level action, not resource-scoped).

#### Terraform additions to `voxhop/infra/outputs.tf`

```hcl
output "ecr_app_url" {
  description = "ECR URL for voxhop-app image"
  value       = aws_ecr_repository.voxhop_app.repository_url
}

output "ecr_simulator_url" {
  description = "ECR URL for voxhop-simulator image"
  value       = aws_ecr_repository.voxhop_simulator.repository_url
}

output "ecr_counterparty_url" {
  description = "ECR URL for voxhop-counterparty image"
  value       = aws_ecr_repository.voxhop_counterparty.repository_url
}

output "instance_id" {
  description = "EC2 instance ID (for EC2 Instance Connect deploy)"
  value       = aws_instance.voxhop.id
}

output "eip_public_ip" {
  description = "Elastic IP public address (for EC2 Instance Connect SSH)"
  value       = aws_eip.voxhop.public_ip
}

output "availability_zone" {
  description = "AZ of the EC2 instance (for ec2-instance-connect send-ssh-public-key)"
  value       = aws_subnet.public.availability_zone
}
```

#### Developer workstation IAM policy (not in Terraform — applied via AWS console or separate policy doc)

Required for any developer running `make deploy-app`:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload", "ecr:BatchCheckLayerAvailability"
      ],
      "Resource": [
        "arn:aws:ecr:*:*:repository/voxhop-app",
        "arn:aws:ecr:*:*:repository/voxhop-simulator",
        "arn:aws:ecr:*:*:repository/voxhop-counterparty"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["ec2-instance-connect:SendSSHPublicKey"],
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": { "StringEquals": { "ec2:ResourceTag/Project": "voxhop" } }
    }
  ]
}
```

#### `voxhop/Makefile` additions

Append after existing targets. Add `ECR_REGION`, `ECR_ACCOUNT`, `ECR_PREFIX`, `INSTANCE_ID`, `EIP`, `AZ` derivation. `deploy-app` must stay under 5 minutes on warm ECR layer cache:

```makefile
# ─── ECR App-Layer Deploy (Phase 2) ──────────────────────────────────────────
# Replaces AMI rebuild for app code changes. Runs in <5 minutes on warm cache.
# Prerequisites: AWS CLI configured, docker running, terraform apply done.
ECR_REGION  ?= eu-north-1
ECR_ACCOUNT  = $(shell aws sts get-caller-identity --query Account --output text)
ECR_PREFIX   = $(ECR_ACCOUNT).dkr.ecr.$(ECR_REGION).amazonaws.com
INSTANCE_ID  = $(shell terraform -chdir=infra output -raw instance_id)
EIP          = $(shell terraform -chdir=infra output -raw eip_public_ip)
AZ           = $(shell terraform -chdir=infra output -raw availability_zone)

deploy-app:
	@echo "[voxhop] Logging in to ECR..."
	aws ecr get-login-password --region $(ECR_REGION) | \
	  docker login --username AWS --password-stdin $(ECR_PREFIX)
	@echo "[voxhop] Building and pushing app images (parallel)..."
	docker build -t $(ECR_PREFIX)/voxhop-app:latest -f voxhop/Dockerfile voxhop/ &
	docker build -t $(ECR_PREFIX)/voxhop-simulator:latest -f voxhop-simulator/Dockerfile voxhop-simulator/ &
	docker build -t $(ECR_PREFIX)/voxhop-counterparty:latest -f voxhop-counterparty/Dockerfile voxhop-counterparty/ &
	wait
	docker push $(ECR_PREFIX)/voxhop-app:latest
	docker push $(ECR_PREFIX)/voxhop-simulator:latest
	docker push $(ECR_PREFIX)/voxhop-counterparty:latest
	@echo "[voxhop] Generating ephemeral SSH key (60-second window)..."
	ssh-keygen -t rsa -f /tmp/voxhop-deploy-key -N "" -q
	aws ec2-instance-connect send-ssh-public-key \
	  --instance-id $(INSTANCE_ID) \
	  --availability-zone $(AZ) \
	  --instance-os-user ec2-user \
	  --ssh-public-key file:///tmp/voxhop-deploy-key.pub
	@echo "[voxhop] SSH pull and restart on instance..."
	ssh -i /tmp/voxhop-deploy-key \
	  -o StrictHostKeyChecking=no \
	  -o ConnectTimeout=10 \
	  ec2-user@$(EIP) \
	  "cd /opt/voxhop && \
	   aws ecr get-login-password --region $(ECR_REGION) | docker login --username AWS --password-stdin $(ECR_PREFIX) && \
	   docker compose pull voxhop voxhop-simulator voxhop-counterparty && \
	   docker compose up -d voxhop voxhop-simulator voxhop-counterparty"
	rm -f /tmp/voxhop-deploy-key /tmp/voxhop-deploy-key.pub
	@echo "[voxhop] deploy-app complete."
```

Add `deploy-app` to `.PHONY` list at top of Makefile.

---

### 4.6 Docker Compose Changes

Update `voxhop/docker-compose.yml`. Two services change:

**`voxhop-counterparty`** — replace Phase 1 stub definition entirely:

```yaml
voxhop-counterparty:
  image: <ECR_PREFIX>/voxhop-counterparty:latest
  container_name: voxhop-counterparty
  ports:
    - "3001:3001"
  # No counterparties volume — persona delivered in call_initiated.customData (§3.2)
  environment:
    - PORT=3001
    - WHISPER_URL=http://whisper:8000
    - OLLAMA_URL=http://ollama:11434
    - PIPER_URL=http://piper-http:5000
    - OLLAMA_MODEL=gemma4
    - WHISPER_TIMEOUT_MS=10000
    - OLLAMA_TIMEOUT_MS=30000
    - PIPER_TIMEOUT_MS=10000
    - LOG_LEVEL=info
  depends_on:
    whisper:
      condition: service_healthy
    ollama:
      condition: service_healthy
    piper-http:
      condition: service_healthy
  healthcheck:
    # CP-01: must return {"status":"ok"}, NOT {"status":"stub"}
    test: ["CMD-SHELL", "node -e \"const http=require('http');http.get('http://localhost:3001/health',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);process.exit(j.status==='ok'?0:1)}catch{process.exit(1)}})}).on('error',()=>process.exit(1))\""]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 30s   # VAD ONNX warm-up can take ~10s on first load
  restart: unless-stopped
```

**`voxhop-simulator`** — add `COUNTERPARTY_URL` env var and `depends_on` for counterparty:

```yaml
voxhop-simulator:
  # ... existing config preserved ...
  environment:
    - COOP_COEP_ENABLED=true
    - COUNTERPARTY_URL=ws://voxhop-counterparty:3001  # Phase 2 addition
  depends_on:
    redis:
      condition: service_healthy
    voxhop-counterparty:          # Phase 2 addition
      condition: service_healthy  # ensures counterparty pipeline ready before simulator accepts calls
```

**`voxhop` (voxhop-app)** — update image to ECR:
```yaml
voxhop:
  image: <ECR_PREFIX>/voxhop-app:latest   # replaces build: context
  # all other config unchanged
```

**`voxhop-simulator`** — update image to ECR:
```yaml
voxhop-simulator:
  image: <ECR_PREFIX>/voxhop-simulator:latest   # was already image: not build:
```

---

### 4.7 Test Plan

#### `voxhop-counterparty/test/` — new unit tests (Vitest)

**`config.test.ts`**:
- Valid env object parses to correct Config with all defaults applied
- Missing `WHISPER_URL` uses default `http://localhost:8001`
- `PORT` coerced from string to number
- `VAD_SILENCE_THRESHOLD_MS` below 200 causes `validateConfig()` to call `process.exit(1)` (mock process.exit)

**`schemas.test.ts`**:
- `CallInitiatedSchema` accepts valid payload with `customData.persona`
- `CallInitiatedSchema` rejects payload missing `customData` entirely
- `CallInitiatedSchema` rejects `customData.persona` failing `PersonaSchema` (e.g. missing `piperVoice`)
- `MediaStartedSchema` accepts `track: 'caller'`
- `MediaStartedSchema` **rejects** `track: 'called'` — `z.literal('caller')` enforcement
- `OllamaStreamChunkSchema` accepts `{ message: { role: 'assistant', content: 'Hello' }, done: false }`
- `OllamaStreamChunkSchema` accepts `{ message: { role: 'assistant', content: '' }, done: true }`
- `PersonaSchema` rejects object missing `piperVoice`
- `WhisperResponseSchema` rejects `{ text: '' }` (min(1))

**`audio-utils.test.ts`**:
- `downsampleTo16k(Buffer.alloc(0), 24000)` returns empty buffer
- `downsampleTo16k` of 24kHz PCM produces `Math.floor(inputSamples / 1.5)` output samples
- `buildWav` produces 44-byte header + input data length
- `buildWav` RIFF/WAVE magic bytes correct at offsets 0, 8

**`pipeline.test.ts`** (mock `fetch` via `vi.stubGlobal`):
- `callWhisper` throws `StagedError('whisper')` on `AbortError` (timeout)
- `callWhisper` throws `StagedError('whisper')` on HTTP 500
- `callWhisper` throws `StagedError('whisper')` on empty transcript `{ text: '' }`
- `callOllamaStream` accumulates tokens and resolves with full string from multi-line NDJSON stream
- `callOllamaStream` handles line buffer split (chunk boundary mid-JSON-line) correctly
- `callOllamaStream` throws `StagedError('ollama')` on HTTP 500
- `callPiper` throws `StagedError('piper')` on zero-byte response (GAP-03)
- `callPiper` sends `{ text, voice }` body — assert request body contains `voice` field

**`call-handler.test.ts`** (mock WebSocket):
- `processingTurn = true` while `runTurn()` in flight — second VAD fire returns without starting a second turn
- `call_initiated` with missing `customData.persona` → `ws.close(1008, ...)` called
- Conversation history grows and stays ≤ 100 entries — assert shift() after 100th entry
- `cleanup()` clears `conversationHistory` and calls `vad.destroy()`
- `HANG_UP_INITIATED` sequence: `call_ended` sent to counterparty WS, both connections closed

#### `voxhop-simulator/test/smoke.test.ts` — changes

**Remove entirely**:
- `describe('voxhop-counterparty stub — M-05', ...)` — the 5 inline logic tests (routeHandler mock)
- The structural test `it('M-05: voxhop-counterparty/package.json has no production dependencies ...')` inside `describe('Structural mandates')`

**Add to `describe('Structural mandates')`**:
```typescript
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
```

**Add `describe('P2 Counterparty Deployment Checklist', ...)`** with `.skip` tests (alongside existing `P1-08` checklist):
```typescript
describe('P2 Counterparty Deployment Checklist (CP-01, CP-03, CP-04, CP-05)', () => {
  it.skip('[CP-01] GET /health on port 3001 returns {"status":"ok"} (not "stub") — requires running counterparty', () => {});
  it.skip('[CP-03] WS upgrade to /gamma/audio returns 101 — requires running counterparty', () => {});
  it.skip('[CP-04] WS upgrade to /events?callId=<uuid> with active call returns 101 — requires running counterparty + active call', () => {});
  it.skip('[CP-05] WS upgrade to /unknown path is destroyed — requires running counterparty', () => {});
});
```

**Retain unchanged**: All MN-06 tests, M-06, M-07, M-09, M-13, AR-02, MN-03, MN-07, outputs.tf test, all Phase 1 state machine tests, all `PersonaSchema` tests.

---

## 5. ACCEPTANCE CRITERIA

### 5.1 Functional (The Happy Path)

`ACC-P2-01: Counterparty health endpoint` — `GET http://voxhop-counterparty:3001/health` returns HTTP 200 with body `{ "status": "ok" }` (not `"stub"`) within 500ms of service startup. Verify: `curl http://localhost:3001/health` returns `{"status":"ok"}`. Corresponds to CP-01.

`ACC-P2-02: Counterparty WebSocket endpoints available` — WS upgrade to `ws://voxhop-counterparty:3001/gamma/audio` returns HTTP 101. WS upgrade to `ws://voxhop-counterparty:3001/events?callId=<uuid>` with matching active call returns HTTP 101. WS upgrade to any other path results in socket destroyed (connection error). Verify: CP-03, CP-04, CP-05 smoke tests pass in running environment.

`ACC-P2-03: Persona selection enables Dial button` — In `ready` state, clicking a persona card applies indigo selection ring (`border-2 border-indigo-500 bg-indigo-950/30`) and enables the Dial button (`bg-indigo-600`). Persona name and language badge appear in `CallDialBar`. Verify: visual inspection; `aria-pressed="true"` on selected card.

`ACC-P2-04: Dial initiates call and transitions layout` — Clicking **Dial (Direct)** while a persona is selected sends `{ type: "dial", personaId }` over WS and immediately switches to split-pane layout (no CSS transition). `CallStatusBadge` shows amber `CONNECTING` with pulsing dot. `TranscriptPanel` shows connecting spinner ("ESTABLISHING CONNECTION"). Verify: React DevTools; network tab shows WS frame.

`ACC-P2-05: Conversation opener heard immediately on dial` — Within 3 seconds of `media_started` being sent to the Counterparty, browser speakers play the persona's `conversationOpener` audio (e.g. James: "Good afternoon, Harrington Insurance, James speaking."). No developer speech is required to trigger the opener. Verify: audible audio; `callStatus` transitions to `active` when first audio binary frame arrives.

`ACC-P2-06: Dial transitions to active on first audio frame` — When the first binary audio frame from the Counterparty (opener or response) is received by NestJS and forwarded to the browser, `callStatus` transitions from `connecting` to `active`. `CallStatusBadge` shows green `ACTIVE`. The 10-second connecting timeout is cleared. Hang Up button appears and auto-focuses within 50ms. Verify: React DevTools state; Hang Up has focus after opener audio arrives.

`ACC-P2-07: Developer speech captured and relayed` — After `callStatus === 'active'`, Float32 48kHz mic frames from `pcm-capture-processor` are sent as binary over `/ws/simulator`. NestJS receives them, `InboundAudioTranscoder.processInbound()` decimates 3:1 to S16LE 16kHz, and sends `{ event: "audio", callId, trackId: rxTrackId, payload }` JSON frames to the Counterparty `/gamma/audio` WS. Verify: NestJS logs show audio frames forwarded; Counterparty logs show VAD processing.

`ACC-P2-08: Full turn — developer speech to counterparty audio` — Developer speaks a sentence. Within 15 seconds (generous bound for developer testing environment): VAD fires → Whisper STT → Ollama LLM → Piper TTS → audio injected by Counterparty → upsampled by NestJS → binary frame sent to browser → audio played. Verify: audible counterparty response; transcript panel shows both entries.

`ACC-P2-09: User transcript entry appears after Whisper` — After VAD fires and Whisper STT completes, a `{ event: "transcript", role: "user", text, timestamp }` event arrives from Counterparty `/events`, is forwarded by NestJS with `source: "counterparty"`, and `dispatch({ type: 'TRANSCRIPT_RECEIVED', payload })` appends a new entry to the transcript panel with `border-l-2 border-blue-600 bg-blue-950/20` accent and `processingTurn = true`. `ProcessingIndicator` appears (spinner + "● ● ●"). Verify: React DevTools; TranscriptPanel contains user entry with correct styling.

`ACC-P2-10: LLM token stream renders live` — During Ollama generation, `{ event: "llm_token", token }` events arrive per generated token. `llmTokenBuffer` grows token-by-token. `LLMStreamEntry` renders the accumulating buffer with `▌` cursor. `ProcessingIndicator` is hidden while `llmTokenBuffer !== ''`. `aria-live="off"` prevents screen reader spam. Verify: visible character-by-character rendering in TranscriptPanel; DevTools shows `llmTokenBuffer` growing.

`ACC-P2-11: Counterparty transcript entry finalises LLM stream` — When Ollama completes, `{ event: "transcript", role: "counterparty", text, timestamp }` arrives. `LLMStreamEntry` is unmounted. A completed `TranscriptEntry` for the counterparty appears with persona language accent colours (per §6.1 table). `processingTurn = false`. `llmTokenBuffer = ''`. Verify: LLM stream cursor disappears; completed entry shows language border.

`ACC-P2-12: Telemetry row appended after Piper` — After Piper audio is injected, `{ event: "turn_latency", sttMs, llmMs, ttsMs, totalMs }` arrives. `TelemetryPanel` subtitle shows `"Pipeline Telemetry — 1 turn(s)"`. Expanding the panel shows the turn row with correct per-stage millisecond values. Threshold colour coding: `totalMs ≤ 2000` → green; `> 2000` → amber; `> 3000` → red. Verify: expand telemetry panel; values match sum (sttMs + llmMs + ttsMs ≈ totalMs ± inject overhead).

`ACC-P2-13: Conversation history maintained across turns` — On second developer turn, Ollama receives messages array with system prompt + user turn 1 + assistant turn 1 + user turn 2. The counterparty's response is contextually coherent (references prior exchange). Verify: Counterparty logs show `messages` array length growing; LLM response references prior context.

`ACC-P2-14: 50-turn FIFO history cap` — After 50 developer turns (100 message history entries), the 101st entry is added and the oldest entry is removed via `shift()`. History array length stays ≤ 100. Verify: Counterparty unit test (`call-handler.test.ts` history cap test).

`ACC-P2-15: processingTurn lock discards concurrent audio` — While pipeline is in-flight (`processingTurn = true`), incoming audio frames are silently discarded at `handleAudioFrame()` guard. No second turn is initiated. Lock releases when Piper audio frames have been fully injected (`finally` block of `runTurn()`). Verify: Counterparty unit test; logs show "silently discarded" for frames received mid-turn.

`ACC-P2-16: Hang Up terminates cleanly` — Clicking **Hang Up** sends `{ type: "hangup" }` to NestJS. NestJS sends `{ event: "call_ended", callId }` to Counterparty `/gamma/audio`. NestJS closes both Counterparty WS connections. Browser `callStatus` transitions to `ended`. `CallStatusBadge` shows gray `ENDED`. **[New Call]** button appears. Transcript is frozen. `processingTurn` lock is released in `cleanup()`. Verify: Counterparty logs show `call_ended` received; both WS connections closed.

`ACC-P2-17: New Call resets to idle` — Clicking **[New Call]** dispatches `DISMISS_CALL_RESULT`. All 7 Phase 2 state fields reset to initial values: `callStatus = 'idle'`, `selectedPersonaId = null`, `transcript = []`, `llmTokenBuffer = ''`, `processingTurn = false`, `telemetry = []`, `callErrorMessage = null`. Split-pane is unmounted. Full-width persona grid + disabled `CallDialBar` renders. Focus is restored to the previously selected persona card (`savedFocusRef.current?.focus()`). Verify: React DevTools state; visual layout restored; focus lands on correct persona card.

`ACC-P2-18: Phase 1 persona grid pixel-identical in idle state` — In `callStatus === 'idle'`, the persona grid renders as `grid grid-cols-3 gap-6` identical to Phase 1. `PersonaCard.tsx` diff is empty. `PersonaGrid.tsx` in grid mode renders `PersonaCardSelectable` components that are visually indistinguishable from Phase 1 `PersonaCard` in unselected state (same `border-gray-800 bg-gray-900` base). Verify: §6.15 Engineering Verification Checklist items.

`ACC-P2-19: Metadata stream independence` — `/events` and `/gamma/audio` WebSocket frames are independent. Audio quality is not affected by metadata event volume (transcript + token events). Both coexist on the single `/ws/simulator` browser connection — browser receives binary frames (audio) and JSON text frames (metadata) in the same WS session. `instanceof ArrayBuffer` routing in App.tsx correctly separates them. Verify: browser DevTools WS tab shows mixed binary + text frames.

`ACC-P2-20: Second dial rejected while call active` — If `{ type: "dial" }` is received while a `CallSession` already exists for that browser WS client, NestJS responds with `{ type: "error", reason: "call_already_active" }` immediately. No second counterparty connection is opened. Verify: send two consecutive dial messages; only one session created.

`ACC-P2-21: 10-second connecting timeout` — If no binary audio frame is received from the Counterparty within 10 seconds of dial, NestJS sends `{ type: "error", reason: "connection_timeout" }` to the browser. `callStatus` transitions to `error`. `CallErrorBanner` shows "Connection timed out. No audio received." with `[Close]` button. Verify: disconnect Piper service; dial; observe timeout after 10s.

`ACC-P2-22: ECR deploy completes in under 5 minutes` — `make deploy-app` from a developer workstation with warm Docker layer cache builds all three app images, pushes to ECR, connects via EC2 Instance Connect SSH, and restarts the three app containers in under 5 minutes from invocation. Verify: time the command; observe `docker compose up -d` completion in SSH output.

`ACC-P2-23: Phase 1 services unaffected` — After Phase 2 deployment, all Phase 1 services remain healthy: `voxhop` (port 3000), `voxhop-simulator` (port 443), `whisper`, `ollama`, `piper-http`, `redis`. `make status` shows all 7 services healthy. Phase 1 smoke tests (`npm test` in `voxhop-simulator/`) all pass — track 1 voxhop Vitest tests (`npm test` in `voxhop/`) all pass. Verify: all 55 Track 1 Vitest tests pass after Phase 2 deployment.

`ACC-P2-24: Track 1 codebase frozen` — `git diff HEAD -- voxhop/src/` and `git diff HEAD -- voxhop/test/` are both empty. The MN-06 smoke test passes. Zero modifications to `voxhop/src/` or `voxhop/test/` across all Phase 2 commits. Verify: MN-06 test in `voxhop-simulator/test/smoke.test.ts`.

`ACC-P2-25: OllamaStreamChunkSchema uses /api/chat format` — The Counterparty sends `POST /api/chat` to Ollama with `{ model, messages, stream: true }`. Streaming response chunks are validated as `{ message: { role: string, content: string }, done: boolean }`. The `content` field accumulates into `fullResponse`. The `/api/generate` format (`{ response, done }`) is NOT used. Verify: Counterparty pipeline unit test; Ollama access logs show `/api/chat`.

### 5.2 Negative (The Unhappy Path)

*Integration Test Team CO-SIGN — 2026-06-07*

---

#### Domain A: Counterparty Protocol Validation (NEG-P2-01 to NEG-P2-10)

`NEG-P2-01: call_initiated with missing customData.persona — WS closed 1008`
**Condition**: A WS client connects to `/gamma/audio` and sends `{ event: "call_initiated", callId: "x", timestamp: "..." }` with no `customData` field at all, or with `customData: {}` (persona absent).
**Expected behaviour**: `CallInitiatedSchema.safeParse()` fails (required `customData.persona` missing); handler calls `ws.close(1008, 'Invalid call_initiated: missing or invalid persona')` immediately. No call session established. `activeHandler.getCallId()` returns `null`. No `handleMediaStarted` path entered.
**How to verify**: `call-handler.test.ts` — mock WS; send raw `call_initiated` with no `customData`; assert `ws.close` called with code 1008. `schemas.test.ts` — `CallInitiatedSchema.safeParse({ event: 'call_initiated', callId: 'x', timestamp: '...' })` asserts `success: false`. Selector: `ws.close.mock.calls[0][0] === 1008`.

`NEG-P2-02: call_initiated with structurally present but schema-invalid persona — WS closed 1008`
**Condition**: `call_initiated` arrives with `customData: { persona: { id: 'en-james', name: 'James', language: 'en', systemPrompt: 'Test' } }` — `piperVoice` field absent. Or `persona.id` is an empty string (fails `min(1)`). Or `persona.systemPrompt` is missing.
**Expected behaviour**: `PersonaSchema.safeParse()` fails; `CallInitiatedSchema.safeParse()` propagates the failure; `ws.close(1008, ...)` called. `this.persona` remains `null`. No pipeline stages entered.
**How to verify**: `schemas.test.ts` — `CallInitiatedSchema.safeParse` with `piperVoice` omitted asserts `success: false` with `piperVoice` in error path. `call-handler.test.ts` — three cases: missing `piperVoice`, empty `id`, missing `systemPrompt`; each asserts `ws.close(1008)`.

`NEG-P2-03: media_started missing txTrackId — WS closed 1008`
**Condition**: A correctly sequenced `call_initiated` (valid persona) is followed by a `media_started` frame where `txTrackId` is absent from the payload.
**Expected behaviour**: `MediaStartedSchema.safeParse()` fails (`txTrackId` is `z.string().min(1)` required); `ws.close(1008, ...)` called. `this.txTrackId` remains `null`. No VAD instantiated. No conversation opener injected via `injectOpener()`.
**How to verify**: `schemas.test.ts` — `MediaStartedSchema.safeParse(frameWithoutTxTrackId)` asserts `success: false` with `txTrackId` in error path. `call-handler.test.ts` — post valid `call_initiated` then `media_started` with `txTrackId` deleted; assert `ws.close(1008)` called; assert `vad.ensureLoaded` never called.

`NEG-P2-04: media_started with wrong mediaFormat (bad sampleRate, channels, encoding, or track label) — WS closed 1008`
**Condition**: `media_started` arrives with any deviant `mediaFormat` field — `sampleRate: 8000` (not `z.literal(16000)`), or `channels: 2` (not `z.literal(1)`), or `encoding: 'audio/pcma'` (not `z.literal('audio/x-raw')`), or `bitDepth: 8`. Additionally: `tracks[0].track: 'called'` (Counterparty `MediaStartedSchema` uses `z.literal('caller')` — NOT `z.enum`; any value other than `'caller'` fails).
**Expected behaviour**: `MediaStartedSchema.safeParse()` fails; `ws.close(1008, ...)` called. No audio pipeline entered.
**How to verify**: `schemas.test.ts` (counterparty) — five separate test cases (one per deviant field), each asserting `success: false` with the failing field in `error.issues[].path`. Mirrors NEG-01 and NEG-02 patterns from existing `frame-shape.test.ts`. Critically: assert `{ ..., tracks: [{ trackId: 'x', track: 'called' }] }` fails — this is the `z.literal('caller')` vs `z.enum` schema boundary test (§7.4).

`NEG-P2-05: Second call_initiated on an already-active session — silently ignored`
**Condition**: A `call_initiated` is received after `this.callId` is already set on the handler (the handler has already processed one valid `call_initiated`).
**Expected behaviour**: The duplicate is silently ignored — `handleCallInitiated()` checks `if (this.callId !== null) return;` before parsing. `this.callId` remains unchanged (first call wins). `ws.close()` is NOT called. `this.persona` is not overwritten.
**How to verify**: `call-handler.test.ts` — after initial `call_initiated` with `callId: 'call-A'`, send second with `callId: 'call-B'` and different persona; assert `handler.getCallId() === 'call-A'`; assert `ws.close` never called; assert `this.persona` unchanged.

`NEG-P2-06: Audio frame with zero-length base64 payload — silently discarded`
**Condition**: An `audio` frame arrives on `/gamma/audio` with `payload: ""` (empty string) or a payload that base64-decodes to zero bytes.
**Expected behaviour**: `handleAudioFrame()` executes `Buffer.from(frame.payload, 'base64')` → `decoded.length === 0` → returns immediately. `this.vad.feed()` is NOT called. `processingTurn` is NOT set. No error is emitted on `/events`.
**How to verify**: `call-handler.test.ts` — mock `vad.feed`; send audio frame with `payload: ''`; assert `vad.feed` never called; assert `processingTurn === false`. Follows the NEG-06 pattern from `chaos.test.ts` (Buffer.from guard).

`NEG-P2-07: Audio frame with unknown event type — silently discarded`
**Condition**: A JSON frame arrives on `/gamma/audio` with an unrecognised `event` value (e.g., `{ event: "heartbeat", callId: "x" }` or `{ event: "ping" }`).
**Expected behaviour**: `GenericFrameSchema.safeParse()` succeeds (any string is valid for `event`). `handleMessage()` routes: `frame.event === 'audio'` — false; `handleLifecycleEvent()` dispatches by event type — no registered handler for `"heartbeat"`; frame is silently discarded. No `ws.close()`. No crash. No error on `/events`.
**How to verify**: `call-handler.test.ts` — send `{ event: "heartbeat", callId: "x" }`; assert no error thrown; assert `ws.close` not called; assert `vad.feed` not called; process remains stable.

`NEG-P2-08: WS upgrade to unknown path — socket destroyed, no HTTP response`
**Condition**: A WS upgrade request arrives for a path other than `/gamma/audio` or `/events` — e.g., `/ws`, `/health`, `/gamma/events`, `/unknown`, `/`.
**Expected behaviour**: `server.on('upgrade', ...)` falls to the `else` branch; calls `socket.destroy()`. The TCP connection is closed at the socket level (no HTTP 404, no 101, no graceful close — raw TCP destroy). The client receives a connection error.
**How to verify**: `server.ts` unit test — mock `req` with `url: '/unknown'`; mock `socket` object; fire `server.emit('upgrade', req, socket, head)`; assert `socket.destroy()` called; assert `wssAudio.handleUpgrade` NOT called; assert `wssEvents.handleUpgrade` NOT called. CP-05 deployment checklist item (`.skip`) documents the live verification.

`NEG-P2-09: /events upgrade with missing callId query param — socket destroyed`
**Condition**: WS upgrade arrives for `/events` with no `callId` query param (`/events` without `?callId=...`), or with an empty string `?callId=`.
**Expected behaviour**: `searchParams.get('callId')` returns `null` or `''`; the conditional `if (!callId || ...)` triggers; `socket.destroy()` called. No WS upgrade occurs. No `setEventsWs()` called on `activeHandler`. The active audio call is completely unaffected.
**How to verify**: `server.ts` unit test — mock upgrade request to `/events` (no query params); assert `socket.destroy()` called; assert `wssEvents.handleUpgrade` NOT called. Second case: `/events?callId=`; assert same.

`NEG-P2-10: /events upgrade with mismatched callId — socket destroyed, active call unaffected`
**Condition**: An active call session has `callId = "call-uuid-A"`. A `/events?callId=call-uuid-B` WS upgrade arrives (stale UUID from a previous call, or an adversarial probe).
**Expected behaviour**: `activeHandler.getCallId() !== callId` comparison fails; `socket.destroy()` called. The existing active call handler's `eventsWs` is NOT overwritten. All in-flight pipeline events continue routing to the correct (previously set) events WS.
**How to verify**: `server.ts` unit test — configure mock `activeHandler.getCallId()` returning `"call-uuid-A"`; attempt upgrade with `?callId=call-uuid-B`; assert `socket.destroy()` called; assert `activeHandler.setEventsWs` NOT called.

---

#### Domain B: Counterparty Pipeline Failures (NEG-P2-11 to NEG-P2-20)

`NEG-P2-11: Whisper timeout — StagedError("whisper"), lock released, pipeline_error on /events, next turn possible`
**Condition**: Whisper HTTP `fetch()` exceeds `WHISPER_TIMEOUT_MS` (default 10,000ms). `AbortSignal.timeout()` fires; `fetch()` rejects with `DOMException('AbortError')`.
**Expected behaviour**: `callWhisper()` catches the `AbortError`, throws `StagedError('whisper', 'Whisper request timed out')`. `runTurn()` catches in the Whisper stage try/catch; calls `this.emitEvent({ event: 'pipeline_error', stage: 'whisper', ... })` on `/events`; returns early from the Whisper stage. `finally` block unconditionally sets `this.processingTurn = false`. No comfort clip (Counterparty has none). The call session remains active; the next VAD fire can start a fresh turn.
**How to verify**: `pipeline.test.ts` — `vi.stubGlobal('fetch', () => new Promise((_, reject) => setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 50)))` — assert `callWhisper()` throws `StagedError` with `stage === 'whisper'`. `call-handler.test.ts` — mock `callWhisper` throwing `StagedError('whisper')`; assert `eventsWs.send` called with `{ event: 'pipeline_error', stage: 'whisper' }`; assert `processingTurn === false` after; assert `callOllamaStream` never called. Follows the NEG-07 pattern from `chaos.test.ts`.

`NEG-P2-12: Whisper 5xx response — StagedError("whisper")`
**Condition**: Whisper returns HTTP 500 (model loading, service crashed).
**Expected behaviour**: `callWhisper()` checks `response.ok === false`; throws `StagedError('whisper', 'Whisper HTTP 500')`. Same recovery path as NEG-P2-11: lock released, `pipeline_error` on `/events`, call session survives.
**How to verify**: `pipeline.test.ts` — mock `fetch` resolving with `{ ok: false, status: 500 }`; assert `callWhisper()` throws `StagedError('whisper')`.

`NEG-P2-13: Whisper returns empty transcript — StagedError("whisper") via Zod min(1) rejection`
**Condition**: Whisper returns HTTP 200 with body `{ text: "" }`. VAD captured a noise burst below the silence threshold.
**Expected behaviour**: `WhisperResponseSchema.safeParse({ text: '' })` fails (`z.string().min(1)` constraint); `callWhisper()` throws `StagedError('whisper', 'Whisper returned empty transcript')`. Lock released. `pipeline_error` emitted on `/events`. Ollama is NOT called.
**How to verify**: `schemas.test.ts` (counterparty) — `WhisperResponseSchema.safeParse({ text: '' })` asserts `success: false`; `error.issues[0].message` contains `'empty transcript'`. `pipeline.test.ts` — mock fetch resolving `{ ok: true, json: () => ({ text: '' }) }` — assert `StagedError('whisper')` thrown. Mirrors NEG-08 from `chaos.test.ts` and `frame-shape.test.ts`.

`NEG-P2-14: Ollama timeout — StagedError("ollama"), lock released`
**Condition**: Ollama streaming `fetch()` exceeds `OLLAMA_TIMEOUT_MS` (default 30,000ms). `AbortSignal.timeout()` fires mid-stream (Ollama is generating tokens but exceeds the limit).
**Expected behaviour**: `callOllamaStream()` catches the `AbortError` in the outer try/catch; throws `StagedError('ollama', 'Ollama request failed: ...')`. `runTurn()` catches in the Ollama stage try/catch; emits `pipeline_error` on `/events`; returns early. `processingTurn = false` in `finally`. Piper is NOT called. Audio tracks receive nothing for this turn.
**How to verify**: `pipeline.test.ts` — mock `fetch` rejecting with `AbortError` after 50ms; assert `callOllamaStream()` throws `StagedError('ollama')`. `call-handler.test.ts` — mock `callOllamaStream` throwing `StagedError('ollama')`; assert `eventsWs.send` called with `{ event: 'pipeline_error', stage: 'ollama' }`; assert `callPiper` never called; assert `processingTurn === false`.

`NEG-P2-15: Ollama 5xx response — StagedError("ollama")`
**Condition**: Ollama returns HTTP 503 (model not loaded), HTTP 500 (GPU OOM), or any non-2xx response.
**Expected behaviour**: `callOllamaStream()` checks `response.ok === false`; throws `StagedError('ollama', 'Ollama HTTP 503')`.
**How to verify**: `pipeline.test.ts` — mock `fetch` resolving `{ ok: false, status: 503 }`; assert `StagedError('ollama')` thrown. Also verify `response.body === null` path throws `StagedError('ollama', 'Ollama response body is null')`.

`NEG-P2-16: Ollama returns malformed NDJSON — bad lines skipped, empty stream throws StagedError("ollama")`
**Condition**: Ollama streaming response contains lines that are not valid JSON (e.g., partial UTF-8 from a network corruption, or the string `"not json"` on its own line). Some lines are valid `OllamaStreamChunkSchema` objects; some are not.
**Expected behaviour**: `JSON.parse(line)` throws for the malformed lines; `catch { continue; }` skips them silently. Valid chunk lines continue to be parsed and tokens emitted. If NO valid `{ done: true }` line is ever received AND `fullResponse === ''` at stream end, `StagedError('ollama', 'Ollama stream ended with empty response')` is thrown.
**How to verify**: `pipeline.test.ts` — mock `fetch` with a `ReadableStream` containing interleaved valid and invalid NDJSON lines; assert valid tokens are emitted via `onToken`; assert no throw if at least one valid chunk completes the stream. Second test: stream containing only malformed lines; assert `StagedError('ollama')` thrown.

`NEG-P2-17: Piper timeout — StagedError("piper"), lock released, partial turn surfaced`
**Condition**: Piper HTTP request exceeds `PIPER_TIMEOUT_MS` (default 10,000ms) during the TTS stage. Whisper and Ollama have already completed successfully — user transcript and counterparty transcript events have already been emitted on `/events`.
**Expected behaviour**: `callPiper()` catches `AbortError`; throws `StagedError('piper', ...)`. `runTurn()` catches in the Piper stage try/catch; emits `pipeline_error` on `/events` with `stage: 'piper'`. Returns early. `processingTurn = false` in `finally`. No audio frames are injected on `txTrackId`. The partial turn transcript (user + counterparty text) is already in the browser — only the audio is missing.
**How to verify**: `pipeline.test.ts` — mock `fetch` rejecting with `AbortError` for Piper; assert `StagedError('piper')` thrown. `call-handler.test.ts` — mock all three services; Piper throws `StagedError('piper')`; assert `injectAudio` never called; assert `processingTurn === false`; assert `turn_latency` event NOT emitted (only emitted after successful Piper injection).

`NEG-P2-18: Piper returns zero bytes — StagedError("piper") — GAP-03 enforced`
**Condition**: Piper returns HTTP 200 with an empty body (`Content-Length: 0` or zero-length `ArrayBuffer`). This is a known Piper failure mode (GAP-03).
**Expected behaviour**: `callPiper()` calls `response.arrayBuffer()` → `Buffer.from(new ArrayBuffer(0))` → `length === 0` → throws `StagedError('piper', 'Piper returned zero bytes')`. No `downsampleTo16k()` called. No audio injected.
**How to verify**: `pipeline.test.ts` — mock `fetch` resolving `{ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }` — assert `StagedError('piper')` thrown. Mirrors NEG-10 from `chaos.test.ts`.

`NEG-P2-19: All three services down simultaneously — Whisper stage fails first, lock always released, pipeline aborts cleanly`
**Condition**: All three inference services (Whisper, Ollama, Piper) are unreachable (Docker containers stopped, network partition). VAD fires and triggers a turn.
**Expected behaviour**: Whisper fails first (`StagedError('whisper')`). `runTurn()` catches, emits `pipeline_error { stage: 'whisper' }`, returns early from the Whisper stage. `finally` block executes unconditionally: `processingTurn = false`. Ollama and Piper are NEVER contacted. The call session remains alive — browser remains connected, future turns are possible when services recover.
**How to verify**: `call-handler.test.ts` — mock `callWhisper` to throw `StagedError('whisper')`; assert `callOllamaStream` never called; assert `callPiper` never called; assert `processingTurn === false` after. This is structurally equivalent to the single-Whisper-failure case — the adversarial value is confirming abort-on-first-stage and guaranteed lock release.

`NEG-P2-20: processingTurn lock held when VAD fires — new VAD fire silently discarded, no second pipeline`
**Condition**: `this.processingTurn === true` (a turn is mid-flight, e.g., Ollama is streaming). A new batch of audio frames arrives and VAD fires again (the developer continued speaking while waiting for a response).
**Expected behaviour**: `handleAudioFrame()` checks `if (this.processingTurn) return;` at the TOP of the handler — before any lock modification, before any async call. Returns immediately. `callWhisper` is NOT invoked. No second `runTurn()` is started. No error emitted. The in-flight turn completes normally; `finally` releases `processingTurn = false` for the next VAD cycle.
**How to verify**: `call-handler.test.ts` — set `handler['processingTurn'] = true` directly; call `handleAudioFrame(validAudioFrame)`; assert `vad.feed` never called; assert `callWhisper` never called; assert `processingTurn` remains `true`. Follows the NEG-12 pattern from `chaos.test.ts` (Redis lock equivalent).

---

#### Domain C: Counterparty Half-Duplex Enforcement (NEG-P2-21 to NEG-P2-25)

`NEG-P2-21: Developer speaks during in-flight pipeline — all frames discarded, lock not re-entered`
**Condition**: A turn is actively processing (`processingTurn = true`, Ollama streaming). Twenty audio frames arrive on `rxTrackId` from the Simulator Backend in rapid succession.
**Expected behaviour**: ALL twenty frames are silently discarded at `handleAudioFrame()`'s `if (this.processingTurn) return;` guard. `vad.feed()` is called zero times during this window. No second `runTurn()` is started. When the in-flight turn completes and `finally` resets `processingTurn = false`, the next arriving frame is processed normally.
**How to verify**: `call-handler.test.ts` — mock a long-running `callOllamaStream` (returns after 100ms); trigger first VAD fire to start turn; send 20 audio frames while turn is in-flight; assert `vad.feed` called 0 times during that window; advance timers to complete turn; assert `processingTurn === false`; assert a 21st frame is now processed normally.

`NEG-P2-22: Conversation opener in-flight and developer speaks — concurrent injection must not crash`
**Condition**: `injectOpener()` is in-flight (Piper synthesizing the opener; `processingTurn` is NOT set, per §4.2 spec). The developer speaks immediately after `media_started`. VAD fires. `runTurn()` starts — it sets `processingTurn = true`. Both `injectOpener()` and `runTurn()`'s Piper stage can be in-flight concurrently, both calling `injectAudio()` on `txTrackId`.
**Expected behaviour**: JavaScript's single-threaded event loop serialises all `ws.send()` calls — no true concurrency at the I/O level. Both `injectAudio()` calls complete without error. Audio frames from both paths are sent to the Simulator Backend interleaved (opener frames then response frames, or vice versa, depending on resolution order). No crash. No `OPEN` state assertion error on `ws.send`. No unhandled promise rejection.
**How to verify**: `call-handler.test.ts` — mock Piper to delay 200ms; trigger `handleMediaStarted()` with a persona that has a `conversationOpener`; immediately call `handleAudioFrame()` with a frame that triggers VAD; assert no unhandled rejection; assert `ws.send` called at least twice (opener chunks + turn response chunks); assert `processingTurn === false` after both complete.

`NEG-P2-23: call_ended received while pipeline in-flight — cleanup called, lock released, no crash on late ws.send`
**Condition**: A `call_ended` frame arrives on `/gamma/audio` while `runTurn()` is awaiting Ollama stream completion. `cleanup()` sets `this.isActive = false` and calls `this.vad.destroy()`.
**Expected behaviour**: `cleanup()` executes: `isActive = false`, `conversationHistory = []`, `vad.destroy()`. The in-flight `runTurn()` is NOT interrupted mid-await (JavaScript does not support cancellation of in-flight promises). When `runTurn()` eventually continues (Ollama resolves or rejects), subsequent calls to `injectAudio(this.audioWs, ...)` may reach a closing or closed WebSocket. `ws.send()` on a non-OPEN WebSocket must not throw — guarded by `ws.readyState === WebSocket.OPEN` check before sending, OR Node.js `ws` library silently ignores sends on closed sockets. The `finally` block still executes: `processingTurn = false`.
**How to verify**: `call-handler.test.ts` — start turn with mocked 500ms Ollama; after 100ms fire `ws.emit('close')`; assert `cleanup()` invoked; after turn resolves, assert no unhandled rejection; assert `processingTurn === false`; assert `conversationHistory.length === 0`.

`NEG-P2-24: WS close during pipeline in-flight — identical to call_ended recovery`
**Condition**: The Simulator Backend's WebSocket connection to `/gamma/audio` closes unexpectedly (network drop, process kill) while `runTurn()` is at an `await`.
**Expected behaviour**: `ws.on('close', ...)` handler fires; calls `cleanup()`; sets `activeHandler = null`. The in-flight `runTurn()` eventually resolves/rejects; its `finally` block runs (`processingTurn = false`). Any attempt to `injectAudio()` on the now-closed WS is handled without crashing — `ws.readyState !== WebSocket.OPEN` blocks the send, or `ws.send` on closed socket emits an `'error'` event that is handled. No orphaned timer, no memory leak (VAD destroyed in `cleanup()`).
**How to verify**: `call-handler.test.ts` — use a mock WS that throws on `send()` after close; trigger turn; call `ws.emit('close')`; advance timers until turn resolves; assert no unhandled rejection; assert `vad.destroy()` called; assert `processingTurn === false`.

`NEG-P2-25: processingTurn lock set synchronously — no race window between VAD fire and lock activation`
**Condition**: The critical invariant (§4.2, high-risk mitigation): `this.processingTurn = true` MUST be set synchronously in `handleAudioFrame()` BEFORE `void this.runTurn()` is called. If the lock is set inside `runTurn()` at the first `await`, a second message event can fire in the gap between `runTurn()` being called and the first `await` — launching a concurrent turn.
**Expected behaviour**: `handleAudioFrame()` code path when VAD fires: (1) `this.processingTurn = true` — synchronous set; (2) `void this.runTurn(speechBuffer)` — async invocation. No `await` between (1) and the lock check at top of `handleAudioFrame()`. A second synchronous call to `handleAudioFrame()` immediately after the first (simulating the JS event loop delivering the next message before yielding) sees `processingTurn === true` and returns immediately.
**How to verify**: `call-handler.test.ts` — mock `vad.feed` to always return a speech buffer; call `handleAudioFrame()` twice in the SAME synchronous execution context (no `await` between); mock `runTurn` to be an async function that records invocations; assert `runTurn` was called exactly **once**; assert `processingTurn === true` after both calls; assert the second call returned without invoking `runTurn`.

---

#### Domain D: Simulator Backend Session Management (NEG-P2-26 to NEG-P2-35)

`NEG-P2-26: Dial with unknown personaId — error sent to browser, no counterparty connection opened`
**Condition**: Browser sends `{ type: "dial", personaId: "xx-nonexistent" }` over `/ws/simulator`. `personaLoader.getPersonas().find(p => p.id === 'xx-nonexistent')` returns `undefined`.
**Expected behaviour**: `handleDial()` sends `JSON.stringify({ type: "error", reason: "unknown_persona" })` to `client`. No `new WebSocket(counterpartyUrl + '/gamma/audio')` is opened. `callSessionService.create()` is NOT called. The session Map remains unchanged. Browser `callStatus` should NOT transition beyond `idle`.
**How to verify**: `simulator.gateway.test.ts` — mock `personaLoader.getPersonas()` returning the 5 standard personas; dispatch `{ type: "dial", personaId: "xx-ghost" }`; assert `client.send` called once with `{ type: "error", reason: "unknown_persona" }`; assert zero outbound WS connections created.

`NEG-P2-27: Second dial while call already active — error sent, existing call untouched`
**Condition**: Browser sends a second `{ type: "dial", personaId: "es-carlos" }` while `callSessionService.get(client)` returns a non-null active session (first call in progress).
**Expected behaviour**: `handleDial()` checks for existing session first; finds one; sends `{ type: "error", reason: "call_already_active" }` to browser; returns without opening any new Counterparty connections. The existing session's `counterpartyAudioWs` and `counterpartyEventsWs` are completely unaffected.
**How to verify**: `simulator.gateway.test.ts` — seed session for client; dispatch second `{ type: "dial" }`; assert `client.send` called with `{ type: "error", reason: "call_already_active" }`; assert existing session's WS mocks untouched; assert no new WS connections opened.

`NEG-P2-28: Hangup with no active call — silently ignored, no crash`
**Condition**: Browser sends `{ type: "hangup" }` before any `{ type: "dial" }` has been processed, or after a previous call's teardown has already cleared the session.
**Expected behaviour**: `handleHangup()` calls `callSessionService.get(client)` → `undefined`; returns without sending `call_ended` to any counterparty (no WS exists). Browser receives nothing. No error logged at `error` level. No unhandled exception. Process remains stable.
**How to verify**: `simulator.gateway.test.ts` — dispatch `{ type: "hangup" }` with empty session Map; assert no error thrown; assert `client.send` not called; assert process alive.

`NEG-P2-29: Binary audio frame before dial — silently discarded`
**Condition**: Browser sends a raw binary `ArrayBuffer` (Float32 audio) before any `{ type: "dial" }` has been processed (no `CallSession` exists for this client WebSocket).
**Expected behaviour**: Gateway's `message` handler checks `isBinary === true`; calls `callSessionService.get(client)` → `undefined`; returns without processing. `InboundAudioTranscoder.processInbound()` is NOT called. No counterparty WS to forward to. No crash.
**How to verify**: `simulator.gateway.test.ts` — dispatch binary frame (mock `Buffer.alloc(320)`) with no active session; assert `processInbound` not called; assert no error thrown; assert `client.send` not called.

`NEG-P2-30: Browser WS closes mid-call — call_ended sent to Counterparty, both connections closed, session cleared`
**Condition**: Browser WebSocket closes unexpectedly (tab closed, network drop) while a call is active and both Counterparty WS connections are open.
**Expected behaviour**: `ws.on('close', ...)` fires; `callSessionService.teardown(client)` executes: (1) `clearTimeout(session.connectingTimeout)`, (2) `counterpartyAudioWs.send({ event: 'call_ended', callId, timestamp })`, (3) `counterpartyAudioWs.close()`, (4) `counterpartyEventsWs.close()`, (5) `sessions.delete(client)`. After teardown: session Map is empty; no orphaned Counterparty WS connections.
**How to verify**: `simulator.gateway.test.ts` — create mock session with mock `counterpartyAudioWs` and `counterpartyEventsWs`; fire `client.emit('close')`; assert `counterpartyAudioWs.send` called once with `call_ended` event; assert `counterpartyAudioWs.close()` called; assert `counterpartyEventsWs.close()` called; assert `sessions.size === 0`.

`NEG-P2-31: Counterparty /gamma/audio WS closes unexpectedly — error sent to browser, /events closed, session cleaned up`
**Condition**: The Counterparty `/gamma/audio` WebSocket closes mid-call (counterparty Docker container restart, OOM kill, network error).
**Expected behaviour**: `counterpartyAudioWs.on('close', ...)` fires; `client.send(JSON.stringify({ type: "error", reason: "Connection lost — counterparty audio disconnected" }))` sent to browser; `counterpartyEventsWs.close()` called; `sessions.delete(client)` called. Browser `callStatus` transitions to `error` via `CALL_ERROR` dispatch.
**How to verify**: `simulator.gateway.test.ts` — fire `counterpartyAudioWs.emit('close')`; assert `client.send` called with `{ type: "error", reason: ... }`; assert `counterpartyEventsWs.close()` called; assert session removed.

`NEG-P2-32: Counterparty /events WS closes unexpectedly while /gamma/audio alive — warning logged, audio continues, call NOT torn down`
**Condition**: The Counterparty `/events` WebSocket closes (connection drops, server-side events WS error) but `/gamma/audio` remains open and streaming audio.
**Expected behaviour**: `counterpartyEventsWs.on('close', ...)` fires; a `warn`-level log emitted ("events WebSocket disconnected — metadata stream degraded"). The call is NOT torn down. No `{ type: "error" }` sent to browser. Audio relay continues uninterrupted via `counterpartyAudioWs`. Browser loses live transcript/token updates but continues to receive audio. This is graceful degradation.
**How to verify**: `simulator.gateway.test.ts` — fire `counterpartyEventsWs.emit('close')` with active session; assert `client.send` NOT called with error type; assert `session.isActive === true`; assert `counterpartyAudioWs` unchanged (still open mock); assert `logger.warn` invoked.

`NEG-P2-33: 10-second connecting timeout fires — error sent to browser, connections cleaned up`
**Condition**: After `{ type: "dial" }`, no binary audio frame arrives from the Counterparty within 10,000ms (Piper stalled during opener synthesis, Counterparty pipeline stuck, Whisper pre-loading cold).
**Expected behaviour**: `session.connectingTimeout = setTimeout(...)` fires at 10,001ms; `client.send(JSON.stringify({ type: "error", reason: "connection_timeout" }))` sent to browser; `callSessionService.teardown(client)` called. `clearTimeout` is NOT called (timer already fired). Browser `callStatus` transitions to `error`; `CallErrorBanner` shows "Connection timed out." Corresponds to ACC-P2-21.
**How to verify**: `simulator.gateway.test.ts` — `vi.useFakeTimers()`; trigger `handleDial()`; do NOT send any audio from Counterparty mock; advance timers by 10,001ms; assert `client.send` called with `{ type: "error", reason: "connection_timeout" }`; assert teardown called. Second test: send binary audio at 9,999ms; assert timeout was cleared; assert no error sent.

`NEG-P2-34: Counterparty sends audio on wrong trackId — frame discarded, warning logged`
**Condition**: Counterparty sends `{ event: "audio", payload: "...", trackId: "wrong-track-uuid" }` where `wrong-track-uuid !== session.txTrackId`.
**Expected behaviour**: NestJS gateway `counterpartyAudioWs.on('message', ...)` handler parses the frame; checks `frame.trackId === session.txTrackId` — mismatch; discards frame; emits `logger.warn('Received audio on unexpected trackId: ...')`. `InboundAudioTranscoder.upsampleToFloat32()` is NOT called. Browser receives no spurious audio binary frame. The connecting timeout is NOT cleared (this was not a valid audio frame).
**How to verify**: `simulator.gateway.test.ts` — dispatch `{ event: "audio", payload: "AAAA", trackId: "unexpected-id" }` from counterparty audio WS mock; assert `client.send` (binary) NOT called; assert `logger.warn` called with the mismatched `trackId`.

`NEG-P2-35: InboundAudioTranscoder receives non-multiple-of-4 bytes — no crash, partial samples handled`
**Condition**: Browser sends a binary frame of 7 bytes (not divisible by 4 — `Float32Array` requires 4 bytes per sample). This can happen on AudioWorklet buffer boundary edge cases.
**Expected behaviour**: `processInbound(Buffer.alloc(7))` creates `new Float32Array(data.buffer, data.byteOffset, data.length / 4)` — `Math.floor(7/4) = 1` Float32 sample read; the 3 trailing bytes are silently ignored by TypedArray construction. The 1 sample is pushed to the accumulator. If accumulator has < 3 samples, returns `null`. No crash. No unhandled exception.
**How to verify**: `audio-transcoder.test.ts` — `new InboundAudioTranscoder().processInbound(Buffer.alloc(7))` → assert no error thrown; assert result is `null` (accumulator has only 1 sample, < 3 needed for one output sample).

---

#### Domain E: Audio Transcoding Edge Cases (NEG-P2-36 to NEG-P2-40)

`NEG-P2-36: Empty binary frame from browser — discarded, no crash`
**Condition**: Browser sends a 0-byte binary `ArrayBuffer` over `/ws/simulator` during an active call. Can happen at AudioWorklet buffer flush on call teardown.
**Expected behaviour**: `processInbound(Buffer.alloc(0))` → `new Float32Array(data.buffer, 0, 0)` → zero iterations → accumulator unchanged → `accumulator.length < 3` → returns `null`. Calling code receives `null`; does NOT forward to Counterparty. No crash. No `0-byte` audio frame sent to counterparty.
**How to verify**: `audio-transcoder.test.ts` — `new InboundAudioTranscoder().processInbound(Buffer.alloc(0))` → assert returns `null`; assert no error thrown. Gateway test: dispatch 0-byte binary frame during active session; assert `counterpartyAudioWs.send` NOT called.

`NEG-P2-37: Very large audio frame from browser — transcoded correctly, no truncation, remainder preserved`
**Condition**: Browser sends an unusually large binary frame — 192,000 bytes (48,000 Float32 samples = 1 second at 48kHz). This can occur if the AudioWorklet batches frames during tab background throttling.
**Expected behaviour**: `processInbound(Buffer.alloc(192000))` → 48,000 Float32 samples → `outSamplesCount = Math.floor(48000 / 3) = 16000` S16LE samples → 32,000 bytes returned. No sample loss. Remainder = `48000 - (16000 * 3) = 0` samples in accumulator (no remainder for this case). All output bytes correctly clamped to `[-32768, 32767]`.
**How to verify**: `audio-transcoder.test.ts` — `processInbound(Buffer.alloc(192000))` → assert `result !== null`; assert `result.length === 32000`; assert no error thrown.

`NEG-P2-38: Counterparty sends audio event with empty base64 payload — discarded at Counterparty, graceful at NestJS`
**Condition**: An `audio` event with `payload: ""` arrives at the Counterparty `handleAudioFrame()`. Also: if an empty-payload audio event somehow reaches NestJS `counterpartyAudioWs`, `upsampleToFloat32("")` is called.
**Expected behaviour**: Counterparty: `Buffer.from("", "base64")` → 0-length buffer → `decoded.length === 0` → return immediately. NestJS: `InboundAudioTranscoder.upsampleToFloat32("")` → `Buffer.from("", "base64")` → `inputSamplesCount = 0` → `new Float32Array(0)` → `ArrayBuffer` with `byteLength === 0` returned. Gateway sends a 0-byte binary to browser. Browser `AudioContext.createBuffer(1, 0, 48000)` produces a zero-frame buffer — should not crash (but produces no audio).
**How to verify**: `audio-transcoder.test.ts` — `InboundAudioTranscoder.upsampleToFloat32("")` → assert `result instanceof ArrayBuffer`; assert `result.byteLength === 0`; assert no error thrown.

`NEG-P2-39: Counterparty sends very large audio payload — decoded and upsampled correctly`
**Condition**: Piper returns a lengthy TTS response. `injectAudio()` chunks the PCM into multiple frames (each chunk ~ `Math.ceil(pcm.length / chunkSize)` frames). NestJS receives each chunk as a separate `audio` event and upsamples each independently.
**Expected behaviour**: For each chunk, `upsampleToFloat32(payload)` decodes the S16LE PCM and produces a `Float32Array` 3× the input sample count (1:3 linear interpolation). Each upsampled chunk is sent as a binary ArrayBuffer to the browser. No single chunk produces a memory explosion. Total audio is playback-gapless when concatenated.
**How to verify**: `audio-transcoder.test.ts` — create a 32,000-byte S16LE buffer (16,000 samples = 1 second at 16kHz); base64-encode; call `upsampleToFloat32(payload)`; assert `result.byteLength === 16000 * 3 * 4 = 192000`; assert no error thrown; spot-check interpolation: sample at index 3 should be `between` sample 0 and sample 1 of the input.

`NEG-P2-40: InboundAudioTranscoder accumulator preserves cross-frame remainder (no sample loss or duplication)`
**Condition**: A Float32 frame with 10 samples arrives (not divisible by 3). The accumulator is initially empty.
**Expected behaviour**: First call (10 samples): accumulator holds 10 → `floor(10/3) = 3` output S16LE samples (6 bytes) → remainder = `10 - 9 = 1` sample stays in accumulator. Second call (10 samples): accumulator has `1 + 10 = 11` → `floor(11/3) = 3` output S16LE samples (6 bytes) → remainder = `11 - 9 = 2`. Neither a sample is lost nor added. 20 total input samples across two calls produce 6 output samples with 2 in the accumulator — confirming 0 sample loss.
**How to verify**: `audio-transcoder.test.ts` — create a `Float32Array` of 10 samples (40 bytes); call `processInbound` twice; assert first call returns `Buffer.length === 6`; assert second call returns `Buffer.length === 6`; assert `transcoder['sampleAccumulator'].length === 2` after second call.

---

#### Domain F: ECR Deploy Pipeline (NEG-P2-41 to NEG-P2-45)

`NEG-P2-41: make deploy-app with expired AWS credentials — fails before any SSH, no partial state`
**Condition**: `~/.aws/credentials` has expired tokens. `aws sts get-caller-identity` (used in `ECR_ACCOUNT = $(shell aws sts get-caller-identity ...)` expansion) or `aws ecr get-login-password` fails with `ExpiredTokenException`.
**Expected behaviour**: Make recipe exits non-zero at the `aws ecr get-login-password` step (first AWS call in the recipe body). No `docker build` is started. No SSH key (`/tmp/voxhop-deploy-key`) is generated. No SSH connection is attempted to the EC2 instance. Error output from AWS CLI is visible in terminal.
**How to verify**: `AWS_ACCESS_KEY_ID=AKIA_INVALID AWS_SECRET_ACCESS_KEY=invalid make deploy-app`; assert exit code non-zero; assert `/tmp/voxhop-deploy-key` does not exist (`ls /tmp/voxhop-deploy-key 2>&1 | grep 'No such file'`).

`NEG-P2-42: EC2 Instance Connect key push fails — deploy aborts, SSH not attempted`
**Condition**: `aws ec2-instance-connect send-ssh-public-key` fails (invalid `INSTANCE_ID`, wrong `AZ`, IAM permission denied, or network timeout).
**Expected behaviour**: `aws ec2-instance-connect` exits non-zero; Make recipe stops at that line. The subsequent `ssh ... ec2-user@$(EIP)` is NOT executed. The ephemeral key may remain on disk at `/tmp/voxhop-deploy-key` (Make stops at the failing step, not at the `rm -f` cleanup). This is a documented risk — Engineering MUST verify the `rm -f` cleanup line runs regardless of failure (via `||` or a final cleanup target).
**How to verify**: Set `INSTANCE_ID=i-000000000` (invalid); run `make deploy-app` (with valid ECR push before this step); observe exit at `send-ssh-public-key`; verify SSH was not attempted; check whether `/tmp/voxhop-deploy-key` is cleaned up — raise as `KI-001` if not.

`NEG-P2-43: Docker pull from ECR fails on instance — compose up not executed, previous container untouched`
**Condition**: `docker compose pull voxhop voxhop-simulator voxhop-counterparty` fails on the instance because an ECR image was never pushed (new ECR repo, or wrong ECR URL in compose file).
**Expected behaviour**: `docker compose pull` exits non-zero; the SSH command chain uses `&&`, so `docker compose up -d` is NOT executed. Existing running containers (from the previous deployment) continue running unchanged. Service remains available at its last-deployed version. `make deploy-app` exits non-zero with visible SSH output.
**How to verify**: Delete one ECR image tag; run `make deploy-app`; SSH into instance; verify `docker ps` shows previous image still running; verify `make deploy-app` exited non-zero.

`NEG-P2-44: docker compose up -d fails — previous container survives, deploy reports failure`
**Condition**: `docker compose up -d voxhop-counterparty` fails because port 3001 is already allocated by a rogue process (not Docker). Or: a startup health check immediately fails.
**Expected behaviour**: `docker compose up -d` exits non-zero; SSH command returns failure; `make deploy-app` exits non-zero with visible error. Docker Compose does NOT kill the currently running container before attempting the new one (it first stops, then starts — if start fails, the stopped container may not restart). Engineering should validate the rollback behaviour and document.
**How to verify**: Pre-test: `ssh ec2-user@$(EIP) 'nohup nc -l -p 3001 &'`; run `make deploy-app`; observe compose up failure; verify previous service reachable via `curl http://...:3001/health`.

`NEG-P2-45: Ephemeral SSH key persists on disk if make deploy-app fails mid-recipe — security risk`
**Condition**: `make deploy-app` succeeds through `ssh-keygen` (key generated at `/tmp/voxhop-deploy-key`) but fails at `aws ec2-instance-connect send-ssh-public-key` or the `ssh` step. Make stops at the failing command; the `rm -f /tmp/voxhop-deploy-key` cleanup at the end of the recipe is never reached.
**Expected behaviour (mandated)**: The deploy recipe MUST ensure the ephemeral key is cleaned up even on failure. Acceptable solutions: (a) use `trap 'rm -f /tmp/voxhop-deploy-key /tmp/voxhop-deploy-key.pub' EXIT` in a shell wrapper, or (b) use `$(RM_KEY)` as a final Make target dependency that always runs, or (c) use `@ssh-keygen ... ; aws ... ; ssh ... ; rm -f ...` with explicit error handling. The current recipe as specced does NOT guarantee cleanup — this is a **medium-severity gap**.
**How to verify**: Simulate failure at SSH step; check `ls -la /tmp/voxhop-deploy-key`; if key persists → raise `KI-002: Ephemeral SSH key not cleaned on deploy failure`.

---

#### Domain G: Service Boundary Enforcement (NEG-P2-46 to NEG-P2-50)

`NEG-P2-46: voxhop-counterparty/package.json — no ioredis in dependencies or devDependencies`
**Condition**: Check the Counterparty `package.json` for any `ioredis` reference. §7.5 is an absolute mandate: no Redis dependency allowed.
**Expected behaviour**: `Object.keys(pkg.dependencies ?? {})` does not include `'ioredis'`. `Object.keys(pkg.devDependencies ?? {})` does not include `'ioredis'`. Production deps are exactly the permitted set: `avr-vad`, `form-data`, `pino`, `ws`, `zod`.
**How to verify**: CP-02 structural test in `voxhop-simulator/test/smoke.test.ts` — `expect(deps).not.toContain('ioredis')`. Extend to also check `devDependencies`. `expect(deps).not.toContain('@nestjs/core')` (§7.2 mandate).

`NEG-P2-47: voxhop-counterparty/src/ imports nothing from voxhop/src/ or voxhop-simulator/src/`
**Condition**: A cross-package import scan of all files in `voxhop-counterparty/src/`. Any `import` referencing `../../voxhop/src/`, `../../voxhop-simulator/src/`, or package names owned by other services violates §7.1 (Service Boundary Law — Absolute).
**Expected behaviour**: `grep -rn "from.*voxhop/src\|from.*voxhop-simulator"` across `voxhop-counterparty/src/` returns empty. All shared code (`StagedError`, `downsampleTo16k`, `buildWav`, `SileroVAD`) is copied verbatim per §7.2 mandate.
**How to verify**: Structural smoke test in `voxhop-simulator/test/smoke.test.ts` — mirrors MN-03 pattern: `execSync("grep -rn 'from.*voxhop/src\\|from.*voxhop-simulator/src' voxhop-counterparty/src/ 2>/dev/null || true")` → assert `result.trim() === ''`.

`NEG-P2-48: git diff HEAD -- voxhop/src/ is empty — Track 1 freeze enforced`
**Condition**: After all Phase 2 implementation commits, `git diff HEAD` against `voxhop/src/` and `voxhop/test/` must be empty. Zero modifications to Track 1 code permitted (§7.1, MN-06).
**Expected behaviour**: Both `git diff HEAD -- voxhop/src/` and `git diff HEAD -- voxhop/test/` return empty strings. This includes: no new imports added to existing files, no type additions, no schema changes, no comment edits.
**How to verify**: MN-06 smoke tests (already present in `voxhop-simulator/test/smoke.test.ts`) — both must continue to pass after Phase 2 implementation. This is a retained gate, not a new one.

`NEG-P2-49: voxhop-counterparty/src/ contains no @nestjs/* imports — plain Node.js mandate enforced`
**Condition**: A scan of all TypeScript files in `voxhop-counterparty/src/` for any `@nestjs/` import string. §7.2 is absolute: no NestJS in the Counterparty service.
**Expected behaviour**: `grep -rn "@nestjs" voxhop-counterparty/src/` returns empty. No `@Injectable()`, no `@WebSocketGateway()`, no `@Module()`, no `@Controller()`. The HTTP + WS server is plain `node:http` + `ws` only.
**How to verify**: Add to CP-02 block in `voxhop-simulator/test/smoke.test.ts`: `execSync("grep -rn '@nestjs' voxhop-counterparty/src/ 2>/dev/null || true")` → assert `result.trim() === ''`.

`NEG-P2-50: Track 1 Vitest suite — all 55 tests pass, zero regressions, zero test count reduction`
**Condition**: After Phase 2 is fully implemented, `npm test` in `voxhop/` runs the complete existing test suite. Phase 2 adds zero modifications to `voxhop/src/` or `voxhop/test/`, so all 55 tests must pass unchanged.
**Expected behaviour**: Exit code 0. Pass count ≥ 55 (exact count locked: chaos tests ×10, frame-shape tests ×13, StagedError tests ×3, NEG-06 ×1, NEG-16 ×1, lock ×2, dual-leg ×1 = confirmed at 55 total as of Phase 1). Fail count = 0. No test file deleted. No test renamed or `.skip`-ped. The Track 1 Vitest configuration (`vitest.config.ts`) is unmodified.
**How to verify**: `npm test` in `voxhop/`; assert exit 0; assert printed summary contains `55 passed`; assert `0 failed`. Corresponds to ACC-P2-23 and ACC-P2-24.

---

## 6. UI/UX DESIGN

*UI/UX Specialist CO-SIGN — 2026-06-07*

This section is the binding design specification for the Phase 2 Direct Mode frontend.

---

### 6.0 Wireframes

All wireframes use ASCII notation. Actual implementation uses Tailwind CSS classes defined in §6.1–§6.15. Dimensions are proportional, not pixel-exact. Annotations in `← angle brackets` reference the applicable Tailwind token from §6.1.

---

#### WF-1A: Idle State — No Persona Selected

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ▪ VoxHop Simulator                         ← bg-gray-950, header bar   │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PERSONAS  ·· ← text-xs font-mono uppercase tracking-widest text-gray-400│
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │  🇬🇧  [EN]       │  │  🇪🇸  [ES]       │  │  🇫🇷  [FR]       │         │
│  │                 │  │                 │  │                 │         │
│  │  James          │  │  Sofia          │  │  Lara           │         │
│  │  text-gray-100  │  │  text-gray-100  │  │  text-gray-100  │         │
│  │                 │  │                 │  │                 │         │
│  │  "Hi, I'm a B2B │  │  "Hola, soy una │  │  "Bonjour, je   │         │
│  │   sales agent…" │  │   agente de…"   │  │   suis agent…"  │         │
│  │  text-gray-500  │  │  text-gray-500  │  │  text-gray-500  │         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
│    border-gray-800       border-gray-800      border-gray-800           │
│    bg-gray-900           bg-gray-900          bg-gray-900               │
│    cursor-pointer        cursor-pointer        cursor-pointer           │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Select a persona to begin a call  ·  [ Dial (Direct) ▶ ]        │   │
│  │  ← text-gray-500, id="dial-helper-text"  ← bg-gray-800 opacity-60│   │
│  │                                            cursor-not-allowed     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│    ← bg-gray-900 border-gray-800 rounded-lg px-5 py-4 mt-6             │
└──────────────────────────────────────────────────────────────────────────┘
```

---

#### WF-1B: Idle State — Persona Selected (James)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ▪ VoxHop Simulator                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PERSONAS                                                                │
│                                                                          │
│  ┌─════════════════╗  ┌─────────────────┐  ┌─────────────────┐         │
│  ║  🇬🇧  [EN]       ║  │  🇪🇸  [ES]       │  │  🇫🇷  [FR]       │         │
│  ║                 ║  │                 │  │                 │         │
│  ║  James  ◉       ║  │  Sofia          │  │  Lara           │         │
│  ║  aria-pressed   ║  │                 │  │                 │         │
│  ║  ="true"        ║  │                 │  │                 │         │
│  ║  "Hi, I'm a B2B ║  │  "Hola, soy una │  │  "Bonjour, je   │         │
│  ║   sales agent…" ║  │   agente de…"   │  │   suis agent…"  │         │
│  ╚═════════════════╝  └─────────────────┘  └─────────────────┘         │
│  border-2 border-indigo-500                  border-gray-800            │
│  bg-indigo-950/30                            bg-gray-900                │
│  ring-1 ring-indigo-500/20                                              │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  ● James  [EN]                      [ Dial (Direct) ▶ ] ENABLED  │   │
│  │  ← indigo dot + text-gray-100        ← bg-indigo-600             │   │
│  │                                        hover:bg-indigo-500       │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

#### WF-2: Connecting State — Split-Pane, Call Initiating

*Triggered immediately on `DIAL_INITIATED`. Layout hard-switches; no CSS animation.*

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ▪ VoxHop Simulator                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐  ┌────────────────────────────────────────────────┐ │
│  │ ← w-72 sidebar │  │  ← flex-1 call panel                           │ │
│  │                │  │                                                │ │
│  │ ┌════════════╗ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ ║ 🇬🇧  [EN]   ║ │  │  │ James  [EN]  ·  ● CONNECTING  · [ Hang Up ▶ ] │ │
│  │ ║             ║ │  │  │              amber badge (disabled)       │  │ │
│  │ ║ James       ║ │  │  └──────────────────────────────────────────┘  │ │
│  │ ║ ● pulsing   ║ │  │    ← bg-gray-900 border-gray-800 rounded-lg   │ │
│  │ ║   green dot ║ │  │                                                │ │
│  │ ╚════════════╝ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ bg-indigo-950  │  │  │                                          │  │ │
│  │ border-indigo  │  │  │    ⟳  ← animate-spin text-amber-400     │  │ │
│  │                │  │  │                                          │  │ │
│  │ ┌────────────┐ │  │  │    ESTABLISHING CONNECTION               │  │ │
│  │ │ Sofia  [ES]│ │  │  │    ← text-xs font-mono text-amber-400   │  │ │
│  │ │ opacity-40 │ │  │  │                                          │  │ │
│  │ │ cursor-not │ │  │  │    Sending call to James…               │  │ │
│  │ │ -allowed   │ │  │  │    ← text-gray-500 text-sm              │  │ │
│  │ │ pointer-ev │ │  │  │                                          │  │ │
│  │ │ ents-none  │ │  │  └──────────────────────────────────────────┘  │ │
│  │ │ tabIndex=-1│ │  │    ← role="log" aria-live="polite"             │ │
│  │ └────────────┘ │  │                                                │ │
│  │ ┌────────────┐ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ │ Lara  [FR] │ │  │  │ ▾ PIPELINE TELEMETRY — 0 turns    [SHOW] │  │ │
│  │ │ opacity-40 │ │  │  │   ← hidden until telemetry.length > 0    │  │ │
│  │ └────────────┘ │  │  └──────────────────────────────────────────┘  │ │
│  └────────────────┘  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

#### WF-3A: Active Call — Turn Processing (User Spoke, Ollama In-Flight)

*`processingTurn = true`, `llmTokenBuffer = ''` → ProcessingIndicator shown.*

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ▪ VoxHop Simulator                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐  ┌────────────────────────────────────────────────┐ │
│  │                │  │                                                │ │
│  │ ┌════════════╗ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ ║ 🇬🇧  [EN]   ║ │  │  │ James  [EN]  ·  ● ACTIVE   ·  [ Hang Up ✕ ] │ │
│  │ ║             ║ │  │  │              ← green badge    ← bg-red-700  │ │
│  │ ║ James       ║ │  │  │              ← focus auto-    ref={hangUpRef}│ │
│  │ ║ ● animate-  ║ │  │  └──────────────────────────────────────────┘  │ │
│  │ ║   pulse     ║ │  │                                                │ │
│  │ ║   green dot ║ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ ╚════════════╝ │  │  │                                          │  │ │
│  │                │  │  │ ▌ [You]  [EN]  14:32:05                  │  │ │
│  │ ┌────────────┐ │  │  │ border-l-2 border-blue-600 bg-blue-950/20│  │ │
│  │ │ Sofia [ES] │ │  │  │ "Can you tell me about your pricing?"    │  │ │
│  │ │ opacity-40 │ │  │  │                                          │  │ │
│  │ └────────────┘ │  │  │ ▌ [James]  [EN]  14:32:01               │  │ │
│  │ ┌────────────┐ │  │  │ border-l-2 border-blue-600 bg-blue-950/20│  │ │
│  │ │ Lara  [FR] │ │  │  │ "Hello! I'd be happy to help you. We    │  │ │
│  │ │ opacity-40 │ │  │  │  offer three tiers…"                    │  │ │
│  │ └────────────┘ │  │  │                                          │  │ │
│  │                │  │  │  ⟳  PIPELINE PROCESSING                 │  │ │
│  │                │  │  │     ← animate-spin text-amber-400        │  │ │
│  │                │  │  │     ● ● ●  ← animate-pulse text-amber-400│  │ │
│  │                │  │  │     aria-live="polite"                   │  │ │
│  │                │  │  │                                          │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  │                │  │    ← role="log" auto-scroll fires              │ │
│  │                │  │                                                │ │
│  │                │  │  ┌──────────────────────────────────────────┐  │ │
│  │                │  │  │ ▾ PIPELINE TELEMETRY — 1 turn     [SHOW] │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  └────────────────┘  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

#### WF-3B: Active Call — LLM Streaming (Ollama Tokens Arriving)

*`processingTurn = true`, `llmTokenBuffer !== ''` → LLMStreamEntry shown; ProcessingIndicator hidden.*

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ▪ VoxHop Simulator                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐  ┌────────────────────────────────────────────────┐ │
│  │                │  │                                                │ │
│  │ ┌════════════╗ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ ║ James  [EN]║ │  │  │ James  [EN]  ·  ● ACTIVE   ·  [ Hang Up ✕ ] │ │
│  │ ║ ● green    ║ │  │  └──────────────────────────────────────────┘  │ │
│  │ ╚════════════╝ │  │                                                │ │
│  │                │  │  ┌──────────────────────────────────────────┐  │ │
│  │ ┌────────────┐ │  │  │                                          │  │ │
│  │ │ Sofia [ES] │ │  │  │ ▌ [You]  [EN]  14:32:05                  │  │ │
│  │ │ opacity-40 │ │  │  │ border-l-2 border-blue-600 bg-blue-950/20│  │ │
│  │ └────────────┘ │  │  │ "Can you tell me about your pricing?"    │  │ │
│  │ ┌────────────┐ │  │  │                                          │  │ │
│  │ │ Lara  [FR] │ │  │  │ ▌ [James]  [EN]  14:32:01               │  │ │
│  │ │ opacity-40 │ │  │  │ border-l-2 border-blue-600 bg-blue-950/20│  │ │
│  │ └────────────┘ │  │  │ "Hello! I'd be happy to help you. We    │  │ │
│  │                │  │  │  offer three tiers…"                    │  │ │
│  │                │  │  │                                          │  │ │
│  │                │  │  │ ─ ─ ─ ─ LLMStreamEntry ─ ─ ─ ─          │  │ │
│  │                │  │  │ border-l-2 border-blue-600 bg-blue-950/20│  │ │
│  │                │  │  │ [James]  [EN]  ● GENERATING (amber)      │  │ │
│  │                │  │  │ aria-live="off"                          │  │ │
│  │                │  │  │ "Of course! Our pricing plans start      │  │ │
│  │                │  │  │  with a Starter tier at €29/month,       │  │ │
│  │                │  │  │  which includes▌"                        │  │ │
│  │                │  │  │               ↑ text-indigo-400           │  │ │
│  │                │  │  │                 animate-pulse aria-hidden │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  │                │  │                                                │ │
│  │                │  │  ┌──────────────────────────────────────────┐  │ │
│  │                │  │  │ ▾ PIPELINE TELEMETRY — 1 turn     [SHOW] │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  └────────────────┘  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

#### WF-4: Ended State — Clean Hang-Up, Telemetry Expanded

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ▪ VoxHop Simulator                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐  ┌────────────────────────────────────────────────┐ │
│  │                │  │                                                │ │
│  │ ┌════════════╗ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ ║ James  [EN]║ │  │  │ James  [EN]  ·  ENDED  ·  [ New Call ↩ ] │  │ │
│  │ ║ (no dot)   ║ │  │  │              ← gray badge  ← bg-gray-700  │  │ │
│  │ ╚════════════╝ │  │  └──────────────────────────────────────────┘  │ │
│  │                │  │                                                │ │
│  │ ┌────────────┐ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ │ Sofia [ES] │ │  │  │                                          │  │ │
│  │ │ opacity-40 │ │  │  │ ▌ [You]  [EN]  14:32:05                  │  │ │
│  │ └────────────┘ │  │  │ "Can you tell me about your pricing?"    │  │ │
│  │ ┌────────────┐ │  │  │                                          │  │ │
│  │ │ Lara  [FR] │ │  │  │ ▌ [James]  [EN]  14:32:01               │  │ │
│  │ │ opacity-40 │ │  │  │ "Hello! I'd be happy to help you…"       │  │ │
│  │ └────────────┘ │  │  │                                          │  │ │
│  │                │  │  │ ▌ [You]  [EN]  14:32:18                  │  │ │
│  │                │  │  │ "What about enterprise plans?"           │  │ │
│  │                │  │  │                                          │  │ │
│  │                │  │  │ ▌ [James]  [EN]  14:32:22               │  │ │
│  │                │  │  │ "Enterprise starts at €299/month…"       │  │ │
│  │                │  │  │                                          │  │ │
│  │                │  │  │ (transcript frozen — no indicator)       │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  │                │  │                                                │ │
│  │                │  │  ┌──────────────────────────────────────────┐  │ │
│  │                │  │  │ ▲ PIPELINE TELEMETRY — 2 turns    [HIDE] │  │ │
│  │                │  │  │ aria-expanded="true"                     │  │ │
│  │                │  │  │ ┌────┬──────────┬──────────┬────────────┐│  │ │
│  │                │  │  │ │Turn│ STT      │ LLM      │ Total      ││  │ │
│  │                │  │  │ ├────┼──────────┼──────────┼────────────┤│  │ │
│  │                │  │  │ │ 1  │ 312 ms   │ 1,840 ms │ 2.84s ←🟡 ││  │ │
│  │                │  │  │ │ 2  │ 287 ms   │ 2,210 ms │ 3.21s ←🔴 ││  │ │
│  │                │  │  │ └────┴──────────┴──────────┴────────────┘│  │ │
│  │                │  │  │ ← text-green-400 / amber-400 / red-400   │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  └────────────────┘  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
  On [New Call ↩] click → DISMISS_CALL_RESULT → idle layout restored, focus
  restored to James persona card (via savedFocusRef + data-persona-id attr)
```

---

#### WF-5: Error State — Pipeline Failure During Call

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ▪ VoxHop Simulator                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐  ┌────────────────────────────────────────────────┐ │
│  │                │  │                                                │ │
│  │ ┌════════════╗ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ ║ James  [EN]║ │  │  │ James  [EN]  ·  ERROR  ·  [ Close ✕ ]    │  │ │
│  │ ╚════════════╝ │  │  │              ← red badge   ← bg-gray-700  │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  │ ┌────────────┐ │  │                                                │ │
│  │ │ Sofia [ES] │ │  │  ┌──────────────────────────────────────────┐  │ │
│  │ │ opacity-40 │ │  │  │ ⚠  Pipeline error (whisper): Request     │  │ │
│  │ └────────────┘ │  │  │    timed out after 10s. Turn interrupted. │  │ │
│  │ ┌────────────┐ │  │  │                                          │  │ │
│  │ │ Lara  [FR] │ │  │  │    [ Try Again ]  [ Close ]              │  │ │
│  │ │ opacity-40 │ │  │  │    bg-red-800      bg-gray-800           │  │ │
│  │ └────────────┘ │  │  │ ← role="alert"  bg-red-900/40            │  │ │
│  │                │  │  │   border-red-800  announced immediately   │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  │                │  │                                                │ │
│  │                │  │  ┌──────────────────────────────────────────┐  │ │
│  │                │  │  │ ▌ [You]  [EN]  14:32:05                  │  │ │
│  │                │  │  │ "Can you tell me about your pricing?"    │  │ │
│  │                │  │  │                                          │  │ │
│  │                │  │  │ ▌ [James]  [EN]  14:32:01               │  │ │
│  │                │  │  │ "Hello! I'd be happy to help you…"       │  │ │
│  │                │  │  │                                          │  │ │
│  │                │  │  │ (transcript frozen at last completed turn)│  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  │                │  │                                                │ │
│  │                │  │  ┌──────────────────────────────────────────┐  │ │
│  │                │  │  │ ▾ PIPELINE TELEMETRY — 1 turn     [SHOW] │  │ │
│  │                │  │  └──────────────────────────────────────────┘  │ │
│  └────────────────┘  └────────────────────────────────────────────────┘ │
│                                                                          │
│  CallErrorBanner sits between CallPanelHeader and TranscriptPanel.       │
│  Both [Try Again] and [Close] dispatch DISMISS_CALL_RESULT → idle.       │
└──────────────────────────────────────────────────────────────────────────┘
```

--- Engineering MUST NOT deviate from the layout architecture, component hierarchy, or interaction flows defined here without a subsequent UI/UX co-sign revision.

---

### 6.1 Design Language — Tokens and Palette

Phase 2 extends the Phase 1 Tailwind design system. All Phase 1 tokens are preserved unchanged.

#### Inherited Tokens (Phase 1 — Do Not Modify)

| Token | Tailwind Class | Usage |
|:------|:--------------|:------|
| Page background | `bg-gray-950` | Root div, header |
| Card background | `bg-gray-900` | All cards and panels |
| Card hover fill | `bg-gray-800/50` | Hover background |
| Primary border | `border-gray-800` | Card borders |
| Hover border | `border-gray-700` | Hover border upgrade |
| Primary text | `text-gray-100` | Headings, values |
| Secondary text | `text-gray-400` | Labels, section heads |
| Tertiary text | `text-gray-500` | Excerpts, placeholders |
| Mono section label | `text-xs font-mono uppercase tracking-widest` | Section header labels |
| Status green | `text-green-400` | Active / success indicators |
| Status amber | `text-amber-400` | Pending / warning indicators |
| Status red | `text-red-400` | Error indicators |

#### Phase 2 New Tokens

| Token | Tailwind Class | Usage |
|:------|:--------------|:------|
| Selection border | `border-2 border-indigo-500` | Selected persona card |
| Selection ring | `ring-1 ring-indigo-500/20` | Selected card outer glow |
| Selection fill | `bg-indigo-950/30` | Selected card background tint |
| Dial button (enabled) | `bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-medium text-sm px-6 py-2.5 rounded-md transition-colors duration-150` | Primary Dial CTA |
| Dial button (disabled) | `bg-gray-800 text-gray-600 cursor-not-allowed opacity-60` | No persona selected |
| Hang Up button | `bg-red-700 hover:bg-red-600 active:bg-red-500 text-white font-medium text-sm px-5 py-2 rounded-md transition-colors duration-150` | Destructive call-end CTA |
| Call badge — connecting | `bg-amber-900/40 text-amber-300 border border-amber-800 px-2 py-0.5 rounded` | Connecting status pill |
| Call badge — active | `bg-green-900/40 text-green-300 border border-green-800 px-2 py-0.5 rounded` | Live call status pill |
| Call badge — ended | `bg-gray-800 text-gray-400 border border-gray-700 px-2 py-0.5 rounded` | Ended status pill |
| Call badge — error | `bg-red-900/40 text-red-300 border border-red-800 px-2 py-0.5 rounded` | Error status pill |
| User transcript accent | `border-l-2 border-blue-600 bg-blue-950/20` | User speech entries |
| Locked card overlay | `opacity-40 cursor-not-allowed pointer-events-none` | Non-selected cards during call |
| Processing spinner | `text-amber-400 animate-spin` | SVG spinner |
| Processing dots | `text-amber-400 animate-pulse` | Three pulsing dots `● ● ●` |
| LLM streaming cursor | `text-indigo-400 animate-pulse` | Block cursor `▌` |
| New Call button | `bg-gray-700 hover:bg-gray-600 text-gray-100 font-medium text-sm px-5 py-2 rounded-md transition-colors duration-150` | Post-call navigation |

#### Language Badge Classes (Retained from Phase 1 — Unchanged)

| Language | Badge Class |
|:---------|:------------|
| EN | `bg-blue-900/60 text-blue-300 border border-blue-800` |
| ES | `bg-red-900/60 text-red-300 border border-red-800` |
| FR | `bg-indigo-900/60 text-indigo-300 border border-indigo-800` |
| DE | `bg-yellow-900/60 text-yellow-200 border border-yellow-800` |
| IT | `bg-green-900/60 text-green-300 border border-green-800` |

#### Counterparty Transcript Accent Colors (Phase 2 New)

| Language | Left Border | Background |
|:---------|:------------|:-----------|
| EN | `border-blue-600` | `bg-blue-950/20` |
| ES | `border-red-600` | `bg-red-950/20` |
| FR | `border-indigo-600` | `bg-indigo-950/20` |
| DE | `border-yellow-600` | `bg-yellow-950/20` |
| IT | `border-green-600` | `bg-green-950/20` |

User speech entries always use `border-blue-600 bg-blue-950/20` regardless of counterparty language.

---

### 6.2 Layout Architecture

#### 6.2.1 Idle State — Full-Width Persona Grid (Phase 1 preserved + `CallDialBar`)

Phase 1 layout unchanged. `CallDialBar` appended below persona grid with `mt-6`.

#### 6.2.2 Call State — Split-Pane Layout

When `callStatus` transitions to `'connecting'`, the layout hard-switches (no CSS animation). Persona grid + `CallDialBar` unmounted. Split-pane mounted:

```
className="flex gap-6 items-start"

Left:  className="w-72 shrink-0 flex flex-col gap-3"   (personas sidebar)
Right: className="flex-1 min-w-0 flex flex-col gap-4"  (call panel)
```

Sidebar: active persona card (indigo border + pulsing green dot), all other cards `opacity-40 cursor-not-allowed pointer-events-none tabIndex={-1}`.

Call panel (top to bottom): `CallPanelHeader` → optional `CallErrorBanner` → `TranscriptPanel` → `TelemetryPanel`.

#### 6.2.3 Ended / Error State

Same split-pane. `CallStatusBadge` transitions to gray `ENDED` or red `ERROR`. Hang Up replaced by `[New Call]` (ended) or `[Close]` (error). Transcript frozen. `CallErrorBanner` shown only in error state.

---

### 6.3 State Machine Extension

#### New Types (add to `types/persona.ts`)

```typescript
export type CallStatus = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export interface TranscriptEntry {
  id: string;           // crypto.randomUUID()
  role: 'user' | 'counterparty';
  text: string;
  language: string;     // 'en' | 'es' | 'fr' | 'de' | 'it'
  timestamp: number;    // Date.now()
}

export interface TelemetryRow {
  turnIndex: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}
```

#### `AppState` Extensions (add to existing `AppState`)

```typescript
callStatus: CallStatus;           // 'idle'
selectedPersonaId: string | null; // null
transcript: TranscriptEntry[];    // []
llmTokenBuffer: string;           // ''
processingTurn: boolean;          // false
telemetry: TelemetryRow[];        // []
callErrorMessage: string | null;  // null
```

#### New Actions (extend `AppAction` union)

```typescript
| { type: 'PERSONA_SELECT';        payload: string }
| { type: 'PERSONA_DESELECT' }
| { type: 'DIAL_INITIATED' }
| { type: 'CALL_ACTIVE' }
| { type: 'TRANSCRIPT_RECEIVED';   payload: { role: 'user' | 'counterparty'; text: string; language: string; timestamp: number } }
| { type: 'LLM_TOKEN_RECEIVED';    payload: string }
| { type: 'TURN_LATENCY_RECEIVED'; payload: { sttMs: number; llmMs: number; ttsMs: number; totalMs: number } }
| { type: 'HANG_UP_INITIATED' }
| { type: 'CALL_ENDED' }
| { type: 'CALL_ERROR';            payload: string }
| { type: 'DISMISS_CALL_RESULT' }
```

#### State Transition Table

| From | Action | To | Key Mutations |
|:-----|:-------|:---|:--------------|
| `idle` | `PERSONA_SELECT` | `idle` | `selectedPersonaId = payload` |
| `idle` | `PERSONA_DESELECT` | `idle` | `selectedPersonaId = null` |
| `idle` | `DIAL_INITIATED` | `connecting` | persona selection locked |
| `connecting` | `CALL_ACTIVE` | `active` | — |
| `connecting` | `CALL_ERROR` | `error` | `callErrorMessage = payload` |
| `active` | `TRANSCRIPT_RECEIVED (user)` | `active` | append entry; `processingTurn = true` |
| `active` | `LLM_TOKEN_RECEIVED` | `active` | `llmTokenBuffer += payload` |
| `active` | `TRANSCRIPT_RECEIVED (counterparty)` | `active` | append entry; `processingTurn = false`; `llmTokenBuffer = ''` |
| `active` | `TURN_LATENCY_RECEIVED` | `active` | append `TelemetryRow` |
| `active` | `HANG_UP_INITIATED` | `ended` | — |
| `active` | `CALL_ENDED` | `ended` | — |
| `active` | `CALL_ERROR` | `error` | `callErrorMessage = payload` |
| `ended` or `error` | `DISMISS_CALL_RESULT` | `idle` | full Phase 2 state reset |

`PERSONA_SELECT` / `PERSONA_DESELECT` only processed when `callStatus === 'idle'`. `DISMISS_CALL_RESULT` resets all Phase 2 fields to initial values.

#### `processingTurn` Lifecycle

- `true` fires on `TRANSCRIPT_RECEIVED (user)` — Whisper complete, Ollama in-flight.
- `false` fires on `TRANSCRIPT_RECEIVED (counterparty)` — Ollama complete, `llmTokenBuffer` cleared.
- `processingTurn && llmTokenBuffer === ''` → `ProcessingIndicator` shown.
- `llmTokenBuffer !== ''` → `LLMStreamEntry` shown, `ProcessingIndicator` hidden.

---

### 6.4 Component Hierarchy

#### Modified Existing Components (2)

| Component | Modification |
|:----------|:------------|
| `App.tsx` | Call state dispatch; binary/JSON WS routing; layout branch on `callStatus`; `hangUpRef` + `savedFocusRef`; 10s connecting timeout |
| `PersonaGrid.tsx` | Accept `mode`, `selectedPersonaId`, `callStatus`, `onSelectPersona`; render `PersonaCardSelectable`; sidebar mode uses `flex flex-col gap-3` |

**`PersonaCard.tsx` — zero modifications. File diff must be empty.**

#### New Components (11)

| Component | Responsibility |
|:----------|:--------------|
| `PersonaCardSelectable` | Interactive persona card — selection, lock, compact sidebar mode. `role="button"` with `aria-pressed`, Enter/Space handling. |
| `CallDialBar` | Bar below grid in idle state. Persona summary + enabled/disabled Dial button. |
| `CallPanel` | Outer call UI container. Composes `CallPanelHeader` + `CallErrorBanner` + `TranscriptPanel` + `TelemetryPanel`. |
| `CallPanelHeader` | Persona name + language badge + `CallStatusBadge` + context-action button (Hang Up / New Call / Close). |
| `CallStatusBadge` | Inline status pill with pulsing dot for `connecting` and `active`. |
| `TranscriptPanel` | `role="log"` scrollable conversation. Connecting/active empty states. Auto-scroll. |
| `TranscriptEntry` | Single completed turn. Role label + language badge + timestamp + language-accented border. |
| `ProcessingIndicator` | `animate-spin` SVG + `animate-pulse` dots. Shown when `processingTurn && llmTokenBuffer === ''`. |
| `LLMStreamEntry` | In-progress counterparty entry. Live token buffer + `▌` cursor. `aria-live="off"`. |
| `TelemetryPanel` | Collapsible per-turn latency table. Threshold colour coding. Collapsed by default. |
| `CallErrorBanner` | `role="alert"` error scoped inside call panel. Try Again + Close buttons → `DISMISS_CALL_RESULT`. |

---

### 6.5 User Journey — Primary Happy Path

1. Page reaches `ready` — persona grid + disabled `CallDialBar` rendered.
2. Developer selects James card — indigo ring applied, `CallDialBar` activates (indigo Dial button).
3. Developer clicks **Dial (Direct) ▶** — `DIAL_INITIATED`, layout switches to split-pane, `connecting` state.
4. First binary audio frame arrives — `CALL_ACTIVE`, Hang Up auto-focuses.
5. Developer hears greeting — no transcript entry (opener has no Whisper STT).
6. Developer speaks — mic audio streams as binary.
7. Whisper completes — `TRANSCRIPT_RECEIVED (user)`, user entry added, `ProcessingIndicator` shown.
8. Ollama streams — `LLM_TOKEN_RECEIVED` per token, `LLMStreamEntry` renders live.
9. Ollama completes — `TRANSCRIPT_RECEIVED (counterparty)`, `LLMStreamEntry` → `TranscriptEntry`, `processingTurn = false`.
10. Piper + `TURN_LATENCY_RECEIVED` — `TelemetryPanel` subtitle increments.
11. Developer clicks **Hang Up ✕** — `HANG_UP_INITIATED`, `ended` state, `[New Call]` shown.
12. Developer clicks **New Call** — `DISMISS_CALL_RESULT`, full reset, grid restored, focus to saved persona card.

---

### 6.6 `PersonaCardSelectable` — Interaction States

Props: `persona`, `isSelected`, `isLocked`, `compact`, `onClick`.

- **Unselected (grid)**: `border border-gray-800 bg-gray-900 cursor-pointer`, `role="button"`, `aria-pressed="false"`.
- **Selected (grid)**: `border-2 border-indigo-500 bg-indigo-950/30 ring-1 ring-indigo-500/20`, `aria-pressed="true"`.
- **Active call partner (sidebar, compact)**: `border-2 border-indigo-500 bg-indigo-950/30 p-3 cursor-default`, `role="article"`, pulsing green dot `animate-pulse bg-green-400`.
- **Locked (sidebar, compact)**: `border border-gray-800 bg-gray-900 opacity-40 cursor-not-allowed pointer-events-none`, `role="article"`, `tabIndex={-1}`, `aria-disabled="true"`.
- All interactive cards: `onKeyDown` handles Enter/Space with `e.preventDefault()`. `data-persona-id={persona.id}` for focus restoration.
- `focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950`.

---

### 6.7 `CallDialBar` — Specification

`className="bg-gray-900 border border-gray-800 rounded-lg px-5 py-4 mt-6 flex items-center justify-between gap-4"`

- Left: when selected — indigo dot + persona name + language badge. When null — `text-gray-500 text-sm` placeholder with `id="dial-helper-text"`.
- Right: Dial button. Enabled (`bg-indigo-600`) when `selectedPersona !== null`, disabled (`bg-gray-800 opacity-60 cursor-not-allowed`) when null.
- Disabled: `disabled` prop, `aria-disabled="true"`, `aria-describedby="dial-helper-text"`.
- Enabled: `aria-label="Dial [persona.name] — Direct Mode"`.

---

### 6.8 `CallPanelHeader` — Specification

`className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap"`

Contents: persona name (`text-gray-100 font-medium text-sm`) + language badge + `div w-px h-4 bg-gray-800` separator + `CallStatusBadge` + `div flex-1` spacer + context button.

Context button by `callStatus`:
- `connecting`: `bg-red-900/50 text-red-400 opacity-50 cursor-not-allowed` disabled Hang Up
- `active`: `bg-red-700 hover:bg-red-600` Hang Up with `ref={hangUpRef}`, `aria-label="Hang up call"`
- `ended`: `bg-gray-700 hover:bg-gray-600 text-gray-100` New Call, `aria-label="End call and return to persona selection"`
- `error`: `bg-gray-700 hover:bg-gray-600 text-gray-100` Close, `aria-label="Dismiss error and return to persona selection"`

`hangUpRef` auto-focus: `useEffect(() => { if (callStatus === 'active') setTimeout(() => hangUpRef.current?.focus(), 50); }, [callStatus])` in `App.tsx`.

---

### 6.9 `CallStatusBadge` — Specification

`className="inline-flex items-center gap-1.5 text-xs font-mono [status-class]"` with `aria-label="Call status: [LABEL]"`.

Pulsing dot (`animate-pulse bg-current w-1.5 h-1.5 rounded-full`, `aria-hidden="true"`) shown for `connecting` and `active` only.

---

### 6.10 `TranscriptPanel` — Specification

Outer: `className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden"`.
Scroll container: `role="log" aria-live="polite" aria-relevant="additions" aria-atomic="false" aria-label="Conversation transcript" className="max-h-[60vh] overflow-y-auto py-3 space-y-1"`.

Auto-scroll: `useEffect` watches `transcript.length`, `processingTurn`, `llmTokenBuffer` — sets `scrollRef.current.scrollTop = scrollRef.current.scrollHeight`.

Empty states:
- `connecting && transcript.length === 0` — amber `animate-spin` SVG + "ESTABLISHING CONNECTION" + "Sending call to [name]…"
- `active && transcript.length === 0 && !processingTurn && llmTokenBuffer === ''` — 💬 icon + "Waiting for conversation"

Content order: completed `TranscriptEntry` list → `ProcessingIndicator` (conditional) → `LLMStreamEntry` (conditional).

`TranscriptEntry` layout: `border-l-2 [lang-border] [lang-bg] rounded-r-lg mx-3 px-4 py-3`. Header row: role label (color-coded) + language badge + timestamp (`toLocaleTimeString()`). Body: `text-gray-100 text-sm leading-relaxed`.

`ProcessingIndicator`: `animate-spin` SVG + `text-amber-400 font-mono uppercase` "Pipeline processing" + `animate-pulse` "● ● ●". Has `aria-live="polite"` and `aria-label`.

`LLMStreamEntry`: same `border-l-2 [lang-border] [lang-bg]` as counterparty entry. Header: persona first name + language badge + amber `GENERATING` label. Body: `{tokenBuffer}` + `▌` (`text-indigo-400 animate-pulse`, `aria-hidden="true"`). Container: `aria-live="off"`.

---

### 6.11 `TelemetryPanel` — Specification

Internal `useState<boolean>(false)` for expand/collapse. Collapsed by default.

Toggle button: `aria-expanded={expanded}`, `aria-controls="telemetry-table-body"`. Shows `▼ SHOW` / `▲ HIDE`. Only rendered when `telemetry.length > 0`.

Subtitle: `"Pipeline Telemetry — N turn(s)"`.

Table: `aria-label="Pipeline telemetry per turn"`. `<caption className="sr-only">` with descriptive text. Column headers `<th scope="col" font-normal>`, turn cells `<th scope="row" font-normal>`.

Latency colour thresholds:
- STT: > 500ms → `text-amber-400`
- LLM: > 2,000ms → `text-amber-400`
- TTS: > 1,000ms → `text-amber-400`
- Total: ≤ 2,000ms → `text-green-400`; > 2,000ms → `text-amber-400`; > 3,000ms → `text-red-400`

Total rendered in seconds (`toFixed(2)` + `s`). Others in ms (`toLocaleString()` + ` ms`).

---

### 6.12 `CallErrorBanner` — Specification

`role="alert"` — announces immediately on mount. `className="flex flex-col gap-3 bg-red-900/40 border border-red-800 rounded-lg px-4 py-3"`.

Contents: warning SVG (`aria-hidden="true"`) + error message text. Two buttons: `[Try Again]` (`bg-red-800 hover:bg-red-700 text-red-100`) and `[Close]` (`bg-gray-800 hover:bg-gray-700 text-gray-300`). Both call `onDismiss` → `DISMISS_CALL_RESULT`.

Rendered inside `CallPanel` between `CallPanelHeader` and `TranscriptPanel`, only when `callStatus === 'error'`. Distinct from global `ErrorBanner.tsx` (Phase 1 boot errors).

---

### 6.13 Accessibility

All Phase 2 elements MUST meet WCAG 2.1 AA.

**Key ARIA requirements:**
- Persona cards: `role="button"`, `aria-pressed`, `tabIndex={0}`, `aria-label`. Locked: `tabIndex={-1}`, `aria-disabled="true"`.
- Transcript: `role="log"`, `aria-live="polite"`, `aria-relevant="additions"`, `aria-atomic="false"`.
- `LLMStreamEntry`: `aria-live="off"` — token updates not announced; completed entry is.
- `ProcessingIndicator`: `aria-live="polite"`, fires once per turn.
- `CallErrorBanner`: `role="alert"`, immediate announcement.
- `TelemetryPanel`: `aria-expanded`, `aria-controls`, `<caption className="sr-only">`.

**Focus management (3 requirements Engineering MUST implement):**

1. **Hang Up auto-focus**: `useEffect` in `App.tsx` — `if (callStatus === 'active') setTimeout(() => hangUpRef.current?.focus(), 50)`.
2. **Focus restoration**: `savedFocusRef.current?.focus()` called in `handleDismiss` — restores to persona card. Persona cards must have `data-persona-id={persona.id}` attribute.
3. **Tab lockout**: All locked sidebar persona cards have `tabIndex={-1}`.

**Keyboard:** Enter/Space activate persona cards (Space with `e.preventDefault()`). All buttons keyboard-operable. No custom arrow-key handling. No Escape handling in Phase 2.

---

### 6.14 Error State Visual Summary

| Error | `CallStatusBadge` | `CallErrorBanner` | Header Button |
|:------|:-----------------|:------------------|:--------------|
| `pipeline_error` mid-call | red `ERROR` | "Pipeline error (stage): reason. Turn interrupted." | `[Close]` |
| WS disconnect | red `ERROR` | "Connection lost. Call ended unexpectedly." | `[Close]` |
| 10s connect timeout | red `ERROR` | "Connection timed out. No audio received." | `[Close]` |
| No persona selected | N/A | None — disabled Dial button is the affordance | N/A |
| Backend-initiated `call_ended` | gray `ENDED` | None — clean end | `[New Call]` |

---

### 6.15 Engineering Verification Checklist

Before marking frontend complete, Engineering MUST verify:

- [ ] `PersonaCard.tsx` diff is empty — zero Phase 1 file modifications
- [ ] Idle: `grid grid-cols-3 gap-6` persona grid — pixel-identical to Phase 1
- [ ] `CallDialBar`: `mt-6`, disabled state correct, enabled state correct
- [ ] Call state: `flex gap-6 items-start` split-pane, `w-72` sidebar, `flex-1` call panel
- [ ] Hard layout switch on `callStatus` change (no CSS transition)
- [ ] Persona selection ring: `border-2 border-indigo-500 bg-indigo-950/30 ring-1 ring-indigo-500/20`
- [ ] `aria-pressed="true"` on selected card, `"false"` on unselected
- [ ] Locked cards: `opacity-40 pointer-events-none tabIndex={-1}`
- [ ] Active call partner: pulsing `animate-pulse bg-green-400` green dot
- [ ] `CallStatusBadge` transitions correctly through all states with pulsing dot
- [ ] Hang Up auto-focuses when `callStatus → 'active'`
- [ ] `TranscriptPanel` `role="log" aria-live="polite"` present
- [ ] Connecting spinner shown during `connecting && transcript.length === 0`
- [ ] `ProcessingIndicator` shown when `processingTurn && llmTokenBuffer === ''`
- [ ] `LLMStreamEntry` shown when `llmTokenBuffer !== ''`, `ProcessingIndicator` absent
- [ ] `LLMStreamEntry` has `aria-live="off"`
- [ ] `▌` cursor is `text-indigo-400 animate-pulse aria-hidden="true"`
- [ ] Auto-scroll fires on transcript changes, processing state, token buffer changes
- [ ] `TelemetryPanel` collapsed by default; toggle `aria-expanded` correct
- [ ] Latency threshold colours correct per §6.11 table
- [ ] Total column: seconds `toFixed(2)`; others: ms `toLocaleString()`
- [ ] `CallErrorBanner` has `role="alert"`, rendered inside call panel only
- [ ] Global `ErrorBanner` and `CallErrorBanner` can coexist without collision
- [ ] `DISMISS_CALL_RESULT` resets all 7 Phase 2 state fields
- [ ] Reducer ignores call events when `callStatus === 'ended'` or `'error'`
- [ ] Focus restored to saved persona card on `DISMISS_CALL_RESULT`
- [ ] 10-second timeout started on `DIAL_INITIATED`, cleared on `CALL_ACTIVE` or `CALL_ERROR`

---

## 7. ARCHITECTURAL GUIDANCE

**Chief Architect INITIATE CO-SIGN — 2026-06-07**

This section provides binding architectural direction for all agents implementing Phase 2. All constraints below are non-negotiable unless explicitly overridden by a subsequent Architect REVIEW.

---

### 7.1 Service Boundary Law (Absolute)

`voxhop-counterparty` and `voxhop/` (Track 1) share **zero** code, imports, or modules. No cross-package imports across service boundaries. The Track 1 codebase (`voxhop/src/`, `voxhop/test/`) is **frozen — zero modifications permitted**. This is enforced by the MN-06 `git diff HEAD -- voxhop/src/` smoke test in `voxhop-simulator/test/smoke.test.ts`.

`voxhop-simulator/src/` MAY be extended. `voxhop-counterparty/` is fully replaced — the Phase 1 stub (`index.js`) is deleted and replaced with a TypeScript service.

---

### 7.2 Counterparty Runtime: Plain Node.js — No NestJS

`voxhop-counterparty` MUST use `node:http` + `ws` only. No NestJS. No dependency injection framework. No class decorators.

**Rationale**: The Counterparty is single-tenant, single-process, single-call-at-a-time in Phase 2. NestJS adds startup overhead, module lifecycle complexity, and obscures the two-WSS upgrade-routing pattern that is central to the architecture. The canonical pattern already exists in `voxhop/src/web-server.ts` — follow it, not replace it.

**Mandated file structure**:
```
voxhop-counterparty/
  src/
    config.ts        — Zod env config (mirror voxhop/src/config.ts pattern)
    schemas.ts       — Counterparty-local Zod schemas (NEVER import from voxhop/)
    silero-vad.ts    — Copy verbatim from voxhop/src/silero-vad.ts
    audio-utils.ts   — Copy buildWav() + downsampleTo16k() from voxhop/src/audio-utils.ts
    pipeline.ts      — Adapted stage functions + StagedError (no executeTurn)
    call-handler.ts  — CounterpartyCallHandler class
    server.ts        — HTTP server + two-WSS upgrade router
    index.ts         — validateConfig() → ensureLoaded() → server.listen()
  test/
  package.json       — TypeScript 5, ws, zod, avr-vad, pino, form-data
  tsconfig.json
  Dockerfile
```

**Production dependencies permitted**: `ws`, `zod`, `avr-vad`, `pino`, `form-data`. No `ioredis`. No `@nestjs/*`.

---

### 7.3 Two WebSocket Endpoints on One Port — `noServer: true` Upgrade Router

The Counterparty MUST expose two WebSocket endpoints on **port 3001** via a single `http.Server`:

- `/gamma/audio` — telco-ai-bridge wire protocol (call lifecycle + audio frames)
- `/events` — metadata stream (transcripts, LLM tokens, per-turn latency, errors)

**Mandatory implementation pattern** — mirrors `voxhop/src/web-server.ts` (C-01) and `HelloSurgery/gamma-proxy/src/index.ts`:

```typescript
const wssAudio  = new WebSocketServer({ noServer: true });
const wssEvents = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (pathname === '/gamma/audio') {
    wssAudio.handleUpgrade(req, socket, head, ws => wssAudio.emit('connection', ws, req));
  } else if (pathname === '/events') {
    wssEvents.handleUpgrade(req, socket, head, ws => wssEvents.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});
```

Any alternative pattern (single WSS, path-per-message routing, HTTP polling, separate ports) is **rejected**.

---

### 7.4 Schemas: Counterparty-Local, Adapted from Track 1

`voxhop-counterparty/src/schemas.ts` defines its own Zod schemas. No import from `voxhop/src/schemas.ts`.

**`CallInitiatedSchema` — extended with `customData.persona`**: The Counterparty requires the full persona object delivered in `call_initiated.customData`. If absent or invalid, the WebSocket MUST be closed immediately (code 1008). No call can proceed without a valid persona (NEG-CP-01).

**`MediaStartedSchema` — single-track (`caller` only)**: The `tracks[]` array contains only the `caller` track — the Counterparty IS the called party. The schema MUST use `z.literal('caller')`, not `z.enum(['caller', 'called'])`.

**`OllamaStreamChunkSchema`** — new schema for streaming LLM response:
```typescript
z.object({ response: z.string(), done: z.boolean() })
```

**`PersonaSchema`** — must be identical to `voxhop-simulator/src/persona/persona.schema.ts`. Deliberately duplicated per service boundary law. When persona fields change, both files must be updated in the same commit.

---

### 7.5 No Redis — In-Memory State Only

`voxhop-counterparty` MUST NOT depend on or connect to Redis. `ioredis` must not appear in `package.json`.

All state that Track 1 externalises to Redis is held as instance fields on `CounterpartyCallHandler`:

| Track 1 Redis concept | Counterparty equivalent |
|:----------------------|:------------------------|
| `initCallState(callId)` | `this.callId = result.data.callId` |
| `acquireLock(trackId)` | `if (this.processingTurn) return;` |
| `releaseLock(trackId)` | `this.processingTurn = false` |
| `cleanupCallState(callId)` | `this.reset()` on handler instance |

`processingTurn: boolean` is the complete lock mechanism. Multi-instance distributed state is a Production Hardening concern (ROADMAP LATER).

---

### 7.6 Ollama Streaming — Approved Deviation from C-12

Track 1 uses `stream: false` (C-12). **The Counterparty uses `stream: true`.** This is an explicitly approved deviation, not a violation.

**Rationale**: Per-token `{ event: "llm_token", token }` events on `/events` require streaming. Buffering the full Ollama response before emitting tokens defeats the real-time token stream UX.

**Implementation**: Read the NDJSON response body line-by-line. For each line, parse `OllamaStreamChunkSchema`. Emit `{ event: "llm_token", token: chunk.response }` on the `/events` WebSocket. Accumulate `chunk.response` into `fullResponse`. When `chunk.done === true`, emit `{ event: "transcript", role: "counterparty", text: fullResponse }` on `/events`.

This deviation is scoped entirely to `voxhop-counterparty/src/pipeline.ts`. It does not touch `voxhop/src/pipeline.ts`.

---

### 7.7 Piper HTTP — No Modification Required

`voxhop/piper-http/main.py` already supports `POST /tts { text, voice }` per Phase 1 M-04 (multi-voice LRU pool). The Counterparty MUST pass `voice: persona.piperVoice` in every Piper request. No changes to `piper-http/main.py`. Track 1 is frozen.

---

### 7.8 Audio Transcoding — NestJS Owns All Conversion, Counterparty Sees Only S16LE

The Simulator Backend (NestJS) owns all Float32 ↔ S16LE transcoding. The wire between Simulator and Counterparty carries only **base64-encoded S16LE 16kHz mono PCM**.

- **Inbound** (browser → NestJS → Counterparty): Float32 48kHz ArrayBuffer → downsample + convert to S16LE 16kHz → base64 → `{ event: "audio", payload }`
- **Outbound** (Counterparty → NestJS → browser): `{ event: "audio", payload }` → base64 decode → S16LE 16kHz → upsample to Float32 48kHz → binary ArrayBuffer

**The `InboundAudioTranscoder` in `voxhop-simulator/src/` MUST be a per-session class instance** — not a module singleton. It holds a stateful sample accumulator for frame boundary alignment (96ms VAD frames). A singleton would corrupt concurrent sessions.

Reference for Float32 ↔ S16LE conversion and 48kHz ↔ 16kHz resampling: `HelloSurgery/scripts/gamma-simulator-web.ts` lines 603–692.

`voxhop-counterparty` never receives Float32 audio. It never performs sample rate conversion. It only base64-decodes the `payload` field and calls `this.vad.feed(decoded)`.

---

### 7.9 Startup Sequence — Config → VAD Warm → Port Bind (C-08 Pattern)

`voxhop-counterparty/src/index.ts` MUST follow the Track 1 validated startup sequence:

```
1. validateConfig()          — Zod env parse; process.exit(1) on failure
2. const vad = new SileroVAD(config)
3. await vad.ensureLoaded()  — ONNX warm before any port binds
4. server.listen(config.PORT)
```

The port MUST NOT bind if `validateConfig()` fails or `ensureLoaded()` rejects. A cold VAD start silently drops early audio frames — unacceptable when the conversation opener fires immediately on `media_started`.

---

### 7.10 `/events` Endpoint — `?callId=` Query Param Scoping

The `/events` WebSocket upgrade MUST accept `?callId=<uuid>`:

```
ws://voxhop-counterparty:3001/events?callId=<callId>
```

In Phase 2 (single active call), this is informational. In Phase 3+, it becomes the routing key. The Counterparty MUST validate that the query `callId` matches the active call. A missing or mismatched `callId` closes the socket with `socket.destroy()`. This costs nothing now and prevents a breaking API change in Phase 3.

---

### 7.11 Conversation History — 50-Turn FIFO, Ollama Chat API

History is an in-memory `Array<{ role: "user" | "assistant"; content: string }>` capped at 100 entries (50 exchanges × 2 roles). When the array exceeds 100, `shift()` from the front.

History is passed to Ollama using the **chat** API (`POST /api/chat`), not the `generate` API. System prompt is `{ role: "system", content: persona.systemPrompt }` prepended on every request. History is discarded on `call_ended` or WebSocket close.

---

### 7.12 Test Updates — Replace M-05, Retain MN-06

The Phase 1 `M-05` test asserting zero production dependencies on `voxhop-counterparty` MUST be removed. Phase 2 has production deps.

**Replace with these Counterparty boundary tests** in `voxhop-simulator/test/smoke.test.ts`:

| ID | Assertion |
|:---|:----------|
| CP-01 | `GET /health` on port 3001 returns `{ status: "ok" }` (not `"stub"`) |
| CP-02 | `voxhop-counterparty/package.json` contains no `ioredis` dependency |
| CP-03 | WS upgrade to `/gamma/audio` succeeds (101 response) |
| CP-04 | WS upgrade to `/events?callId=<uuid>` succeeds (101 response) |
| CP-05 | WS upgrade to any other path is destroyed (connection refused / closed) |
| MN-06 | `git diff HEAD -- voxhop/src/` is empty — Track 1 freeze enforced *(retained)* |

---

### 7.13 Technical Guidance Compliance Summary

| Constraint | Origin | Status |
|:-----------|:-------|:-------|
| Node.js 20 + TypeScript 5 (ESM) | MASTER_VISION.md | ✅ Counterparty migrated to TypeScript in Phase 2 |
| Zod runtime validation for all config and schemas | MASTER_VISION.md | ✅ All Zod, no hand-rolled validation |
| No cross-package imports across service boundaries | MASTER_VISION.md §VII | ✅ Schemas duplicated locally per boundary law |
| `noServer: true` + upgrade router for multi-WSS | `voxhop/src/web-server.ts` C-01 | ✅ Both WSS instances use `noServer: true` |
| `StagedError` + `instanceof` narrowing | `voxhop/src/pipeline.ts` GAP-02 | ✅ Carried into Counterparty pipeline |
| `validateConfig → ensureLoaded → listen` startup | `voxhop/src/index.ts` C-08 | ✅ Mandated for Counterparty |
| Track 1 codebase frozen | ROADMAP.md + MN-06 smoke test | ✅ Zero modifications to `voxhop/src/` or `voxhop/test/` |
| Piper multi-voice `{ text, voice }` | Phase 1 M-04 | ✅ Already supported — no changes needed |
| Ollama streaming (`stream: true`) | Approved C-12 deviation | ✅ Scoped to Counterparty pipeline only |
| No Redis in Counterparty | §7.5 | ✅ In-memory `processingTurn` boolean; `ioredis` banned |
| Half-duplex `processingTurn` lock | MASTER_VISION.md §III.7 | ✅ Frames silently discarded while lock held |
| Infrastructure as Code — all resources in Terraform | MASTER_VISION.md §III.9 | ✅ ECR repos + IAM additions in `voxhop/infra/main.tf` |

---

### 7.14 Architect REVIEW — 2026-06-07

**ARCHITECT CO-SIGN: ✅ APPROVED**

All four co-signs — §4 Engineering, §5.1 Functional Acceptance Criteria, §5.2 Negative Acceptance Criteria, and §6 UI/UX Design — are holistically aligned and consistent with each other and with the §7 INITIATE architectural constraints.

**Constraint Compliance Audit:**

| Constraint ID | Constraint | File:Line | Verified Value | Result |
|:---|:---|:---|:---|:---|
| §7.1 | Service Boundary Law | §4.2 `package.json` + §4.7 MN-06 | Zero cross-package imports; Track 1 frozen; MN-06 retained | ✅ |
| §7.2 | Plain Node.js — No NestJS | §4.2 `package.json:165-180`, `server.ts:627` | `node:http` + `ws` only; no `@nestjs/*`; no `ioredis` | ✅ |
| §7.3 | Two-WSS `noServer: true` upgrade router | §4.2 `server.ts:627-647` | Two WSS instances with `noServer: true`; upgrade dispatch correct | ✅ |
| §7.4 | `OllamaStreamChunkSchema` | §4.2 `schemas.ts:317-324` | CORRECTED to `/api/chat` shape by Engineering — see Advisory 1 | ⚠️ |
| §7.5 | No Redis — in-memory `processingTurn` only | §4.2 `call-handler.ts:435-518` | Set synchronously pre-`runTurn()`; `finally` release guaranteed | ✅ |
| §7.6 | NDJSON streaming (approved C-12 deviation) | §4.2 `pipeline.ts:366-414` | `lineBuffer` accumulator; `\n` split; incomplete tail preserved | ✅ |
| §7.7 | Piper `{ text, voice }` — no piper-http changes | §4.2 `pipeline.ts:417` | `callPiper(text, config, voice)`; `piper-http/main.py` untouched | ✅ |
| §7.8 | NestJS owns all Float32 ↔ S16LE transcoding | §4.3 `audio-transcoder.ts:749-795` | Per-session class instance; not `@Injectable()`; Counterparty sees S16LE only | ✅ |
| §7.9 | Startup: config → VAD warm → port bind | §4.2 `index.ts:677-713` | Exact sequence; `process.exit(1)` on failure; port never binds on failure | ✅ |
| §7.10 | `/events` `?callId=` scoping | §4.2 `server.ts:638-643` | `searchParams.get('callId')` + `getCallId()` comparison + `socket.destroy()` on mismatch | ✅ |
| §7.11 | 50-turn FIFO; Ollama `/api/chat` | §4.2 `call-handler.ts:437-562` | 100-entry cap with `shift()`; `/api/chat` messages array with system prompt | ✅ |
| §7.12 | M-05 replaced; MN-06 retained | §4.7 `smoke.test.ts` additions | M-05 removed; CP-02 added; MN-06 explicit and unchanged | ✅ |

**Holistic Alignment Summary:**

Engineering §4 correctly implements all §7 constraints. The one internal INITIATE inconsistency — §7.4 and §7.6 specifying the `/api/generate` schema shape (`{ response, done }`) while §7.11 mandated `/api/chat` (`{ message: { role, content }, done }`) — was correctly identified and resolved by Engineering in §4.1 (risk table) and §4.2 (`schemas.ts`, `callOllamaStream`). All five capabilities in §3.1–§3.5 are fully covered by §5.1's 25 functional criteria. §5.2's 50 negative criteria across 7 domains are realistic, adversarially-minded, and complete — NEG-P2-22 (opener/turn concurrency) and NEG-P2-25 (synchronous lock set invariant) are the architecturally highest-value tests. §6 UI/UX is internally consistent with §4 on state types, reducer rules, component hierarchy, and audio routing. All five critical architectural constraints (`processingTurn` lock, NDJSON streaming, VAD pre-warm, `/events` callId scoping, service boundaries) are correctly and consistently reflected across all sections.

**Advisory Notes (Non-Blocking):**

1. **INITIATE schema inconsistency acknowledged**: §7.4's `OllamaStreamChunkSchema` and §7.6's token reference used `/api/generate` format while §7.11 mandated `/api/chat`. Engineering's correction is correct. Future INITIATE guidance must align schema definitions with API endpoint mandates at authoring time.

2. **Ephemeral SSH key cleanup gap (KI-002)**: The `make deploy-app` recipe as specified does NOT guarantee cleanup of `/tmp/voxhop-deploy-key` on failure. Implementation **MUST** use `trap 'rm -f /tmp/voxhop-deploy-key /tmp/voxhop-deploy-key.pub' EXIT` in a shell wrapper. NEG-P2-45 correctly surfaces this. Medium-severity security gap — must be addressed before first production use of `make deploy-app`.

3. **Developer workstation IAM not in Terraform**: Acceptable pragmatic exception — ECR repos and EC2 instance IAM role are correctly infrastructure-as-code. Developer identity IAM is out-of-scope for Terraform in this phase.

---

## 8. DELIVERY & STATUS

### Phase
`NOW — IN PROGRESS`

### Dependencies
- Track 2 Phase 1 DONE ✅

### Scope Decisions (confirmed by Sponsor — 2026-06-07)

| Decision | Confirmed |
|:---------|:----------|
| Counterparty role | WS **server** at `/gamma/audio` + `/events` (port 3001). Standard telco-ai-bridge non-replace protocol. |
| Simulator Backend role | WS **client**. Sends `call_initiated` (persona in `customData`) → `call_answered` → `media_started` → audio frames → `call_ended`. |
| Persona delivery | Full persona JSON object in `call_initiated.customData`. |
| Conversation opener | Injected as Piper audio frames immediately on `media_started` (no developer speech required). |
| Metadata separation | `/gamma/audio` stays protocol-pure. Separate `/events` WS on Counterparty for transcripts + telemetry. |
| Metadata aggregation | NestJS fans out to both Counterparty WS endpoints; multiplexes all onto single `/ws/simulator` browser connection. Scales to Phase 3 voxhop-app events with `source` tag, no browser changes. |
| Half-duplex lock | `processingTurn` lock — incoming audio discarded during pipeline execution. Same pattern as `voxhop-app`. |
| Browser control protocol | `{ type: "dial", personaId }` / `{ type: "hangup" }` JSON. Raw binary `ArrayBuffer` (Float32 48kHz) for audio. NestJS owns all transcoding. |
| Comfort during processing | None. UI `processingTurn` indicator is sufficient for a developer tool. |
| Deployment | **ECR** for app images; **EC2 Instance Connect SSH** for reload. AMI stabilised as base-layer only. |

### Co-Signs

| Agent | Status | Date |
|:------|:-------|:-----|
| Product Owner | ✅ SIGNED | 2026-06-07 |
| Chief Architect (INITIATE) | ✅ SIGNED | 2026-06-07 |
| UI/UX Specialist | ✅ SIGNED | 2026-06-07 |
| Engineering Team | ✅ SIGNED | 2026-06-07 |
| Integration Test | ✅ SIGNED | 2026-06-07 |
| Chief Architect (REVIEW) | ✅ SIGNED | 2026-06-07 |
| Sponsor Approval | ✅ SIGNED | 2026-06-07 |

### Regression Radius
- All Phase 1 services must remain healthy after Phase 2 deployment
- `voxhop-counterparty` stub (Phase 1) is fully replaced by the Phase 2 implementation
- Phase 1 smoke tests updated: stub health-check tests replaced by full Counterparty pipeline tests
- Track 1 `voxhop/` codebase: zero modifications permitted (regression gate enforced)
