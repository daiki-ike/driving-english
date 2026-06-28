// ───────── 状態 ─────────
let ws, inCtx, outCtx, micStream, worklet;
let playHead = 0;
const sources = new Set();
let timerId = null;
let seconds = 0;
let wrappedUp = false;

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
  logEl.innerHTML = '';

  outCtx = new AudioContext({ sampleRate: 24000 });
  await outCtx.resume();
  playHead = outCtx.currentTime;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = onWsOpen;
  ws.onmessage = onWsMessage;
  ws.onclose = () => { setStatus('切断しました'); resetUI(); };
  ws.onerror = () => setStatus('接続エラー');
}

async function onWsOpen() {
  try {
    // レートは端末まかせ（worklet側で16kHzに変換する）
    inCtx = new AudioContext();
    ws.send(JSON.stringify({ debug: { inputSampleRate: inCtx.sampleRate } }));
    const audioConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (micSelect.value) audioConstraints.deviceId = { exact: micSelect.value };
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    populateMics(); // 許可後はラベル（マイク名）が取れるので一覧を更新
    const usedLabel = micStream.getAudioTracks()[0]?.label || '不明';
    console.log('使用マイク:', usedLabel);
    ws.send(JSON.stringify({ debug: { usingMic: usedLabel } }));
    await inCtx.audioWorklet.addModule('pcm-processor.js');
    const src = inCtx.createMediaStreamSource(micStream);
    worklet = new AudioWorkletNode(inCtx, 'pcm-processor');
    let sentChunks = 0;
    let levelPeak = 0;
    let lastLevelSend = 0;
    worklet.port.onmessage = (e) => {
      // 音量レベルを計算（話してるのに0なら、そのマイクは声を拾えていない）
      const i16 = new Int16Array(e.data);
      let peak = 0;
      for (let i = 0; i < i16.length; i++) { const a = Math.abs(i16[i]); if (a > peak) peak = a; }
      const lvl = Math.min(100, Math.round((peak / 32768) * 100));
      if (levelBar) levelBar.style.width = lvl + '%';
      if (lvl > levelPeak) levelPeak = lvl;

      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: bufToB64(e.data) } },
        }));
        if (++sentChunks % 20 === 0) console.log('🎤 マイク送信中 chunks=', sentChunks);

        // 1秒に1回、直近のピーク音量をサーバへ（こちらでも声が入ってるか確認できる）
        const now = performance.now();
        if (now - lastLevelSend > 1000) {
          ws.send(JSON.stringify({ debug: { micPeak: levelPeak } }));
          lastLevelSend = now;
          levelPeak = 0;
        }
      }
    };
    src.connect(worklet);
    // 一部ブラウザはグラフがdestinationに繋がっていないと処理を止める。
    // 無音(gain 0)で繋いでグラフを動かし続ける（自分の声は聞こえない）。
    const mute = inCtx.createGain();
    mute.gain.value = 0;
    worklet.connect(mute);
    mute.connect(inCtx.destination);

    stopBtn.disabled = false;
    orb.classList.add('live');
    setStatus('会話できます。話しかけてください 🗣️');
    startTimer();
  } catch (err) {
    setStatus('マイクが使えません: ' + err.message);
    stop();
  }
}

// ───────── Gemini からのメッセージ ─────────
function onWsMessage(ev) {
  let msg;
  try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); }
  catch { return; }

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
  if (timerId) { clearInterval(timerId); timerId = null; }
  stopPlayback();
  try { worklet?.disconnect(); } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  try { inCtx?.close(); } catch {}
  try { outCtx?.close(); } catch {}
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
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
