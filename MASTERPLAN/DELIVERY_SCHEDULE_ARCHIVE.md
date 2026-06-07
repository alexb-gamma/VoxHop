# VoxHop DELIVERY SCHEDULE — ARCHIVE

> Completed features are archived here after Sponsor closure.
> Active delivery schedule: [`DELIVERY_SCHEDULE.md`](DELIVERY_SCHEDULE.md)

---

## Track 1 — Foundation + Pipeline Demo
**Closed: 2026-06-06 — SPONSOR APPROVED**
**Feature Spec**: [`FEATURES/TRACK1_FOUNDATION_PIPELINE.md`](FEATURES/TRACK1_FOUNDATION_PIPELINE.md)

> **Sponsor Directive**: Prove the pipe. IaC from the very first resource. End-to-end STT → LLM → TTS echo pipeline on a live Gamma PSTN call in Week 1.
> **All Co-Signs**: PO ✅ | Architect INITIATE ✅ | UI/UX ⏭ (backend only) | Engineering ✅ | Integration Test ✅ | Architect REVIEW ✅ | Sponsor ✅

### Final Delivery State

| Item | Value |
|:--|:--|
| **AMI** | `ami-0cae9aa0e65457fa4` (`voxhop-ami-1780762106`, re-baked 2026-06-06) |
| **Instance** | `i-0295d1d370d43a642` (`g5.xlarge`, `eu-north-1b`) |
| **Elastic IP** | `13.62.124.43` |
| **WebSocket URL** | `wss://13.62.124.43:3000/ws/calls` |
| **TypeScript** | 0 errors |
| **Tests** | 55/55 Vitest passing |
| **First-boot health** | All 5 services healthy — no SSM post-boot intervention required |

### Services on Final Instance

| Service | Container | Status |
|:--|:--|:--|
| VoxHop Node.js | `voxhop-app` | healthy |
| Ollama (gemma4, CUDA A10G) | `voxhop-ollama` | healthy |
| Whisper (large-v3, CUDA) | `voxhop-whisper` | healthy |
| Piper TTS (en_GB-alan-medium) | `voxhop-piper` | healthy |
| Redis 7 | `voxhop-redis` | healthy |

---

### Eng-A: Infrastructure Track

| Ticket | Day | File(s) | Status | Description | Dependencies |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T-00** | Day 0 | — | `DONE` | **Submit A10G GPU quota** (`eu-north-1`, `g5.xlarge`). 64 vCPUs G/VT approved; `g5.xlarge` confirmed available in `eu-north-1b`. | None |
| **T-01** | Day 1 | `voxhop/package.json`, `voxhop/tsconfig.json`, `voxhop/vitest.config.ts`, `voxhop/Makefile` | `DONE` | **Project scaffold + Makefile skeleton**. `tsconfig.json` uses `"module": "commonjs"` (C-11). All Makefile targets implemented. | None |
| **T-04** | Day 2 | `voxhop/infra/main.tf`, `voxhop/infra/variables.tf`, `voxhop/infra/outputs.tf`, `voxhop/infra/backend.tf` | `DONE` | **Terraform IaC — base infrastructure**. VPC, subnet, IGW, SG, IAM (with `tag:GetResources` ID-04), EIP, S3 (`force_destroy=true`), DynamoDB. All resources tagged `Project=voxhop`. | T-01 |
| **T-05** | Day 3 | `voxhop/infra/packer/voxhop-ami.pkr.hcl` | `DONE` | **Packer AMI template**. CUDA 12, Docker Engine + Compose v2, Whisper Large v3, Ollama + Gemma 4, Piper + `en_GB-alan-medium`. GPU smoke test gate. comfort_en.pcm baked. | T-04 |
| **T-09** | Day 4 | `voxhop/infra/main.tf` | `DONE` | **Terraform EC2 + make deploy**. EC2 `g5.xlarge` with user-data `docker compose up -d`. `eu-west-1` fallback variables documented in `variables.tf`. Post-destroy tag-scan in Makefile `_tag-scan-gate`. | T-04, T-05 |
| **T-11** | Day 5 | `voxhop/test/chaos.test.ts`, `voxhop/test/metrics.test.ts` | `DONE` | **Chaos + latency instrumentation tests**. 14 chaos tests + 11 metrics tests. All pass. | T-10 |

---

### Eng-B: Pipeline Track

