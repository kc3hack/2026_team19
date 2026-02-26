from __future__ import annotations

import fastapi

from app.schemas.pipeline import PipelineTranscribeAnalyzeResponse
from app.services.speech_pipeline import transcribe_and_analyze_chunk

router = fastapi.APIRouter()


@router.post(
    "/transcribe-analyze",
    response_model=PipelineTranscribeAnalyzeResponse,
    summary="音声チャンクを文字起こしし、解析結果をまとめて返す",
    description=(
        "Desktop向けの統合パイプラインAPIです。"
        " 音声チャンクを受け取り、文字起こし（暫定）と解析結果を1レスポンスで返します。"
    ),
    responses={
        200: {"description": "処理成功"},
        400: {"description": "チャンク連番不正"},
        413: {"description": "音声チャンクサイズ上限超過"},
        415: {"description": "非対応フォーマット"},
        422: {"description": "入力バリデーションエラー"},
    },
)
async def transcribe_analyze(
    audio: fastapi.UploadFile = fastapi.File(..., description="音声チャンク"),
    session_id: str = fastapi.Form(..., min_length=1),
    chunk_seq: int = fastapi.Form(..., ge=0),
    is_final_chunk: bool = fastapi.Form(False),
    input_source: str = fastapi.Form("microphone"),
    audio_format: str = fastapi.Form("wav"),
    sample_rate_hz: int = fastapi.Form(16000, ge=1),
    channels: int = fastapi.Form(1, ge=1),
    language_hint: str = fastapi.Form("ja-JP"),
    include_dictionary: bool = fastapi.Form(False),
    dictionary_top_k: int = fastapi.Form(5, ge=1, le=50),
    deduplicate: bool = fastapi.Form(False),
    min_length: int = fastapi.Form(1, ge=1, le=64),
    normalize_sentence_vector: bool = fastapi.Form(True),
    text_override: str | None = fastapi.Form(
        default=None,
        description="MVP向け暫定: STT未接続時に文字起こし結果として扱うテキスト",
    ),
) -> PipelineTranscribeAnalyzeResponse:
    if input_source not in {"microphone", "system_audio"}:
        raise fastapi.HTTPException(status_code=422, detail="input_source must be microphone or system_audio")

    if audio_format not in {"wav", "pcm16", "webm_opus"}:
        raise fastapi.HTTPException(status_code=415, detail="unsupported audio format")

    normalized_session_id = session_id.strip()
    if not normalized_session_id:
        raise fastapi.HTTPException(status_code=422, detail="session_id must not be blank")

    max_bytes = 5 * 1024 * 1024
    audio_bytes = await audio.read(max_bytes + 1)
    if not audio_bytes:
        raise fastapi.HTTPException(status_code=422, detail="audio chunk is empty")
    if len(audio_bytes) > max_bytes:
        raise fastapi.HTTPException(status_code=413, detail="audio chunk too large")

    result = await transcribe_and_analyze_chunk(
        audio_bytes=audio_bytes,
        session_id=normalized_session_id,
        chunk_seq=chunk_seq,
        is_final_chunk=is_final_chunk,
        include_dictionary=include_dictionary,
        dictionary_top_k=dictionary_top_k,
        deduplicate=deduplicate,
        min_length=min_length,
        normalize_sentence_vector=normalize_sentence_vector,
        text_override=text_override,
    )

    # 現時点のMVPではSTT実装に直結しないフィールドも受け付ける。
    # 将来の実STT差し替え時にそのまま利用できるよう、ここではバリデーションのみ行う。
    _ = (sample_rate_hz, channels, language_hint)

    return PipelineTranscribeAnalyzeResponse(**result)
