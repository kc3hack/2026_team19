from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.analysis import (
    ReferDictionaryEntry,
    SentenceVectorizeResponse,
    VectorizeResponse,
)


class PipelineTiming(BaseModel):
    processed_ms: int = Field(ge=0, description="サーバー側処理時間（ミリ秒）")


class PipelineTranscript(BaseModel):
    partial_text: str = Field(default="", description="途中文字起こし")
    final_text: str = Field(default="", description="確定文字起こし")
    is_final: bool = Field(description="確定結果か")
    confidence: float | None = Field(default=None, description="STT信頼度（未提供時はnull）")


class PipelineAnalysis(BaseModel):
    vectorize: VectorizeResponse | None = Field(
        default=None,
        description="内容語ベクトル化結果（非確定チャンクではnull）",
    )
    sentence_vectorize: SentenceVectorizeResponse | None = Field(
        default=None,
        description="文章ベクトル化結果（非確定チャンクではnull）",
    )


class PipelineDictionary(BaseModel):
    enabled: bool = Field(description="辞書参照を実行したか")
    entries: list[ReferDictionaryEntry] = Field(default_factory=list, description="辞書参照結果")


class PipelineTranscribeAnalyzeResponse(BaseModel):
    session_id: str = Field(description="セッション識別子")
    chunk_seq: int = Field(ge=0, description="チャンク連番")
    timing: PipelineTiming
    transcript: PipelineTranscript
    analysis: PipelineAnalysis
    dictionary: PipelineDictionary
