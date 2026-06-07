# FEATURE: Track 2 Phase 1 — Infrastructure

> **Track**: NOW
> **Phase**: 1 of 3 — establishes the infrastructure foundation that Phases 2 and 3 build on.
> **Umbrella**: [`TRACK2_SIMULATOR.md`](TRACK2_SIMULATOR.md)
> **Delivery Tickets**: See [`DELIVERY_SCHEDULE.md`](../DELIVERY_SCHEDULE.md)

---

## 1. PROBLEM STATEMENT

**What specific problem is this feature solving?**

The Track 2 feature (Simulator + AI Counterparty) requires three distinct software components and a non-trivial infrastructure layer before any AI pipeline code can be written or tested:

**Problem 1 — No secure origin, no mic, no AudioWorklet.**
The browser microphone API (`getUserMedia`) and the `SharedArrayBuffer`/AudioWorklet APIs require a secure origin (`https://`) and specific HTTP headers (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). Without a live HTTPS endpoint at `simulator.voxhop.borshik.net`, WebRTC mic capture cannot be developed or tested at all — not locally, not in CI. Phase 2 cannot begin without this foundation.

**Problem 2 — Piper serves one voice.**
The existing Piper HTTP server (`voxhop/piper-http/main.py`) is hardcoded for `en_GB-alan-medium`. All five EU-language personas (EN, ES, FR, DE, IT) required for Phase 2's Counterparty pipeline need distinct Piper voice packs. The voice packs must be installed on the AMI and the HTTP endpoint must accept a `voice` parameter before any EU-language persona can synthesise speech.

**Problem 3 — No deployment target for the new services.**
`voxhop-simulator` (NestJS) and `voxhop-counterparty` (Node/ws) have no Terraform infrastructure, no TLS certificate, no Docker Compose wiring, and no Makefile targets. Engineering has nowhere to deploy or test Phase 2 and Phase 3 services.

**Who suffers from this problem today?**

Engineering cannot begin Phase 2 (Counterparty pipeline) without a working AudioWorklet frontend, a multi-voice Piper, and a live HTTPS deployment target. Every day Phase 1 is unresolved is a day Phase 2 cannot start.

**What is the cost of inaction?**

Phase 2 is fully blocked. The `getUserMedia` + AudioWorklet dependency chain cannot be emulated locally without HTTPS. The EU language personas cannot be tested without Piper multi-voice. The Track 2 timeline slips by the full duration of Phase 1.

---

## 2. VISION

Phase 1 delivers a provably working infrastructure skeleton. At the end of Phase 1:

- `https://simulator.voxhop.borshik.net` loads in Chrome and Firefox with a valid Let's Encrypt TLS certificate and no browser security warnings.
- The browser grants microphone access and the AudioWorklet initialises successfully — confirming COOP/COEP headers are correct and `SharedArrayBuffer` is available.
- A dark-mode persona grid renders, populated with five starter personas loaded via `GET /personas` from the NestJS Simulator Backend.
- The Piper HTTP server accepts a `voice` parameter and synthesises audio in any of the five EU voice packs.
- `make deploy` provisions the full 7-service stack (including a stub `voxhop-counterparty`) cleanly from a fresh environment.

There is no call button. No call flow. No AI pipeline. No WebSocket between Simulator and `voxhop-app`. Phase 1 is purely infrastructure — but it is infrastructure that must be *proven* before Phase 2 writes a single line of Counterparty code.

This aligns with the VoxHop core philosophy: **pipeline before intelligence**. Prove the plumbing works. Then build the intelligence.

---

## 3. CORE CAPABILITIES

### 3.1 DNS + TLS Infrastructure

