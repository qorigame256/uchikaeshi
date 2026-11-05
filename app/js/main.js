// 画面の流れと試合の進行・描画。
// 通信の考え方（CLAUDE.md「通信の作り」にも書いてある）:
// - 球は打たれてから次に打たれるまで、決まった動き（まっすぐ＋横の壁で跳ね返る）をする。だから「打った」という知らせ
//   （位置・速さ・向き・打ってからの秒）だけを送れば、両方の画面で同じ動きになる。
// - 打ち返せたか・取りこぼしたかは、球が向かっている側（守る側）の画面で決める。守る側でない画面では、
//   球がゴールの線に着いたらそこで止めて、守る側からの知らせを待つ。
// - 得点・次に出す人・試合の終わりは部屋を作った側（主催者）が決めて、通し番号を付けて送る。
import { Net } from './net.js';
import * as S from './sim.js';
import { Input } from './input.js';
import { Cpu } from './cpu.js';
import * as A from './audio.js';
import { loadProfile, saveProfile } from './profile.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d');
const input = new Input(canvas);
const profile = loadProfile();
A.setVolume(profile.volume);

let net = null;
let isHost = false;
let cpu = null;
let lastProgress = null;
let rtt = 120;          // 往復にかかる時間（ミリ秒）の見積もり
let myAgain = false;
let foeAgain = false;

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const now = () => performance.now();

function newPlayer(i) {
  const h = S.home(i);
  return { x: h.x, y: h.y, tx: h.x, ty: h.y, aim: S.forwardAngle(i), swing: -1, recover: 0, hitDone: false, outsideAtPress: true, name: '' };
}

// phase: 'title' | 'lobby' | 'point'（得点のあとの間）| 'serve'（球を持って構えている）| 'rally' | 'over'
const G = {
  mode: 'cpu', me: 0, phase: 'title', phaseT: 0,
  sc: [0, 0], r: 0, n: 0, srv: 0, over: -1, seq: 0,
  ball: { x: S.W / 2, y: S.L / 2, vx: 0, vy: 0, speed: S.SERVE_SPEED },
  frozen: false, pendingMiss: -1, lastHit: null,
  players: [newPlayer(0), newPlayer(1)],
};
const local = (i) => G.mode === 'cpu' || i === G.me;
const foeIdx = () => 1 - G.me;

// ---------------- 画面の切り替え ----------------
const PANELS = ['title', 'cpuPick', 'lobby', 'settings', 'result'];
function show(id) {
  for (const p of PANELS) $(p).hidden = p !== id;
  const inGame = id === null;
  $('hud').hidden = !inGame;
  input.setEnabled(inGame);
}

