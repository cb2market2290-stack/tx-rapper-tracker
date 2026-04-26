#!/usr/bin/env python3
"""scripts/extract-features.py

Phase 2c worker: drains track_extraction_jobs, downloads YouTube audio with
yt-dlp, runs librosa to compute per-track audio features, and writes the
results into track_features.

Why a Python worker? The Node side has no good librosa equivalent, and
shelling out to a one-shot Python script per job is heavier than just
running this as a long-lived (or cron-driven) process. Lives next to the
JS scripts so the launchd agent that runs the daily snapshot can launch
this too on a different schedule.

Job lifecycle (FSM):

    pending  -> running  -> done
                        \\-> failed   (attempts < 5; eligible for retry)
                        \\-> skipped  (e.g. video unavailable; never retry)

State transitions are atomic (UPDATE ... RETURNING) so two workers running
at once can't both claim the same row.

Idempotency: success path UPSERTs into track_features on
(artist_id, video_id), and the job row is moved to 'done'. Failure path
captures the error message and increments attempts. Re-running the worker
after fixing the root cause picks up failed-but-eligible rows via the same
claim query (status='pending' OR (status='failed' AND attempts<5)).

Usage:
    # Drain one job and exit (useful for the smoke test)
    python3 scripts/extract-features.py --once
    # Drain up to N jobs and exit
    python3 scripts/extract-features.py --max 50
    # Run a specific job by id (debugging)
    python3 scripts/extract-features.py --job-id 42
    # Show the queue without running
    python3 scripts/extract-features.py --status

Env:
    DATABASE_URL   — same connection string the Node side uses
    YT_DLP_BIN     — path to yt-dlp (default: 'yt-dlp' in $PATH)
    FFMPEG_BIN     — path to ffmpeg (default: 'ffmpeg' in $PATH)
    LIBROSA_SR     — target sample rate (default: 22050 — librosa default)
    EXTRACT_TMP_DIR — temp scratch dir (default: tempfile.gettempdir())
    EXTRACT_MAX_ATTEMPTS — give up after this many failures (default: 5)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional, Tuple

# psycopg v3 (modern). v2 also works with `psycopg2` as the import name —
# we don't ship code paths for both because the Mac dev box installs v3
# alongside librosa cleanly via pip. Imported lazily so --help works on a
# bare Python install (the actual run path errors out clearly below).
psycopg = None  # type: ignore
dict_row = None  # type: ignore


def _require_psycopg() -> None:
    global psycopg, dict_row
    if psycopg is not None:
        return
    try:
        import psycopg as _psycopg  # type: ignore
        from psycopg.rows import dict_row as _dict_row  # type: ignore
    except ImportError as e:  # pragma: no cover
        print(
            f"FATAL: psycopg v3 not installed ({e}). pip install 'psycopg[binary]'",
            file=sys.stderr,
        )
        sys.exit(2)
    psycopg = _psycopg
    dict_row = _dict_row

# librosa is heavy (~300MB with deps). Import lazily so --status / --help
# don't pay the cost.
def _load_librosa():
    import librosa  # type: ignore
    import numpy as np  # type: ignore
    return librosa, np


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

DATABASE_URL = os.environ.get("DATABASE_URL")
YT_DLP_BIN = os.environ.get("YT_DLP_BIN", "yt-dlp")
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
LIBROSA_SR = int(os.environ.get("LIBROSA_SR", "22050"))
EXTRACT_TMP_DIR = Path(os.environ.get("EXTRACT_TMP_DIR", tempfile.gettempdir()))
MAX_ATTEMPTS = int(os.environ.get("EXTRACT_MAX_ATTEMPTS", "5"))

# Pitch profiles for key estimation (Krumhansl-Schmuckler). Static so we
# don't recompute per-track. Index: 0=C, 1=C#, ..., 11=B.
MAJOR_PROFILE = (
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
    2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
)
MINOR_PROFILE = (
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
    2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
)
PITCH_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

# Camelot wheel: maps (key_index, mode) → label. mode 0=minor (A side),
# 1=major (B side). Numbered 1..12 around the wheel.
CAMELOT = {
    # majors
    (0, 1): "8B", (1, 1): "3B", (2, 1): "10B", (3, 1): "5B",
    (4, 1): "12B", (5, 1): "7B", (6, 1): "2B", (7, 1): "9B",
    (8, 1): "4B", (9, 1): "11B", (10, 1): "6B", (11, 1): "1B",
    # minors
    (0, 0): "5A", (1, 0): "12A", (2, 0): "7A", (3, 0): "2A",
    (4, 0): "9A", (5, 0): "4A", (6, 0): "11A", (7, 0): "6A",
    (8, 0): "1A", (9, 0): "8A", (10, 0): "3A", (11, 0): "10A",
}

ANALYZER_VERSION_FALLBACK = "librosa-unknown"


# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("extract-features")


# ---------------------------------------------------------------------------
# data model
# ---------------------------------------------------------------------------

@dataclass
class Job:
    id: int
    artist_id: str
    video_id: str
    title: Optional[str]
    duration_sec: Optional[int]
    attempts: int


@dataclass
class Features:
    duration_sec: int
    tempo_bpm: float
    key_index: int
    mode: int  # 0 minor, 1 major
    camelot: str
    energy: float                     # 0..1, scaled mean RMS
    rms_db: float                     # mean RMS in dBFS
    loudness_lufs: Optional[float]    # None unless we have a real LUFS metering lib
    spectral_centroid: float          # Hz (mean)
    spectral_rolloff: float           # Hz (mean of 85% rolloff)
    zero_crossing_rate: float         # mean
    extras: dict[str, Any]
    analyzer_version: str


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

@contextmanager
def db_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    _require_psycopg()
    conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    try:
        yield conn
    finally:
        conn.close()


def claim_one_job(conn, job_id: Optional[int] = None) -> Optional[Job]:
    """Atomically move one eligible row to status='running' and return it.

    Eligible = status='pending' OR (status='failed' AND attempts<MAX_ATTEMPTS).
    Re-claims its own row when --job-id is set, regardless of state, so the
    operator can re-run a specific job for debugging.
    """
    with conn.cursor() as cur:
        if job_id is not None:
            cur.execute(
                """
                UPDATE track_extraction_jobs
                   SET status = 'running',
                       attempts = attempts + 1,
                       claimed_at = now()
                 WHERE id = %s
             RETURNING id, artist_id, video_id, title, duration_sec, attempts
                """,
                (job_id,),
            )
        else:
            cur.execute(
                """
                UPDATE track_extraction_jobs
                   SET status = 'running',
                       attempts = attempts + 1,
                       claimed_at = now()
                 WHERE id = (
                   SELECT id
                     FROM track_extraction_jobs
                    WHERE status = 'pending'
                       OR (status = 'failed' AND attempts < %s)
                    ORDER BY enqueued_at ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                 )
             RETURNING id, artist_id, video_id, title, duration_sec, attempts
                """,
                (MAX_ATTEMPTS,),
            )
        row = cur.fetchone()
        conn.commit()
        if not row:
            return None
        return Job(**row)


def mark_done(conn, job: Job, features: Features) -> None:
    """Upsert features and flip the job row to 'done' atomically."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO track_features (
                artist_id, video_id, title, duration_sec,
                tempo_bpm, key_index, mode, camelot,
                energy, rms_db, loudness_lufs,
                spectral_centroid, spectral_rolloff, zero_crossing_rate,
                extras, source, analyzer_version
            ) VALUES (
                %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s::jsonb, %s, %s
            )
            ON CONFLICT (artist_id, video_id) DO UPDATE SET
                title             = EXCLUDED.title,
                duration_sec      = EXCLUDED.duration_sec,
                tempo_bpm         = EXCLUDED.tempo_bpm,
                key_index         = EXCLUDED.key_index,
                mode              = EXCLUDED.mode,
                camelot           = EXCLUDED.camelot,
                energy            = EXCLUDED.energy,
                rms_db            = EXCLUDED.rms_db,
                loudness_lufs     = EXCLUDED.loudness_lufs,
                spectral_centroid = EXCLUDED.spectral_centroid,
                spectral_rolloff  = EXCLUDED.spectral_rolloff,
                zero_crossing_rate = EXCLUDED.zero_crossing_rate,
                extras            = EXCLUDED.extras,
                source            = EXCLUDED.source,
                analyzer_version  = EXCLUDED.analyzer_version,
                extracted_at      = now()
            """,
            (
                job.artist_id, job.video_id, job.title, features.duration_sec,
                features.tempo_bpm, features.key_index, features.mode, features.camelot,
                features.energy, features.rms_db, features.loudness_lufs,
                features.spectral_centroid, features.spectral_rolloff, features.zero_crossing_rate,
                json.dumps(features.extras), 'youtube_audio', features.analyzer_version,
            ),
        )
        cur.execute(
            """
            UPDATE track_extraction_jobs
               SET status = 'done',
                   last_error = NULL,
                   finished_at = now()
             WHERE id = %s
            """,
            (job.id,),
        )
        conn.commit()


def mark_failed(conn, job: Job, err: str, *, terminal: bool = False) -> None:
    """Move job to 'failed' (eligible for retry) or 'skipped' (terminal).

    `terminal` is set when the failure can't be fixed by retrying — the
    typical case is a permanently unavailable video (DRM, age-restricted
    without auth, removed). Those go to 'skipped' so the queue stops
    working on them.
    """
    status = "skipped" if terminal else "failed"
    # Trim error to keep the row bounded; full traceback is in the worker log.
    err_short = (err or "").strip()[:1000]
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE track_extraction_jobs
               SET status = %s,
                   last_error = %s,
                   finished_at = now()
             WHERE id = %s
            """,
            (status, err_short, job.id),
        )
        conn.commit()


