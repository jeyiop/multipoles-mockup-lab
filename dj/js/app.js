'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (t) => {
    if (!isFinite(t)) t = 0;
    const neg = t < 0; t = Math.abs(t);
    const m = Math.floor(t / 60), s = t - m * 60;
    return (neg ? '-' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  };
  const fmtDur = (t) => { t = Math.round(t || 0); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  const keyColor = (cam) => { const n = parseInt(cam, 10); return n ? `hsl(${((n - 1) * 30 + 200) % 360} 75% ${cam.endsWith('A') ? 62 : 72}%)` : '#555'; };
  const AUDIO_EXT = /\.(mp3|wav|wave|aif|aiff|flac|m4a|mp4|aac|ogg|oga|opus|webm)$/i;
  const ID = ['A', 'B'];

  /* ---------------- État ---------------- */
  const S = {
    tracks: new Map(),
    playlists: [],
    view: 'collection',
    sort: { col: 'addedAt', dir: -1 },
    search: '',
    compat: '',
    selected: new Set(),
    anchor: null,
    history: [],
    zoom: 8,
    mix: {
      A: { trim: 0, high: 0, mid: 0, low: 0, filter: 0, fader: 0.8 },
      B: { trim: 0, high: 0, mid: 0, low: 0, filter: 0, fader: 0.8 },
      master: 0.8, xf: 0.5, curve: 'smooth',
    },
  };
  const decks = {};
  const channels = {};
  const ui = {};
  let engineP = null;

  const setStatus = (t) => { $('#status').textContent = t; };

  /* ---------------- Moteur ---------------- */
  function ensureEngine() {
    if (engineP) return engineP;
    engineP = (async () => {
      await Engine.init();
      for (const id of ID) {
        channels[id] = new Channel(Engine.ctx, Engine.bus);
        const d = new Deck(id, channels[id]);
        d.onChange = () => renderDeck(id);
        d.onTrackEdit = (tr) => saveTrack(tr);
        d.onFirstPlay = (dk) => addHistory(dk);
        decks[id] = d;
      }
      applyMix();
      requestAnimationFrame(frame);
    })().catch((e) => {
      console.error(e);
      setStatus('Impossible de démarrer le moteur audio : ' + e.message);
      engineP = null;
      throw e;
    });
    return engineP;
  }
  const other = (id) => decks[id === 'A' ? 'B' : 'A'];

  function applyMix() {
    if (!Engine.ctx) return;
    for (const id of ID) {
      const m = S.mix[id], c = channels[id];
      c.setTrim(m.trim); c.setEq('high', m.high); c.setEq('mid', m.mid); c.setEq('low', m.low);
      c.setFilter(m.filter); c.setFader(m.fader);
    }
    Engine.smooth(Engine.master.gain, S.mix.master * S.mix.master * 1.25);
    applyXf();
  }
  function applyXf() {
    if (!Engine.ctx) return;
    const x = S.mix.xf;
    let a, b;
    if (S.mix.curve === 'smooth') { a = Math.cos((x * Math.PI) / 2); b = Math.sin((x * Math.PI) / 2); }
    else if (S.mix.curve === 'dj') { a = Math.min(1, 2 * (1 - x)); b = Math.min(1, 2 * x); }
    else { a = x > 0.97 ? 0 : 1; b = x < 0.03 ? 0 : 1; }
    channels.A.setXf(a); channels.B.setXf(b);
  }

  /* ---------------- Boutons rotatifs ---------------- */
  class Knob {
    constructor(slot, { label, min = -1, max = 1, value = 0, def = 0, onChange }) {
      this.min = min; this.max = max; this.def = def; this.onChange = onChange;
      this.el = document.createElement('div');
      this.el.className = 'knob';
      this.el.innerHTML = `<div class="dial"></div><label>${esc(label)}</label>`;
      slot.appendChild(this.el);
      this.dial = this.el.firstChild;
      this.set(value, false);
      let y0 = 0, v0 = 0;
      this.el.addEventListener('pointerdown', (e) => {
        this.el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = this.value; e.preventDefault();
      });
      this.el.addEventListener('pointermove', (e) => {
        if (!this.el.hasPointerCapture(e.pointerId)) return;
        const k = e.shiftKey ? 600 : 160;
        this.set(v0 + ((y0 - e.clientY) / k) * (this.max - this.min));
      });
      this.el.addEventListener('dblclick', () => this.set(this.def));
      this.el.addEventListener('wheel', (e) => { e.preventDefault(); this.set(this.value - Math.sign(e.deltaY) * (this.max - this.min) * 0.02); }, { passive: false });
    }
    set(v, notify = true) {
      v = clamp(v, this.min, this.max);
      if (Math.abs(v - this.def) < (this.max - this.min) * 0.012) v = this.def; // cran central
      this.value = v;
      this.dial.style.setProperty('--rot', (-135 + (270 * (v - this.min)) / (this.max - this.min)) + 'deg');
      this.el.classList.toggle('kill', this.min < 0 && v <= this.min + 0.001);
      if (notify) this.onChange(v);
    }
  }

  /* ---------------- Construction de l'interface ---------------- */
  function buildDeck(id) {
    const root = $('#deck' + id);
    root.appendChild($('#deck-tpl').content.cloneNode(true));
    $('.deck-letter', root).textContent = id;
    const hcWrap = $('.hotcues', root);
    for (let i = 0; i < 8; i++) {
      const b = document.createElement('button');
      b.className = 'btn hc'; b.dataset.hc = i; b.textContent = 'ABCDEFGH'[i];
      b.title = 'Hot cue ' + 'ABCDEFGH'[i] + ' (Maj+clic : effacer)';
      hcWrap.appendChild(b);
    }
    const q = (s) => $(s, root);
    ui[id] = {
      root, title: q('.d-title'), artist: q('.d-artist'), bpm: q('.d-bpm'), pitch: q('.d-pitch'),
      key: q('.d-key'), time: q('.d-time'), remain: q('.d-remain'), beats: $$('.d-beat i', root),
      overview: q('.overview'), slider: q('.tempo-slider'), play: q('[data-act=play]'), cue: q('[data-act=cue]'),
      sync: q('[data-act=sync]'), quant: q('[data-act=quant]'), keylock: q('[data-act=keylock]'),
      range: q('[data-act=range]'), loopAuto: q('[data-act=loop-auto]'), loopExit: q('[data-act=loop-exit]'),
      hcs: $$('.hc', root), zoom: $('#zoom' + id), last: {},
    };
    const U = ui[id];

    root.addEventListener('click', async (e) => {
      const hc = e.target.closest('[data-hc]');
      const btn = e.target.closest('[data-act]');
      if (!hc && !btn) return;
      await ensureEngine();
      const d = decks[id];
      if (hc) { d.hotcue(+hc.dataset.hc, e.shiftKey); return; }
      const act = btn.dataset.act;
      switch (act) {
        case 'play': d.toggle(); break;
        case 'sync':
          if (d.syncLock) { d.syncLock = false; d.emit(); }
          else if (d.syncTo(other(id))) { d.syncLock = true; d.emit(); }
          else setStatus('SYNC : les deux decks doivent avoir un morceau avec BPM.');
          break;
        case 'quant': d.quant = !d.quant; d.emit(); break;
        case 'keylock': d.setKeylock(!d.keylock); break;
        case 'range': d.cycleRange(); break;
        case 'loop-auto': d.autoLoop(); break;
        case 'loop-half': d.resizeLoop(0.5); break;
        case 'loop-double': d.resizeLoop(2); break;
        case 'loop-in': d.markLoopIn(); break;
        case 'loop-out': d.markLoopOut(); break;
        case 'loop-exit': d.exitLoop(); break;
        case 'bpm-half': d.scaleBpm(0.5); refreshTable(); break;
        case 'bpm-double': d.scaleBpm(2); refreshTable(); break;
        case 'grid-left': d.shiftGrid(-0.005); break;
        case 'grid-right': d.shiftGrid(0.005); break;
        case 'grid-here': d.gridHere(); break;
      }
    });
    // CUE et nudge : maintenir
    const hold = (el, down, up) => {
      el.addEventListener('pointerdown', async (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); await ensureEngine(); down(decks[id], e); });
      el.addEventListener('pointerup', () => decks[id] && up(decks[id]));
      el.addEventListener('pointercancel', () => decks[id] && up(decks[id]));
    };
    hold(U.cue, (d) => d.cueDown(), (d) => d.cueUp());
    hold(q('[data-act=nudge-down]'), (d, e) => d.setNudge(e.shiftKey ? -0.1 : -0.04), (d) => d.setNudge(0));
    hold(q('[data-act=nudge-up]'), (d, e) => d.setNudge(e.shiftKey ? 0.1 : 0.04), (d) => d.setNudge(0));

    U.slider.addEventListener('input', async () => {
      await ensureEngine();
      const d = decks[id];
      d.syncLock = false;
      d.setTempo(+U.slider.value * d.range);
    });
    U.slider.addEventListener('dblclick', async () => { await ensureEngine(); decks[id].syncLock = false; decks[id].setTempo(0); });

    // vue d'ensemble : clic / glisser pour se déplacer
    const ovSeek = (e) => {
      const d = decks[id];
      if (!d || !d.track) return;
      const r = U.overview.getBoundingClientRect();
      d.seek(clamp((e.clientX - r.left) / r.width, 0, 1) * d.dur);
    };
    U.overview.addEventListener('pointerdown', async (e) => { await ensureEngine(); U.overview.setPointerCapture(e.pointerId); ovSeek(e); });
    U.overview.addEventListener('pointermove', (e) => { if (U.overview.hasPointerCapture(e.pointerId)) ovSeek(e); });

    // waveform zoomée : glisser pour scrubber
    let drag = null;
    U.zoom.addEventListener('pointerdown', async (e) => {
      await ensureEngine();
      const d = decks[id];
      if (!d.track) return;
      U.zoom.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, t: d.time, wasPlaying: d.playing };
      if (d.playing) d.pause();
    });
    U.zoom.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const d = decks[id];
      const pps = U.zoom.clientWidth / S.zoom;
      d.seek(drag.t - (e.clientX - drag.x) / pps);
    });
    const endDrag = () => { if (drag && drag.wasPlaying) decks[id].play(); drag = null; };
    U.zoom.addEventListener('pointerup', endDrag);
    U.zoom.addEventListener('pointercancel', endDrag);
    U.zoom.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(Math.sign(e.deltaY)); }, { passive: false });

    // dépôt d'un morceau sur le deck
    for (const el of [root, U.zoom]) {
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-track')) { e.preventDefault(); root.classList.add('drop'); } });
      el.addEventListener('dragleave', () => root.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        root.classList.remove('drop');
        const ids = e.dataTransfer.getData('text/x-track');
        if (ids) { e.preventDefault(); e.stopPropagation(); loadToDeck(id, ids.split('\n')[0]); }
      });
    }
  }

  function buildMixer() {
    for (const id of ID) {
      const col = $(`.ch[data-ch="${id}"]`);
      const m = S.mix[id];
      const knob = (key, label) => {
        const slot = document.createElement('div');
        slot.className = 'knob-slot';
        col.appendChild(slot);
        new Knob(slot, { label, value: m[key], onChange: (v) => { m[key] = v; applyMix(); } });
      };
      knob('trim', 'TRIM'); knob('high', 'HI'); knob('mid', 'MID'); knob('low', 'LOW'); knob('filter', 'FILTRE');
      const meter = document.createElement('div');
      meter.className = 'meter'; meter.innerHTML = '<i></i>';
      col.appendChild(meter);
      const fader = document.createElement('input');
      Object.assign(fader, { type: 'range', min: 0, max: 1, step: 0.001, value: m.fader, className: 'fader', title: 'Volume ' + id });
      fader.addEventListener('input', () => { m.fader = +fader.value; applyMix(); });
      fader.addEventListener('dblclick', () => { fader.value = 0.8; m.fader = 0.8; applyMix(); });
      col.appendChild(fader);
      ui['meter' + id] = meter.firstChild;
    }
    new Knob($('[data-knob=master]'), { label: 'VOL', min: 0, max: 1, value: S.mix.master, def: 0.8, onChange: (v) => { S.mix.master = v; applyMix(); } });
    ui.meterM = $('.meter.master i');
    const xf = $('#xfader');
    xf.addEventListener('input', () => { S.mix.xf = +xf.value; applyXf(); });
    xf.addEventListener('dblclick', () => { xf.value = 0.5; S.mix.xf = 0.5; applyXf(); });
    $('#xcurve').addEventListener('change', (e) => { S.mix.curve = e.target.value; applyXf(); });
    ui.xf = xf;
  }

  function zoomBy(dir) {
    const steps = [2, 4, 8, 16, 32, 64];
    const i = clamp(steps.indexOf(S.zoom) + dir, 0, steps.length - 1);
    S.zoom = steps[i];
  }

  /* ---------------- Rendu des decks ---------------- */
  function setText(U, key, el, v) { if (U.last[key] !== v) { U.last[key] = v; el.textContent = v; } }

  function renderDeck(id) {
    const d = decks[id], U = ui[id];
    if (!d) return;
    const tr = d.track;
    setText(U, 'title', U.title, d.loading ? 'Chargement…' : tr ? tr.title : 'Aucun morceau');
    setText(U, 'artist', U.artist, tr ? tr.artist || '—' : 'Glissez un morceau depuis la bibliothèque');
    U.key.textContent = tr && tr.camelot ? `${tr.camelot} · ${tr.key}` : '';
    U.key.style.background = tr && tr.camelot ? keyColor(tr.camelot) : 'transparent';
    U.key.style.color = '#000';
    U.play.classList.toggle('on', d.playing);
    U.sync.classList.toggle('on', d.syncLock);
    U.quant.classList.toggle('on', d.quant);
    U.keylock.classList.toggle('on', d.keylock);
    U.range.textContent = '±' + d.range + '%';
    U.slider.value = d.tempo / d.range;
    U.loopAuto.textContent = fmtBeats(d.loopBeats);
    U.loopAuto.classList.toggle('on', d.loop.on);
    U.loopExit.textContent = d.loop.on || !(d.loop.end > d.loop.start) ? 'EXIT' : 'RELOOP';
    U.loopExit.classList.toggle('on', d.loop.on);
    U.hcs.forEach((b, i) => {
      const set = tr && tr.hotcues && tr.hotcues[i] != null;
      b.classList.toggle('set', !!set);
      b.style.background = set ? Wave.HC[i] : '';
    });
    refreshLoadedMarks();
  }
  function fmtBeats(b) {
    if (b >= 1) return String(Math.round(b * 100) / 100);
    return '1/' + Math.round(1 / b);
  }

  function frame() {
    for (const id of ID) {
      const d = decks[id], U = ui[id];
      // suivi du tempo en mode SYNC verrouillé
      const o = other(id);
      if (d.syncLock && d.track && o.track && o.bpm) {
        const r = o.bpm / d.track.bpm;
        let rr = r; while (rr > 1.45) rr /= 2; while (rr < 0.7) rr *= 2;
        if (Math.abs((rr - 1) * 100 - d.tempo) > 0.005) { d.tempo = clamp((rr - 1) * 100, -d.range, d.range); d.applyRate(); U.slider.value = d.tempo / d.range; }
      }
      const t = d.displayTime;
      setText(U, 'time', U.time, fmt(t));
      setText(U, 'remain', U.remain, '-' + fmt(Math.max(0, d.dur - t)));
      setText(U, 'bpm', U.bpm, d.bpm ? d.bpm.toFixed(2) : '—');
      setText(U, 'pitch', U.pitch, (d.tempo >= 0 ? '+' : '') + d.tempo.toFixed(2) + '%' + (d.nudge ? (d.nudge > 0 ? ' ▶' : ' ◀') : ''));
      const beat = d.period ? ((Math.floor(d.beatPos(t) + 0.03) % 4) + 4) % 4 : -1;
      if (U.last.beat !== beat) { U.last.beat = beat; U.beats.forEach((b, i) => b.classList.toggle('on', i === beat)); }
      U.cue.classList.toggle('on', !!d.track && !d.playing && Math.abs(d.time - d.cue) < 0.03);
      Wave.drawZoom(U.zoom, d, S.zoom);
      Wave.drawOverview(U.overview, d);
      setMeter(ui['meter' + id], channels[id].meter.level());
    }
    setMeter(ui.meterM, Engine.meter.level());
    if (rec) $('#rec-time').textContent = fmt((performance.now() - rec.start) / 1000).replace(/\.\d$/, '');
    requestAnimationFrame(frame);
  }
  function setMeter(el, peak) {
    const db = 20 * Math.log10(peak + 1e-9);
    const v = clamp((db + 48) / 48, 0, 1);
    el.style.height = (100 - v * 100).toFixed(1) + '%';
  }

  /* ---------------- Chargement d'un morceau ---------------- */
  async function loadToDeck(id, trackId) {
    await ensureEngine();
    const tr = S.tracks.get(trackId);
    if (!tr) return;
    const d = decks[id];
    if (d.playing && !confirm(`Le deck ${id} est en lecture. Remplacer le morceau ?`)) return;
    const f = await DB.get('files', trackId);
    if (!f) { setStatus('Fichier audio introuvable pour « ' + tr.title + ' ».'); return; }
    setStatus(`Chargement de « ${tr.title} » sur le deck ${id}…`);
    try {
      const ok = await d.load(tr, f.blob);
      if (ok) setStatus(`Deck ${id} : ${tr.artist ? tr.artist + ' — ' : ''}${tr.title}`);
    } catch (e) {
      console.error(e);
      d.loading = false; d.emit();
      setStatus('Lecture impossible : ' + e.message);
    }
  }
  function loadSmart(trackId) {
    const free = ID.find((id) => !decks[id] || !decks[id].playing) || 'A';
    loadToDeck(free, trackId);
  }

  function addHistory(d) {
    if (!d.track) return;
    S.history.push({ id: d.track.id, at: Date.now(), deck: d.id });
    d.track.plays = (d.track.plays || 0) + 1;
    saveTrack(d.track);
    renderTree();
    if (S.view === 'history') refreshTable();
  }

  /* ---------------- Persistance ---------------- */
  const saveTimers = new Map();
  function saveTrack(tr) {
    clearTimeout(saveTimers.get(tr.id));
    saveTimers.set(tr.id, setTimeout(() => DB.put('tracks', tr).catch(console.error), 400));
  }
  const savePlaylist = (pl) => DB.put('playlists', pl).catch(console.error);

  /* ---------------- Import & analyse ---------------- */
  const fileId = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  let decodeCtx = null;
  const queue = [];
  let busy = false;

  function importFiles(files) {
    const list = [...files].filter((f) => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/'));
    const fresh = list.filter((f) => !S.tracks.has(fileId(f)) && !queue.some((q) => fileId(q) === fileId(f)));
    if (!list.length) { setStatus('Aucun fichier audio reconnu.'); return; }
    if (!fresh.length) { setStatus('Ces morceaux sont déjà dans la bibliothèque.'); return; }
    queue.push(...fresh);
    processQueue();
  }

  async function processQueue() {
    if (busy) return;
    busy = true;
    let done = 0, failed = 0;
    if (!decodeCtx) decodeCtx = new OfflineAudioContext(1, 1, 22050);
    while (queue.length) {
      const f = queue.shift();
      setStatus(`Analyse ${done + failed + 1}/${done + failed + 1 + queue.length} — ${f.name}`);
      try {
        const tags = await Tags.read(f);
        const ab = await f.arrayBuffer();
        const buf = await decodeCtx.decodeAudioData(ab);
        const a = await Analysis.analyze(buf);
        const tr = {
          id: fileId(f), fileName: f.name, ...tags, ...a,
          cue: 0, hotcues: new Array(8).fill(null), addedAt: Date.now(), plays: 0,
        };
        // le premier temps comme point de cue par défaut
        tr.cue = a.bpm ? a.beatOffset : 0;
        await DB.put('files', { id: tr.id, blob: f });
        await DB.put('tracks', tr);
        S.tracks.set(tr.id, tr);
        done++;
        refreshTable();
        renderTree();
      } catch (e) {
        console.error(f.name, e);
        failed++;
      }
    }
    busy = false;
    setStatus(`Import terminé : ${done} morceau(x) analysé(s)` + (failed ? `, ${failed} illisible(s) par ce navigateur.` : '.'));
  }

  async function filesFromDataTransfer(dt) {
    const items = [...(dt.items || [])];
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return [...dt.files];
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e);
    return out;
  }

  /* ---------------- Bibliothèque ---------------- */
  function camelotParts(c) { const n = parseInt(c, 10); return n ? { n, l: c.slice(-1) } : null; }
  function compatible(a, b) {
    const x = camelotParts(a), y = camelotParts(b);
    if (!x || !y) return false;
    if (x.n === y.n) return true;
    if (x.l !== y.l) return false;
    const d = Math.abs(x.n - y.n);
    return d === 1 || d === 11;
  }

  function currentIds() {
    if (S.view === 'collection') return [...S.tracks.keys()];
    if (S.view === 'history') return S.history.map((h) => h.id);
    const pl = S.playlists.find((p) => p.id === S.view);
    return pl ? pl.trackIds : [];
  }

  function viewRows() {
    let rows = currentIds().map((id, i) => ({ t: S.tracks.get(id), order: i + 1, h: S.view === 'history' ? S.history[i] : null })).filter((r) => r.t);
    const toks = S.search.toLowerCase().split(/\s+/).filter(Boolean);
    if (toks.length) {
      rows = rows.filter(({ t }) => {
        const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.camelot} ${t.key} ${Math.round(t.bpm)}`.toLowerCase();
        return toks.every((k) => hay.includes(k));
      });
    }
    if (S.compat) {
      const d = decks[S.compat];
      const ref = d && d.track;
      if (ref) {
        const bpm = d.bpm || ref.bpm;
        rows = rows.filter(({ t }) => {
          if (t.id === ref.id || !compatible(ref.camelot, t.camelot) || !t.bpm) return false;
          const ratio = [t.bpm, t.bpm * 2, t.bpm / 2].map((b) => Math.abs(b / bpm - 1));
          return Math.min(...ratio) <= 0.06;
        });
      } else rows = [];
    }
    const { col, dir } = S.sort;
    const val = (r) => {
      if (col === 'order') return r.order;
      if (col === 'camelot') { const p = camelotParts(r.t.camelot || ''); return p ? p.n * 2 + (p.l === 'B' ? 1 : 0) : 99; }
      const v = r.t[col];
      return typeof v === 'string' ? v.toLowerCase() : v || 0;
    };
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    return rows;
  }

  let rowsCache = [];
  function refreshTable() {
    rowsCache = viewRows();
    const onA = decks.A && decks.A.track ? decks.A.track.id : null;
    const onB = decks.B && decks.B.track ? decks.B.track.id : null;
    const html = rowsCache.map(({ t, order, h }) => {
      const cls = [S.selected.has(t.id) ? 'sel' : '', t.id === onA ? 'onA' : '', t.id === onB ? 'onB' : ''].join(' ');
      const added = h ? new Date(h.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : new Date(t.addedAt).toLocaleDateString('fr-FR');
      return `<tr draggable="true" data-id="${esc(t.id)}" class="${cls}">
        <td class="load"><button class="btn ld a" data-load="A" title="Charger sur A">A</button> <button class="btn ld b" data-load="B" title="Charger sur B">B</button></td>
        <td class="num">${order}</td>
        <td title="${esc(t.fileName)}">${esc(t.title)}</td>
        <td>${esc(t.artist)}</td>
        <td class="num bpm-cell" title="Double-clic pour corriger">${t.bpm ? t.bpm.toFixed(2) : '—'}</td>
        <td>${t.camelot ? `<span class="key" style="background:${keyColor(t.camelot)}">${esc(t.camelot)}</span><span class="kn">${esc(t.key)}</span>` : '—'}</td>
        <td class="num">${fmtDur(t.duration)}</td>
        <td>${esc(t.genre)}</td>
        <td>${added}</td>
      </tr>`;
    }).join('');
    $('#tbody').innerHTML = html;
    $('#empty').classList.toggle('show', S.tracks.size === 0);
    $('#count').textContent = `${rowsCache.length} morceau${rowsCache.length > 1 ? 'x' : ''}`;
    $$('.tracks th').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === S.sort.col);
      th.classList.toggle('asc', S.sort.dir === 1);
    });
  }
  function refreshLoadedMarks() {
    const onA = decks.A && decks.A.track ? decks.A.track.id : null;
    const onB = decks.B && decks.B.track ? decks.B.track.id : null;
    $$('#tbody tr').forEach((tr) => {
      tr.classList.toggle('onA', tr.dataset.id === onA);
      tr.classList.toggle('onB', tr.dataset.id === onB);
    });
    if (S.compat) refreshTable();
  }

  function renderTree() {
    const pls = S.playlists.map((p) => `<li data-view="${esc(p.id)}" class="${S.view === p.id ? 'active' : ''}" title="Double-clic : renommer">
      ♪ <span class="nm">${esc(p.name)}</span><span class="n">${p.trackIds.length}</span><span class="x" data-del="${esc(p.id)}" title="Supprimer la playlist">×</span></li>`).join('');
    $('#tree').innerHTML = `
      <li data-view="collection" class="${S.view === 'collection' ? 'active' : ''}">▤ Collection<span class="n">${S.tracks.size}</span></li>
      <li data-view="history" class="${S.view === 'history' ? 'active' : ''}">◷ Historique (session)<span class="n">${S.history.length}</span></li>
      <li class="sep">PLAYLISTS <button class="btn mini" id="btn-newpl" title="Nouvelle playlist">+</button></li>
      ${pls || '<li class="sep" style="letter-spacing:0">Aucune playlist</li>'}`;
    $('#add-to').innerHTML = '<option value="">Ajouter à…</option>' + S.playlists.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') + '<option value="__new">+ Nouvelle playlist…</option>';
  }

  function newPlaylist(ids = []) {
    const name = prompt('Nom de la playlist :', 'Nouvelle playlist');
    if (!name) return null;
    const pl = { id: 'pl_' + Date.now().toString(36), name: name.trim(), trackIds: [...ids] };
    S.playlists.push(pl);
    savePlaylist(pl);
    renderTree();
    return pl;
  }
  function addToPlaylist(pl, ids) {
    let n = 0;
    for (const id of ids) if (!pl.trackIds.includes(id)) { pl.trackIds.push(id); n++; }
    savePlaylist(pl);
    renderTree();
    if (S.view === pl.id) refreshTable();
    setStatus(`${n} morceau(x) ajouté(s) à « ${pl.name} ».`);
  }

  async function deleteSelection() {
    const ids = [...S.selected];
    if (!ids.length) return;
    if (S.view === 'collection') {
      const loaded = ID.some((id) => decks[id] && decks[id].track && ids.includes(decks[id].track.id));
      if (loaded) { setStatus('Éjectez d\'abord le morceau chargé sur un deck.'); return; }
      if (!confirm(`Supprimer ${ids.length} morceau(x) de la bibliothèque (cues et analyse compris) ?`)) return;
      for (const id of ids) {
        S.tracks.delete(id);
        await DB.del('tracks', id); await DB.del('files', id);
      }
      for (const pl of S.playlists) {
        const before = pl.trackIds.length;
        pl.trackIds = pl.trackIds.filter((x) => !ids.includes(x));
        if (pl.trackIds.length !== before) savePlaylist(pl);
      }
    } else if (S.view !== 'history') {
      const pl = S.playlists.find((p) => p.id === S.view);
      if (pl) { pl.trackIds = pl.trackIds.filter((x) => !S.selected.has(x)); savePlaylist(pl); }
    }
    S.selected.clear();
    renderTree();
    refreshTable();
  }

  function exportTracklist() {
    if (!rowsCache.length) return;
    const t0 = S.view === 'history' && S.history.length ? S.history[0].at : 0;
    const lines = rowsCache.map(({ t, order, h }) => {
      const ts = h ? fmtDur((h.at - t0) / 1000).padStart(5, ' ') + '  ' : '';
      return `${String(order).padStart(2, '0')}. ${ts}${t.artist ? t.artist + ' - ' : ''}${t.title}  [${t.bpm ? t.bpm.toFixed(1) : '?'} BPM | ${t.camelot || '?'}]`;
    });
    const name = S.view === 'collection' ? 'collection' : S.view === 'history' ? 'historique' : (S.playlists.find((p) => p.id === S.view) || {}).name || 'playlist';
    download(new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), `tracklist-${name}.txt`);
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function bindLibrary() {
    $('#in-files').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    $('#in-folder').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    $('#search').addEventListener('input', (e) => { S.search = e.target.value; refreshTable(); });
    $('#compat').addEventListener('change', (e) => { S.compat = e.target.value; refreshTable(); });
    $('#btn-export').addEventListener('click', exportTracklist);
    $('#add-to').addEventListener('change', (e) => {
      const v = e.target.value;
      e.target.value = '';
      const ids = [...S.selected];
      if (!ids.length) { setStatus('Sélectionnez d\'abord des morceaux.'); return; }
      if (v === '__new') { const pl = newPlaylist(ids); if (pl) setStatus(`Playlist « ${pl.name} » créée.`); }
      else if (v) addToPlaylist(S.playlists.find((p) => p.id === v), ids);
    });

    $$('.tracks th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const col = th.dataset.sort;
      S.sort = { col, dir: S.sort.col === col ? -S.sort.dir : col === 'addedAt' ? -1 : 1 };
      refreshTable();
    }));

    const tbody = $('#tbody');
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const id = tr.dataset.id;
      const ld = e.target.closest('[data-load]');
      if (ld) { loadToDeck(ld.dataset.load, id); return; }
      if (e.shiftKey && S.anchor) {
        const ids = rowsCache.map((r) => r.t.id);
        const a = ids.indexOf(S.anchor), b = ids.indexOf(id);
        if (a >= 0 && b >= 0) { S.selected = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); }
      } else if (e.metaKey || e.ctrlKey) {
        S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
        S.anchor = id;
      } else {
        S.selected = new Set([id]);
        S.anchor = id;
      }
      $$('#tbody tr').forEach((r) => r.classList.toggle('sel', S.selected.has(r.dataset.id)));
    });
    tbody.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr');
      if (!tr || e.target.closest('[data-load]')) return;
      const t = S.tracks.get(tr.dataset.id);
      if (e.target.closest('.bpm-cell')) {
        const v = prompt(`BPM de « ${t.title} » :`, t.bpm ? t.bpm.toFixed(2) : '');
        const n = parseFloat(String(v).replace(',', '.'));
        if (n > 20 && n < 400) {
          t.bpm = Math.round(n * 100) / 100;
          saveTrack(t);
          refreshTable();
          ID.forEach((id) => decks[id] && decks[id].track === t && decks[id].emit());
        }
        return;
      }
      loadSmart(tr.dataset.id);
    });
    tbody.addEventListener('dragstart', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      if (!S.selected.has(tr.dataset.id)) {
        S.selected = new Set([tr.dataset.id]);
        $$('#tbody tr').forEach((r) => r.classList.toggle('sel', S.selected.has(r.dataset.id)));
      }
      const ids = [tr.dataset.id, ...[...S.selected].filter((x) => x !== tr.dataset.id)];
      e.dataTransfer.setData('text/x-track', ids.join('\n'));
      e.dataTransfer.effectAllowed = 'copy';
    });

    const tree = $('#tree');
    tree.addEventListener('click', (e) => {
      if (e.target.closest('#btn-newpl')) { newPlaylist(); return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        const pl = S.playlists.find((p) => p.id === del.dataset.del);
        if (pl && confirm(`Supprimer la playlist « ${pl.name} » ? (les morceaux restent dans la collection)`)) {
          S.playlists = S.playlists.filter((p) => p !== pl);
          DB.del('playlists', pl.id);
          if (S.view === pl.id) S.view = 'collection';
          renderTree(); refreshTable();
        }
        return;
      }
      const li = e.target.closest('[data-view]');
      if (!li) return;
      S.view = li.dataset.view;
      S.selected.clear();
      S.sort = S.view === 'collection' ? { col: 'addedAt', dir: -1 } : { col: 'order', dir: 1 };
      renderTree(); refreshTable();
    });
    tree.addEventListener('dblclick', (e) => {
      const li = e.target.closest('[data-view^="pl_"]');
      if (!li) return;
      const pl = S.playlists.find((p) => p.id === li.dataset.view);
      const name = prompt('Renommer la playlist :', pl.name);
      if (name) { pl.name = name.trim(); savePlaylist(pl); renderTree(); }
    });
    tree.addEventListener('dragover', (e) => {
      const li = e.target.closest('[data-view^="pl_"]');
      if (li && e.dataTransfer.types.includes('text/x-track')) { e.preventDefault(); li.classList.add('drop'); }
    });
    tree.addEventListener('dragleave', (e) => { const li = e.target.closest('li'); if (li) li.classList.remove('drop'); });
    tree.addEventListener('drop', (e) => {
      const li = e.target.closest('[data-view^="pl_"]');
      if (!li) return;
      e.preventDefault();
      e.stopPropagation();
      li.classList.remove('drop');
      const pl = S.playlists.find((p) => p.id === li.dataset.view);
      addToPlaylist(pl, e.dataTransfer.getData('text/x-track').split('\n').filter(Boolean));
    });

    // dépôt de fichiers depuis l'ordinateur
    const hint = $('#drop-hint');
    let depth = 0;
    const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => { if (isFiles(e)) { depth++; hint.classList.add('show'); } });
    window.addEventListener('dragleave', (e) => { if (isFiles(e) && --depth <= 0) { depth = 0; hint.classList.remove('show'); } });
    window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0; hint.classList.remove('show');
      importFiles(await filesFromDataTransfer(e.dataTransfer));
    });
  }

  /* ---------------- Enregistrement du mix ---------------- */
  let rec = null;
  async function toggleRec() {
    await ensureEngine();
    const btn = $('#btn-rec');
    if (rec) { rec.mr.stop(); return; }
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    const mime = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    let mr;
    try { mr = new MediaRecorder(Engine.recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : undefined); }
    catch (e) { setStatus('Enregistrement non pris en charge par ce navigateur.'); return; }
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      const type = mr.mimeType || mime || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      download(new Blob(chunks, { type }), `mix-${stamp}.${ext}`);
      rec = null;
      btn.classList.remove('on');
      $('#rec-time').textContent = '';
      setStatus('Mix enregistré et téléchargé.');
    };
    mr.start(1000);
    rec = { mr, start: performance.now() };
    btn.classList.add('on');
    setStatus('Enregistrement du mix en cours…');
  }

  /* ---------------- Clavier ---------------- */
  function bindKeys() {
    const map = {
      q: ['A', 'play'], a: ['A', 'cue'], w: ['A', 'sync'], e: ['A', 'loop'], z: ['A', 'nd'], x: ['A', 'nu'],
      '1': ['A', 'hc', 0], '2': ['A', 'hc', 1], '3': ['A', 'hc', 2], '4': ['A', 'hc', 3],
      p: ['B', 'play'], l: ['B', 'cue'], o: ['B', 'sync'], i: ['B', 'loop'], ',': ['B', 'nd'], '.': ['B', 'nu'],
      '7': ['B', 'hc', 0], '8': ['B', 'hc', 1], '9': ['B', 'hc', 2], '0': ['B', 'hc', 3],
    };
    const typing = (e) => e.target.closest('input[type=search], input[type=text], textarea, select, dialog');
    window.addEventListener('keydown', async (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        S.mix.xf = clamp(S.mix.xf + (e.key === 'ArrowLeft' ? -0.05 : 0.05), 0, 1);
        ui.xf.value = S.mix.xf; await ensureEngine(); applyXf();
        return;
      }
      const m = map[e.key.toLowerCase()];
      if (!m || e.repeat) return;
      e.preventDefault();
      await ensureEngine();
      const [id, act, arg] = m;
      const d = decks[id];
      if (act === 'play') d.toggle();
      else if (act === 'cue') d.cueDown();
      else if (act === 'sync') $(`[data-act=sync]`, ui[id].root).click();
      else if (act === 'loop') d.autoLoop();
      else if (act === 'nd') d.setNudge(-0.04);
      else if (act === 'nu') d.setNudge(0.04);
      else if (act === 'hc') d.hotcue(arg, e.shiftKey);
    });
    window.addEventListener('keyup', (e) => {
      const m = map[e.key.toLowerCase()];
      if (!m || !decks[m[0]]) return;
      if (m[1] === 'cue') decks[m[0]].cueUp();
      if (m[1] === 'nd' || m[1] === 'nu') decks[m[0]].setNudge(0);
    });
  }

  /* ---------------- Démarrage ---------------- */
  async function boot() {
    ID.forEach(buildDeck);
    buildMixer();
    bindLibrary();
    bindKeys();
    $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => zoomBy(+b.dataset.zoom)));
    $('#btn-help').addEventListener('click', () => $('#help').showModal());
    $('#btn-rec').addEventListener('click', toggleRec);
    // le contexte audio doit naître d'un geste utilisateur
    const kick = () => { ensureEngine().catch(() => {}); };
    window.addEventListener('pointerdown', kick, { once: true, capture: true });
    window.addEventListener('keydown', kick, { once: true, capture: true });
    // waveforms vides avant le démarrage du moteur
    const idle = { id: 'A', track: null, loading: false };
    Wave.drawZoom(ui.A.zoom, idle, S.zoom);
    Wave.drawZoom(ui.B.zoom, { ...idle, id: 'B' }, S.zoom);

    try {
      const [tracks, playlists] = await Promise.all([DB.all('tracks'), DB.all('playlists')]);
      tracks.forEach((t) => S.tracks.set(t.id, t));
      S.playlists = playlists.sort((a, b) => a.id.localeCompare(b.id));
      if (tracks.length) setStatus(`${tracks.length} morceau(x) dans la bibliothèque. Cliquez n'importe où pour activer l'audio.`);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) {
      console.error(e);
      setStatus('Stockage local indisponible : la bibliothèque ne sera pas conservée.');
    }
    renderTree();
    refreshTable();
  }

  window.Platine = { S, decks, channels, importFiles, loadToDeck, ensureEngine };
  boot();
})();
