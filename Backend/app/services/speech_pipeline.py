from __future__ import annotations

import asyncio
from dataclasses import dataclass
from threading import Lock
import time

import fastapi

from app.services.refer_dictionary import refer_dictionary
from app.services.text_analysis import vectorize_content_tokens, vectorize_sentence


@dataclass
class _SpeechResult:
    partial_text: str
    final_text: str
    is_final: bool
    confidence: float | None
    source: str


@dataclass
class _SessionState:
    last_seq: int
    closed: bool
    updated_at: float


# MVP段階のためプロセス内メモリでセッション順序を管理する。
# 将来的に複数インスタンス運用する場合はRedis等の外部ストアに置き換える。
_SESSION_STATES: dict[str, _SessionState] = {}
_SESSION_LOCKS: dict[str, asyncio.Lock] = {}
_SESSION_GUARD = Lock()
_NLP_LOCK = Lock()
_SESSION_ACTIVE_TTL_SECONDS = 3600.0
_SESSION_CLOSED_TTL_SECONDS = 300.0


def _lock_has_waiters(lock: asyncio.Lock) -> bool:
    waiters = getattr(lock, "_waiters", None)
    return bool(waiters) and any(not waiter.done() for waiter in waiters)


def _prune_stale_sessions_locked(now: float) -> None:
    stale_session_ids = [
        session_id
        for session_id, state in _SESSION_STATES.items()
        if (now - state.updated_at)
        >= (_SESSION_CLOSED_TTL_SECONDS if state.closed else _SESSION_ACTIVE_TTL_SECONDS)
    ]
    for session_id in stale_session_ids:
        _SESSION_STATES.pop(session_id, None)
        lock = _SESSION_LOCKS.get(session_id)
        if lock and not lock.locked() and not _lock_has_waiters(lock):
            _SESSION_LOCKS.pop(session_id, None)


def _validate_chunk_sequence(session_id: str, chunk_seq: int) -> None:
    with _SESSION_GUARD:
        _prune_stale_sessions_locked(time.monotonic())
        state = _SESSION_STATES.get(session_id)
        if state is None:
            if chunk_seq != 0:
                raise fastapi.HTTPException(
                    status_code=400,
                    detail="invalid chunk sequence: first chunk must be 0",
                )
            return

        if state.closed:
            raise fastapi.HTTPException(status_code=400, detail="session already finalized")

        if chunk_seq != state.last_seq + 1:
            raise fastapi.HTTPException(
                status_code=400,
                detail="invalid chunk sequence",
            )


def _mark_chunk_processed(session_id: str, chunk_seq: int, is_final_chunk: bool) -> None:
    with _SESSION_GUARD:
        now = time.monotonic()
        _prune_stale_sessions_locked(now)
        _SESSION_STATES[session_id] = _SessionState(
            last_seq=chunk_seq,
            closed=is_final_chunk,
            updated_at=now,
        )


def _get_session_lock(session_id: str) -> asyncio.Lock:
    with _SESSION_GUARD:
        _prune_stale_sessions_locked(time.monotonic())
        lock = _SESSION_LOCKS.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            _SESSION_LOCKS[session_id] = lock
        return lock


def _cleanup_session_lock(session_id: str, lock: asyncio.Lock) -> None:
    with _SESSION_GUARD:
        _prune_stale_sessions_locked(time.monotonic())
        existing = _SESSION_LOCKS.get(session_id)
        state = _SESSION_STATES.get(session_id)
        inactive = state is None or state.closed
        if existing is lock and inactive and not lock.locked() and not _lock_has_waiters(lock):
            _SESSION_LOCKS.pop(session_id, None)


def _analyze_final_text(
    *,
    text: str,
    deduplicate: bool,
    min_length: int,
    normalize_sentence_vector: bool,
) -> tuple[dict, dict]:
    # Sudachi/GiNZA の実装都合でスレッドセーフでない処理があるため、
    # スレッド実行しつつもNLP本体は排他で直列化する。
    with _NLP_LOCK:
        vectorize_result = vectorize_content_tokens(
            text=text,
            deduplicate=deduplicate,
            min_length=min_length,
        )
        sentence_result = vectorize_sentence(
            text=text,
            normalize=normalize_sentence_vector,
        )
    return vectorize_result, sentence_result


def _mock_transcribe(
    *,
    audio_bytes: bytes,
    is_final_chunk: bool,
    text_override: str | None,
) -> _SpeechResult:
    """暫定STT。

    `text_override` が指定されている場合はそれを文字起こし結果として返す。
    未指定時は空文字を返し、解析はスキップされる。
    """
    normalized = (text_override or "").strip()
    if normalized:
        if is_final_chunk:
            return _SpeechResult(
                partial_text="",
                final_text=normalized,
                is_final=True,
                confidence=1.0,
                source="text_override",
            )
        return _SpeechResult(
            partial_text=normalized,
            final_text="",
            is_final=False,
            confidence=1.0,
            source="text_override",
        )

    if not audio_bytes:
        raise fastapi.HTTPException(status_code=422, detail="audio chunk is empty")

    return _SpeechResult(
        partial_text="",
        final_text="",
        is_final=is_final_chunk,
        confidence=None,
        source="stub",
    )


async def transcribe_and_analyze_chunk(
    *,
    audio_bytes: bytes,
    session_id: str,
    chunk_seq: int,
    is_final_chunk: bool,
    include_dictionary: bool,
    dictionary_top_k: int,
    deduplicate: bool,
    min_length: int,
    normalize_sentence_vector: bool,
    text_override: str | None,
) -> dict:
    start = time.perf_counter()
    session_lock = _get_session_lock(session_id)

    try:
        async with session_lock:
            _validate_chunk_sequence(session_id=session_id, chunk_seq=chunk_seq)

            speech = _mock_transcribe(
                audio_bytes=audio_bytes,
                is_final_chunk=is_final_chunk,
                text_override=text_override,
            )

            target_text = speech.final_text if speech.is_final else speech.partial_text

            vectorize_result = None
            sentence_result = None
            dictionary_entries = []

            if speech.is_final and target_text:
                vectorize_result, sentence_result = await asyncio.to_thread(
                    _analyze_final_text,
                    text=target_text,
                    deduplicate=deduplicate,
                    min_length=min_length,
                    normalize_sentence_vector=normalize_sentence_vector,
                )

                if include_dictionary:
                    raw_entries = await refer_dictionary(target_text)
                    limit = max(1, min(dictionary_top_k, 50))
                    dictionary_entries = raw_entries[:limit]

            _mark_chunk_processed(session_id=session_id, chunk_seq=chunk_seq, is_final_chunk=is_final_chunk)
    finally:
        _cleanup_session_lock(session_id=session_id, lock=session_lock)

    processed_ms = int((time.perf_counter() - start) * 1000)

    return {
        "session_id": session_id,
        "chunk_seq": chunk_seq,
        "timing": {"processed_ms": max(processed_ms, 0)},
        "transcript": {
            "partial_text": speech.partial_text,
            "final_text": speech.final_text,
            "is_final": speech.is_final,
            "confidence": speech.confidence,
        },
        "analysis": {
            "vectorize": vectorize_result,
            "sentence_vectorize": sentence_result,
        },
        "dictionary": {
            "enabled": bool(include_dictionary and speech.is_final and target_text),
            "entries": dictionary_entries,
        },
    }