def queue_status(conn) -> dict[str, int]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT status, COUNT(*) AS n
              FROM track_extraction_jobs
             GROUP BY status
            """
        )
        return {row["status"]: row["n"] for row in cur.fetchall()}


# ---------------------------------------------------------------------------
# audio download
# ---------------------------------------------------------------------------

class TerminalDownloadError(RuntimeError):
    """Raised for failures that retrying won't fix (e.g. video removed)."""


def download_audio(video_id: str, dest: Path) -> Path:
    """Download YouTube audio for video_id into dest dir as <video_id>.m4a.

    Returns the path to the downloaded file. Raises TerminalDownloadError
    for permanent failures (private/removed/age-restricted) so the caller
    can mark the job 'skipped' instead of retrying.
    """
    out_template = str(dest / f"{video_id}.%(ext)s")
    cmd = [
        YT_DLP_BIN,
        f"https://www.youtube.com/watch?v={video_id}",
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "-o", out_template,
        "--no-progress",
        "--no-warnings",
        "--no-playlist",
        # We don't need post-processing — librosa loads m4a/aac fine via
        # audioread+ffmpeg fallback. Skipping ffmpeg post means much less
        # disk churn.
        "--no-post-overwrites",
    ]
    log.info("yt-dlp downloading %s", video_id)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        # yt-dlp prints stable-ish strings for the unfixable cases.
        terminal_signals = (
            "Video unavailable",
            "Private video",
            "This video is age-restricted",
            "has been removed",
            "Sign in to confirm your age",
            "deleted by the uploader",
        )
        terminal = any(s in stderr for s in terminal_signals)
        msg = stderr.splitlines()[-1] if stderr else f"yt-dlp exit {proc.returncode}"
        raise TerminalDownloadError(msg) if terminal else RuntimeError(msg)
    # Find the file we wrote — extension can vary if bestaudio fallback
    # picked a non-m4a stream.
    matches = list(dest.glob(f"{video_id}.*"))
    if not matches:
        raise RuntimeError("yt-dlp claimed success but no file landed")
    return matches[0]


