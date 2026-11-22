// IndexedDB：単語帳の本文（decks）と音声・画像（media）、アップロードの記録（meta）を入れておく。
const NAME = 'eitango', VER = 1;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ['decks', 'media', 'meta']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbp = null; }; res(r.result); };
    r.onerror = () => { dbp = null; rej(r.error); };
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('保存できませんでした（容量不足の可能性があります）'));
  }));
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const getDeck = (id) => tx('decks', 'readonly', (s) => req(s.get(id)));
export const putDeck = (deck) => tx('decks', 'readwrite', (s) => { s.put(deck, deck.id); });
export const getMeta = (k) => tx('meta', 'readonly', (s) => req(s.get(k)));
export const putMeta = (k, v) => tx('meta', 'readwrite', (s) => { s.put(v, k); });

const mkey = (deckId, name) => deckId + '/' + name;
export const getMedia = (deckId, name) => tx('media', 'readonly', (s) => req(s.get(mkey(deckId, name))));
/** items: [[name, ArrayBuffer], …] をまとめて保存 */
export const putMediaMany = (deckId, items) => tx('media', 'readwrite', (s) => { for (const [n, b] of items) s.put(b, mkey(deckId, n)); });
/** その単語帳ですでに入っている音声・画像の名前 */
export function mediaNames(deckId) {
  return tx('media', 'readonly', (s) => req(s.getAllKeys(IDBKeyRange.bound(deckId + '/', deckId + '/￿'))))
    .then((keys) => new Set(keys.map((k) => k.slice(deckId.length + 1))));
}
