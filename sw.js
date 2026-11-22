// オフラインでも動くように。ネット優先（毎回サーバーに新しい版がないか確かめる）・だめならキャッシュ。
// 単語帳の中身（英文・音声）はここには入れない（IndexedDB に入れる）。
const CACHE = 'eitango-v1.0.0';
const FILES = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png',
  'js/app.js', 'js/config.js', 'js/dates.js', 'js/srs.js', 'js/records.js', 'js/idb.js', 'js/sanitize.js', 'js/importer.js', 'js/anki-worker.js',
  'js/audio.js', 'js/cloud.js', 'js/cloud-config.js', 'js/share.js',
  'vendor/ts-fsrs.mjs', 'vendor/fflate.umd.js', 'vendor/fzstd.umd.js', 'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k.startsWith('eitango-')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return; // Firestore・Storage はそのまま通す
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
