'use strict';
/*
 * Analyse audio : waveform 3 bandes, BPM + grille rythmique, tonalité (notation Camelot).
 * Travaille sur un signal mono rééchantillonné ~11 kHz pour rester rapide.
 */
const Analysis = (() => {
  const WF_RATE = 150; // colonnes de waveform par seconde
  const pause = () => new Promise((r) => setTimeout(r, 0));

  const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  // Profils Krumhansl-Kessler
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function camelotOf(tonic, minor) {
    const majorTonic = minor ? (tonic + 3) % 12 : tonic;
    const n = (((majorTonic * 7) % 12) + 7) % 12 + 1;
    return n + (minor ? 'A' : 'B');
  }

  function mono(buf) {
    const n = buf.length;
    const ch = buf.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i];
    }
    if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
    return out;
  }

  function downsample(x, factor) {
    if (factor <= 1) return x;
    const n = Math.floor(x.length / factor);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const o = i * factor;
      for (let k = 0; k < factor; k++) s += x[o + k];
      y[i] = s / factor;
    }
    return y;
  }

  function lowpass(x, sr, fc) {
    const a = Math.exp((-2 * Math.PI * fc) / sr);
    const b = 1 - a;
    const y = new Float32Array(x.length);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
      s1 = b * x[i] + a * s1;
      s2 = b * s1 + a * s2;
      y[i] = s2;
    }
    return y;
  }

  /* Waveform : [global, graves, médiums, aigus] par colonne, en Uint8. */
  function waveform(x, sr, low, lowMid) {
    const n = Math.ceil((x.length / sr) * WF_RATE);
    const raw = new Float32Array(n * 4);
    const step = sr / WF_RATE;
    let max = 1e-9;
    for (let b = 0; b < n; b++) {
      const s = Math.floor(b * step);
      const e = Math.min(x.length, Math.floor((b + 1) * step));
      let pa = 0, pl = 0, pm = 0, ph = 0;
      for (let i = s; i < e; i++) {
        const v = Math.abs(x[i]);
        const l = Math.abs(low[i]);
        const m = Math.abs(lowMid[i] - low[i]);
        const h = Math.abs(x[i] - lowMid[i]);
        if (v > pa) pa = v;
        if (l > pl) pl = l;
        if (m > pm) pm = m;
        if (h > ph) ph = h;
      }
      raw[b * 4] = pa; raw[b * 4 + 1] = pl; raw[b * 4 + 2] = pm; raw[b * 4 + 3] = ph;
      if (pa > max) max = pa;
    }
    const out = new Uint8Array(n * 4);
    const k = 255 / max;
    for (let i = 0; i < raw.length; i++) {
      const boost = i % 4 === 3 ? 1.6 : 1; // les aigus sont naturellement faibles
      out[i] = Math.min(255, Math.round(raw[i] * k * boost));
    }
    return out;
  }

  /* Enveloppe d'attaques (différence d'énergie log, plein spectre + graves). */
  function onsets(x, sr, low) {
    const hop = Math.max(1, Math.round(sr / 172));
    const win = hop * 2;
    const n = Math.max(0, Math.floor((x.length - win) / hop));
    const env = new Float32Array(n);
    let pf = 0, pl = 0;
    for (let k = 0; k < n; k++) {
      let ef = 0, el = 0;
      const o = k * hop;
      for (let i = o; i < o + win; i++) { ef += x[i] * x[i]; el += low[i] * low[i]; }
      const lf = Math.log(ef + 1e-3);
      const ll = Math.log(el + 1e-3);
      env[k] = k === 0 ? 0 : Math.max(0, lf - pf) + 1.5 * Math.max(0, ll - pl);
      pf = lf; pl = ll;
    }
    // soustraction de la moyenne locale
    const out = new Float32Array(n);
    const W = 32;
    let acc = 0;
    const pre = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) { acc += env[k]; pre[k + 1] = acc; }
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - W), b = Math.min(n, k + W + 1);
      const mean = (pre[b] - pre[a]) / (b - a);
      out[k] = Math.max(0, env[k] - mean);
    }
    return { env: out, fps: sr / hop };
  }

  /* Repli de l'enveloppe sur une période : mesure à quel point les attaques tombent "en phase". */
  function fold(env, fps, bpm) {
    const bins = 96;
    const hist = new Float64Array(bins);
    const p = (fps * 60) / bpm;
    for (let i = 0; i < env.length; i++) {
      const v = env[i];
      if (v === 0) continue;
      let ph = i / p;
      ph -= Math.floor(ph);
      hist[(ph * bins) | 0] += v;
    }
    let max = -1, mi = 0, sum = 0;
    for (let b = 0; b < bins; b++) {
      const v = hist[(b + bins - 1) % bins] + 2 * hist[b] + hist[(b + 1) % bins];
      sum += hist[b];
      if (v > max) { max = v; mi = b; }
    }
    const mean = (sum * 4) / bins;
    return { score: max - mean, phaseFrames: ((mi + 0.5) / bins) * p };
  }

  function tempo(env, fps) {
    const n = env.length;
    if (n < fps * 8) return { bpm: 0, offset: 0 };
    const minLag = Math.floor((fps * 60) / 200);
    const maxLag = Math.ceil((fps * 60) / 60);
    let s0 = 0, s1 = n;
    const maxFrames = Math.round(fps * 120);
    if (n > maxFrames) { s0 = Math.floor((n - maxFrames) / 2); s1 = s0 + maxFrames; }
    const ac = new Float64Array(maxLag * 2 + 2);
    for (let lag = minLag; lag <= maxLag * 2 && lag < s1 - s0; lag++) {
      let sum = 0;
      for (let i = s0; i < s1 - lag; i++) sum += env[i] * env[i + lag];
      ac[lag] = sum / (s1 - s0 - lag);
    }
    let bestLag = 0, bestS = -Infinity;
    const score = (lag) => {
      const bpm = (60 * fps) / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 122) / 0.5, 2));
      return (ac[lag] + 0.5 * (ac[2 * lag] || 0)) * w;
    };
    for (let lag = minLag; lag <= maxLag; lag++) {
      const s = score(lag);
      if (s > bestS) { bestS = s; bestLag = lag; }
    }
    if (!bestLag) return { bpm: 0, offset: 0 };
    // interpolation parabolique
    let lagF = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const a = score(bestLag - 1), b = bestS, c = score(bestLag + 1);
      const d = a - 2 * b + c;
      if (d < 0) lagF = bestLag + (0.5 * (a - c)) / d;
    }
    let coarse = (60 * fps) / lagF;
    // plage de tempo usuelle en DJ : 88–175 BPM (corrigeable ensuite avec ½ / ×2)
    while (coarse < 88) coarse *= 2;
    while (coarse >= 176) coarse /= 2;

    // affinage par repli de phase sur tout le morceau
    let best = { bpm: coarse, score: -Infinity, phaseFrames: 0 };
    const scan = (lo, hi, step) => {
      for (let b = lo; b <= hi; b += step) {
        const f = fold(env, fps, b);
        if (f.score > best.score) best = { bpm: b, score: f.score, phaseFrames: f.phaseFrames };
      }
    };
    scan(coarse * 0.975, coarse * 1.025, 0.05);
    scan(best.bpm - 0.06, best.bpm + 0.06, 0.005);
    // préférence pour un tempo entier (cas le plus fréquent en musique électronique)
    const rounded = Math.round(best.bpm);
    if (Math.abs(rounded - best.bpm) < 0.15) {
      const f = fold(env, fps, rounded);
      if (f.score >= best.score * 0.985) best = { bpm: rounded, score: f.score, phaseFrames: f.phaseFrames };
    }
    const period = 60 / best.bpm;
    let offset = (best.phaseFrames + 1.5) / fps;
    offset = ((offset % period) + period) % period;
    return { bpm: Math.round(best.bpm * 100) / 100, offset };
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = a + half;
          const br = re[b] * cr - im[b] * ci;
          const bi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - br; im[b] = im[a] - bi;
          re[a] += br; im[a] += bi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
  }

  function key(x, sr) {
    const N = 8192;
    if (x.length < N * 2) return { key: '', camelot: '' };
    const frames = Math.min(240, Math.floor(x.length / N) * 2);
    const hann = new Float64Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const binPc = new Int8Array(N / 2).fill(-1);
    const binW = new Float64Array(N / 2);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * sr) / N;
      if (f < 60 || f > 2500) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const r = Math.round(midi);
      const d = Math.abs(midi - r);
      if (d > 0.4) continue;
      binPc[k] = ((r % 12) + 12) % 12;
      binW[k] = 1 - d * 2;
    }
    const chroma = new Float64Array(12);
    const re = new Float64Array(N), im = new Float64Array(N);
    const frameC = new Float64Array(12);
    const span = x.length - N;
    for (let f = 0; f < frames; f++) {
      const o = Math.floor((f / Math.max(1, frames - 1)) * span);
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * hann[i]; im[i] = 0; }
      fft(re, im);
      frameC.fill(0);
      let tot = 0;
      for (let k = 1; k < N / 2; k++) {
        const pc = binPc[k];
        if (pc < 0) continue;
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * binW[k];
        frameC[pc] += m;
        tot += m;
      }
      if (tot > 1e-6) for (let c = 0; c < 12; c++) chroma[c] += frameC[c] / tot;
    }
    const corr = (prof, t) => {
      let mx = 0, my = 0;
      for (let i = 0; i < 12; i++) { mx += chroma[(i + t) % 12]; my += prof[i]; }
      mx /= 12; my /= 12;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < 12; i++) {
        const a = chroma[(i + t) % 12] - mx, b = prof[i] - my;
        num += a * b; dx += a * a; dy += b * b;
      }
      return num / Math.sqrt(dx * dy + 1e-12);
    };
    let best = { r: -2, t: 0, minor: false };
    for (let t = 0; t < 12; t++) {
      const a = corr(MAJOR, t), b = corr(MINOR, t);
      if (a > best.r) best = { r: a, t, minor: false };
      if (b > best.r) best = { r: b, t, minor: true };
    }
    return { key: KEY_NAMES[best.t] + (best.minor ? 'm' : ''), camelot: camelotOf(best.t, best.minor) };
  }

  async function analyze(buf) {
    let x = mono(buf);
    let sr = buf.sampleRate;
    const factor = Math.max(1, Math.round(sr / 11025));
    x = downsample(x, factor);
    sr /= factor;
    await pause();
    const low = lowpass(x, sr, 160);
    const lowMid = lowpass(x, sr, 2200);
    const peaks = waveform(x, sr, low, lowMid);
    await pause();
    const o = onsets(x, sr, low);
    await pause();
    const t = tempo(o.env, o.fps);
    await pause();
    const k = key(x, sr);
    return {
      duration: buf.duration,
      bpm: t.bpm,
      beatOffset: t.offset,
      key: k.key,
      camelot: k.camelot,
      peaks,
      wfRate: WF_RATE,
    };
  }

  return { analyze, WF_RATE, camelotOf };
})();
