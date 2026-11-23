import { APP_NAME, VERSION, HISTORY } from './config.js';
import { today, now, addDays, parseD, weekStart, range, isDebugDate } from './dates.js';
import { Rating, State, preview, rate, ivlLabel, dayQueue, pickNext, summarize, newInfo, MATURE_DAYS, isRetired, setRetired, retiredList, hasNewLeft } from './srs.js';
import { dayN, weekN, lastWeekN, streak, ranking, gapToNext, mergeProfile, mergeProgress, trimProgress } from './records.js';
import { audioCfg, ensureAudio, resetAudio, playVoice, preload, stopVoice, tone } from './audio.js';
import { sanitize, plainText, soundsOf, imagesOf } from './sanitize.js';
import { readApkg, guessMap, buildDeck, sortNotes, deckIdFor, cardOf, ROLES } from './importer.js';
import * as idb from './idb.js';
import { cloudReady, listDocs, getDoc, putDoc } from './cloud.js';
import { uploadDeck, uploadState, fetchDeck, fillMedia, fetchOne, deckMeta, planPack, typeOf, isAudio, isRunning } from './share.js';
const storageReady = cloudReady; // 単語帳の中身も Firestore に置く（無料の Spark プランで使える）

// ───────── 基本 ─────────
const LS_KEY = 'eitango.v1', PROG_KEY = 'eitango.prog.';
const MAX_PEOPLE = 4;
const NEW_OPTS = [10, 15, 20, 30];
const AVATARS = ['🦊', '🐼', '🐧', '🐨', '🦁', '🐸', '🐙', '🦄', '🐳', '🦖', '🐱', '🦉', '🐻', '🐹', '🦈', '🦋', '🐢', '🐰', '🐶', '🐯',
  '🚀', '⚽', '🎮', '🎸', '🌈', '🍙', '🍓', '🌻', '🤖', '👾', '🧙', '🎧', '📚', '✈️', '🏀', '🎨'];
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = '日月火水木金土';
const mdw = (d) => { const x = parseD(d); return `${x.getMonth() + 1}/${x.getDate()}（${WD[x.getDay()]}）`; };

// ───────── 保存（localStorage） ─────────
let DB = loadDB();
let P = null; // 今の人
function loadDB() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY));
    if (d && Array.isArray(d.profiles)) { d.decks = d.decks || {}; d.hidden = d.hidden || []; d.deleted = d.deleted || []; d.profiles.forEach(fixProfile); return d; }
  } catch { /* 初回 */ }
  return { v: 1, profiles: [], current: null, sound: true, family: '', lastSync: 0, deleted: [], decks: {}, hidden: [] };
}
function fixProfile(p) { p.log = p.log || {}; p.sum = p.sum || {}; p.newPerDay = p.newPerDay || 10; return p; }
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) { alert('記録の保存に失敗しました: ' + e.message); }
}
const PROG = {};
const progId = (pid, did) => pid + '_' + did;
function getProg(pid, did) {
  const k = progId(pid, did);
  if (PROG[k]) return PROG[k];
  let o = null;
  try { o = JSON.parse(localStorage.getItem(PROG_KEY + k)); } catch { /* なし */ }
  return (PROG[k] = o || { id: k, c: {}, nd: {}, upd: 0 });
}
const hasProg = (pid, did) => !!PROG[progId(pid, did)] || localStorage.getItem(PROG_KEY + progId(pid, did)) != null;
function saveProg(prog) {
  try { localStorage.setItem(PROG_KEY + prog.id, JSON.stringify(prog)); } catch (e) { alert('記録の保存に失敗しました: ' + e.message); }
}
const dirty = new Set(); // クラウドに送る必要があるもの 'p:人ID' / 'g:人ID_単語帳ID'
function save(prog) {
  if (P) { P.upd = Date.now(); dirty.add('p:' + P.id); }
  if (prog) { prog.upd = Date.now(); saveProg(prog); dirty.add('g:' + prog.id); }
  saveLocal(); schedulePush();
}
function newProfile(name, avatar) {
  return { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, avatar, newPerDay: 10, deck: null, log: {}, sum: {}, upd: Date.now() };
}

// ───────── 単語帳 ─────────
const DECKS = {}; // id → { deck, order:[guid], byG: Map }
const visibleDecks = () => Object.values(DB.decks).filter((d) => !DB.hidden.includes(d.id)).sort((a, b) => (a.created || a.upd || 0) - (b.created || b.upd || 0));
async function loadDeck(id) {
  if (!id) return null;
  if (DECKS[id]) return DECKS[id];
  const deck = await idb.getDeck(id).catch(() => null);
  if (!deck) return null;
  if (DB.decks[id] && DB.decks[id].name) deck.name = DB.decks[id].name;
  return (DECKS[id] = { deck, order: deck.notes.map((n) => n[0]), byG: new Map(deck.notes.map((n) => [n[0], n])) });
}
function curDeckId() {
  const vis = visibleDecks();
  if (P && P.deck && vis.some((d) => d.id === P.deck)) return P.deck;
  return (vis.find((d) => d.local) || vis[0] || {}).id || null;
}
async function mediaBytes(deckId, name) {
  const b = await idb.getMedia(deckId, name).catch(() => null);
  if (b) return b;
  if (cloudOn() && storageReady()) { try { return await fetchOne(DB.family, deckId, name); } catch { return null; } }
  return null;
}
function updateSum(did) {
  const D = DECKS[did]; if (!D || !P) return;
  P.sum[did] = { ...summarize(D.order, getProg(P.id, did)), at: Date.now() };
}

// ───────── 進み具合のバー（取り込み・アップロード・ダウンロード） ─────────
const TASKS = {}; // key → { label, done, total, err }
function setTask(k, label, done, total, err) {
  TASKS[k] = { label, done, total, err };
  const el = document.querySelector(`[data-task="${k}"]`);
  if (el) el.outerHTML = taskHtml(k);
}
function taskHtml(k) {
  const t = TASKS[k]; if (!t) return `<div data-task="${k}"></div>`;
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  return `<div class="task ${t.err ? 'err' : ''}" data-task="${k}"><div class="tl">${esc(t.label)}<span>${t.err ? '⚠️ ' + esc(t.err) : t.total ? `${t.done} / ${t.total}` : ''}</span></div>
    <div class="bar"><i style="width:${t.err ? 100 : pct}%"></i></div></div>`;
}

