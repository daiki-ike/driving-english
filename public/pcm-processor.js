// マイク音声を「確実に16kHzの16bit PCM」に変換して main スレッドへ送る AudioWorklet。
// 入力レート(sampleRate)はブラウザ/端末によって 44100 や 48000 になるので、
// ここで線形補間して 16000Hz にダウンサンプルする（これをしないとGeminiが認識できない）。
const TARGET_RATE = 16000;

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // 例: 48000/16000 = 3
    this.buffer = [];
    this.pos = 0;
  }

  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) this.buffer.push(ch[i]);

    // 16kHz相当のサンプルを線形補間で取り出す
    const out = [];
    while (this.pos + 1 < this.buffer.length) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      const s = this.buffer[i0] * (1 - frac) + this.buffer[i0 + 1] * frac;
      out.push(s);
      this.pos += this.ratio;
    }
    const consumed = Math.floor(this.pos);
    if (consumed > 0) {
      this.buffer = this.buffer.slice(consumed);
      this.pos -= consumed;
    }

    if (out.length) {
      const pcm = new Int16Array(out.length);
      for (let i = 0; i < out.length; i++) {
        const v = Math.max(-1, Math.min(1, out[i]));
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
