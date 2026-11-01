# ComfyUI Tab Audio Capture

外部サイトの埋め込み `iframe` で再生されている音声を、**Chrome / Chromium のタブ音声キャプチャ**を利用して ComfyUI の `AUDIO` 出力に変換するカスタムノードです。iframe内部の DOM にはアクセスしません。

## ノード2種類

### Tab Audio Capture · Live

- `Start Capture` をクリックして **録音したいChromeタブ**を選び、**タブの音声も共有**を有効にする。ComfyUIとは別のタブも選べます。
- 録音はワークフロー実行と無関係に継続。最新120秒分を保持します。
- `duration_seconds`（0.5～60秒）で切り出す長さを設定。
- `Queue Prompt` を押した**時点**で直近の音声のスナップショットを作成し、実行開始後に `AUDIO` から参照できるようにします。GPU実行待ちが長くても、Queue時の音声は変わりません。
- `Stop Capture` の後も、最後に保持した音声については Queue を実行できます。
- 標準の Record Audio と同じ再生バーを表示。停止時と Queue 時に切り出した音声を再生・シークできます。
- 毎回の自動Queueやワークフローの連続再実行は**行いません**。

接続例：`Tab Audio Capture · Live (AUDIO)` → `動画生成ノードのaudio_ref`。

### Tab Audio Capture · Stop & Save

- `Start Recording` をクリックし、録音したいChromeタブの音声を共有。ComfyUIのタブでも別タブでも録音できます。
- 標準の Record Audio と同じ再生バーと、開始／停止を切り替える1つのボタンを表示します。`Stop & Save` で録音を終了し、**Queueなしで保存・再生**できます。
- 保存設定は GeminiTools の Save Audio と同じ標準ウィジェットです。録音開始前に設定してください。
- `filename_prefix` で `ComfyUI/output` 内のフォルダとファイル名を指定します。例：`music/take` → `output/music/take_00001.wav`。既定値は `tab_audio/tab_audio`。
- `format` は `original`（受信した32bit float PCMをそのままWAVへ保存）、`wav`（16/24/32bit PCM、既定24bit）、`m4a`（AAC、128/192/256/320kbps、既定256kbps）。WAVのビット深度とM4Aのビットレートは、選択した形式の項目のみ Advanced に表示します。
- `Queue Prompt` で保存済み音声を `audio`（AUDIO）出力として渡します。2番目の `saved_file_path`（STRING）は、保存したWAV/M4Aの絶対パスを返し、Video Helper Suite の `Load Audio (Path)` の `audio_file` 入力に直接接続できます。
- 保存済みファイルへの参照はワークフローにも残り、再起動後も使用できます。録音時間の上限は10分で、AudioContextのサンプルレートを維持します。

接続例：`Tab Audio Capture · Stop & Save (AUDIO)` → `動画生成ノードのaudio_ref`。

## サンプルワークフロー

JSONをComfyUIへドラッグ＆ドロップして開いてください。録音対象は開始時に選択します。

- [録音・保存・出力確認](example/record_tab_audio.json)：標準ノードで `audio` と `saved_file_path` を確認。
- [保存パスからの読み込み](example/record_tab_audio_with_vhs.json)：`saved_file_path` → `Load Audio (Path)` → `Preview Audio`。Video Helper Suite が必要です。
- [Liveで直近N秒を切り出す](example/live_tab_audio.json)：Live → Preview Audio。

## インストール

1. ZIPを展開して、ディレクトリを以下のように配置してください。

   ```text
   ComfyUI/
     custom_nodes/
       ComfyUI-TabAudioCapture/
         __init__.py
         sessions.py
         web/
           tab_audio_capture.js
           worklets/
             tab_audio_worklet.mjs
   ```

2. **ComfyUIを再起動**し、ブラウザをリロードしてください。
3. ノード検索で `Tab Audio Capture` を入力すると、上記2種類が表示されます。
4. 利用したいノードをグラフに追加し、`AUDIO` 出力を既存の音声入力ノードにつないでください。
5. ノード内の `Start` を押し、Chromeの共有ダイアログで **「Chromeタブ」→「録音したいタブ」→「タブの音声も共有」** の順に選択してください。

追加の `pip install` は基本的に不要です（ComfyUIが利用している `torch`、`numpy`、`aiohttp`、`av` を利用）。

## 技術仕様・注意点

- Chrome / Chromiumを想定。マイク入力ではなく**タブ内で再生中の音声**を取得します。タブ内の他の音も混合され、外部iframeだけを個別分離することはできません。
- `getDisplayMedia()` の仕様上、録音を開始するたびに共有先の選択と許可が必要です。HTTPの場合は `localhost`、その他はHTTPSが必要です。
- ブラウザでのキャプチャは `AudioWorklet` → 32bit float PCM → WebSocket → ComfyUI Python サーバーです。出力は `[1, channels, samples]` の `waveform` と `sample_rate` を持つ標準 `AUDIO` 辞書です。
- **通常の `AUDIO` ソケットは連続ストリームではありません。** LiveノードはQueue時の固定スナップショット、保存ノードはStop時に完成した音声を返す仕組みです。動画生成実行中に入力を更新するものではありません。
- Liveの音声はメモリ内のリングバッファで最大120秒、Queue時のスナップショットは一時ディスクファイルとして保持。再起動後は失われます。古いスナップショットは次の録音開始時などに、24時間経過したものを掃除します。
- Stop & Saveは一時ディスクにPCMを書き込み、停止時に選択した形式で保存します。保存済みファイルは自動削除しません。10分上限で停止すると、その時点までの録音を保存します。
- ネットワーク遅延が大きくWebSocket送信待ちが4 MiBを超えると、自動停止する安全策があります。長時間のネットワーク断やタブを閉じた場合、録音が途切れることがあります。
- ローカルのComfyUIとChromeを想定した実装です。ComfyUI Cloud等のカスタムノード導入が制限される環境では使用できません。HTTPSリバースプロキシ環境ではWebSocketのアップグレードが必要です。
- 音源を再生するサイト側がOS/ブラウザのタブキャプチャを妨げる場合、その音声は取得できません。

## テスト

Python単体/HTTP・WebSocketテストと、録音操作・プレーヤー更新を確認するJavaScriptテストを含みます。ブラウザとComfyUIサーバーはモックするため、実機のComfyUIプロセスを起動する必要はありません。

```bash
cd ComfyUI/custom_nodes/ComfyUI-TabAudioCapture
python -m pytest -q
node --test tests/test_ui.mjs
```

`pytest` がなければ開発用環境にのみ導入してください。実際のChrome共有ダイアログを含むComfyUI UI上での録音検証は別途必要です。
