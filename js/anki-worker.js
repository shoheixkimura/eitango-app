/* .apkg を読む（画面が固まらないように別スレッドで動かす）。
   旧形式 collection.anki2 / collection.anki21 と、新しい形式 collection.anki21b（zstd 圧縮）に対応。 */
/* global fflate, fzstd, initSqlJs */
importScripts('../vendor/fflate.umd.js', '../vendor/fzstd.umd.js', '../vendor/sql-wasm.js');

const post = (stage, done = 0, total = 0) => self.postMessage({ type: 'progress', stage, done, total });

/** protobuf の最低限の読み取り（新しい形式の media 一覧用） */
function pbFields(buf) {
  const out = []; let i = 0;
  const varint = () => { let x = 0, s = 0, b; do { b = buf[i++]; x += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return x; };
  while (i < buf.length) {
    const key = varint(), no = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) out.push([no, varint()]);
    else if (wt === 2) { const n = varint(); out.push([no, buf.subarray(i, i + n)]); i += n; }
    else if (wt === 1) i += 8; else if (wt === 5) i += 4; else throw new Error('protobuf');
  }
  return out;
}
const td = new TextDecoder();
const unz = (b) => (b && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd ? fzstd.decompress(b) : b);

function rows(db, sql) {
  const r = db.exec(sql);
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}
const hasTable = (db, t) => rows(db, `select name from sqlite_master where type='table' and name='${t}'`).length > 0;

self.onmessage = async (e) => {
  try {
    const file = e.data.file;
    post('read');
    const zipBuf = new Uint8Array(await file.arrayBuffer());
    post('unzip');
    let names;
    // 中身の一覧だけ先に見る（大きな音声はあとで1つずつ取り出す）
    const files = fflate.unzipSync(zipBuf, { filter: (f) => { (names = names || []).push(f.name); return /^collection\.anki2(1b?)?$|^media$|^meta$/.test(f.name); } });
    let colName = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((n) => files[n]);
    if (!colName) throw new Error('この .apkg の中に単語帳のデータが見つかりませんでした');
    const isNew = colName === 'collection.anki21b';
    let colBytes = files[colName];
    if (isNew) colBytes = fzstd.decompress(colBytes);

    post('sqlite');
    const SQL = await initSqlJs({ locateFile: (f) => '../vendor/' + f });
    const db = new SQL.Database(colBytes);

    // ノートタイプとフィールド名
    const models = {};
    if (hasTable(db, 'notetypes') && hasTable(db, 'fields')) {
      for (const r of rows(db, 'select id, name from notetypes')) models[r.id] = { name: r.name, fields: [] };
      for (const r of rows(db, 'select ntid, ord, name from fields order by ntid, ord')) if (models[r.ntid]) models[r.ntid].fields[r.ord] = r.name;
    }
    if (!Object.keys(models).length) {
      const m = JSON.parse((rows(db, 'select models from col')[0] || {}).models || '{}');
      for (const [id, v] of Object.entries(m)) models[id] = { name: v.name, fields: [...v.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name) };
    }
    // デッキ名（:: または \x1f で階層）
    const decks = {};
    if (hasTable(db, 'decks')) for (const r of rows(db, 'select id, name from decks')) decks[r.id] = String(r.name).split('\x1f').join('::');
    if (!Object.keys(decks).length) {
      const d = JSON.parse((rows(db, 'select decks from col')[0] || {}).decks || '{}');
      for (const [id, v] of Object.entries(d)) decks[id] = v.name;
    }

    // ノートと、出す順番（新しいカードの due → ノート ID）
    const order = {}, topCount = {};
    for (const r of rows(db, 'select nid, did, type, due from cards')) {
      const k = r.type === 0 ? [0, r.due] : [1, 0];
      const o = order[r.nid];
      if (!o || k[0] < o[0] || (k[0] === o[0] && k[1] < o[1])) order[r.nid] = k;
      const top = String(decks[r.did] || '').split('::')[0];
      if (top) topCount[top] = (topCount[top] || 0) + 1;
    }
    const notes = rows(db, 'select id, guid, mid, flds from notes').map((r) => ({ id: r.id, guid: r.guid, mid: String(r.mid), f: String(r.flds).split('\x1f') }));
    // ノート ID（作った順）にならべておく。Anki に保存されていた順（新しいカードの due）は k に入れる
    notes.sort((a, b) => a.id - b.id);
    db.close();
    const tops = Object.entries(topCount).sort((a, b) => b[1] - a[1]);
    const topName = (tops.find((t) => t[0] !== 'Default') || tops[0] || ['単語帳'])[0];

    // 音声・画像：番号 → ファイル名
    let mediaMap = {};
    if (files.media) {
      const raw = unz(files.media);
      if (raw[0] === 0x7b) mediaMap = JSON.parse(td.decode(raw));
      else pbFields(raw).forEach(([no, v], i) => {
        if (no !== 1) return;
        const nm = pbFields(v).find((x) => x[0] === 1);
        if (nm) mediaMap[String(i)] = td.decode(nm[1]);
      });
    }
    // ノートが使っているファイルだけ取り出す
    const used = new Set();
    const reS = /\[sound:([^\]]+)\]/g, reI = /<img[^>]*?src=["']?([^"'>\s]+)/gi;
    for (const n of notes) for (const f of n.f) {
      for (const m of f.matchAll(reS)) used.add(m[1].trim());
      for (const m of f.matchAll(reI)) { try { used.add(decodeURIComponent(m[1])); } catch { used.add(m[1]); } }
    }
    const wanted = Object.entries(mediaMap).filter(([, nm]) => used.has(nm));
    const want = new Map(wanted);
    const media = [], transfer = [];
    let done = 0;
    post('media', 0, wanted.length);
    // 1つずつ取り出す（33MB でも一度にメモリを使いすぎないように）
    await new Promise((res, rej) => {
      const uz = new fflate.Unzip((f) => {
        if (!want.has(f.name)) return;
        const parts = [];
        f.ondata = (err, chunk, final) => {
          if (err) return rej(err);
          parts.push(chunk);
          if (!final) return;
          let len = 0; for (const p of parts) len += p.length;
          let b = new Uint8Array(len), o = 0; for (const p of parts) { b.set(p, o); o += p.length; }
          if (isNew) b = unz(b);
          const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          media.push({ name: want.get(f.name), data: buf }); transfer.push(buf);
          if (++done % 20 === 0 || done === wanted.length) post('media', done, wanted.length);
        };
        f.start();
      });
      uz.register(fflate.UnzipInflate);
      const CH = 1 << 20;
      for (let i = 0; i < zipBuf.length; i += CH) uz.push(zipBuf.subarray(i, i + CH), i + CH >= zipBuf.length);
      res();
    });
    const missing = [...used].filter((nm) => !media.some((m) => m.name === nm)).length;
    self.postMessage({ type: 'done', format: colName, models, topName, notes: notes.map((n) => ({ guid: n.guid, mid: n.mid, f: n.f, k: order[n.id] || [2, 0] })), media, missing }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
