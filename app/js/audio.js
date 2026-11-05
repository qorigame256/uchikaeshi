// 効果音をその場で合成する（音のファイルを持たない）。
let ctx = null;
let master = null;
let volume = 0.8;

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function setVolume(v) {
  volume = v;
  if (master) master.gain.value = v;
}

function tone(freq, dur, { type = 'sine', gain = 0.3, slide = 0, delay = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur, { gain = 0.25, freq = 2000, q = 1, delay = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

// 打ち返した音。速い球ほど高く、ぴったり打ちは派手に
export function sfxHit(ratio, just) {
  const base = 300 + ratio * 500;
  tone(base, 0.12, { type: 'square', gain: 0.18, slide: 0.5 });
  noise(0.08, { gain: 0.3, freq: 3000 + ratio * 3000, q: 0.7 });
  if (just) {
    tone(base * 2, 0.35, { type: 'sawtooth', gain: 0.12, slide: 1.5 });
    tone(base * 3, 0.4, { type: 'triangle', gain: 0.15, delay: 0.03 });
    noise(0.25, { gain: 0.35, freq: 6000, q: 0.5 });
  }
}

// 鼓動（ドクン・ドクン）。打ち合いの間に鳴らし、球が速いほど大きくする。
// 低い音だけだとスマホやノートPCの小さなスピーカーで聞こえないので、1つ上の高さの音を少し重ねる
// 大きさは最初 0.16〜0.42 だったが、本人が遊んで「うるさすぎる」と言ったので 2026-11-05 に約3分の1へ下げた（本人決定。数字は Claude の値）
export function sfxHeart(ratio) {
  const g = 0.055 + ratio * 0.085;
  tone(72, 0.16, { type: 'sine', gain: g, slide: 0.6 });
  tone(144, 0.07, { type: 'triangle', gain: g * 0.35, slide: 0.5 });
  tone(64, 0.18, { type: 'sine', gain: g * 0.75, slide: 0.6, delay: 0.15 });
  tone(128, 0.07, { type: 'triangle', gain: g * 0.25, slide: 0.5, delay: 0.15 });
}

export const sfxSwing =() => noise(0.12, { gain: 0.12, freq: 1200, q: 0.6 });
export const sfxWall = () => tone(900, 0.05, { type: 'triangle', gain: 0.1 });
export const sfxServe = () => tone(500, 0.15, { type: 'triangle', gain: 0.2, slide: 1.6 });

export function sfxPoint(good) {
  if (good) {
    tone(660, 0.15, { type: 'triangle', gain: 0.22 });
    tone(990, 0.25, { type: 'triangle', gain: 0.22, delay: 0.1 });
  } else {
    tone(300, 0.3, { type: 'sawtooth', gain: 0.15, slide: 0.5 });
    noise(0.3, { gain: 0.2, freq: 400, q: 0.5 });
  }
}

export function sfxEnd(win) {
  const notes = win ? [523, 659, 784, 1047] : [440, 392, 330, 262];
  notes.forEach((f, i) => tone(f, 0.3, { type: 'triangle', gain: 0.2, delay: i * 0.13 }));
}

export const sfxClick = () => tone(700, 0.05, { type: 'triangle', gain: 0.12 });
