from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

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


class PipelineAnalyzeTextRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128, description="セッション識別子")
    source: Literal["microphone", "system_audio"] = Field(description="入力ソース")
    utterance_id: str = Field(min_length=1, max_length=128, description="発話識別子")
    seq: int = Field(ge=0, description="source単位の連番")
    text: str = Field(min_length=1, max_length=20000, description="解析対象テキスト")
    is_final: bool = Field(description="確定発話か")
    confidence: float | None = Field(default=None, ge=0, le=1, description="認識信頼度")
    language: str = Field(default="ja-JP", description="言語タグ")
    start_ms: int = Field(ge=0, description="発話開始時刻（ms）")
    end_ms: int = Field(ge=0, description="発話終了時刻（ms）")
    include_dictionary: bool = Field(default=True, description="辞書参照を実行するか")
    dictionary_top_k: int = Field(default=5, ge=1, le=50, description="辞書参照上位件数")
    deduplicate: bool = Field(default=False, description="内容語を重複排除するか")
    min_length: int = Field(default=1, ge=1, le=64, description="内容語最小長")
    normalize_sentence_vector: bool = Field(default=True, description="文ベクトルを正規化するか")
    metadata: dict[str, Any] | None = Field(default=None, description="付随メタデータ")

    @model_validator(mode="after")
    def validate_constraints(self) -> "PipelineAnalyzeTextRequest":
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")
        if not self.is_final and self.include_dictionary:
            raise ValueError("include_dictionary must be false when is_final is false")
        return self


class PipelineAnalyzeTextResponse(BaseModel):
    session_id: str = Field(description="セッション識別子")
    source: Literal["microphone", "system_audio"] = Field(description="入力ソース")
    utterance_id: str = Field(description="発話識別子")
    seq: int = Field(ge=0, description="source単位の連番")
    text: str = Field(description="解析対象テキスト")
    is_final: bool = Field(description="確定発話か")
    confidence: float | None = Field(default=None, description="認識信頼度")
    language: str = Field(description="言語タグ")
    start_ms: int = Field(ge=0, description="発話開始時刻（ms）")
    end_ms: int = Field(ge=0, description="発話終了時刻（ms）")
    timing: PipelineTiming
    analysis: PipelineAnalysis
    dictionary: PipelineDictionary