| Ticket | Day | File(s) | Status | Description | Dependencies |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T-02** | Day 1 | `voxhop/src/config.ts`, `voxhop/src/schemas.ts`, `voxhop/test/frame-shape.test.ts` | `DONE` | **Zod schemas + frame-shape tests**. Config with process.exit on failure. C-02 `tracks[]` MediaStartedSchema. GAP-01 `WhisperResponseSchema` z.string().min(1). 17 frame-shape tests, all pass. | None |
| **T-03** | Day 2 | `voxhop/piper-http/main.py`, `voxhop/piper-http/requirements.txt`, `voxhop/piper-http/Dockerfile`, `voxhop/docker-compose.yml` | `DONE` | **Piper HTTP wrapper** *(Sprint 0 CRITICAL PATH blocker — ID-01)*. FastAPI `POST /tts` → raw 24kHz PCM. Per-request subprocess. Full docker-compose.yml with all services + health checks. | T-01 |
| **T-06** | Day 3 | `voxhop/src/silero-vad.ts`, `voxhop/src/audio-utils.ts`, `voxhop/test/vad.test.ts` | `DONE` | **VAD + audio-utils + VAD unit tests**. silero-vad.ts copied from HelloSurgery. audio-utils.ts with downsampleTo16k + buildWav (RE-07). 13 VAD tests (10ms/20ms/40ms cadences, lock-held discard), all pass. | T-02 |
| **T-07** | Day 4 | `voxhop/src/redis.ts`, `voxhop/src/metrics.ts` | `DONE` | **Redis + Prometheus metrics**. ioredis (C-05). acquireLock/releaseLock/initCallState/cleanupCallState. GAP-04 compliance. 4 Histograms + turnFailures_total Counter. | T-02, T-06 |
| **T-08** | Day 4 | `voxhop/src/comfort.ts`, `voxhop/src/pipeline.ts` | `DONE` | **Pipeline execution + comfort clip**. loadComfortClip with process.exit guards (NEG-21/22). executeTurn linear SD-01. callWhisper/callOllama/callPiper with AbortSignal.timeout (C-10). StagedError instanceof narrowing (GAP-02). Zero-byte guard (GAP-03). txTrackId injection (C-04). | T-03, T-06, T-07 |
| **T-10** | Day 5 | `voxhop/src/call-handler.ts`, `voxhop/src/web-server.ts`, `voxhop/src/index.ts` | `DONE` | **Call handler + web server + index**. C-01 WebSocketServer({noServer:true}). VoxHopCallHandler with Map<trackId,LegState> (SD-02). SD-03 direct vad.feed() dispatch. NEG-03/04/05/06 guards. GAP-04 cleanup. Startup sequence: config→VAD pre-warm→comfort load→listen (C-07/08/09). | T-06, T-07, T-08 |

---

### Shared: Live Demo Gate

| Ticket | Day | Status | Notes |
| :--- | :--- | :--- | :--- |
| **T-12** | — | `WAIVED BY SPONSOR` | Live Gamma demo gate waived. Infrastructure fully deployed and all 5 services verified healthy. Gamma DID not yet configured at time of closure. |

---

### Sprint 0 Blockers (Final State)

| ID | Blocker | Status |
| :--- | :--- | :--- |
| S0-1 | Submit A10G GPU quota (`eu-north-1`, `g5.xlarge`) | `DONE — 64 vCPUs G/VT approved in eu-north-1; g5.xlarge available in eu-north-1b` |
| S0-2 | Build and validate Piper HTTP wrapper (`piper-http/`) | `DONE — piper healthy on live instance i-0295d1d370d43a642` |
| S0-3 | Validate all Zod schemas against `telco-ai-bridge` source (`rx.go`, `session.go`) | `DONE — schemas validated against spec §7 confirmed facts` |
| S0-4 | Bootstrap Terraform state backend (`make bootstrap`) | `DONE — S3 bucket voxhop-terraform-state + DynamoDB voxhop-terraform-locks created and imported` |
| S0-5 | Packer AMI built and AMI ID recorded in `variables.tf` | `DONE — ami-0cae9aa0e65457fa4 recorded in variables.tf` |

---

### Key Decisions Logged

| Decision | Rationale |
|:--|:--|
| AWS DLAMI base | Eliminates all DKMS/kernel-module compile risk; NVIDIA drivers, CUDA, Docker, NVIDIA Container Toolkit pre-installed |
| Ollama readiness via HTTP poll | `docker exec ollama list` unreliable; host curl to `/api/tags` with abort-on-container-exit is deterministic |
| `runtime: nvidia` + explicit NVIDIA env vars | Both `runtime: nvidia` AND `deploy.resources.reservations.devices` causes GPU discovery conflict — use only one |
| `npm install → build → prune` sequence | `npm install --production` skips `tsc` (devDep), causing build failure |
| Piper fully bundled in `/opt/piper/` | Wrapper script at `/usr/local/bin/piper` sets `ESPEAK_DATA_PATH` and `LD_LIBRARY_PATH` |
| `CUDA_VISIBLE_DEVICES=0` required | Ollama GPU discovery timed out without explicit device env var on g5.xlarge |
| `eu-north-1b` AZ hardcoded | `g5.xlarge` not available in `eu-north-1a` |
| Makefile `build-ami` auto-creates tarball | Prevents future builds failing silently due to missing `/tmp/voxhop-src.tar.gz` |
