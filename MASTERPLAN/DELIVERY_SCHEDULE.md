# VoxHop DELIVERY SCHEDULE

## Summary Table

| Feature | Engineering Status | Verification Status | Notes |
| :--- | :--- | :--- | :--- |
| **Track 1 — Foundation + Pipeline Demo** | `DONE` | `SPONSOR CLOSED 2026-06-06` | See [`DELIVERY_SCHEDULE_ARCHIVE.md`](DELIVERY_SCHEDULE_ARCHIVE.md) |
| **Track 2 Phase 1 — Infrastructure** | `DONE` | `SPONSOR CLOSED 2026-06-07` | Live at `https://simulator.voxhop.borshik.net` · LE cert · 5 personas · AudioWorklet ✅ |
| **Track 2 Phase 2 — AI Counterparty + Direct Mode** | `NOT STARTED` | `—` | NEXT — ready to start |
| **Track 2 Phase 3 — Translation + Replace Mode** | `NOT STARTED` | `—` | Awaiting Phase 2 DONE |

---

## Track 2 Phase 1 — Infrastructure — *SPONSOR CLOSED 2026-06-07*

> **Status**: `DONE — SPONSOR VERIFIED 2026-06-07`
> **Feature Spec**: [`MASTERPLAN/FEATURES/TRACK2_PHASE1_INFRASTRUCTURE.md`](FEATURES/TRACK2_PHASE1_INFRASTRUCTURE.md)
> **Dependency**: Track 1 DONE ✅
> **Co-Signs**: Chief Architect (INITIATE) ✅ → UI/UX ✅ → Engineering ✅ → Integration Test ✅ → Chief Architect (REVIEW) ✅ → **Sponsor ✅ APPROVED 2026-06-07**

### Acceptance Verification (all PASS — 2026-06-07)

| Check | Result |
| :--- | :--- |
| ACC-01 HTTPS valid padlock | ✅ PASS — Let's Encrypt YE2, expires 2026-09-05 |
| ACC-02 `GET /personas` → 5 items | ✅ PASS — de-klaus, en-james, es-carlos, fr-camille, it-marco |
| ACC-03 `GET /health` → 200 | ✅ PASS — `{"status":"ok"}` from public internet |
| ACC-04 Mic permission grant | ✅ PASS — Sponsor browser confirmed |
| ACC-05 AudioWorklet Ready | ✅ PASS — Sponsor browser confirmed |
| ACC-06 COOP/COEP headers | ✅ PASS — `same-origin` + `require-corp` (public internet) |
| ACC-07 WS handshake | ✅ PASS — `HTTP 101 Switching Protocols` + `{"type":"ack"}` |
| Track 1 regression gate | ✅ PASS — 55/55 Vitest, zero diffs in Track 1 code |

### Tickets (all DONE)

| Ticket | File(s) | Status | Description |
| :--- | :--- | :--- | :--- |
| **P1-01** | `voxhop/infra/main.tf`, `outputs.tf` | `✅ DONE` | Terraform: Route 53 zone + A record + IAM policy |
| **P1-02** | `voxhop/infra/packer/voxhop-ami.pkr.hcl`, `issue-cert.sh` | `✅ DONE` | AMI rebuild: 4 EU Piper voice packs + certbot |
| **P1-03** | `voxhop/piper-http/main.py` | `✅ DONE` | Piper LRU pool, multi-voice, concurrent-safe |
| **P1-04** | `voxhop/docker-compose.yml`, `voxhop/Makefile` | `✅ DONE` | 7-service compose stack + Makefile targets |
| **P1-05** | `voxhop-simulator/` | `✅ DONE` | NestJS scaffold: COOP/COEP, LE cert, persona loader, WS gateway |
| **P1-06** | `voxhop-simulator/client/` | `✅ DONE` | React/Vite/Tailwind SPA + AudioWorklet |
| **P1-07** | `counterparties/*.json` | `✅ DONE` | 5 EU persona JSONs |
| **P1-08** | `voxhop-simulator/test/smoke.test.ts` | `✅ DONE` | Smoke tests + ACC checks |

---

## Track 2 Phase 2 — AI Counterparty + Direct Mode (NEXT)

> **Status**: `NEXT — READY TO START`
> **Feature Spec**: [`MASTERPLAN/FEATURES/TRACK2_PHASE2_COUNTERPARTY.md`](FEATURES/TRACK2_PHASE2_COUNTERPARTY.md)

*Tickets defined after Phase 2 spec is co-signed.*

---

## Track 2 Phase 3 — Translation + Replace Mode (NEXT)

> **Status**: `AWAITING PHASE 2 DONE`
> **Feature Spec**: [`MASTERPLAN/FEATURES/TRACK2_PHASE3_TRANSLATION.md`](FEATURES/TRACK2_PHASE3_TRANSLATION.md)

*Tickets defined after Phase 3 spec is co-signed.*

---

> **Archived DONE items**: See [DELIVERY_SCHEDULE_ARCHIVE.md](DELIVERY_SCHEDULE_ARCHIVE.md)
