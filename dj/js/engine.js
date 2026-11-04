'use strict';
/*
 * Moteur audio.
 * - Un AudioWorklet par deck lit le morceau décodé à l'échantillon près :
 *   tempo variable, boucles exactes, sauts sans clic, keylock (time-stretch WSOLA).
 * - Une tranche de mixeur par deck : trim, EQ 3 bandes avec kill, filtre LP/HP, fader, crossfader.
 */

/* ---- Code exécuté dans l'AudioWorkletGlobalScope (sérialisé via toString). ---- */
function deckPlayerWorklet() {
  class DeckPlayer extends AudioWorkletProcessor {
    constructor() {
      super();
      this.L = null; this.R = null; this.len = 0;
      this.pos = 0; this.rate = 1; this.keylock = true; this.playing = false;
      this.gain = 0; this.pendingSeek = -1; this.seq = 0;
      this.loopOn = false; this.ls = 0; this.le = 0;
      this.N = 1024; this.Hs = 512; this.tol = 320;
      this.win = new Float32Array(this.N);
      for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N);
      this.olaL = new Float32Array(this.N); this.olaR = new Float32Array(this.N);
      this.SZ = 8192;
      this.fL = new Float32Array(this.SZ); this.fR = new Float32Array(this.SZ);
      this.fr = 0; this.fw = 0; this.fc = 0;
      this.prev = -1; this.mode = 0; this.blk = 0;
      this.port.onmessage = (e) => this.msg(e.data);
    }
    reset() {
      this.olaL.fill(0); this.olaR.fill(0);
      this.fr = this.fw = this.fc = 0; this.prev = -1;
    }
    msg(m) {
      switch (m.type) {
        case 'load':
          this.L = m.L; this.R = m.R || m.L; this.len = this.L.length;
          this.pos = 0; this.playing = false; this.gain = 0; this.pendingSeek = -1;
          this.loopOn = false; this.seq = m.seq; this.reset();
          break;
        case 'play': this.playing = m.value; break;
        case 'seek':
          this.seq = m.seq;
          if (this.gain > 1e-3) this.pendingSeek = m.pos;
          else { this.pos = m.pos; this.pendingSeek = -1; this.reset(); }
          break;
        case 'rate': this.rate = m.value; break;
        case 'keylock': this.keylock = m.value; break;
        case 'loop': this.loopOn = m.on; this.ls = m.start; this.le = m.end; break;
      }
    }
    wrap(i) {
      if (this.loopOn && i >= this.le && this.le > this.ls) i = this.ls + ((i - this.le) % (this.le - this.ls));
      return i;
    }
    mono(i) {
      i = this.wrap(i);
      if (i < 0 || i >= this.len) return 0;
      return this.L[i] + this.R[i];
    }
    corr(a, b, n, step) {
      let c = 0, e = 0;
      for (let i = 0; i < n; i += step) {
        const x = this.mono(a + i);
        c += x * this.mono(b + i);
        e += x * x;
      }
      return c / Math.sqrt(e + 1e-9);
    }
    push(l, r) {
      this.fL[this.fw] = l; this.fR[this.fw] = r;
      this.fw = (this.fw + 1) & (this.SZ - 1); this.fc++;
    }
    frame() {
      const N = this.N, Hs = this.Hs, ov = N - Hs;
      const s = Math.round(this.pos);
      let best = s;
      if (this.prev >= 0) {
        const nat = this.prev + Hs;
        let bc = -Infinity;
        for (let d = -this.tol; d <= this.tol; d += 4) {
          const c = this.corr(s + d, nat, ov, 4);
          if (c > bc) { bc = c; best = s + d; }
        }
        const c0 = best;
        bc = -Infinity;
        for (let d = -3; d <= 3; d++) {
          const c = this.corr(c0 + d, nat, ov, 2);
          if (c > bc) { bc = c; best = c0 + d; }
        }
      }
      for (let i = 0; i < N; i++) {
        const j = this.wrap(best + i);
        if (j >= 0 && j < this.len) {
          this.olaL[i] += this.L[j] * this.win[i];
          this.olaR[i] += this.R[j] * this.win[i];
        }
      }
      for (let i = 0; i < Hs; i++) this.push(this.olaL[i], this.olaR[i]);
      this.olaL.copyWithin(0, Hs); this.olaL.fill(0, N - Hs);
      this.olaR.copyWithin(0, Hs); this.olaR.fill(0, N - Hs);
      this.prev = best;
      this.pos += this.rate * Hs;
      if (this.loopOn && this.pos >= this.le && this.le > this.ls) {
        const LL = this.le - this.ls;
        this.pos -= LL; this.prev -= LL;
      }
    }
    end() {
      this.playing = false; this.gain = 0; this.pos = this.len; this.reset();
      this.port.postMessage({ type: 'ended' });
    }
    process(inputs, outputs) {
      const out = outputs[0];
      const oL = out[0], oR = out[1] || out[0];
      const n = oL.length;
      if (!this.L) return true;
      const mode = this.keylock && Math.abs(this.rate - 1) > 1e-4 ? 1 : 0;
      if (mode !== this.mode) {
        if (this.mode === 1) this.pos = Math.max(0, this.pos - this.fc * this.rate);
        this.reset();
        this.mode = mode;
      }
      for (let i = 0; i < n; i++) {
        const tgt = this.pendingSeek >= 0 || !this.playing ? 0 : 1;
        this.gain += (tgt - this.gain) * 0.04;
        if (this.pendingSeek >= 0 && this.gain < 1e-3) {
          this.pos = this.pendingSeek; this.pendingSeek = -1; this.reset();
        }
        if (tgt === 0 && this.gain < 1e-4) { this.gain = 0; oL[i] = 0; oR[i] = 0; continue; }
        let l = 0, r = 0;
        if (mode === 0) {
          const p = this.pos;
          const i0 = Math.floor(p), fr = p - i0;
          const a = this.wrap(i0), b = this.wrap(i0 + 1);
          if (a >= 0 && a < this.len) { l = this.L[a] * (1 - fr); r = this.R[a] * (1 - fr); }
          if (b >= 0 && b < this.len) { l += this.L[b] * fr; r += this.R[b] * fr; }
          this.pos += this.rate;
          if (this.loopOn && this.pos >= this.le && this.le > this.ls) this.pos -= this.le - this.ls;
        } else {
          if (this.fc === 0) this.frame();
          l = this.fL[this.fr]; r = this.fR[this.fr];
          this.fr = (this.fr + 1) & (this.SZ - 1); this.fc--;
        }
        oL[i] = l * this.gain;
        if (oR !== oL) oR[i] = r * this.gain;
        if (this.pos >= this.len) { this.end(); break; }
      }
      if (++this.blk % 4 === 0) {
        const heard = this.pendingSeek >= 0 ? this.pendingSeek : this.pos - (this.mode ? this.fc * this.rate : 0);
        this.port.postMessage({
          type: 'pos', pos: heard, seq: this.seq,
          t: currentTime + n / sampleRate, playing: this.playing,
        });
      }
      return true;
    }
  }
  registerProcessor('deck-player', DeckPlayer);
}

