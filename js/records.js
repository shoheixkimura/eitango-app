// 記録の集計（今週の数・連続日数）と、2台の記録の合流。
import { today, addDays, weekStart, dayDiff } from './dates.js';

/** その日の回答数 */
export const dayN = (p, d) => ((p.log || {})[d] || {}).n || 0;
/** 期間 [from, to] の回答数の合計 */
export function sumN(p, from, to) {
  let n = 0;
  for (const [d, L] of Object.entries(p.log || {})) if (d >= from && d <= to) n += L.n || 0;
  return n;
}
/** 今週（月曜0時から）の回答数 */
export const weekN = (p, d = today()) => sumN(p, weekStart(d), d);
/** 先週（月〜日）の回答数 */
export function lastWeekN(p, d = today()) { const ws = weekStart(d); return sumN(p, addDays(ws, -7), addDays(ws, -1)); }
/** 先週の、今日と同じ曜日までの回答数 */
export function lastWeekSoFarN(p, d = today()) { const ws = weekStart(d); return sumN(p, addDays(ws, -7), addDays(d, -7)); }

/** 連続学習日数：その日の分を終えた日（fin）が続いた日数。今日まだでも、昨日まで続いていれば数える */
export function streak(p, d = today()) {
  const log = p.log || {};
  if (!(log[d] && log[d].fin)) d = addDays(d, -1);
  let n = 0;
  while (log[d] && log[d].fin) { n++; d = addDays(d, -1); }
  return n;
}
/** 今週のランキング：今週の数 → 連続日数 → 名前 の順 */
export function ranking(profiles, d = today()) {
  return profiles.map((p) => ({ p, week: weekN(p, d), streak: streak(p, d), last: lastWeekN(p, d), lastSoFar: lastWeekSoFarN(p, d) }))
    .sort((a, b) => b.week - a.week || b.streak - a.streak || String(a.p.name).localeCompare(String(b.p.name)));
}
/** すぐ上の人を抜くのに必要な枚数（自分が1位なら 0） */
export function gapToNext(R, i) {
  if (i <= 0) return 0;
  return R[i - 1].week - R[i].week + 1;
}

// ───────── 合流 ─────────
const keysOf = (x, y) => new Set([...Object.keys(x || {}), ...Object.keys(y || {})]);
/** カードは「復習回数が多いほう、同じなら最後に答えたのが新しいほう」 */
export function pickCard(a, b) {
  if (!a) return b; if (!b) return a;
  if ((a.r || 0) !== (b.r || 0)) return (a.r || 0) > (b.r || 0) ? a : b;
  return (a.lr || 0) >= (b.lr || 0) ? a : b;
}
/** 人の記録（名前・設定・日ごとの回答数）を合流させる。日ごとの回答数は多いほう、終えた印はどちらかにあれば */
export function mergeProfile(a, b) {
  const newer = (a.upd || 0) >= (b.upd || 0) ? a : b;
  const m = { ...newer, log: {}, sum: { ...(b.sum || {}), ...(a.sum || {}) } };
  for (const d of keysOf(a.log, b.log)) {
    const x = (a.log || {})[d], y = (b.log || {})[d];
    const w = !x ? y : !y ? x : (x.n || 0) >= (y.n || 0) ? x : y;
    m.log[d] = { n: w.n || 0 };
    if ((x && x.fin) || (y && y.fin)) m.log[d].fin = 1;
  }
  // 単語帳ごとのまとめは、その単語帳の記録が新しいほう
  for (const k of keysOf(a.sum, b.sum)) {
    const x = (a.sum || {})[k], y = (b.sum || {})[k];
    m.sum[k] = !x ? y : !y ? x : (x.at || 0) >= (y.at || 0) ? x : y;
  }
  return m;
}
/** 単語帳ごとの記録（各カードの FSRS の状態・その日に始めた新しいカードの数）を合流させる */
export function mergeProgress(a, b) {
  const m = { ...((a.upd || 0) >= (b.upd || 0) ? a : b), c: {}, nd: {} };
  for (const g of keysOf(a.c, b.c)) m.c[g] = pickCard((a.c || {})[g], (b.c || {})[g]);
  for (const d of keysOf(a.nd, b.nd)) {
    const x = (a.nd || {})[d] || {}, y = (b.nd || {})[d] || {};
    m.nd[d] = { n: Math.max(x.n || 0, y.n || 0), x: Math.max(x.x || 0, y.x || 0) };
  }
  m.upd = Math.max(a.upd || 0, b.upd || 0);
  return m;
}
/** 古い「その日に始めた数」は14日分だけ残す */
export function trimProgress(prog, d = today()) {
  for (const k of Object.keys(prog.nd || {})) if (dayDiff(d, k) > 14) delete prog.nd[k];
  return prog;
}
