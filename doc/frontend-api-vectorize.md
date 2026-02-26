# フロント向け API 仕様（ベクトル化）

このドキュメントは、Frontend メンバーがベクトル化APIを利用するための実装向け仕様です。  
バックエンド内部の実装詳細は以下を参照してください。

- `/Users/honmayuudai/MyHobby/hackson/KC3Hack2026/doc/text-analysis-methods.md`

## 1. Swagger での確認先

バックエンド起動後、以下で確認できます。

- Swagger UI: `http://127.0.0.1:8000/docs`
- ReDoc: `http://127.0.0.1:8000/redoc`

## 2. エンドポイント

- `POST /analysis/vectorize`
  - 単語（内容語）ベクトルを返す
- `POST /analysis/vectorize/sentence`
  - 文章全体の単一ベクトルを返す
- `POST /analysis/tfidf/bubble-scores`
  - 発話ごとのTF-IDFスコアと推奨バブルサイズを返す
- 共通: `Content-Type: application/json`

## 3. リクエスト

### 3.1 基本形

```json
{
  "text": "今日は自然言語処理を勉強して、そして結果を共有します。",
  "deduplicate": false
}
```

### 3.2 フィールド

| 項目          | 型                 | 必須 | 既定値  | 説明                           |
| ------------- | ------------------ | ---- | ------- | ------------------------------ |
| `text`        | `string`           | 必須 | -       | 解析対象テキスト（1文字以上）  |
| `include_pos` | `string[] \| null` | 任意 | `null`  | ベクトル化対象に含める品詞     |
| `exclude_pos` | `string[] \| null` | 任意 | `null`  | ベクトル化対象から除外する品詞 |
| `min_length`  | `number`           | 任意 | `1`     | 語長の最小値                   |
| `deduplicate` | `boolean`          | 任意 | `false` | 同一基本形を1件に集約するか    |

補足:

- `include_pos` / `exclude_pos` を指定しない場合はサーバー既定の品詞フィルタが使われます。
- 空文字 `text` は `422` になります。

## 4. レスポンス

### 4.1 例

```jsonc
{
  "text": "今日は自然言語処理を勉強して、そして結果を共有します。",
  "meta": {
    "model": "ginza",
    "vector_dim": 300,
    "input_token_count": 15,
    "output_token_count": 7,
    "vector_source_counts": {
      "spacy": 6,
      "hash": 1
    }
  },
  "tokens": [
    {
      "surface": "自然言語処理",
      "base_form": "自然言語処理",
      "pos": "名詞",
      "start": 3,
      "end": 9,
      "vector": [0.011231, -0.042001, 0.008821, -0.005238, ...],
      "vector_dim": 300,
      "vector_source": "spacy"
    }
  ]
}
```

### 4.2 フィールド

| 項目                        | 型         | 説明                                     | フロントでの主な用途                 |
| --------------------------- | ---------- | ---------------------------------------- | ------------------------------------ |
| `text`                      | `string`   | 入力された元テキスト（そのまま返却）     | 画面表示時の原文保持、オフセット基準 |
| `meta`                      | `object`   | 解析全体のメタ情報                       | 状態表示、デバッグ表示               |
| `meta.model`                | `string`   | 利用モデル名（例: `ginza`）              | 環境差異の把握、ログ表示             |
| `meta.vector_dim`           | `number`   | レスポンス全体のベクトル次元             | ベクトル処理前の次元チェック         |
| `meta.input_token_count`    | `number`   | 形態素解析後トークン数（除外前）         | 解析量の可視化                       |
| `meta.output_token_count`   | `number`   | ベクトル化して返したトークン数（除外後） | 抽出件数表示、空結果判定             |
| `meta.vector_source_counts` | `object`   | `spacy` / `hash` など取得元ごとの件数    | 品質監視（フォールバック率確認）     |
| `tokens`                    | `array`    | ベクトル化したトークン一覧               | バブルUIやリスト表示のデータ本体     |
| `tokens[].surface`          | `string`   | 表層形                                   | 表示テキスト                         |
| `tokens[].base_form`        | `string`   | 基本形                                   | 重複統合・索引用キー                 |
| `tokens[].pos`              | `string`   | 品詞                                     | 色分け、品詞フィルタUI               |
| `tokens[].start`            | `number`   | 原文中の開始位置                         | ハイライト開始位置                   |
| `tokens[].end`              | `number`   | 原文中の終了位置                         | ハイライト終了位置                   |
| `tokens[].vector`           | `number[]` | ベクトル値本体                           | 類似度計算、クラスタリング           |
| `tokens[].vector_dim`       | `number`   | トークンベクトルの次元                   | 配列長検証                           |
| `tokens[].vector_source`    | `string`   | ベクトル取得元（`spacy` / `hash`）       | フォールバック判定                   |