/* ---- Thread principal ---- */
const Engine = {
  ctx: null,
  master: null,
  async init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const src = '(' + deckPlayerWorklet.toString() + ')();';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    this.bus = ctx.createGain();
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;
    this.bus.connect(this.master).connect(this.limiter).connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    this.limiter.connect(this.recDest);
    this.meter = new Meter(ctx, this.limiter);
  },
  smooth(param, v) {
    param.setTargetAtTime(v, this.ctx.currentTime, 0.012);
  },
};

class Meter {
  constructor(ctx, node) {
    this.an = ctx.createAnalyser();
    this.an.fftSize = 1024;
    this.buf = new Float32Array(1024);
    node.connect(this.an);
    this.hold = 0;
  }
  level() {
    this.an.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (let i = 0; i < this.buf.length; i++) { const v = Math.abs(this.buf[i]); if (v > p) p = v; }
    this.hold = Math.max(p, this.hold * 0.92);
    return this.hold;
  }
}

class Channel {
  constructor(ctx, out) {
    this.ctx = ctx;
    const bq = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
    this.trim = ctx.createGain();
    this.low = bq('lowshelf', 220);
    this.mid = bq('peaking', 1000, 0.7);
    this.high = bq('highshelf', 4500);
    this.lp = bq('lowpass', 22000, 0.9);
    this.hp = bq('highpass', 10, 0.9);
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.trim.connect(this.low).connect(this.mid).connect(this.high).connect(this.lp).connect(this.hp).connect(this.fader).connect(this.xf).connect(out);
    this.meter = new Meter(ctx, this.fader);
  }
  setTrim(v) { Engine.smooth(this.trim.gain, Math.pow(10, (v * 12) / 20)); }
  setEq(band, v) { Engine.smooth(this[band].gain, v < 0 ? v * 40 : v * 9); }
  setFilter(v) {
    if (v < -0.02) {
      Engine.smooth(this.lp.frequency, 20000 * Math.pow(150 / 20000, -v));
      Engine.smooth(this.hp.frequency, 10);
    } else if (v > 0.02) {
      Engine.smooth(this.hp.frequency, 20 * Math.pow(7000 / 20, v));
      Engine.smooth(this.lp.frequency, 22000);
    } else {
      Engine.smooth(this.lp.frequency, 22000);
      Engine.smooth(this.hp.frequency, 10);
    }
  }
  setFader(v) { Engine.smooth(this.fader.gain, v * v); }
  setXf(g) { Engine.smooth(this.xf.gain, g); }
}

