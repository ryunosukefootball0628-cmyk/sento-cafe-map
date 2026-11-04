// 電波の弱い場所でもアプリを開けるよう、画面のファイルをキャッシュしておく Service Worker
// 置くファイルを増やしたり減らしたりしたら、CACHE_NAME の番号を上げる（古いキャッシュが消える）
const CACHE_NAME = 'sento-cafe-map-v2';
// 同期に使う Firebase（バージョンは sync.js と同じ）
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
const APP_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'storage.js',
  'image.js',
  'backup.js',
  'sync.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  `${FIREBASE_SDK}/firebase-app.js`,
  `${FIREBASE_SDK}/firebase-auth.js`,
  `${FIREBASE_SDK}/firebase-firestore.js`,
];
// ネットが遅いとき、キャッシュに切り替えるまで待つ時間（ミリ秒）
const NETWORK_TIMEOUT = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// まずネットから最新を取り、つながらないときや遅いときはキャッシュを使う
// （直したファイルが、ネットにつながっていればすぐ反映されるように）
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT);
      }),
    ]);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) {
      return cached;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  // 地図タイルはここでは扱わない（OSMの利用規約に合わせ、ブラウザの通常のキャッシュに任せる）
  // /__/ はログインの画面など Firebase Hosting が用意するページなので、キャッシュしない
  if (url.origin === self.location.origin && !url.pathname.startsWith('/__/')) {
    event.respondWith(networkFirst(request));
  } else if (url.hostname === 'unpkg.com' || url.href.startsWith(FIREBASE_SDK)) {
    // Leaflet と Firebase はバージョンを固定しているので、キャッシュがあればそれを使う
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
  }
});
