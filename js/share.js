// 単語帳の共有：取り込んだ端末がアップロードし、ほかの端末はダウンロードして IndexedDB にためる。
// どちらも1ファイルずつ進め、途中で切れても、すでに終わった分はとばして続きからやり直せる。
import * as idb from './idb.js';
import { uploadFile, downloadFile, putDoc, existsFile } from './cloud.js';

const EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
export const typeOf = (name) => EXT[(String(name).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
export const isAudio = (name) => typeOf(name).startsWith('audio/');
export const deckFile = (deck) => `deck-${(deck.created || 0).toString(36)}.json`;
const mrel = (name) => 'm/' + name;

/** 一覧（Firestore）に置く情報 */
export function deckMeta(deck, extra = {}) {
  const names = Object.keys(deck.media || {});
  return { id: deck.id, name: deck.name, count: deck.notes.length, audio: names.filter(isAudio).length, images: names.filter((n) => !isAudio(n)).length,
    total: names.length, file: deckFile(deck), upd: Date.now(), ...extra };
}

/** いくつかを同時に進める */
async function pool(items, n, fn) {
  let i = 0, err = null;
  const run = async () => { while (i < items.length && !err) { const x = items[i++]; try { await fn(x); } catch (e) { err = e; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  if (err) throw err;
}

const running = {};
/** アップロード（同じ単語帳を同時に2回は走らせない）。onProg(済み, 全部) */
export function uploadDeck(code, deck, by, onProg = () => {}) {
  if (running['up' + deck.id]) return running['up' + deck.id];
  const p = (async () => {
    const names = Object.keys(deck.media || {});
    const key = 'up:' + deck.id;
    const done = new Set((await idb.getMeta(key)) || []);
    const total = names.length;
    const meta = (extra) => putDoc(code, 'decks', deck.id, deckMeta(deck, { by, ...extra }));
    onProg(done.size, total);
    // 本文（JSON）
    if (!done.has('#' + deckFile(deck))) {
      await uploadFile(code, deck.id, deckFile(deck), JSON.stringify(deck), 'application/json');
      done.add('#' + deckFile(deck)); await idb.putMeta(key, [...done]);
    }
    const todo = names.filter((n) => !done.has(n));
    await meta({ uploaded: total - todo.length, done: todo.length === 0 });
    let since = 0;
    await pool(todo, 4, async (n) => {
      const data = await idb.getMedia(deck.id, n);
      if (!data) return; // この端末にない（ふつうは起きない）
      await uploadFile(code, deck.id, mrel(n), data, typeOf(n));
      done.add(n);
      onProg(names.filter((x) => done.has(x)).length, total);
      if (++since >= 25) { since = 0; await idb.putMeta(key, [...done]); }
    });
    await idb.putMeta(key, [...done]);
    const up = names.filter((x) => done.has(x)).length;
    await meta({ uploaded: up, done: up === total });
    return up === total;
  })().finally(() => { delete running['up' + deck.id]; });
  return (running['up' + deck.id] = p);
}
/** アップロードがどこまで終わったか（この端末の記録） */
export async function uploadState(deck) {
  const done = new Set((await idb.getMeta('up:' + deck.id)) || []);
  const names = Object.keys(deck.media || {});
  return { done: names.filter((n) => done.has(n)).length, total: names.length, json: done.has('#' + deckFile(deck)) };
}

/** 本文をダウンロード（なければ、または新しい版があれば） */
export async function fetchDeck(code, meta) {
  const local = await idb.getDeck(meta.id);
  if (local && deckFile(local) === meta.file) return local;
  if (!(await existsFile(code, meta.id, meta.file).catch(() => true)) && local) return local;
  const deck = JSON.parse(new TextDecoder().decode(await downloadFile(code, meta.id, meta.file)));
  if (!deck || deck.id !== meta.id || !Array.isArray(deck.notes)) throw new Error('単語帳のデータがこわれています');
  if (meta.name) deck.name = meta.name;
  await idb.putDeck(deck);
  return deck;
}
/** 音声・画像をダウンロード。first にあるものを先に、残りはノートの順に。onProg(済み, 全部) */
export function fillMedia(code, deck, first = [], onProg = () => {}, onlyFirst = false) {
  const k = 'dl' + deck.id + (onlyFirst ? 'f' : '');
  if (running[k]) return running[k];
  const p = (async () => {
    const have = await idb.mediaNames(deck.id), all = Object.keys(deck.media || {});
    const order = [...new Set([...first, ...all])].filter((n) => deck.media[n] != null);
    const todo = (onlyFirst ? first.filter((n) => deck.media[n] != null) : order).filter((n) => !have.has(n));
    let got = all.filter((n) => have.has(n)).length;
    onProg(got, all.length);
    await pool(todo, 4, async (n) => {
      const data = await downloadFile(code, deck.id, mrel(n));
      await idb.putMediaMany(deck.id, [[n, data]]);
      onProg(++got, all.length);
    });
    return got;
  })().finally(() => { delete running[k]; });
  return (running[k] = p);
}
/** 1つだけ取ってくる（学習中に足りないとき） */
export async function fetchOne(code, deckId, name) {
  const data = await downloadFile(code, deckId, mrel(name));
  await idb.putMediaMany(deckId, [[name, data]]);
  return data;
}
export const isRunning = (k) => !!running[k];
