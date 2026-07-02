// ───────── 状態 ─────────
let ws, inCtx, outCtx, micStream, worklet;
let playHead = 0;
const sources = new Set();
let timerId = null;
let seconds = 0;
let wrappedUp = false;

// 運転中の安定運用まわり
let sessionActive = false;   // 「はじめる」〜「おわる」の間 true
let wakeLock = null;         // 画面スリープ防止
let reconnectTimer = null;   // 再接続待ちタイマー
let reconnectAttempts = 0;
let heartbeatTimer = null;   // 生存確認
let lastPong = 0;            // 最後にサーバから応答が来た時刻

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const orb = document.getElementById('orb');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const logEl = document.getElementById('log');
const micSelect = document.getElementById('micSelect');
const levelBar = document.getElementById('levelBar');
const testMicBtn = document.getElementById('testMicBtn');

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
testMicBtn.addEventListener('click', toggleMicTest);
// マイクを選び直したら、テスト中なら自動でそのマイクに切り替えてテストし直す
micSelect.addEventListener('change', () => { userPickedMic = true; if (testCtx) { stopMicTest(); toggleMicTest(); } });

function setStatus(t) { statusEl.textContent = t; }

// ───────── マイク単体テスト（Geminiと無関係に、生のマイク音量を見る）─────────
let testCtx, testStream, testRAF;
async function toggleMicTest() {
  if (testCtx) { stopMicTest(); return; }
  try {
    testCtx = new AudioContext();
    await testCtx.resume();
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (micSelect.value) audio.deviceId = { exact: micSelect.value };
    testStream = await navigator.mediaDevices.getUserMedia({ audio });
    populateMics();
    const label = testStream.getAudioTracks()[0]?.label || '不明';
    setStatus('テスト中: ' + label + ' に話しかけて');
    testMicBtn.textContent = '⏹ テストをやめる';
    testMicBtn.classList.add('active');

    const src = testCtx.createMediaStreamSource(testStream);
    const analyser = testCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
      levelBar.style.width = Math.min(100, Math.round((peak / 128) * 100)) + '%';
      testRAF = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    setStatus('マイクが開けません: ' + e.message);
    stopMicTest();
  }
}
function stopMicTest() {
  if (testRAF) cancelAnimationFrame(testRAF);
  testStream?.getTracks().forEach((t) => t.stop());
  try { testCtx?.close(); } catch {}
  testCtx = testStream = testRAF = null;
  levelBar.style.width = '0%';
  testMicBtn.textContent = '🎤 マイクをテスト';
  testMicBtn.classList.remove('active');
}

// 仮想ケーブル/ループバック系（声が入らない）を判別する
const FAKE_MIC = /cable|virtual|mix|ミキサ|stereo|loopback|出力|output|wave|voicemeeter/i;
let userPickedMic = false;

// 使えるマイク一覧をメニューに並べる（本物のマイクを既定で選ぶ）
async function populateMics() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    const cur = micSelect.value;
    micSelect.innerHTML = '';
    mics.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `マイク ${i + 1}`;
      if (FAKE_MIC.test(d.label)) o.textContent += ' ⚠️仮想(声入らない)';
      micSelect.appendChild(o);
    });
    if (cur && mics.some((d) => d.deviceId === cur)) {
      micSelect.value = cur;
    } else if (!userPickedMic) {
      // 仮想ケーブルを避けて本物のマイクを既定にする
      const real = mics.find((d) => /mic|マイク/i.test(d.label) && !FAKE_MIC.test(d.label))
        || mics.find((d) => d.deviceId !== 'default' && !FAKE_MIC.test(d.label))
        || mics.find((d) => !FAKE_MIC.test(d.label));
      if (real) micSelect.value = real.deviceId;
    }
  } catch (e) { console.warn('マイク一覧の取得に失敗', e); }
}
populateMics();
navigator.mediaDevices.addEventListener?.('devicechange', populateMics);

// ───────── 開始 ─────────
async function start() {
  stopMicTest(); // テスト中なら止めてデバイスを解放
  startBtn.disabled = true;
  setStatus('つないでいます…');
  seconds = 0; wrappedUp = false;
  reconnectAttempts = 0;
  logEl.innerHTML = '';
  sessionActive = true;

  outCtx = new AudioContext({ sampleRate: 24000 });
  await outCtx.resume();
  playHead = outCtx.currentTime;

  await requestWakeLock(); // 会話中は画面を消させない

  try {
    await setupMic();      // マイクは1回だけ用意（再接続では作り直さない）
  } catch (err) {
    setStatus('マイクが使えません: ' + err.message);
    stop();
    return;
  }

  // サーバが寝てる場合、先にHTTPで起こしておく（WS接続より起床に向いている）
  await prewarmServer();
  connect(false);
}

