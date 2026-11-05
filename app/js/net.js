// 相手との通信。
// 公開の中継サーバー（MQTT）で相手と出会い、WebRTC（＝端末どうしを直接つなぐ仕組み）でつなぎ直す。
// 直接つながらない回線では、中継サーバー経由のまま続ける（少し遅れるが遊べる）。
const BROKER = 'wss://broker.emqx.io:8084/mqtt';
const PREFIX = 'uchikaeshi/v1/';
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const RTC_WAIT_MS = 8000;   // これだけ待って直接つながらなければ中継に切り替える
const SILENT_MS = 7000;     // これだけ相手から何も来なければ切れたとみなす
// 相手が画面を裏に回したと知らせてきたときの待ち時間。iPhone などは裏に回したページの動きを丸ごと止めるので、
// その間は相手から何も来なくても切れたとはみなさない（Claude が置いた値。本人が戻ってこない場合は「やめる」で抜けられる）
const AWAY_MS = 90000;

export class Net {
  constructor(room, isHost, h) {
    this.room = room;
    this.isHost = isHost;
    this.h = h; // { onMessage(msg), onStatus(text), onConnected(mode), onClosed() }
    this.id = Math.random().toString(36).slice(2, 10);
    this.peer = null;
    this.dc = null;
    this.mode = null; // 'rtc' | 'relay'
    this.pendingIce = [];
    this.lastRecv = 0;
    this.peerAway = false;
    this.closed = false;
  }

  start() {
    this.topic = PREFIX + this.room;
    // mqtt は index.html で読み込む（window.mqtt）
    this.client = window.mqtt.connect(BROKER, {
      clientId: 'uk_' + this.id, clean: true, connectTimeout: 8000, reconnectPeriod: 2000,
    });
    this.h.onStatus('中継サーバーにつないでいます…');
    this.client.on('connect', () => {
      this.client.subscribe(this.topic);
      if (!this.peer) this.h.onStatus('相手を待っています');
    });
    this.client.on('error', () => this.h.onStatus('中継サーバーにつながりません。通信を確かめてください'));
    this.client.on('message', (_t, buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.from === this.id) return;
      if (m.to && m.to !== this.id) return;
      if (this.peer && m.from !== this.peer) return;
      this.onSignal(m);
    });
    if (!this.isHost) {
      // 主催者が来るまで「来ました」を出し続ける
      this.helloTimer = setInterval(() => { if (!this.peer && this.client.connected) this.signal({ k: 'hello' }); }, 1500);
    }
    this.lastTick = performance.now();
    this.watchTimer = setInterval(() => {
      const now = performance.now();
      // 自分のページが止められていた（見回りが3秒以上遅れた）ときは、その間に相手から届かなかったのは自分のせいなので数え直す
      if (now - this.lastTick > 3000) this.lastRecv = now;
      this.lastTick = now;
      if (this.mode && now - this.lastRecv > (this.peerAway ? AWAY_MS : SILENT_MS)) this.close(true);
    }, 1000);
    this.pingTimer = setInterval(() => { if (this.mode) this.send({ t: 'ping' }); }, 1000);
    // 画面を裏に回した・戻したことを相手に知らせる
    this.onVisibility = () => {
      if (!document.hidden) this.lastRecv = performance.now();
      if (this.mode) this.send({ t: 'away', v: document.hidden });
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    // タブを閉じる・別のページへ移るときも上の「裏に回した」が出るので、続けて「抜けます」を送り、相手を 90 秒待たせない
    this.onPageHide = () => this.close();
    addEventListener('pagehide', this.onPageHide);
  }

  signal(o) {
    o.from = this.id;
    if (this.peer) o.to = this.peer;
    this.client.publish(this.topic, JSON.stringify(o));
  }

