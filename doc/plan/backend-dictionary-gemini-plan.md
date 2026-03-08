# バックエンド辞書検索（Gemini暫定版）実装計画

## 1. このドキュメントの位置づけ

このファイルは、実装担当者がそのまま着手できる具体仕様です。  
「何を、どこに、どの形で、どうテストするか」を固定します。

## 2. 実装ゴール（MVP）

- `POST /dictionary/lookup` を追加する
- 単語DBは未実装のため、現時点では常に Gemini へフォールバックする
- 入力された単語に対して、平易な日本語の概要を返す

## 3. 追加/変更ファイル（確定）

### 3.1 新規追加

- `Backend/app/schemas/dictionary.py`
- `Backend/app/services/dictionary.py`
- `Backend/app/api/endpoints/dictionary.py`
- `Backend/tests/test_dictionary_service.py`
- `Backend/tests/test_dictionary_endpoint.py`

### 3.2 既存変更

- `Backend/app/api/__init__.py`
- `Backend/main.py`
- `Backend/README.md`

## 4. API仕様（確定）

### 4.1 エンドポイント

- `POST /dictionary/lookup`

### 4.2 リクエストスキーマ

`DictionaryLookupRequest`

- `term: str`
  - 必須
  - `strip()` 後に空文字は不可
  - `min_length=1`, `max_length=128`
- `context: str | None`
  - 任意
  - `max_length=1000`
  - 空文字は `None` 扱い

リクエスト例:

```json
{
  "term": "RAG",
  "context": "LLMの会話で出てきた用語"
}
```

### 4.3 レスポンススキーマ

`DictionaryLookupResponse`

- `term: str`（正規化後の検索語）
- `summary: str`（1〜2文の日本語概要）
- `source: str`（固定値: `"gemini"`）
- `model: str`（使用した Gemini モデル名）
- `cached: bool`（現時点は固定 `false`）

レスポンス例:

```json
{
  "term": "RAG",
  "summary": "RAGは、回答生成時に外部知識を検索して根拠を補う手法です。LLMの回答精度を高める目的で使われます。",
  "source": "gemini",
  "model": "gemini-1.5-flash",
  "cached": false
}
```

## 5. エラー仕様（確定）

### 5.1 HTTPステータス

- `422`: 入力バリデーションエラー
- `503`: `GEMINI_API_KEY` 未設定
- `504`: Gemini API タイムアウト
- `502`: Gemini API 応答不正 or 上流エラー

### 5.2 `detail` 文言（固定）

- 503: `"GEMINI_API_KEY is not configured"`
- 504: `"Gemini API request timed out"`
- 502（応答不正）: `"Gemini upstream returned invalid response"`
- 502（上流失敗）: `"Failed to call Gemini API"`

## 6. サービス実装仕様（確定）

実装先: `Backend/app/services/dictionary.py`

### 6.1 定数

- `GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"`
- `GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")`
- `GEMINI_TIMEOUT_SECONDS = float(os.getenv("GEMINI_TIMEOUT_SECONDS", "10"))`
- `GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")`

### 6.2 関数シグネチャ

- `def lookup_term_summary(term: str, context: str | None = None) -> dict[str, Any]:`
- `def _lookup_term_from_db(term: str) -> dict[str, Any] | None:`
- `def _build_prompt(term: str, context: str | None) -> str:`
- `def _call_gemini(prompt: str) -> tuple[str, str]:`

### 6.3 処理フロー（固定）

1. `term` を `strip()` して正規化
2. `_lookup_term_from_db(term)` を呼ぶ（現時点では必ず `None` を返す）
3. DBヒットなしなら `_build_prompt()` でプロンプト生成
4. `_call_gemini()` で概要取得
5. 下記形式で返却:
   - `{"term": term, "summary": summary, "source": "gemini", "model": model_name, "cached": False}`

### 6.4 プロンプト仕様（固定）

`_build_prompt()` は次の意図を満たす文章を返すこと。

- 出力は日本語
- 1〜2文
- 専門外ユーザーにも分かる平易な説明
- 不要な前置き・箇条書き・Markdown記法は使わない

含めるテンプレート（実装時に文字列として使用）:

```text
あなたは技術用語辞書アシスタントです。
次の用語を、会話中にすぐ理解できるように日本語で1〜2文で説明してください。
専門用語の言い換えを優先し、簡潔に答えてください。
用語: {term}
文脈: {context_or_なし}
```

### 6.5 Gemini REST呼び出し仕様（固定）

HTTP:

- `POST {GEMINI_API_BASE}/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}`
- `Content-Type: application/json`
- timeout: `GEMINI_TIMEOUT_SECONDS`

リクエストJSON:

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "PROMPT_TEXT" }]
    }
  ],
  "generationConfig": {
    "temperature": 0.2,
    "maxOutputTokens": 120,
    "topP": 0.9
  }
}
```

レスポンスパース:

- `candidates[0].content.parts[*].text` を順に見て、最初の非空文字列を採用
- 改行は半角スペースに正規化（`"\n" -> " "`）
- 最終 `strip()` 後に空なら `502`（invalid response）

例外変換:

- API key未設定 -> `503`
- timeout -> `504`
- HTTP 4xx/5xx -> `502`（`"Failed to call Gemini API"`）
- JSON構造不正 -> `502`（`"Gemini upstream returned invalid response"`）

### 6.6 環境変数ロード方針（確定）

- `python-dotenv` を利用し、`Backend/main.py` で `load_dotenv()` を実行する。
- 読み込み対象は `Backend/.env`（`Path(__file__).resolve().parent / ".env"`）。
- `override=False`（既定）で、OS側で設定済みの環境変数を優先する。
- これにより開発時は `uv run uvicorn main:app --reload` だけで `.env` が反映される。

## 7. エンドポイント実装仕様（確定）

実装先: `Backend/app/api/endpoints/dictionary.py`

- `APIRouter()` を作成
- `POST /lookup`
  - `response_model=DictionaryLookupResponse`
  - リクエスト: `DictionaryLookupRequest`
  - サービス: `lookup_term_summary(term=body.term, context=body.context)`

`Backend/app/api/__init__.py`:

- `from app.api.endpoints import analysis, dictionary, hoge`
- `router.include_router(dictionary.router, prefix="/dictionary", tags=["dictionary"])`

`Backend/main.py`:

- `openapi_tags` に dictionary を追加
  - `{"name": "dictionary", "description": "単語の意味概要検索API"}`

## 8. テスト仕様（確定）

### 8.1 サービステスト

ファイル: `Backend/tests/test_dictionary_service.py`

- `test_lookup_term_summary_returns_gemini_result`
  - `_lookup_term_from_db` を `None` モック
  - `_call_gemini` を固定値モック
  - `source=="gemini"`, `cached is False`, `summary` が返ること

- `test_call_gemini_raises_503_when_api_key_missing`
  - `GEMINI_API_KEY` 未設定で `503` と固定detail

- `test_call_gemini_raises_504_on_timeout`
  - `httpx` timeout をモックし `504`

- `test_call_gemini_raises_502_on_invalid_payload`
  - candidates 欠落レスポンスで `502`（invalid response）

### 8.2 エンドポイントテスト

ファイル: `Backend/tests/test_dictionary_endpoint.py`

- `test_dictionary_lookup_returns_200`
  - サービス関数をモックし 200 + expected fields を確認

- `test_dictionary_lookup_validates_empty_term`
  - `{"term": ""}` で 422

- `test_dictionary_lookup_propagates_503`
  - サービスが `HTTPException(503, "...")` を投げた時に 503 を確認

## 9. 実装手順（順番固定）

1. `schemas/dictionary.py` を実装
2. `services/dictionary.py` を実装
3. `endpoints/dictionary.py` を実装
4. `api/__init__.py` に router 追加
5. `main.py` の OpenAPI tags 更新
6. テスト2ファイル追加
7. `Backend/README.md` のAPI一覧更新
8. `pytest` 実行で追加分が通ることを確認

## 10. 完了条件（Definition of Done）

- `/docs` に `POST /dictionary/lookup` が表示される
- 正常入力で `200` + 仕様通りJSONを返す
- 未設定キーで `503` を返す
- 追加テストがすべて成功する
- README API一覧に追記済み