// サーバがスリープしていたら起こす。最大45秒待つが、失敗してもWS接続は試みる。
async function prewarmServer() {
  setStatus('サーバを起こしています…（最大1分）');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    await fetch('/', { cache: 'no-store', signal: ctrl.signal });
  } catch (e) {
    console.warn('起床フェッチ失敗（そのままWS接続を試みます）', e.message);
  } finally {
    clearTimeout(timer);
  }
}

// マイク準備（1セッションで1回だけ）
async function setupMic() {
  inCtx = new AudioContext();
  const audioConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (micSelect.value) audioConstraints.deviceId = { exact: micSelect.value };
  micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  populateMics();
  console.log('使用マイク:', micStream.getAudioTracks()[0]?.label || '不明');
  await inCtx.audioWorklet.addModule('pcm-processor.js');
  const src = inCtx.createMediaStreamSource(micStream);
  worklet = new AudioWorkletNode(inCtx, 'pcm-processor');
  let sentChunks = 0, levelPeak = 0, lastLevelSend = 0;
  worklet.port.onmessage = (e) => {
    const i16 = new Int16Array(e.data);
    let peak = 0;
    for (let i = 0; i < i16.length; i++) { const a = Math.abs(i16[i]); if (a > peak) peak = a; }
    const lvl = Math.min(100, Math.round((peak / 32768) * 100));
    if (levelBar) levelBar.style.width = lvl + '%';
    if (lvl > levelPeak) levelPeak = lvl;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: bufToB64(e.data) } } }));
      if (++sentChunks % 20 === 0) console.log('🎤 chunks=', sentChunks);
      const now = performance.now();
      if (now - lastLevelSend > 1000) { ws.send(JSON.stringify({ debug: { micPeak: levelPeak } })); lastLevelSend = now; levelPeak = 0; }
    }
  };
  src.connect(worklet);
  // 一部ブラウザはグラフがdestinationに繋がっていないと処理を止める→無音で繋いで動かし続ける
  const mute = inCtx.createGain();
  mute.gain.value = 0;
  worklet.connect(mute);
  mute.connect(inCtx.destination);
}