class Deck {
  constructor(id, channel) {
    this.id = id;
    this.ctx = Engine.ctx;
    this.sr = this.ctx.sampleRate;
    this.node = new AudioWorkletNode(this.ctx, 'deck-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.connect(channel.trim);
    this.node.port.onmessage = (e) => this.onMsg(e.data);
    this.track = null;
    this.dur = 0;
    this.playing = false;
    this.cue = 0;
    this.tempo = 0; this.range = 8; this.nudge = 0;
    this.keylock = true; this.quant = true; this.syncLock = false;
    this.loop = { on: false, start: 0, end: 0 };
    this.loopBeats = 4; this.loopIn = null;
    this.seq = 0;
    this.rep = { pos: 0, t: 0, playing: false };
    this.loading = false;
    this.cueHold = false;
    this.onChange = () => {};
    this.onTrackEdit = () => {};
    this.onFirstPlay = () => {};
  }
  post(m, transfer) { this.node.port.postMessage(m, transfer || []); }
  emit() { this.onChange(this); }
  onMsg(m) {
    if (m.type === 'pos') {
      if (m.seq !== this.seq) return;
      this.rep = { pos: m.pos / this.sr, t: m.t, playing: m.playing };
    } else if (m.type === 'ended') {
      this.playing = false;
      this.rep = { pos: this.dur, t: this.ctx.currentTime, playing: false };
      this.emit();
    }
  }
  get rate() { return (1 + this.tempo / 100) * (1 + this.nudge); }
  get bpm() { return this.track && this.track.bpm ? this.track.bpm * this.rate : 0; }
  get period() { return this.track && this.track.bpm ? 60 / this.track.bpm : 0; }
  get time() {
    let p = this.rep.pos;
    if (this.rep.playing) {
      p += Math.max(0, this.ctx.currentTime - this.rep.t) * this.rate;
      const L = this.loop;
      if (L.on && p >= L.end && L.end > L.start) p = L.start + ((p - L.end) % (L.end - L.start));
    }
    return Math.max(0, Math.min(p, this.dur));
  }
  /* Position telle qu'entendue (compense la latence de sortie) pour l'affichage. */
  get displayTime() {
    if (!this.playing) return this.time;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.max(0, this.time - lat * this.rate);
  }
  beatPos(t = this.time) {
    if (!this.period) return 0;
    return (t - this.track.beatOffset) / this.period;
  }
  quantize(t) {
    if (!this.quant || !this.period) return t;
    const k = Math.round(this.beatPos(t));
    const q = this.track.beatOffset + k * this.period;
    return q < 0 ? q + this.period : q;
  }
  beatFloor(t) {
    if (!this.quant || !this.period) return t;
    const k = Math.floor(this.beatPos(t) + 0.02);
    return Math.max(0, this.track.beatOffset + k * this.period);
  }

  async load(track, blob) {
    const token = ++this.seq;
    this.loading = true;
    this.pause();
    this.emit();
    const ab = await blob.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    if (token !== this.seq) return false;
    const L = new Float32Array(buf.getChannelData(0));
    const R = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : null;
    this.post({ type: 'load', L, R, seq: this.seq }, R ? [L.buffer, R.buffer] : [L.buffer]);
    this.dur = buf.length / buf.sampleRate;
    this.track = track;
    if (!track.hotcues) track.hotcues = new Array(8).fill(null);
    this.cue = track.cue || 0;
    this.loop = { on: false, start: 0, end: 0 };
    this.loopIn = null;
    this.playing = false;
    this.played = false;
    this.applyRate();
    this.post({ type: 'keylock', value: this.keylock });
    this.post({ type: 'loop', on: false, start: 0, end: 0 });
    this.seek(this.cue);
    this.loading = false;
    this.emit();
    return true;
  }

  play() {
    if (!this.track || this.loading) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.time >= this.dur - 0.05) this.seek(this.cue);
    this.rep = { pos: this.time, t: this.ctx.currentTime, playing: true };
    this.playing = true;
    this.cueHold = false;
    this.post({ type: 'play', value: true });
    if (!this.played) { this.played = true; this.onFirstPlay(this); }
    this.emit();
  }
  pause() {
    this.rep = { pos: this.time, t: this.ctx.currentTime, playing: false };
    this.playing = false;
    this.post({ type: 'play', value: false });
    this.emit();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    t = Math.max(0, Math.min(t, Math.max(0, this.dur - 0.01)));
    this.seq++;
    this.post({ type: 'seek', pos: t * this.sr, seq: this.seq });
    this.rep = { pos: t, t: this.ctx.currentTime, playing: this.playing };
  }

