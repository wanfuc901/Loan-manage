// Service worker: mở web nhanh và dùng được khi mạng yếu.
// - Tệp của web (cùng nguồn): lấy bản mới từ mạng trước, mất mạng thì dùng bản đã lưu.
// - Thư viện CDN có ghi rõ phiên bản (không bao giờ đổi): dùng bản đã lưu, chưa có thì tải về.
// API (GitHub, Groq, Claude) không đi qua bộ nhớ đệm.
const CACHE = "skv-v2";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest", "icons/icon.svg",
  "js/app.js", "js/store.js", "js/extract.js", "js/parse.js", "js/loan.js", "js/crypto.js",
];
const CDN_HOSTS = ["cdn.jsdelivr.net"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
    );
    return;
  }

  if (CDN_HOSTS.includes(url.hostname) && /@\d+\.\d+\.\d+/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});
