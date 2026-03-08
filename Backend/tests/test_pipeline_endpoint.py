from fastapi.testclient import TestClient

from main import app


client = TestClient(app)


def _post_pipeline(
    *,
    session_id: str,
    chunk_seq: int,
    is_final_chunk: bool,
    text_override: str | None,
    audio_format: str = "wav",
    include_dictionary: bool = False,
    test_client: TestClient = client,
    audio_bytes: bytes = b"dummy-audio-bytes",
) -> dict:
    data = {
        "session_id": session_id,
        "chunk_seq": str(chunk_seq),
        "is_final_chunk": str(is_final_chunk).lower(),
        "input_source": "microphone",
        "audio_format": audio_format,
        "sample_rate_hz": "16000",
        "channels": "1",
        "language_hint": "ja-JP",
        "include_dictionary": str(include_dictionary).lower(),
        "dictionary_top_k": "5",
        "deduplicate": "false",
        "min_length": "1",
        "normalize_sentence_vector": "true",
    }
    if text_override is not None:
        data["text_override"] = text_override

    files = {"audio": ("chunk.wav", audio_bytes, "audio/wav")}
    res = test_client.post("/pipeline/transcribe-analyze", data=data, files=files)
    try:
        body = res.json()
    except ValueError:
        body = {"detail": res.text}
    return {"status": res.status_code, "body": body}


def _post_analyze_text(
    *,
    session_id: str,
    source: str = "microphone",
    utterance_id: str = "utt_001",
    seq: int = 0,
    text: str = "本日の議題はAPI設計です。",
    is_final: bool = True,
    include_dictionary: bool = False,
    start_ms: int = 1000,
    end_ms: int = 2000,
    test_client: TestClient = client,
) -> dict:
    payload = {
        "session_id": session_id,
        "source": source,
        "utterance_id": utterance_id,
        "seq": seq,
        "text": text,
        "is_final": is_final,
        "confidence": 0.95,
        "language": "ja-JP",
        "start_ms": start_ms,
        "end_ms": end_ms,
        "include_dictionary": include_dictionary,
        "dictionary_top_k": 5,
        "deduplicate": False,
        "min_length": 1,
        "normalize_sentence_vector": True,
        "metadata": {"agent_version": "0.1.0"},
    }
    res = test_client.post("/pipeline/analyze-text", json=payload)
    try:
        body = res.json()
    except ValueError:
        body = {"detail": res.text}
    return {"status": res.status_code, "body": body}


def test_pipeline_partial_chunk_skips_analysis() -> None:
    result = _post_pipeline(
        session_id="test_session_partial_001",
        chunk_seq=0,
        is_final_chunk=False,
        text_override="今日は",
    )

    assert result["status"] == 200
    body = result["body"]
    assert body["transcript"]["partial_text"] == "今日は"
    assert body["transcript"]["is_final"] is False
    assert body["analysis"]["vectorize"] is None
    assert body["analysis"]["sentence_vectorize"] is None
    assert body["dictionary"]["enabled"] is False
    assert body["dictionary"]["entries"] == []


def test_pipeline_final_chunk_returns_analysis() -> None:
    result = _post_pipeline(
        session_id="test_session_final_001",
        chunk_seq=0,
        is_final_chunk=True,
        text_override="本日の議題はAPI設計です。",
    )

    assert result["status"] == 200
    body = result["body"]
    assert body["transcript"]["final_text"] == "本日の議題はAPI設計です。"
    assert body["transcript"]["is_final"] is True
    assert body["analysis"]["vectorize"] is not None
    assert body["analysis"]["sentence_vectorize"] is not None
    assert body["analysis"]["vectorize"]["meta"]["vector_dim"] > 0
    assert body["analysis"]["sentence_vectorize"]["meta"]["vector_dim"] > 0


def test_pipeline_rejects_invalid_chunk_sequence() -> None:
    first = _post_pipeline(
        session_id="test_session_seq_001",
        chunk_seq=0,
        is_final_chunk=False,
        text_override="最初のチャンク",
    )
    assert first["status"] == 200

    second = _post_pipeline(
        session_id="test_session_seq_001",
        chunk_seq=2,
        is_final_chunk=False,
        text_override="連番が飛んだチャンク",
    )
    assert second["status"] == 400
    assert second["body"]["detail"] == "invalid chunk sequence"


