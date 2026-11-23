// 「やさしい説明」と「語源」：単語帳とは別に、単語（英語の文字）ごとに持つ。
// 単語帳を取り込み直しても消えないように、単語帳の ID と単語の文字で結びつける。
//   この端末   → IndexedDB の meta「ext:{単語帳のID}」= { rev, at, items: { 単語: [やさしい説明, 語源] } }
//   クラウド   → decks/x{単語帳のID}（目印：kind 'ext'・rev・かたまりの数）と blobs/x{単語帳のID}_{rev}_{番号}
// 中身は教材の単語にもとづくので、公開リポジトリには置かず、家族の合言葉の場所にだけ置く。
import * as idb from './idb.js';
import { putBlob, getBlob, putDoc } from './cloud.js';
import { plainText } from './sanitize.js';
import { CHUNK } from './share.js';

/** 単語の見出しをそろえる（大文字小文字・「～」・空白のちがいを無視） */
export function wordKey(s) {
  return plainText(s).toLowerCase().replace(/[～〜~…]/g, ' ').replace(/\s+/g, ' ').trim();
}
export const extDocId = (deckId) => 'x' + deckId;
export const isExtDoc = (m) => !!m && (m.kind === 'ext' || /^x/.test(String(m.id || '')));

/** 説明ファイル（JSON）を読む。{ items: { 単語: [説明, 語源] } } か [{ word, easy, ety }] の形 */
export function parseExtFile(text) {
  const d = JSON.parse(text), items = {};
  const add = (w, easy, ety) => {
    const k = wordKey(w || '');
    if (!k) return;
    const e1 = String(easy || '').trim().slice(0, 400), e2 = String(ety || '').trim().slice(0, 400);
    if (e1 || e2) items[k] = [e1, e2];
  };
  if (Array.isArray(d)) d.forEach((x) => x && add(x.word, x.easy, x.ety));
  else if (d && d.items && typeof d.items === 'object') for (const [w, v] of Object.entries(d.items)) add(w, Array.isArray(v) ? v[0] : v.easy, Array.isArray(v) ? v[1] : v.ety);
  else throw new Error('説明ファイルの形ではありません');
  if (!Object.keys(items).length) throw new Error('説明が1つも入っていません');
  return items;
}
/** 単語帳のうち、説明があるカードの数 */
export function matchCount(deckWords, items) {
  let n = 0;
  for (const w of deckWords) if (items[wordKey(w)]) n++;
  return n;
}

export const getLocalExt = (deckId) => idb.getMeta('ext:' + deckId).catch(() => null);
export const putLocalExt = (deckId, ext) => idb.putMeta('ext:' + deckId, ext);

/** 新しい版としてこの端末に保存し、家族のクラウドにも置く（code がなければ端末だけ） */
export async function saveExt(code, deckId, items) {
  const ext = { rev: Date.now().toString(36), at: Date.now(), items };
  await putLocalExt(deckId, ext);
  if (code) await uploadExt(code, deckId, ext);
  return ext;
}
export async function uploadExt(code, deckId, ext) {
  const body = new TextEncoder().encode(JSON.stringify(ext.items));
  const n = Math.max(1, Math.ceil(body.length / CHUNK));
  for (let i = 0; i < n; i++) await putBlob(code, `${extDocId(deckId)}_${ext.rev}_${i}`, body.subarray(i * CHUNK, (i + 1) * CHUNK));
  await putDoc(code, 'decks', extDocId(deckId), { id: extDocId(deckId), kind: 'ext', deck: deckId, rev: ext.rev, n, count: Object.keys(ext.items).length, upd: ext.at });
}
/** クラウドの目印がこの端末より新しければ取ってくる。取ってきたら true */
export async function syncExt(code, meta) {
  if (!meta || !meta.deck || !meta.rev) return false;
  const local = await getLocalExt(meta.deck);
  if (local && local.rev === meta.rev) return false;
  if (local && (local.at || 0) > (meta.upd || 0)) return false; // この端末のほうが新しい（アップロード待ち）
  const parts = [];
  for (let i = 0; i < (meta.n || 1); i++) parts.push(await getBlob(code, `${extDocId(meta.deck)}_${meta.rev}_${i}`));
  let len = 0; for (const p of parts) len += p.length;
  const all = new Uint8Array(len); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const items = JSON.parse(new TextDecoder().decode(all));
  await putLocalExt(meta.deck, { rev: meta.rev, at: meta.upd || Date.now(), items });
  return true;
}
