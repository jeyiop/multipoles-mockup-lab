'use strict';
/* Dessin des waveforms : vue zoomée centrée sur la tête de lecture + vue d'ensemble. */
const Wave = (() => {
  const PALETTE = {
    A: { low: '#1d4ed8', mid: '#38bdf8', high: '#e0f7ff', accent: '#38bdf8' },
    B: { low: '#c2410c', mid: '#fb923c', high: '#fff3e8', accent: '#fb923c' },
  };
  const HC = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899'];
  const BG = '#0a0c11';

  function fit(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr));
    const h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
    return false;
  }

  function amp(peaks, n, b0, b1, band) {
    if (b1 <= b0) b1 = b0 + 1;
    if (b0 < 0) b0 = 0;
    if (b1 > n) b1 = n;
    let m = 0;
    for (let b = b0; b < b1; b++) { const v = peaks[b * 4 + band]; if (v > m) m = v; }
    return m / 255;
  }

  /* Dessine des colonnes de t0 à t1 (secondes) sur la largeur W. */
  function columns(g, tr, t0, t1, W, H, pal, scaleH = 1) {
    const peaks = tr.peaks;
    const n = peaks.length / 4;
    const rate = tr.wfRate;
    const mid = H / 2;
    const dt = (t1 - t0) / W;
    const layers = [[0, pal.low, 1], [2, pal.mid, 0.9], [3, pal.high, 0.85]];
    for (const [band, color, k] of layers) {
      g.fillStyle = color;
      g.beginPath();
      for (let x = 0; x < W; x++) {
        const ts = t0 + x * dt;
        const b0 = Math.floor(ts * rate);
        if (b0 >= n || b0 + 1 < 0) continue;
        const a = amp(peaks, n, b0, Math.floor((ts + dt) * rate), band) * k * scaleH;
        if (a <= 0.004) continue;
        const h = a * mid * 0.96;
        g.rect(x, mid - h, 1, h * 2);
      }
      g.fill();
    }
  }

  function marker(g, x, H, color, label, dpr, top = true) {
    g.fillStyle = color;
    g.fillRect(Math.round(x), 0, Math.max(1, dpr), H);
    const s = 7 * dpr;
    g.beginPath();
    if (top) { g.moveTo(x - s, 0); g.lineTo(x + s, 0); g.lineTo(x, s * 1.2); }
    else { g.moveTo(x - s, H); g.lineTo(x + s, H); g.lineTo(x, H - s * 1.2); }
    g.fill();
    if (label) {
      g.font = `bold ${10 * dpr}px system-ui, sans-serif`;
      g.fillStyle = '#000';
      g.fillRect(x + 2 * dpr, top ? s * 1.3 : H - s * 1.3 - 12 * dpr, 12 * dpr, 12 * dpr);
      g.fillStyle = color;
      g.fillText(label, x + 4.5 * dpr, top ? s * 1.3 + 10 * dpr : H - s * 1.3 - 2 * dpr);
    }
  }

  function drawZoom(cv, deck, span) {
    fit(cv);
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const dpr = window.devicePixelRatio || 1;
    const pal = PALETTE[deck.id];
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    const tr = deck.track;
    const cx = W / 2;
    if (!tr || deck.loading) {
      g.fillStyle = '#5b6474';
      g.font = `${12 * dpr}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText(deck.loading ? 'Chargement…' : `Deck ${deck.id} — glissez un morceau ici`, cx, H / 2 + 4 * dpr);
      g.textAlign = 'start';
      return;
    }
    const t = deck.displayTime;
    const t0 = t - span / 2, t1 = t + span / 2;
    const pps = W / span;
    const X = (ts) => (ts - t0) * pps;

    // boucle
    const L = deck.loop;
    if (L.end > L.start) {
      g.fillStyle = L.on ? 'rgba(34,197,94,0.22)' : 'rgba(148,163,184,0.12)';
      g.fillRect(X(L.start), 0, (L.end - L.start) * pps, H);
    } else if (deck.loopIn != null) {
      g.fillStyle = 'rgba(34,197,94,0.6)';
      g.fillRect(X(deck.loopIn), 0, dpr, H);
    }

    columns(g, tr, t0, t1, W, H, pal);

    // grille rythmique
    if (deck.period) {
      const p = deck.period;
      const k0 = Math.ceil((t0 - tr.beatOffset) / p);
      const k1 = Math.floor((t1 - tr.beatOffset) / p);
      if (k1 - k0 < 400) {
        for (let k = k0; k <= k1; k++) {
          const x = Math.round(X(tr.beatOffset + k * p));
          const bar = ((k % 4) + 4) % 4 === 0;
          g.fillStyle = bar ? 'rgba(248,113,113,0.85)' : 'rgba(255,255,255,0.28)';
          g.fillRect(x, 0, bar ? 2 * dpr : dpr, bar ? H : H * 0.12);
          if (!bar) g.fillRect(x, H - H * 0.12, dpr, H * 0.12);
        }
      }
    }

    // cue principal + hot cues
    if (deck.cue >= t0 && deck.cue <= t1) marker(g, X(deck.cue), H, '#f59e0b', '', dpr, false);
    tr.hotcues.forEach((c, i) => {
      if (c != null && c >= t0 && c <= t1) marker(g, X(c), H, HC[i], 'ABCDEFGH'[i], dpr, true);
    });

    // tête de lecture
    g.fillStyle = '#fff';
    g.fillRect(Math.round(cx) - dpr, 0, 2 * dpr, H);
  }

  const cache = new WeakMap();
  function drawOverview(cv, deck) {
    const resized = fit(cv);
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const dpr = window.devicePixelRatio || 1;
    const tr = deck.track;
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    if (!tr || deck.loading || !deck.dur) return;
    let c = cache.get(cv);
    if (!c || c.id !== tr.id || resized || c.w !== W || c.h !== H) {
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const og = off.getContext('2d');
      columns(og, tr, 0, deck.dur, W, H, PALETTE[deck.id]);
      c = { id: tr.id, w: W, h: H, img: off };
      cache.set(cv, c);
    }
    g.drawImage(c.img, 0, 0);
    const X = (ts) => (ts / deck.dur) * W;
    const ph = X(deck.displayTime);
    g.fillStyle = 'rgba(10,12,17,0.55)';
    g.fillRect(0, 0, ph, H);
    const L = deck.loop;
    if (L.end > L.start) {
      g.fillStyle = L.on ? 'rgba(34,197,94,0.35)' : 'rgba(148,163,184,0.2)';
      g.fillRect(X(L.start), 0, Math.max(2 * dpr, X(L.end) - X(L.start)), H);
    }
    g.fillStyle = '#f59e0b';
    g.fillRect(X(deck.cue), 0, dpr, H);
    tr.hotcues.forEach((cpos, i) => {
      if (cpos == null) return;
      g.fillStyle = HC[i];
      g.fillRect(X(cpos) - dpr, 0, 2 * dpr, H * 0.35);
    });
    // repères de minutes
    g.fillStyle = 'rgba(255,255,255,0.15)';
    for (let m = 60; m < deck.dur; m += 60) g.fillRect(Math.round(X(m)), H - 4 * dpr, dpr, 4 * dpr);
    g.fillStyle = '#fff';
    g.fillRect(Math.round(ph) - dpr, 0, 2 * dpr, H);
  }

  return { drawZoom, drawOverview, HC, PALETTE };
})();