def test_pipeline_rejects_unsupported_audio_format() -> None:
    result = _post_pipeline(
        session_id="test_session_format_001",
        chunk_seq=0,
        is_final_chunk=False,
        text_override="text",
        audio_format="mp3",
    )
    assert result["status"] == 415
    assert result["body"]["detail"] == "unsupported audio format"


def test_pipeline_rejects_too_large_audio_chunk() -> None:
    result = _post_pipeline(
        session_id="test_session_too_large_001",
        chunk_seq=0,
        is_final_chunk=False,
        text_override="text",
        audio_bytes=b"x" * (5 * 1024 * 1024 + 1),
    )
    assert result["status"] == 413
    assert result["body"]["detail"] == "audio chunk too large"


def test_pipeline_rejects_blank_session_id() -> None:
    result = _post_pipeline(
        session_id="   ",
        chunk_seq=0,
        is_final_chunk=False,
        text_override="text",
    )
    assert result["status"] == 422
    assert result["body"]["detail"] == "session_id must not be blank"


def test_pipeline_rejects_duplicate_final_chunk() -> None:
    first = _post_pipeline(
        session_id="test_session_final_dup_001",
        chunk_seq=0,
        is_final_chunk=True,
        text_override="最終チャンクです。",
    )
    assert first["status"] == 200

    second = _post_pipeline(
        session_id="test_session_final_dup_001",
        chunk_seq=0,
        is_final_chunk=True,
        text_override="最終チャンクです。",
    )
    assert second["status"] == 400
    assert second["body"]["detail"] == "session already finalized"


def test_pipeline_allows_retry_after_processing_failure(monkeypatch) -> None:
    async def _raise_dictionary_error(_: str):
        raise RuntimeError("dictionary temporarily unavailable")

    monkeypatch.setattr("app.services.speech_pipeline.refer_dictionary", _raise_dictionary_error)
    non_raising_client = TestClient(app, raise_server_exceptions=False)

    first = _post_pipeline(
        session_id="test_session_retry_001",
        chunk_seq=0,
        is_final_chunk=True,
        text_override="人工知能の要点を共有します。",
        include_dictionary=True,
        test_client=non_raising_client,
    )
    assert first["status"] == 500

    second = _post_pipeline(
        session_id="test_session_retry_001",
        chunk_seq=0,
        is_final_chunk=True,
        text_override="人工知能の要点を共有します。",
        include_dictionary=False,
    )
    assert second["status"] == 200


def test_analyze_text_final_returns_analysis() -> None:
    result = _post_analyze_text(
        session_id="test_analyze_text_final_001",
        is_final=True,
    )

    assert result["status"] == 200
    body = result["body"]
    assert body["session_id"] == "test_analyze_text_final_001"
    assert body["analysis"]["vectorize"] is not None
    assert body["analysis"]["sentence_vectorize"] is not None
    assert body["dictionary"]["enabled"] is False


def test_analyze_text_partial_skips_analysis() -> None:
    result = _post_analyze_text(
        session_id="test_analyze_text_partial_001",
        is_final=False,
        include_dictionary=False,
    )

    assert result["status"] == 200
    body = result["body"]
    assert body["is_final"] is False
    assert body["analysis"]["vectorize"] is None
    assert body["analysis"]["sentence_vectorize"] is None
    assert body["dictionary"]["enabled"] is False
    assert body["dictionary"]["entries"] == []


def test_analyze_text_rejects_dictionary_on_partial() -> None:
    result = _post_analyze_text(
        session_id="test_analyze_text_invalid_partial_001",
        is_final=False,
        include_dictionary=True,
    )

    assert result["status"] == 422
    assert "include_dictionary must be false when is_final is false" in str(result["body"])


def test_analyze_text_rejects_invalid_timestamp_range() -> None:
    result = _post_analyze_text(
        session_id="test_analyze_text_invalid_timestamp_001",
        start_ms=3000,
        end_ms=2000,
    )

    assert result["status"] == 422
    assert "end_ms must be greater than or equal to start_ms" in str(result["body"])
