// CPU の練習相手。いつも1番（画面の上側）に立つ。
// 人と同じく、見えている球の動きから落ちる場所を読んで動き、球が剣の届く所に入る瞬間をねらって振る。
// 強さごとの数字はどれも Claude が置いた値（遊んでから直してよい）。
import { W, L, REACH, BALL_R, AIM_LIMIT, forwardAngle, clampAim, home, predictAt } from './sim.js';

export const LEVELS = {
  // react: 相手が打ってから動き出すまでの秒 / speed: 動く速さ（人を1として）/ jitter: 振る時機のぶれ（秒）
  // posErr: 落ちる場所の読み違い（m）/ smart: 相手のいない側をねらう割合 / spread: ねらいの散らばり（0〜1）
  easy: { react: 0.38, speed: 0.65, jitter: 0.1, posErr: 0.75, smart: 0.0, spread: 0.3 },
  normal: { react: 0.24, speed: 0.85, jitter: 0.055, posErr: 0.35, smart: 0.4, spread: 0.6 },
  hard: { react: 0.13, speed: 1.0, jitter: 0.028, posErr: 0.15, smart: 0.8, spread: 0.9 },
};

const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // だいたい -1〜1

export class Cpu {
  constructor(level) {
    this.lv = LEVELS[level] || LEVELS.normal;
    this.reset();
  }

  reset() {
    this.seenHit = -1;     // どの打球まで見たか（何本目と何回目の組）
    this.wait = 0;         // 動き出すまでの残り秒
    this.target = home(1);
    this.offset = 0;       // 振る時機のずらし（秒。正なら早め）
    this.aim = forwardAngle(1);
    this.serveWait = 0.8 + Math.random() * 0.8;
    this.swungFor = -1;
  }

  // 毎回の更新。戻り値: { move: {x,y}（長さ0〜1、闘技場の向き）, swing, aim }
  update(dt, G, me, foe) {
    const out = { move: { x: 0, y: 0 }, swing: false, aim: this.aim };
    const hitKey = G.r * 1000 + G.n;

    if (G.phase === 'serve') {
      this.goTo(out, me, home(1));
      if (G.srv === 1) {
        this.serveWait -= dt;
        if (this.serveWait <= 0) {
          this.aim = this.chooseAim(me, foe);
          out.aim = this.aim;
          out.swing = true;
          this.serveWait = 0.8 + Math.random() * 0.8;
        }
      }
      return out;
    }
    if (G.phase !== 'rally') { this.goTo(out, me, home(1)); return out; }

    const b = G.ball;
    if (b.vy < 0) {
      // こちらへ向かってくる
      if (this.seenHit !== hitKey) {
        this.seenHit = hitKey;
        this.wait = this.lv.react * (0.8 + Math.random() * 0.4);
        this.offset = randn() * this.lv.jitter;
      }
      if (this.wait > 0) {
        this.wait -= dt;
        if (this.wait <= 0) {
          const p = predictAt(b, home(1).y);
          this.target = { x: p.x + randn() * this.lv.posErr, y: home(1).y };
          this.aim = this.chooseAim(me, foe);
        }
      } else {
        this.goTo(out, me, this.target);
      }
      // 球が剣の届く所に入るまでの秒を見積もり、そこへ合わせて振る
      const d = Math.hypot(b.x - me.x, b.y - me.y) - (REACH + BALL_R);
      const speed = Math.hypot(b.vx, b.vy);
      const tEnter = d / Math.max(0.1, speed);
      if (this.swungFor !== hitKey && me.swing < 0 && me.recover <= 0 && tEnter <= this.offset + 0.01 && b.y > -0.5) {
        this.swungFor = hitKey;
        out.swing = true;
      }
      out.aim = this.aim;
    } else {
      // 球が離れていく間は真ん中寄りへ戻る
      this.goTo(out, me, { x: W / 2 + (foe.x - W / 2) * 0.3, y: home(1).y });
    }
    return out;
  }

  goTo(out, me, t) {
    const dx = t.x - me.x;
    const dy = t.y - me.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.08) return;
    const k = Math.min(1, d / 0.4) * this.lv.speed;
    out.move = { x: (dx / d) * k, y: (dy / d) * k };
  }

  chooseAim(me, foe) {
    let tx;
    if (Math.random() < this.lv.smart) tx = foe.x < W / 2 ? W - 0.6 : 0.6;
    else tx = W / 2 + randn() * this.lv.spread * (W / 2);
    // 壁で跳ね返る分は考えず、相手のゴールの線のどこへ向けるか
    const a = Math.atan2(L - me.y, tx - me.x);
    return clampAim(1, a + randn() * 0.05 * AIM_LIMIT);
  }
}