const params = new URLSearchParams(location.search);
const joinCode = (params.get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
if (joinCode) {
  $('joinBox').hidden = false;
  $('joinCode').textContent = joinCode;
  $('menuBox').hidden = true;
}

function click(id, fn) { $(id).addEventListener('click', () => { A.unlockAudio(); A.sfxClick(); fn(); }); }

click('btnHost', () => {
  isHost = true;
  G.mode = 'online';
  G.me = 0;
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += abc[Math.floor(Math.random() * abc.length)];
  $('roomCode').textContent = code;
  $('roomUrl').value = location.origin + location.pathname + '?r=' + code;
  $('roomShare').hidden = false;
  show('lobby');
  startNet(code);
});
click('btnJoin', () => {
  isHost = false;
  G.mode = 'online';
  G.me = 1;
  $('roomCode').textContent = joinCode;
  $('roomShare').hidden = true;
  show('lobby');
  startNet(joinCode);
});
click('btnCpu', () => show('cpuPick'));
click('btnCpuBack', () => show('title'));
for (const b of document.querySelectorAll('#cpuLevels button')) {
  b.addEventListener('click', () => { A.unlockAudio(); A.sfxClick(); startCpu(b.dataset.level); });
}
click('btnCopy', async () => {
  try { await navigator.clipboard.writeText($('roomUrl').value); $('btnCopy').textContent = 'コピーした'; }
  catch { $('roomUrl').select(); }
});
const backToTitle = () => { net?.close(); location.href = location.pathname; };
click('btnLeave', backToTitle);
click('btnBack', backToTitle);
click('btnQuit', () => {
  if (G.mode === 'cpu') { G.phase = 'title'; show('title'); return; }
  backToTitle();
});
click('btnAgain', () => {
  if (G.mode === 'cpu') { startMatch(); return; }
  myAgain = true;
  net?.send({ t: 'ag' });
  $('againWait').hidden = false;
  if (isHost && foeAgain) startMatch();
});

// 設定
let settingsFrom = 'title';
function openSettings() {
  settingsFrom = 'title';
  $('setName').value = profile.name;
  $('setVol').value = profile.volume;
  $('setVolV').textContent = Math.round(profile.volume * 100);
  show('settings');
}
click('btnSettings', openSettings);
$('setVol').addEventListener('input', () => {
  profile.volume = Number($('setVol').value);
  $('setVolV').textContent = Math.round(profile.volume * 100);
  A.setVolume(profile.volume);
});
click('btnSettingsClose', () => {
  profile.name = $('setName').value.trim().slice(0, 10);
  saveProfile(profile);
  show(settingsFrom);
});

// ---------------- CPU 戦 ----------------
function startCpu(level) {
  G.mode = 'cpu';
  G.me = 0;
  isHost = true;
  cpu = new Cpu(level);
  G.players[0].name = profile.name || 'あなた';
  G.players[1].name = 'CPU（' + { easy: 'やさしい', normal: 'ふつう', hard: 'つよい' }[level] + '）';
  startMatch();
}

// ---------------- 通信 ----------------
let helloTimer = null;
let resendTimer = null;
let pingTimer = null;
function startNet(code) {
  G.phase = 'lobby';
  net = new Net(code, isHost, {
    onStatus: (t) => { if (t) $('lobbyStatus').textContent = t; },
    onConnected: () => {
      $('lobbyStatus').textContent = 'つながりました';
      sendHello();
      // 中継のときは知らせが落ちることがあるので、試合が始まるまで名乗り直す
      helloTimer = setInterval(() => { if (G.phase === 'lobby') sendHello(); else clearInterval(helloTimer); }, 2000);
      pingTimer = setInterval(() => net.send({ t: 'pi', s: now() }), 1000);
      // 主催者は最後の進行の知らせを2秒ごとに送り直す（参加者は同じ番号を捨てるので、届いていれば何も起きない）
      if (isHost) resendTimer = setInterval(() => { if (lastProgress) net.send(lastProgress); }, 2000);
    },
    onClosed: () => {
      clearInterval(helloTimer); clearInterval(resendTimer); clearInterval(pingTimer);
      alert('相手との通信が切れました');
      backToTitle();
    },
    onMessage,
  });
  net.start();
  G.players[G.me].name = profile.name || 'あなた';
}

function sendHello() { net.send({ t: 'hi', name: profile.name }); }

function onMessage(m) {
  switch (m.t) {
    case 'hi': {
      const nm = typeof m.name === 'string' ? m.name.slice(0, 10) : '';
      G.players[foeIdx()].name = nm || '相手';
      if (isHost && G.phase === 'lobby') startMatch();
      break;
    }
    case 'pt':
      if (isHost || !Number.isInteger(m.q) || m.q <= G.seq) return;
      if (!Array.isArray(m.sc) || !m.sc.every(Number.isInteger) || !Number.isInteger(m.r) || !(m.srv === 0 || m.srv === 1)) return;
      G.seq = m.q;
      applyProgress(m);
      break;
    case 's': {
      const p = G.players[foeIdx()];
      if (num(m.x) && num(m.y)) { p.tx = m.x; p.ty = m.y; S.clampPlayer(foeIdx(), { x: p.tx, y: p.ty }); }
      if (num(m.a)) p.aim = m.a;
      if (num(m.sw) && m.sw >= 0 && p.swing < 0) p.swing = m.sw;
      if (m.lh) applyRemoteHit(m.lh);
      if (isHost && m.ms === G.r) remoteMiss(m.ms);
      break;
    }
    case 'h': applyRemoteHit(m); break;
    case 'ms': if (isHost) remoteMiss(m.r); break;
    case 'pi': net.send({ t: 'po', s: m.s }); break;
    case 'po': if (num(m.s)) rtt = rtt * 0.7 + (now() - m.s) * 0.3; break;
    case 'ag':
      foeAgain = true;
      if (isHost && myAgain) startMatch();
      break;
  }
}

// 相手が打ち返した知らせ。打ってからの秒と通信の遅れの分だけ球を進めて、こちらの画面に置く
function applyRemoteHit(h) {
  // 'point' も受ける: 得点のあとの間はこちらの方が遅れて終わるので、その間に相手が出した球を捨てないため
  if (G.phase !== 'point' && G.phase !== 'serve' && G.phase !== 'rally') return;
  if (G.phase === 'point' && G.over >= 0) return;
  if (h.r !== G.r || !Number.isInteger(h.n) || h.n <= G.n) return;
  if (![h.x, h.y, h.vx, h.vy, h.sp, h.age].every(num)) return;
  if (S.defenderOf(h.vy) !== G.me) return;
  // sp はもとの速さ、vx・vy の長さは飛ぶ速さ（ぴったり打ちの球だけ sp より速い）
  const sp = Math.min(S.JUST_MAX, Math.hypot(h.vx, h.vy));
  const k = sp / Math.max(0.01, Math.hypot(h.vx, h.vy));
  G.n = h.n;
  G.ball = { x: S.clamp(h.x, 0, S.W), y: S.clamp(h.y, 0, S.L), vx: h.vx * k, vy: h.vy * k, speed: sp, base: S.clamp(h.sp, S.SERVE_SPEED, S.MAX_SPEED) };
  const lag = Math.min(0.15, Math.max(0, rtt / 2000));
  S.advance(G.ball, Math.min(0.5, h.age) + lag);
  const wasServe = G.phase === 'serve';
  G.phase = 'rally';
  G.frozen = false;
  G.trail = [];
  const p = G.players[foeIdx()];
  if (p.swing < 0) p.swing = 0.05;
  hitEffects(foeIdx(), !!h.j, wasServe);
}

function remoteMiss(r) {
  if (r !== G.r || G.phase !== 'rally') return;
  pointTo(G.me); // 相手（参加者）が取りこぼした
}

// ---------------- 試合の進行（主催者・CPU 戦） ----------------
function startMatch() {
  myAgain = false;
  foeAgain = false;
  cpu?.reset();
  progress({ st: 1, sc: [0, 0], r: 0, srv: Math.random() < 0.5 ? 0 : 1, over: -1, w: -1 });
}

function progress(m) {
  m.t = 'pt';
  m.q = ++G.seq;
  lastProgress = m;
  applyProgress(m);
  if (G.mode === 'online') net.send(m);
}

function pointTo(w) {
  if (G.phase !== 'rally') return;
  const sc = G.sc.slice();
  sc[w]++;
  const over = sc[w] >= S.WIN_POINTS ? w : -1;
  progress({ sc, r: G.r + 1, srv: 1 - w, over, w });
}

function applyProgress(m) {
  G.sc = m.sc.slice(0, 2);
  G.r = m.r;
  G.n = 0;
  G.srv = m.srv;
  G.over = m.over === 0 || m.over === 1 ? m.over : -1;
  G.phase = 'point';
  G.phaseT = m.st ? 1.8 : 1.3;
  G.frozen = false;
  G.pendingMiss = -1;
  G.lastHit = null;
  if (m.st) {
    for (let i = 0; i < 2; i++) {
      const h = S.home(i);
      Object.assign(G.players[i], { x: h.x, y: h.y, tx: h.x, ty: h.y, aim: S.forwardAngle(i), swing: -1, recover: 0 });
    }
    $('againWait').hidden = true;
    myAgain = false;
    foeAgain = false;
    Object.assign(stats, { bestRally: 0, just: 0, top: 0 });
    tension = 0;
    show(null);
    banner('試合開始　' + S.WIN_POINTS + '点先取', 1.6);
    if (input.touchMode || matchMedia('(pointer: coarse)').matches) { $('touchHint').hidden = false; setTimeout(() => { $('touchHint').hidden = true; }, 5000); }
  } else if (m.w === 0 || m.w === 1) {
    const mine = m.w === G.me;
    A.sfxPoint(mine);
    banner(mine ? '得点！' : '取られた…', 1.2);
    flash = mine ? 0.25 : 0;
  }
  updateHud();
}

function endMatch() {
  G.phase = 'over';
  const win = G.over === G.me;
  A.sfxEnd(win);
  $('resultTitle').textContent = win ? '勝ち！' : '負け';
  $('resultScore').textContent = `${G.players[G.me].name} ${G.sc[G.me]} - ${G.sc[foeIdx()]} ${G.players[foeIdx()].name}`;
  $('resultStats').textContent = `いちばん長いラリー ${stats.bestRally} 回 ・ ぴったり打ち ${stats.just} 回 ・ 最高 ${Math.round(stats.top * 3.6)} km/h`;
  $('againWait').hidden = true;
  show('result');
}

// ---------------- 動き ----------------
const stats = { bestRally: 0, just: 0, top: 0 };
function canSwing(p) { return p.swing < 0 && p.recover <= 0; }

function holdPos(i) {
  const p = G.players[i];
  const a = S.clampAim(i, p.aim);
  return { x: S.clamp(p.x + Math.cos(a) * 0.75, S.BALL_R, S.W - S.BALL_R), y: p.y + Math.sin(a) * 0.75 };
}

function startSwing(i) {
  const p = G.players[i];
  if (!canSwing(p)) return;
  p.swing = 0;
  p.hitDone = false;
  p.outsideAtPress = Math.hypot(G.ball.x - p.x, G.ball.y - p.y) > S.REACH + S.BALL_R;
  if (i === G.me) A.sfxSwing();
  if (G.phase === 'serve' && G.srv === i) serveBall(i);
  if (G.mode === 'online' && i === G.me) sendState(true);
}

// base はもとの速さ。飛ぶ速さはぴったり打ちのときだけ速くなる（sim.js の flightSpeed）
function launch(i, base, just) {
  const p = G.players[i];
  p.hitDone = true;
  const a = S.clampAim(i, p.aim);
  const b = G.ball;
  const speed = S.flightSpeed(base, just);
  b.vx = Math.cos(a) * speed;
  b.vy = Math.sin(a) * speed;
  b.speed = speed;
  b.base = base;
  G.n++;
  G.lastHit = { r: G.r, n: G.n, x: b.x, y: b.y, vx: b.vx, vy: b.vy, sp: base, j: just, by: i, at: now() };
  if (G.mode === 'online' && i === G.me) net.send({ t: 'h', ...hitMsg() });
}

function hitMsg() {
  const h = G.lastHit;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { r: h.r, n: h.n, x: r3(h.x), y: r3(h.y), vx: r3(h.vx), vy: r3(h.vy), sp: r3(h.sp), j: h.j ? 1 : 0, age: r3((now() - h.at) / 1000) };
}

function serveBall(i) {
  Object.assign(G.ball, holdPos(i));
  G.phase = 'rally';
  G.n = 0;
  G.trail = [];
  launch(i, S.SERVE_SPEED, false);
  hitEffects(i, false, true);
}

function checkHit(i) {
  const p = G.players[i];
  if (p.swing < 0 || p.hitDone) return;
  if (Math.hypot(G.ball.x - p.x, G.ball.y - p.y) > S.REACH + S.BALL_R) return;
  const just = p.swing <= S.JUST_WINDOW && p.outsideAtPress;
  launch(i, S.nextSpeed(G.ball.base ?? G.ball.speed), just);
  hitEffects(i, just, false);
}

function miss(d) {
  G.frozen = true;
  if (G.mode === 'cpu' || isHost) { pointTo(1 - d); return; }
  G.pendingMiss = G.r;
  net.send({ t: 'ms', r: G.r });
}

function movePlayer(i, mv, dt) {
  const p = G.players[i];
  if (p.recover > 0) return;
  const k = p.swing >= 0 ? 0.6 : 1; // 振っている間は少し遅い
  p.x += mv.x * S.MOVE_SPEED * k * dt;
  p.y += mv.y * S.MOVE_SPEED * k * dt;
  S.clampPlayer(i, p);
}

function tickSwing(p, dt) {
  if (p.swing >= 0) {
    p.swing += dt;
    if (p.swing > S.SWING_TIME) { p.swing = -1; p.recover = S.RECOVER_TIME; }
  } else if (p.recover > 0) p.recover = Math.max(0, p.recover - dt);
}

let sendAcc = 0;
let wallSfxT = 0;
G.trail = [];

function update(dt) {
  const playing = G.phase === 'point' || G.phase === 'serve' || G.phase === 'rally';
  if (!playing) return;
  const me = G.players[G.me];

  // 自分の操作
  const mv = input.move();
  movePlayer(G.me, screenDirToWorld(mv), dt);
  if (input.touchMode) {
    me.aim = input.flickDir ? screenAngleToWorld(Math.atan2(input.flickDir.y, input.flickDir.x)) : S.forwardAngle(G.me);
  } else if (input.mouse) {
    const w = toWorld(input.mouse.x, input.mouse.y);
    me.aim = Math.atan2(w.y - me.y, w.x - me.x);
  }
  me.aim = S.clampAim(G.me, me.aim);
  if (input.consumeSwing()) startSwing(G.me);

  // CPU
  if (cpu && G.mode === 'cpu') {
    const c = G.players[1];
    const out = cpu.update(dt, G, c, G.players[0]);
    movePlayer(1, out.move, dt);
    c.aim = S.clampAim(1, out.aim);
    if (out.swing) startSwing(1);
  }

  for (let i = 0; i < 2; i++) {
    const p = G.players[i];
    tickSwing(p, dt);
    if (!local(i)) {
      // 相手の位置は届いた所へなめらかに寄せる
      const k = 1 - Math.exp(-dt * 18);
      p.x += (p.tx - p.x) * k;
      p.y += (p.ty - p.y) * k;
    }
  }

  if (G.phase === 'point') {
    G.phaseT -= dt;
    if (G.phaseT <= 0) {
      if (G.over >= 0) { endMatch(); return; }
      G.phase = 'serve';
      G.phaseT = 0;
      rally = 0;
    }
  } else if (G.phase === 'serve') {
    Object.assign(G.ball, holdPos(G.srv));
    G.phaseT += dt;
    if (local(G.srv) && G.phaseT > S.AUTO_SERVE) {
      G.players[G.srv].aim = S.forwardAngle(G.srv);
      startSwing(G.srv);
    }
  } else if (G.phase === 'rally' && !G.frozen) {
    const steps = Math.ceil(dt / S.STEP);
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      if (S.stepBall(G.ball, sdt) && wallSfxT <= 0) { A.sfxWall(); wallSfxT = 0.05; }
      const d = S.defenderOf(G.ball.vy);
      if (local(d)) checkHit(d);
      const gone = d === 0 ? G.ball.y >= S.L : G.ball.y <= 0;
      if (gone) {
        G.ball.y = S.clamp(G.ball.y, 0, S.L);
        if (local(d)) miss(d);
        else G.frozen = true; // 守る側からの知らせを待つ
        break;
      }
      if (G.phase !== 'rally') break;
    }
  }
  wallSfxT -= dt;
  tickTension(dt);

  if (G.phase === 'rally' || G.phase === 'serve') {
    G.trail.push({ x: G.ball.x, y: G.ball.y });
    if (G.trail.length > 16) G.trail.shift();
  }

  if (G.mode === 'online') {
    sendAcc += dt;
    if (sendAcc >= 0.05) sendState(false);
  }
  updateHud();
}

