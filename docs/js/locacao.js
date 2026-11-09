/* locacao.js — aba "Locação · entregas": checklist de entrega do carro alugado, fotos no Drive
   e link para o cliente conferir, aceitar os termos e assinar. Usa o acesso e a compressão do app.js (window.GA). */
(function () {
  'use strict';

  var L = {
    tela: 'lista', boot: lerLS('gav-loc-boot'), atual: null, k: '', thumbs: {}, fila: [],
    enviando: '', processando: false, timer: null, atualizando: false, falta: null, salvando: false
  };
  var ESPERAS = [2000, 5000, 10000], PAUSA_LONGA = 30000, MAX_FOTOS = 6;
  var app = document.getElementById('app');

  function lerLS(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function gravarLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem espaço */ } }
  function esc(t) { return window.GA.esc(t); }
  function toast(t) { window.GA.toast(t); }

  // ------------------------------------------------------------ IndexedDB próprio (fila de fotos e miniaturas)
  var DB = null, MEM = { fila: {}, thumbs: {} };
  function abrirDB() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('giroauto_locacao', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('fila', { keyPath: 'id' }); r.result.createObjectStore('thumbs'); };
        r.onsuccess = function () { DB = r.result; res(); };
        r.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }
  function tx(store, modo, fn) {
    if (!DB) return Promise.resolve(fn(null, MEM[store]));
    return new Promise(function (res, rej) {
      var t = DB.transaction(store, modo), r = fn(t.objectStore(store)), out;
      if (r && 'onsuccess' in r) r.onsuccess = function () { out = r.result; };
      t.oncomplete = function () { res(out); };
      t.onerror = t.onabort = function () { rej(t.error); };
    });
  }
  function put(store, val, key) { return tx(store, 'readwrite', function (st, m) { if (m) { m[key || val.id] = val; return; } return key === undefined ? st.put(val) : st.put(val, key); }); }
  function get(store, key) { return tx(store, 'readonly', function (st, m) { return m ? m[key] : st.get(key); }); }
  function del(store, key) { return tx(store, 'readwrite', function (st, m) { if (m) { delete m[key]; return; } return st.delete(key); }); }
  function todos(store) {
    if (!DB) return Promise.resolve(Object.keys(MEM[store]).map(function (k) { return { k: k, v: MEM[store][k] }; }));
    return new Promise(function (res) {
      var out = [], t = DB.transaction(store, 'readonly'), c = t.objectStore(store).openCursor();
      c.onsuccess = function () { var cur = c.result; if (cur) { out.push({ k: cur.key, v: cur.value }); cur.continue(); } };
      t.oncomplete = function () { res(out); };
      t.onerror = function () { res(out); };
    });
  }

  // ------------------------------------------------------------ servidor
  function rpc(fn) {
    var args = Array.prototype.slice.call(arguments, 1), A = window.GA.acesso();
    if (!A) return Promise.reject(new Error('Sem link de acesso'));
    if (!navigator.onLine) return Promise.reject(new Error('Sem internet'));
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, /locFoto|locSalvar|locBoot/.test(fn) ? 120000 : 60000);
    return fetch(A.api, {
      method: 'POST', redirect: 'follow', signal: ctl ? ctl.signal : undefined,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ k: A.k, fn: fn, args: args })
    }).then(function (r) { return r.text(); }, function () {
      throw new Error(ctl && ctl.signal.aborted ? 'O servidor demorou demais para responder.' : 'Falha de conexão.');
    }).then(function (txt) {
      clearTimeout(timer);
      var d = null; try { d = JSON.parse(txt); } catch (e) { /* não é JSON */ }
      if (!d) throw new Error('Resposta inválida do servidor.');
      if (!d.ok) { if (d.error === 'chave') window.GA.semChave(); throw new Error(d.message || d.error); }
      return d.r;
    }, function (e) { clearTimeout(timer); throw e; });
  }

  function carregarBoot() {
    return rpc('locBoot').then(function (b) {
      L.boot = b; gravarLS('gav-loc-boot', b);
      if (L.tela === 'lista' || !L.boot) render(); else atualizar();
    }).catch(function (e) { L.erroBoot = e.message; if (!L.boot) render(); });
  }
  function guardarAtual() { if (L.atual) gravarLS('gav-loc-e-' + L.atual.id, L.atual); }
  function abrirEntrega(id) {
    L.atual = lerLS('gav-loc-e-' + id) || L.atual;
    if (L.atual && L.atual.id === id) ir('check');
    else { L.atual = null; L.tela = 'check'; render(); }
    return rpc('locAbrir', id).then(function (e) { L.atual = e; guardarAtual(); render(); buscarMinis(); })
      .catch(function (e) { if (!L.atual) { toast(e.message); ir('lista'); } });
  }

  // ------------------------------------------------------------ fila de envio (fotos e campos)
  function recarregarFila() {
    return todos('fila').then(function (l) { L.fila = l.map(function (x) { return x.v; }).sort(function (a, b) { return a.ts - b.ts; }); });
  }
  function filaDa(id) { return L.fila.filter(function (o) { return o.entrega === id; }); }
  function fotosNaFila(id) { return filaDa(id).filter(function (o) { return o.tipo === 'foto'; }).length; }
  function enfileirar(op) {
    op.ts = Date.now(); op.tent = 0; op.esperaAte = 0;
    return put('fila', op).then(recarregarFila).then(function () { atualizar(); processar(); });
  }
  function processar() {
    if (L.processando) return;
    L.processando = true; clearTimeout(L.timer);
    (function passo() {
      recarregarFila().then(function () {
        var agora = Date.now();
        var op = L.fila.filter(function (o) { return !o.esperaAte || o.esperaAte <= agora; })[0];
        if (!op || !navigator.onLine) {
          L.processando = false; L.enviando = ''; atualizar();
          var prox = L.fila.reduce(function (m, o) { return Math.min(m, o.esperaAte || agora + 1000); }, Infinity);
          if (prox !== Infinity) L.timer = setTimeout(processar, Math.max(1000, prox - agora));
          return;
        }
        L.enviando = op.id; atualizar();
        executar(op).then(function () {
          return get('fila', op.id).then(function (a) { if (a && a.ts === op.ts) return del('fila', op.id); }).then(recarregarFila).then(atualizar);
        }, function (err) {
          console.warn('locação: envio falhou', op.id, err);
          if (/não pode mais mudar|não encontrada|desconhecido|Máximo/.test(err.message)) { toast(err.message); return del('fila', op.id); }
          op.tent = (op.tent || 0) + 1;
          var espera = ESPERAS[op.tent - 1]; if (!espera) { op.tent = 0; espera = PAUSA_LONGA; }
          op.esperaAte = Date.now() + espera;
          return get('fila', op.id).then(function (a) { if (a && a.ts === op.ts) return put('fila', op); });
        }).then(passo, passo);
      });
    })();
  }
  function executar(op) {
    if (op.tipo === 'foto') {
      return window.GA.blobParaBase64(op.blob).then(function (b64) {
        return rpc('locFoto', { id: op.entrega, k: op.k, base64: b64, mime: op.mime, ts: new Date(op.ts).toISOString() });
      }).then(function (r) {
        var th = L.thumbs[op.id];
        if (th) { L.thumbs[r.fotoId] = th; put('thumbs', th, r.fotoId).catch(function () {}); del('thumbs', op.id).catch(function () {}); }
        aplicarItem(op.entrega, op.k, r.item);
      });
    }
    return rpc('locSalvarItem', Object.assign({ id: op.entrega, k: op.k }, op.dados)).then(function (r) {
      aplicarItem(op.entrega, op.k, r.item);
      if (L.atual && L.atual.id === op.entrega) { L.atual.km = r.km; L.atual.combustivel = r.combustivel; L.atual.chaves = r.chaves; guardarAtual(); }
    });
  }
  function aplicarItem(id, k, it) {
    if (!it) return;
    var e = L.atual && L.atual.id === id ? L.atual : lerLS('gav-loc-e-' + id);
    if (!e) return;
    // o que ainda está na fila para este item vale mais que a resposta do servidor
    var pend = L.fila.filter(function (o) { return o.tipo === 'item' && o.entrega === id && o.k === k; })[0];
    e.itens[k] = Object.assign({}, it, pend ? pickItem(pend.dados) : {});
    if (L.atual && L.atual.id === id) { L.atual = e; guardarAtual(); } else gravarLS('gav-loc-e-' + id, e);
  }
  function pickItem(d) { var o = {}; if (d.estado !== undefined) o.estado = d.estado; if (d.obs !== undefined) o.obs = d.obs; return o; }

  /** Muda estado, observação ou campos do painel: aparece na hora e sobe pela fila. */
  function salvarCampos(k, dados) {
    var e = L.atual; if (!e || !Object.keys(dados).length) return Promise.resolve();
    var x = e.itens[k] = e.itens[k] || { fotos: [], estado: '', obs: '' };
    Object.assign(x, pickItem(dados));
    ['km', 'combustivel', 'chaves'].forEach(function (c) { if (dados[c] !== undefined) e[c] = dados[c]; });
    guardarAtual();
    var id = 'item_' + e.id + '_' + k;
    return get('fila', id).then(function (a) {
      return enfileirar({ id: id, tipo: 'item', entrega: e.id, k: k, dados: Object.assign({}, a ? a.dados : {}, dados) });
    });
  }

  function receberFoto(file) {
    if (!file || !L.atual) return;
    var e = L.atual, k = L.k;
    toast('Preparando foto…');
    window.GA.comprimir(file).then(function (r) {
      var id = 'foto_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      L.thumbs[id] = r.thumb; put('thumbs', r.thumb, id).catch(function () {});
      return enfileirar({ id: id, tipo: 'foto', entrega: e.id, k: k, blob: r.blob, mime: r.blob.type || 'image/jpeg' });
    }).then(function () {
      var x = e.itens[k] || {};
      if (!x.estado) salvarCampos(k, { estado: 'OK' });          // foto sem marcação = em bom estado (dá para trocar)
      toast('Foto salva. Enviando ao Drive…');
      renderItem();
    }).catch(function (er) { console.error(er); toast('Não consegui ler a foto. Tente de novo.'); });
  }

  function buscarMinis() {
    if (!L.atual || !navigator.onLine || L.buscandoMini) return;
    var faltam = [];
    Object.keys(L.atual.itens || {}).forEach(function (k) { (L.atual.itens[k].fotos || []).forEach(function (f) { if (!L.thumbs[f]) faltam.push(f); }); });
    if (!faltam.length) return;
    L.buscandoMini = true;
    rpc('locMiniaturas', faltam.slice(0, 30)).then(function (l) {
      (l || []).forEach(function (m) { if (m.data) { L.thumbs[m.id] = m.data; put('thumbs', m.data, m.id).catch(function () {}); } });
    }).catch(function () {}).then(function () { L.buscandoMini = false; atualizar(); });
  }

  // ------------------------------------------------------------ visão de um item
  function itens() { return (L.boot && L.boot.itens) || []; }
  function item(k) { return itens().filter(function (i) { return i.k === k; })[0]; }
  function vi(k) {
    var e = L.atual || { itens: {} }, x = e.itens[k] || {};
    var pend = L.fila.filter(function (o) { return o.tipo === 'foto' && o.entrega === e.id && o.k === k; });
    var fotos = (x.fotos || []).map(function (f) { return { id: f, th: L.thumbs[f], fila: false }; })
      .concat(pend.map(function (o) { return { id: o.id, th: L.thumbs[o.id], fila: true }; }));
    var it = item(k) || {};
    var ok = x.estado === 'Não tem' || (fotos.length && !(x.estado === 'Avaria' && !String(x.obs || '').trim()));
    if (it.campos && it.campos.indexOf('km') >= 0) ok = ok && !!e.km && !!e.combustivel;
    return { it: it, x: x, fotos: fotos, feito: !!ok, estado: x.estado || '', obs: x.obs || '' };
  }
  function emoji(y) {
    if (y.estado === 'Avaria') return '🟠';
    if (y.estado === 'Não tem') return '⚫';
    if (y.feito) return '🟢';
    return y.it.opcional ? '◽' : '⚪';
  }
  function aceito() { return L.atual && L.atual.situacao === 'aceito'; }

  // ------------------------------------------------------------ telas
  function ir(t, k) {
    if (k) L.k = k;
    L.tela = t; L.falta = null;
    render(); window.scrollTo(0, 0);
  }
  function topo(titulo, sub, voltar) {
    return '<header class="topo"><div class="linha">' +
      (voltar ? '<button class="voltar" data-l="voltar" data-t="' + voltar + '">‹ Voltar</button>' : window.GA.btnMenu()) +
      '<div style="flex:1 1 auto;min-width:0"><div class="marca">' + titulo + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>' +
      '<button class="atualizar" id="btnAtualizarL" data-acao="atualizarTudo" aria-label="Atualizar">' + htmlBtnAtualizar() + '</button>' +
      '</div><div id="pillsL">' + htmlPills() + '</div></header>';
  }
  function htmlBtnAtualizar() {
    return L.atualizando ? '<span class="giro"></span><small>Atualizando</small>' : '<span class="ic">⟳</span><small>Atualizar</small>';
  }
  function htmlPills() {
    var n = L.fila.filter(function (o) { return o.tipo === 'foto'; }).length, out = '';
    if (!navigator.onLine) out += '<span class="pill off">Sem internet — fotos guardadas no celular</span>';
    if (n) out += '<span class="pill alerta">' + (L.enviando ? '<span class="giro"></span> ' : '') + n + (n === 1 ? ' foto aguardando envio' : ' fotos aguardando envio') + '</span>';
    return out;
  }

  function render() {
    if (!L.boot) return renderSemBoot();
    if (L.tela === 'dados') return renderDados();
    if (L.tela === 'termos') return renderTermos();
    if (L.tela !== 'lista' && !L.atual) return renderCarregando();
    if (L.tela === 'check') return renderCheck();
    if (L.tela === 'item') return renderItem();
    if (L.tela === 'enviar') return renderEnviar();
    return renderLista();
  }
  /** Atualização leve: não apaga o que ele está digitando. */
  function atualizar() {
    var p = document.getElementById('pillsL'); if (p) p.innerHTML = htmlPills();
    var b = document.getElementById('btnAtualizarL'); if (b) b.innerHTML = htmlBtnAtualizar();
    if (L.tela === 'item') { var f = document.getElementById('fotosL'); if (f) f.innerHTML = htmlFotos(); }
    else if (L.tela === 'check' || L.tela === 'lista') render();
    else if (L.tela === 'enviar') { var en = document.getElementById('enviarL'); if (en) en.innerHTML = htmlEnviar(); }
  }

  function renderSemBoot() {
    app.innerHTML = topo('GIRO AUTO · Locação', '', '') + '<main><div class="card"><h1 class="nome">Preparando a locação…</h1>' +
      '<p class="como">Na primeira vez é preciso internet para baixar o checklist de entrega.</p>' +
      (L.erroBoot ? '<div class="aviso-foto">' + esc(L.erroBoot) + '</div><button class="btn pri" data-l="tentar">Tentar de novo</button>' : '<span class="giro"></span>') +
      '</div></main>';
  }
  function renderCarregando() {
    app.innerHTML = topo('GIRO AUTO · Locação', '', 'lista') + '<main><div class="card"><span class="giro"></span> Abrindo a entrega…</div></main>';
  }

  // --- Lista de entregas
  function renderLista() {
    var cfg = L.boot.config || {};
    var lista = (L.boot.lista || []).map(function (e) {
      var ic = { rascunho: '📝', aguardando: '⏳', aceito: '✅' }[e.situacao] || '📝';
      var st = { rascunho: 'Checklist em andamento', aguardando: 'Aguardando o cliente assinar', aceito: 'Aceito em ' + esc(e.aceiteEm) }[e.situacao] || '';
      return '<button class="it" data-l="abrir" data-id="' + esc(e.id) + '"><span class="em">' + ic + '</span><span class="tx"><div class="nm">' +
        esc(e.cliente) + ' · ' + esc(e.placa) + '</div><div class="ds">' + esc(e.modelo) + ' · ' + dataCurta(e.criadaEm) + ' · ' + st + '</div></span></button>';
    }).join('');
    app.innerHTML = topo('GIRO AUTO · Locação', 'Entrega de carro com aceite do cliente', '') +
      '<main>' +
      (!cfg.locador ? '<div class="card" style="border-color:var(--ouro)"><b class="c-ouro">Antes da primeira entrega</b>' +
        '<p class="como" style="margin:4px 0 8px">Coloque seu nome (ou da empresa) como locador e confira o texto dos termos que o cliente vai aceitar.</p>' +
        '<button class="btn pri peq" data-l="ir" data-t="termos">Preencher agora</button></div>' : '') +
      '<button class="btn pri" data-l="nova">+ Nova entrega</button>' +
      '<div class="area">Entregas</div>' + (lista || '<div class="card c-2">Nenhuma entrega ainda.</div>') +
      '<button class="btn sec peq" style="margin-top:8px" data-l="ir" data-t="termos">Termos e dados do locador</button>' +
      '</main>';
  }
  function dataCurta(iso) { var d = new Date(iso); return isNaN(d) ? '' : ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2); }

  // --- Cliente e carro
  function campo(k, rot, val, extra) {
    return '<label class="cap" for="ld_' + k + '">' + rot + '</label><input type="text" id="ld_' + k + '" value="' + esc(val || '') + '" autocomplete="off" ' + (extra || '') + '>';
  }
  function renderDados() {
    var e = L.editando || {}, c = e.cliente || {}, v = e.carro || {};
    app.innerHTML = topo(e.id ? 'Editar entrega' : 'Nova entrega', 'Cliente e carro', e.id ? 'check' : 'lista') +
      '<main><div class="area">Cliente</div><div class="card">' +
      campo('nome', 'Nome completo *', c.nome, 'autocapitalize="words"') +
      campo('cpf', 'CPF', c.cpf, 'inputmode="numeric" placeholder="Só números"') +
      campo('tel', 'Celular com DDD (WhatsApp)', c.tel, 'inputmode="tel" placeholder="11999998888"') +
      campo('email', 'E-mail', c.email, 'inputmode="email" autocapitalize="off"') +
      '<p class="como" style="margin:10px 0 0">Com o CPF cadastrado, só o próprio cliente consegue assinar (o app confere os números).</p></div>' +
      '<div class="area">Carro</div><div class="card">' +
      campo('placa', 'Placa *', v.placa, 'autocapitalize="characters" placeholder="ABC1D23"') +
      campo('modelo', 'Modelo e ano *', v.modelo, 'placeholder="Onix 2020"') +
      campo('cor', 'Cor', v.cor) +
      campo('devolucao', 'Devolução prevista', e.devolucao, 'placeholder="15/11 às 18h"') +
      '<label class="cap" for="ld_obsGerais">Observações da entrega</label><textarea id="ld_obsGerais" maxlength="600" placeholder="Opcional">' + esc(e.obsGerais || '') + '</textarea>' +
      '</div></main>' +
      '<div class="rodape"><div class="dentro"><button class="btn pri" data-l="salvarDados">' + (e.id ? 'Salvar' : 'Começar o checklist') + '</button></div></div>';
  }
  function salvarDados() {
    if (L.salvando) return;
    if (!navigator.onLine) { toast('Para criar ou editar a entrega é preciso internet.'); return; }
    var d = { id: (L.editando || {}).id || '' };
    ['nome', 'cpf', 'tel', 'email', 'placa', 'modelo', 'cor', 'devolucao', 'obsGerais'].forEach(function (k) { d[k] = document.getElementById('ld_' + k).value.trim(); });
    if (!d.nome || !d.placa || !d.modelo) { toast('Preencha nome do cliente, placa e modelo.'); return; }
    L.salvando = true;
    var b = document.querySelector('[data-l="salvarDados"]'); if (b) { b.disabled = true; b.textContent = 'Salvando…'; }
    rpc('locSalvar', d).then(function (e) {
      L.salvando = false; L.atual = e; guardarAtual(); L.editando = null;
      carregarBoot();
      if (d.id) ir('check'); else ir('item', itens()[0].k);
    }).catch(function (er) {
      L.salvando = false; if (b) { b.disabled = false; b.textContent = d.id ? 'Salvar' : 'Começar o checklist'; } toast(er.message);
    });
  }

  // --- Checklist da entrega
  function renderCheck() {
    var e = L.atual, feitos = 0, obrig = 0, html = '', area = '';
    itens().forEach(function (it) {
      var y = vi(it.k);
      if (!it.opcional) { obrig++; if (y.feito) feitos++; }
      if (it.area !== area) { area = it.area; html += '<div class="area">' + esc(area) + '</div>'; }
      var ds = y.fotos.length ? y.fotos.length + (y.fotos.length === 1 ? ' foto' : ' fotos') : (y.estado === 'Não tem' ? '' : it.opcional ? 'Opcional' : 'Pendente');
      if (y.estado) ds += (ds ? ' · ' : '') + y.estado;
      if (y.obs) ds += ' · ' + esc(y.obs);
      if (it.k === 'painel' && (e.km || e.combustivel)) ds += ' · ' + (e.km ? Number(e.km).toLocaleString('pt-BR') + ' km' : 'sem km') + ' · ' + (e.combustivel || 'sem combustível');
      html += '<button class="it" data-l="item" data-k="' + it.k + '"><span class="em">' + emoji(y) + '</span><span class="tx"><div class="nm">' + esc(it.nome) +
        '</div><div class="ds' + (y.estado === 'Avaria' ? ' aviso' : '') + '">' + ds + '</div></span><span class="mini">' +
        y.fotos.slice(0, 2).map(function (f) { return f.th ? '<img src="' + f.th + '" alt="">' : '<span></span>'; }).join('') + '</span></button>';
    });
    var ac = aceito();
    var prox = itens().filter(function (it) { return !it.opcional && !vi(it.k).feito; })[0];
    app.innerHTML = topo('Entrega · ' + esc(e.carro.modelo) + ' · ' + esc(e.carro.placa), esc(e.cliente.nome), 'lista') +
      '<main>' +
      (ac ? '<div class="card" style="border-color:var(--verde)"><b class="c-ok">✅ Aceito pelo cliente</b><p class="como" style="margin:4px 0 0">' +
        esc(e.aceite.nome) + ' assinou em ' + esc(e.aceite.emTexto) + '. A entrega não pode mais ser alterada.</p></div>' : '') +
      '<div class="card"><div class="prog"><div class="rot"><span>Itens conferidos</span><b>' + feitos + '/' + obrig + '</b></div><div class="barra"><i style="width:' +
      Math.round(100 * feitos / Math.max(obrig, 1)) + '%"></i></div></div>' +
      (ac ? '' : '<button class="btn sec peq" data-l="editar">Editar cliente e carro</button>') + '</div>' +
      html + htmlDocs() + '</main>' +
      '<div class="rodape"><div class="dentro">' +
      (ac ? '<button class="btn pri" data-l="ir" data-t="enviar">Ver aceite e termo</button>'
        : (prox ? '<button class="btn pri" data-l="item" data-k="' + prox.k + '">Continuar checklist</button>' : '') +
          '<button class="btn ' + (prox ? 'sec peq' : 'pri') + '" data-l="ir" data-t="enviar">Enviar ao cliente</button>') +
      '</div></div>';
  }

  // --- Documentos anexados (contrato assinado no gov.br, caução etc.): sobem sem nenhuma alteração
  function htmlDocs() {
    var e = L.atual, docs = e.docs || [];
    return '<div class="area">Contrato e documentos</div><div class="card" id="docsL">' +
      (docs.length ? docs.map(function (d) {
        return '<div class="kv"><span>📄 <a href="https://drive.google.com/file/d/' + esc(d.id) + '/view" target="_blank" rel="noopener">' + esc(d.nome) + '</a></span>' +
          (aceito() ? '' : '<button class="chip" style="min-height:40px" data-l="tirarDoc" data-d="' + esc(d.id) + '">Tirar</button>') + '</div>';
      }).join('') : '<p class="como" style="margin:0 0 10px">Anexe o contrato assinado no gov.br (PDF). Ele fica na mesma pasta do checklist no Drive.</p>') +
      (L.subindoDoc ? '<div class="faixa"><span class="giro"></span> Enviando ' + esc(L.subindoDoc) + '…</div>'
        : '<label class="btn sec peq" style="position:relative;margin-top:8px">📎 Anexar documento<input type="file" accept="application/pdf,image/*,.doc,.docx" data-ldoc="1" style="position:absolute;inset:0;opacity:0"></label>') +
      '</div>';
  }
  function anexarDoc(file) {
    if (!file || !L.atual) return;
    if (!navigator.onLine) { toast('Para anexar documento é preciso internet.'); return; }
    if (file.size > 15 * 1024 * 1024) { toast('Arquivo grande demais (máximo 15 MB).'); return; }
    var id = L.atual.id;
    L.subindoDoc = file.name; render();
    window.GA.blobParaBase64(file).then(function (b64) {
      return rpc('locDocumento', { id: id, nome: file.name, mime: file.type || 'application/octet-stream', base64: b64 });
    }).then(function (e) {
      if (L.atual && L.atual.id === id) { L.atual = e; guardarAtual(); }
      toast('Documento anexado na pasta da entrega.');
    }).catch(function (er) { toast(er.message); }).then(function () { L.subindoDoc = ''; render(); });
  }

  // --- Um item
  function renderItem() {
    var e = L.atual, lista = itens(), i = lista.indexOf(item(L.k)), y = vi(L.k), it = y.it, ac = aceito();
    var campos = '';
    if (it.campos) {
      campos = '<div class="card">';
      if (it.campos.indexOf('km') >= 0) {
        campos += '<label class="cap" style="margin-top:0" for="lkm">Quilometragem (km) *</label><input type="text" id="lkm" inputmode="numeric" value="' + esc(e.km) + '"' + (ac ? ' disabled' : '') + ' placeholder="Ex.: 45230">' +
          '<label class="cap">Combustível *</label><div class="chips">' + L.boot.combustivel.map(function (c) {
            return '<button class="chip' + (e.combustivel === c ? ' on' : '') + '" data-l="comb" data-v="' + c + '"' + (ac ? ' disabled' : '') + '>' + c + '</button>';
          }).join('') + '</div>';
      }
      if (it.campos.indexOf('chaves') >= 0) {
        campos += '<label class="cap" style="margin-top:0" for="lchaves">Quantas chaves o cliente leva?</label><input type="text" id="lchaves" inputmode="numeric" value="' + esc(e.chaves) + '"' + (ac ? ' disabled' : '') + ' placeholder="1">';
      }
      campos += '</div>';
    }
    var estados = ['OK', 'Avaria'].concat(it.podeNaoTer ? ['Não tem'] : []);
    app.innerHTML = topo(esc(it.nome), esc(it.area) + ' · ' + (i + 1) + '/' + lista.length, 'check') +
      '<main><p class="como">' + esc(it.dica) + '</p>' + campos +
      '<div id="fotosL">' + htmlFotos() + '</div>' +
      '<div class="card"><label class="cap" style="margin-top:0">Como está</label><div class="chips">' +
      estados.map(function (s) {
        var cls = { OK: 'ok', Avaria: 'at', 'Não tem': '' }[s];
        return '<button class="chip ' + cls + (y.estado === s ? ' on' : '') + '" data-l="estado" data-v="' + s + '"' + (ac ? ' disabled' : '') + '>' + s + '</button>';
      }).join('') + '</div>' +
      '<label class="cap" for="lobs">' + (y.estado === 'Avaria' ? 'Descreva a avaria *' : 'Observação') + '</label><textarea id="lobs" maxlength="500"' + (ac ? ' disabled' : '') +
      ' placeholder="' + (y.estado === 'Avaria' ? 'Onde fica, tamanho, se é risco, amassado ou trinca' : 'Opcional') + '">' + esc(y.obs) + '</textarea></div>' +
      '</main><div class="rodape"><div class="dentro"><div class="lado">' +
      '<button class="btn sec" data-l="voltar" data-t="check">Lista</button>' +
      '<button class="btn pri" data-l="proximo">' + (i < lista.length - 1 ? 'Próximo ›' : 'Concluir ›') + '</button></div></div></div>';
  }
  function htmlFotos() {
    var y = vi(L.k), ac = aceito(), out = '<div class="card"><label class="cap" style="margin-top:0">Fotos (' + y.fotos.length + '/' + MAX_FOTOS + ')</label><div class="grade">';
    y.fotos.forEach(function (f) {
      out += '<div class="fotoL">' + (f.th ? '<img src="' + f.th + '" alt="">' : '<span class="giro"></span>') +
        '<small>' + (L.enviando === f.id ? '<span class="giro"></span>' : f.fila ? '⏳' : '<span class="c-ok">✓</span>') + '</small>' +
        (ac ? '' : '<button class="tirar" data-l="tirarFoto" data-f="' + esc(f.id) + '" aria-label="Apagar foto">×</button>') + '</div>';
    });
    if (!ac && y.fotos.length < MAX_FOTOS) {
      out += '<label class="fotoL nova"><span class="ic">📷</span>' + (y.fotos.length ? 'Mais uma' : 'Tirar foto') +
        '<input type="file" accept="image/*" capture="environment" data-lfoto="1"></label>';
    }
    return out + '</div>' + (y.fotos.some(function (f) { return f.fila; }) ? '<p class="como" style="margin:8px 0 0">⏳ = guardada no celular, sobe sozinha para o Drive.</p>' : '') + '</div>';
  }
  /** Ao sair do item, grava o que foi digitado. */
  function sairDoItem() {
    if (aceito() || L.tela !== 'item') return Promise.resolve();
    var d = {}, y = vi(L.k), e = L.atual;
    var o = document.getElementById('lobs'); if (o && o.value.trim() !== y.obs) d.obs = o.value.trim();
    var km = document.getElementById('lkm'); if (km && km.value.replace(/\D/g, '') !== (e.km || '')) d.km = km.value.replace(/\D/g, '');
    var ch = document.getElementById('lchaves'); if (ch && ch.value.replace(/\D/g, '') !== (e.chaves || '')) d.chaves = ch.value.replace(/\D/g, '');
    return salvarCampos(L.k, d);
  }

  // --- Enviar ao cliente
  function renderEnviar() {
    var e = L.atual;
    app.innerHTML = topo(aceito() ? 'Aceite do cliente' : 'Enviar ao cliente', esc(e.carro.modelo) + ' · ' + esc(e.carro.placa), 'check') +
      '<main id="enviarL">' + htmlEnviar() + '</main>';
  }
  function linkCliente() {
    var A = window.GA.acesso(), e = L.atual;
    if (!A || !e.token) return '';
    return new URL('aceite.html', location.href.split('#')[0].split('?')[0]).href + '#t=' + e.token + '&api=' + encodeURIComponent(A.api);
  }
  function mensagem() {
    var e = L.atual, cfg = L.boot.config || {};
    return 'Olá, ' + e.cliente.nome.split(' ')[0] + '! Aqui está o checklist de entrega do ' + e.carro.modelo + ' (placa ' + e.carro.placa + '), ' +
      'com as fotos de como o carro está sendo entregue. Confira, leia os termos e assine pelo link:\n' + linkCliente() +
      (cfg.locador ? '\n\n' + cfg.locador : '');
  }
  function telWhats(t) {
    var d = String(t || '').replace(/\D/g, '');
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return d;
  }
  function htmlEnviar() {
    var e = L.atual, c = e.cliente, out = '', pend = fotosNaFila(e.id);
    if (aceito()) {
      return '<div class="card" style="text-align:center;border-color:var(--verde)"><div style="font-size:44px">✅</div><div class="veredito c-ok">Aceito pelo cliente</div>' +
        '<p class="como" style="margin:8px 0 0">' + esc(e.aceite.nome) + ' (CPF final ' + esc(String(e.aceite.cpf).slice(-2)) + ') leu os termos e assinou em <b>' + esc(e.aceite.emTexto) + '</b>.</p></div>' +
        '<div class="card"><div class="kv"><span>Quilometragem</span><b>' + esc(e.km) + ' km</b></div><div class="kv"><span>Combustível</span><b>' + esc(e.combustivel) + '</b></div></div>' +
        '<div style="display:flex;flex-direction:column;gap:8px">' +
        (e.pdfUrl ? '<a class="btn pri" href="' + esc(e.pdfUrl) + '" target="_blank" rel="noopener">Abrir termo assinado (PDF)</a>' +
          (linkCliente() ? '<a class="btn sec peq" href="' + esc('https://wa.me/' + telWhats(c.tel) + '?text=' + encodeURIComponent('Olá, ' + c.nome.split(' ')[0] + '! Seu comprovante de entrega do ' + e.carro.modelo + ' (placa ' + e.carro.placa + ') está neste link: ' + linkCliente())) + '" target="_blank" rel="noopener">💬 Mandar comprovante pelo WhatsApp</a>' : '') : '<div class="aviso-foto">O termo em PDF não foi gerado. As fotos e a assinatura estão na pasta.</div>') +
        '<a class="btn sec peq" href="' + esc(e.pastaUrl) + '" target="_blank" rel="noopener">Abrir pasta no Drive</a>' +
        (linkCliente() ? '<a class="btn sec peq" href="' + esc(linkCliente()) + '" target="_blank" rel="noopener">Ver a página do cliente</a>' : '') + '</div>';
    }
    out += '<div class="card"><div class="kv"><span>Cliente</span><b>' + esc(c.nome) + '</b></div>' +
      '<div class="kv"><span>E-mail</span><b>' + esc(c.email || '—') + '</b></div><div class="kv"><span>Celular</span><b>' + esc(c.tel || '—') + '</b></div>' +
      '<div class="kv"><span>Quilometragem</span><b>' + (e.km ? esc(e.km) + ' km' : '—') + '</b></div><div class="kv"><span>Combustível</span><b>' + esc(e.combustivel || '—') + '</b></div></div>';
    if (pend) out += '<div class="aviso-foto">Ainda há ' + pend + ' foto(s) subindo para o Drive. Espere terminar para o cliente ver tudo.</div>';
    if (L.falta && L.falta.length) {
      out += '<div class="aviso-foto"><b>Falta completar:</b><ol class="lista">' + L.falta.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol></div>';
    }
    if (!e.token) {
      out += '<p class="como">O cliente recebe um link, vê todas as fotos, lê os termos e assina com o dedo na tela. Não precisa baixar nada.</p>' +
        '<button class="btn pri" data-l="gerar"' + (pend || L.gerando ? ' disabled' : '') + '>' + (L.gerando ? 'Gerando…' : 'Gerar link do cliente') + '</button>';
      return out;
    }
    var link = linkCliente(), msg = mensagem();
    var mail = 'mailto:' + (c.email || '') + '?subject=' + encodeURIComponent('Checklist de entrega do veículo ' + e.carro.placa) + '&body=' + encodeURIComponent(msg);
    var zap = 'https://wa.me/' + telWhats(c.tel) + '?text=' + encodeURIComponent(msg);
    out += '<div class="card" style="border-color:var(--ouro)"><b class="c-ouro">⏳ Aguardando o cliente assinar</b>' +
      '<p class="como" style="margin:4px 0 8px">Com o cliente do seu lado, toque no botão amarelo e entregue o celular para ele assinar. Depois volte aqui e toque em ⟳ Atualizar: a entrega vira ✅.</p>' +
      '<input type="text" id="linkL" readonly value="' + esc(link) + '"></div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      '<a class="btn pri" href="' + esc(link) + '" target="_blank" rel="noopener">✍️ Cliente assina agora neste celular</a>' +
      '<div class="area" style="margin:10px 0 0">Ou mande para ele assinar depois</div>' +
      '<a class="btn sec peq" href="' + esc(zap) + '" target="_blank" rel="noopener">💬 Enviar por WhatsApp</a>' +
      '<a class="btn sec peq" href="' + esc(mail) + '">📧 Enviar por e-mail</a>' +
      '<button class="btn sec peq" data-l="copiar">📋 Copiar link</button></div>' +
      '<p class="como" style="margin-top:12px">Mudou alguma coisa depois de mandar? Pode editar: o link continua o mesmo e mostra a versão nova até o cliente assinar.</p>';
    return out;
  }
  function gerarLink() {
    if (L.gerando) return;
    if (!navigator.onLine) { toast('Para gerar o link é preciso internet.'); return; }
    L.gerando = true; L.falta = null; atualizar();
    rpc('locGerarLink', L.atual.id).then(function (r) {
      L.gerando = false;
      if (r.falta) { L.falta = r.falta; toast('Ainda falta completar alguns itens.'); }
      else { L.atual = r.entrega; guardarAtual(); carregarBoot(); }
      atualizar();
    }).catch(function (er) { L.gerando = false; toast(er.message); atualizar(); });
  }

  // --- Termos e dados do locador
  function renderTermos() {
    var c = (L.boot && L.boot.config) || {};
    app.innerHTML = topo('Termos e locador', 'Aparecem na página do cliente e no PDF', 'lista') +
      '<main><div class="card">' +
      campo('locador', 'Seu nome ou da empresa (locador)', c.locador) +
      campo('docLocador', 'CPF ou CNPJ do locador', c.docLocador, 'inputmode="numeric"') +
      campo('telLocador', 'Telefone para contato', c.telLocador, 'inputmode="tel"') +
      '<label class="cap" for="ld_termos">Termos que o cliente aceita (um por linha)</label><textarea id="ld_termos" style="min-height:280px">' + esc(c.termos) + '</textarea>' +
      '<p class="como" style="margin:8px 0 0">Mudanças valem para as próximas assinaturas. Quem já assinou fica com o texto do PDF dele.</p>' +
      '</div><button class="btn sec peq" data-l="termosPadrao">Voltar ao texto padrão</button></main>' +
      '<div class="rodape"><div class="dentro"><button class="btn pri" data-l="salvarTermos">Salvar</button></div></div>';
  }
  function salvarTermos(padrao) {
    if (!navigator.onLine) { toast('Para salvar é preciso internet.'); return; }
    var d = {};
    ['locador', 'docLocador', 'telLocador', 'termos'].forEach(function (k) { d[k] = document.getElementById('ld_' + k).value.trim(); });
    if (padrao) d.termos = '';
    rpc('locSalvarConfig', d).then(function (c) {
      L.boot.config = c; gravarLS('gav-loc-boot', L.boot);
      toast(padrao ? 'Texto padrão de volta.' : 'Salvo.');
      if (padrao) renderTermos(); else ir('lista');
    }).catch(function (er) { toast(er.message); });
  }

  // ------------------------------------------------------------ eventos
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-l]');
    if (!b || b.disabled) return;
    var a = b.getAttribute('data-l');
    if (a === 'tentar') { L.erroBoot = ''; render(); return carregarBoot(); }
    if (a === 'ir') return ir(b.getAttribute('data-t'));
    if (a === 'voltar') { var t = b.getAttribute('data-t'); return sairDoItem().then(function () { if (t === 'lista') carregarBoot(); ir(t); }); }
    if (a === 'nova') { L.editando = null; return ir('dados'); }
    if (a === 'editar') { L.editando = L.atual; return ir('dados'); }
    if (a === 'salvarDados') return salvarDados();
    if (a === 'abrir') return abrirEntrega(b.getAttribute('data-id'));
    if (a === 'item') return ir('item', b.getAttribute('data-k'));
    if (a === 'proximo') {
      return sairDoItem().then(function () {
        var l = itens(), i = l.indexOf(item(L.k));
        var y = vi(L.k);
        if (!y.it.opcional && y.estado === 'Avaria' && !y.obs) toast('Lembre de descrever a avaria.');
        if (i < l.length - 1) ir('item', l[i + 1].k); else ir('enviar');
      });
    }
    if (a === 'estado') {
      var novo = vi(L.k).estado === b.getAttribute('data-v') ? '' : b.getAttribute('data-v');
      return sairDoItem().then(function () { return salvarCampos(L.k, { estado: novo }); }).then(renderItem);
    }
    if (a === 'comb') {
      var cb = b.getAttribute('data-v');
      return sairDoItem().then(function () { return salvarCampos(L.k, { combustivel: cb }); }).then(renderItem);
    }
    if (a === 'tirarFoto') {
      var f = b.getAttribute('data-f');
      if (!window.confirm('Apagar esta foto?')) return;
      if (/^foto_/.test(f)) { return del('fila', f).then(recarregarFila).then(function () { del('thumbs', f).catch(function () {}); renderItem(); }); }
      if (!navigator.onLine) { toast('Para apagar uma foto que já subiu é preciso internet.'); return; }
      return rpc('locRemoverFoto', { id: L.atual.id, k: L.k, fotoId: f }).then(function (r) { aplicarItem(L.atual.id, L.k, r.item); renderItem(); })
        .catch(function (er) { toast(er.message); });
    }
    if (a === 'gerar') return gerarLink();
    if (a === 'tirarDoc') {
      if (!window.confirm('Tirar este documento da entrega? Ele vai para a lixeira do Drive.')) return;
      return rpc('locRemoverDoc', { id: L.atual.id, docId: b.getAttribute('data-d') }).then(function (e) { L.atual = e; guardarAtual(); render(); })
        .catch(function (er) { toast(er.message); });
    }
    if (a === 'copiar') {
      var inp = document.getElementById('linkL');
      var feito = function () { toast('Link copiado.'); };
      try { navigator.clipboard.writeText(inp.value).then(feito, function () { inp.select(); document.execCommand('copy'); feito(); }); }
      catch (er) { inp.select(); document.execCommand('copy'); feito(); }
      return;
    }
    if (a === 'salvarTermos') return salvarTermos(false);
    if (a === 'termosPadrao') { if (window.confirm('Trocar os termos pelo texto padrão?')) salvarTermos(true); return; }
  });
  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.matches && el.matches('input[type=file][data-ldoc]')) { var d = el.files && el.files[0]; el.value = ''; return anexarDoc(d); }
    if (el.matches && el.matches('input[type=file][data-lfoto]')) {
      var f = el.files && el.files[0];
      sairDoItem().then(function () { receberFoto(f); });
      el.value = '';
    }
  });
  window.addEventListener('online', function () { processar(); });

  // ------------------------------------------------------------ chamado pelo app.js
  window.Locacao = {
    render: function () {
      if (!L.iniciada) {
        L.iniciada = true;
        abrirDB().then(function () {
          return Promise.all([recarregarFila(), todos('thumbs').then(function (l) { l.forEach(function (x) { L.thumbs[x.k] = x.v; }); })]);
        }).then(function () { render(); processar(); carregarBoot(); });
      }
      render();
    },
    atualizar: atualizar,
    atualizarTudo: function () {
      if (L.atualizando) return;
      L.atualizando = true; atualizar();
      processar();
      var A = window.GA.versao();
      var ver = A ? A.verificar().catch(function () { return null; }) : Promise.resolve(null);
      var ent = L.atual && L.tela !== 'lista' ? rpc('locAbrir', L.atual.id).then(function (e) { L.atual = e; guardarAtual(); }).catch(function () {}) : Promise.resolve();
      Promise.all([ver, carregarBoot(), ent]).then(function (r) {
        L.atualizando = false;
        buscarMinis();
        if (r[0] && r[0].nova) { toast('Versão nova ' + r[0].remota + ' encontrada. Atualizando…'); setTimeout(function () { A.aplicar(); }, 900); return; }
        toast('Tudo atualizado' + (A ? ' (versão ' + A.VERSAO + ')' : '') + '.');
        render();
      });
    }
  };
})();
