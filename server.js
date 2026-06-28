import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001';
const VOICE = process.env.GEMINI_VOICE || 'Aoede';

if (!API_KEY || API_KEY === 'ここにAPIキー') {
  console.error('❌ GEMINI_API_KEY が未設定です。.env を作って API キーを入れてください。');
  process.exit(1);
}

const GEMINI_WS =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent' +
  `?key=${API_KEY}`;

// ── AIの性格づけ（初級 × 日常会話の流暢さ向け）──────────────────
const SYSTEM_INSTRUCTION = `You are my friendly English conversation partner.
I am a Japanese beginner learner, and I talk with you while I am driving,
so it is voice-only and hands-free. Make it easy to follow by ear.

How to talk:
- Use VERY simple English (beginner / A2). Short sentences, common words. Speak a bit slowly.
- Say only 1 or 2 sentences per turn, then ALWAYS end with ONE easy, open question
  to keep the conversation going.
- Talk about everyday life: my day, food, weather, weekend, family, hobbies, my work in Japan.
  Stay on ONE topic and ask simple follow-up questions before changing it.
- Do NOT correct me in the middle of the talk. Just say my idea back in correct simple
  English (a natural recast) and keep going.
- If I am silent or stuck, wait a moment, then ask more simply, or give me TWO example
  answers to choose from (e.g. "Was it fun, or tiring?").
- Stay in English. If I clearly do not know a word, give a quick Japanese hint in
  (parentheses), then continue in English.
- When I say "let's wrap up", stop the chat and give me a short recap in simple terms:
  3 quick fixes (what I said -> a better way to say it) and 1 new easy phrase for tomorrow.

Start now: warmly greet me and ask how my day is going.`;

const app = express();
// ブラウザが古いJSをキャッシュして使い続けるのを防ぐ（常に最新を読ませる）
app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (client) => {
  const gem = new WebSocket(GEMINI_WS);
  let ready = false;
  const pending = [];

  gem.on('open', () => {
    gem.send(JSON.stringify({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }));
  });

  // Gemini -> ブラウザ（JSONフレームをそのまま転送）
  gem.on('message', (data) => {
    const text = data.toString();
    if (client.readyState === WebSocket.OPEN) client.send(text);

    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.setupComplete && !ready) {
      ready = true;
      console.log('🟢 Geminiと接続完了。話しかけてOKです');
      pending.forEach((m) => gem.send(m));
      pending.length = 0;
      // 起動直後にAIから挨拶させる（再生が動くか即わかる＆会話の口火を切る）
      gem.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: "Hi, I'm ready. Let's start." }] }],
          turnComplete: true,
        },
      }));
    }
    // デバッグ用: 音声以外の主要イベントを表示
    if (msg.error) console.log('⚠️ Geminiエラー:', JSON.stringify(msg.error));
    if (msg.serverContent?.turnComplete) console.log('… AIの発話ターン完了');
    if (msg.serverContent?.outputTranscription?.text) {
      console.log('🔊 AI:', msg.serverContent.outputTranscription.text);
    }
    if (msg.serverContent?.inputTranscription?.text) {
      console.log('🎤 あなた:', msg.serverContent.inputTranscription.text);
    }
  });

  gem.on('close', (code, reason) => {
    console.log('Gemini切断:', code, reason.toString());
    if (client.readyState === WebSocket.OPEN) client.close();
  });
  gem.on('error', (e) => console.error('Gemini WSエラー:', e.message));

  // ブラウザ -> Gemini
  let audioCount = 0;
  client.on('message', (data) => {
    const str = data.toString();
    try {
      const m = JSON.parse(str);
      if (m.debug) {
        if (m.debug.micPeak !== undefined) {
          const bar = '█'.repeat(Math.round(m.debug.micPeak / 5)).padEnd(20, '·');
          console.log(`🎚️ マイク音量 [${bar}] ${m.debug.micPeak}`);
        } else {
          console.log('🛠️ ブラウザ情報:', JSON.stringify(m.debug));
        }
        return; // デバッグ情報はGeminiに送らない
      }
      if (m.realtimeInput?.audio) {
        if (++audioCount % 25 === 0) console.log(`📥 ブラウザから音声受信 (${audioCount}個目)`);
      } else {
        console.log('📥 ブラウザから:', Object.keys(m).join(','));
      }
    } catch { /* 無視 */ }
    if (ready) gem.send(str);
    else pending.push(str);
  });
  client.on('close', () => {
    console.log(`🔌 ブラウザ切断（音声 ${audioCount}個受信した）`);
    if (gem.readyState === WebSocket.OPEN) gem.close();
  });
});

server.listen(PORT, () => {
  console.log(`✅ 起動しました → http://localhost:${PORT}`);
  console.log(`   モデル: ${MODEL} / 声: ${VOICE}`);
});