function sendState() {
  sendAcc = 0;
  const p = G.players[G.me];
  const r2 = (v) => Math.round(v * 100) / 100;
  const m = { t: 's', x: r2(p.x), y: r2(p.y), a: r2(p.aim), sw: p.swing >= 0 ? r2(p.swing) : -1 };
  // 自分が最後に打った知らせを毎回添える（中継で知らせが落ちても、次の便で追いつけるように）
  if (G.lastHit && G.lastHit.by === G.me && G.lastHit.r === G.r && G.n === G.lastHit.n) m.lh = hitMsg();
  if (G.pendingMiss === G.r) m.ms = G.r;
  net.send(m);
}

// ---------------- 演出 ----------------
let flash = 0;
let shake = 0;
let rally = 0;
// 緊迫感の演出（見た目と音だけ。試合の動きには関わらない。数字は Claude の値）
let tension = 0;   // 0〜1。球の速さに遅れて付いていく
let heartT = 0;    // 次の鼓動までの秒
const speedRatio = () => S.clamp((G.ball.speed - S.SERVE_SPEED) / (S.MAX_SPEED - S.SERVE_SPEED), 0, 1);

function tickTension(dt) {
  const target = G.phase === 'rally' ? speedRatio() : 0;
  // 上がるときは素早く、点が決まったあとはゆっくり引く
  tension += (target - tension) * (1 - Math.exp(-dt * (target > tension ? 6 : 1.2)));
  // 鼓動は打ち合いの間だけ。間隔は遅い球 1.5 秒 → 上限の速さ 0.75 秒
  // （最初の 0.95〜0.35 秒は本人が遊んで「うるさすぎる」と言ったので、2026-11-05 本人決定でペースを下げた）
  if (G.phase === 'rally' && !G.frozen) {
    heartT -= dt;
    if (heartT <= 0) {
      A.sfxHeart(speedRatio());
      heartT = 1.5 - 0.75 * speedRatio();
    }
  } else heartT = 0.4;
}
const parts = [];
const floats = [];

