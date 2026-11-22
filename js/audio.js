// 音声と効果音。iPhone/iPad では、画面にさわった瞬間にしか音を使える状態にできないので、
// さわるたびに AudioContext を起こし、止まっていたら作り直す（漢字アプリと同じ工夫）。
export const audioCfg = { sfx: true };

let AC = null, broken = false, lastCT = -1, stuck = 0, src = null, el = null;
const decoded = new Map(); // key → AudioBuffer（最近のものだけ）

function make() {
  try { if (AC) AC.close().catch(() => {}); } catch { /* 既に閉じている */ }
  AC = new (window.AudioContext || window.webkitAudioContext)();
  broken = false; stuck = 0; lastCT = -1; decoded.clear();
  AC.onstatechange = () => { if (AC && AC.state === 'interrupted') broken = true; };
  // 無音を1回鳴らして「この画面は音を出す」と知らせる
  try { const b = AC.createBufferSource(); b.buffer = AC.createBuffer(1, 1, 22050); b.connect(AC.destination); b.start(0); } catch { /* */ }
}
/** 画面にさわるたびに呼ぶ。止まっていたら再開、こわれていたら作り直す */
export function ensureAudio(gesture = true) {
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch { /* 非対応 */ }
  try {
    if (!AC || AC.state === 'closed' || (broken && gesture)) make();
    if (AC.state !== 'running') AC.resume().catch(() => { broken = true; });
  } catch { /* 音が出せない環境 */ }
}
/** 「音をなおす」：むりやり作り直してテストの音を鳴らす（さわった中で呼ぶ） */
export function resetAudio() { broken = true; ensureAudio(true); const w = audioCfg.sfx; audioCfg.sfx = true; tone([[660, 0.1], [880, 0.16]]); audioCfg.sfx = w; }
for (const t of ['pointerdown', 'touchend', 'click', 'keydown']) document.addEventListener(t, () => ensureAudio(true), true);
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); stopVoice(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 1000) broken = true;
  if (AC && AC.state !== 'running') AC.resume().catch(() => { broken = true; });
});
window.addEventListener('pageshow', (e) => { if (e.persisted) broken = true; });
setInterval(() => {
  if (!AC || document.visibilityState !== 'visible') return;
  if (AC.state === 'running') {
    // 何か鳴っているはずなのに時計が進まない →「こわれた」。次にさわったとき作り直す
    if (src && AC.currentTime === lastCT) { if (++stuck >= 2) broken = true; } else stuck = 0;
    lastCT = AC.currentTime;
  } else if (AC.state === 'interrupted') broken = true;
  else if (AC.state === 'suspended') AC.resume().catch(() => { broken = true; });
}, 1500);

/** 音声ファイルを先に読んでおく（getBytes は ArrayBuffer を返す関数） */
export async function preload(k, getBytes) {
  if (!AC) return null;
  if (decoded.has(k)) return decoded.get(k);
  const bytes = await getBytes();
  if (!bytes) return null;
  const ctx = AC;
  const buf = await new Promise((res, rej) => ctx.decodeAudioData(bytes.slice(0), res, rej)).catch(() => null);
  if (!buf || ctx !== AC) return null;
  decoded.set(k, buf);
  while (decoded.size > 8) decoded.delete(decoded.keys().next().value);
  return buf;
}
export function stopVoice() {
  try { if (src) src.stop(); } catch { /* 止まっている */ }
  src = null;
  if (el) { el.pause(); el = null; }
}
/** 音声を鳴らす。鳴らせたら true */
export async function playVoice(k, getBytes, type = 'audio/mpeg') {
  stopVoice();
  ensureAudio(false);
  try {
    const buf = await preload(k, getBytes);
    if (buf && AC && AC.state === 'running') {
      const s = AC.createBufferSource(); s.buffer = buf; s.connect(AC.destination); s.start(0);
      src = s; s.onended = () => { if (src === s) src = null; };
      return true;
    }
  } catch { /* 下の方法で */ }
  // Web Audio で鳴らせないときは audio 要素で
  try {
    const bytes = await getBytes();
    if (!bytes) return false;
    const u = URL.createObjectURL(new Blob([bytes], { type }));
    el = new Audio(u); el.onended = () => URL.revokeObjectURL(u);
    await el.play();
    return true;
  } catch { return false; }
}

function note(f, t, d, type, vol) {
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(AC.destination); o.start(t); o.stop(t + d + 0.02);
}
/** 効果音：[[周波数, 長さ秒], …] を順に鳴らす */
export function tone(seq, type = 'sine', vol = 0.12) {
  if (!audioCfg.sfx) return;
  try {
    ensureAudio(false);
    let t = AC.currentTime + 0.005;
    for (const [f, d] of seq) { note(f, t, d, type, vol); t += d * 0.7; }
  } catch { /* 音が出せない環境 */ }
}