# ---------------------------------------------------------------------------
# librosa analysis
# ---------------------------------------------------------------------------

def _camelot_label(key_index: int, mode_int: int) -> str:
    return CAMELOT.get((key_index, mode_int), f"{PITCH_NAMES[key_index]}{'maj' if mode_int else 'min'}")


def _estimate_key_mode(chroma_mean) -> Tuple[int, int]:
    """Krumhansl-Schmuckler key/mode estimation.

    chroma_mean is a length-12 ndarray of average chroma energy. We
    correlate it against rotated major/minor profiles and return the
    (key_index, mode) tuple with the highest Pearson correlation.
    """
    librosa, np = _load_librosa()
    chroma = np.asarray(chroma_mean, dtype=float)
    # Center both vectors so Pearson reduces to dot / (||a|| ||b||).
    chroma = chroma - chroma.mean()
    cnorm = np.linalg.norm(chroma)
    if cnorm < 1e-12:
        return 0, 1  # silent / numerically empty → fall back to C major
    chroma = chroma / cnorm

    best_score = -2.0
    best = (0, 1)
    for mode_int, profile in ((1, MAJOR_PROFILE), (0, MINOR_PROFILE)):
        prof = np.array(profile, dtype=float)
        prof = prof - prof.mean()
        prof = prof / np.linalg.norm(prof)
        for key_index in range(12):
            rotated = np.roll(prof, key_index)
            score = float(np.dot(chroma, rotated))
            if score > best_score:
                best_score = score
                best = (key_index, mode_int)
    return best