  /* CUE : en pause hors du point -> pose le cue ; en pause sur le cue -> pré-écoute tant qu'on maintient ;
     en lecture -> retour au cue et pause. */
  cueDown() {
    if (!this.track) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cue);
    } else if (Math.abs(this.time - this.cue) > 0.02) {
      this.cue = this.quantize(this.time);
      this.track.cue = this.cue;
      this.seek(this.cue);
      this.onTrackEdit(this.track);
    } else {
      this.play();
      this.cueHold = true;
    }
    this.emit();
  }
  cueUp() {
    if (this.cueHold) {
      this.cueHold = false;
      this.pause();
      this.seek(this.cue);
      this.emit();
    }
  }

  hotcue(i, erase) {
    if (!this.track) return;
    const hc = this.track.hotcues;
    if (erase) hc[i] = null;
    else if (hc[i] == null) hc[i] = this.quantize(this.time);
    else {
      this.seek(hc[i]);
      if (!this.playing) this.cue = hc[i];
    }
    this.onTrackEdit(this.track);
    this.emit();
  }

  applyRate() {
    const t = this.time;
    this.rep = { pos: t, t: this.ctx.currentTime, playing: this.playing };
    this.post({ type: 'rate', value: this.rate });
  }
  setTempo(pct) {
    this.tempo = Math.max(-this.range, Math.min(this.range, pct));
    this.applyRate();
    this.emit();
  }
  setNudge(v) { this.nudge = v; this.applyRate(); }
  setKeylock(v) { this.keylock = v; this.post({ type: 'keylock', value: v }); this.emit(); }
  cycleRange() {
    const ranges = [8, 16, 50];
    this.range = ranges[(ranges.indexOf(this.range) + 1) % ranges.length];
    this.setTempo(this.tempo);
  }

  /* SYNC : cale le tempo (en gérant les rapports ×2 / ½) puis la phase sur l'autre deck. */
  syncTo(other, withPhase = true) {
    if (!this.track || !this.track.bpm || !other.track || !other.bpm) return false;
    const target = other.bpm / this.track.bpm;
    let r = target, mult = 1;
    while (r > 1.45) { r /= 2; mult /= 2; }
    while (r < 0.7) { r *= 2; mult *= 2; }
    const pct = (r - 1) * 100;
    while (Math.abs(pct) > this.range && this.range < 50) this.range = this.range === 8 ? 16 : 50;
    this.tempo = Math.max(-this.range, Math.min(this.range, pct));
    this.applyRate();
    if (withPhase && other.playing && this.period) {
      const frac = (v) => v - Math.floor(v);
      let d = frac(other.beatPos() * mult) - frac(this.beatPos());
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      this.seek(this.time + d * this.period);
    }
    this.emit();
    return true;
  }

  setLoop(start, end) {
    this.loop = { on: true, start, end };
    this.post({ type: 'loop', on: true, start: start * this.sr, end: end * this.sr });
    this.emit();
  }
  exitLoop() {
    if (this.loop.on) {
      this.loop.on = false;
      this.post({ type: 'loop', on: false, start: 0, end: 0 });
    } else if (this.loop.end > this.loop.start) {
      // reloop
      this.setLoop(this.loop.start, this.loop.end);
      this.seek(this.loop.start);
    }
    this.emit();
  }
  autoLoop(beats = this.loopBeats) {
    if (!this.track || !this.period) return;
    if (this.loop.on && Math.abs(this.loop.end - this.loop.start - beats * this.period) < 1e-3) {
      this.exitLoop();
      return;
    }
    this.loopBeats = beats;
    const start = this.beatFloor(this.time);
    this.setLoop(start, start + beats * this.period);
  }
  resizeLoop(factor) {
    const nb = Math.max(1 / 32, Math.min(64, this.loopBeats * factor));
    this.loopBeats = nb;
    if (this.loop.on && this.period) {
      const start = this.loop.start;
      const end = start + nb * this.period;
      this.setLoop(start, end);
      if (this.time >= end) this.seek(start + ((this.time - start) % (end - start)));
    } else this.emit();
  }
  markLoopIn() { if (this.track) { this.loopIn = this.quantize(this.time); this.emit(); } }
  markLoopOut() {
    if (!this.track || this.loopIn == null) return;
    const end = this.quantize(this.time);
    if (end > this.loopIn + 0.05) {
      if (this.period) this.loopBeats = Math.round(((end - this.loopIn) / this.period) * 100) / 100;
      this.setLoop(this.loopIn, end);
    }
  }

  /* Outils de grille rythmique */
  scaleBpm(f) { if (this.track && this.track.bpm) { this.track.bpm = Math.round(this.track.bpm * f * 100) / 100; this.onTrackEdit(this.track); this.emit(); } }
  shiftGrid(sec) { if (this.track) { this.track.beatOffset += sec; this.onTrackEdit(this.track); this.emit(); } }
  gridHere() { if (this.track) { this.track.beatOffset = this.time; this.onTrackEdit(this.track); this.emit(); } }
}
