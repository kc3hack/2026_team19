# Desktop/electron

TalkScope の macOS デスクトップシェル（Electron）です。  
既存 `Frontend` を Renderer として読み込みます。

## 前提

- Node.js 20 以上
- macOS

## セットアップ

```bash
cd /Users/honmayuudai/MyHobby/hackson/KC3Hack2026/Desktop/electron
bun install
```

## 起動（開発）

```bash
bun run dev
```

- `Frontend` の dev server（`http://localhost:5173`）を起動し、Electron から接続します。
- 起動直後は Tray 常駐（ウィンドウ非表示）です。メニューバーアイコンをクリックして表示してください。

## 起動（本番相当）

1. Frontend をビルド

```bash
bun run build:renderer
```

2. Electron を起動

```bash
bun run start
```

## 実装済み（Day 1-4）

- Tray 常駐
- Window 表示/非表示
- ログイン時起動トグル
- IPC 土台（`desktop:*`）
  - `desktop:getAudioSources`
  - `desktop:startCapture`
  - `desktop:stopCapture`
  - `desktop:getPermissions`
  - `desktop:openSettings`
- 音声キャプチャ PoC（preload）
  - `desktopAPI.startAudioCapture({ inputSource, sourceId, chunkMs })`
  - `desktopAPI.stopAudioCapture()`
  - `desktopAPI.onAudioChunk(...)`
  - `desktopAPI.onCaptureError(...)`
  - マイク入力 / システム音声入力の切り替え
- 統合API連携（Renderer）
  - `onAudioChunk` ごとに `POST /pipeline/transcribe-analyze` を送信
  - `system_audio` では pipeline の `partial/final` を transcript に反映
  - `microphone` では Web Speech を優先しつつ pipeline へ並行送信

## Day 2 の確認手順

1. `bun run dev` で Desktop を起動
2. メニューバーからウィンドウを開く
3. ヘッダー左側の入力ソースで `マイク入力` または `システム音声` を選択
4. `録音開始` を押す
5. ヘッダーの `chunks:<number>` が増えることを確認

## 既知の制約（Day 4 時点）

- Backend 側 STT は現在スタブ実装（`text_override` 優先）です
- `system_audio` で実用的な文字起こしを行うには、Backend 側の実STT接続が必要です