補足:

- `tokens[].vector` の長さは通常 `tokens[].vector_dim` と一致します。
- `tokens[].vector_dim` は通常 `meta.vector_dim` と一致します。
- `vector_source = hash` は、語彙ベクトルが取れずフォールバックした語です。

## 5. エラー仕様

### 5.1 422（入力エラー）例

```json
{
  "detail": [
    {
      "type": "string_too_short",
      "loc": ["body", "text"],
      "msg": "String should have at least 1 character",
      "input": "",
      "ctx": { "min_length": 1 }
    }
  ]
}
```

## 6. TypeScript 型サンプル

```ts
export type VectorizeRequest = {
  text: string;
  include_pos?: string[] | null;
  exclude_pos?: string[] | null;
  min_length?: number;
  deduplicate?: boolean;
};

export type VectorizedToken = {
  surface: string;
  base_form: string;
  pos: string;
  start: number;
  end: number;
  vector: number[];
  vector_dim: number;
  vector_source: "spacy" | "hash" | string;
};

export type VectorizeResponse = {
  text: string;
  meta: {
    model: string;
    vector_dim: number;
    input_token_count: number;
    output_token_count: number;
    vector_source_counts: Record<string, number>;
  };
  tokens: VectorizedToken[];
};
```

## 7. 文章ベクトルAPI（`/analysis/vectorize/sentence`）

### 7.1 リクエスト

```json
{
  "text": "本日の議事録を作成します。API設計と実装方針を共有します。",
  "normalize": true
}
```

| 項目        | 型        | 必須 | 既定値 | 説明                                    |
| ----------- | --------- | ---- | ------ | --------------------------------------- |
| `text`      | `string`  | 必須 | -      | 文章ベクトル化対象テキスト（1文字以上） |
| `normalize` | `boolean` | 任意 | `true` | 返却ベクトルにL2正規化を適用するか      |

### 7.2 レスポンス

```jsonc
{
  "text": "本日の議事録を作成します。API設計と実装方針を共有します。",
  "meta": {
    "model": "ginza",
    "vector_dim": 300,
    "vector_source": "spacy_doc",
    "normalize": true,
    "input_token_count": 13,
    "content_token_count": 6
  },
  "sentence_vector": [0.0312, -0.0124, 0.2011, -0.0942, ...]
}
```

| 項目                       | 型         | 説明                                                                             |
| -------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `text`                     | `string`   | 入力テキスト（そのまま返却）                                                     |
| `meta.model`               | `string`   | 利用モデル名（例: `ginza`）                                                      |
| `meta.vector_dim`          | `number`   | 文章ベクトルの次元数                                                             |
| `meta.vector_source`       | `string`   | ベクトル取得元（`spacy_doc` / `spacy_token_avg` / `content_token_avg` / `hash`） |
| `meta.normalize`           | `boolean`  | 正規化を適用したか                                                               |
| `meta.input_token_count`   | `number`   | 形態素解析後トークン数                                                           |
| `meta.content_token_count` | `number`   | 内容語として採用されたトークン数                                                 |
| `sentence_vector`          | `number[]` | 文章ベクトル本体（`meta.vector_dim` 個）                                         |

### 7.3 TypeScript 型サンプル

```ts
export type SentenceVectorizeRequest = {
  text: string;
  normalize?: boolean;
};

export type SentenceVectorizeResponse = {
  text: string;
  meta: {
    model: string;
    vector_dim: number;
    vector_source:
      | "spacy_doc"
      | "spacy_token_avg"
      | "content_token_avg"
      | "hash"
      | string;
    normalize: boolean;
    input_token_count: number;
    content_token_count: number;
  };
  sentence_vector: number[];
};
```

