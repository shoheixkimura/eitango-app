// FSRS（ts-fsrs）で復習を管理する。カードの状態は短いキーで小さく保存する。
import { fsrs, generatorParameters, createEmptyCard, Rating, State } from '../vendor/ts-fsrs.mjs';
import { today, now as nowMs, endOfDay } from './dates.js';

export { Rating, State };
export const RETENTION = 0.9;          // 目標の記憶率（固定）
export const MATURE_DAYS = 21;         // 次の復習まで21日以上 →「定着」
const PARAMS = {
  request_retention: RETENTION,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],       // 新しいカードの学習ステップ
  relearning_steps: ['10m'],           // 忘れたカードの再学習ステップ
  maximum_interval: 36500,
};
const schedulers = {};
/** fuzz=false はテスト用（毎回同じ結果になる） */
export function scheduler(fuzz = true) {
  return schedulers[fuzz] || (schedulers[fuzz] = fsrs(generatorParameters({ ...PARAMS, enable_fuzz: fuzz })));
}

// ───────── 保存の形 ─────────
// { d: 次の期限(分), s: 安定度, f: 難しさ, t: 状態(0新/1学習/2復習/3再学習), r: 復習回数, l: 忘れた回数,
//   sd: 予定の間隔(日), ls: 学習ステップの位置, lr: 最後に答えた時刻(分) }
const MIN = 60000;
const r3 = (x) => Math.round(x * 1000) / 1000;
export function pack(c) {
  const o = { d: Math.round(+c.due / MIN), s: r3(c.stability), f: r3(c.difficulty), t: c.state, r: c.reps, l: c.lapses, sd: c.scheduled_days };
  if (c.learning_steps) o.ls = c.learning_steps;
  if (c.last_review) o.lr = Math.round(+c.last_review / MIN);
  return o;
}
export function unpack(o, at = nowMs()) {
  if (!o) return createEmptyCard(new Date(at));
  const lr = o.lr ? new Date(o.lr * MIN) : undefined;
  return {
    due: new Date(o.d * MIN), stability: o.s, difficulty: o.f, state: o.t, reps: o.r, lapses: o.l,
    scheduled_days: o.sd || 0, learning_steps: o.ls || 0, last_review: lr,
    elapsed_days: lr ? Math.max(0, Math.floor((at - +lr) / 86400000)) : 0,
  };
}

/** 4つのボタンそれぞれを押したときの次の状態 */
export function preview(packed, at = nowMs(), fuzz = true) {
  const rec = scheduler(fuzz).repeat(unpack(packed, at), new Date(at));
  const out = {};
  for (const g of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) out[g] = rec[g].card;
  return out;
}
/** 評価して次の状態（保存の形）を返す */
export function rate(packed, grade, at = nowMs(), fuzz = true) {
  const { card } = scheduler(fuzz).next(unpack(packed, at), new Date(at), grade);
  return pack(card);
}

/** 次に出るまでの目安：「1分」「10分」「3日」「2か月」 */
export function ivlLabel(dueMs, at = nowMs()) {
  const m = Math.max(1, Math.round((dueMs - at) / MIN));
  if (m < 60) return m + '分';
  const h = m / 60;
  if (h < 24) return Math.round(h) + '時間';
  const d = Math.round(h / 24);
  if (d < 31) return d + '日';
  if (d < 365) return Math.round(d / 30) + 'か月';
  return Math.round((d / 365) * 10) / 10 + '年';
}

// ───────── 今日の出題 ─────────
/** その日に新しく始めたカードの数・追加した枠 */
export function newInfo(prog, d = today()) { return (prog.nd && prog.nd[d]) || { n: 0, x: 0 }; }
export function newLimit(profile, prog, d = today()) {
  const i = newInfo(prog, d);
  return Math.max(0, (profile.newPerDay || 10) + (i.x || 0) - (i.n || 0));
}
/**
 * 今日の残り。order はノートの順番（guid の配列）。
 * review＝期限がきた復習、learn＝学習中（ステップの途中）、fresh＝今日やる新しいカード
 */
export function dayQueue(order, prog, profile, at = nowMs(), d = today()) {
  const eod = endOfDay(d) / MIN, c = prog.c || {};
  const review = [], learn = [], fresh = [];
  let lim = newLimit(profile, prog, d);
  for (const g of order) {
    const x = c[g];
    if (!x || x.t === State.New) { if (lim > 0) { fresh.push(g); lim--; } continue; }
    if (x.d >= eod) continue;
    (x.t === State.Review ? review : learn).push(g);
  }
  const byDue = (a, b) => c[a].d - c[b].d;
  review.sort(byDue); learn.sort(byDue);
  return { review, learn, fresh, total: review.length + learn.length + fresh.length };
}
/**
 * 次に出すカード。期限のきた学習中カード → 復習と新しいカードをまぜて（新しいカードは3枚に1枚）→
 * 残りが学習中だけなら、いちばん早く期限がくるものを先に出す。
 */
export function pickNext(q, prog, answeredToday, at = nowMs(), last = null) {
  const c = prog.c || {}, nowM = at / MIN;
  const dueLearn = q.learn.filter((g) => c[g].d <= nowM && g !== last);
  if (dueLearn.length) return dueLearn[0];
  const rv = q.review.filter((g) => g !== last), fr = q.fresh.filter((g) => g !== last);
  if (rv.length && fr.length) return answeredToday % 3 === 2 ? fr[0] : rv[0];
  if (rv.length) return rv[0];
  if (fr.length) return fr[0];
  const ahead = q.learn.filter((g) => g !== last);
  if (ahead.length) return ahead[0];
  return q.total ? (q.learn[0] || q.review[0] || q.fresh[0]) : null;
}

/** 単語帳ごとのまとめ：定着(m)・学習中(l)・未学習(u) */
export function summarize(order, prog) {
  const c = prog.c || {}, s = { m: 0, l: 0, u: 0, t: order.length };
  for (const g of order) {
    const x = c[g];
    if (!x || x.t === State.New) s.u++;
    else if (x.t === State.Review && (x.sd || 0) >= MATURE_DAYS) s.m++;
    else s.l++;
  }
  return s;
}
