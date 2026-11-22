// 日付はすべて端末の現地時間で扱う。?date=2026-12-01 で「今日」を変えて試せる（時刻は今の時刻のまま）。
const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
let dbgDate = /^\d{4}-\d{2}-\d{2}$/.test(qs.get('date') || '') ? qs.get('date') : null;

export const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return fmt(d); };
export const dayDiff = (a, b) => Math.round((parseD(a) - parseD(b)) / 86400000);
export const isDebugDate = () => !!dbgDate;
/** テスト用：「今日」を差しかえる（null で元にもどす） */
export function setDebugDate(s) { dbgDate = s; }

/** 今の時刻（ミリ秒）。?date= のときは、その日の今の時刻 */
export function now() {
  if (!dbgDate) return Date.now();
  const n = new Date(), d = parseD(dbgDate);
  d.setHours(n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds());
  return d.getTime();
}
export const today = () => fmt(new Date(now()));
/** その日の終わり（翌日0時のミリ秒） */
export function endOfDay(s = today()) { const d = parseD(s); d.setDate(d.getDate() + 1); return d.getTime(); }
/** その日をふくむ週の月曜日 */
export function weekStart(s = today()) {
  const d = parseD(s), wd = (d.getDay() + 6) % 7; // 月=0 … 日=6
  d.setDate(d.getDate() - wd);
  return fmt(d);
}
/** 日付から日数のぶんだけの配列 [from, from+1, …] */
export function range(from, n) { const a = []; for (let i = 0; i < n; i++) a.push(addDays(from, i)); return a; }
