'use strict';
/* Stockage local (IndexedDB) : morceaux analysés, fichiers audio, playlists. */
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('platine-dj', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('tracks', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('playlists', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function run(store, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    all: (store) => run(store, 'readonly', (s) => s.getAll()),
    get: (store, id) => run(store, 'readonly', (s) => s.get(id)),
    put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
    del: (store, id) => run(store, 'readwrite', (s) => s.delete(id)),
  };
})();
