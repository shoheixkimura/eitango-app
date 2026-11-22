// クラウド同期（Firestore の REST API。SDK は使わない。無料の Spark プランで動く）。
// eitango_families/{合言葉のハッシュ}/profiles|progress|decks/{ID}
// eitango_families/{合言葉のハッシュ}/blobs/{単語帳のID}_{版}_b{番号}|m{番号}  … 単語帳の本文と音声・画像
// 削除はアプリからは行わない（ルールでも禁止。消せるのは Firebase コンソールの管理者だけ）
import { CLOUD } from './cloud-config.js';

export const cloudReady = () => !!(CLOUD.projectId && CLOUD.apiKey);
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

// ───────── 単語帳の中身（Firestore に約900KBずつのかたまりで置く。無料の Spark プランで使える） ─────────
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
/** かたまりを1つ置く。すでにあれば何もしない（ルールで上書きは禁止） */
export async function putBlob(code, id, bytes) {
  const body = JSON.stringify({ fields: { b: { bytesValue: b64(bytes) }, updated: { integerValue: String(Date.now()) } } });
  try {
    await call(`${await docPath(code, 'blobs', id)}?currentDocument.exists=false&${key()}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
  } catch (e) {
    // すでにある（400 / 409）、または上書き禁止で 403 → あるかどうかを確かめる
    if ([400, 403, 409].includes(e.status) && (await hasBlob(code, id))) return;
    throw e;
  }
}
export async function hasBlob(code, id) {
  try { await call(`${await docPath(code, 'blobs', id)}?mask.fieldPaths=updated&${key()}`); return true; }
  catch (e) { if (e.status === 404) return false; throw e; }
}
export async function getBlob(code, id) {
  const j = await json(`${await docPath(code, 'blobs', id)}?${key()}`);
  return unb64(j.fields.b.bytesValue);
}