def analyze(audio_path: Path) -> Features:
    """Run librosa over an audio file and return a Features dataclass."""
    librosa, np = _load_librosa()
    log.info("librosa loading %s", audio_path.name)
    y, sr = librosa.load(str(audio_path), sr=LIBROSA_SR, mono=True)

    duration = float(librosa.get_duration(y=y, sr=sr))
    if duration < 1.0:
        raise RuntimeError(f"audio too short ({duration:.2f}s)")

    # Tempo. The newer librosa.feature.tempo lives at librosa.feature.rhythm.tempo
    # in 0.10+ but is also re-exported. Fall back gracefully.
    tempo = None
    try:
        tempo_arr = librosa.feature.tempo(y=y, sr=sr)  # type: ignore[attr-defined]
    except (AttributeError, TypeError):
        tempo_arr = librosa.beat.tempo(y=y, sr=sr)  # type: ignore[attr-defined]
    if tempo_arr is not None and len(tempo_arr) > 0:
        tempo = float(tempo_arr[0])

    # Chroma → key + mode.
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    key_index, mode_int = _estimate_key_mode(chroma_mean)

    # Energy: mean of per-frame RMS, scaled to 0..1 by clamping the dB
    # range. -60 dBFS = 0, 0 dBFS = 1; rap typically lands around -16 dBFS
    # mastered, so most tracks score 0.6-0.85.
    rms = librosa.feature.rms(y=y)[0]
    rms_mean = float(rms.mean())
    rms_db = 20.0 * float(np.log10(max(rms_mean, 1e-9)))
    energy = max(0.0, min(1.0, (rms_db + 60.0) / 60.0))

    # Spectral signals.
    spectral_centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    spectral_rolloff = float(librosa.feature.spectral_rolloff(y=y, sr=sr).mean())
    zcr = float(librosa.feature.zero_crossing_rate(y=y).mean())

    # Forward-compat extras: store the chroma vector (small) so future
    # downstream uses can re-derive different keys without re-loading audio.
    extras = {
        "chroma_mean": [round(float(x), 6) for x in chroma_mean.tolist()],
    }

    return Features(
        duration_sec=int(duration),
        tempo_bpm=round(tempo or 0.0, 2),
        key_index=int(key_index),
        mode=int(mode_int),
        camelot=_camelot_label(int(key_index), int(mode_int)),
        energy=round(energy, 4),
        rms_db=round(rms_db, 2),
        loudness_lufs=None,
        spectral_centroid=round(spectral_centroid, 2),
        spectral_rolloff=round(spectral_rolloff, 2),
        zero_crossing_rate=round(zcr, 4),
        extras=extras,
        analyzer_version=f"librosa-{getattr(librosa, '__version__', 'unknown')}",
    )


# ---------------------------------------------------------------------------
# main loop
# ---------------------------------------------------------------------------

def process_one(conn, job: Job) -> bool:
    """Process a single claimed job. Returns True on success, False on failure."""
    log.info(
        "claimed job %s (artist=%s video=%s attempt=%s)",
        job.id, job.artist_id, job.video_id, job.attempts,
    )
    workdir = Path(tempfile.mkdtemp(prefix=f"extract-{job.video_id}-", dir=EXTRACT_TMP_DIR))
    try:
        try:
            audio = download_audio(job.video_id, workdir)
        except TerminalDownloadError as e:
            log.warning("job %s terminal download failure: %s", job.id, e)
            mark_failed(conn, job, str(e), terminal=True)
            return False
        try:
            features = analyze(audio)
        except Exception as e:
            log.warning("job %s analyze failure: %s\n%s", job.id, e, traceback.format_exc())
            mark_failed(conn, job, f"analyze: {e}")
            return False
        mark_done(conn, job, features)
        log.info(
            "job %s done: tempo=%.1f camelot=%s energy=%.2f",
            job.id, features.tempo_bpm, features.camelot, features.energy,
        )
        return True
    except Exception as e:
        log.error("job %s unexpected: %s\n%s", job.id, e, traceback.format_exc())
        mark_failed(conn, job, f"worker: {e}")
        return False
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def drain(conn, *, max_jobs: Optional[int] = None, job_id: Optional[int] = None) -> Tuple[int, int]:
    """Drain the queue. Returns (succeeded, failed). max_jobs caps total."""
    succeeded = failed = 0
    while True:
        if max_jobs is not None and (succeeded + failed) >= max_jobs:
            break
        job = claim_one_job(conn, job_id=job_id)
        if not job:
            break
        if process_one(conn, job):
            succeeded += 1
        else:
            failed += 1
        if job_id is not None:
            # --job-id mode does exactly one row.
            break
    return succeeded, failed


def main() -> int:
    parser = argparse.ArgumentParser(description="Drain track_extraction_jobs.")
    parser.add_argument("--once", action="store_true", help="process at most one job and exit")
    parser.add_argument("--max", type=int, default=None, help="upper bound on jobs to process")
    parser.add_argument("--job-id", type=int, default=None, help="process this job id only")
    parser.add_argument("--status", action="store_true", help="print queue status and exit")
    args = parser.parse_args()

    if not DATABASE_URL:
        print("DATABASE_URL not set; aborting", file=sys.stderr)
        return 2

    with db_conn() as conn:
        if args.status:
            counts = queue_status(conn)
            print(json.dumps(counts, indent=2))
            return 0
        max_jobs = 1 if args.once else args.max
        succeeded, failed = drain(conn, max_jobs=max_jobs, job_id=args.job_id)
        log.info("drain finished: succeeded=%d failed=%d", succeeded, failed)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