// WebSocket接続（初回 or 再接続）。OSのTCPタイムアウト任せにせず、自前で見切りを付ける。
function connect(isReconnect) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/${isReconnect ? '?greet=0' : ''}`);
  let settled = false;
  const connectTimeoutMs = isReconnect ? 10000 : 15000; // prewarm済みなので初回もそう長くは待たない
  const giveUpTimer = setTimeout(() => {
    if (settled) return;
    console.warn('接続がタイムアウトしたので見切りをつけます');
    try { ws.close(); } catch {}
  }, connectTimeoutMs);

  ws.onopen = () => {
    settled = true;
    clearTimeout(giveUpTimer);
    reconnectAttempts = 0;
    lastPong = Date.now();
    ws.send(JSON.stringify({ debug: { inputSampleRate: inCtx?.sampleRate, usingMic: micStream?.getAudioTracks()[0]?.label } }));
    stopBtn.disabled = false;
    orb.classList.add('live');
    setStatus(isReconnect ? '再接続しました 🗣️' : '会話できます。話しかけてください 🗣️');
    if (!timerId) startTimer();
    startHeartbeat();
  };
  ws.onmessage = onWsMessage;
  ws.onclose = () => { settled = true; clearTimeout(giveUpTimer); stopHeartbeat(); if (sessionActive) scheduleReconnect(); else resetUI(); };
  ws.onerror = () => { /* onclose が続けて呼ばれるのでそちらで処理 */ };
}

// 電波が切れた時 / 接続に失敗した時：短い間隔で自動的に繋ぎ直す（会話中のみ）
function scheduleReconnect() {
  if (!sessionActive || reconnectTimer) return;
  orb.classList.remove('live');
  setStatus('接続中… 📶（サーバが起きるまで少しお待ちください）');
  const delay = Math.min(500 * Math.pow(1.6, reconnectAttempts), 5000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (sessionActive) connect(true); }, delay);
}

// 生存確認：4秒ごとにpingを送り、12秒応答が無ければ「固まってる」とみなして繋ぎ直す
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ping: Date.now() }));
      if (Date.now() - lastPong > 12000) {
        console.warn('応答なし→接続を張り直します');
        try { ws.close(); } catch {}
      }
    }
  }, 4000);
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

// 画面スリープ防止
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      console.log('画面スリープ防止 ON');
    }
  } catch (e) { console.warn('画面スリープ防止に失敗', e); }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

// アプリに戻ってきた時：画面ロック復帰・通信復活・音声再開
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !sessionActive) return;
  if (!wakeLock) await requestWakeLock();
  try { await outCtx?.resume(); } catch {}
  try { await inCtx?.resume(); } catch {}
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) scheduleReconnect();
});

// ───────── Gemini からのメッセージ ─────────
function onWsMessage(ev) {
  let msg;
  try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); }
  catch { return; }

  if (msg.pong) { lastPong = Date.now(); return; } // 生存確認の応答

  if (msg.error) {
    console.error('Geminiエラー:', msg.error);
    setStatus('エラー: ' + JSON.stringify(msg.error));
    return;
  }

  const sc = msg.serverContent;
  if (!sc) return;

  if (sc.interrupted) stopPlayback(); // 割り込み（バージイン）したら再生を止める

  let gotAudio = false;
  for (const p of sc.modelTurn?.parts || []) {
    if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('audio/pcm')) {
      playPcm(p.inlineData.data);
      gotAudio = true;
    }
  }
  if (gotAudio) setStatus('AIが話しています 🔊');
  if (sc.turnComplete) setStatus('どうぞ話してください 🗣️');

  if (sc.inputTranscription?.text) { appendLog('you', sc.inputTranscription.text); console.log('🎤', sc.inputTranscription.text); }
  if (sc.outputTranscription?.text) { appendLog('ai', sc.outputTranscription.text); console.log('🔊', sc.outputTranscription.text); }
}

// ───────── 再生（24kHz PCM を順番にスケジュール）─────────
function playPcm(b64) {
  const bytes = b64ToBytes(b64);
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const buf = outCtx.createBuffer(1, f32.length, 24000);
  buf.copyToChannel(f32, 0);
  const node = outCtx.createBufferSource();
  node.buffer = buf;
  node.connect(outCtx.destination);

  const t = Math.max(playHead, outCtx.currentTime);
  node.start(t);
  playHead = t + buf.duration;
  sources.add(node);
  node.onended = () => sources.delete(node);
}

function stopPlayback() {
  for (const n of sources) { try { n.stop(); } catch {} }
  sources.clear();
  if (outCtx) playHead = outCtx.currentTime;
}

// ───────── 5分タイマー → 自動ラップアップ ─────────
function startTimer() {
  timerId = setInterval(() => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
    if (seconds >= 300 && !wrappedUp) wrapUp();
  }, 1000);
}

function wrapUp() {
  wrappedUp = true;
  setStatus('5分たちました。まとめます…');
  ws?.send(JSON.stringify({
    clientContent: {
      turns: [{ role: 'user', parts: [{ text: "Okay, let's wrap up now. Please give me my recap." }] }],
      turnComplete: true,
    },
  }));
}

// ───────── 終了 ─────────
function stop() {
  sessionActive = false; // これ以降は自動再接続しない
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHeartbeat();
  releaseWakeLock();
  if (timerId) { clearInterval(timerId); timerId = null; }
  stopPlayback();
  try { worklet?.disconnect(); } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  try { inCtx?.close(); } catch {}
  try { outCtx?.close(); } catch {}
  if (ws) { try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch {} ws = null; }
  resetUI();
  setStatus('終了しました。おつかれさまでした');
}

function resetUI() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  orb.classList.remove('live');
}

// ───────── ログ（運転後の振り返り用）─────────
function appendLog(who, text) {
  const last = logEl.lastElementChild;
  if (last && last.dataset.who === who) { last.querySelector('.t').textContent += text; return; }
  const row = document.createElement('div');
  row.className = 'row ' + who;
  row.dataset.who = who;
  row.innerHTML = `<span class="who">${who === 'you' ? 'あなた' : 'AI'}</span><span class="t">${text}</span>`;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

// ───────── base64 ヘルパー ─────────
function bufToB64(arrbuf) {
  const bytes = new Uint8Array(arrbuf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
