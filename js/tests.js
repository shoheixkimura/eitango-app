// ブラウザで動く小さなテスト。tests.html をひらくと実行される。
import { setDebugDate, today, now, weekStart, addDays, endOfDay } from './dates.js';
import { Rating, State, pack, unpack, rate, preview, ivlLabel, dayQueue, pickNext, summarize, newLimit, scheduler, isRetired, setRetired, retiredList, hasNewLeft } from './srs.js';
import { streak, weekN, lastWeekN, lastWeekSoFarN, ranking, gapToNext, mergeProfile, mergeProgress, pickCard } from './records.js';
import { guessMap } from './importer.js';
import { wordKey, parseExtFile, matchCount, isExtDoc } from './extras.js';
import { sanitize, plainText, soundsOf } from './sanitize.js';

const out = document.getElementById('out');
let pass = 0, fail = 0, sec = null;
const group = (name) => { sec = document.createElement('ul'); out.insertAdjacentHTML('beforeend', `<h2>${name}</h2>`); out.appendChild(sec); };
function ok(cond, name, info = '') {
  const li = document.createElement('li');
  li.className = cond ? 'ok' : 'ng';
  li.textContent = `${cond ? '✔' : '✘'} ${name}${!cond && info ? '  →  ' + info : ''}`;
  sec.appendChild(li);
  cond ? pass++ : fail++;
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `期待 ${JSON.stringify(b)} / 実際 ${JSON.stringify(a)}`);
const at = (s, h = 9, m = 0) => { const [y, mo, d] = s.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const MIN = 60000, DAY = 86400000;

try {
  group('日付と週（端末の現地時間・月曜0時に切りかわり）');
  setDebugDate('2026-12-02'); // 水曜
  eq(today(), '2026-12-02', '?date= で「今日」が変わる');
  ok(new Date(now()).getDate() === 2, 'now() もその日になる');
  eq(weekStart('2026-12-02'), '2026-11-30', '水曜 → その週の月曜');
  eq(weekStart('2026-11-30'), '2026-11-30', '月曜 → その日');
  eq(weekStart('2026-12-06'), '2026-11-30', '日曜 → 前の月曜（週の最後）');
  eq(weekStart('2026-12-07'), '2026-12-07', '次の月曜で切りかわる');
  eq(addDays('2026-12-31', 1), '2027-01-01', '年をまたぐ');
  eq(weekStart('2027-01-01'), '2026-12-28', '年をまたぐ週');
  ok(endOfDay('2026-12-02') === new Date(2026, 11, 3).getTime(), 'その日の終わり＝翌日0時');

  group('連続日数と今週の数');
  const p = { log: { '2026-11-29': { n: 5, fin: 1 }, '2026-11-30': { n: 12, fin: 1 }, '2026-12-01': { n: 8, fin: 1 }, '2026-12-02': { n: 3 }, '2026-11-24': { n: 20, fin: 1 }, '2026-11-25': { n: 7 } } };
  eq(streak(p, '2026-12-02'), 3, '今日まだ終えていなくても、昨日まで続いていれば数を消さない');
  p.log['2026-12-02'].fin = 1;
  eq(streak(p, '2026-12-02'), 4, '今日終えたら +1');
  eq(streak(p, '2026-12-04'), 0, '1日あいたら 0');
  eq(weekN(p, '2026-12-02'), 23, '今週（月〜今日）の回答数');
  eq(lastWeekN(p, '2026-12-02'), 32, '先週（月〜日）の回答数');
  eq(lastWeekSoFarN(p, '2026-12-02'), 27, '先週の同じ曜日までの回答数');
  eq(weekN(p, '2026-12-07'), 0, '月曜になると今週は0から（リセット処理なし）');
  const fam = [{ name: 'A', log: { '2026-12-01': { n: 30 } } }, { name: 'B', log: { '2026-12-01': { n: 12 } } }, { name: 'C', log: {} }];
  const R = ranking(fam, '2026-12-02');
  eq(R.map((r) => r.p.name), ['A', 'B', 'C'], 'ランキングは今週の数の順');
  eq(gapToNext(R, 1), 19, '「あと◯枚で抜ける」＝差＋1');
  eq(gapToNext(R, 0), 0, '1位は0');

  group('FSRS（目標の記憶率 0.9・学習ステップ 1分/10分）');
  const t0 = at('2026-12-02');
  const pv = preview(null, t0, false);
  eq(Math.round((+pv[Rating.Again].due - t0) / MIN), 1, '新しいカード「もう一度」→ 1分後');
  eq(Math.round((+pv[Rating.Good].due - t0) / MIN), 10, '新しいカード「できた」→ 10分後');
  ok(+pv[Rating.Easy].due - t0 >= DAY, '新しいカード「かんたん」→ 1日以上先', ivlLabel(+pv[Rating.Easy].due, t0));
  let c = rate(null, Rating.Good, t0, false);
  eq(c.t, State.Learning, '1回目の「できた」は学習中');
  c = rate(c, Rating.Good, t0 + 10 * MIN, false);
  eq(c.t, State.Review, '10分後にもう一度「できた」で復習に進む');
  const d1 = c.sd;
  ok(d1 >= 1, '復習の間隔は1日以上', d1);
  const c2 = rate(c, Rating.Good, c.d * MIN, false);
  ok(c2.sd > d1, '期限どおりに「できた」で間隔がのびる', `${d1} → ${c2.sd}`);
  const lapse = rate(c2, Rating.Again, c2.d * MIN, false);
  eq(lapse.t, State.Relearning, '復習で「もう一度」→ 再学習');
  eq(lapse.l, 1, '忘れた回数 +1');
  eq(Math.round(lapse.d - c2.d), 10, '再学習は10分後');
  const rt = pack(unpack(c2, c2.d * MIN));
  eq(rt, c2, '保存の形 → 戻す → 保存の形 で同じ');
  ok(scheduler(false).parameters.request_retention === 0.9, '目標の記憶率は 0.9');
  eq([ivlLabel(t0 + 10 * MIN, t0), ivlLabel(t0 + 3 * DAY, t0), ivlLabel(t0 + 62 * DAY, t0), ivlLabel(t0 + 5 * 3600000, t0)], ['10分', '3日', '2か月', '5時間'], '次に出る日の目安');

  group('今日の出題');
  const order = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
  const prof = { newPerDay: 3 };
  const eodM = endOfDay('2026-12-02') / MIN;
  const prog = { c: { g2: { t: 2, d: eodM - 600, r: 3, sd: 5 }, g4: { t: 2, d: eodM + 10, r: 2, sd: 4 }, g5: { t: 1, d: t0 / MIN + 5, r: 1 } }, nd: {} };
  let q = dayQueue(order, prog, prof, t0, '2026-12-02');
  eq(q.review, ['g2'], '期限が今日の復習だけ（明日の分は出ない）');
  eq(q.learn, ['g5'], '学習中のカード');
  eq(q.fresh, ['g1', 'g3', 'g6'], '新しいカードは元の順番で1日の枚数まで');
  prog.nd['2026-12-02'] = { n: 2, x: 0 };
  eq(dayQueue(order, prog, prof, t0, '2026-12-02').fresh, ['g1'], '今日すでに始めた分を引く');
  prog.nd['2026-12-02'].x = 10;
  eq(newLimit(prof, prog, '2026-12-02'), 11, '「あと10枚」で枠がふえる');
  q = dayQueue(order, prog, prof, t0, '2026-12-02');
  eq(pickNext(q, prog, 0, t0 + 10 * MIN), 'g5', '期限のきた学習中カードを先に');
  eq(pickNext(q, prog, 0, t0), 'g2', '学習中の期限前は復習を先に');
  eq(pickNext(q, prog, 2, t0), 'g1', '3枚に1枚は新しいカード');
  eq(pickNext({ review: [], fresh: [], learn: ['g5'], total: 1 }, prog, 0, t0), 'g5', '残りが学習中だけなら、期限前でも出す');
  eq(summarize(order, { c: { g1: { t: 2, sd: 30 }, g2: { t: 2, sd: 3 }, g3: { t: 3, sd: 40 } } }), { m: 1, l: 2, u: 3, x: 0, t: 6 }, '定着（21日以上）・学習中・未学習');

  group('卒業（もう出さないカード）');
  const pr = { c: { g2: { t: 2, d: eodM - 600, r: 3, sd: 30 }, g5: { t: 1, d: t0 / MIN + 5, r: 1 } }, nd: {} };
  setRetired(pr, 'g2', true, 100); setRetired(pr, 'g1', true, 100);
  let qx = dayQueue(order, pr, prof, t0, '2026-12-02');
  ok(!qx.review.includes('g2') && !qx.fresh.includes('g1'), '卒業したカードは復習にも新しいカードにも出ない', JSON.stringify(qx));
  eq(qx.fresh, ['g3', 'g4', 'g6'], '新しいカードは次のカードがくり上がる');
  eq(summarize(order, pr), { m: 0, l: 1, u: 3, x: 2, t: 6 }, 'まとめでは「卒業」として数える');
  eq(retiredList(order, pr), ['g1', 'g2'], '卒業したカードの一覧');
  ok(pr.c.g2.r === 3, '卒業しても FSRS の記録は残る');
  setRetired(pr, 'g2', false, 200);
  ok(!isRetired(pr, 'g2') && dayQueue(order, pr, prof, t0, '2026-12-02').review.includes('g2'), '戻すと、前の記録のまま復習に出る');
  ok(!hasNewLeft(['g1', 'g2'], { c: { g2: { t: 2 } }, x: { g1: { v: 1, at: 1 } } }), '残りの新しいカードが卒業だけなら「新しいカードはない」');
  const xa = { id: 'x', upd: 5, c: {}, nd: {}, x: { g1: { v: 1, at: 100 }, g2: { v: 1, at: 100 } } };
  const xb = { id: 'x', upd: 1, c: {}, nd: {}, x: { g1: { v: 0, at: 300 }, g3: { v: 1, at: 50 } } };
  const xm = mergeProgress(xa, xb);
  eq(xm.x, { g1: { v: 0, at: 300 }, g2: { v: 1, at: 100 }, g3: { v: 1, at: 50 } }, '2台の合流：カードごとにあとで変えたほう（戻したのが後なら戻す）');
  const sk = (o) => Object.keys(o).sort().map((k) => [k, o[k]]);
  eq(sk(mergeProgress(xb, xa).x), sk(xm.x), '順番を入れかえても同じ結果');

  group('2台の記録の合流');
  eq(pickCard({ r: 3, lr: 100 }, { r: 5, lr: 50 }), { r: 5, lr: 50 }, '復習回数が多いほう');
  eq(pickCard({ r: 3, lr: 100 }, { r: 3, lr: 200 }), { r: 3, lr: 200 }, '同じなら新しいほう');
  const a = { id: 'p1', name: '旧', upd: 1, log: { '2026-12-01': { n: 5, fin: 1 }, '2026-12-02': { n: 2 } }, sum: { d1: { m: 1, at: 5 } } };
  const b = { id: 'p1', name: '新', upd: 2, log: { '2026-12-01': { n: 3 }, '2026-12-02': { n: 7 } }, sum: { d1: { m: 3, at: 9 } } };
  const m = mergeProfile(a, b);
  eq(m.name, '新', '名前や設定は新しいほう');
  eq(m.log, { '2026-12-01': { n: 5, fin: 1 }, '2026-12-02': { n: 7 } }, '日ごとの回答数は多いほう・終えた印はどちらかにあれば');
  eq(m.sum.d1.m, 3, '単語帳のまとめは新しいほう');
  eq(mergeProfile(b, a).log, m.log, '順番を入れかえても同じ結果');
  const pa = { id: 'x', upd: 1, c: { g1: { r: 2, lr: 10 }, g2: { r: 1, lr: 5 } }, nd: { '2026-12-02': { n: 3, x: 0 } } };
  const pb = { id: 'x', upd: 2, c: { g1: { r: 1, lr: 20 }, g3: { r: 1, lr: 7 } }, nd: { '2026-12-02': { n: 1, x: 10 } } };
  const mp = mergeProgress(pa, pb);
  eq(Object.keys(mp.c).sort(), ['g1', 'g2', 'g3'], 'どちらかで答えたカードはすべて残る');
  eq(mp.c.g1.r, 2, 'カードごとに復習回数が多いほう');
  eq(mp.nd['2026-12-02'], { n: 3, x: 10 }, 'その日に始めた数・追加した枠は多いほう');

  group('やさしい説明・語源');
  eq([wordKey('wrap up ～'), wordKey('<b>Veteran</b>'), wordKey('  look  into ')], ['wrap up', 'veteran', 'look into'], '単語の見出しをそろえる');
  const items = parseExtFile(JSON.stringify({ items: { Juror: ['裁判で話し合う人', 'jur(法)+-or(人)'], empty: ['', ''] } }));
  eq(items, { juror: ['裁判で話し合う人', 'jur(法)+-or(人)'] }, '説明ファイルを読む（空のものは入れない）');
  eq(parseExtFile(JSON.stringify([{ word: 'jury', easy: 'a', ety: '' }])), { jury: ['a', ''] }, '配列の形も読める');
  eq(matchCount(['juror', 'jury', 'JUROR'], items), 2, '単語帳と合う数');
  ok(isExtDoc({ id: 'xd123', kind: 'ext' }) && !isExtDoc({ id: 'd123' }), '説明の目印は単語帳の一覧に入れない');

  group('取り込み（フィールドの推定・安全な表示）');
  const notes = [{ f: ['I like apples.', 'りんごが好きです。', '[sound:a.mp3]', '<img src="x.png">'] }, { f: ['See you.', 'またね。', '[sound:b.mp3]', ''] }];
  eq(guessMap(['A', 'B', 'C', 'D'], notes), { en: 0, ja: 1, snd: 2, img: 3, pos: -1, ex: -1, exja: -1, snd2: -1 }, '英文・和訳・音声・画像を推定');
  eq(guessMap(['Front', 'Back'], [{ f: ['犬', 'dog'] }]), { en: 1, ja: 0, snd: -1, img: -1, pos: -1, ex: -1, exja: -1, snd2: -1 }, '和訳が表のデータでも、英語を表にする');
  const wn = [{ f: ['p1q5_0001', 'last', '動詞', '続く、継続する', 'The meeting only lasted a few minutes.', '話し合いは数分だけ続いた。', '[sound:w1.mp3]', '[sound:s1.mp3]'] }];
  eq(guessMap(['ID', '単語', '品詞', '意味', '例文', '例文意味', '単語音声', '例文音声'], wn), { en: 1, ja: 3, snd: 6, img: -1, pos: 2, ex: 4, exja: 5, snd2: 7 }, '単語帳（ID・単語・品詞・意味・例文・例文意味・単語音声・例文音声）をフィールド名から推定');
  eq(guessMap(['Front', 'Back', 'Sound'], [{ f: ['I like it.', '好きです。', '[sound:a.mp3]'] }]), { en: 0, ja: 1, snd: 2, img: -1, pos: -1, ex: -1, exja: -1, snd2: -1 }, 'DUO の形（Front・Back・Sound）');
  const html = sanitize('<b>Hi</b><script>alert(1)</script><img src="x.png" onerror="alert(2)"><a href="javascript:x">link</a>[sound:a.mp3]', (n) => (n === 'x.png' ? 'blob:ok' : null));
  ok(!/script|onerror|javascript|sound/.test(html), 'script・イベント属性・リンク・[sound:] を取りのぞく', html);
  ok(html.includes('<b>Hi</b>') && html.includes('src="blob:ok"') && html.includes('link'), '文字・太字・画像は残る', html);
  eq(plainText('A<br>B [sound:x.mp3]'), 'A B', '表示用の文字');
  eq(soundsOf('x[sound:a b.mp3]y[sound:c.mp3]'), ['a b.mp3', 'c.mp3'], '[sound:] のファイル名');
} catch (e) {
  group('エラー'); ok(false, e.message, e.stack);
} finally {
  setDebugDate(null);
}
document.getElementById('sum').innerHTML = fail ? `<span class="ng">✘ ${fail}件 失敗</span>（${pass}件 成功）` : `<span class="ok">✔ ${pass}件 すべて成功</span>`;
window.__TEST__ = { pass, fail };
