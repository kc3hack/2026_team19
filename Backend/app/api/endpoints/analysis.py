import fastapi

from app.schemas.analysis import (
    ReferDictionaryRequest,
    ReferDictionaryResponse,
    ReferDictionaryEntry,
    SentenceVectorizeRequest,
    SentenceVectorizeResponse,
    TfidfBubbleScoresRequest,
    TfidfBubbleScoresResponse,
    VectorizeRequest,
    VectorizeResponse,
)
from app.services.text_analysis import (
    tfidf_bubble_scores,
    vectorize_content_tokens,
    vectorize_sentence,
)
from app.services.refer_dictionary import refer_dictionary

router = fastapi.APIRouter()


@router.post(
    "/vectorize",
    response_model=VectorizeResponse,
    summary="テキストを品詞フィルタ付きでベクトル化する",
    description=(
        "入力テキストを形態素解析し、内容語（名詞/動詞/形容詞など）を中心にベクトル化します。"
        " 既定では接続詞・助詞・助動詞・記号類を除外します。"
    ),
    response_description="ベクトル化結果（meta と tokens）",
    responses={
        200: {"description": "解析成功"},
        422: {"description": "入力バリデーションエラー（text が空など）"},
    },
)
def vectorize(
    body: VectorizeRequest = fastapi.Body(
        ...,
        examples={
            "default": {
                "summary": "既定パラメータで実行",
                "value": {
                    "text": "今日は自然言語処理を勉強して、そして結果を共有します。",
                    "deduplicate": False,
                },
            },
            "custom_filter": {
                "summary": "品詞フィルタを明示",
                "value": {
                    "text": "本日の議事録を作成します。API設計と実装方針を共有します。",
                    "include_pos": ["名詞", "動詞", "形容詞"],
                    "exclude_pos": ["接続詞", "助詞", "助動詞", "補助記号"],
                    "min_length": 2,
                    "deduplicate": True,
                },
            },
        },
    )
) -> VectorizeResponse:
    result = vectorize_content_tokens(
        text=body.text,
        include_pos=body.include_pos,
        exclude_pos=body.exclude_pos,
        min_length=body.min_length,
        deduplicate=body.deduplicate,
    )
    return VectorizeResponse(**result)


@router.post(
    "/vectorize/sentence",
    response_model=SentenceVectorizeResponse,
    summary="文章全体を1つのベクトルに変換する",
    description=(
        "入力テキストを文章単位でベクトル化します。"
        " 取得優先順は spacy doc -> spacy token平均 -> 内容語平均 -> hash です。"
    ),
    response_description="文章ベクトル化結果（meta と sentence_vector）",
    responses={
        200: {"description": "解析成功"},
        422: {"description": "入力バリデーションエラー（text が空など）"},
    },
)
def vectorize_sentence_endpoint(
    body: SentenceVectorizeRequest = fastapi.Body(
        ...,
        examples={
            "default": {
                "summary": "文章ベクトル（正規化あり）",
                "value": {
                    "text": "本日の議事録を作成します。API設計と実装方針を共有します。",
                    "normalize": True,
                },
            }
        },
    )
) -> SentenceVectorizeResponse:
    result = vectorize_sentence(text=body.text, normalize=body.normalize)
    return SentenceVectorizeResponse(**result)


@router.post(
    "/tfidf/bubble-scores",
    response_model=TfidfBubbleScoresResponse,
    summary="発話ごとのTF-IDFスコアからバブルサイズを算出する",
    description=(
        "1発話=1バブルとしてTF-IDFを算出し、"
        "上位top_k語のスコア合計を p10/p90 基準で正規化してバブルサイズに変換します。"
    ),
    response_description="発話ごとのTF-IDFバブルスコア",
    responses={
        200: {"description": "算出成功"},
        422: {"description": "入力バリデーションエラー（空配列・空白発話など）"},
    },
)
def tfidf_bubble_scores_endpoint(
    body: TfidfBubbleScoresRequest = fastapi.Body(
        ...,
        examples={
            "default": {
                "summary": "既定パラメータで算出",
                "value": {
                    "utterances": [
                        "今日はRAGの設計を詰めます。",
                        "APIのレイテンシ改善も必要です。",
                        "GPUコストの見積もりも確認しましょう。",
                    ],
                    "top_k": 3,
                    "window_size": 30,
                    "min_bubble_size": 28,
                    "max_bubble_size": 72,
                },
            }
        },
    )
) -> TfidfBubbleScoresResponse:
    result = tfidf_bubble_scores(
        utterances=body.utterances,
        top_k=body.top_k,
        window_size=body.window_size,
        min_bubble_size=body.min_bubble_size,
        max_bubble_size=body.max_bubble_size,
    )
    return TfidfBubbleScoresResponse(**result)


@router.post(
    "/refer_dictionary",
    response_model=ReferDictionaryResponse,
    summary="テキスト中の名詞を辞書検索し、意味を取得する",
    description=(
        "入力テキストを形態素解析して名詞を抽出し、各名詞の意味をDB またはLLM から取得します。"
        " DB にキャッシュがあればそちらを返し、なければ LLM で生成して DB に登録します。"
    ),
    responses={
        200: {"description": "辞書検索成功"},
        422: {"description": "入力バリデーションエラー（text が空など）"},
    },
)
async def refer_dictionary_endpoint(
    body: ReferDictionaryRequest,
) -> ReferDictionaryResponse:
    entries = await refer_dictionary(body.text)
    return ReferDictionaryResponse(
        text=body.text,
        entries=[ReferDictionaryEntry(**e) for e in entries],
    )