// ───────── クラウド同期 ─────────
let syncing = false, pushTimer = null, syncMsg = '', curView = null, pendingReload = false, inStudy = false;
const cloudOn = () => cloudReady() && !!DB.family;
async function syncNow() {
  if (!cloudOn() || syncing) return false;
  syncing = true;
  try {
    const fam = DB.family;
    // 人
    const remote = await listDocs(fam, 'profiles'), seen = {};
    for (const r of remote) {
      if (!r || !r.id || DB.deleted.includes(r.id)) continue;
      seen[r.id] = JSON.stringify(r);
      const l = DB.profiles.find((p) => p.id === r.id);
      if (l) Object.assign(l, mergeProfile(l, r)); else DB.profiles.push(fixProfile(r));
    }
    // 単語帳の一覧
    const decks = await listDocs(fam, 'decks').catch(() => []);
    for (const m of decks) {
      if (!m || !m.id) continue;
      const l = DB.decks[m.id] || {};
      DB.decks[m.id] = { ...l, ...m, local: !!l.local, created: l.created || m.upd };
      if (DECKS[m.id] && m.name) DECKS[m.id].deck.name = m.name;
    }
    saveLocal();
    for (const p of DB.profiles) if (JSON.stringify(p) !== seen[p.id]) { await putDoc(fam, 'profiles', p.id, p); }
    for (const p of DB.profiles) dirty.delete('p:' + p.id);
    // 各カードの記録：この端末で使っている人の分
    for (const p of DB.profiles) {
      if (p !== P && !Object.keys(DB.decks).some((d) => hasProg(p.id, d))) continue;
      for (const did of new Set([...Object.keys(DB.decks), ...Object.keys(p.sum || {})])) {
        const local = hasProg(p.id, did) ? getProg(p.id, did) : null;
        const rem = await getDoc(fam, 'progress', progId(p.id, did));
        if (!local && !rem) continue;
        const m = trimProgress(!local ? rem : !rem ? local : mergeProgress(local, rem));
        m.id = progId(p.id, did);
        PROG[m.id] = m; saveProg(m);
        if (JSON.stringify(m) !== JSON.stringify(rem)) await putDoc(fam, 'progress', m.id, m);
        dirty.delete('g:' + m.id);
      }
    }
    // この端末で取り込んで、まだクラウドにない（終わっていない）単語帳はアップロードを続ける
    for (const d of Object.values(DB.decks)) if (d.local && d.mine && !d.done) startUpload(d.id);
    DB.lastSync = Date.now(); syncMsg = '';
    saveLocal();
    return true;
  } catch (e) { syncMsg = e.message; return false; }
  finally { syncing = false; }
}
async function pushDirty(keepalive = false) {
  if (!cloudOn()) return;
  for (const k of [...dirty]) {
    const [t, id] = [k.slice(0, 1), k.slice(2)];
    try {
      if (t === 'p') { const p = DB.profiles.find((x) => x.id === id); if (p) await putDoc(DB.family, 'profiles', id, p, keepalive); }
      else if (PROG[id]) await putDoc(DB.family, 'progress', id, PROG[id], keepalive);
      dirty.delete(k); syncMsg = '';
    } catch (e) { syncMsg = e.message; if (!e.status) return; }
  }
}
function schedulePush() {
  if (!cloudOn()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushDirty(), 4000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearTimeout(pushTimer); pushDirty(true); }
  else if (!inStudy) syncNow().then((ok) => { if (ok && (curView === viewProfiles || curView === viewHome)) go(curView); });
});
window.addEventListener('online', () => { pushDirty().then(() => syncNow()); });

function startUpload(id) {
  if (!cloudOn() || !storageReady() || isRunning('up' + id)) return;
  idb.getDeck(id).then((deck) => {
    if (!deck) return;
    const k = 'up:' + id, by = P ? P.name : '';
    setTask(k, `「${deck.name}」を家族と共有しています`, 0, 0);
    uploadDeck(DB.family, deck, by, (d, t) => setTask(k, `「${deck.name}」を家族と共有しています`, d, t))
      .then((ok) => { if (ok) { DB.decks[id] = { ...DB.decks[id], done: true }; saveLocal(); setTask(k, `「${deck.name}」を共有しました`, 1, 1); } })
      .catch((e) => setTask(k, `「${deck.name}」の共有が途中で止まりました（あとで続きから）`, 0, 0, e.message));
  });
}
/** ほかの端末が取り込んだ単語帳をダウンロード。今日の分の音声を先に */
async function downloadDeck(id, firstOnly = false) {
  const meta = DB.decks[id];
  if (!meta || !cloudOn() || !storageReady()) return null;
  const k = 'dl:' + id;
  try {
    setTask(k, `「${meta.name}」をダウンロードしています`, 0, 0);
    const deck = await fetchDeck(DB.family, meta);
    delete DECKS[id];
    DB.decks[id] = { ...DB.decks[id], local: true }; saveLocal();
    const D = await loadDeck(id);
    const first = todaysMedia(D);
    await fillMedia(DB.family, deck, first, (d, t) => setTask(k, `「${meta.name}」の今日の分をダウンロードしています`, d, t), true);
    setTask(k, `「${meta.name}」の今日の分はダウンロードずみ`, 1, 1);
    if (!firstOnly) backgroundFill(id);
    return D;
  } catch (e) { setTask(k, `「${meta.name}」のダウンロードが途中で止まりました`, 0, 0, e.message); return null; }
}
function backgroundFill(id) {
  if (!cloudOn() || !storageReady()) return;
  const D = DECKS[id]; if (!D) return;
  const k = 'dl:' + id, nm = D.deck.name;
  fillMedia(DB.family, D.deck, todaysMedia(D), (d, t) => setTask(k, d >= t ? `「${nm}」の音声はすべてこの端末にあります` : `「${nm}」の音声をダウンロードしています`, d, t))
    .catch((e) => setTask(k, `「${nm}」のダウンロードが途中で止まりました（あとで続きから）`, 0, 0, e.message));
}
/** 今日出るカードの音声・画像のファイル名 */
function todaysMedia(D) {
  if (!P) return [];
  const q = dayQueue(D.order, getProg(P.id, D.deck.id), P);
  const out = [];
  for (const g of [...q.learn, ...q.review, ...q.fresh, ...D.order.slice(0, 0)]) {
    const n = D.byG.get(g); if (!n) continue;
    const c = cardOf(D.deck, n);
    out.push(...c.snd, ...c.img, ...imagesOf(c.en), ...imagesOf(c.ja), ...c.snd2);
  }
  // 「あと10枚」に備えて、その先の新しいカード10枚分も
  const prog = getProg(P.id, D.deck.id);
  let extra = 0;
  for (const g of D.order) {
    if (extra >= 10) break;
    if (prog.c[g] || q.fresh.includes(g) || isRetired(prog, g)) continue;
    const c = cardOf(D.deck, D.byG.get(g)); out.push(...c.snd, ...c.img, ...c.snd2); extra++;
  }
  return out;
}

// ───────── 画面の切りかえ ─────────
let cleanup = null;
function go(render, ...args) {
  if (cleanup) { cleanup(); cleanup = null; }
  if (pendingReload && render !== viewStudy) { location.reload(); return; }
  app.onclick = null; app.onchange = null; app.oninput = null;
  window.scrollTo(0, 0);
  curView = render;
  inStudy = render === viewStudy;
  render(...args);
}
function onAct(map) {
  app.onclick = (e) => {
    const el = e.target.closest('[data-act]');
    if (el && map[el.dataset.act]) map[el.dataset.act](el, e);
  };
}
const syncLine = () => (cloudOn() ? `<p class="sync ${syncMsg ? 'bad' : ''}">☁️ ${syncMsg ? '同期できていません（' + esc(syncMsg) + '）。記録はこの端末に残っています' : syncing ? '同期中…' : DB.lastSync ? '家族と同期ずみ' : '同期の準備中…'}
  <button class="linkbtn" data-act="resync">いま同期</button></p>` : '');

// ───────── 家族ランキング ─────────
function rankRows(R, me, compact = false) {
  const top = Math.max(1, ...R.map((r) => r.week));
  return R.map((r, i) => {
    const up = r.last > 0 && r.week > r.last, upSoFar = !up && r.lastSoFar > 0 && r.week > r.lastSoFar;
    const badge = up ? '<em class="bdg up">🚀 先週超え！</em>' : upSoFar ? `<em class="bdg">📈 先週のこの時点より +${r.week - r.lastSoFar}</em>` : '';
    const tag = compact ? 'div' : 'button';
    return `<${tag} class="rk ${r.p === me ? 'me' : ''}" ${compact ? '' : `data-act="pick" data-id="${r.p.id}"`}>
      <span class="rno">${['🥇', '🥈', '🥉'][i] || i + 1}</span><span class="rav">${r.p.avatar}</span>
      <span class="rmain"><span class="rname">${esc(r.p.name)}${badge}</span><span class="rbar"><i style="width:${(r.week / top) * 100}%"></i></span></span>
      <span class="rnum"><b>${r.week}</b><small>枚</small></span><span class="rst ${r.streak ? '' : 'zero'}">🔥${r.streak}<small>日</small></span></${tag}>`;
  }).join('');
}
/** やる気が出る一言（責めない） */
function cheer(R, me) {
  const i = R.findIndex((r) => r.p === me); if (i < 0) return '';
  const r = R[i];
  if (R.length === 1) return r.week ? `今週 ${r.week}枚。いいペースです！` : '今週はこれから。まずは1枚からどうぞ。';
  if (i === 0) {
    if (!r.week) return '今週はまだみんなこれから。最初の1枚で1位に！';
    const g2 = r.week - R[1].week;
    return g2 > 0 ? `いま1位！ 2位の${esc(R[1].p.name)}さんと ${g2}枚差です。` : 'いま1位タイ！ あと1枚で単独トップ。';
  }
  const gap = gapToNext(R, i), above = R[i - 1];
  const head = r.last > 0 && r.week > r.last ? '先週より多く学習できています！ ' : '';
  return `${head}あと <b>${gap}</b>枚で ${esc(above.p.name)}さんを抜けます。`;
}

