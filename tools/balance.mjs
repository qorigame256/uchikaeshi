// CPU どうしを画面なしで何試合も戦わせて、手ごたえの見当になる数字を測る。
// 使い方: node tools/balance.mjs [1組あたりの試合数（既定 200）]
//   数字を試しに変えて測る: BAL_SET="RECOVER_TIME=0.25,MOVE_SPEED=6.5" node tools/balance.mjs
//   （sim.js の `export const 名前 = 値;` を書き換えた写しを一時フォルダに作って読む。app/ のファイルは変えない）
//   組を絞る: BAL_PAIRS="hard-hard,perfect-hard" node tools/balance.mjs
// 試合の進め方は app/js/main.js の update()（CPU 戦のとき）を写している。main.js の試合の進め方を変えたら、ここも合わせる。
// CPU は 1番（上側）に立つ前提で作られているので、0番の CPU には上下左右を入れ替えた世界を見せる。
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
let jsDir = path.join(here, '../app/js');
if (process.env.BAL_SET) {
  let src = fs.readFileSync(path.join(jsDir, 'sim.js'), 'utf8');
  for (const kv of process.env.BAL_SET.split(',')) {
    const [name, val] = kv.split('=').map((s) => s.trim());
    const re = new RegExp(`(export const ${name} = )[^;]+;`);
    if (!re.test(src)) { console.error(`sim.js に ${name} が見つからない`); process.exit(1); }
    src = src.replace(re, `$1${val};`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uk-balance-'));
  fs.writeFileSync(path.join(tmp, 'sim.js'), src);
  fs.copyFileSync(path.join(jsDir, 'cpu.js'), path.join(tmp, 'cpu.js'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  jsDir = tmp;
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  console.log(`試しに変えた数字: ${process.env.BAL_SET}`);
}
const S = await import(pathToFileURL(path.join(jsDir, 'sim.js')).href);
const { Cpu, LEVELS } = await import(pathToFileURL(path.join(jsDir, 'cpu.js')).href);

// 比べるための「完璧な CPU」（反応ほぼ0・読み違い0・時機のぶれ0）。ゲームには入れない
// react をちょうど 0 にすると cpu.js が落ちる場所を読みに行かない（wait > 0 のときだけ読むため）ので、ごく小さい値にする
LEVELS.perfect = { react: 0.001,speed: 1, jitter: 0, posErr: 0, smart: 0.8, spread: 0.9 };

const N = Number(process.argv[2]) || 200;
const DT = 1 / 60;

function newPlayer(i) {
  const h = S.home(i);
  return { x: h.x, y: h.y, aim: S.forwardAngle(i), swing: -1, recover: 0, hitDone: false, outsideAtPress: true };
}

// 0番の CPU に見せる、上下左右を入れ替えた世界
const mirP = (p) => ({ x: S.W - p.x, y: S.L - p.y, swing: p.swing, recover: p.recover });
function mirG(G) {
  const b = G.ball;
  return { phase: G.phase, srv: 1 - G.srv, r: G.r, n: G.n, ball: { x: S.W - b.x, y: S.L - b.y, vx: -b.vx, vy: -b.vy, speed: b.speed } };
}

function playMatch(lv0, lv1) {
  const cpus = [new Cpu(lv0), new Cpu(lv1)];
  const G = {
    phase: 'point', phaseT: 1.8, sc: [0, 0], r: 0, n: 0, srv: Math.random() < 0.5 ? 0 : 1, over: -1,
    ball: { x: S.W / 2, y: S.L / 2, vx: 0, vy: 0, speed: S.SERVE_SPEED },
    players: [newPlayer(0), newPlayer(1)],
  };
  const rec = { time: 0, points: [], just: 0, hits: 0 };
  let pointStart = 0;

  const holdPos = (i) => {
    const p = G.players[i];
    const a = S.clampAim(i, p.aim);
    return { x: S.clamp(p.x + Math.cos(a) * 0.75, S.BALL_R, S.W - S.BALL_R), y: p.y + Math.sin(a) * 0.75 };
  };
  const launch = (i, base, just = false) => {
    const p = G.players[i];
    p.hitDone = true;
    const a = S.clampAim(i, p.aim);
    const speed = S.flightSpeed(base, just);
    G.ball.vx = Math.cos(a) * speed;
    G.ball.vy = Math.sin(a) * speed;
    G.ball.speed = speed;
    G.ball.base = base;
    G.ball.just = just;
    G.n++;
  };
  const startSwing = (i) => {
    const p = G.players[i];
    if (!(p.swing < 0 && p.recover <= 0)) return;
    p.swing = 0;
    p.hitDone = false;
    p.outsideAtPress = Math.hypot(G.ball.x - p.x, G.ball.y - p.y) > S.REACH + S.BALL_R;
    if (G.phase === 'serve' && G.srv === i) {
      Object.assign(G.ball, holdPos(i));
      G.phase = 'rally';
      G.n = 0;
      pointStart = rec.time;
      launch(i, S.SERVE_SPEED);
    }
  };
  const checkHit = (i) => {
    const p = G.players[i];
    if (p.swing < 0 || p.hitDone) return;
    if (Math.hypot(G.ball.x - p.x, G.ball.y - p.y) > S.REACH + S.BALL_R) return;
    const just = p.swing <= S.JUST_WINDOW && p.outsideAtPress;
    if (just) rec.just++;
    rec.hits++;
    launch(i, S.nextSpeed(G.ball.base), just);
  };
  const movePlayer = (i, mv) => {
    const p = G.players[i];
    if (p.recover > 0) return;
    const k = p.swing >= 0 ? 0.6 : 1;
    p.x += mv.x * S.MOVE_SPEED * k * DT;
    p.y += mv.y * S.MOVE_SPEED * k * DT;
    S.clampPlayer(i, p);
  };
  const pointTo = (w, loser) => {
    const p = G.players[loser];
    // 取りこぼしたときの様子: 球の速さ・返球の回数・人と球の横のずれ・振っていたか
    rec.points.push({
      w, speed: G.ball.base, byJust: G.ball.just && G.n > 0, returns: Math.max(0, G.n - 1), dur: rec.time - pointStart,
      gapX: Math.abs(G.ball.x - p.x), state: p.swing >= 0 ? 'swinging' : p.recover > 0 ? 'recover' : 'idle',
    });
    G.sc[w]++;
    G.over = G.sc[w] >= S.WIN_POINTS ? w : -1;
    G.r++;
    G.n = 0;
    G.srv = 1 - w;
    G.phase = 'point';
    G.phaseT = 1.3;
  };

  while (rec.time < 3600) {
    rec.time += DT;
    // CPU（main.js では 0番＝人の操作が先、1番＝CPU があと）
    for (let i = 0; i < 2; i++) {
      const p = G.players[i];
      if (i === 1) {
        const out = cpus[1].update(DT, G, p, G.players[0]);
        movePlayer(1, out.move);
        p.aim = S.clampAim(1, out.aim);
        if (out.swing) startSwing(1);
      } else {
        const out = cpus[0].update(DT, mirG(G), mirP(p), mirP(G.players[1]));
        movePlayer(0, { x: -out.move.x, y: -out.move.y });
        p.aim = S.clampAim(0, out.aim + Math.PI);
        if (out.swing) startSwing(0);
      }
    }
    for (const p of G.players) {
      if (p.swing >= 0) {
        p.swing += DT;
        if (p.swing > S.SWING_TIME) { p.swing = -1; p.recover = S.RECOVER_TIME; }
      } else if (p.recover > 0) p.recover = Math.max(0, p.recover - DT);
    }
    if (G.phase === 'point') {
      G.phaseT -= DT;
      if (G.phaseT <= 0) {
        if (G.over >= 0) break;
        G.phase = 'serve';
        G.phaseT = 0;
      }
    } else if (G.phase === 'serve') {
      Object.assign(G.ball, holdPos(G.srv));
      G.phaseT += DT;
      if (G.phaseT > S.AUTO_SERVE) { G.players[G.srv].aim = S.forwardAngle(G.srv); startSwing(G.srv); }
    } else if (G.phase === 'rally') {
      const steps = Math.ceil(DT / S.STEP);
      const sdt = DT / steps;
      for (let s = 0; s < steps; s++) {
        S.stepBall(G.ball, sdt);
        const d = S.defenderOf(G.ball.vy);
        checkHit(d);
        if (d === 0 ? G.ball.y >= S.L : G.ball.y <= 0) { pointTo(1 - d, d); break; }
      }
    }
  }
  rec.winner = G.over;
  return rec;
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + '%';
const avg = (xs) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0; };
const kmh = (v) => Math.round(v * 3.6);

const PAIRS = process.env.BAL_PAIRS ? process.env.BAL_PAIRS.split(',').map((s) => s.trim().split('-')) : [
  ['easy', 'easy'], ['normal', 'normal'], ['hard', 'hard'],
  ['normal', 'easy'], ['hard', 'normal'], ['hard', 'easy'],
  ['perfect', 'easy'], ['perfect', 'normal'], ['perfect', 'hard'], ['perfect', 'perfect'],
];

console.log(`1組 ${N} 試合ずつ（5点先取）。左が0番、右が1番。`);
for (const [a, b] of PAIRS) {
  const recs = [];
  for (let k = 0; k < N; k++) recs.push(playMatch(a, b));
  const pts = recs.flatMap((r) => r.points);
  const wins0 = recs.filter((r) => r.winner === 0).length;
  const unfinished = recs.filter((r) => r.winner < 0).length;
  const ret = pts.map((p) => p.returns);
  const states = {};
  for (const p of pts) states[p.state] = (states[p.state] || 0) + 1;
  const hits = recs.reduce((s, r) => s + r.hits, 0);
  const just = recs.reduce((s, r) => s + r.just, 0);
  console.log(`\n■ ${a} 対 ${b}`);
  console.log(`  ${a} の勝ち ${pct(wins0, N)}${unfinished ? `（終わらなかった ${unfinished}）` : ''}`);
  console.log(`  1試合の長さ: 平均 ${Math.round(avg(recs.map((r) => r.time)))} 秒（短い1割 ${Math.round(q(recs.map((r) => r.time), 0.1))} 秒・長い1割 ${Math.round(q(recs.map((r) => r.time), 0.9))} 秒）`);
  console.log(`  1点あたりの返球: 平均 ${avg(ret).toFixed(1)} 回（中央 ${q(ret, 0.5)}・長い1割 ${q(ret, 0.9)}）・返せずにサーブで決まった点 ${pct(ret.filter((v) => v === 0).length, pts.length)}`);
  console.log(`  1点の球が動いていた時間: 平均 ${avg(pts.map((p) => p.dur)).toFixed(1)} 秒`);
  console.log(`  点が決まったときの球の速さ: 平均 ${kmh(avg(pts.map((p) => p.speed)))} km/h（中央 ${kmh(q(pts.map((p) => p.speed), 0.5))}・上限 ${kmh(S.MAX_SPEED)} に届いた点 ${pct(pts.filter((p) => p.speed >= S.MAX_SPEED - 0.01).length, pts.length)}）`);
  const justWin = pts.filter((p) => p.byJust).length;
  const normalWin = pts.filter((p) => !p.byJust && p.returns > 0).length;
  console.log(`  ぴったり打ち: 打ち返しの ${pct(just, hits)}・相手が返せなかった割合 ぴったり ${pct(justWin, just)}／ふつう ${pct(normalWin, hits - just)}`);
  console.log(`  取りこぼしたときの様子: ${Object.entries(states).map(([k, v]) => `${{ idle: '振っていない', swinging: '振っている最中', recover: '振り終わりで動けない' }[k]} ${pct(v, pts.length)}`).join('・')}・球との横のずれ 平均 ${avg(pts.map((p) => p.gapX)).toFixed(2)} m`);
}

// 球の速さごとに、相手の打った所から自分の守る線（home の y）まで届く秒数（まっすぐ・いちばん斜め）
console.log('\n■ 球の速さと、届くまでの秒（相手の構える線→自分の構える線 9.6 m）');
const dist = S.home(0).y - S.home(1).y;
for (const v of [S.SERVE_SPEED, 10, 14, 18, 22, S.MAX_SPEED]) {
  const tStraight = dist / v;
  const tAngle = dist / (v * Math.cos(S.AIM_LIMIT));
  console.log(`  ${kmh(v)} km/h: まっすぐ ${tStraight.toFixed(2)} 秒・いちばん斜め ${tAngle.toFixed(2)} 秒（横に ${(S.MOVE_SPEED * tAngle).toFixed(1)} m 動ける）`);
}
// 返球の回数ごとの速さ（もとの速さ／その回がぴったり打ちだったときに飛ぶ速さ）
let s1 = S.SERVE_SPEED;
const row1 = [], row2 = [];
for (let n = 1; n <= 20; n++) {
  s1 = S.nextSpeed(s1);
  if (n % 2 === 0 || n <= 3) { row1.push(`${n}回目 ${kmh(s1)}`); row2.push(`${n}回目 ${kmh(S.flightSpeed(s1, true))}`); }
}
console.log('\n■ 返球の回数と速さ（km/h）');
console.log('  もとの速さ:           ' + row1.join('・'));
console.log('  ぴったり打ちの1球:    ' + row2.join('・'));
