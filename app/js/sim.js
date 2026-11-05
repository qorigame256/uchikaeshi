// 試合の数字と、球・人の動きの計算。自分・相手・CPU のどれも同じ計算を使う。
// 座標はメートル。x は横（0〜W）、y は縦（0〜L）。
// 0番（部屋を作った側・CPU 戦の自分）は y の大きい側に立ち、y=L の壁が自分のゴール。1番は y=0 の壁がゴール。
// 数字はどれも Claude が置いた値（遊んでから直してよい）。
export const W = 8;            // 闘技場の横幅
export const L = 14;           // 闘技場の縦の長さ
export const BALL_R = 0.22;    // 球の半径
export const PLAYER_R = 0.42;  // 人の半径
export const REACH = 1.3;      // 剣が届く距離（人の中心から）
export const MOVE_SPEED = 5.5; // 動く速さ（m/秒）
export const SWING_TIME = 0.25;   // 剣が出ている時間（ルール2）
export const RECOVER_TIME = 0.25; // 振り終わったあと動けない時間（ルール2。2026-11-05 本人決定で 0.4 から縮めた）
export const JUST_WINDOW = 0.07;  // 振り始めてからこの秒数のうちに当たると「ぴったり打ち」（ルール3）
export const SERVE_SPEED = 7;     // 最初の球の速さ
export const MAX_SPEED = 28;      // 球の速さ（もとの速さ）の上限
export const JUST_BOOST = 1.3;    // ぴったり打ちの球は、その1球だけもとの速さのこの倍で飛ぶ（2026-11-05 本人決定の仕組み。倍率は Claude の値）
export const JUST_MAX = 32;       // ぴったり打ちの球が飛ぶ速さの上限（Claude の値）
export const AIM_LIMIT = 60 * Math.PI / 180; // 正面から左右に打ち分けられる角度の限り
export const WIN_POINTS = 5;      // ルール6
export const AUTO_SERVE = 5;      // これだけ待っても打たなければ、まっすぐ自動で出る
export const STEP = 1 / 240;      // 球の動きを細かく刻む幅（速い球が人をすり抜けないため）

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 正面の向き（ラジアン）。0番は y が減る向き、1番は y が増える向き
export const forwardAngle = (i) => (i === 0 ? -Math.PI / 2 : Math.PI / 2);

export function home(i) {
  return { x: W / 2, y: i === 0 ? L - 2.2 : 2.2 };
}

export function clampPlayer(i, p) {
  p.x = clamp(p.x, PLAYER_R, W - PLAYER_R);
  if (i === 0) p.y = clamp(p.y, L / 2 + PLAYER_R, L - PLAYER_R);
  else p.y = clamp(p.y, PLAYER_R, L / 2 - PLAYER_R);
}

// 球がどちらのゴールへ向かっているか（＝どちらが打ち返す番か）
export const defenderOf = (vy) => (vy > 0 ? 0 : 1);

// 向きを「相手の側へ、正面から左右 AIM_LIMIT まで」に収める
export function clampAim(i, a) {
  const f = forwardAngle(i);
  let d = a - f;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return f + clamp(d, -AIM_LIMIT, AIM_LIMIT);
}

// 球には「もとの速さ」（打ち返すたびに少しずつ上がる）と「飛ぶ速さ」がある。ふつうは同じで、ぴったり打ちの球だけ飛ぶ速さが速い。
// ぴったり打ちでもとの速さは余分に上がらない（最初は大きく積み上がる作りだったが、本人が遊んで「速くなるペースが速すぎる」と
// 言ったので 2026-11-05 に変えた。ぴったり打ちの得は、その1球だけ速いことにした）
export function nextSpeed(base) {
  return Math.min(MAX_SPEED, base * 1.05 + 0.4);
}
export function flightSpeed(base, just) {
  return just ? Math.min(JUST_MAX, base * JUST_BOOST) : base;
}

// 球を dt 秒動かす。横の壁で跳ね返ったら true
export function stepBall(b, dt) {
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  if (b.x < BALL_R) { b.x = 2 * BALL_R - b.x; b.vx = Math.abs(b.vx); return true; }
  if (b.x > W - BALL_R) { b.x = 2 * (W - BALL_R) - b.x; b.vx = -Math.abs(b.vx); return true; }
  return false;
}

// 球を t 秒先まで進める（ゴールの線で止める）
export function advance(b, t) {
  let left = Math.max(0, t);
  while (left > 0) {
    const dt = Math.min(STEP, left);
    stepBall(b, dt);
    left -= dt;
    if (b.y <= 0 || b.y >= L) break;
  }
  return b;
}

// 球が y=lineY に届くときの横位置と、かかる秒数を先読みする（CPU が使う）
export function predictAt(ball, lineY) {
  const b = { ...ball };
  let t = 0;
  const dt = STEP * 4;
  while (t < 4) {
    if ((b.vy > 0 && b.y >= lineY) || (b.vy < 0 && b.y <= lineY)) return { x: b.x, t };
    stepBall(b, dt);
    t += dt;
  }
  return { x: b.x, t };
}