// ───────── 名前を選ぶ画面 ─────────
function viewProfiles() {
  const R = ranking(DB.profiles);
  app.innerHTML = `<div class="page narrow">
    <h1 class="logo"><img class="mark" src="icon-192.png" alt="" width="76" height="76">${esc(APP_NAME)}<small>家族で英語を覚えよう</small></h1>
    ${DB.profiles.length ? `<h2 class="sec">だれが学習しますか？</h2>
      <div class="people">${DB.profiles.map((p) => `<button class="person" data-act="pick" data-id="${p.id}"><span class="pav">${p.avatar}</span><span class="pname">${esc(p.name)}</span><small>🔥 ${streak(p)}日・今週 ${weekN(p)}枚</small></button>`).join('')}
      ${DB.profiles.length < MAX_PEOPLE ? '<button class="person add" data-act="add"><span class="pav">＋</span><span class="pname">追加</span></button>' : ''}</div>
      ${R.length > 1 ? `<h2 class="sec">🏆 今週のランキング<small>${mdw(weekStart())}から</small></h2><div class="ranks">${rankRows(R, null, true)}</div>` : ''}`
    : `<section class="card hello"><p>はじめまして！ まず、学習する人の名前を登録してください（家族で4人まで）。</p>
      <div class="row"><button class="btn primary big" data-act="add">＋ 名前を登録する</button></div></section>`}
    ${cloudReady() && !DB.family ? '<div class="row"><button class="btn ghost" data-act="cloud">☁️ 家族の合言葉で記録をよびだす</button></div>' : ''}
    ${syncLine()}
    <p class="ver">v${VERSION}${isDebugDate() ? `　<b class="dbg">日付テスト中：${today()}</b>` : ''}</p>
  </div>`;
  onAct({
    pick: (el) => { DB.current = el.dataset.id; saveLocal(); P = DB.profiles.find((p) => p.id === DB.current); go(viewHome); },
    add: () => go(viewProfileForm, null),
    cloud: () => go(viewCloudLink),
    resync: async () => { await syncNow(); go(viewProfiles); },
  });
}
function viewCloudLink() {
  app.innerHTML = `<div class="page narrow">
    <header class="top"><button class="btn back" data-act="back">← もどる</button><h2>☁️ 記録をよびだす</h2><span></span></header>
    <section class="card">
      <p>ほかの端末で使っている<b>家族の合言葉</b>を入れると、同じ家族の記録と単語帳がこの端末にも出てきます。</p>
      <p class="note">合言葉は、使っている端末の「設定 → 家族の合言葉と同期」に表示されています。</p>
      <label class="fld">合言葉<input id="fam" type="text" maxlength="40" placeholder="合言葉を入れる" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <div class="row"><button class="btn primary" data-act="link">よびだす</button></div>
      <p class="note" id="msg"></p>
    </section></div>`;
  onAct({
    back: () => go(viewProfiles),
    link: async () => {
      const code = $('#fam').value.trim();
      if (code.length < 12) return alert('合言葉は12文字以上です。もう一度たしかめてください。');
      $('#msg').textContent = 'よびだし中…';
      const before = DB.profiles.length;
      DB.family = code; saveLocal();
      const ok = await syncNow();
      if (!ok) { DB.family = ''; saveLocal(); $('#msg').textContent = ''; return alert('同期できませんでした: ' + syncMsg); }
      if (DB.profiles.length === before && !confirm('この合言葉には、まだだれの記録もありませんでした。合言葉が1文字でもちがうと別の場所になります。\n\nこのままこの合言葉で同期を続けますか？')) {
        DB.family = ''; saveLocal(); $('#msg').textContent = '合言葉をたしかめて、もう一度入れてください。'; return;
      }
      go(viewProfiles);
    },
  });
}
function viewProfileForm(p) {
  const used = DB.profiles.filter((x) => x !== p).map((x) => x.avatar);
  const cur = p || { name: '', avatar: AVATARS.find((a) => !used.includes(a)) };
  app.innerHTML = `<div class="page narrow">
    <header class="top"><button class="btn back" data-act="cancel">← もどる</button><h2>${p ? '名前・アイコンを変える' : '名前を登録'}</h2><span></span></header>
    <section class="card">
      <label class="fld">名前<input id="pn" type="text" maxlength="12" value="${esc(cur.name)}" placeholder="名前" autocomplete="off"></label>
      <div class="fld">アイコン<div class="avs">${AVATARS.map((a) => `<button class="av ${a === cur.avatar ? 'on' : ''}" data-act="av" data-a="${a}">${a}</button>`).join('')}</div></div>
      <div class="row"><button class="btn primary big" data-act="ok">決定</button></div>
    </section></div>`;
  let avatar = cur.avatar;
  onAct({
    av: (el) => { avatar = el.dataset.a; app.querySelectorAll('.av').forEach((b) => b.classList.toggle('on', b === el)); },
    cancel: () => go(p ? viewSettings : viewProfiles),
    ok: () => {
      const name = $('#pn').value.trim();
      if (!name) return alert('名前を入れてください');
      if (p) { p.name = name; p.avatar = avatar; save(); go(viewSettings); }
      else {
        if (DB.profiles.length >= MAX_PEOPLE) return alert(`登録できるのは${MAX_PEOPLE}人までです`);
        const np = newProfile(name, avatar); DB.profiles.push(np);
        DB.current = np.id; P = np; save(); go(viewHome); syncNow();
      }
    },
  });
}