  async onSignal(m) {
    switch (m.k) {
      case 'hello':
        if (!this.isHost || this.peer) return;
        this.peer = m.from;
        this.signal({ k: 'welcome' });
        this.h.onStatus('相手が来ました。つないでいます…');
        await this.startRtc();
        break;
      case 'welcome':
        if (this.isHost || this.peer) return;
        this.peer = m.from;
        clearInterval(this.helloTimer);
        this.h.onStatus('部屋に入りました。つないでいます…');
        this.armFallback();
        break;
      case 'offer':
        if (this.isHost) return;
        this.pc = this.makePc();
        this.pc.ondatachannel = (e) => this.useChannel(e.channel);
        await this.pc.setRemoteDescription(m.sdp);
        await this.flushIce();
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.signal({ k: 'answer', sdp: this.pc.localDescription });
        break;
      case 'answer':
        if (!this.isHost || !this.pc) return;
        await this.pc.setRemoteDescription(m.sdp);
        await this.flushIce();
        break;
      case 'ice':
        if (this.pc && this.pc.remoteDescription) { try { await this.pc.addIceCandidate(m.c); } catch { /* 古い候補は無視 */ } }
        else this.pendingIce.push(m.c);
        break;
      case 'relay':
        this.receive(m.d);
        break;
      case 'bye':
        this.close(true);
        break;
    }
  }

  makePc() {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = (e) => { if (e.candidate) this.signal({ k: 'ice', c: e.candidate }); };
    return pc;
  }

  async flushIce() {
    for (const c of this.pendingIce.splice(0)) { try { await this.pc.addIceCandidate(c); } catch { /* 無視 */ } }
  }

  async startRtc() {
    this.pc = this.makePc();
    this.useChannel(this.pc.createDataChannel('g'));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.signal({ k: 'offer', sdp: this.pc.localDescription });
    this.armFallback();
  }

  armFallback() {
    setTimeout(() => { if (!this.mode && !this.closed) this.connected('relay'); }, RTC_WAIT_MS);
  }

  useChannel(dc) {
    dc.onopen = () => { this.dc = dc; if (this.mode !== 'rtc') this.connected('rtc'); };
    dc.onmessage = (e) => { try { this.receive(JSON.parse(e.data)); } catch { /* 無視 */ } };
    dc.onclose = () => { if (this.dc === dc) { this.dc = null; if (!this.closed) this.mode = 'relay'; } };
  }

  connected(mode) {
    const first = !this.mode;
    this.mode = mode;
    this.lastRecv = performance.now();
    if (first) this.h.onConnected(mode);
    else this.h.onStatus(mode === 'rtc' ? '直接つながりました' : '');
  }

  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.lastRecv = performance.now();
    if (!this.mode) this.connected('relay'); // 相手が先に中継で話し始めた
    if (msg.t === 'ping') return;
    if (msg.t === 'away') { this.peerAway = !!msg.v; return; }
    if (msg.t === 'bye') { this.close(true); return; }
    this.h.onMessage(msg);
  }

  send(msg) {
    if (this.closed) return;
    if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(msg));
    else if (this.peer) this.signal({ k: 'relay', d: msg });
  }

  get modeLabel() {
    if (this.peerAway) return '相手が画面を離れています';
    return this.mode === 'rtc' ? '直接' : this.mode === 'relay' ? '中継' : '';
  }

  close(byPeer = false) {
    if (this.closed) return;
    this.closed = true;
    if (!byPeer && this.peer && this.client?.connected) this.signal({ k: 'bye' });
    // ページを閉じる途中だと中継の「抜けます」は出ていかないことがあるので、直接の線でも送っておく
    if (!byPeer && this.dc?.readyState === 'open') { try { this.dc.send(JSON.stringify({ t: 'bye' })); } catch { /* 無視 */ } }
    clearInterval(this.helloTimer); clearInterval(this.watchTimer); clearInterval(this.pingTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    removeEventListener('pagehide', this.onPageHide);
    try { this.pc?.close(); } catch { /* 無視 */ }
    setTimeout(() => this.client?.end(true), 300);
    if (byPeer) this.h.onClosed();
  }
}
