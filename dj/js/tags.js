'use strict';
/* Lecture minimale des tags ID3v2.3 / v2.4 (MP3) + repli sur le nom de fichier. */
const Tags = (() => {
  const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  function decodeText(data) {
    if (!data.length) return '';
    const enc = data[0];
    const body = data.subarray(1);
    let txt;
    try {
      if (enc === 0) txt = new TextDecoder('latin1').decode(body);
      else if (enc === 1) txt = new TextDecoder('utf-16').decode(body);
      else if (enc === 2) txt = new TextDecoder('utf-16be').decode(body);
      else txt = new TextDecoder('utf-8').decode(body);
    } catch (e) { txt = ''; }
    return txt.replace(/\u0000+$/g, '').split('\u0000')[0].trim();
  }

  async function readId3(file) {
    const out = {};
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out;
    const ver = head[3];
    if (ver < 3) return out;
    const size = syncsafe(head, 6);
    const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    let p = 0;
    if (head[5] & 0x40) p += ver === 4 ? syncsafe(buf, 0) : be32(buf, 0) + 4;
    const map = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre', TKEY: 'tagKey', TBPM: 'tagBpm' };
    while (p + 10 <= buf.length) {
      const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsz = ver === 4 ? syncsafe(buf, p + 4) : be32(buf, p + 4);
      if (fsz <= 0 || p + 10 + fsz > buf.length) break;
      if (map[id]) out[map[id]] = decodeText(buf.subarray(p + 10, p + 10 + fsz));
      p += 10 + fsz;
    }
    if (out.genre) out.genre = out.genre.replace(/^\(\d+\)/, '').trim();
    return out;
  }

  function fromFileName(name) {
    const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    const parts = base.split(/\s+-\s+/);
    if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
    return { artist: '', title: base };
  }

  async function read(file) {
    let tags = {};
    try { tags = await readId3(file); } catch (e) { tags = {}; }
    const fb = fromFileName(file.name);
    return {
      title: tags.title || fb.title,
      artist: tags.artist || fb.artist,
      album: tags.album || '',
      genre: tags.genre || '',
    };
  }

  return { read };
})();
