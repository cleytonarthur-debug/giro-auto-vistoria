/* aceite.js — página do cliente da locação. Feita para ser rápida: o cliente acompanhou o checklist ao vivo,
   então aqui ele confere o resumo e as avarias, aceita os termos e assina em tela cheia (com a S Pen ou o dedo).
   Só funciona com o código da entrega que vem no link (#t=…&api=…). */
(function () {
  'use strict';
  var app = document.getElementById('app'), zoom = document.getElementById('zoom');
  var q = new URLSearchParams(location.hash.replace(/^#/, ''));
  var T = q.get('t'), API = q.get('api');
  var D = null, enviando = false, assinatura = '';   // assinatura = PNG pronto (data URL)

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }

  function rpc(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return fetch(API, {
      method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ t: T, fn: fn, args: args })
    }).then(function (r) { return r.text(); }, function () { throw new Error('Sem conexão. Confira a internet e tente de novo.'); })
      .then(function (txt) {
        var d = null; try { d = JSON.parse(txt); } catch (e) { /* não é JSON */ }
        if (!d) throw new Error('O servidor não respondeu direito. Tente de novo em instantes.');
        if (!d.ok) throw new Error(d.message || 'Erro');
        return d.r;
      });
  }

  function erro(msg) {
    app.innerHTML = '<header class="topo"><div class="marca">Termo de entrega do veículo</div></header>' +
      '<main><div class="card"><h1 class="nome">Não foi possível abrir</h1><p class="como">' + esc(msg) + '</p>' +
      '<button class="btn pri" onclick="location.reload()">Tentar de novo</button></div></main>';
  }

  function cardItem(it) {
    var cor = it.estado === 'Avaria' ? 'c-at' : it.estado === 'Não tem' ? 'c-2' : 'c-ok';
    return '<div class="card item"><div class="lin"><b>' + esc(it.nome) + '</b><span class="' + cor + '">' + esc(it.estado || '—') + '</span></div>' +
      (it.obs ? '<p class="obs">' + esc(it.obs) + '</p>' : '') +
      (it.fotos.length ? '<div class="galeria">' + it.fotos.map(function (f) {
        return f.mini ? '<img src="' + f.mini + '" data-foto="' + esc(f.id) + '" alt="Foto: ' + esc(it.nome) + '">' : '';
      }).join('') + '</div>' : '') + '</div>';
  }

  function render() {
    var c = D.carro;
    var avarias = D.itens.filter(function (it) { return it.estado === 'Avaria'; });
    var termos = String(D.termos || '').split('\n').filter(function (t) { return t.trim(); }).map(function (t) {
      return '<li>' + (/^TERMO DE RESPONSABILIDADE/i.test(t) ? '<b>' + esc(t) + '</b>' : esc(t)) + '</li>';
    }).join('');
    var final = D.aceite
      ? '<div class="card ok"><div style="font-size:40px">✅</div><div class="veredito c-ok">Entrega aceita</div>' +
        '<p class="como" style="margin:6px 0 0">Assinado por <b>' + esc(D.aceite.nome) + '</b> em <b>' + esc(D.aceite.em) + '</b> (horário de Brasília).</p>' +
        '<button class="btn sec peq naoimprime" style="margin-top:12px" onclick="window.print()">Salvar comprovante (PDF)</button></div>'
      : '<div class="area">Aceite e assinatura</div><div class="card" id="form">' +
        '<label class="cap" style="margin-top:0" for="nome">Nome completo</label><input type="text" id="nome" autocomplete="name" value="' + esc(D.cliente.nome) + '">' +
        '<label class="cap" for="cpf">CPF</label><input type="text" id="cpf" inputmode="numeric" autocomplete="off" placeholder="Só números">' +
        '<label class="marca-check"><input type="checkbox" id="concordo"> <span>Li e aceito os termos acima, inclusive o <b>termo de responsabilidade</b>.</span></label>' +
        '<div id="assinBox">' + htmlAssinBox() + '</div>' +
        '<div id="msg"></div>' +
        '<button class="btn pri" id="confirmar" type="button" style="margin-top:12px">Confirmar entrega</button></div>';
    app.innerHTML = '<header class="topo"><div class="marca">Termo de entrega do veículo</div><div class="sub">' + esc(c.modelo) + ' · placa ' + esc(c.placa) + '</div></header>' +
      '<main>' +
      '<div class="card"><div class="kv"><span>Locador</span><b>' + esc(D.locador || '—') + (D.docLocador ? '<br><small>' + esc(D.docLocador) + '</small>' : '') + '</b></div>' +
      '<div class="kv"><span>Cliente</span><b>' + esc(D.cliente.nome) + '</b></div>' +
      '<div class="kv"><span>Veículo</span><b>' + esc(c.modelo) + (c.cor ? ' · ' + esc(c.cor) : '') + '<br><small>placa ' + esc(c.placa) + '</small></b></div>' +
      '<div class="kv"><span>Quilometragem</span><b>' + Number(D.km || 0).toLocaleString('pt-BR') + ' km</b></div>' +
      '<div class="kv"><span>Combustível</span><b>' + esc(D.combustivel) + '</b></div>' +
      (D.chaves ? '<div class="kv"><span>Chaves</span><b>' + esc(D.chaves) + '</b></div>' : '') +
      (D.devolucao ? '<div class="kv"><span>Devolução prevista</span><b>' + esc(D.devolucao) + '</b></div>' : '') +
      '<div class="kv"><span>Entrega</span><b>' + esc(D.entregueEm) + '</b></div>' +
      ((D.docs || []).length ? '<div class="kv"><span>Documentos</span><b>' + D.docs.map(esc).join('<br>') + '</b></div>' : '') +
      (D.obsGerais ? '<p class="como" style="margin:8px 0 0">' + esc(D.obsGerais) + '</p>' : '') + '</div>' +
      '<div class="area">Avarias registradas</div>' +
      (avarias.length ? avarias.map(cardItem).join('') : '<div class="card c-ok">Nenhuma avaria registrada.</div>') +
      '<details class="fotos"><summary>Ver todas as fotos do checklist (' + D.itens.length + ' itens)</summary>' + D.itens.map(cardItem).join('') + '</details>' +
      '<div class="area">Termos</div><div class="card"><ol class="lista">' + termos + '</ol></div>' +
      final +
      (D.telLocador ? '<p class="como" style="text-align:center">Dúvidas: ' + esc(D.locador) + ' · ' + esc(D.telLocador) + '</p>' : '') +
      '</main>';
    if (!D.aceite) document.getElementById('confirmar').onclick = confirmar;
  }
  function htmlAssinBox() {
    return assinatura
      ? '<label class="cap">Assinatura</label><img class="assin-previa" src="' + assinatura + '" alt="Assinatura"><button class="btn sec peq" type="button" data-assinar="1" style="margin-top:8px">Refazer assinatura</button>'
      : '<button class="btn sec assinar" type="button" data-assinar="1">✍️ Assinar (abre em tela cheia)</button>';
  }

  // ------------------------------------------------------------ assinatura em tela cheia (S Pen ou dedo)
  var tela, cv, ctx, tracos = [], atual = null, viuCaneta = false;
  function abrirAssinatura() {
    tracos = []; atual = null;
    tela = document.createElement('div');
    tela.className = 'tela-assin';
    tela.innerHTML = '<div class="dica-assin">Assine na linha · <span>vire o celular de lado para mais espaço</span></div><canvas></canvas><div class="linha-assin"></div>' +
      '<div class="barra-assin"><button type="button" data-a="corrigir">↶ Corrigir</button><button type="button" data-a="limpar">Limpar</button>' +
      '<button type="button" data-a="cancelar">Cancelar</button><button type="button" class="salvar" data-a="salvar">✓ Salvar</button></div>';
    document.body.appendChild(tela);
    document.body.classList.add('sem-rolar');
    cv = tela.querySelector('canvas'); ctx = cv.getContext('2d');
    try { (tela.requestFullscreen ? tela.requestFullscreen() : Promise.resolve()).then(function () {
      if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape');
    }).catch(function () { /* sem tela cheia nativa: a sobreposição já ocupa a tela */ }); } catch (e) { /* idem */ }
    ajustar();
    window.addEventListener('resize', ajustar);
    cv.addEventListener('pointerdown', inicio);
    cv.addEventListener('pointermove', movimento);
    ['pointerup', 'pointercancel'].forEach(function (n) { cv.addEventListener(n, fim); });
    tela.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-a]'); if (!b) return;
      var a = b.getAttribute('data-a');
      if (a === 'corrigir') { tracos.pop(); redesenhar(); }
      if (a === 'limpar') { tracos = []; redesenhar(); }
      if (a === 'cancelar') fecharAssinatura();
      if (a === 'salvar') {
        if (!tracos.length) { b.textContent = 'Assine primeiro'; setTimeout(function () { b.textContent = '✓ Salvar'; }, 1500); return; }
        assinatura = exportar(); fecharAssinatura();
        document.getElementById('assinBox').innerHTML = htmlAssinBox();
      }
    });
  }
  function fecharAssinatura() {
    window.removeEventListener('resize', ajustar);
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* segue */ }
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* segue */ }
    if (tela) tela.remove();
    document.body.classList.remove('sem-rolar');
    tela = null;
  }
  function ajustar() {
    var r = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * r; cv.height = cv.clientHeight * r;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    redesenhar();
  }
  function pos(ev) {
    var b = cv.getBoundingClientRect();
    var p = ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5;
    return { x: ev.clientX - b.left, y: ev.clientY - b.top, p: p };
  }
  function inicio(ev) {
    if (ev.pointerType === 'pen') viuCaneta = true;
    if (viuCaneta && ev.pointerType === 'touch') return;          // mão apoiada na tela não risca
    ev.preventDefault();
    atual = [pos(ev)]; tracos.push(atual);
    try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* segue */ }
    redesenhar();
  }
  function movimento(ev) {
    if (!atual || (viuCaneta && ev.pointerType === 'touch')) return;
    ev.preventDefault();
    var pts = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    (pts.length ? pts : [ev]).forEach(function (e) { atual.push(pos(e)); });
    desenharTraco(atual, Math.max(1, atual.length - pts.length - 1));
  }
  function fim() { atual = null; }
  function largura(p) { return 1.2 + p * 3.6; }                    // caneta: mais força, traço mais grosso
  function desenharTraco(t, de) {
    ctx.strokeStyle = '#111'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (t.length === 1) { ctx.beginPath(); ctx.arc(t[0].x, t[0].y, largura(t[0].p) / 2, 0, 7); ctx.fillStyle = '#111'; ctx.fill(); return; }
    for (var i = de || 1; i < t.length; i++) {
      ctx.beginPath(); ctx.lineWidth = largura((t[i - 1].p + t[i].p) / 2);
      ctx.moveTo(t[i - 1].x, t[i - 1].y); ctx.lineTo(t[i].x, t[i].y); ctx.stroke();
    }
  }
  function redesenhar() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    tracos.forEach(function (t) { desenharTraco(t, 1); });
  }
  /** Recorta só a área assinada, com fundo branco, em até 900 px de largura (fica leve e legível no PDF). */
  function exportar() {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    tracos.forEach(function (t) { t.forEach(function (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }); });
    var m = 12, w = (x1 - x0) + 2 * m, h = (y1 - y0) + 2 * m, esc2 = Math.min(2, 900 / w);
    var o = document.createElement('canvas'); o.width = Math.max(60, Math.round(w * esc2)); o.height = Math.max(40, Math.round(h * esc2));
    var c = o.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, o.width, o.height);
    c.setTransform(esc2, 0, 0, esc2, (m - x0) * esc2, (m - y0) * esc2);
    var guarda = ctx; ctx = c; tracos.forEach(function (t) { desenharTraco(t, 1); }); ctx = guarda;
    return o.toDataURL('image/png');
  }

  function aviso(t) { document.getElementById('msg').innerHTML = t ? '<div class="aviso-foto" style="margin-top:12px">' + esc(t) + '</div>' : ''; }

  function confirmar() {
    if (enviando) return;
    var nome = document.getElementById('nome').value.trim(), cpf = document.getElementById('cpf').value.replace(/\D/g, '');
    if (nome.split(/\s+/).length < 2) return aviso('Digite o nome completo.');
    if (cpf.length !== 11 && cpf.length !== 14) return aviso('Digite o CPF completo (11 números).');
    if (!document.getElementById('concordo').checked) return aviso('Marque que leu e aceita os termos.');
    if (!assinatura) return aviso('Toque em Assinar.');
    aviso('');
    enviando = true;
    var b = document.getElementById('confirmar'); b.disabled = true; b.textContent = 'Enviando…';
    rpc('aceiteConfirmar', { nome: nome, cpf: cpf, concordo: true, assinatura: assinatura, aparelho: navigator.userAgent })
      .then(function (r) {
        D.aceite = { nome: nome, em: r.em };
        render(); window.scrollTo(0, document.body.scrollHeight);
      }).catch(function (e) { enviando = false; b.disabled = false; b.textContent = 'Confirmar entrega'; aviso(e.message); });
  }

  // ------------------------------------------------------------ toques: assinar e ampliar foto
  document.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-assinar]')) return abrirAssinatura();
    var img = ev.target.closest('img[data-foto]');
    if (img) {
      zoom.innerHTML = '<img src="' + img.src + '" alt=""><div class="dica"><span class="giro"></span> Carregando foto maior…</div>';
      zoom.classList.remove('oculto');
      rpc('aceiteFoto', img.getAttribute('data-foto')).then(function (src) {
        if (!zoom.classList.contains('oculto')) zoom.innerHTML = '<img src="' + src + '" alt=""><div class="dica">Toque para fechar</div>';
      }).catch(function () { var d = zoom.querySelector('.dica'); if (d) d.textContent = 'Toque para fechar'; });
      return;
    }
    if (ev.target.closest('#zoom')) { zoom.classList.add('oculto'); zoom.innerHTML = ''; }
  });

  if (!T || !API || !/^https:\/\/script\.google\.com\/.+\/exec$|^http:\/\/localhost:\d+\/exec$/.test(API)) { erro('Link incompleto. Peça ao locador para mandar o link de novo.'); return; }
  rpc('aceiteVer').then(function (d) { D = d; render(); }).catch(function (e) { erro(e.message); });
})();
