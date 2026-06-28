# 運転英会話（driving-english）

運転中にハンズフリーで使う、初級者むけ英会話練習アプリのプロトタイプ。
Gemini Live API を使って、AIが**声でしゃべり返してくる**リアルタイム会話をする。

ChatGPT/Gemini の汎用アシスタントと違うところ：
- AIは1〜2文だけ話して、必ず質問で返す（会話が途切れない）
- 初級者むけに簡単な単語・ゆっくりめ
- 詰まったら2択を出してくれる
- 5分で自動的にラップアップ（修正3つ＋新フレーズ1つ）

---

## 1. 準備（最初の1回だけ）

### Node.js を入れる
https://nodejs.org/ から LTS版をインストール。

### APIキーを取る（無料枠あり）
1. https://aistudio.google.com/apikey をひらく
2. 「Create API key」でキーを発行
3. このフォルダの `.env.example` をコピーして `.env` という名前にする
4. `.env` の `GEMINI_API_KEY=ここにAPIキー` を、自分のキーに書きかえる

### インストール
このフォルダで：

```
npm install
```

---

## 2. 起動

```
npm start
```

`✅ 起動しました → http://localhost:3000` と出たら成功。
**PCのブラウザ**で http://localhost:3000 をひらいて「はじめる」を押す → マイク許可 → 話しかける。

> まずはPCで会話が成立するか確認するのがおすすめ。

---

## 3. スマホ（運転）で使うには HTTPS が必要

スマホのブラウザは、マイクを使うのに **https** が必須（PCのlocalhostだけは例外）。
LANのIP（http://192.168...）だとマイクが動かない。だから次のどれかで https にする：

- **手軽**: `cloudflared`（無料トンネル）でこのサーバを一時的に https 公開する
- **ちゃんと**: Render / Railway / Fly.io などに置く（後で一緒にやる）

スマホで開けたら、ブラウザの「ホーム画面に追加」でアプリっぽく常駐できる。
運転中はスマホをマウントして、開いて「はじめる」を押すだけ。

---

## 4. うまく動かないとき

- **起動時に「GEMINI_API_KEY が未設定」** → `.env` を作ったか／キーを貼ったか確認
- **すぐ切断される・モデルエラー** → `.env` の `GEMINI_MODEL` を
  `gemini-2.5-flash-preview-native-audio-dialog` に変えて再起動
- **声が返らない／プツプツする** → このまま教えてくれれば一緒に直す

---

## 構成

```
server.js              … APIキーを隠す中継サーバ＋静的配信
public/index.html      … 画面（大きいボタン2つ）
public/app.js          … マイク録音・送受信・音声再生・5分タイマー
public/pcm-processor.js… マイク音声をPCM16に変換
public/style.css       … 見た目
.env                   … APIキー（自分で作る・gitに上げない）
```