- **Trigger**: `make deploy` executes Terraform apply.
- **Input**: AWS credentials with Route 53 permissions; existing GPU instance EIP (`13.62.124.43`); `borshik.net` DNS zone (Sponsor's domain, NS delegation done manually once).
- **Output**:
  - Route 53 hosted zone `voxhop.borshik.net` created.
  - A record: `simulator.voxhop.borshik.net` → GPU EIP.
  - Security group: port 443 inbound added to existing GPU instance SG.
  - IAM policy granting Certbot Route 53 DNS-01 challenge permissions.
  - `terraform output ns_records` prints the four NS values for manual NS delegation.
  - `make deploy` prints a human-readable NS delegation banner before provisioning.
- **Behaviour**:
  1. Terraform creates Route 53 zone and records in `eu-north-1`.
  2. AMI bake (P1-02) installs Certbot with the `certbot-dns-route53` plugin.
  3. `scripts/issue-cert.sh` runs `certbot certonly --dns-route53` for `simulator.voxhop.borshik.net` and `*.voxhop.borshik.net`.
  4. A systemd timer runs `certbot renew` every 12 hours to maintain cert validity.
  5. The NestJS Simulator Backend (`voxhop-simulator`) serves HTTPS on port 443 using the issued cert.
  6. After `make deploy`, operator must complete the one-time manual step: add the four NS records printed in the banner to `borshik.net`'s registrar.

**Out of scope for Phase 1**: Automatic NS delegation. Certificate monitoring / alerting. Multi-domain certs beyond `simulator.voxhop.borshik.net` and `*.voxhop.borshik.net`.

---

### 3.2 Piper Multi-Voice Extension

- **Trigger**: HTTP POST to `voxhop-piper` `/synthesise` endpoint with optional `voice` field.
- **Input**: `{ "text": "Buenos días, ¿en qué puedo ayudarle?", "voice": "es_ES-davefx-medium" }`. The `voice` field is optional.
- **Output**: LPCM16 audio bytes (unchanged from Track 1 contract). HTTP 200 on success; HTTP 500 with structured error body on Piper subprocess failure.
- **Behaviour**:
  1. If `voice` is absent or null, default to `en_GB-alan-medium` — backward-compatible with all Track 1 callers.
  2. LRU subprocess pool: maximum 2 Piper subprocesses kept warm simultaneously. If a voice is requested that is not in the pool and both slots are occupied, evict the least-recently-used subprocess before spawning the new voice.
  3. Four EU voice packs installed on the AMI: `es_ES-davefx-medium`, `fr_FR-siwis-medium`, `de_DE-thorsten-medium`, `it_IT-riccardo-medium` (or `x_low` if `medium` unavailable — check at bake time and log a warning if downgraded).
  4. Each synthesise request must complete within 5 seconds; abort and return HTTP 500 if exceeded.
  5. No change to the existing LPCM16 output format or the `/health` endpoint.

**Out of scope for Phase 1**: Voice cloning. Streaming TTS. Voice pack hot-swap without container restart.

---

### 3.3 NestJS Simulator Backend Scaffold

- **Trigger**: `docker compose up voxhop-simulator` (or `make deploy`).
- **Input**: `counterparties/` directory mounted read-only at `/app/counterparties`. `COOP_COEP_ENABLED=true` env var (default true).
- **Output**:
  - `GET /personas` → `200 OK` with JSON array of validated persona objects.
  - `GET /health` → `200 OK { "status": "ok" }`.
  - `WS /ws/simulator` → accepts browser WebSocket connections; sends `{ "type": "ack" }` on connect; logs connect/disconnect. No call logic yet.
  - COOP/COEP headers on all HTTP responses: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`.
- **Behaviour**:
  1. On startup, read all `*.json` files from `/app/counterparties`. Validate each against `PersonaSchema` (Zod): `{ id: string, name: string, language: string, systemPrompt: string, conversationOpener?: string, piperVoice: string }`. Log and skip invalid files. Deduplicate by `id` (first-seen wins; log a warning on duplicate).
  2. Validated personas are held in memory for the lifetime of the process. No file-watching in Phase 1.
  3. `GET /personas` returns the in-memory persona array as JSON.
  4. WS gateway at `/ws/simulator` uses `@WebSocketGateway()`. On connection: log `[simulator] browser connected`. Send `{ "type": "ack" }`. On close: log `[simulator] browser disconnected`. No message handling required in Phase 1.
  5. `SharedArrayBuffer` availability is NOT a backend concern — it is a browser-side check (§3.4). The backend's responsibility is only to serve the correct COOP/COEP headers that enable it.

**Out of scope for Phase 1**: Call session management. WS message routing. `POST /calls`. VoxHop WS client. Counterparty WS client.

---

### 3.4 React + Vite + Tailwind Frontend Scaffold

- **Trigger**: Browser navigates to `https://simulator.voxhop.borshik.net`.
- **Input**: None on initial load. `GET /personas` response from Simulator Backend. Browser mic permission grant.
- **Output**: A rendered dark-mode single-page application with:
  - **Header**: "VoxHop Simulator" wordmark + environment badge.
  - **Persona grid**: skeleton ghost cards while `GET /personas` is in flight; real persona cards (name, language flag, persona excerpt) after resolution.
  - **Mic permission UI**: a "Grant Microphone Access" prompt rendered before `getUserMedia` is called. On grant, shows a green mic indicator. On denial, shows a persistent warning.
  - **AudioWorklet status**: after mic grant, initialises the PCM capture AudioWorklet. Shows "AudioWorklet Ready" indicator on success. Shows `<ErrorBanner>` on failure.
  - **No Dial button**: Phase 1 has no call flow.
- **Behaviour**:
  1. **Boot check**: on mount, verify `typeof SharedArrayBuffer !== 'undefined'`. If absent (missing COOP/COEP headers), render `<ErrorBanner message="SharedArrayBuffer unavailable — check COOP/COEP headers" />` and halt further initialisation. This is the canary for the HTTPS + header configuration.
  2. **Persona fetch**: call `GET /personas`. Render skeleton cards during fetch. On success, render persona cards. On network failure, render `<ErrorBanner message="Could not reach simulator service" />`.
  3. **Mic permission**: render a `<MicPermissionPrompt>` component with a single "Allow Microphone" button. On click, call `navigator.mediaDevices.getUserMedia({ audio: true, video: false })`. On grant, proceed to AudioWorklet init. On denial or error, render `<ErrorBanner message="Microphone access denied — call features unavailable" />`.
  4. **AudioWorklet init**: after mic grant, create `AudioContext`, load the PCM capture processor script (`pcm-capture-processor.js`), and wire the mic stream into the worklet. On `AudioWorkletNode` ready, post a status message to the main thread. Render "AudioWorklet Ready ✓" in the header status bar.
  5. **State management**: `useReducer` for all call/UI state. `useRef` for AudioContext and worklet node references. No external state library.
  6. **Technology**: React 18 + Vite + TypeScript + Tailwind CSS. Dark mode by default (`bg-gray-950`). Desktop-first (1280×800 minimum viewport). No mobile breakpoint required.
  7. **COOP/COEP**: the frontend cannot set its own headers — they must come from the NestJS backend (§3.3). The `SharedArrayBuffer` boot check (step 1) is the observable verification that the backend is serving them correctly.

**Out of scope for Phase 1**: Dial button. Call state UI. Transcript panel. Protocol timeline. Direct Mode or Translation Mode flows.

---

### 3.5 Docker Compose + Makefile Integration

- **Trigger**: `make deploy` (full provision + deploy) or `docker compose up` (local dev).
- **Input**: AWS credentials, built Docker images for all services, `counterparties/` directory.
- **Output**: 7 services running and healthy:
  1. `voxhop-app` (Track 1 — existing)
  2. `voxhop-simulator` (NestJS — Phase 1 new)
  3. `voxhop-counterparty` (**stub** in Phase 1 — responds to `/health` only)
  4. `voxhop-whisper` (Track 1 — existing)
  5. `voxhop-ollama` (Track 1 — existing)
  6. `voxhop-piper` (Track 1 — existing, now multi-voice)
  7. `voxhop-redis` (Track 1 — existing)
- **Behaviour**:
  1. `voxhop-simulator` compose service: mounts `counterparties/` read-only, exposes port 443, `depends_on: [voxhop-redis]`.
  2. `voxhop-counterparty` compose service in Phase 1: minimal Node.js container that returns `{ "status": "stub" }` on `GET /health`. No other functionality. Prevents compose from failing on a missing service definition.
  3. `make deploy` prints NS delegation banner *before* running Terraform: lists the four NS records that must be added to `borshik.net` manually by the Sponsor. Certbot DNS-01 will fail if NS delegation is not in place.
  4. `make destroy` tears down all AWS resources (Terraform destroy) cleanly without manual intervention.
  5. Existing Track 1 `voxhop-app` service definition is not modified. All 55 Track 1 tests must continue to pass after the compose file changes.

**Out of scope for Phase 1**: Multi-node deployment. GPU contention testing. Service mesh. Auto-scaling.

---

### 3.6 Starter Persona JSON Library

- **Trigger**: `voxhop-simulator` container startup (read by PersonaLoader, §3.3).
- **Input**: Five JSON files in `counterparties/` directory, one per EU language.
- **Output**: Five persona objects available via `GET /personas`.
- **Behaviour**: Each persona JSON file must satisfy `PersonaSchema`:

```json
{
  "id": "es-hotel-receptionist",
  "name": "Carlos — Madrid Hotel Receptionist",
  "language": "es",
  "piperVoice": "es_ES-davefx-medium",
  "systemPrompt": "You are Carlos, a friendly hotel receptionist at a Madrid boutique hotel. Speak naturally in Spanish. Keep responses concise — 1–3 sentences. You are helping a guest with their stay.",
  "conversationOpener": "Buenas tardes, Hotel Alcázar, le habla Carlos. ¿En qué puedo ayudarle?"
}
```

The five starter personas must cover: `en` (English), `es` (Spanish), `fr` (French), `de` (German), `it` (Italian). Each must reference a valid EU Piper voice pack installed in Phase 1 (§3.2).

`conversationOpener` is optional but strongly recommended for all five starter personas — it gives the Counterparty pipeline a first utterance to synthesise in Phase 2 without waiting for developer speech.

**Out of scope for Phase 1**: In-browser persona editor. Dynamic persona reload. Persona versioning. Persona deletion via API.

---

## 4. TECHNICAL IMPLEMENTATION

> *§4.1 provides the architecture overview. §4.2–4.4 are completed by the Engineering Team during the co-sign process.*

### 4.1 Architecture Overview

**Existing services touched (additive changes only):**
- `voxhop/piper-http/main.py` — `voice` parameter added (§3.2)
- `voxhop/docker-compose.yml` — two new service definitions
- `voxhop/Makefile` — new targets + NS banner
- `voxhop/infra/main.tf` + `outputs.tf` + `variables.tf` — Route 53 + SG + IAM

**New artefacts:**
- `voxhop/infra/packer/scripts/issue-cert.sh` — Certbot DNS-01 script
- `voxhop-simulator/` — NestJS project (new repo/directory)
- `voxhop-simulator/client/` — React/Vite/Tailwind SPA (within NestJS static serving or separate Vite dev server)
- `counterparties/*.json` — 5 persona files

**No changes to:**
- `voxhop/src/` (Track 1 application code — schema migration deferred to Phase 3)
- `voxhop/test/` (Track 1 tests — must all remain green)
- `voxhop-counterparty/` (stub only in Phase 1; full implementation in Phase 2)

---

> **Engineering Team CO-SIGN — 2026-06-07**
> Reviewed by: Engineering Team
> Status: ✅ COMPLETE
> Coverage: All 8 planned tickets (P1-01..P1-08) specified with concrete implementation decisions. All 13 Architect mandates (M-01..M-13) and 8 MUST NOTs (MN-01..MN-08) reflected. 6 Engineering risks (ER-01..ER-06) identified and mitigated. Two non-blocking Engineering Notes raised.

### 4.2 New/Modified Components

**Existing files modified (additive only):**

| File | Change type | What changes |
|:-----|:------------|:-------------|
| `voxhop/piper-http/main.py` | MODIFY | Add `voice: Optional[str] = None` to `TTSRequest`; replace `_synthesise_sync()` + `_piper_proc` with `_pool: OrderedDict` + `asyncio.Lock`; add `/synthesise` alias route |
| `voxhop/infra/main.tf` | MODIFY | Add `aws_route53_zone.voxhop`, `aws_route53_record.simulator_a`, Route 53 IAM policy statements to `aws_iam_role_policy.voxhop_ec2` |
| `voxhop/infra/outputs.tf` | MODIFY | Add `output "ns_records" { value = aws_route53_zone.voxhop.name_servers }` |
| `voxhop/docker-compose.yml` | MODIFY | Add `voxhop-simulator` and `voxhop-counterparty` service definitions |
| `voxhop/Makefile` | MODIFY | Add NS delegation banner to `deploy` target; add `make issue-cert` target |
| `voxhop/infra/packer/voxhop-ami.pkr.hcl` | MODIFY | Add EU voice pack download provisioner block + `issue-cert.sh` copy |

**New files:**

| File | What it is |
|:-----|:-----------|
| `voxhop/infra/packer/scripts/issue-cert.sh` | Certbot DNS-01 script with NS preflight + `--staging` support |
| `voxhop-simulator/` | NestJS project root (new directory) |
| `voxhop-simulator/src/main.ts` | NestJS bootstrap: COOP/COEP middleware, static file serving, port 443 |
| `voxhop-simulator/src/app.module.ts` | Root module: imports PersonaModule, SimulatorGateway |
| `voxhop-simulator/src/persona/persona.schema.ts` | Zod `PersonaSchema` and `Persona` TypeScript type |
| `voxhop-simulator/src/persona/persona.loader.ts` | `@Injectable()` service, `onModuleInit()` reads `counterparties/*.json` |
| `voxhop-simulator/src/persona/persona.controller.ts` | `GET /personas`, `GET /health` |
| `voxhop-simulator/src/simulator/simulator.gateway.ts` | `@WebSocketGateway({ path: '/ws/simulator' })` — ack on connect only |
| `voxhop-simulator/client/` | Vite + React + Tailwind SPA (built output served as NestJS static files) |
| `voxhop-simulator/client/src/App.tsx` | Root component; `useReducer(appReducer, initialState)`; boot sequence |
| `voxhop-simulator/client/src/state/appReducer.ts` | `AppState`, `AppAction`, `appReducer` exactly as §6.4 |
| `voxhop-simulator/client/src/types/persona.ts` | Client-side `Persona`, `MicStatus`, `WorkletStatus` types (duplicated, not imported from server — MN-03) |
| `voxhop-simulator/client/src/components/Header.tsx` | Wordmark, env badge, mic indicator, worklet indicator |
| `voxhop-simulator/client/src/components/ErrorBanner.tsx` | `role="alert"`, persistent, non-dismissible |
| `voxhop-simulator/client/src/components/PersonaGrid.tsx` | `grid grid-cols-3 gap-6`; renders `SkeletonCard` or `PersonaCard` |
| `voxhop-simulator/client/src/components/PersonaCard.tsx` | Name, language badge, system prompt excerpt |
| `voxhop-simulator/client/src/components/SkeletonCard.tsx` | `animate-pulse` placeholder; `aria-busy="true"` |
| `voxhop-simulator/client/src/components/MicPermissionPrompt.tsx` | Mic grant UI; `aria-label` on button |
| `voxhop-simulator/client/public/pcm-capture-processor.js` | `AudioWorkletProcessor` subclass; posts `{ type: 'pcm-capture-ready' }` on init |
| `voxhop-simulator/client/vite.config.ts` | Dev proxy `/personas` → NestJS; build outputs to `../static/` for NestJS static serving |
| `counterparties/en-james.json` | English starter persona |
| `counterparties/es-carlos.json` | Spanish starter persona |
| `counterparties/fr-camille.json` | French starter persona |
| `counterparties/de-klaus.json` | German starter persona |
| `counterparties/it-marco.json` | Italian starter persona |
| `voxhop-counterparty/index.js` | Phase 1 stub: `node:http` server, `GET /health` → `{ "status": "stub" }`, 404 all others |

---

### 4.3 Logic Flow

#### Deployment Sequence

```
Operator runs: make deploy
│
├── [BANNER] "NS delegation required before running make issue-cert.
│            Add the NS records printed below to borshik.net registrar
│            AFTER terraform apply completes."
│
├── terraform -chdir=infra apply (P1-01)
│   ├── Creates aws_route53_zone.voxhop → borshik.net subdelegation zone
│   ├── Creates aws_route53_record.simulator_a → simulator.voxhop.borshik.net A → EIP
│   ├── Adds Route 53 IAM permissions to ec2 role (Certbot DNS-01)
│   └── prints: terraform output -json ns_records → 4 NS values
│
├── [BANNER] "Next: add the NS records above to borshik.net registrar.
│            Confirm: dig NS voxhop.borshik.net @8.8.8.8
│            Then run: make issue-cert"
│
├── docker compose up -d (P1-04)
│   ├── voxhop-redis   :6379  → healthy
│   ├── voxhop-piper   :5000  → healthy (now multi-voice, P1-03)
│   ├── voxhop-whisper :8001  → healthy
│   ├── voxhop-ollama  :11434 → healthy
│   ├── voxhop-app     :3000  → healthy
│   ├── voxhop-simulator :443 → healthy (NestJS + React SPA)
│   └── voxhop-counterparty :3001 → healthy (stub /health only)
│
[manual, separate] Operator delegates NS at borshik.net registrar
[manual, separate] Operator confirms: dig NS voxhop.borshik.net @8.8.8.8 | grep awsdns
[manual, separate] Operator runs: make issue-cert
│
└── issue-cert.sh
    ├── PREFLIGHT: dig NS voxhop.borshik.net @8.8.8.8 | grep -q "awsdns" || exit 1
    ├── certbot certonly --dns-route53 --staging (AR-01 guard)
    ├── [confirm staging cert issued successfully]
    └── certbot certonly --dns-route53 --non-interactive --agree-tos
        -d simulator.voxhop.borshik.net -d *.voxhop.borshik.net
        → TLS cert issued → NestJS reads cert on next start
```

#### Browser Boot Sequence

```
Browser loads https://simulator.voxhop.borshik.net
│
├── NestJS serves index.html with COOP/COEP headers (M-01)
│
├── React hydrates → App mounts → useEffect fires (single, empty deps)
│   │
│   ├── [SYNC] SAB check: typeof SharedArrayBuffer === 'undefined'?
│   │   ├── YES → dispatch(SAB_MISSING) → status='sab_error' → <ErrorBanner> [HALT]
│   │   └── NO  → dispatch(SAB_OK) → status='loading'
│   │
│   ├── [ASYNC] fetch('/personas')
│   │   ├── Error/non-2xx → dispatch(PERSONAS_ERROR) → status='network_error' [HALT]
│   │   └── 200 OK        → dispatch(PERSONAS_LOADED, personas[])
│   │                          → status='mic_prompt'
│   │                          → PersonaGrid renders 5 real cards
│   │                          → MicPermissionPrompt renders
│   │
│   └── [waits for user action]
│
├── User clicks "Allow Microphone"
│   ├── getUserMedia({ audio: true })
│   │   ├── DOMException → dispatch(MIC_DENIED) → status='mic_denied' [SOFT HALT]
│   │   └── resolved     → micStreamRef.current = stream
│   │                       dispatch(MIC_GRANTED) → status='worklet_init'
│   │
│   └── useEffect reacts to status='worklet_init':
│       ├── new AudioContext() → audioContextRef.current
│       ├── audioCtx.audioWorklet.addModule('/pcm-capture-processor.js')
│       │   ├── throws → dispatch(WORKLET_ERROR) → status='worklet_error' [SOFT HALT]
│       │   └── resolves → new AudioWorkletNode(audioCtx, 'pcm-capture-processor')
│       │       ├── workletNode.port.onmessage = ({ data }) => {
│       │       │     if (data.type === 'pcm-capture-ready')
│       │       │       dispatch(WORKLET_READY) → status='ready' ✓
│       │       │   }
│       │       └── srcNode = audioCtx.createMediaStreamSource(micStreamRef.current)
│       │           srcNode.connect(workletNode)
│       └── workletNodeRef.current = workletNode
│
└── status='ready' → Header shows "AudioWorklet Ready ✓" (green)
```

---

### 4.4 Engineering Strategy

#### Technical Approach per Ticket

**P1-01 — Terraform (Route 53, IAM, NS output)**
- Add to `voxhop/infra/main.tf`: `resource "aws_route53_zone" "voxhop" { name = "voxhop.borshik.net" tags = { ... } }` and `resource "aws_route53_record" "simulator_a" { zone_id = aws_route53_zone.voxhop.zone_id name = "simulator" type = "A" ttl = 300 records = [aws_eip.voxhop.public_ip] }` (M-06 — no hardcoded IP).
- Add Route 53 IAM permissions to the existing `aws_iam_role_policy.voxhop_ec2`: `route53:GetChange`, `route53:ChangeResourceRecordSets`, `route53:ListResourceRecordSets` scoped to the hosted zone ARN.
- Add to `voxhop/infra/outputs.tf`: `output "ns_records" { value = aws_route53_zone.voxhop.name_servers }`.
- **Critical**: port 443 SG ingress already exists in `aws_security_group.voxhop` — zero SG changes (M-13 / DA-05). Verify via `grep -n "443" voxhop/infra/main.tf` before writing.
- Run `terraform plan` locally to confirm zero unexpected changes to existing resources before `apply`.

**P1-02 — AMI rebuild (voice packs + Certbot)**
- Add a Packer provisioner block in `voxhop-ami.pkr.hcl` that downloads 4 EU voice packs from HuggingFace (`rhasspy/piper-voices`) into `/usr/local/share/piper-voices/`. Script must perform HTTP HEAD check for `it_IT-riccardo-medium.onnx` first; fall back to `x_low` with echo WARNING if unavailable (M-11). Log the final installed Italian voice name.
- Install via `apt-get install -y certbot python3-certbot-dns-route53` (DA-03). If apt version lags, fall back to pip3.
- Copy `issue-cert.sh` into AMI at `/usr/local/bin/issue-cert.sh` with `chmod +x`.
- Create systemd timer: `certbot-renew.timer` running `certbot renew --quiet` every 12h. Enable at bake time.
- After bake, run smoke test: `piper --version` for each installed voice pack; confirm all 5 (EN + 4 EU) respond without error.

**P1-03 — Piper multi-voice LRU pool**
- **Architecture change**: `_synthesise_sync()` currently spawns fresh `subprocess.run()` per request and is called from a thread executor. The LRU pool replaces both `_piper_proc` (used only by `/health`) and `_synthesise_sync()` with a `collections.OrderedDict` named `_pool` guarded by `asyncio.Lock`.
- Implementation:
  ```python
  _pool: OrderedDict[str, subprocess.Popen] = OrderedDict()
  _pool_lock = asyncio.Lock()
  POOL_MAX = 2
  DEFAULT_VOICE = "en_GB-alan-medium"

  async def get_or_spawn(voice: str) -> subprocess.Popen:
      async with _pool_lock:  # covers lookup → eviction → spawn → register
          if voice in _pool:
              _pool.move_to_end(voice)
              return _pool[voice]
          if len(_pool) >= POOL_MAX:
              _, evicted = _pool.popitem(last=False)
              evicted.terminate()
          proc = subprocess.Popen(["piper", "--model", f"/models/{voice}.onnx", ...], stdin=PIPE, stdout=PIPE)
          _pool[voice] = proc
          return proc
      # synthesis runs OUTSIDE the lock

  @app.post("/tts")
  async def tts(req: TTSRequest):
      voice = req.voice or DEFAULT_VOICE
      proc = await get_or_spawn(voice)
      # write to proc.stdin, read from proc.stdout (with 5s timeout)
      # if proc.poll() is not None → process died mid-synthesis → remove from _pool
      ...

  @app.post("/synthesise")  # additive alias — M-03: /tts is never removed
  async def synthesise_alias(req: TTSRequest):
      return await tts(req)
  ```
- Add concurrent-safety test: two simultaneous `asyncio.create_task()` calls with different voices on a full pool; assert pool size = 2 after both complete.

**P1-04 — Docker Compose + Makefile**
- `voxhop-simulator` service:
  ```yaml
  voxhop-simulator:
    image: voxhop-simulator:latest
    ports: ["443:443"]
    volumes: ["./counterparties:/app/counterparties:ro"]  # M-09: read-only
    depends_on: [voxhop-redis]
    environment: [COOP_COEP_ENABLED=true]
  ```
- `voxhop-counterparty` stub service:
  ```yaml
  voxhop-counterparty:
    image: voxhop-counterparty-stub:latest
    ports: ["3001:3001"]
  ```
- Makefile `deploy` target (M-08):
  ```makefile
  deploy:
      @echo "================================================"
      @echo "VoxHop Deploy — NS Delegation Required"
      @echo "After terraform apply, add the 4 NS records"
      @echo "printed below to borshik.net registrar."
      @echo "Then confirm: dig NS voxhop.borshik.net @8.8.8.8"
      @echo "Then run: make issue-cert"
      @echo "================================================"
      terraform -chdir=infra apply
      @terraform -chdir=infra output -json ns_records
      @echo "Next step: make issue-cert (AFTER NS propagation)"
      docker compose up -d
  issue-cert:
      /usr/local/bin/issue-cert.sh
  destroy:
      docker compose down
      terraform -chdir=infra destroy
  ```

**P1-05 — NestJS `voxhop-simulator` scaffold**
- Bootstrap: NestJS 10 + Express adapter (not Fastify). `npm create @nestjs/core voxhop-simulator`.
- `main.ts`:
  ```typescript
  const app = await NestFactory.create(AppModule);
  // M-01: COOP/COEP BEFORE all other middleware + static files
  if (process.env.COOP_COEP_ENABLED !== 'false') {
    app.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  }
  app.useStaticAssets(join(__dirname, '..', 'static')); // Vite build output
  await app.listen(443, { key, cert }); // TLS from /etc/letsencrypt
  ```
- `persona.loader.ts`: `@Injectable()` class implementing `OnModuleInit`. `onModuleInit()`: `readdir('/app/counterparties')` → filter `*.json` → `readFile` each → `PersonaSchema.safeParse()` → skip invalids with `Logger.warn` → dedup by `id` (first-seen wins) → store in `private readonly personas: Persona[]`.
- `simulator.gateway.ts`: `@WebSocketGateway({ path: '/ws/simulator', transports: ['websocket'] })`. `handleConnection(client)`: `client.send(JSON.stringify({ type: 'ack' }))`.
- PersonaSchema (Zod, server-side — separate from client types per MN-03):
  ```typescript
  const PersonaSchema = z.object({
    id: z.string(), name: z.string(), language: z.string(),
    piperVoice: z.string(), systemPrompt: z.string(),
    conversationOpener: z.string().optional(),
  });
  ```

**P1-06 — React/Vite/Tailwind frontend**
- Vite config: `server.proxy: { '/personas': 'http://localhost:443' }` (dev proxy). Build output: `dist/` → NestJS static serves from `static/` (symlink or `outDir` configured).
- `pcm-capture-processor.js` in `public/` (served as static asset by Vite in dev and NestJS in prod):
  ```javascript
  class PcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() { super(); this.port.postMessage({ type: 'pcm-capture-ready' }); }
    process(inputs) { /* capture PCM — Phase 1: just forward */ return true; }
  }
  registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
  ```
- Implement `appReducer.ts` exactly as §6.4 specifies. No deviation.
- Tailwind config: `darkMode: 'class'` or `'media'`; add `bg-gray-950` to safelist (not a default Tailwind colour — requires `extend: { colors: { 'gray-950': '#030712' } }` or use `zinc-950` which ships with Tailwind v3.3+).
- **Engineering Note (EN-01)**: `bg-gray-950` is not in Tailwind CSS v3.x default palette. Use `zinc-950` (`#09090b`) as a near-identical substitute, OR add a custom colour to `tailwind.config.ts`. Document decision in client README.

**P1-07 — Persona JSON files**
- Five files in `counterparties/`. Schema must satisfy `PersonaSchema`. `piperVoice` must match the quality level confirmed installed in P1-02 (M-11).
- `conversationOpener` is strongly recommended for all five. Each opener should be 1–2 sentences in the persona's language, natural for a first phone contact.
- Example `counterparties/es-carlos.json`:
  ```json
  {
    "id": "es-carlos",
    "name": "Carlos — Madrid Hotel Receptionist",
    "language": "es",
    "piperVoice": "es_ES-davefx-medium",
    "systemPrompt": "You are Carlos, a friendly hotel receptionist at Hotel Alcázar in Madrid. Speak naturally in Spanish. Keep responses to 1–3 sentences. Help the guest with their stay.",
    "conversationOpener": "Buenas tardes, Hotel Alcázar, le habla Carlos. ¿En qué puedo ayudarle?"
  }
  ```

**P1-08 — Integration smoke test**
- Framework: Playwright (browser automation to test HTTPS load + AudioWorklet) OR manual test checklist for ACC-01..ACC-11 with `curl` + browser inspection.
- For CI: `curl -I https://simulator.voxhop.borshik.net` → verify `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers in response (ACC-06).
- `curl https://simulator.voxhop.borshik.net/personas` → assert HTTP 200 + JSON array length = 5 (ACC-02).
- `curl -X POST http://voxhop-piper:5000/tts -d '{"text":"Hola","voice":"es_ES-davefx-medium"}'` → assert response is binary audio (ACC-07).
- `curl -X POST http://voxhop-piper:5000/tts -d '{"text":"Hello"}'` → assert response is binary audio (ACC-08, backward compat).
- ACC-01, ACC-04, ACC-05 (HTTPS padlock, mic grant, AudioWorklet init) require a real browser session — document as manual verification steps in the P1-08 checklist.

#### Complexity Score

**Overall: 6/10**

Reasoning:
- Terraform (P1-01): 2/10 — additive resources, well-understood pattern
- AMI rebuild (P1-02): 4/10 — Certbot DNS-01 sequencing risk (AR-01) elevates this; voice pack download and availability check adds moderate risk
- Piper LRU pool (P1-03): 7/10 — structural rearchitecture of `_synthesise_sync()` + `_piper_proc`; async concurrency with `asyncio.Lock`; dead-process detection; concurrent-safety test required
- Docker Compose + Makefile (P1-04): 2/10 — straightforward
- NestJS scaffold (P1-05): 5/10 — middleware ordering (M-01) is the highest-risk step; COOP/COEP header placement before static files is non-obvious in NestJS
- React + AudioWorklet (P1-06): 6/10 — AudioWorklet module loading and PCM processor init has browser-specific pitfalls; `SharedArrayBuffer` + `crossOriginIsolated` dependency chain must work end-to-end
- Persona JSONs (P1-07): 1/10 — trivial
- Smoke test (P1-08): 3/10 — ACC-01/04/05 require manual browser steps; rest are `curl`-automatable

#### Execution Order

```
Stream A (infra — must complete before docker compose up):
  P1-01 (Terraform) → P1-02 (AMI rebuild) → P1-04 (Docker Compose)

Stream B (Python — independent; can start in parallel with Stream A):
  P1-03 (Piper multi-voice) — modify existing container; deploy via P1-04

Stream C (app code — independent):
  P1-05 (NestJS) → P1-06 (React client) [client depends on NestJS serving /personas]
  P1-07 (persona JSONs) — can be done anytime; needed for P1-08

P1-08 (smoke test) — depends on all of P1-01..P1-07 deployed
```

P1-03 and P1-05/06/07 can proceed in parallel with infra. P1-08 is the integration gate.

**Critical sequence constraint**: P1-01 must complete before `make issue-cert` is possible. `make issue-cert` (cert issuance) must complete before NestJS can serve HTTPS. ACC-01 (HTTPS load) and ACC-04/05/06 (AudioWorklet) can only be verified after cert issuance. Therefore Stream A must reach "cert issued" before P1-08 is executable.

#### Engineering Risks (ER-xx)

**ER-01 — NestJS static file serving order: if `useStaticAssets()` is called before COOP/COEP `app.use()`, the SPA HTML response omits the headers (M-01 violation)**
- Symptom: `typeof SharedArrayBuffer === 'undefined'` in browser (SAB_MISSING error). DevTools shows root HTML response lacking COOP/COEP headers even though API routes have them.
- Mitigation: Enforce strict ordering in `main.ts`: (1) `app.use()` COOP/COEP middleware; (2) `useStaticAssets()`; (3) `await app.listen()`. Add a test that GETs `/` and asserts both headers present.

**ER-02 — `bg-gray-950` missing from Tailwind v3 default palette (EN-01)**
- Tailwind CSS v3.x does not ship `gray-950`. The spec's Tailwind classes reference it throughout §6.6.
- Mitigation: Use `zinc-950` (`#09090b`) — visually indistinguishable — OR add `extend: { colors: { 'gray-950': '#030712' } }` to `tailwind.config.ts`. Choose one approach consistently. Document in client README.

**ER-03 — AudioWorklet `addModule()` path: in dev (Vite proxy), the processor file is served by Vite at `/pcm-capture-processor.js`. In production (NestJS static), it's served by NestJS from the `static/` directory. Both must resolve to the same path.**
- Mitigation: Place `pcm-capture-processor.js` in `voxhop-simulator/client/public/`. Vite copies `public/` files to `dist/` verbatim. NestJS serves `dist/` as `static/`. The call `audioCtx.audioWorklet.addModule('/pcm-capture-processor.js')` resolves correctly in both environments.

**ER-04 — Piper voice pack model path: AMI bake installs OnnxRuntime models into a directory; `piper` CLI must be invoked with `--model <path>`. The pool implementation must know the installed model directory.**
- Mitigation: Hard-code the voice pack directory as an env var `PIPER_MODELS_DIR` defaulting to `/usr/local/share/piper-voices`. The pool's `get_or_spawn()` constructs the full model path as `f"{PIPER_MODELS_DIR}/{voice}.onnx"`. Verify path at server startup (warn + continue if a named model file is absent).

**ER-05 — TLS cert path in NestJS: `fs.readFileSync` of `/etc/letsencrypt/live/simulator.voxhop.borshik.net/fullchain.pem` fails if cert is not yet issued (NestJS startup before `make issue-cert`)**
- Mitigation: In Phase 1, NestJS is expected to start before cert issuance (Docker Compose up runs during `make deploy`, cert issuance is manual afterwards). Provide a self-signed fallback cert for the initial startup. The smoke test (ACC-01 — valid Let's Encrypt cert) is run only after `make issue-cert` completes.

**ER-06 — `ws` module in `@nestjs/websockets` may conflict with `ws` version used elsewhere in the monorepo if `voxhop-simulator` and `voxhop` share a `node_modules`**
- Mitigation: `voxhop-simulator` is a separate directory with its own `package.json` and `node_modules` — no hoisting. Confirm with `npm install --prefix voxhop-simulator` in isolation.

#### Engineering Notes

**EN-01 (non-blocking)**: `bg-gray-950` is absent from Tailwind v3 default palette. Use `zinc-950` or extend config. Document choice in `voxhop-simulator/client/README.md` before P1-06 is marked complete.

**EN-02 (non-blocking)**: In development (without a TLS cert), COOP/COEP headers can be set by the Vite dev server config (`server.headers`) to enable `SharedArrayBuffer` testing without NestJS running. This is a dev-only convenience — Vite headers MUST NOT substitute for the NestJS middleware (M-01). The smoke test (P1-08) always runs against NestJS-served responses, never Vite dev server.

#### Ticket Breakdown (P1-01..P1-08)

| Ticket | File(s) | Status | Description | Depends On |
|:-------|:--------|:-------|:------------|:-----------|
| **P1-01** | `voxhop/infra/main.tf`, `outputs.tf` | `NOT STARTED` | Terraform: Route 53 zone + A record (M-06) + IAM Route 53 permissions + `ns_records` output. Zero SG changes (M-13). | — |
| **P1-02** | `voxhop/infra/packer/voxhop-ami.pkr.hcl`, `scripts/issue-cert.sh` [NEW] | `NOT STARTED` | AMI: 4 EU voice packs with M-11 bake-time quality check, Certbot DNS-01 install, systemd renewal timer, `issue-cert.sh` with NS preflight + `--staging` guard (M-07). | P1-01 (IAM perms needed for DNS-01) |
| **P1-03** | `voxhop/piper-http/main.py` | `NOT STARTED` | Piper LRU pool: `collections.OrderedDict` max-2, `asyncio.Lock` covering full lookup→eviction→spawn (M-04), synthesis outside lock, `/synthesise` alias without removing `/tts` (M-03), dead-process detection. | — |
| **P1-04** | `voxhop/docker-compose.yml`, `voxhop/Makefile` | `NOT STARTED` | Compose: `voxhop-simulator` (port 443, `counterparties:ro` M-09) + `voxhop-counterparty` stub (port 3001). Makefile: NS banner before terraform (M-08), `make issue-cert` target (M-07), `make destroy`. | P1-01, P1-03 |
| **P1-05** | `voxhop-simulator/` [NEW] | `NOT STARTED` | NestJS: Express adapter, COOP/COEP `app.use()` BEFORE `useStaticAssets()` (M-01), `GET /personas`, `GET /health`, WS stub (ack only), PersonaLoader `onModuleInit()` with Zod (M-12, M-09), first-seen dedup, TLS self-signed cert fallback (ER-05). | P1-07 (persona files needed for integration) |
| **P1-06** | `voxhop-simulator/client/` [NEW] | `NOT STARTED` | React/Vite/Tailwind: exact §6 component hierarchy + §6.4 `useReducer` state machine. `public/pcm-capture-processor.js` AudioWorklet processor (ER-03). Vite dev proxy for `/personas`. Types duplicated not shared (MN-03). `zinc-950` or custom gray-950 (EN-01). | P1-05 (NestJS serves client in prod) |
| **P1-07** | `counterparties/en-james.json`, `es-carlos.json`, `fr-camille.json`, `de-klaus.json`, `it-marco.json` [NEW] | `NOT STARTED` | 5 starter personas (EN/ES/FR/DE/IT). `piperVoice` must match confirmed quality from P1-02 (M-11). `conversationOpener` on all five. Zod validates against `PersonaSchema`. | P1-02 (voice quality confirmed) |
| **P1-08** | `voxhop-simulator/test/smoke.test.ts` [NEW] | `NOT STARTED` | Integration smoke test: ACC-01..ACC-11. `curl` for ACC-02/06/07/08/09/10/11. Manual browser steps for ACC-01/04/05 documented as checklist. | All P1-01..P1-07 deployed |

> **Execution order**: Stream A (P1-01 → P1-02 → P1-04) runs sequentially — infra before deploy. Stream B (P1-03) runs in parallel with Stream A — Piper change is independent. Stream C (P1-05 → P1-06; P1-07 anytime) runs in parallel with Streams A+B. P1-08 runs last after all deployed.

---

> **Integration Test CO-SIGN — 2026-06-07**
> Status: ✅ COMPLETE
> 33 adversarial probes covering all 8 attack surfaces (COOP/COEP headers, Piper LRU pool, PersonaLoader, Terraform, Certbot/NS delegation, AudioWorklet/SAB, Track 1 regression, counterparty stub), all MN-01..MN-08 MUST NOTs, and all AR-01..AR-07 architectural risks. Track 1 regression is explicitly gated: 55/55 Vitest tests must pass and zero diffs to `voxhop/src/` before any Phase 1 ticket is marked DONE.

## 5. ACCEPTANCE CRITERIA

### 5.1 Functional (The Happy Path)

| ID | Criterion | Verified |
|:---|:----------|:---------|
| ACC-01 | `https://simulator.voxhop.borshik.net` loads in Chrome and Firefox with a valid Let's Encrypt TLS certificate and zero browser security warnings. The browser URL bar shows a padlock. | ☐ |
| ACC-02 | `GET https://simulator.voxhop.borshik.net/personas` returns HTTP 200 with a JSON array of exactly 5 persona objects, each containing `id`, `name`, `language`, `piperVoice`, `systemPrompt`. | ☐ |
| ACC-03 | The persona grid renders 5 cards (no skeleton state visible after load completes). Each card shows the persona name and language. | ☐ |
| ACC-04 | Clicking "Allow Microphone" grants mic access. The header shows a green mic indicator. No browser error is thrown. | ☐ |
| ACC-05 | After mic grant, the AudioWorklet initialises and the header shows "AudioWorklet Ready ✓". `SharedArrayBuffer` is available (`typeof SharedArrayBuffer === 'function'`). | ☐ |
| ACC-06 | HTTP response headers for the root page include `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Verifiable via browser DevTools Network tab. | ☐ |
| ACC-07 | `POST http://voxhop-piper:5000/tts` with `{ "text": "Hola", "voice": "es_ES-davefx-medium" }` returns LPCM audio within 5 seconds. | ☐ |
| ACC-08 | `POST /tts` with no `voice` field returns LPCM audio synthesised by `en_GB-alan-medium` (backward-compatible Track 1 behaviour). | ☐ |
| ACC-09 | `make deploy` completes without error on a fresh AWS environment. All 7 Docker services report healthy within 10 minutes of deploy completing. | ☐ |
| ACC-10 | `make deploy` prints a NS delegation banner showing 4 NS record values before Terraform runs. | ☐ |
| ACC-11 | After adding a 6th persona JSON file to `counterparties/` and restarting `voxhop-simulator`, `GET /personas` returns 6 personas. No code change or rebuild required. | ☐ |

### 5.2 Negative (The Unhappy Path)

| ID | Criterion | Verified |
|:---|:----------|:---------|
| NEG-01 | **[COOP/COEP — Headers absent on static asset responses]** Setup: `COOP_COEP_ENABLED=true`; `curl -I https://simulator.voxhop.borshik.net/pcm-capture-processor.js` and `curl -I https://simulator.voxhop.borshik.net/assets/<bundle>.js`. — Expected: Every static asset response MUST include both `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (MN-02). If `useStaticAssets()` is called before `app.use()` COOP/COEP, static file responses silently omit both headers — the root HTML may pass while JS chunks fail. — Observable: Both headers appear in `curl -I` output for `pcm-capture-processor.js` and at least one built JS chunk. | ☐ |
| NEG-02 | **[COOP/COEP — Headers absent on WebSocket upgrade response]** Setup: Connect to `wss://simulator.voxhop.borshik.net/ws/simulator` via mitmproxy or Burp Suite. Capture the raw HTTP 101 Switching Protocols upgrade response. — Expected: The upgrade response MUST include both COOP and COEP headers. The NestJS `@WebSocketGateway` upgrade handshake MUST NOT bypass the Express middleware chain (MN-02: "no WebSocket upgrade may omit" the headers). — Observable: Proxy-captured HTTP 101 response contains `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. | ☐ |
| NEG-03 | **[COOP/COEP — Headers absent on 4xx and 5xx error responses]** Setup: `curl -I https://simulator.voxhop.borshik.net/nonexistent` (expect 404); `curl -I https://simulator.voxhop.borshik.net/personas` with `Accept: text/plain` (expect 406). — Expected: 4xx and 5xx responses MUST carry both COOP and COEP headers (MN-02: "no exception filter" exempted). A NestJS global exception filter registered before the COOP/COEP middleware registration point will strip headers from error responses. — Observable: `curl -I` on the 404 response includes both `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`. | ☐ |
| NEG-04 | **[COOP/COEP — Middleware registered after useStaticAssets (ER-01 — the silent killer)]** Setup: Deliberate ER-01 scenario: swap `useStaticAssets()` before `app.use()` COOP/COEP in `main.ts`; deploy; `curl -I https://simulator.voxhop.borshik.net/`; then load page in Chrome and evaluate `window.crossOriginIsolated` in console. — Expected: Correct implementation: `curl -I /` MUST return both headers on the root HTML response and `crossOriginIsolated === true`. Reversed order produces no headers on `/`; browser shows `crossOriginIsolated: false`; `<ErrorBanner message="SharedArrayBuffer unavailable — check COOP/COEP headers" />` is the sole page content. — Observable: `curl -I https://simulator.voxhop.borshik.net/` shows `Cross-Origin-Opener-Policy: same-origin`. Browser console: `crossOriginIsolated` → `true`. | ☐ |
| NEG-05 | **[COOP/COEP — Headers leak to voxhop-app via shared proxy (AR-02)]** Setup: `curl -I http://voxhop-app:3000/` and inspect all response headers. — Expected: `voxhop-app` MUST NOT carry `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy` headers. COOP/COEP are `voxhop-simulator` NestJS-application-layer-only — a shared nginx proxy or compose-level header injection contaminates Track 1 and may break cross-origin audio asset loading (AR-02). — Observable: `curl -I http://voxhop-app:3000/` output contains no `cross-origin-opener-policy` or `cross-origin-embedder-policy` (case-insensitive scan). | ☐ |
| NEG-06 | **[Piper LRU Pool — Concurrent voice requests cause race condition (AR-03, M-04)]** Setup: Pre-warm pool with voices A and B (pool full at 2). Fire two concurrent `asyncio.create_task()` synthesis requests for voices C and D simultaneously — both require eviction. Assert after both complete. — Expected: Pool MUST remain exactly size 2 throughout. MUST NOT double-evict or double-kill the same subprocess. MUST NOT leak orphaned processes. Both requests MUST return HTTP 200 + valid LPCM audio. `ps aux | grep piper | grep -v grep | wc -l` MUST equal 2. — Observable: Both responses HTTP 200 with binary body. Process count = 2. Logs show exactly 2 eviction events and 2 new spawns. | ☐ |
| NEG-07 | **[Piper LRU Pool — Dead subprocess retained silently in pool]** Setup: Externally kill a Piper subprocess in the pool (`os.kill(proc.pid, signal.SIGKILL)`). Immediately issue a synthesis request for that same voice. — Expected: Post-synthesis `_pool[voice].poll()` MUST detect non-None (process dead). Dead process MUST be removed from `_pool`. Next synthesis request for the same voice MUST re-spawn a fresh subprocess and return HTTP 200 + audio. Caller MUST NOT receive a silent hang beyond the 5-second timeout (M-04). — Observable: Logs show dead-process detection and pool removal. Second request for same voice returns HTTP 200. No zombie subprocess in `ps`. | ☐ |
| NEG-08 | **[Piper LRU Pool — Pool capacity exceeds 2 due to off-by-one in guard]** Setup: Issue 4 sequential synthesis requests for 4 different voices (EN, ES, FR, DE). After all complete, inspect pool size. — Expected: Pool MUST contain exactly 2 entries — the 2 most-recently-used voices (M-04: POOL_MAX = 2). An off-by-one (`>` instead of `>=` in the capacity guard) lets the pool grow to 3 or 4 entries and leak subprocesses. — Observable: After 4 requests, `ps aux | grep piper | grep -v grep | wc -l` → `2`. Logs show exactly 2 eviction events total. Pool holds exactly 2 entries. | ☐ |
| NEG-09 | **[Piper LRU Pool — /tts route removed or renamed to /synthesise only (AR-07, M-03)]** Setup: After P1-03 implementation, `POST http://voxhop-piper:5000/tts` with `{"text":"Hello"}` (no `voice` field — backward-compat probe). — Expected: `POST /tts` MUST return HTTP 200 + LPCM audio using `en_GB-alan-medium`. MUST NOT return 404 or 405. Renaming `/tts` to `/synthesise` as the sole endpoint immediately breaks every Track 1 caller and fails all 55 Vitest tests (AR-07, M-03). — Observable: `curl -w "%{http_code}" -X POST http://voxhop-piper:5000/tts -H "Content-Type: application/json" -d '{"text":"Hello"}' | tail -1` → `200`. Response body is binary LPCM, not JSON. | ☐ |
| NEG-10 | **[Piper LRU Pool — /synthesise alias absent or returns 404]** Setup: `POST http://voxhop-piper:5000/synthesise` with `{"text":"Hola","voice":"es_ES-davefx-medium"}`. — Expected: `/synthesise` MUST return HTTP 200 + LPCM audio. MUST be an in-process handler alias pointing to the same function as `/tts` — NOT an HTTP redirect (no 301/302). MUST NOT return 404 or 405. — Observable: `curl -w "%{http_code}" -X POST http://voxhop-piper:5000/synthesise -H "Content-Type: application/json" -d '{"text":"Hola","voice":"es_ES-davefx-medium"}' | tail -1` → `200`. Response body is binary audio, not JSON. | ☐ |
| NEG-11 | **[PersonaLoader — Invalid JSON file crashes service instead of being skipped (M-12)]** Setup: Place `bad.json` in `counterparties/` containing `{ "id": 123, broken json`. Restart `voxhop-simulator`. — Expected: Service MUST NOT crash or panic. Invalid file MUST be skipped with a logged warning (M-12: "Log and skip invalid files"). `GET /health` → `200 {"status":"ok"}`. `GET /personas` → the 5 valid personas unchanged. — Observable: `docker ps` shows `voxhop-simulator` `Up`. `curl /health` → `{"status":"ok"}`. `curl /personas | jq length` → `5`. Logs contain `[PersonaLoader] Skipping invalid persona: bad.json`. | ☐ |
| NEG-12 | **[PersonaLoader — Duplicate ID: last-seen overwrites first-seen (wrong dedup direction)]** Setup: Add `en-james-dup.json` to `counterparties/` with `"id":"en-james"` but `"name":"IMPOSTOR"`. Restart `voxhop-simulator`. — Expected: First-seen persona MUST win (M-12: "first-seen wins; log a warning on duplicate"). `GET /personas` MUST return exactly 5 entries, not 6. The `en-james` entry name MUST NOT contain `IMPOSTOR`. Logs MUST contain a duplicate `id` warning. A naive `Map.set()` loop overwrites without checking — the obvious wrong implementation. — Observable: `curl /personas | jq length` → `5`. `curl /personas | jq '.[] | select(.id=="en-james") | .name'` does not contain `IMPOSTOR`. Logs show duplicate id warning. | ☐ |
| NEG-13 | **[PersonaLoader — Zero valid personas crashes service instead of returning empty array (M-12)]** Setup: Replace all 5 persona files with `{}` (valid JSON but fails Zod `PersonaSchema`). Restart `voxhop-simulator`. — Expected: Service MUST remain healthy. MUST NOT crash or call `process.exit(1)` (M-12: "Zero personas loaded → service remains healthy, `GET /personas` returns `[]`"). `GET /health` → `200`. `GET /personas` → HTTP 200 `[]`. — Observable: Container stays running after restart. `curl /health` → `{"status":"ok"}`. `curl /personas` → `[]`. | ☐ |
| NEG-14 | **[PersonaLoader — Non-JSON files in counterparties/ cause parse errors (M-12)]** Setup: Place `notes.txt`, `README.md`, and `.DS_Store` in `counterparties/` alongside the 5 valid JSON files. Restart `voxhop-simulator`. — Expected: PersonaLoader MUST enumerate ONLY `*.json` files. Non-JSON files MUST be silently ignored — zero error logs referencing them (M-12: "enumerate all `*.json` from `/app/counterparties`"). `GET /personas` → exactly 5 personas. — Observable: `curl /personas | jq length` → `5`. No log lines referencing `notes.txt`, `README.md`, or `.DS_Store`. | ☐ |
| NEG-15 | **[PersonaLoader — counterparties/ mounted read-write, missing :ro flag (M-09)]** Setup: Inspect `voxhop/docker-compose.yml` `voxhop-simulator` volumes entry. Then `docker compose exec voxhop-simulator touch /app/counterparties/probe-write.json`. — Expected: Volume mount MUST include the `:ro` flag (M-09: "`- ./counterparties:/app/counterparties:ro`"). Write attempt inside the container MUST fail with "Read-only file system" or "Permission denied". — Observable: `grep "counterparties" voxhop/docker-compose.yml` → line contains `:ro` suffix. The `docker compose exec` touch command exits non-zero with a filesystem error. | ☐ |
| NEG-16 | **[PersonaLoader — File-watching for persona hot-reload at runtime (MN-05)]** Setup: `grep -E "(chokidar|fs\.watch|FSWatcher|setInterval)" voxhop-simulator/src/persona/persona.loader.ts`; also check `voxhop-simulator/package.json` for `chokidar`. — Expected: MUST NOT contain any file-watching mechanism (MN-05: "No `chokidar`, `fs.watch()`, `FSWatcher`, or `setInterval`-based re-read"). Persona data loads ONCE at `onModuleInit()`. Container restart is the sole reload mechanism. — Observable: All grep commands return zero matches. `voxhop-simulator/package.json` lists no `chokidar` dependency. | ☐ |
| NEG-17 | **[Terraform — Hardcoded IP string in Route 53 A record (M-06)]** Setup: `grep -n "13.62.124.43" voxhop/infra/main.tf`. Then run `terraform plan` and inspect the `aws_route53_record.simulator_a` resource block. — Expected: Zero occurrences of the literal string `"13.62.124.43"` anywhere in `main.tf` (M-06). The A record MUST set `records = [aws_eip.voxhop.public_ip]` — a Terraform resource attribute reference. A hardcoded string breaks on any future EIP reallocation. — Observable: `grep "13.62.124.43" voxhop/infra/main.tf` → zero output. `terraform plan` shows the A record referencing the EIP resource attribute, not a literal IP string. | ☐ |
| NEG-18 | **[Terraform — Duplicate port 443 SG ingress rule causes plan error (M-13)]** Setup: Run `terraform plan` against the Phase 1 modified `main.tf`. Filter for `aws_security_group` resource changes. — Expected: ZERO changes to any `aws_security_group` resource (M-13: "P1-01 additions are limited to Route 53 and IAM policy statements"). Adding a duplicate 443 ingress block causes Terraform to error or produce an unintended SG change that fails on apply. — Observable: `terraform plan | grep "aws_security_group"` → no planned changes. Plan summary: `0 to change` for all SG resources. | ☐ |
| NEG-19 | **[Certbot / NS delegation — NS preflight check bypassed, certbot fires before NS delegated (AR-01, M-07)]** Setup: Ensure NS is NOT delegated (`dig NS voxhop.borshik.net @8.8.8.8` returns no `awsdns` entries). Run `issue-cert.sh` directly. — Expected: Script MUST exit non-zero with a human-readable NS delegation error BEFORE invoking any `certbot` command (M-07: "If Route 53 NS records are not returned, the script MUST exit"). Zero Certbot processes spawned. Zero Let's Encrypt rate-limit attempts consumed. — Observable: Script output contains NS delegation error. Exit code non-zero. `pgrep certbot` during script execution → no PID found. No `_acme-challenge` TXT record appears in Route 53. | ☐ |
| NEG-20 | **[Certbot / NS delegation — HTTP-01 challenge used instead of DNS-01 (MN-01)]** Setup: `grep -E "(--standalone|--webroot|--nginx)" voxhop/infra/packer/scripts/issue-cert.sh`; then `grep "\-\-dns-route53" voxhop/infra/packer/scripts/issue-cert.sh`. — Expected: Script MUST use `--dns-route53` exclusively (MN-01). MUST NOT contain `--standalone`, `--webroot`, or `--nginx`. Port 80 is not open in the SG — HTTP-01 times out and consumes a rate-limit attempt before failing. — Observable: First grep → zero matches. Second grep → at least one match on a `certbot certonly` line. | ☐ |
| NEG-21 | **[Certbot / NS delegation — make deploy auto-invokes certbot (MN-07, M-07)]** Setup: `grep -A 30 "^deploy:" voxhop/Makefile | grep -E "(certbot|issue-cert|issue_cert)"`. Also run `make deploy --dry-run` and scan output for cert-related commands. — Expected: The `deploy` Makefile target MUST NOT invoke `certbot`, `issue-cert.sh`, or any cert-related command (MN-07). Auto-invocation before NS propagation (which can take 15 min–48 h) burns Let's Encrypt rate limits irreversibly. — Observable: Grep finds zero cert-related commands in the `deploy` target recipe. `make deploy` dry-run output contains only: NS banner echo, `terraform apply`, `docker compose up -d`. | ☐ |
| NEG-22 | **[Certbot / NS delegation — --staging flag skipped on first issuance attempt (AR-01, M-07)]** Setup: `grep -n "staging" voxhop/infra/packer/scripts/issue-cert.sh`. Confirm `--staging` line number is smaller than the live (non-staged) `certbot certonly` line number. — Expected: `issue-cert.sh` MUST invoke `certbot certonly --dns-route53 --staging` BEFORE any live issuance call (M-07: "First attempt MUST use `--staging` flag"). Skipping staging on a subtly broken DNS-01 setup consumes 5 rate-limit attempts per hour before failure is detected. — Observable: `grep -n "staging" issue-cert.sh` returns a line number earlier in the file than the non-staged `certbot certonly` invocation. | ☐ |
| NEG-23 | **[AudioWorklet / SAB — SAB check not first in boot useEffect (M-02)]** Setup: Set `COOP_COEP_ENABLED=false` (or strip headers at proxy). Load `https://simulator.voxhop.borshik.net/` in Chrome. Watch DevTools Network tab and React DevTools state simultaneously. — Expected: SAB check MUST be the FIRST synchronous side-effect in the mount `useEffect` — before `fetch('/personas')` fires (M-02). With headers disabled: `status = 'sab_error'` MUST be set before any `/personas` network request. If check is not first, the app fetches personas and renders the grid — completely hiding the COOP/COEP failure from the developer. — Observable: Network tab shows NO `/personas` request at all. React DevTools `status` → `sab_error`. `<ErrorBanner>` is sole page content. | ☐ |
| NEG-24 | **[AudioWorklet / SAB — AudioWorklet module load failure silently hangs in worklet_init (§3.4 step 4)]** Setup: Remove or serve a 404 for `pcm-capture-processor.js` from the NestJS static directory. Grant microphone access. Observe the init phase. — Expected: `addModule()` rejection MUST be caught and dispatch `WORKLET_ERROR`. Header MUST show `WORKLET ERROR` in `text-red-400`. `<ErrorBanner message="AudioWorklet failed to initialise" />` MUST render (§6.4 transition). MUST NOT silently hang in `worklet_init` status indefinitely. — Observable: `<ErrorBanner>` with worklet error message appears within 5 seconds of mic grant. Header reads `WORKLET ERROR`. Browser console shows 404 on the processor URL. | ☐ |
| NEG-25 | **[AudioWorklet / SAB — crossOriginIsolated = false despite correct COOP/COEP headers (AR-04)]** Setup: Load `https://simulator.voxhop.borshik.net/` in Chrome (correct headers confirmed by NEG-01 and NEG-04). Open DevTools console. Evaluate `window.crossOriginIsolated`. — Expected: `window.crossOriginIsolated` MUST be `true`. `typeof SharedArrayBuffer` MUST be `'function'`. Phase 1 includes no external CDN resources or iframes — any `false` result indicates an unexpected cross-origin resource breaking isolation (AR-04). — Observable: `crossOriginIsolated` → `true`. `typeof SharedArrayBuffer` → `'function'`. DevTools Security tab: "This page is cross-origin isolated." No `<iframe>` elements in the DOM. | ☐ |
| NEG-26 | **[Regression — voxhop/src/ contains diffs after Phase 1 (MN-06, M-10)]** Setup: After all Phase 1 tickets are marked complete, run `git diff HEAD -- voxhop/src/` and `git diff HEAD -- voxhop/test/`. — Expected: ZERO diffs in `voxhop/src/` and `voxhop/test/` (MN-06, M-10). The only permitted Phase 1 diffs are: `voxhop/piper-http/main.py`, `voxhop/docker-compose.yml`, `voxhop/infra/main.tf`, `voxhop/infra/outputs.tf`, `voxhop/Makefile`. Any "preparatory refactor" to Track 1 code is a Phase 1 violation. — Observable: Both `git diff` commands produce empty stdout. Exit code 0 with zero output lines. | ☐ |
| NEG-27 | **[Regression — Track 1 Vitest suite broken by Phase 1 changes (M-10)]** Setup: After all Phase 1 changes deployed, run `npx vitest run` in `voxhop/` directory from a clean environment. — Expected: 55/55 tests MUST pass. Zero failures. Zero skipped (M-10: "All 55 Vitest tests MUST pass before any Phase 1 ticket is marked DONE"). A `/tts` route rename, any `voxhop/src/` diff, or a `main.py` syntax error each independently cause failures here. — Observable: `npx vitest run` exits with `Tests: 55 passed, 55 total`. Exit code 0. No skipped or failing tests. | ☐ |
| NEG-28 | **[voxhop-counterparty stub — Non-health routes exposed beyond GET /health (M-05)]** Setup: Start `voxhop-counterparty` stub. Issue `GET /`, `POST /tts`, `GET /ws`, `POST /audio`, `GET /process`. — Expected: ALL non-`/health` paths MUST return HTTP 404 (M-05: "return 404 on every other path"). No WebSocket server. No audio routes. No routing table beyond `GET /health`. Engineering may add "helpful" placeholder routes — all are prohibited. — Observable: `curl -w "%{http_code}" http://voxhop-counterparty:3001/` → `404`. `curl -w "%{http_code}" http://voxhop-counterparty:3001/tts` → `404`. `curl -w "%{http_code}" http://voxhop-counterparty:3001/health` → `200` body `{"status":"stub"}`. | ☐ |
| NEG-29 | **[voxhop-counterparty stub — Phase 2 dependencies present in package.json (MN-08, M-05)]** Setup: `cat voxhop-counterparty/package.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('dependencies',{}))"`. Check for `avr-vad`, `ws`, `whisper`, `ollama`, `piper`, `openai`. Inspect for a `node_modules/` directory. — Expected: ZERO production dependencies (M-05: "zero production `node_modules`"). MUST NOT list `avr-vad`, any Whisper, Ollama, or Piper client (MN-08). The entire Phase 1 service MUST be expressible as a single `index.js` using `node:http` built-in. — Observable: `jq '.dependencies' voxhop-counterparty/package.json` → `null` or `{}`. No `node_modules/` directory present. `grep -E "(avr-vad|whisper|ollama|piper)" voxhop-counterparty/package.json` → zero matches. | ☐ |
| NEG-30 | **[MN-03 — Server-side TypeScript types imported into React client across service boundary]** Setup: `grep -r "from.*persona\.schema" voxhop-simulator/client/src/`; `grep -r "from.*[./]src[/]" voxhop-simulator/client/src/`; inspect `voxhop-simulator/client/tsconfig.json` for any `paths` alias crossing into `src/`. — Expected: ZERO imports from `voxhop-simulator/src/` in any client file (MN-03). Client `Persona` interface MUST be defined independently in `client/src/types/persona.ts` — not imported from or re-exported from the server layer. — Observable: All grep commands return zero matches. `cat voxhop-simulator/client/src/types/persona.ts` contains a self-contained `Persona` interface, not a re-export from the server. | ☐ |
| NEG-31 | **[MN-04 — Module Federation or non-standard bundler composition in Vite client]** Setup: `grep -E "(federation|module-federation|webpack)" voxhop-simulator/client/package.json voxhop-simulator/client/vite.config.ts`. — Expected: Zero references to Module Federation plugins or Webpack (MN-04). The React client MUST be a self-contained Vite SPA building to a static `dist/` directory served by NestJS `useStaticAssets()`. No shared chunk remoting across service boundaries. — Observable: Grep returns zero matches across both files. `vite.config.ts` contains only standard Vite configuration (`server.proxy`, `build.outDir`). | ☐ |
| NEG-32 | **[AR-06 — Italian voice pack quality mismatch between AMI bake and persona JSON piperVoice field (M-11)]** Setup: Read AMI bake log to determine whether `it_IT-riccardo-medium` or `it_IT-riccardo-x_low` was installed (look for M-11 WARNING). Then `POST http://voxhop-piper:5000/tts` with `{"text":"Buongiorno","voice":"<exact piperVoice value from counterparties/it-marco.json>"}`. — Expected: Request MUST return HTTP 200 + LPCM audio. If bake downgraded to `x_low` but `it-marco.json` still declares `medium`, synthesis fails with "model not found" → HTTP 500. `piperVoice` in the JSON MUST exactly match the confirmed-installed quality (M-11). — Observable: HTTP 200 with binary audio body. Any WARNING in bake log about Italian voice downgrade MUST match the `piperVoice` string in `it-marco.json`. | ☐ |
| NEG-33 | **[AR-05 — make destroy leaves orphaned Route 53 zone blocking clean re-deploy]** Setup: Full `make deploy`. Then `make destroy`. Then `aws route53 list-hosted-zones --query 'HostedZones[?Name==\`voxhop.borshik.net.\`]'`. Then re-run `make deploy` from the destroyed state. — Expected: `make destroy` MUST exit 0 and cleanly remove all Phase 1 AWS resources including the Route 53 hosted zone (AR-05). A hosted zone containing DNS records blocks zone deletion unless records are removed first — `terraform destroy` must handle this ordering. Re-`make deploy` MUST succeed without "resource already exists" conflicts. — Observable: `make destroy` exits 0. Route 53 query returns empty list. Second `make deploy` completes without Terraform state conflicts or "already exists" errors. | ☐ |

---

> **UI/UX Specialist CO-SIGN — 2026-06-07**

## 6. UI/UX DESIGN

### 6.1 Design Principles

This interface is a **precision engineering instrument**, not a consumer product. Every rendered element is a direct, unambiguous readout of system state. Nothing is decorative. The only animation permitted in Phase 1 is the skeleton shimmer during data load (`animate-pulse`). No entrance transitions, no hover animations beyond instant colour swaps, no loading spinners.

**Palette semantics** — colour carries meaning, not aesthetics:

| Colour family | Semantic role |
|:--------------|:-------------|
| `gray-*` | Structure, chrome, inactive state |
| `green-400` | Operational success — something is alive and ready |
| `amber-400` | In-progress / attention — waiting for user or async result |
| `red-400` / `red-900` | Failure — developer action required |

**Governing constraints:**
- Dark mode only. `bg-gray-950` base surface. No light-mode variant.
- Desktop-first. 1280×800 minimum viewport. No responsive breakpoints.
- `useReducer` + `useRef` only. No Zustand, no Redux, no Context API state.
- `animate-pulse` shimmer is the sole animation.
- All `<ErrorBanner>` instances are **persistent and non-dismissible**.

---

### 6.2 Page Architecture & Layout Wireframe

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║  HEADER  ·  h-14  ·  sticky top-0 z-10  ·  border-b border-gray-800            ║
║                                                                                  ║
║  ┌─────────────────────────────┐     ┌──────────────────┬──────────────────┐   ║
║  │ VoxHop Simulator    [DEV]   │     │ ●  MIC PENDING   │  WORKLET —       │   ║
║  └─────────────────────────────┘     └──────────────────┴──────────────────┘   ║
║  ←── left: wordmark + env badge ──→  ←── right: mic indicator │ worklet ───→   ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║  MAIN CONTENT  ·  max-w-screen-xl mx-auto  ·  px-6 py-8                        ║
║                                                                                  ║
║  [ErrorBanner — rendered only when state.errorMessage !== null]                  ║
║                                                                                  ║
║  COUNTERPARTY PERSONAS  ←── section label: font-mono uppercase text-gray-400    ║
║                                                                                  ║
║  PERSONA GRID  ·  grid grid-cols-3 gap-6                                        ║
║  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐           ║
║  │ James — British…  │  │ Carlos — Madrid…  │  │ Camille — Paris…  │           ║
║  │                [EN]  │                [ES]  │                [FR]           ║
║  │ You are James, a  │  │ You are Carlos, a │  │ You are Camille,  │           ║
║  └───────────────────┘  └───────────────────┘  └───────────────────┘           ║
║  ┌───────────────────┐  ┌───────────────────┐                                   ║
║  │ Klaus — Frankfurt │  │ Marco — Rome…     │                                   ║
║  │                [DE]  │                [IT]                                   ║
║  └───────────────────┘  └───────────────────┘                                   ║
║                                                                                  ║
║  MIC PERMISSION PROMPT  ·  rendered only when status === 'mic_prompt'           ║
║  ┌──────────────────────────────────────────────────────────────────────────┐   ║
║  │ 🎤  Microphone Access Required                       [Allow Microphone]  │   ║
║  └──────────────────────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════════════════╝
```

**State-specific layout variants:**

| `status` | ErrorBanner | Persona section | MicPermissionPrompt |
|:---------|:------------|:----------------|:--------------------|
| `initialising` | — | — (sync; imperceptible) | — |
| `sab_error` | ✅ (sole content — fatal) | ✗ | ✗ |
| `loading` | — | ✅ (5 skeleton cards) | ✗ |
| `network_error` | ✅ | ✗ | ✗ |
| `mic_prompt` | — | ✅ (5 real cards) | ✅ |
| `mic_denied` | ✅ | ✅ (5 real cards — soft) | ✗ |
| `worklet_init` | — | ✅ (5 real cards) | ✗ |
| `worklet_error` | ✅ | ✅ (5 real cards — soft) | ✗ |
| `ready` | — | ✅ (5 real cards) | ✗ |

---

### 6.3 Component Hierarchy

```
<App>                                    — root; owns useReducer + all useRefs
│   state: AppState                      — via useReducer(appReducer, initialState)
│   audioContextRef: useRef<AudioContext | null>
│   workletNodeRef:  useRef<AudioWorkletNode | null>
│   micStreamRef:    useRef<MediaStream | null>
│
├── <Header>
│       env: string                      — 'DEV' | 'PROD'
│       micStatus: MicStatus
│       workletStatus: WorkletStatus
│
├── <ErrorBanner>                        — rendered when state.errorMessage !== null
│       message: string
│
├── {section label + PersonaGrid}        — rendered when status ∉ {sab_error, network_error, initialising}
│   └── <PersonaGrid>
│           personas: Persona[]
│           loading: boolean
│           ├── <SkeletonCard />  ×5     — when loading=true
│           └── <PersonaCard>    ×n     — when loading=false
│                   persona: Persona
│
└── <MicPermissionPrompt>               — rendered only when status === 'mic_prompt'
        onGrant: () => void
```

**Client-side type definitions** (duplicated from server per MN-03):

```typescript
// voxhop-simulator/client/src/types/persona.ts
export interface Persona {
  id: string;
  name: string;
  language: string;            // 'en' | 'es' | 'fr' | 'de' | 'it'
  piperVoice: string;
  systemPrompt: string;
  conversationOpener?: string;
}

export type MicStatus = 'none' | 'prompting' | 'granted' | 'denied';
export type WorkletStatus = 'none' | 'init' | 'ready' | 'error';
```

---

### 6.4 State Machine

**State shape:**

```typescript
type PhaseStatus =
  | 'initialising' | 'sab_error' | 'loading' | 'network_error'
  | 'mic_prompt' | 'mic_denied' | 'worklet_init' | 'worklet_error' | 'ready';

interface AppState {
  status: PhaseStatus;
  personas: Persona[];
  errorMessage: string | null;
  micGranted: boolean;
  workletReady: boolean;
}
```

**Action types:**

```typescript
type AppAction =
  | { type: 'SAB_OK' }
  | { type: 'SAB_MISSING' }
  | { type: 'PERSONAS_LOADED'; payload: Persona[] }
  | { type: 'PERSONAS_ERROR'; payload: string }
  | { type: 'MIC_GRANTED' }
  | { type: 'MIC_DENIED'; payload: string }
  | { type: 'WORKLET_READY' }
  | { type: 'WORKLET_ERROR'; payload: string };
```

**Transition table:**

| From | Action | To | `errorMessage` |
|:-----|:-------|:---|:---------------|
| `initialising` | `SAB_OK` | `loading` | — |
| `initialising` | `SAB_MISSING` | `sab_error` | `"SharedArrayBuffer unavailable — check COOP/COEP headers"` |
| `loading` | `PERSONAS_LOADED` | `mic_prompt` | — |
| `loading` | `PERSONAS_ERROR` | `network_error` | `"Could not reach simulator service"` |
| `mic_prompt` | `MIC_GRANTED` | `worklet_init` | — |
| `mic_prompt` | `MIC_DENIED` | `mic_denied` | `"Microphone access denied — call features unavailable"` |
| `worklet_init` | `WORKLET_READY` | `ready` | — |
| `worklet_init` | `WORKLET_ERROR` | `worklet_error` | `"AudioWorklet failed to initialise"` |

Terminal states: `sab_error` (hard), `network_error` (hard), `mic_denied` (soft — personas visible), `worklet_error` (soft — personas visible). No outbound transitions. Reload to recover.

**State diagram:**

```
              ┌──────────────┐
              │ initialising │
              └──────┬───────┘
     SAB_OK ↙              ↘ SAB_MISSING
       ┌─────────┐        ┌───────────┐
       │ loading │        │ sab_error │ [TERMINAL — hard]
       └────┬────┘        └───────────┘
  LOADED ↙     ↘ ERROR
┌──────────┐ ┌──────────────┐
│mic_prompt│ │network_error │ [TERMINAL — hard]
└────┬─────┘ └──────────────┘
GRANTED ↙  ↘ DENIED
┌──────────────┐ ┌───────────┐
│ worklet_init │ │mic_denied │ [TERMINAL — soft]
└──────┬───────┘ └───────────┘
READY ↙  ↘ ERROR
 ┌───────┐ ┌───────────────┐
 │ ready │ │ worklet_error │ [TERMINAL — soft]
 └───────┘ └───────────────┘
```

**Boot sequence (`useEffect` on mount — single, empty deps):**

```typescript
useEffect(() => {
  // Step 1: SAB check — synchronous, must be FIRST (M-02)
  if (typeof SharedArrayBuffer === 'undefined') {
    dispatch({ type: 'SAB_MISSING' }); return;
  }
  dispatch({ type: 'SAB_OK' });

  // Step 2: Persona fetch
  fetch('/personas')
    .then(res => { if (!res.ok) throw new Error(); return res.json(); })
    .then(data => dispatch({ type: 'PERSONAS_LOADED', payload: data }))
    .catch(() => dispatch({ type: 'PERSONAS_ERROR', payload: 'Could not reach simulator service' }));
}, []);
```

---

### 6.5 User Journey Map

#### Journey 1 — Happy Path: Full System Initialisation

| Step | User Action | UI State |
|:-----|:------------|:---------|
| 1 | Page loads | Header renders. `status = 'initialising'`. Content area empty. |
| 2 | *(auto)* SAB check passes | `status = 'loading'`. 5 skeleton cards + section label appear. |
| 3 | *(auto)* `GET /personas` resolves | 5 real persona cards. `MicPermissionPrompt` appears. Header mic: `● MIC PENDING` (amber). |
| 4 | User clicks **Allow Microphone** | Browser permission dialog appears. |
| 5 | User clicks **Allow** | `MicPermissionPrompt` disappears. `status = 'worklet_init'`. Mic: `● MIC ACTIVE` (green). Worklet: `WORKLET INIT` (amber). |
| 6 | *(auto)* Worklet ready | `status = 'ready'`. Worklet: `AudioWorklet Ready ✓` (green). Page fully operational — no further UI change in Phase 1. |

#### Journey 2 — SAB Missing (COOP/COEP not served)

Page hydrates → SAB check fires → `status = 'sab_error'` → `<ErrorBanner>` is the sole content. Secondary diagnostic `<p>` renders below: `Required: Cross-Origin-Opener-Policy: same-origin · Cross-Origin-Embedder-Policy: require-corp` (gray monospace). All further init halted. Developer must fix headers and reload.

#### Journey 3 — Persona Load Failure

SAB passes → `status = 'loading'` → 5 skeleton cards → `GET /personas` rejects → skeleton + section label disappear → `<ErrorBanner>` only → `status = 'network_error'`. No retry. Reload to try again.

#### Journey 4 — Mic Permission Denied

5 personas loaded → `MicPermissionPrompt` shown → user denies → `status = 'mic_denied'` → `<ErrorBanner>` above persona grid → mic indicator: `● MIC DENIED` (red). Personas remain visible (soft terminal). AudioWorklet not attempted.

---

### 6.6 Visual Specification (Tailwind)

**Global:** `min-h-screen bg-gray-950 text-gray-100 antialiased`

**Header:** `sticky top-0 z-10 h-14 bg-gray-950 border-b border-gray-800 px-6 flex items-center justify-between`

| Element | Classes |
|:--------|:--------|
| Wordmark | `text-gray-100 font-semibold text-base tracking-tight select-none` |
| Env badge | `bg-gray-800 text-gray-400 text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide` |
| Header separator | `w-px h-4 bg-gray-800` (between mic + worklet) |

**Mic indicator** (`flex items-center gap-1.5`):

| `micStatus` | Dot | Label |
|:------------|:----|:------|
| `prompting` | `w-2 h-2 rounded-full bg-amber-400` | `text-amber-400 text-xs font-mono` · `MIC PENDING` |
| `granted` | `w-2 h-2 rounded-full bg-green-400` | `text-green-400 text-xs font-mono` · `MIC ACTIVE` |
| `denied` | `w-2 h-2 rounded-full bg-red-400` | `text-red-400 text-xs font-mono` · `MIC DENIED` |

**Worklet indicator** (single `<span>`):

| `workletStatus` | Classes | Text |
|:----------------|:--------|:-----|
| `none` | `text-gray-600 text-xs font-mono` | `WORKLET —` |
| `init` | `text-amber-400 text-xs font-mono` | `WORKLET INIT` |
| `ready` | `text-green-400 text-xs font-mono` | `AudioWorklet Ready ✓` |
| `error` | `text-red-400 text-xs font-mono` | `WORKLET ERROR` |

**Main content:** `max-w-screen-xl mx-auto px-6 py-8`

**ErrorBanner:** `flex items-start gap-3 bg-red-900/50 border border-red-800 rounded-lg px-4 py-3 mb-6` | icon `w-4 h-4 text-red-400 shrink-0 mt-0.5` | message `text-red-200 text-sm` | `role="alert"`

**Section label:** `text-gray-400 text-xs font-mono uppercase tracking-widest mb-4`

**PersonaGrid:** `grid grid-cols-3 gap-6`

**PersonaCard:** `bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-gray-700 hover:bg-gray-800/50 transition-colors duration-150`
- Name: `text-gray-100 font-medium text-sm`
- Excerpt: `text-gray-500 text-xs mt-3 line-clamp-2 leading-relaxed`

**Language badge colours:**

| Language | Badge classes |
|:---------|:-------------|
| `en` | `bg-blue-900/60 text-blue-300 border border-blue-800` |
| `es` | `bg-red-900/60 text-red-300 border border-red-800` |
| `fr` | `bg-indigo-900/60 text-indigo-300 border border-indigo-800` |
| `de` | `bg-yellow-900/60 text-yellow-200 border border-yellow-800` |
| `it` | `bg-green-900/60 text-green-300 border border-green-800` |

**SkeletonCard:** `bg-gray-900 border border-gray-800 rounded-lg p-5 animate-pulse` | `aria-busy="true"` | `aria-label="Loading persona"` | placeholder bars: `h-3.5 w-36 bg-gray-800 rounded` (name), `h-3.5 w-7 bg-gray-800 rounded` (badge), `h-3 w-full bg-gray-800 rounded mt-4` + `h-3 w-2/3 mt-2` (excerpt lines). Render exactly **5**.

**MicPermissionPrompt:** `bg-gray-900 border border-gray-800 rounded-lg px-5 py-4 mt-6 flex items-center justify-between gap-4`
- Button: `bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-gray-100 text-sm font-medium px-4 py-2 rounded-md transition-colors duration-150 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-gray-400`
- `aria-label="Grant microphone access for audio capture"`

---

### 6.7 Accessibility Notes

| Element | Implementation |
|:--------|:---------------|
| `<ErrorBanner>` | `role="alert"` — announced immediately on render |
| `<SkeletonCard>` | `aria-busy="true"` + `aria-label="Loading persona"` |
| "Allow Microphone" button | `aria-label="Grant microphone access for audio capture"` |
| `<PersonaCard>` | `role="article"` — no `tabindex`; read-only in Phase 1 |
| Mic indicator | `aria-label="Microphone status: {pending|active|denied}"` on wrapper |
| Worklet indicator | `aria-label="AudioWorklet status: {none|initialising|ready|error}"` on `<span>` |
| Keyboard nav | Only one interactive element (mic button) — natively focusable |
| Contrast | `text-gray-100/bg-gray-950` ≈ 19.5:1; `text-red-200/bg-red-900/50` ≈ 7.3:1 — all WCAG AA |

**Browser support note** (document in `voxhop-simulator/client/README.md`): Supported: Chrome 90+, Firefox 90+. Safari not supported in Phase 1 — AudioWorklet + `crossOriginIsolated` behaviour is inconsistent.

---

### 6.8 Phase 2/3 Elements — Not Rendered in Phase 1

| Element | Phase 1 treatment |
|:--------|:-----------------|
| Dial / Call button | Not in DOM |
| Call state panel | Not in DOM |
| Transcript panel | Not in DOM |
| Protocol event timeline | Not in DOM |
| Mode toggle (Direct / Translation) | Not in DOM |
| WS connection status | WS connects (ack received) but NOT surfaced in UI |
| Persona editor | Not in DOM |

---

> **Chief Architect CO-SIGN — REVIEW — 2026-06-07**
> Verdict: ✅ APPROVED WITH NOTES
>
> All 13 mandates (M-01..M-13) are concretely cited in §4.4 ticket strategies with explicit mandate references in P1-01..P1-08; all 8 MUST NOTs (MN-01..MN-08) have at least one adversarial NEG probe in §5.2 (MN-02 covered four times: NEG-01/02/03/04); all 7 architectural risks (AR-01..AR-07) carry both §4.4 mitigations and §5.2 NEG coverage, including the AR-07 spec-error fix (ACC-07 now correctly reads `POST /tts` on port `5000`, validated by NEG-09 and the P1-08 curl command). All 6 engineering risks (ER-01..ER-06) have concrete mitigation strategies; all 11 ACC criteria map to at least one ticket; §6 state machine and component hierarchy faithfully reproduced in §4.3/4.4 with zero contradictions. The `voxhop/src/` zero-change guarantee doubly enforced: §4.1/4.2 zero ticket scope in `voxhop/src/` and §5.2 NEG-26/NEG-27 regression gate. EN-01 and EN-02 are acceptable non-blocking notes.
>
> **Implementation notes for Engineering (non-blocking):**
>
> 1. **EN-01 — Check Tailwind version before substituting**: Run `npm list tailwindcss` in the client. Tailwind v3.3+ (June 2023) ships `gray-950` natively — if on v3.3+, use `bg-gray-950` as specified in §6.6 with zero config changes needed; pin `tailwindcss >= 3.3.0` in `package.json`. Only fall back to `zinc-950` or `extend.colors['gray-950']` if pinned below v3.3.
> 2. **Vite dev proxy port**: `server.proxy: { '/personas': 'http://localhost:443' }` fails without root privileges locally. Run NestJS dev on an unprivileged port (suggest `4443`, `SIMULATOR_PORT` env var defaulting to `4443`); proxy `{ '/personas': 'http://localhost:4443' }`. Production Docker bind to port 443 inside container is unaffected.
> 3. **AR-02 + AR-05 documentation ownership**: (a) AR-02: add comment `# COOP/COEP are set at NestJS app layer only — do NOT add them here (AR-02)` in `docker-compose.yml` adjacent to `voxhop-simulator` service definition — assign to P1-04. (b) AR-05: add `make destroy` smoke-test step to the P1-08 checklist (run `make destroy` from a clean `make deploy` state; assert Route 53 hosted zone is absent; assert clean redeploy succeeds) — NEG-33 probes this but P1-08 ticket text only lists ACC-01..ACC-11.

---

> **Chief Architect CO-SIGN — INITIATE — 2026-06-07**

## 7. ARCHITECTURAL GUIDANCE

### 7.1 Mandates (M-xx)

**M-01 — COOP/COEP middleware registered at NestJS application level, before all route handlers**
- **File**: `voxhop-simulator/src/main.ts`
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` MUST be applied via `app.use()` as a global Express-layer middleware, registered on the NestJS application instance before any controller, route handler, or static file serving is mounted. They MUST appear on every HTTP response without exception — including `/health`, `/personas`, 4xx/5xx error responses, WebSocket upgrade handshakes, and all React SPA static asset responses. Per-controller `@Header()` decoration or per-route middleware is explicitly insufficient: a single response without both headers breaks the browser's cross-origin isolation policy and renders `SharedArrayBuffer` unavailable, failing ACC-05 and ACC-06. The `COOP_COEP_ENABLED` env var (§3.3) may gate this middleware but MUST default to `true`.

**M-02 — `SharedArrayBuffer` boot check is browser-side only; NestJS has no role in this assertion**
- **File**: `voxhop-simulator/client/src/App.tsx` (or root component mount effect)
- The SAB check (`typeof SharedArrayBuffer === 'undefined'`) MUST execute as the first side-effect on component mount — before `AudioContext` creation, before `getUserMedia`, and before any `GET /personas` fetch. If absent, the component MUST render `<ErrorBanner message="SharedArrayBuffer unavailable — check COOP/COEP headers" />` and immediately return. The NestJS backend's sole responsibility is serving the correct COOP/COEP headers that enable `crossOriginIsolated = true`.

**M-03 — Piper `POST /tts` endpoint MUST NOT be renamed; `voice` parameter is purely additive**
- **File**: `voxhop/piper-http/main.py`
- The existing `@app.post("/tts")` route MUST NOT be renamed, removed, or aliased as the sole entry point. The `voice` parameter is added to the `TTSRequest` Pydantic model as `voice: Optional[str] = None`. Default: `effective_voice = request.voice or "en_GB-alan-medium"`. Every Track 1 caller sending no `voice` field receives `en_GB-alan-medium` synthesis. Note: ACC-07 in §5.1 contains a spec error referencing `/synthesise` on port `3200` — the correct endpoint is `/tts` on port `5000`. Engineering must raise this with the PO before P1-03 begins, and ACC-07 must be corrected. A `/synthesise` alias may be added as a secondary route pointing to the same handler; `/tts` is never removed.

**M-04 — LRU subprocess pool: `asyncio.Lock` MUST cover the full lookup → eviction → spawn → register cycle; synthesis runs outside the lock**
- **File**: `voxhop/piper-http/main.py`
- The current `_synthesise_sync()` spawns a fresh `subprocess.run()` per request. Phase 1 replaces both `_piper_proc` management and `_synthesise_sync()` with a `collections.OrderedDict` named `_pool` (hard capacity: 2). Pool key: voice name string. Pool value: live `subprocess.Popen` handle with `stdin=PIPE, stdout=PIPE`. The global `asyncio.Lock` MUST be held across: (1) check if voice in `_pool`; (2) if present, `_pool.move_to_end(voice)` and retrieve handle; (3) if absent and `len(_pool) >= 2`, pop `next(iter(_pool))` — kill that process; (4) spawn `subprocess.Popen` for new voice; (5) insert into `_pool`. Lock released AFTER the new process is registered. Synthesis runs OUTSIDE the lock. After synthesis, call `_pool[voice].poll()` — if not `None`, the process died; remove from `_pool` so the next request re-spawns cleanly.

**M-05 — `voxhop-counterparty` stub exposes ONLY `GET /health` in Phase 1**
- **Directory**: `voxhop-counterparty/` (new; minimal Node.js service)
- The stub MUST respond `{ "status": "stub" }` on `GET /health` and return 404 on every other path. No WebSocket server, no audio processing, no `avr-vad` import. The entire Phase 1 service MUST be expressible as a single `index.js` using Node.js built-in `node:http` with zero production `node_modules`.

**M-06 — Route 53 A record MUST reference `aws_eip.voxhop.public_ip`; no hardcoded IP strings**
- **File**: `voxhop/infra/main.tf`
- The `aws_route53_record` A record for `simulator.voxhop.borshik.net` MUST set `records = [aws_eip.voxhop.public_ip]` — the Terraform-managed resource attribute — not the literal string `"13.62.124.43"`. This ensures any future EIP reallocation propagates to DNS automatically on the next `terraform apply`.

**M-07 — Certbot DNS-01 only; `issue-cert.sh` MUST include a preflight NS check and MUST NOT be auto-invoked by `make deploy`**
- **Files**: `voxhop/infra/packer/scripts/issue-cert.sh` (new), `voxhop/Makefile`
- `issue-cert.sh` MUST invoke `certbot certonly --dns-route53 --non-interactive --agree-tos -d simulator.voxhop.borshik.net -d "*.voxhop.borshik.net"`. Before any Certbot call, it MUST run: `dig NS voxhop.borshik.net @8.8.8.8 | grep -q "awsdns"`. If Route 53 NS records are not returned, the script MUST exit with a human-readable error and zero Certbot invocations. `make deploy` MUST NOT invoke this script. `make issue-cert` is a separate Makefile target. First attempt MUST use `--staging` flag (Let's Encrypt staging — no rate limits, not browser-trusted) to validate the DNS-01 flow before live issuance.

**M-08 — NS delegation banner: instructional warning BEFORE Terraform apply; NS values printed AFTER; `make issue-cert` is a distinct target**
- **Files**: `voxhop/Makefile`, `voxhop/infra/outputs.tf`
- `make deploy` prints an instructional preamble BEFORE `terraform apply` executes explaining the NS delegation requirement. Because Route 53 NS values are assigned at hosted zone creation, the actual NS records are printed AFTER `terraform apply` via `terraform -chdir=infra output -json ns_records`. `outputs.tf` MUST add `output "ns_records" { value = aws_route53_zone.voxhop.name_servers }` (currently missing — DA-02 finding). The `deploy` target concludes: "Next: add the NS records above to borshik.net registrar, confirm propagation (`dig NS voxhop.borshik.net @8.8.8.8`), then run `make issue-cert`."

**M-09 — `counterparties/` directory MUST be mounted read-only; NestJS performs zero writes to this path**
- **File**: `voxhop/docker-compose.yml` (service definition for `voxhop-simulator`)
- Volume mount MUST use the `:ro` flag: `- ./counterparties:/app/counterparties:ro`. `PersonaLoader` uses only `fs.readFile` / `fs.readdir` at startup. Zero write operations target `/app/counterparties` in Phase 1.

**M-10 — Track 1 zero-regression guarantee: 55/55 Vitest tests pass; `voxhop/src/` receives exactly zero changes**
- **Files**: `voxhop/src/` (zero diffs), `voxhop/test/` (zero diffs)
- `voxhop/src/` MUST be untouched — not a single file, not a single import. The `txTracks[]` schema migration is Phase 3 (`TRACK2_PHASE3_TRANSLATION.md §3.1`). Phase 1's only diffs to existing files: `voxhop/piper-http/main.py`, `voxhop/docker-compose.yml`, `voxhop/infra/main.tf` + `outputs.tf`, `voxhop/Makefile`. All 55 Vitest tests MUST pass before any Phase 1 ticket is marked DONE.

**M-11 — Italian voice pack: bake-time availability check; log WARNING on downgrade; persona JSON MUST match installed quality**
- **File**: `voxhop/infra/packer/voxhop-ami.pkr.hcl`
- AMI bake MUST attempt `it_IT-riccardo-medium.onnx` first (HTTP HEAD to HuggingFace URL). If unavailable, fall back to `it_IT-riccardo-x_low.onnx` and emit `[voxhop-ami] WARNING: it_IT-riccardo-medium unavailable — installed x_low`. The `piperVoice` field in `counterparties/it-*.json` MUST match the quality level confirmed installed. Evaluate `it_IT-paola-medium` (female voice) as a higher-quality alternative if `riccardo` is unavailable at `medium`.

**M-12 — `PersonaSchema` Zod validation at NestJS startup; invalid files skipped with WARNING; zero valid personas is non-fatal**
- **File**: `voxhop-simulator/src/persona/persona.loader.ts` (new)
- On startup, enumerate all `*.json` from `/app/counterparties`. For each file, call `PersonaSchema.safeParse()`. On failure: `logger.warn('[PersonaLoader] Skipping invalid persona: ${filename}')`. On duplicate `id`: first-seen wins + warning. Zero personas loaded → service remains healthy, `GET /personas` returns `[]`.

**M-13 — Port 443 SG ingress rule already exists in Track 1 `main.tf`; P1-01 MUST NOT create a duplicate**
- **File**: `voxhop/infra/main.tf` (lines 137–143 — existing ingress rule)
- The existing `aws_security_group.voxhop` already declares TCP 443 ingress. P1-01's additions are limited to: `aws_route53_zone`, `aws_route53_record`, and Route 53 IAM policy statements. Terraform will error on a duplicate `ingress` block.

---

### 7.2 MUST NOTs (MN-xx)

**MN-01 — MUST NOT use Certbot HTTP-01 challenge**
- Port 80 is not declared open in `aws_security_group.voxhop`. DNS-01 is the only viable cert challenge mechanism. `--standalone`, `--webroot`, and `--nginx` are prohibited.

**MN-02 — MUST NOT serve any `voxhop-simulator` HTTP response without both COOP and COEP headers**
- No route, no exception filter, no static file response, no WebSocket upgrade may omit `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`. One uncovered response breaks isolation and fails ACC-05/ACC-06.

**MN-03 — MUST NOT import TypeScript types from `voxhop-simulator/src/` into `voxhop-simulator/client/`**
- No `tsconfig.paths` alias, no relative `../../src/` import crossing the server→client boundary. Types needed in both layers (e.g., `Persona`) are DUPLICATED — defined independently in `voxhop-simulator/src/persona/persona.schema.ts` and `voxhop-simulator/client/src/types/persona.ts`.

**MN-04 — MUST NOT use Module Federation or non-standard bundler composition**
- The React client is a self-contained Vite SPA. No `@module-federation/vite`. NestJS serves the Vite-built `dist/` directory as static files.

**MN-05 — MUST NOT implement file-watching or hot-reload of persona files in Phase 1**
- No `chokidar`, `fs.watch()`, `FSWatcher`, or `setInterval`-based re-read. Persona data is loaded once at startup. Container restart is the reload mechanism.

**MN-06 — MUST NOT modify `voxhop/src/` — not a single file, not a single line**
- Zero diffs to `voxhop/src/`. The `txTracks[]` schema migration and all 17 test fixture update sites are Phase 3. Any "preparatory" modification to `voxhop/src/` in Phase 1 is prohibited.

**MN-07 — `make deploy` MUST NOT auto-invoke `issue-cert.sh` or any Certbot command**
- Cert issuance is gated on human-confirmed NS propagation (15 minutes to 48 hours). Auto-invocation risks exhausting Let's Encrypt rate limits (5 failed DNS-01 validations per hostname per hour).

**MN-08 — `voxhop-counterparty` Phase 1 stub MUST NOT contain `avr-vad`, Whisper, Ollama, or Piper client code**
- No Silero VAD ONNX, no Whisper HTTP client, no Ollama client, no Piper HTTP client. Phase 1 stub is a throwaway container — Phase 2 replaces it entirely.

---

### 7.3 Architectural Risks (AR-xx)

**AR-01 — NS delegation timing: Certbot DNS-01 fails if NS not delegated before cert issuance → Let's Encrypt rate limit**
- **Risk**: HIGH — operational blocker if missequenced.
- Let's Encrypt requires `_acme-challenge.voxhop.borshik.net` TXT records to be resolvable. If `borshik.net` has not delegated to Route 53 NS, cert issuance fails. After 5 failed DNS-01 validations per hostname per hour, Let's Encrypt rate-limits. After 50 cert issuance attempts per domain per week, the weekly cap is hit.
- **Mitigation**: M-07 preflight (`dig NS voxhop.borshik.net @8.8.8.8 | grep -q "awsdns"` before any Certbot call). First attempt uses `--staging`. Confirm NS propagation from two resolvers (`@8.8.8.8` and `@1.1.1.1`) before running live `make issue-cert`.

**AR-02 — COOP/COEP headers leaking to `voxhop-app` via a future shared reverse proxy**
- **Risk**: MEDIUM — latent in Phase 1; operational trap for Phases 2/3.
- If a future nginx proxy applies COOP/COEP globally, `voxhop-app`'s responses carry `COEP: require-corp` — potentially breaking cross-origin audio asset loading.
- **Mitigation**: COOP/COEP applied at NestJS application layer ONLY (M-01). Document in README: "Do not add COOP/COEP at nginx or any reverse proxy."

**AR-03 — Piper LRU subprocess race condition on concurrent voice requests**
- **Risk**: MEDIUM — structural rearchitecture, not a simple extension.
- `_synthesise_sync()` currently spawns a fresh `subprocess.run()` per request; `_piper_proc` is used only by `/health`. Without M-04's lock, two concurrent async coroutines can double-evict, double-kill, or produce orphaned processes.
- **Mitigation**: Enforce M-04 strictly. Add a concurrent-safety test: fire two concurrent synthesis requests for different voices when pool is full (size=2); assert pool size remains exactly 2; no subprocess leak; both return valid PCM.

**AR-04 — AudioWorklet and `SharedArrayBuffer`: Chrome and Firefox only; Safari explicitly excluded**
- **Risk**: LOW for Phase 1 (exclusion is intentional).
- AudioWorklet + `crossOriginIsolated = true` is fully supported in Chrome 66+ and Firefox 76+. Safari support is inconsistent.
- **Mitigation**: ACC-04/ACC-05 verified on Chrome (latest stable) and Firefox (latest stable) only. Document "Supported: Chrome 90+, Firefox 90+. Safari not supported in Phase 1."

**AR-05 — Terraform state drift from manual AWS Console changes**
- **Risk**: MEDIUM before `make destroy` — can cause teardown failures or orphaned resources.
- **Mitigation**: All DNS changes go through `main.tf` → commit → `make deploy`. Before Phase 1 is closed, `make destroy` MUST be smoke-tested from a clean `make deploy`.

**AR-06 — Italian voice pack quality: `it_IT-riccardo-medium` may be unavailable on HuggingFace**
- **Risk**: LOW for Phase 1; MEDIUM for Phase 2 pipeline quality.
- **Mitigation**: M-11 bake-time check + WARNING log + persona JSON alignment. Evaluate `it_IT-paola-medium` as fallback.

**AR-07 — Spec error in §3.2 and ACC-07: references `/synthesise` on port `3200`; actual endpoint is `/tts` on port `5000`**
- **Risk**: HIGH — Engineering renaming `/tts` causes immediate 55/55 Track 1 test failure.
- **Mitigation**: M-03 prohibits renaming. Engineering MUST raise ACC-07 correction with PO before first P1-03 commit.

---

### 7.4 Dependency Assumptions (DA-xx)

**DA-01 — GPU instance EIP `13.62.124.43` is stable throughout Phase 1; Terraform A record references `aws_eip.voxhop.public_ip` dynamically**

**DA-02 — `voxhop-app` remains on port 3000; `voxhop-counterparty` stub assigned port 3001**
- Existing occupied ports: 3000 (`voxhop-app`), 443 (`voxhop-simulator`), 5000 (`voxhop-piper`), 6379 (`voxhop-redis`), 8001 (`voxhop-whisper`), 11434 (`voxhop-ollama`).

**DA-03 — `python3-certbot-dns-route53` is installable via `apt-get` on AWS DLAMI Ubuntu 22.04**
- If the apt package version lags the plugin's required API, fall back to `pip3 install certbot certbot-dns-route53`.

**DA-04 — `avr-vad` ONNX (Silero VAD v5) is NOT installed or declared in any Phase 1 package manifest**
- Phase 2 dependency only. Must not appear in `voxhop-simulator/package.json` or any Phase 1 compose service.

**DA-05 — Port 443 SG ingress rule already exists in Track 1 `voxhop/infra/main.tf` (lines 137–143); P1-01 adds zero SG changes**

**DA-06 — `borshik.net` registrar is accessible to the Sponsor for the one-time NS delegation action before cert issuance**
- Irreducible human gate. Phase 1 is not DONE until the TLS certificate is successfully issued.

---

## 8. DELIVERY & STATUS

### Phase
`NOW`

### Dependencies
- Track 1 DONE ✅ (instance running, 55/55 tests green, `voxhop-app` WS reachable)
- AWS Route 53 access for `voxhop.borshik.net` hosted zone creation
- Sponsor one-time manual action: NS delegation from `borshik.net` registrar to Route 53 NS records (printed by `make deploy` banner)

### Co-Signs

| Agent | Status | Date |
|:------|:-------|:-----|
| Product Owner | ✅ APPROVED | 2026-06-07 |
| Chief Architect (INITIATE) | ✅ COMPLETE | 2026-06-07 |
| UI/UX Specialist | ✅ COMPLETE | 2026-06-07 |
| Engineering Team | ✅ COMPLETE | 2026-06-07 |
| Integration Test | ✅ COMPLETE | 2026-06-07 |
| Chief Architect (REVIEW) | ✅ APPROVED WITH NOTES | 2026-06-07 |
| Sponsor Approval | ✅ APPROVED | 2026-06-07 |

### Regression Radius
- **`voxhop/piper-http/main.py`** — additive `voice` param; Track 1's single-voice usage must remain unchanged (no `voice` field → `en_GB-alan-medium`)
- **`voxhop/docker-compose.yml`** — new service entries; existing Track 1 service health checks must continue to pass
- **`voxhop/infra/main.tf`** — new Route 53 + SG resources; existing EC2, S3, and IAM resources must be unaffected
- **`voxhop/test/`** — all 55 Track 1 Vitest tests must pass after any changes to `voxhop/` files