function hitEffects(i, just, isServe) {
  const b = G.ball;
  const ratio = (b.speed - S.SERVE_SPEED) / (S.MAX_SPEED - S.SERVE_SPEED);
  if (isServe) { A.sfxServe(); rally = 0; } else { A.sfxHit(ratio, just); rally++; }
  stats.bestRally = Math.max(stats.bestRally, rally);
  stats.top = Math.max(stats.top, b.speed);
  if (just && i === G.me) stats.just++;
  const n = just ? 26 : 10;
  for (let k = 0; k < n; k++) {
    const a = Math.random() * Math.PI * 2;
    const s = (just ? 6 : 3) * (0.4 + Math.random());
    parts.push({ x: b.x, y: b.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.3, hue: just ? 50 : ballHue(ratio) });
  }
  if (just) {
    shake = i === G.me ? 0.25 : 0.12;
    flash = Math.max(flash, i === G.me ? 0.35 : 0.15);
    floats.push({ x: b.x, y: b.y, text: 'ぴったり！', life: 0.9 });
  }
}

function ballHue(ratio) { return 190 + Math.max(0, Math.min(1, ratio)) * 130; }

let bannerTimer = null;
function banner(text, sec) {
  const el = $('banner');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('on'), sec * 1000);
}

function updateHud() {
  const me = G.players[G.me];
  const foe = G.players[foeIdx()];
  $('scoreMe').textContent = G.sc[G.me];
  $('scoreFoe').textContent = G.sc[foeIdx()];
  $('nameMe').textContent = me.name;
  $('nameFoe').textContent = foe.name;
  $('netMode').textContent = G.mode === 'online' && net ? net.modeLabel : '';
  const sp = G.phase === 'rally' ? Math.round(G.ball.speed * 3.6) : 0;
  $('speed').textContent = sp ? `${sp} km/h ・ ${rally} 回` : '';
  const serveHint = G.phase === 'serve' && G.srv === G.me;
  $('serveHint').hidden = !serveHint;
}

