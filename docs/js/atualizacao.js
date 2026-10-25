/* Atualização do app (gratuita: GitHub Pages + service worker), igual ao Diário de Treino.
   - O site publica versao.json com a versão atual.
   - O app compara com a própria versão (abaixo). Se houver versão nova, limpa a cópia
     guardada no aparelho e recarrega já com os arquivos novos. Fotos e fila não são apagadas.
   VERSAO e DATA são trocados pelo script tools/versao.mjs a cada publicação. */
window.Atualizacao = (function () {
  'use strict';
  var VERSAO = "1.1.0";
  var DATA = "25/10/2026";

  // compara "1.0.10" com "1.0.9" número a número
  function cmp(a, b) {
    var x = String(a || '0').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var y = String(b || '0').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(x.length, y.length); i++) { var d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  }

  function verificar() {
    if (!navigator.onLine) return Promise.reject(new Error('Sem internet.'));
    return fetch('versao.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('Não consegui ler a versão do servidor (HTTP ' + r.status + ').');
      return r.json();
    }).then(function (info) {
      return { local: VERSAO, remota: info.versao, nova: cmp(info.versao, VERSAO) > 0, info: info };
    });
  }

  // Baixa a versão nova: atualiza o service worker, apaga a cópia antiga e recarrega.
  function aplicar() {
    var p = Promise.resolve();
    if ('serviceWorker' in navigator) {
      p = navigator.serviceWorker.getRegistration().then(function (reg) {
        if (!reg) return;
        return reg.update().catch(function () {}).then(function () { if (reg.waiting) reg.waiting.postMessage('pular-espera'); });
      });
    }
    return p.then(function () {
      if (window.caches) return caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); });
    }).catch(function () {}).then(function () {
      location.replace(location.pathname + '?atualizado=' + Date.now());
    });
  }

  return { VERSAO: VERSAO, DATA: DATA, cmp: cmp, verificar: verificar, aplicar: aplicar };
})();
