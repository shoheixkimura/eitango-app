// 単語帳の共有：取り込んだ端末がアップロードし、ほかの端末はダウンロードして IndexedDB にためる。
// 無料の Spark プランで使えるように、Firestore に約900KBずつの「かたまり」として置く。
//   本文（JSON）    → blobs/{単語帳のID}_{版}_b0, b1, …
//   音声・画像      → 全部をノートの順につなげた1本のデータを900KBずつに切り、blobs/{単語帳のID}_{版}_m0, m1, …
// どちらも1かたまりずつ進め、途中で切れても、すでに終わった分はとばして続きからやり直せる。
import * as idb from './idb.js';
import { putBlob, getBlob, putDoc } from './cloud.js';

export const CHUNK = 900000; // 1かたまりの大きさ（Firestore の1ドキュメントは1MBまで）
const EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
export const typeOf = (name) => EXT[(String(name).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
export const isAudio = (name) => typeOf(name).startsWith('audio/');
const rev = (deck) => (deck.created || 0).toString(36);
const bid = (deck, k, i) => `${deck.id}_${rev(deck)}_${k}${i}`;
export const deckFile = (deck) => rev(deck);

/** 音声・画像をノートの順に並べ、つなげたデータの中の位置を決める（{ 名前: [位置, 長さ] }） */
export function planPack(deck) {
  const seen = new Set(), order = [];
  const add = (n) => { if (deck.media[n] != null && !seen.has(n)) { seen.add(n); order.push(n); } };
  for (const [, , f] of deck.notes) for (const x of f) {
    for (const m of String(x).matchAll(/\[sound:([^\]]+)\]/g)) add(m[1].trim());
    for (const m of String(x).matchAll(/<img[^>]*?src=["']?([^"'>\s]+)/gi)) { try { add(decodeURIComponent(m[1])); } catch { add(m[1]); } }
  }
  Object.keys(deck.media).forEach(add);
  const files = {};
  let off = 0;
  for (const n of order) { files[n] = [off, deck.media[n]]; off += deck.media[n]; }
  return { size: CHUNK, total: off, n: Math.ceil(off / CHUNK), files };
}
const chunksOf = (pack, name) => { const [o, l] = pack.files[name]; const a = []; for (let i = Math.floor(o / CHUNK); i <= Math.floor((o + Math.max(l, 1) - 1) / CHUNK); i++) a.push(i); return a; };

/** 一覧（Firestore の decks）に置く情報 */
export function deckMeta(deck, extra = {}) {
  deck.pack = deck.pack || planPack(deck);
  const names = Object.keys(deck.media || {});
  const body = new TextEncoder().encode(JSON.stringify(deck)).length;
  return { id: deck.id, name: deck.name, count: deck.notes.length, audio: names.filter(isAudio).length, images: names.filter((n) => !isAudio(n)).length,
    total: names.length, file: rev(deck), bodyN: Math.ceil(body / CHUNK), mediaN: deck.pack.n, upd: Date.now(), ...extra };
}

async function pool(items, n, fn) {
  let i = 0, err = null;
  const run = async () => { while (i < items.length && !err) { const x = items[i++]; try { await fn(x); } catch (e) { err = e; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  if (err) throw err;
}
const running = {};
const once = (k, fn) => running[k] || (running[k] = fn().finally(() => { delete running[k]; }));
export const isRunning = (k) => !!running[k];

/** つなげたデータの i 番目のかたまりを、この端末の音声・画像から作る */
async function buildChunk(deck, pack, order, i) {
  const from = i * CHUNK, to = Math.min(pack.total, from + CHUNK), out = new Uint8Array(to - from);
  for (const n of order) {
    const [o, l] = pack.files[n];
    if (o + l <= from || o >= to) continue;
    const data = new Uint8Array(await idb.getMedia(deck.id, n));
    const s = Math.max(o, from), e = Math.min(o + l, to);
    out.set(data.subarray(s - o, e - o), s - from);
  }
  return out;
}

/** アップロード（同じ単語帳を同時に2回は走らせない）。onProg(済み, 全部) はかたまりの数 */
export function uploadDeck(code, deck, by, onProg = () => {}) {
  return once('up' + deck.id, async () => {
    deck.pack = deck.pack || planPack(deck);
    const key = 'up:' + deck.id + ':' + rev(deck);
    const done = new Set((await idb.getMeta(key)) || []);
    const body = new TextEncoder().encode(JSON.stringify(deck));
    const ids = [];
    for (let i = 0; i * CHUNK < body.length; i++) ids.push(['b', i]);
    for (let i = 0; i < deck.pack.n; i++) ids.push(['m', i]);
    const total = ids.length, meta = (extra) => putDoc(code, 'decks', deck.id, deckMeta(deck, { by, ...extra }));
    const todo = ids.filter(([k, i]) => !done.has(k + i));
    onProg(total - todo.length, total);
    await meta({ uploaded: total - todo.length, chunks: total, done: !todo.length });
    const order = Object.keys(deck.pack.files).sort((a, b) => deck.pack.files[a][0] - deck.pack.files[b][0]);
    let since = 0;
    await pool(todo, 2, async ([k, i]) => {
      const bytes = k === 'b' ? body.subarray(i * CHUNK, (i + 1) * CHUNK) : await buildChunk(deck, deck.pack, order, i);
      await putBlob(code, bid(deck, k, i), bytes);
      done.add(k + i);
      onProg(done.size, total);
      if (++since >= 5) { since = 0; await idb.putMeta(key, [...done]); }
    });
    await idb.putMeta(key, [...done]);
    const ok = ids.every(([k, i]) => done.has(k + i));
    await meta({ uploaded: done.size, chunks: total, done: ok });
    return ok;
  });
}
/** アップロードがどこまで終わったか（この端末の記録、かたまりの数） */
export async function uploadState(deck) {
  const done = new Set((await idb.getMeta('up:' + deck.id + ':' + rev(deck))) || []);
  const m = deckMeta(deck);
  return { done: done.size, total: m.bodyN + m.mediaN };
}

/** 本文をダウンロード（なければ、または新しい版があれば） */
export async function fetchDeck(code, meta) {
  const local = await idb.getDeck(meta.id);
  if (local && rev(local) === meta.file) return local;
  const parts = [];
  for (let i = 0; i < (meta.bodyN || 1); i++) parts.push(await getBlob(code, `${meta.id}_${meta.file}_b${i}`));
  let len = 0; for (const p of parts) len += p.length;
  const all = new Uint8Array(len); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const deck = JSON.parse(new TextDecoder().decode(all));
  if (!deck || deck.id !== meta.id || !Array.isArray(deck.notes)) throw new Error('単語帳のデータがこわれています');
  if (meta.name) deck.name = meta.name;
  deck.pack = deck.pack || planPack(deck);
  await idb.putDeck(deck);
  return deck;
}

/** かたまりを取ってきて、そこに全部入っているファイルを保存する。cache はかたまりを少しだけ覚えておく */
async function fetchFiles(code, deck, names, have, cache, onFile) {
  const pack = deck.pack;
  for (const n of names) {
    if (have.has(n) || !pack.files[n]) continue;
    const cs = chunksOf(pack, n), bufs = [];
    for (const i of cs) {
      if (!cache.has(i)) {
        cache.set(i, getBlob(code, bid(deck, 'm', i)));
        while (cache.size > 3) cache.delete(cache.keys().next().value);
      }
      bufs.push(await cache.get(i));
    }
    const [o, l] = pack.files[n], out = new Uint8Array(l);
    cs.forEach((i, k) => {
      const from = i * CHUNK, s = Math.max(o, from), e = Math.min(o + l, from + bufs[k].length);
      if (e > s) out.set(bufs[k].subarray(s - from, e - from), s - o);
    });
    await idb.putMediaMany(deck.id, [[n, out.buffer]]);
    have.add(n);
    onFile();
  }
}
/** 音声・画像をダウンロード。first にあるものを先に、残りはノートの順に。onProg(済み, 全部) はファイルの数 */
export function fillMedia(code, deck, first = [], onProg = () => {}, onlyFirst = false) {
  return once('dl' + deck.id + (onlyFirst ? 'f' : ''), async () => {
    deck.pack = deck.pack || planPack(deck);
    const have = await idb.mediaNames(deck.id), all = Object.keys(deck.pack.files);
    let got = all.filter((n) => have.has(n)).length;
    const tick = () => onProg(++got, all.length);
    onProg(got, all.length);
    const cache = new Map();
    await fetchFiles(code, deck, first, have, cache, tick);
    if (!onlyFirst) {
      const rest = all.filter((n) => !have.has(n)).sort((a, b) => deck.pack.files[a][0] - deck.pack.files[b][0]);
      await fetchFiles(code, deck, rest, have, cache, tick);
    }
    return got;
  });
}
/** 1つだけ取ってくる（学習中に足りないとき） */
export async function fetchOne(code, deckId, name) {
  const deck = await idb.getDeck(deckId);
  if (!deck) return null;
  deck.pack = deck.pack || planPack(deck);
  const have = new Set();
  await fetchFiles(code, deck, [name], have, new Map(), () => {});
  return idb.getMedia(deckId, name);
}
