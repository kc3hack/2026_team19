# フロント向け API 仕様（Desktop 統合パイプライン）

このドキュメントは、Desktop クライアント（Electron）から
「音声入力 -> 文字起こし -> 形態素解析/ベクトル化 -> 辞書参照」までを
1 回の API 呼び出しで扱うための実装仕様です。

## 1. 目的

- クライアントの API 往復回数を削減する
- Desktop 側実装を単純化する
- 既存 Backend 資産（`/analysis/*`, `/analysis/refer_dictionary`）を内部再利用する

方針:

- 外部 API は統合（1 エンドポイント）
- Backend 内部はサービス分離を維持（STT / 解析 / 辞書）

## 2. エンドポイント

- `POST /pipeline/transcribe-analyze`
- `Content-Type: multipart/form-data`

## 3. リクエスト

## 3.1 フィールド

| 項目 | 型 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- | --- |
| `audio` | file(binary) | 必須 | - | 音声チャンク本体 |
| `session_id` | string | 必須 | - | セッション識別子（再接続時も同一） |
| `chunk_seq` | integer | 必須 | - | 0 始まり連番 |
| `is_final_chunk` | boolean | 任意 | `false` | 発話区切りの確定チャンクか |
| `input_source` | `"microphone" \| "system_audio"` | 任意 | `"microphone"` | 入力ソース |
| `audio_format` | `"wav" \| "pcm16" \| "webm_opus"` | 任意 | `"wav"` | 音声フォーマット |
| `sample_rate_hz` | integer | 任意 | `16000` | サンプルレート |
| `channels` | integer | 任意 | `1` | チャンネル数 |
| `language_hint` | string | 任意 | `"ja-JP"` | 音声認識ヒント |
| `include_dictionary` | boolean | 任意 | `false` | 辞書参照を行うか |
| `dictionary_top_k` | integer | 任意 | `5` | 辞書参照する用語数 |
| `deduplicate` | boolean | 任意 | `false` | 既存 `/analysis/vectorize` と同義 |
| `min_length` | integer | 任意 | `1` | 既存 `/analysis/vectorize` と同義 |
| `normalize_sentence_vector` | boolean | 任意 | `true` | 既存 `/analysis/vectorize/sentence` と同義 |

## 3.2 補足

- チャンク間の文脈維持は `session_id` と `chunk_seq` で行う
- `include_dictionary=true` は `is_final_chunk=true` 時のみ有効（MVP）
- 解析対象テキストは STT の最終確定テキストを使用

## 4. レスポンス

## 4.1 例

```json
{
  "session_id": "sess_20260226_001",
  "chunk_seq": 12,
  "timing": {
    "processed_ms": 248
  },
  "transcript": {
    "partial_text": "本日の議題は API 設計",
    "final_text": "本日の議題はAPI設計です。",
    "is_final": true,
    "confidence": 0.91
  },
  "analysis": {
    "vectorize": {
      "text": "本日の議題はAPI設計です。",
      "meta": {
        "model": "ginza",
        "vector_dim": 300,
        "input_token_count": 8,
        "output_token_count": 3,
        "vector_source_counts": {
          "spacy": 3
        }
      },
      "tokens": []
    },
    "sentence_vectorize": {
      "text": "本日の議題はAPI設計です。",
      "meta": {
        "model": "ginza",
        "vector_dim": 300,
        "vector_source": "spacy_doc",
        "normalize": true,
        "input_token_count": 8,
        "content_token_count": 3
      },
      "sentence_vector": []
    }
  },
  "dictionary": {
    "enabled": true,
    "entries": [
      {
        "term": "API",
        "description": "アプリ間でデータや機能をやり取りするための取り決めです。",
        "source": "db"
      }
    ]
  }
}
```

## 4.2 フィールド

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `session_id` | string | 入力のセッションID |
| `chunk_seq` | integer | 入力チャンク連番 |
| `timing.processed_ms` | integer | サーバ処理時間 |
| `transcript.partial_text` | string | 途中文字起こし |
| `transcript.final_text` | string | 確定文字起こし |
| `transcript.is_final` | boolean | 確定結果か |
| `transcript.confidence` | number \| null | STT 信頼度 |
| `analysis.vectorize` | object \| null | 既存 `VectorizeResponse` 互換 |
| `analysis.sentence_vectorize` | object \| null | 既存 `SentenceVectorizeResponse` 互換 |
| `dictionary.enabled` | boolean | 辞書参照を実行したか |
| `dictionary.entries` | array | 既存 `ReferDictionaryEntry` 互換 |

## 5. 動作仕様（MVP）

## 5.1 `is_final_chunk=false`（低遅延）

- STT を実行して `partial_text` を返す
- 形態素解析・ベクトル化・辞書は原則スキップ
- レスポンス時間を優先

## 5.2 `is_final_chunk=true`（確定）

- STT で `final_text` を確定
- `final_text` に対して `vectorize` / `vectorize_sentence` を実行
- `include_dictionary=true` の場合のみ辞書参照を実行

## 5.3 辞書参照の実行条件

- `is_final_chunk=true`
- `include_dictionary=true`
- 上位 `dictionary_top_k` 語のみ対象
- 同一セッション内で同じ語は重複問い合わせを抑制

## 6. エラー仕様

| HTTP | 条件 | `detail` 例 |
| --- | --- | --- |
| `400` | チャンク連番不正 / セッション不整合 | `invalid chunk sequence` |
| `413` | 音声チャンクサイズ上限超過 | `audio chunk too large` |
| `415` | 非対応フォーマット | `unsupported audio format` |
| `422` | 入力バリデーション | FastAPI標準形式 |
| `503` | STTエンジンまたはDBが利用不可 | `speech service unavailable` |
| `504` | STTまたは辞書上流タイムアウト | `upstream timeout` |

## 7. TypeScript 型サンプル

```ts
export type DesktopPipelineResponse = {
  session_id: string;
  chunk_seq: number;
  timing: { processed_ms: number };
  transcript: {
    partial_text: string;
    final_text: string;
    is_final: boolean;
    confidence: number | null;
  };
  analysis: {
    vectorize: import("./frontend-api-vectorize").VectorizeResponse | null;
    sentence_vectorize:
      | import("./frontend-api-vectorize").SentenceVectorizeResponse
      | null;
  };
  dictionary: {
    enabled: boolean;
    entries: Array<{
      term: string;
      description: string;
      source: "db" | "llm" | string;
    }>;
  };
};
```

## 8. 実装方針（Backend）

## 8.1 外部 API は 1 本、内部は既存再利用

- 新規エンドポイント: `app/api/endpoints/pipeline.py`
- 内部利用:
  - STT サービス（新規）
  - `vectorize_content_tokens`（既存）
  - `vectorize_sentence`（既存）
  - `refer_dictionary`（既存）

## 8.2 段階導入

1. HTTP（multipart）版を先行実装
2. Desktop を統合 API へ切替
3. 必要に応じて WebSocket 版（`/pipeline/realtime`）を追加

## 9. Desktop 側の呼び出し指針

- 2〜5 秒ごとに音声をチャンク化して送信
- UI は `partial_text` を逐次更新し、`is_final=true` で解析結果を反映
- ネットワーク断時は同一 `session_id` で再接続、`chunk_seq` を継続