// ───────── ホーム ─────────
async function viewHome() {
  if (!P) return go(viewProfiles);
  const did = curDeckId(), meta = did && DB.decks[did];
  let D = did ? await loadDeck(did) : null;
  if (curView !== viewHome) return;
  const R = ranking(DB.profiles), st = streak(P), t = today();
  let main;
  if (!meta) {
    main = `<div class="empty"><p>まだ単語帳がありません。</p><p class="note">Anki の .apkg ファイルを取り込むと、家族みんなで使えます。${cloudOn() ? '家族のだれかが取り込んだ単語帳は、ここに自動で出てきます。' : ''}</p>
      <div class="row"><button class="btn primary big" data-act="import">📥 単語帳を取り込む</button></div></div>`;
  } else if (!D) {
    const can = cloudOn() && storageReady() && meta.done !== false;
    main = `<div class="empty"><p>「${esc(meta.name)}」はまだこの端末にありません。</p>
      ${can ? `<div class="row"><button class="btn primary big" data-act="dl">⬇️ ダウンロードする</button></div><p class="note">${meta.count}文・音声${meta.audio}個。今日の分を先に取ってきます。</p>`
    : `<p class="note">${meta.done === false ? '取り込んだ端末から、まだアップロード中です。しばらくしてからもう一度ひらいてください。' : '家族の合言葉で同期すると使えます。'}</p>`}
      ${taskHtml('dl:' + did)}</div>`;
  } else {
    const prog = getProg(P.id, did), q = dayQueue(D.order, prog, P), ni = newInfo(prog);
    const leftNew = hasNewLeft(D.order, prog);
    const doneToday = dayN(P, t);
    if (q.total) {
      main = `<div class="today"><div class="tnum"><b>${q.total}</b><small>枚 今日の残り</small></div>
          <div class="tsplit"><span><i class="dot rv"></i>復習 <b>${q.review.length + q.learn.length}</b></span><span><i class="dot nw"></i>新しい <b>${q.fresh.length}</b></span></div></div>
        <button class="btn primary huge" data-act="start">${doneToday ? '▶ 続きから' : '▶ 学習をはじめる'}</button>`;
    } else {
      main = `<div class="today done"><div class="tdone">🎉 今日の分は完了！</div><p class="note">今日 ${doneToday}枚 学習しました。${ni.n ? `新しいカードは ${ni.n}枚。` : ''}</p></div>
        ${leftNew ? '<button class="btn big" data-act="more">＋ 新しいカードをあと10枚</button>' : '<p class="note">この単語帳の新しいカードはすべて学習しました。</p>'}`;
    }
  }
  const decks = visibleDecks();
  app.innerHTML = `<div class="page">
    <header class="top"><button class="who" data-act="switch"><span>${P.avatar}</span>${esc(P.name)}<small>切りかえ</small></button>
      <span class="chip fire">🔥 ${st}日連続</span></header>
    ${decks.length > 1 ? `<label class="decksel">単語帳<select id="deck">${decks.map((d) => `<option value="${d.id}" ${d.id === did ? 'selected' : ''}>${esc(d.name)}${d.local ? '' : '（未ダウンロード）'}</option>`).join('')}</select></label>`
    : meta ? `<p class="deckname">📘 ${esc(meta.name)}</p>` : ''}
    <section class="hero card">${main}</section>
    <section class="card"><h3>🏆 家族ランキング<small>今週（${mdw(weekStart())}〜）の学習カード数</small></h3>
      <p class="cheer">${cheer(R, P)}</p><div class="ranks">${rankRows(R, P, true)}</div></section>
    <div class="tasks">${Object.keys(TASKS).filter((k) => k.startsWith('up:')).map(taskHtml).join('')}</div>
    <nav class="navs"><button class="btn nav" data-act="stats">📊<span>統計</span></button><button class="btn nav" data-act="set">⚙️<span>設定</span></button></nav>
    ${syncLine()}
  </div>`;
  app.onchange = (e) => { if (e.target.id === 'deck') { P.deck = e.target.value; save(); go(viewHome); } };
  onAct({
    switch: () => go(viewProfiles),
    start: () => { ensureAudio(true); go(viewStudy, did); },
    more: () => { const prog = getProg(P.id, did), i = (prog.nd[t] = prog.nd[t] || { n: 0, x: 0 }); i.x = (i.x || 0) + 10; save(prog); if (D && cloudOn()) fillMedia(DB.family, D.deck, todaysMedia(D), () => {}, true).catch(() => {}); ensureAudio(true); go(viewStudy, did); },
    import: () => go(viewImport),
    dl: async (el) => { el.disabled = true; el.textContent = 'ダウンロード中…'; P.deck = did; save(); await downloadDeck(did); if (curView === viewHome) go(viewHome); },
    stats: () => go(viewStats, P.id),
    set: () => go(viewSettings),
    resync: async () => { await syncNow(); go(viewHome); },
  });
  if (D && cloudOn() && storageReady() && DB.decks[did] && !DB.decks[did].mine) backgroundFill(did);
}

