from fastapi.testclient import TestClient

from main import app


client = TestClient(app)


def test_vectorize_endpoint_returns_vectors() -> None:
    res = client.post(
        "/analysis/vectorize",
        json={
            "text": "今日は自然言語処理を勉強して、そして結果を共有します。",
            "deduplicate": False,
        },
    )
    assert res.status_code == 200
    body = res.json()

    assert "meta" in body
    assert body["meta"]["vector_dim"] > 0
    assert body["meta"]["output_token_count"] > 0
    assert len(body["tokens"]) > 0

    surfaces = [token["surface"] for token in body["tokens"]]
    assert "そして" not in surfaces

    first = body["tokens"][0]
    assert {"surface", "base_form", "pos", "start", "end", "vector", "vector_dim", "vector_source"} <= set(first.keys())
    assert len(first["vector"]) == first["vector_dim"]


def test_vectorize_endpoint_validates_empty_text() -> None:
    res = client.post("/analysis/vectorize", json={"text": ""})
    assert res.status_code == 422


def test_vectorize_sentence_endpoint_returns_vector() -> None:
    res = client.post(
        "/analysis/vectorize/sentence",
        json={
            "text": "本日の議事録を作成します。API設計と実装方針を共有します。",
            "normalize": True,
        },
    )
    assert res.status_code == 200
    body = res.json()

    assert "meta" in body
    assert body["meta"]["vector_dim"] > 0
    assert len(body["sentence_vector"]) == body["meta"]["vector_dim"]
    assert body["meta"]["vector_source"] in {
        "spacy_doc",
        "spacy_token_avg",
        "content_token_avg",
        "hash",
    }


def test_vectorize_sentence_endpoint_validates_empty_text() -> None:
    res = client.post("/analysis/vectorize/sentence", json={"text": ""})
    assert res.status_code == 422


def test_vectorize_sentence_endpoint_validates_whitespace_only_text() -> None:
    res = client.post("/analysis/vectorize/sentence", json={"text": "   "})
    assert res.status_code == 422


def test_tfidf_bubble_scores_endpoint_returns_scores() -> None:
    res = client.post(
        "/analysis/tfidf/bubble-scores",
        json={
            "utterances": [
                "今日はRAG設計を進めます。",
                "APIのレイテンシを改善します。",
                "GPUコストの見積もりを確認します。",
            ],
            "top_k": 3,
            "window_size": 30,
            "min_bubble_size": 28,
            "max_bubble_size": 72,
        },
    )
    assert res.status_code == 200
    body = res.json()

    assert "meta" in body
    assert body["meta"]["algorithm"] == "tfidf_topk_sum_v1"
    assert body["meta"]["utterance_count"] == 3
    assert len(body["items"]) == 3
    assert all(28 <= item["bubble_size"] <= 72 for item in body["items"])


def test_tfidf_bubble_scores_endpoint_validates_blank_utterance() -> None:
    res = client.post(
        "/analysis/tfidf/bubble-scores",
        json={
            "utterances": ["有効な発話です", "   "],
            "top_k": 3,
            "window_size": 30,
            "min_bubble_size": 28,
            "max_bubble_size": 72,
        },
    )
    assert res.status_code == 422
