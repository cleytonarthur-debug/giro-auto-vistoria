/* Service worker: com internet o app busca a versão mais nova (assim as atualizações chegam
   sozinhas); com sinal ruim ou sem sinal usa a cópia guardada e abre na hora. */
const CACHE = "giro-auto-vistoria-1.1.0";
const SHELL = [
  "./", "index.html", "css/app.css", "fonts/fonts.css", "js/atualizacao.js", "js/app.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "fonts/montserrat-latin-400-normal.woff2", "fonts/montserrat-latin-600-normal.woff2",
  "fonts/montserrat-latin-700-normal.woff2", "fonts/montserrat-latin-800-normal.woff2"
];
const ESPERA_REDE = 3500; // pátio com sinal fraco: depois disso usa a cópia guardada

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("message", e => { if (e.data === "pular-espera") self.skipWaiting(); });

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;        // servidor do Google nunca passa por aqui
  if (url.pathname.endsWith("versao.json")) return;  // sempre da rede
  const guardada = () => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"));
  e.respondWith(new Promise(resolve => {
    let pronto = false;
    const timer = setTimeout(() => { guardada().then(r => { if (r && !pronto) { pronto = true; resolve(r); } }); }, ESPERA_REDE);
    fetch(req, { cache: "no-cache" }).then(res => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
      if (!pronto) { pronto = true; clearTimeout(timer); resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      guardada().then(r => { if (!pronto) { pronto = true; resolve(r || Response.error()); } });
    });
  }));
});