// ---------------- 描画 ----------------
let view = { sc: 30, ox: 0, oy: 0, w: 0, h: 0 };

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = innerWidth;
  const h = innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const top = 56;
  const bottom = 34;
  const sc = Math.min((w - 24) / S.W, (h - top - bottom) / S.L);
  view = { sc, ox: (w - S.W * sc) / 2, oy: top + (h - top - bottom - S.L * sc) / 2, w, h };
}
addEventListener('resize', resize);
resize();

// 自分のゴールがいつも画面の下に来るよう、1番の人は上下左右を反対にして見る
function toScreen(x, y) {
  if (G.me === 1) { x = S.W - x; y = S.L - y; }
  return { x: view.ox + x * view.sc, y: view.oy + y * view.sc };
}
function toWorld(sx, sy) {
  let x = (sx - view.ox) / view.sc;
  let y = (sy - view.oy) / view.sc;
  if (G.me === 1) { x = S.W - x; y = S.L - y; }
  return { x, y };
}
function screenDirToWorld(v) { return G.me === 1 ? { x: -v.x, y: -v.y } : v; }
function screenAngleToWorld(a) { return G.me === 1 ? a + Math.PI : a; }
function worldAngleToScreen(a) { return G.me === 1 ? a + Math.PI : a; }

