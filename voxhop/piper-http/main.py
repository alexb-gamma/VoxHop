"""
VoxHop — Piper TTS HTTP Wrapper (P1-03: Multi-Voice LRU Pool)

FastAPI service wrapping the Piper ONNX TTS CLI.

Endpoints:
  POST /tts        Body: { "text": "...", "voice": "..." (optional) }
  POST /synthesise Alias for /tts (additive — M-03: /tts is NEVER removed)
  GET  /health     Returns pool status

M-03: /tts endpoint MUST NOT be renamed or removed.
M-04: asyncio.Lock covers full lookup→eviction→spawn→register. Synthesis outside lock.
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional
from collections import OrderedDict
import subprocess
import asyncio
import logging
import os
import select
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("piper-http")

app = FastAPI(title="VoxHop Piper TTS Wrapper")

# ─── Configuration ─────────────────────────────────────────────────────────────

PIPER_BIN = os.environ.get("PIPER_BIN", "piper")
PIPER_MODELS_DIR = os.environ.get("PIPER_MODELS_DIR", "/opt/voxhop/models")
DEFAULT_VOICE = "en_GB-alan-medium"
POOL_MAX = 2
SYNTHESIS_TIMEOUT = 5.0  # seconds

# ─── LRU Subprocess Pool (M-04) ──────────────────────────────────────────────

# Pool: OrderedDict[voice_name → Popen handle], max POOL_MAX entries.
# Most-recently-used voice is at the END; LRU (for eviction) is at the START.
_pool: OrderedDict[str, subprocess.Popen] = OrderedDict()
_pool_lock = asyncio.Lock()


class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = None  # M-03: additive param; absent → DEFAULT_VOICE


def _spawn_piper(voice: str) -> subprocess.Popen:
    """Spawn a persistent Piper subprocess for the given voice."""
    model_path = os.path.join(PIPER_MODELS_DIR, f"{voice}.onnx")
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Piper model not found: {model_path}")

    logger.info(f"[piper-pool] Spawning process voice={voice} model={model_path}")
    proc = subprocess.Popen(
        [
            PIPER_BIN,
            "--model", model_path,
            "--output-raw",
            "--sentence-silence", "0.0",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    logger.info(f"[piper-pool] Spawned PID={proc.pid} voice={voice}")
    return proc


async def get_or_spawn(voice: str) -> subprocess.Popen:
    """
    Return a live Piper subprocess for the requested voice.

    M-04: asyncio.Lock covers the FULL lookup → eviction → spawn → register cycle.
    Synthesis runs OUTSIDE the lock.
    """
    async with _pool_lock:
        # (1) Check if voice already in pool
        if voice in _pool:
            existing = _pool[voice]
            if existing.poll() is None:
                # Process alive — move to MRU end and return
                _pool.move_to_end(voice)
                logger.debug(f"[piper-pool] Cache hit voice={voice} PID={existing.pid}")
                return existing
            else:
                # Process died — remove stale entry, fall through to spawn
                logger.warning(f"[piper-pool] Stale process for voice={voice} — removing from pool")
                del _pool[voice]

        # (2) Evict LRU if pool is at capacity
        if len(_pool) >= POOL_MAX:
            lru_voice, lru_proc = next(iter(_pool.items()))
            del _pool[lru_voice]
            try:
                lru_proc.terminate()
                lru_proc.wait(timeout=2.0)
            except Exception:
                lru_proc.kill()
            logger.info(f"[piper-pool] Evicted LRU voice={lru_voice}")

        # (3) Spawn new process
        try:
            proc = _spawn_piper(voice)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to spawn Piper for voice={voice}: {exc}")

        # (4) Register in pool (lock still held — M-04)
        _pool[voice] = proc
        logger.info(f"[piper-pool] Pool size={len(_pool)} voices={list(_pool.keys())}")
        return proc
        # Lock released here — synthesis happens OUTSIDE the lock


def _synthesise_sync(proc: subprocess.Popen, text: str) -> bytes:
    """
    Run synthesis on a persistent Piper subprocess.

    Writes text to stdin (keeping the process alive) and reads PCM from stdout
    using select() with a 100 ms silence-detection heuristic. The process stays
    alive in the pool after synthesis completes so the next request for the same
    voice can skip the spawn overhead.

    Raises RuntimeError on timeout or empty output.
    """
    text_bytes = (text.strip() + "\n").encode("utf-8")

    # Write to stdin — do NOT close (process must stay alive for pool reuse)
    proc.stdin.write(text_bytes)
    proc.stdin.flush()

    # Read PCM from stdout until 100 ms of silence after getting initial data
    chunks: list[bytes] = []
    deadline = time.monotonic() + SYNTHESIS_TIMEOUT
    got_data = False

    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        timeout = min(0.1, max(0.0, remaining))

        try:
            ready, _, _ = select.select([proc.stdout], [], [], timeout)
        except (ValueError, OSError):
            break  # stdout closed — process died

        if ready:
            try:
                chunk = os.read(proc.stdout.fileno(), 65536)
            except OSError:
                break
            if chunk:
                chunks.append(chunk)
                got_data = True
            else:
                break  # EOF — process exited
        elif got_data:
            # 100 ms silence after having received data → synthesis complete
            break

    if not got_data:
        raise RuntimeError(f"Piper synthesis timed out after {SYNTHESIS_TIMEOUT}s (no audio received)")

    return b"".join(chunks)


def _remove_dead_process(proc: subprocess.Popen) -> None:
    """Remove a dead process from the pool (called after synthesis or on error)."""
    to_remove = [v for v, p in list(_pool.items()) if p is proc]
    for v in to_remove:
        del _pool[v]
        logger.warning(f"[piper-pool] Removed dead process for voice={v}")


# ─── Startup ──────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    """Pre-warm the default voice on startup."""
    logger.info(f"[piper-pool] Pre-warming default voice={DEFAULT_VOICE}")
    try:
        await get_or_spawn(DEFAULT_VOICE)
        logger.info("[piper-pool] Default voice pre-warmed. Piper HTTP wrapper ready.")
    except Exception as e:
        logger.warning(f"[piper-pool] Pre-warm failed (non-fatal): {e}")


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/tts")
async def tts(request: TTSRequest):
    """
    Synthesise text to speech using Piper ONNX.

    M-03: This endpoint MUST NOT be renamed or removed.
    M-04: get_or_spawn() holds the lock; synthesis runs outside the lock.
    Returns raw 24kHz S16LE PCM binary data.
    """
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")

    voice = request.voice or DEFAULT_VOICE
    proc = await get_or_spawn(voice)  # lock acquired and released inside

    # Synthesis runs OUTSIDE the lock (M-04)
    try:
        loop = asyncio.get_event_loop()
        pcm_data = await loop.run_in_executor(
            None,
            _synthesise_sync,
            proc,
            request.text.strip(),
        )
    except Exception as e:
        logger.error(f"[piper-pool] Synthesis failed voice={voice}: {e}")
        # Check if process died during synthesis
        if proc.poll() is not None:
            async with _pool_lock:
                _remove_dead_process(proc)
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {str(e)}")

    # Post-synthesis dead-process check (M-04)
    if proc.poll() is not None:
        async with _pool_lock:
            _remove_dead_process(proc)

    if not pcm_data:
        raise HTTPException(status_code=500, detail="Piper returned empty audio")

    return Response(
        content=pcm_data,
        media_type="audio/L16; rate=24000",
        headers={"Content-Length": str(len(pcm_data))},
    )


@app.post("/synthesise")
async def synthesise_alias(request: TTSRequest):
    """
    Alias for POST /tts — additive endpoint (M-03: /tts is never removed).
    Phase 2 Counterparty pipeline may prefer /synthesise; both are supported.
    """
    return await tts(request)


@app.get("/health")
async def health():
    """Health check — returns pool status."""
    pool_info = {v: p.pid for v, p in _pool.items() if p.poll() is None}
    return {
        "status": "ok",
        "pool_size": len(pool_info),
        "pool_voices": pool_info,
    }