// ───────── 学習 ─────────
const SND = {
  [Rating.Again]: () => tone([[392, 0.12], [330, 0.16]], 'triangle', 0.08),
  [Rating.Hard]: () => tone([[523, 0.12]], 'triangle', 0.08),
  [Rating.Good]: () => tone([[659, 0.09], [880, 0.14]], 'sine', 0.1),
  [Rating.Easy]: () => tone([[659, 0.08], [880, 0.08], [1175, 0.16]], 'sine', 0.1),
  fin: () => tone([[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.3]], 'sine', 0.12),
};
// 画面の下に少しだけ出るお知らせ（「元に戻す」つき）
let toastTimer = null;
function hideToast() { clearTimeout(toastTimer); const el = $('#toast'); if (el) el.remove(); }
function showToast(msg, actLabel, onAct) {
  hideToast();
  const el = document.createElement('div');
  el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(msg)}</span>${actLabel ? `<button class="tbtn">${esc(actLabel)}</button>` : ''}`;
  if (actLabel) el.querySelector('button').onclick = () => { hideToast(); onAct(); };
  document.body.appendChild(el);
  toastTimer = setTimeout(hideToast, actLabel ? 7000 : 2500);
}
const GRADES = [[Rating.Again, 'もう一度', 'again', '1'], [Rating.Hard, 'むずかしい', 'hard', '2'], [Rating.Good, 'できた', 'good', '3'], [Rating.Easy, 'かんたん', 'easy', '4']];
async function viewStudy(did) {
  const D = await loadDeck(did);
  if (!D || curView !== viewStudy) return go(viewHome);
  const prog = getProg(P.id, did);
  const S = { cur: null, back: false, last: null, urls: [], card: null, sheet: false };
  const revoke = () => { S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls = []; };
  cleanup = () => { revoke(); stopVoice(); hideToast(); document.removeEventListener('keydown', onKey); };
  const playName = (nm) => { if (nm) playVoice(did + '/' + nm, () => mediaBytes(did, nm), typeOf(nm)); };
  const play = () => { if (S.card) playName(S.card.snd[0]); };
  const playEx = () => { if (S.card && S.back) playName(S.card.snd2[0]); };

  async function next() {
    revoke(); stopVoice();
    const q = dayQueue(D.order, prog, P);
    if (!q.total) return finished();
    S.cur = pickNext(q, prog, dayN(P, today()), now(), S.last);
    S.back = false;
    const card = cardOf(D.deck, D.byG.get(S.cur));
    // 画像を先に用意（なければ何も出さない）
    const imgs = {};
    for (const nm of new Set([...card.img, ...imagesOf(card.en), ...imagesOf(card.ja)])) {
      const b = await mediaBytes(did, nm);
      if (b) { const u = URL.createObjectURL(new Blob([b], { type: typeOf(nm) })); imgs[nm] = u; S.urls.push(u); }
    }
    if (curView !== viewStudy) return;
    S.card = { ...card, imgs, q };
    render();
    play();
    // 次に出そうなカードの音声を先に読んでおく
    for (const g of [...q.review.slice(0, 2), ...q.fresh.slice(0, 2), ...q.learn.slice(0, 1)]) {
      if (g === S.cur) continue;
      const c = cardOf(D.deck, D.byG.get(g));
      if (c.snd[0]) preload(did + '/' + c.snd[0], () => mediaBytes(did, c.snd[0])).catch(() => {});
    }
  }
  function render() {
    const c = S.card, q = c.q, answered = dayN(P, today());
    const pct = Math.round((answered / Math.max(1, answered + q.total)) * 100);
    const isNew = !prog.c[S.cur] || prog.c[S.cur].t === State.New;
    const imgHtml = c.img.filter((n) => c.imgs[n]).map((n) => `<img src="${c.imgs[n]}" alt="">`).join('');
    const mp = D.deck.models[D.byG.get(S.cur)[1]].map, url = (n) => c.imgs[n] || null;
    const en = sanitize(c.en, url, mp.img === mp.en), ja = sanitize(c.ja, url, mp.img === mp.ja);
    const pos = plainText(c.pos), ex = sanitize(c.ex, url, true), exja = sanitize(c.exja, url, true);
    let foot;
    if (!S.back) foot = `<button class="btn primary huge show" data-act="show">答えを見る<small>スペース</small></button>`;
    else {
      const pv = preview(prog.c[S.cur], now());
      foot = `<div class="grades">${GRADES.map(([g, label, cls, key]) => `<button class="gbtn ${cls}" data-act="rate" data-g="${g}"><b>${label}</b><small>${ivlLabel(+pv[g].due)}</small><kbd>${key}</kbd></button>`).join('')}</div>`;
    }
    app.innerHTML = `<div class="page study">
      <header class="stop"><button class="btn back" data-act="quit">✕ やめる</button>
        <div class="sprog"><div class="bar"><i style="width:${pct}%"></i></div><small><span class="c-nw">新 ${q.fresh.length}</span>　<span class="c-ln">学習中 ${q.learn.length}</span>　<span class="c-rv">復習 ${q.review.length}</span>　今日 ${answered}枚</small></div></header>
      <section class="flash ${S.back ? 'flip' : ''}">
        ${isNew ? '<span class="tagnew">はじめて</span>' : ''}
        ${S.back ? '<button class="grad" data-act="gradask" title="このカードを卒業させる（もう出さない）">🎓 卒業</button>' : ''}
        ${imgHtml ? `<div class="fimg">${imgHtml}</div>` : ''}
        <div class="en ${plainText(c.en).split(' ').length <= 3 ? 'word' : ''}">${en || '<span class="note">（英語がありません）</span>'}</div>
        ${c.snd[0] ? '<button class="btn listen" data-act="play">🔊 もう一度聞く<small>R</small></button>' : ''}
        ${S.back ? `<hr>${pos ? `<span class="pos">${esc(pos)}</span>` : ''}<div class="ja">${ja || '<span class="note">（和訳がありません）</span>'}</div>
          ${ex ? `<div class="ex"><div class="exen">${ex}</div>${exja ? `<div class="exja">${exja}</div>` : ''}${c.snd2[0] ? '<button class="btn listen sm2" data-act="playex">🔊 例文を聞く<small>E</small></button>' : ''}</div>` : ''}` : ''}
      </section>
      <footer class="sfoot">${foot}</footer>
      ${S.sheet ? `<div class="sheetbg" data-act="gradno"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="gradttl" data-act="none">
        <div class="gicon">🎓</div><h3 id="gradttl">このカードを卒業させますか？</h3>
        <p class="gword">${esc(plainText(c.en))}</p>
        <p class="note">卒業したカードは、もう出ません（家族のほかの人には出ます）。<br>まちがえたときは「統計」の画面からいつでも戻せます。</p>
        <div class="row col"><button class="btn primary big" data-act="gradyes">🎓 卒業させる</button><button class="btn big" data-act="gradno">やめる</button></div>
      </div></div>` : ''}
    </div>`;
  }
  /** このカードを卒業させる（もう出さない）。答えの数には入れない */
  function graduate() {
    const g = S.cur, w = plainText(S.card.en), word = w.length > 24 ? w.slice(0, 23) + '…' : w;
    setRetired(prog, g, true);
    S.sheet = false; S.last = g;
    const t = today();
    if (!dayQueue(D.order, prog, P).total && dayN(P, t)) (P.log[t] = P.log[t] || { n: 0 }).fin = 1;
    P.deck = did; updateSum(did); save(prog);
    tone([[784, 0.1], [1047, 0.18]], 'sine', 0.08);
    showToast(`🎓「${word}」を卒業させました`, '元に戻す', () => { setRetired(prog, g, false); updateSum(did); save(prog); showToast('元に戻しました。また出てきます'); });
    next();
  }
  function answer(g) {
    if (!S.back) return;
    const t = today(), before = prog.c[S.cur];
    if (!before || before.t === State.New) { const i = (prog.nd[t] = prog.nd[t] || { n: 0, x: 0 }); i.n++; }
    prog.c[S.cur] = rate(before, g, now());
    const L = (P.log[t] = P.log[t] || { n: 0 }); L.n++;
    S.last = S.cur;
    const q = dayQueue(D.order, prog, P);
    if (!q.total) L.fin = 1;
    P.deck = did;
    updateSum(did);
    trimProgress(prog);
    save(prog);
    SND[g]();
    next();
  }
  function finished() {
    const t = today(), leftNew = hasNewLeft(D.order, getProg(P.id, did));
    if (P.log[t] && P.log[t].n && !P.log[t].fin) { P.log[t].fin = 1; save(); }
    if (P.log[t] && P.log[t].fin) SND.fin();
    const R = ranking(DB.profiles), i = R.findIndex((r) => r.p === P);
    app.innerHTML = `<div class="page narrow center">
      <section class="card finish"><div class="party">🎉</div><h2>今日の分は完了です！</h2>
        <p>今日 <b>${dayN(P, t)}</b>枚 学習しました。<br>🔥 連続 <b>${streak(P)}</b>日</p>
        ${R.length > 1 ? `<p class="cheer">今週 ${R[i].week}枚で家族 ${i + 1}位。${cheer(R, P)}</p>` : ''}
        <div class="row">${leftNew ? '<button class="btn primary big" data-act="more">＋ 新しいカードをあと10枚</button>' : ''}<button class="btn big" data-act="home">ホームへ</button></div>
      </section></div>`;
  }
  function onKey(e) {
    if (e.target.closest && e.target.closest('input,select,textarea')) return;
    if (S.sheet) { if (e.key === 'Escape') { S.sheet = false; render(); } return; } // 確認中はほかのキーを使わない
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!S.back) { S.back = true; render(); } else answer(Rating.Good); }
    else if (S.back && '1234'.includes(e.key)) answer(+e.key);
    else if (e.key === 'r' || e.key === 'R') play();
    else if (e.key === 'e' || e.key === 'E') playEx();
  }
  document.addEventListener('keydown', onKey);
  onAct({
    quit: () => go(viewHome),
    home: () => go(viewHome),
    show: () => { S.back = true; render(); },
    play: () => play(),
    playex: () => playEx(),
    rate: (el) => { if (!S.sheet) answer(+el.dataset.g); },
    gradask: () => { if (S.back) { S.sheet = true; render(); } },
    gradno: () => { S.sheet = false; render(); },
    gradyes: () => graduate(),
    more: () => { const t = today(), i = (prog.nd[t] = prog.nd[t] || { n: 0, x: 0 }); i.x = (i.x || 0) + 10; save(prog); if (cloudOn()) fillMedia(DB.family, D.deck, todaysMedia(D), () => {}, true).catch(() => {}); next(); },
  });
  next();
}

// ───────── 統計 ─────────
async function viewStats(pid) {
  const p = DB.profiles.find((x) => x.id === pid) || P, t = today();
  const days = range(addDays(t, -29), 30), mx = Math.max(5, ...days.map((d) => dayN(p, d)));
  const total = Object.values(p.log).reduce((a, L) => a + (L.n || 0), 0);
  const studied = days.filter((d) => dayN(p, d) > 0).length;
  const rows = [];
  for (const d of visibleDecks()) {
    let s = (p.sum || {})[d.id];
    if (p === P && DECKS[d.id]) s = summarize(DECKS[d.id].order, getProg(p.id, d.id));
    else if (p === P && d.local) { const D = await loadDeck(d.id); if (D) s = summarize(D.order, getProg(p.id, d.id)); }
    if (curView !== viewStats) return;
    const n = s ? s.t : d.count || 0, m = s ? s.m : 0, l = s ? s.l : 0, u = s ? s.u : n, x = (s && s.x) || 0;
    rows.push(`<div class="dst"><div class="dl">${esc(d.name)}<small>${n}文</small></div>
      <div class="seg"><i class="s-x" style="flex:${x}"></i><i class="s-m" style="flex:${m}"></i><i class="s-l" style="flex:${l}"></i><i class="s-u" style="flex:${u}"></i></div>
      <div class="leg">${x ? `<span><i class="s-x"></i>卒業 <b>${x}</b></span>` : ''}<span><i class="s-m"></i>定着 <b>${m}</b></span><span><i class="s-l"></i>学習中 <b>${l}</b></span><span><i class="s-u"></i>未学習 <b>${u}</b></span></div>
      ${p === P && x && DECKS[d.id] ? `<button class="linkbtn" data-act="grads" data-id="${d.id}">🎓 卒業したカードを見る・戻す</button>` : ''}</div>`);
  }
  app.innerHTML = `<div class="page narrow">
    <header class="top"><button class="btn back" data-act="home">← もどる</button><h2>📊 統計</h2><span></span></header>
    ${DB.profiles.length > 1 ? `<div class="tabs">${DB.profiles.map((x) => `<button class="tab ${x === p ? 'on' : ''}" data-act="who" data-id="${x.id}">${x.avatar} ${esc(x.name)}</button>`).join('')}</div>` : ''}
    <section class="tiles">
      <div class="tile"><small>今日</small><b>${dayN(p, t)}</b><span>枚</span></div>
      <div class="tile"><small>今週</small><b>${weekN(p)}</b><span>枚</span></div>
      <div class="tile"><small>先週</small><b>${lastWeekN(p)}</b><span>枚</span></div>
      <div class="tile"><small>連続</small><b>${streak(p)}</b><span>日</span></div>
    </section>
    <section class="card"><h3>最近30日の回答数<small>30日のうち ${studied}日 学習・これまでに ${total}枚</small></h3>
      <div class="chart" role="img" aria-label="最近30日の回答数">${days.map((d) => { const n = dayN(p, d), L = p.log[d]; return `<div class="cb ${d === t ? 'today' : ''} ${L && L.fin ? 'fin' : ''}" title="${mdw(d)} ${n}枚"><i style="height:${(n / mx) * 100}%"></i>${n ? `<em>${n}</em>` : ''}</div>`; }).join('')}</div>
      <div class="cx"><span>${mdw(days[0])}</span><span>${mdw(days[15])}</span><span>今日</span></div>
      <p class="note">濃い色の日＝その日の分を終えた日（連続日数に数える日）</p></section>
    <section class="card"><h3>単語帳ごと<small>定着＝次の復習まで${MATURE_DAYS}日以上のカード</small></h3>${rows.join('') || '<p class="note">単語帳がありません</p>'}</section>
  </div>`;
  onAct({ home: () => go(viewHome), who: (el) => go(viewStats, el.dataset.id), grads: (el) => go(viewGraduates, el.dataset.id) });
}

// ───────── 卒業したカード ─────────
async function viewGraduates(did) {
  const D = await loadDeck(did);
  if (!D || curView !== viewGraduates) return go(viewStats, P.id);
  const prog = getProg(P.id, did);
  const draw = () => {
    const list = retiredList(D.order, prog).map((g) => [g, cardOf(D.deck, D.byG.get(g))])
      .sort((a, b) => (prog.x[b[0]].at || 0) - (prog.x[a[0]].at || 0)); // 最近卒業した順
    app.innerHTML = `<div class="page narrow">
      <header class="top"><button class="btn back" data-act="back">← もどる</button><h2>🎓 卒業したカード</h2><span></span></header>
      <p class="note">${esc(P.avatar + ' ' + P.name)}さんの「${esc(D.deck.name)}」で、もう出さないことにしたカードです（${list.length}枚）。「戻す」を押すと、前の記録のまま、また出てくるようになります。</p>
      <section class="card glist">${list.map(([g, c]) => `<div class="gitem"><div class="gtxt"><b>${esc(plainText(c.en))}</b><small>${esc(plainText(c.ja))}</small></div><button class="btn sm" data-act="back1" data-g="${esc(g)}">戻す</button></div>`).join('') || '<p class="note">卒業したカードはありません</p>'}</section>
    </div>`;
  };
  draw();
  onAct({
    back: () => go(viewStats, P.id),
    back1: (el) => { setRetired(prog, el.dataset.g, false); updateSum(did); save(prog); showToast('戻しました。また出てきます'); draw(); },
  });
}

// ───────── 取り込み ─────────
function viewImport() {
  let res = null;
  app.innerHTML = `<div class="page narrow">
    <header class="top"><button class="btn back" data-act="back">← もどる</button><h2>📥 単語帳を取り込む</h2><span></span></header>
    <section class="card" id="step">
      <p>Anki の単語帳ファイル（.apkg）を選んでください。表に英文、裏に和訳を出します。</p>
      <label class="btn primary big filebtn">ファイルを選ぶ<input type="file" id="file" accept=".apkg,.colpkg,application/zip,application/octet-stream" hidden></label>
      <p class="note">${cloudOn() ? '取り込んだ単語帳は、家族の端末すべてで使えるようにアップロードされます（家族の合言葉の場所だけに置かれ、公開はされません）。' : '家族の合言葉で同期すると、取り込んだ単語帳を家族の端末でも使えます。'}</p>
    </section><div id="prog"></div></div>`;
  const progEl = $('#prog');
  const show = (label, d, t) => { TASKS.imp = { label, done: d, total: t }; progEl.innerHTML = taskHtml('imp'); };
  app.onchange = async (e) => {
    if (e.target.id !== 'file' || !e.target.files[0]) return;
    const f = e.target.files[0];
    $('#step').innerHTML = `<p>「${esc(f.name)}」（${(f.size / 1048576).toFixed(1)}MB）を読んでいます…</p>`;
    show('ファイルを読んでいます', 0, 0);
    try {
      res = await readApkg(f, show);
    } catch (err) {
      progEl.innerHTML = '';
      const unsupported = /zstd|unknown compression|未対応/i.test(err.message);
      $('#step').innerHTML = `<p class="bad">読みこめませんでした。</p><p class="note">${unsupported ? 'この形式は未対応です。Anki で『旧形式で書き出す』にチェックして書き出してください。' : esc(err.message)}</p>
        <div class="row"><button class="btn" data-act="again">もう一度選ぶ</button></div>`;
      return;
    }
    progEl.innerHTML = '';
    mapping();
  };
  async function mapping() {
    const mids = Object.keys(res.models).filter((mid) => res.notes.some((n) => n.mid === mid));
    if (!res.notes.length) { $('#step').innerHTML = '<p class="bad">カードが1枚もありませんでした。</p>'; return; }
    const maps = {};
    for (const mid of mids) maps[mid] = guessMap(res.models[mid].fields, res.notes.filter((n) => n.mid === mid));
    const id = await deckIdFor(res.topName), exists = DB.decks[id];
    let order = 'id';
    const draw = () => {
      $('#step').innerHTML = `<h3>単語帳の名前</h3>
        <label class="fld"><input id="dname" type="text" maxlength="40" value="${esc(exists ? exists.name : res.topName)}"></label>
        ${exists ? '<p class="note ok">✔ 前に取り込んだ単語帳と同じです。上書きしても学習記録はそのまま続きます。</p>' : ''}
        <label class="fld inline">新しいカードを出す順番<select id="order"><option value="id" ${order === 'id' ? 'selected' : ''}>本の順（ノートを作った順）</option><option value="anki" ${order === 'anki' ? 'selected' : ''}>Anki に保存されていた順</option></select></label>
        <p class="note">${res.notes.length}文・音声と画像 ${res.media.length}個${res.missing ? `（見つからないファイル ${res.missing}個）` : ''}</p>
        ${mids.map((mid) => {
    const m = res.models[mid], mp = maps[mid], ns = sortNotes(res.notes, order).filter((n) => n.mid === mid);
    const sel = (role) => `<select data-mid="${mid}" data-role="${role}"><option value="-1">なし</option>${m.fields.map((f, i) => `<option value="${i}" ${mp[role] === i ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>`;
    return `<h3>フィールドの割り当て<small>${esc(m.name)}（${ns.length}文）</small></h3>
          <div class="maps">${ROLES.map(([r, label]) => `<label class="fld inline">${label}${sel(r)}</label>`).join('')}</div>
          <div class="pv">${ns.slice(0, 3).map((n) => {
    const g = (i) => (i >= 0 ? n.f[i] || '' : '');
    const snd = soundsOf(g(mp.snd)).concat(mp.snd < 0 ? soundsOf(g(mp.en)) : []);
    return `<div class="pvc"><div class="en">${esc(plainText(g(mp.en))) || '<span class="note">（なし）</span>'}</div><div class="ja">${esc(plainText(g(mp.ja))) || '<span class="note">（なし）</span>'}</div>
            <small>${snd.length ? '🔊 音声あり' : '音声なし'}${mp.img >= 0 && imagesOf(g(mp.img)).length ? '・🖼 画像あり' : ''}</small></div>`;
  }).join('')}</div>`;
  }).join('')}
        <div class="row"><button class="btn primary big" data-act="save">この内容で取り込む</button></div>`;
    };
    draw();
    app.onchange = (e) => {
      const s = e.target;
      if (s.id === 'order') { order = s.value; const nm = $('#dname').value; draw(); $('#dname').value = nm; return; }
      if (s.dataset.role) {
        const v = +s.value, mp = maps[s.dataset.mid];
        for (const [r] of ROLES) if (r !== s.dataset.role && mp[r] === v && v >= 0) mp[r] = -1; // 同じフィールドを2つに使わない
        mp[s.dataset.role] = v;
        const nm = $('#dname').value; draw(); $('#dname').value = nm;
      }
    };
    onAct({
      back: () => go(viewSettings),
      save: async (el) => {
        if (mids.some((mid) => maps[mid].en < 0)) return alert('「英文（表）」にするフィールドを選んでください');
        el.disabled = true;
        const name = $('#dname').value.trim() || res.topName;
        const deck = buildDeck(res, maps, id, name, order);
        if (exists && exists.created) deck.created = Math.max(Date.now(), exists.created + 1);
        deck.pack = planPack(deck);
        $('#step').innerHTML = '<p>この端末に保存しています…</p>';
        try {
          const items = res.media.map((m) => [m.name, m.data]);
          for (let i = 0; i < items.length; i += 25) { await idb.putMediaMany(id, items.slice(i, i + 25)); show('音声・画像を保存しています', Math.min(items.length, i + 25), items.length); }
          await idb.putDeck(deck);
        } catch (err) { $('#step').innerHTML = `<p class="bad">保存できませんでした。</p><p class="note">${esc(err.message)}</p>`; return; }
        delete DECKS[id];
        DB.decks[id] = { ...(DB.decks[id] || {}), ...deckMeta(deck), created: deck.created, local: true, mine: true, done: false };
        DB.hidden = DB.hidden.filter((x) => x !== id);
        if (P) P.deck = id;
        save();
        res = null;
        if (cloudOn()) { putDoc(DB.family, 'decks', id, deckMeta(deck, { by: P ? P.name : '', uploaded: 0, done: false })).catch(() => {}); startUpload(id); }
        progEl.innerHTML = '';
        $('#step').innerHTML = `<p class="ok">✔ 「${esc(name)}」を取り込みました（${deck.notes.length}文）。</p>
          ${cloudOn() ? (storageReady() ? '<p class="note">家族の端末で使えるように、裏でアップロードしています。この画面を閉じても、次にひらいたとき続きからアップロードします。</p>' : '') : ''}
          <div class="row"><button class="btn primary big" data-act="home">ホームへ</button></div>`;
      },
      again: () => go(viewImport),
      home: () => go(viewHome),
    });
  }
  onAct({ back: () => go(viewSettings), again: () => go(viewImport) });
}

// ───────── 設定 ─────────
async function viewSettings() {
  const opt = (arr, cur, f = (x) => x) => arr.map((x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${f(x)}</option>`).join('');
  const decks = visibleDecks(), hidden = DB.hidden.filter((id) => DB.decks[id]);
  const ups = {};
  for (const d of decks) if (d.local && d.mine) { const deck = await idb.getDeck(d.id).catch(() => null); if (deck) ups[d.id] = await uploadState(deck); }
  if (curView !== viewSettings) return;
  app.innerHTML = `<div class="page narrow">
    <header class="top"><button class="btn back" data-act="home">← もどる</button><h2>⚙️ 設定</h2><span></span></header>
    <section class="card">
      <h3>${P.avatar} ${esc(P.name)}</h3>
      <label class="fld inline">1日の新しいカード<select id="newPerDay">${opt(NEW_OPTS, P.newPerDay, (x) => x + '枚')}</select></label>
      <div class="row"><button class="btn" data-act="edit">名前・アイコンを変える</button><button class="btn danger" data-act="del">${cloudOn() ? 'この端末の一覧から外す' : 'この人の記録を消す'}</button></div>
    </section>
    <section class="card">
      <h3>📘 単語帳</h3>
      ${decks.map((d) => `<div class="drow"><div><b>${esc(d.name)}</b><small>${d.count || 0}文・音声${d.audio || 0}個${d.local ? '' : '・未ダウンロード'}${ups[d.id] && cloudOn() ? (d.done ? '・家族と共有ずみ' : `・共有 ${ups[d.id].done}/${ups[d.id].total}`) : ''}</small></div>
        <span><button class="btn sm" data-act="rename" data-id="${d.id}">名前</button>${ups[d.id] && cloudOn() && !d.done ? `<button class="btn sm" data-act="upload" data-id="${d.id}">共有を続ける</button>` : ''}<button class="btn sm danger" data-act="hide" data-id="${d.id}">外す</button></span></div>`).join('') || '<p class="note">まだありません</p>'}
      ${Object.keys(TASKS).filter((k) => k !== 'imp').map(taskHtml).join('')}
      <div class="row"><button class="btn primary" data-act="import">📥 .apkg を取り込む</button>${hidden.length ? `<button class="btn" data-act="unhide">外した単語帳をもどす（${hidden.length}）</button>` : ''}</div>
      <p class="note">「外す」は一覧から外すだけです。クラウドの単語帳と学習記録は消えません（完全に消すのは管理者が Firebase の画面で行います）。</p>
    </section>
    <section class="card">
      <h3>☁️ 家族の合言葉と同期</h3>
      ${!cloudReady() ? '<p class="note">Firebase の接続先が未設定です。記録はこの端末の中だけに保存されています。</p>'
    : DB.family ? `<p>同期中です。家族の端末にも<b>同じ合言葉</b>を入れると、同じ記録と単語帳が出ます。</p>
        <p class="note">合言葉：<code>${esc(DB.family)}</code><br>${syncMsg ? '⚠️ エラー: ' + esc(syncMsg) : DB.lastSync ? '最後の同期：' + new Date(DB.lastSync).toLocaleString('ja-JP') : 'まだ同期していません'}</p>
        <div class="row"><button class="btn primary" data-act="sync">いま同期する</button><button class="btn" data-act="unlink">同期をやめる</button>${DB.deleted.length ? `<button class="btn" data-act="restore">外した人をもどす（${DB.deleted.length}人）</button>` : ''}</div>`
    : `<p class="note">家族だけの合言葉を決めて、使う端末すべてに同じものを入れてください。合言葉を知っている人は記録を見られるので、推測されにくいものにしてください。</p>
        <label class="fld">合言葉<input id="fam" type="text" maxlength="40" placeholder="12文字以上" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <div class="row"><button class="btn" data-act="gen">自動で作る</button><button class="btn primary" data-act="link">この合言葉で同期する</button></div>`}
    </section>
    <section class="card">
      <h3>この端末</h3>
      <label class="fld inline">効果音<select id="sound"><option value="1" ${DB.sound !== false ? 'selected' : ''}>あり</option><option value="0" ${DB.sound !== false ? '' : 'selected'}>なし</option></select></label>
      <div class="row"><button class="btn" data-act="fixsnd">🔧 音をなおす（テストの音が鳴ります）</button></div>
      <p class="note">英文の音声が出ないとき：画面をどこか1回タップ → 「音をなおす」 → それでもだめなら、アプリを終了してひらき直してください。消音スイッチや音量も確かめてください。</p>
    </section>
    <section class="card">
      <h3>記録のバックアップ</h3>
      <p class="note">家族全員の記録（単語帳の中身はふくまない）をファイルに書き出せます。</p>
      <div class="row"><button class="btn" data-act="export">ファイルに書き出す</button><button class="btn" data-act="importbk">ファイルから読みこむ</button></div>
      <input type="file" id="bkfile" accept="application/json,.json" hidden>
    </section>
    <div class="row"><button class="btn ghost" data-act="about">バージョン・更新履歴・ライセンス（v${VERSION}）</button></div>
  </div>`;
  app.onchange = (e) => {
    const id = e.target.id, v = e.target.value;
    if (id === 'newPerDay') { P.newPerDay = +v; save(); }
    if (id === 'sound') { DB.sound = v === '1'; audioCfg.sfx = DB.sound; saveLocal(); }
    if (id === 'bkfile' && e.target.files[0]) {
      e.target.files[0].text().then((txt) => {
        const d = JSON.parse(txt);
        if (!d || d.app !== 'eitango' || !d.db || !Array.isArray(d.db.profiles)) throw new Error('このアプリの記録ファイルではありません');
        if (!confirm(`${d.db.profiles.length}人分の記録を読みこみ、今の記録と置きかえます。よろしいですか？`)) return;
        for (const k of Object.keys(localStorage)) if (k.startsWith(PROG_KEY)) localStorage.removeItem(k);
        for (const k of Object.keys(PROG)) delete PROG[k];
        for (const [k, v2] of Object.entries(d.prog || {})) { localStorage.setItem(PROG_KEY + k, JSON.stringify(v2)); dirty.add('g:' + k); }
        const fam = DB.family, decks = DB.decks;
        DB = { ...loadDBFrom(d.db), family: fam };
        for (const [k, x] of Object.entries(decks)) DB.decks[k] = { ...(DB.decks[k] || {}), ...x };
        DB.profiles.forEach((p) => dirty.add('p:' + p.id));
        saveLocal(); P = null; go(viewProfiles); syncNow();
      }).catch((err) => alert('読みこめませんでした: ' + err.message));
    }
  };
  onAct({
    home: () => go(viewHome),
    edit: () => go(viewProfileForm, P),
    about: () => go(viewAbout),
    import: () => go(viewImport),
    fixsnd: () => { DB.sound = true; audioCfg.sfx = true; saveLocal(); resetAudio(); go(viewSettings); },
    rename: (el) => {
      const d = DB.decks[el.dataset.id], nm = prompt('単語帳の名前', d.name);
      if (!nm || !nm.trim()) return;
      d.name = nm.trim(); d.upd = Date.now(); saveLocal();
      if (DECKS[d.id]) DECKS[d.id].deck.name = d.name;
      idb.getDeck(d.id).then((deck) => { if (deck) { deck.name = d.name; idb.putDeck(deck); } }).catch(() => {});
      if (cloudOn()) getDoc(DB.family, 'decks', d.id).then((m) => m && putDoc(DB.family, 'decks', d.id, { ...m, name: d.name, upd: Date.now() })).catch(() => {});
      go(viewSettings);
    },
    hide: (el) => {
      const d = DB.decks[el.dataset.id];
      if (!confirm(`「${d.name}」を一覧から外します。クラウドの単語帳と学習記録は消えません。よろしいですか？`)) return;
      DB.hidden.push(d.id); saveLocal(); go(viewSettings);
    },
    unhide: () => { DB.hidden = []; saveLocal(); go(viewSettings); },
    upload: (el) => { startUpload(el.dataset.id); go(viewSettings); },
    del: () => {
      if (!confirm(cloudOn() ? `「${P.name}」をこの端末の一覧から外します。クラウドの記録は消えません（完全に消せるのは管理者だけです）。よろしいですか？`
        : `「${P.name}」の記録をすべて消します。元にもどせません。よろしいですか？`)) return;
      DB.deleted.push(P.id);
      if (!cloudOn()) for (const did of Object.keys(DB.decks)) localStorage.removeItem(PROG_KEY + progId(P.id, did));
      DB.profiles = DB.profiles.filter((p) => p !== P); DB.current = null; P = null; saveLocal(); go(viewProfiles);
    },
    export: () => {
      const prog = {};
      for (const k of Object.keys(localStorage)) if (k.startsWith(PROG_KEY)) { try { prog[k.slice(PROG_KEY.length)] = JSON.parse(localStorage.getItem(k)); } catch { /* */ } }
      const db = { ...DB, family: '' };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'eitango', v: 1, at: new Date().toISOString(), db, prog })], { type: 'application/json' }));
      a.download = `eitango-kiroku-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
    importbk: () => $('#bkfile').click(),
    gen: () => { const a = new Uint32Array(3); crypto.getRandomValues(a); $('#fam').value = [...a].map((x) => x.toString(36).padStart(6, '0').slice(-5)).join('-'); },
    link: async () => {
      const code = $('#fam').value.trim();
      if (code.length < 12) return alert('合言葉は12文字以上にしてください（「自動で作る」も使えます）');
      DB.family = code; saveLocal();
      DB.profiles.forEach((p) => dirty.add('p:' + p.id));
      const ok = await syncNow();
      if (!ok) alert('同期できませんでした: ' + syncMsg);
      for (const d of Object.values(DB.decks)) if (d.local && d.mine) { d.done = false; startUpload(d.id); }
      P = DB.profiles.find((p) => p.id === DB.current) || P;
      go(viewSettings);
    },
    sync: async () => { const ok = await syncNow(); if (!ok && syncMsg) alert('同期できませんでした: ' + syncMsg); go(viewSettings); },
    restore: async () => { DB.deleted = []; saveLocal(); await syncNow(); go(viewSettings); },
    unlink: () => { if (confirm('この端末での同期をやめます。記録は端末にもクラウドにも残ります。')) { DB.family = ''; saveLocal(); go(viewSettings); } },
  });
}
function loadDBFrom(d) {
  d.decks = d.decks || {}; d.hidden = d.hidden || []; d.deleted = d.deleted || []; d.profiles.forEach(fixProfile);
  for (const x of Object.values(d.decks)) x.local = false; // 中身はこの端末にあるか確かめなおす
  return d;
}

// ───────── バージョン・更新履歴 ─────────
function viewAbout() {
  app.innerHTML = `<div class="page narrow">
    <header class="top"><button class="btn back" data-act="back">← もどる</button><h2>バージョン・更新履歴</h2><span></span></header>
    <section class="card"><h3>${esc(APP_NAME)}　v${VERSION}</h3>
      <p class="note">記録の保存先：この端末のブラウザ内${cloudOn() ? '＋クラウド（家族の合言葉の場所）' : ''}。アプリが新しくなっても、記録はそのまま引きつがれます。</p></section>
    ${HISTORY.map(([v, d, items]) => `<section class="card"><h3>v${v}<small>${d}</small></h3><ul class="hist">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`).join('')}
    <section class="card"><h3>ライセンス</h3><ul class="hist">
      <li><a href="https://github.com/open-spaced-repetition/ts-fsrs" target="_blank" rel="noopener">ts-fsrs</a>（MIT License, © Open Spaced Repetition）</li>
      <li><a href="https://github.com/101arrowz/fflate" target="_blank" rel="noopener">fflate</a>・<a href="https://github.com/101arrowz/fzstd" target="_blank" rel="noopener">fzstd</a>（MIT License, © Arjun Barrett）</li>
      <li><a href="https://github.com/sql-js/sql.js" target="_blank" rel="noopener">sql.js</a>（MIT License）・SQLite（パブリックドメイン）</li></ul>
      <p class="note">ライセンスの全文は vendor/ フォルダにあります。単語帳の中身（英文・音声）の権利は、それぞれの教材の作者にあります。</p></section>
  </div>`;
  onAct({ back: () => go(viewSettings) });
}

// ───────── 起動 ─────────
document.addEventListener('gesturestart', (e) => e.preventDefault());
(async function main() {
  audioCfg.sfx = DB.sound !== false;
  // 単語帳の中身がこの端末にあるか確かめる
  for (const d of Object.values(DB.decks)) d.local = !!(await idb.getDeck(d.id).then((x) => !!x).catch(() => false));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) { if (inStudy) pendingReload = true; else location.reload(); } });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  P = DB.profiles.find((p) => p.id === DB.current) || null;
  go(viewProfiles); // 最初はかならず名前を選ぶ
  syncNow().then((ok) => { if (ok && (curView === viewProfiles || curView === viewHome)) go(curView); });
})();
