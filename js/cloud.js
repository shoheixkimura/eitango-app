// クラウド同期（Firestore と Firebase Storage の REST API。SDK は使わない）。
// Firestore: eitango_families/{合言葉のハッシュ}/profiles|progress|decks/{ID}
// Storage:   eitango/{合言葉のハッシュ}/decks/{単語帳のID}/...
// 削除はアプリからは行わない（ルールでも禁止。消せるのは Firebase コンソールの管理者だけ）
import { CLOUD } from './cloud-config.js';

export const cloudReady = () => !!(CLOUD.projectId && CLOUD.apiKey);
export const storageReady = () => cloudReady() && !!CLOUD.storageBucket;
const fsBase = () => `https://firestore.googleapis.com/v1/projects/${CLOUD.projectId}/databases/(default)/documents`;
const key = () => `key=${encodeURIComponent(CLOUD.apiKey)}`;

const famCache = {};
/** 合言葉そのものは送らず、ハッシュを置き場所の名前にする（漢字アプリとは前につける文字列を変えている） */
export async function famId(code) {
  if (famCache[code]) return famCache[code];
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('eitango-family:' + code.trim()));
  return (famCache[code] = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''));
}
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function call(url, opt) {
  let r;
  try { r = await fetch(url, opt); } catch (e) { throw new HttpError(0, 'ネットにつながっていません'); }
  if (!r.ok) {
    let msg = r.status + '';
    try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch { /* 本文なし */ }
    throw new HttpError(r.status, typeof msg === 'string' ? msg : r.status + '');
  }
  return r;
}
const json = async (url, opt) => { const r = await call(url, opt); return r.status === 204 ? null : r.json(); };
const docPath = async (code, col, id) => `${fsBase()}/eitango_families/${await famId(code)}/${col}/${encodeURIComponent(id)}`;

/** コレクションの全ドキュメント（中身は json フィールドの文字列） */
export async function listDocs(code, col) {
  const out = [];
  let token = '';
  do {
    const j = await json(`${fsBase()}/eitango_families/${await famId(code)}/${col}?pageSize=100${token ? '&pageToken=' + encodeURIComponent(token) : ''}&${key()}`);
    for (const d of (j && j.documents) || []) { try { out.push(JSON.parse(d.fields.json.stringValue)); } catch { /* こわれたデータは無視 */ } }
    token = j && j.nextPageToken;
  } while (token);
  return out;
}
/** 1つのドキュメント（なければ null） */
export async function getDoc(code, col, id) {
  try {
    const j = await json(`${await docPath(code, col, id)}?${key()}`);
    return JSON.parse(j.fields.json.stringValue);
  } catch (e) { if (e.status === 404) return null; throw e; }
}
export async function putDoc(code, col, id, obj, keepalive = false) {
  const body = JSON.stringify({ fields: { json: { stringValue: JSON.stringify(obj) }, updated: { integerValue: String(Date.now()) } } });
  // keepalive（画面を閉じるとき）は 64KB までしか送れない
  await call(`${await docPath(code, col, id)}?${key()}`, { method: 'PATCH', keepalive: keepalive && body.length < 60000, headers: { 'Content-Type': 'application/json' }, body });
}

// ───────── Firebase Storage ─────────
const stBase = () => `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(CLOUD.storageBucket)}/o`;
const objName = async (code, deckId, rel) => `eitango/${await famId(code)}/decks/${deckId}/${rel}`;
/** ファイルをアップロード（すでにあれば何もしない。ルールで上書きは禁止） */
export async function uploadFile(code, deckId, rel, data, type) {
  const name = await objName(code, deckId, rel);
  try {
    await call(`${stBase()}?uploadType=media&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type || 'application/octet-stream' }, body: data });
  } catch (e) {
    // 上書きが禁止されて 403 のときは、すでにあるかを確かめる
    if (e.status === 403 && (await existsFile(code, deckId, rel))) return;
    throw e;
  }
}
export async function existsFile(code, deckId, rel) {
  try { await call(`${stBase()}/${encodeURIComponent(await objName(code, deckId, rel))}`); return true; }
  catch (e) { if (e.status === 404 || e.status === 403) return false; throw e; }
}
export async function downloadFile(code, deckId, rel) {
  const r = await call(`${stBase()}/${encodeURIComponent(await objName(code, deckId, rel))}?alt=media`);
  return r.arrayBuffer();
}