## 8. TF-IDF バブルスコアAPI（`/analysis/tfidf/bubble-scores`）

### 8.1 リクエスト

```json
{
  "utterances": [
    "今日はRAGの設計を詰めます。",
    "APIのレイテンシ改善も必要です。",
    "GPUコストの見積もりも確認しましょう。"
  ],
  "top_k": 3,
  "window_size": 30,
  "min_bubble_size": 28,
  "max_bubble_size": 72
}
```

| 項目              | 型         | 必須 | 既定値 | 説明                                                |
| ----------------- | ---------- | ---- | ------ | --------------------------------------------------- |
| `utterances`      | `string[]` | 必須 | -      | バブル対象の発話配列（1要素=1バブル）              |
| `top_k`           | `number`   | 任意 | `3`    | `raw_score` に加算する上位TF-IDF語数               |
| `window_size`     | `number`   | 任意 | `30`   | TF-IDF算出に使うスライディング窓サイズ（発話数）   |
| `min_bubble_size` | `number`   | 任意 | `28`   | 正規化スコア0のときの最小バブルサイズ(px)          |
| `max_bubble_size` | `number`   | 任意 | `72`   | 正規化スコア1のときの最大バブルサイズ(px)          |

補足:

- 空配列、空白のみ発話、`max_bubble_size <= min_bubble_size` は `422` になります。

### 8.2 レスポンス

```jsonc
{
  "meta": {
    "algorithm": "tfidf_topk_sum_v1",
    "top_k": 3,
    "window_size": 30,
    "min_bubble_size": 28,
    "max_bubble_size": 72,
    "p10": 0.31211,
    "p90": 1.98212,
    "utterance_count": 3
  },
  "items": [
    {
      "index": 0,
      "text": "今日はRAGの設計を詰めます。",
      "raw_score": 1.423111,
      "normalized_score": 0.665269,
      "bubble_size": 57,
      "top_terms": [
        { "term": "rag", "score": 0.845212 },
        { "term": "設計", "score": 0.577899 }
      ]
    }
  ]
}
```

| 項目                     | 型         | 説明                                                          |
| ------------------------ | ---------- | ------------------------------------------------------------- |
| `meta.algorithm`         | `string`   | 算出アルゴリズム識別子（現状: `tfidf_topk_sum_v1`）          |
| `meta.p10` / `meta.p90` | `number`   | `raw_score` の正規化に使った分位点                            |
| `meta.utterance_count`   | `number`   | 入力発話数                                                    |
| `items[]`                | `object[]` | 発話ごとのバブルスコア                                        |
| `items[].index`          | `number`   | `utterances` 内の位置                                         |
| `items[].text`           | `string`   | 対象発話（そのまま返却）                                      |
| `items[].raw_score`      | `number`   | 上位 `top_k` 語のTF-IDF合計スコア                             |
| `items[].normalized_score` | `number` | `p10/p90` 正規化後の 0..1 スコア                              |
| `items[].bubble_size`    | `number`   | 推奨バブルサイズ(px)                                           |
| `items[].top_terms`      | `object[]` | 発話内のTF-IDF上位語（最大 `top_k` 件）                       |
| `items[].top_terms[].term` | `string` | 上位語                                                        |
| `items[].top_terms[].score` | `number` | 上位語のTF-IDFスコア                                          |

### 8.3 TypeScript 型サンプル

```ts
export type TfidfBubbleScoresRequest = {
  utterances: string[];
  top_k?: number;
  window_size?: number;
  min_bubble_size?: number;
  max_bubble_size?: number;
};

export type TfidfBubbleScoresResponse = {
  meta: {
    algorithm: "tfidf_topk_sum_v1" | string;
    top_k: number;
    window_size: number;
    min_bubble_size: number;
    max_bubble_size: number;
    p10: number;
    p90: number;
    utterance_count: number;
  };
  items: Array<{
    index: number;
    text: string;
    raw_score: number;
    normalized_score: number;
    bubble_size: number;
    top_terms: Array<{
      term: string;
      score: number;
    }>;
  }>;
};
```