function render(dt) {
  const { w, h, sc } = view;
  ctx.fillStyle = '#04050b';
  ctx.fillRect(0, 0, w, h);
  if (G.phase === 'title' || G.phase === 'lobby') { drawIdle(); return; }

  ctx.save();
  if (shake > 0) {
    const s = shake * 14;
    ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }
  const tl = toScreen(G.me === 1 ? S.W : 0, G.me === 1 ? S.L : 0);
  const aw = S.W * sc;
  const ah = S.L * sc;

  // 床
  const g = ctx.createLinearGradient(0, tl.y, 0, tl.y + ah);
  g.addColorStop(0, '#140a1c');
  g.addColorStop(0.5, '#090b16');
  g.addColorStop(1, '#071420');
  ctx.fillStyle = g;
  ctx.fillRect(tl.x, tl.y, aw, ah);
  ctx.strokeStyle = 'rgba(120,160,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < S.W; i++) line(tl.x + i * sc, tl.y, tl.x + i * sc, tl.y + ah);
  for (let i = 1; i < S.L; i++) line(tl.x, tl.y + i * sc, tl.x + aw, tl.y + i * sc);

  // 真ん中の線
  ctx.setLineDash([sc * 0.3, sc * 0.25]);
  ctx.strokeStyle = 'rgba(200,220,255,0.35)';
  ctx.lineWidth = 2;
  line(tl.x, tl.y + ah / 2, tl.x + aw, tl.y + ah / 2);
  ctx.setLineDash([]);

  // 横の壁とゴール（自分のゴールは下・青、相手のゴールは上・赤）
  glow('#5cf', 12, () => { ctx.lineWidth = 3; line(tl.x, tl.y, tl.x, tl.y + ah); line(tl.x + aw, tl.y, tl.x + aw, tl.y + ah); });
  glow('#3af', 18, () => { ctx.lineWidth = 5; line(tl.x, tl.y + ah, tl.x + aw, tl.y + ah); });
  glow('#f58', 18, () => { ctx.lineWidth = 5; line(tl.x, tl.y, tl.x + aw, tl.y); });

  // 人
  for (let i = 0; i < 2; i++) drawPlayer(i);

  // 球の尾と球
  if (G.phase === 'rally' || G.phase === 'serve') {
    const ratio = (G.ball.speed - S.SERVE_SPEED) / (S.MAX_SPEED - S.SERVE_SPEED);
    const hue = ballHue(ratio);
    for (let k = 1; k < G.trail.length; k++) {
      const a = toScreen(G.trail[k - 1].x, G.trail[k - 1].y);
      const b = toScreen(G.trail[k].x, G.trail[k].y);
      ctx.strokeStyle = `hsla(${hue},100%,65%,${(k / G.trail.length) * 0.6})`;
      ctx.lineWidth = S.BALL_R * sc * 2 * (k / G.trail.length);
      ctx.lineCap = 'round';
      line(a.x, a.y, b.x, b.y);
    }
    const p = toScreen(G.ball.x, G.ball.y);
    const light = 60 + Math.max(0, ratio) * 30;
    glow(`hsl(${hue},100%,${light}%)`, 18 + ratio * 30, () => {
      ctx.fillStyle = `hsl(${hue},100%,${light}%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, S.BALL_R * sc * (1 + ratio * 0.3), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, S.BALL_R * sc * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 火花
  for (let k = parts.length - 1; k >= 0; k--) {
    const q = parts[k];
    q.life -= dt;
    if (q.life <= 0) { parts.splice(k, 1); continue; }
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.vx *= 0.92;
    q.vy *= 0.92;
    const s = toScreen(q.x, q.y);
    ctx.fillStyle = `hsla(${q.hue},100%,70%,${Math.min(1, q.life * 2)})`;
    ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
  }
  // 浮かぶ文字
  ctx.textAlign = 'center';
  for (let k = floats.length - 1; k >= 0; k--) {
    const f = floats[k];
    f.life -= dt;
    if (f.life <= 0) { floats.splice(k, 1); continue; }
    const s = toScreen(f.x, f.y);
    ctx.font = `bold ${Math.round(sc * 0.75)}px system-ui, sans-serif`;
    ctx.fillStyle = `rgba(255,240,120,${Math.min(1, f.life * 2)})`;
    ctx.fillText(f.text, s.x, s.y - (0.9 - f.life) * sc * 1.5 - sc * 0.6);
  }
  ctx.restore();
  drawTension(tl, aw, ah);

  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flash * 0.5})`;
    ctx.fillRect(0, 0, w, h);
  }
  flash = Math.max(0, flash - dt * 1.5);
  shake = Math.max(0, shake - dt);
}

// 球が速いほど画面の周りが暗く狭まる。
// 闘技場の中は暗くしない（球や相手が見えにくくなると腕前の勝負でなくなるため）。
// 縁が赤く脈打つ演出もあったが、本人が「チカチカしてまぶしい」と言ったので 2026-11-05 に外した（戻さない）
function drawTension(tl, aw, ah) {
  if (tension < 0.02) return;
  const { w, h } = view;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.rect(tl.x, tl.y, aw, ah);
  ctx.clip('evenodd');
  const R = Math.hypot(w, h) / 2;
  const inner = R + (Math.max(aw, ah) * 0.55 - R) * tension; // 速いほど暗い所が内側へ寄ってくる
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.max(0, inner), w / 2, h / 2, R);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${0.92 * tension})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function drawPlayer(i) {
  const p = G.players[i];
  const sc = view.sc;
  const s = toScreen(p.x, p.y);
  const mine = i === G.me;
  const col = mine ? '#4df' : '#f7a';
  const a = worldAngleToScreen(S.clampAim(i, p.aim));
  const ready = canSwing(p);

  // 剣の届く範囲（構えているときだけ薄く出す）
  if (ready) {
    ctx.strokeStyle = mine ? 'rgba(80,220,255,0.18)' : 'rgba(255,120,170,0.14)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, (S.REACH + S.BALL_R) * sc, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 振っている剣
  if (p.swing >= 0) {
    const t = p.swing / S.SWING_TIME;
    glow(col, 20, () => {
      ctx.strokeStyle = mine ? `rgba(150,240,255,${1 - t * 0.7})` : `rgba(255,160,200,${1 - t * 0.7})`;
      ctx.lineWidth = sc * 0.22;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(s.x, s.y, S.REACH * sc * 0.92, a - 1.0, a + 1.0);
      ctx.stroke();
    });
  }
  // 体
  ctx.globalAlpha = p.recover > 0 ? 0.55 : 1;
  glow(col, 16, () => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(s.x, s.y, S.PLAYER_R * sc, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#04050b';
  ctx.beginPath();
  ctx.arc(s.x, s.y, S.PLAYER_R * sc * 0.55, 0, Math.PI * 2);
  ctx.fill();
  // 向いている方
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  line(s.x + Math.cos(a) * S.PLAYER_R * sc * 0.6, s.y + Math.sin(a) * S.PLAYER_R * sc * 0.6,
    s.x + Math.cos(a) * S.PLAYER_R * sc * 1.5, s.y + Math.sin(a) * S.PLAYER_R * sc * 1.5);
  ctx.globalAlpha = 1;
  // ねらいの線（自分だけ）
  if (mine && ready) {
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(120,230,255,0.35)';
    ctx.lineWidth = 1.5;
    line(s.x, s.y, s.x + Math.cos(a) * sc * 3.2, s.y + Math.sin(a) * sc * 3.2);
    ctx.setLineDash([]);
  }
}

function drawIdle() {
  // タイトルの後ろでゆっくり球が跳ね回る
  const t = now() / 1000;
  const { w, h } = view;
  for (let k = 0; k < 3; k++) {
    const x = w / 2 + Math.sin(t * (0.5 + k * 0.17) + k) * w * 0.4;
    const y = h / 2 + Math.cos(t * (0.4 + k * 0.13) + k * 2) * h * 0.4;
    glow(`hsl(${190 + k * 60},100%,60%)`, 30, () => {
      ctx.fillStyle = `hsl(${190 + k * 60},100%,60%)`;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
function glow(color, blur, fn) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.strokeStyle = color;
  fn();
  ctx.restore();
}

// ---------------- 毎フレーム ----------------
let lastT = now();
function frame(t) {
  const dt = Math.min(0.05, Math.max(0, (t - lastT) / 1000));
  lastT = t;
  update(dt);
  render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 確かめる用（ブラウザの開発ツールから様子を見る）
window.__game = { G, input, update, startSwing, stats };
