# swift-capture-agent

Swift Capture Agent の雛形実装です。ローカル WebSocket サーバとして起動し、
UI からの command を受け取って transcript/analysis event を返します。

## 機能（現時点）

- `ws://127.0.0.1:55100/ws` で待受
- サブプロトコル `lexiflow.capture.v1` を要求
- `hello/get_status/start_capture/stop_capture/set_source_enabled/open_settings/set_auto_launch` を処理
- `start_capture` 後、`microphone` を Speech framework で文字起こしして partial/final transcript を送信
- `system_audio` は ScreenCaptureKit 経由で取り込み、Speech framework で文字起こし
- final transcript ごとに Backend `POST /pipeline/analyze-text` を呼び出し、`analysis_result` event を返却

## 起動

```bash
cd /Users/honmayuudai/MyHobby/hackson/KC3Hack2026/Desktop/swift-capture-agent
swift run swift-capture-agent
```

`.env` を使う場合は、同じディレクトリに配置します。

```bash
cd /Users/honmayuudai/MyHobby/hackson/KC3Hack2026/Desktop/swift-capture-agent
cp .env.example .env
```

## 環境変数

- `LEXIFLOW_AGENT_HOST`（既定: `127.0.0.1`）
- `LEXIFLOW_AGENT_PORT`（既定: `55100`）
- `LEXIFLOW_BACKEND_BASE_URL`（既定: `http://127.0.0.1:8000`）

優先順位は次の通りです。

1. プロセス起動時に渡した環境変数
2. `swift-capture-agent/.env`
3. コード上の既定値

## 注意

- `system_audio` は画面収録権限が必要です。
- 現時点では `microphone` と `system_audio` の同時取り込みは未実装です。
- マイク・音声認識・画面収録の権限が未許可の場合、`permission_required` と `error` を返します。
