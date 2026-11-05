// キーボード・マウス・スマホの操作をまとめる。
// ここでは画面の向き（右が +x、下が +y）のまま返し、闘技場の向きへの直しは main.js が行う。
// スマホ: 画面の左半分＝移動スティック（触れた所が中心）。右半分＝触れた瞬間に振り、そのまま指をはじいた向きへ打ち返す。
//   触れるだけなら正面へ返す。
const STICK_MAX = 55;   // スティックを倒し切る距離（画面の点）
const FLICK_MIN = 14;   // これだけ指が動いたら「はじいた向き」とみなす

export class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set();
    this.mouse = null;          // 最後のマウスの位置（画面の点）
    this.swingQueued = false;
    this.touchMode = false;
    this.stick = null;          // { id, ox, oy, dx, dy }
    this.flick = null;          // { id, sx, sy }
    this.flickDir = null;       // はじいた向き { x, y }（画面の向き）。null は正面
    this.enabled = false;

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === ' ' || k === 'j') { this.swingQueued = true; e.preventDefault(); }
      if (k.startsWith('arrow')) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());

    el.addEventListener('mousemove', (e) => { this.mouse = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled || e.button !== 0) return;
      this.mouse = { x: e.clientX, y: e.clientY };
      this.swingQueued = true;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    const opt = { passive: false };
    el.addEventListener('touchstart', (e) => this.onTouchStart(e), opt);
    el.addEventListener('touchmove', (e) => this.onTouchMove(e), opt);
    el.addEventListener('touchend', (e) => this.onTouchEnd(e), opt);
    el.addEventListener('touchcancel', (e) => this.onTouchEnd(e), opt);

    this.stickBase = document.getElementById('stickBase');
    this.stickKnob = document.getElementById('stickKnob');
  }

  onTouchStart(e) {
    e.preventDefault();
    this.touchMode = true;
    if (!this.enabled) return;
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth / 2) {
        if (!this.stick) {
          this.stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, dx: 0, dy: 0 };
          this.showStick();
        }
      } else if (!this.flick) {
        this.flick = { id: t.identifier, sx: t.clientX, sy: t.clientY };
        this.flickDir = null;
        this.swingQueued = true;
      }
    }
  }

  onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.stick && t.identifier === this.stick.id) {
        let dx = t.clientX - this.stick.ox;
        let dy = t.clientY - this.stick.oy;
        const d = Math.hypot(dx, dy);
        if (d > STICK_MAX) { dx *= STICK_MAX / d; dy *= STICK_MAX / d; }
        this.stick.dx = dx;
        this.stick.dy = dy;
        this.showStick();
      } else if (this.flick && t.identifier === this.flick.id) {
        const dx = t.clientX - this.flick.sx;
        const dy = t.clientY - this.flick.sy;
        if (Math.hypot(dx, dy) >= FLICK_MIN) this.flickDir = { x: dx, y: dy };
      }
    }
  }

  onTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.stick && t.identifier === this.stick.id) { this.stick = null; this.showStick(); }
      if (this.flick && t.identifier === this.flick.id) this.flick = null;
    }
  }

  showStick() {
    if (!this.stickBase) return;
    if (!this.stick) { this.stickBase.hidden = true; return; }
    this.stickBase.hidden = false;
    this.stickBase.style.left = this.stick.ox + 'px';
    this.stickBase.style.top = this.stick.oy + 'px';
    this.stickKnob.style.transform = `translate(${this.stick.dx}px, ${this.stick.dy}px)`;
  }

  // 移動の向き（画面の向き、長さ 0〜1）
  move() {
    if (this.stick) return { x: this.stick.dx / STICK_MAX, y: this.stick.dy / STICK_MAX };
    let x = 0;
    let y = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1;
    if (this.keys.has('w') || this.keys.has('arrowup')) y -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) y += 1;
    const d = Math.hypot(x, y);
    return d > 0 ? { x: x / d, y: y / d } : { x: 0, y: 0 };
  }

  consumeSwing() {
    const s = this.swingQueued;
    this.swingQueued = false;
    return s;
  }

  setEnabled(on) {
    this.enabled = on;
    this.swingQueued = false;
    this.keys.clear();
    this.stick = null;
    this.flick = null;
    this.flickDir = null;
    this.showStick();
  }
}
