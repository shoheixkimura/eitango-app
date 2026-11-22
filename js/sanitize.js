// フィールドの HTML を表示用に安全にする。script・イベント属性・リンクなどを取りのぞき、[sound:…] は消す。
const KEEP = new Set(['B', 'I', 'U', 'S', 'EM', 'STRONG', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'DIV', 'SPAN', 'P', 'FONT',
  'RUBY', 'RT', 'RB', 'RP', 'UL', 'OL', 'LI', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'MARK', 'CODE', 'PRE', 'BLOCKQUOTE', 'IMG']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'AUDIO', 'VIDEO', 'SOURCE', 'TEMPLATE', 'NOSCRIPT', 'TITLE']);
const STYLE_OK = /^(color|background-color|font-weight|font-style|text-decoration|text-align)$/;

export const stripSound = (s) => String(s || '').replace(/\[sound:[^\]]*\]/g, '');
export const soundsOf = (s) => [...String(s || '').matchAll(/\[sound:([^\]]+)\]/g)].map((m) => m[1].trim());
export function imagesOf(s) {
  return [...String(s || '').matchAll(/<img[^>]*?src=["']?([^"'>\s]+)/gi)].map((m) => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } });
}
/** 画面に出す文字だけ（推定やプレビュー用） */
export function plainText(s) {
  const t = document.createElement('template');
  t.innerHTML = stripSound(s).replace(/<br\s*\/?>/gi, ' ');
  return (t.content.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * 安全な HTML にする。img は imgUrl(ファイル名) が返す URL に差しかえ（返さなければ消す）。
 * noImg=true なら img を消す（画像は別の場所に出すとき）
 */
export function sanitize(html, imgUrl = () => null, noImg = false) {
  const t = document.createElement('template');
  t.innerHTML = stripSound(html);
  const walk = (node) => {
    for (const el of [...node.childNodes]) {
      if (el.nodeType === 8) { el.remove(); continue; } // コメント
      if (el.nodeType !== 1) continue;
      const tag = el.tagName.toUpperCase();
      if (DROP.has(tag) || (tag === 'IMG' && noImg)) { el.remove(); continue; }
      if (!KEEP.has(tag)) { walk(el); el.replaceWith(...el.childNodes); continue; }
      const src = tag === 'IMG' ? el.getAttribute('src') : null;
      const style = el.getAttribute('style'), color = tag === 'FONT' ? el.getAttribute('color') : null;
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
      if (tag === 'IMG') {
        let nm = src || ''; try { nm = decodeURIComponent(nm); } catch { /* そのまま */ }
        const u = imgUrl(nm);
        if (!u) { el.remove(); continue; }
        el.setAttribute('src', u); el.setAttribute('alt', '');
      }
      if (style) {
        const ok = style.split(';').map((x) => x.split(':')).filter(([k, v]) => k && v && STYLE_OK.test(k.trim().toLowerCase()) && !/url|expression|[<>]/i.test(v))
          .map(([k, v]) => `${k.trim()}:${v.trim()}`).join(';');
        if (ok) el.setAttribute('style', ok);
      }
      if (color && /^#?[\w]+$/.test(color)) el.setAttribute('style', `color:${color}`);
      walk(el);
    }
  };
  walk(t.content);
  const d = document.createElement('div');
  d.appendChild(t.content);
  return d.innerHTML.trim();
}
