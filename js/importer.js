// .apkg の取り込み：別スレッドで読み、フィールドの割り当てを推定し、このアプリの単語帳の形にする。
import { plainText, soundsOf, imagesOf } from './sanitize.js';

export const ROLES = [['en', '英文（表）'], ['ja', '和訳（裏）'], ['snd', '音声'], ['img', '画像']];
const STAGE = { read: 'ファイルを読んでいます', unzip: '展開しています', sqlite: 'カードを読んでいます', media: '音声・画像を取り出しています' };

/** 別スレッドで .apkg を読む。onProgress(文, 済み, 全部) */
export function readApkg(file, onProgress = () => {}) {
  return new Promise((res, rej) => {
    const w = new Worker(new URL('./anki-worker.js', import.meta.url));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(STAGE[m.stage] || m.stage, m.done, m.total);
      else if (m.type === 'done') { w.terminate(); res(m); }
      else if (m.type === 'error') { w.terminate(); rej(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || '読みこめませんでした')); };
    w.postMessage({ file });
  });
}

const LATIN = /[A-Za-z]/g, JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g;
const cnt = (s, re) => (s.match(re) || []).length;
/**
 * フィールドの役わりを推定する。[sound:] → 音声、<img> → 画像、英字が多い → 英文、日本語が多い → 和訳。
 * 返り値 { en, ja, snd, img }（フィールド番号、なければ -1）
 */
export function guessMap(fieldNames, notes) {
  const n = fieldNames.length, sample = notes.slice(0, 50);
  const st = fieldNames.map(() => ({ snd: 0, img: 0, lat: 0, ja: 0 }));
  for (const nt of sample) for (let i = 0; i < n; i++) {
    const f = nt.f[i] || '', t = plainText(f);
    if (soundsOf(f).length) st[i].snd++;
    if (imagesOf(f).length) st[i].img++;
    st[i].lat += cnt(t, LATIN); st[i].ja += cnt(t, JA);
  }
  const used = new Set(), best = (score) => {
    let bi = -1, bv = 0;
    for (let i = 0; i < n; i++) if (!used.has(i) && score(st[i]) > bv) { bv = score(st[i]); bi = i; }
    if (bi >= 0) used.add(bi);
    return bi;
  };
  const snd = best((s) => s.snd), img = best((s) => s.img);
  const en = best((s) => (s.lat > s.ja ? s.lat - s.ja : 0));
  const ja = best((s) => (s.ja > 0 ? s.ja : 0));
  const m = { en, ja, snd, img };
  // 英字・日本語で決まらなければ、残りのフィールドを前から使う
  for (const k of ['en', 'ja']) if (m[k] < 0) m[k] = best(() => 1);
  return m;
}

/** 文字列から決まる短い ID（同じ名前なら同じ ID） */
export async function stableId(prefix, s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prefix + ':' + s));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const deckIdFor = (topName) => stableId('eitango-deck', topName).then((h) => 'd' + h);

/** 取り込み結果と割り当てから、このアプリの単語帳を作る（音声・画像は別に保存する） */
export function buildDeck(res, maps, id, name) {
  const models = {};
  for (const [mid, m] of Object.entries(res.models)) if (maps[mid]) models[mid] = { name: m.name, fields: m.fields, map: maps[mid] };
  const seen = new Set(), notes = [];
  for (const n of res.notes) {
    if (!models[n.mid] || seen.has(n.guid)) continue;
    seen.add(n.guid);
    notes.push([n.guid, n.mid, n.f]);
  }
  const media = {};
  for (const m of res.media) media[m.name] = m.data.byteLength;
  return { v: 1, id, name, src: res.topName, format: res.format, created: Date.now(), models, notes, media };
}

/** カード1枚の表示に使うもの：{ en, ja, snd:[…], img:[…] }（HTML は表示のときに安全にする） */
export function cardOf(deck, note) {
  const [guid, mid, f] = note, mp = deck.models[mid].map, g = (i) => (i >= 0 ? f[i] || '' : '');
  const snd = mp.snd >= 0 ? soundsOf(g(mp.snd)) : [];
  // 音声のフィールドが決まっていなくても、英文の中の [sound:] は使う
  if (!snd.length) snd.push(...soundsOf(g(mp.en)));
  return { guid, en: g(mp.en), ja: g(mp.ja), snd, img: mp.img >= 0 ? imagesOf(g(mp.img)) : [] };
}
