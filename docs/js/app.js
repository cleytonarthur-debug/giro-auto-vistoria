/* app.js — estado, IndexedDB, fila de envio com retry, compressão, polling e as telas
   (lista, item, resultado, conversa e ajustes). Conversa com o servidor (Apps Script) por fetch. */
(function () {
  'use strict';

  var BOOT = null, CK = [], TOTAL = 0, OP = {}, FOTOS_TOTAL = 0;   // vêm do servidor (boot) e ficam guardados
  var ACESSO = null;                                               // {api, k} do link pessoal
  var CHAVE_ACESSO = 'gav-acesso', CHAVE_BOOT = 'gav-boot';
  function aplicarBoot(b) {
    BOOT = b; CK = b.checklist; TOTAL = CK.length; OP = b.operacao;
    FOTOS_TOTAL = CK.filter(function (i) { return !i.semFotos; }).length * 2;
  }
  function lerLS(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function gravarLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem espaço */ } }

  /* Link: https://…/giro-auto-vistoria/#api=<url /exec>&k=<chave>  (o APK abre com ?api=…&k=…) */
  function lerAcesso() {
    var h = location.hash.replace(/^#/, '') || location.search.replace(/^\?/, '');
    var q = new URLSearchParams(h);
    var api = q.get('api'), k = q.get('k');
    if (api && k && /^https:\/\/script\.google\.com\/.+\/exec$/.test(api)) {
      gravarLS(CHAVE_ACESSO, { api: api, k: k });
      history.replaceState(null, '', location.pathname);        // tira a chave da barra de endereço
    }
    return lerLS(CHAVE_ACESSO);
  }
  var ESPERAS = [2000, 5000, 10000];            // backoff das 3 tentativas
  var PAUSA_LONGA = 30000;                      // depois das 3, tenta de novo a cada 30 s (ou ao reconectar)
  var MAX_VIDEO = 20 * 1024 * 1024;

  var S = {
    tela: 'dash', n: 1,
    estado: null,                 // vem do servidor (fonte da verdade)
    local: {},                    // por item: {A:{hash}, B:{hash}, ok:{A,B}}
    thumbs: {},                   // 'n_A' -> dataURL (miniatura local)
    fila: [],                     // cópia em memória da fila do IndexedDB
    enviandoId: null, processando: false, timerFila: null,
    disparados: {}, retentados: {},
    final: null, carregandoFinal: false, chatEnviando: false, erroFinal: ''
  };

  // ------------------------------------------------------------ IndexedDB
  var DB = null, MEM = { fila: {}, thumbs: {}, kv: {} };
  function abrirDB() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('giroauto_vistoria', 1);
        r.onupgradeneeded = function () {
          var d = r.result;
          d.createObjectStore('fila', { keyPath: 'id' });
          d.createObjectStore('thumbs');
          d.createObjectStore('kv');
        };
        r.onsuccess = function () { DB = r.result; res(); };
        r.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }
  function idb(store, modo, fn) {
    if (!DB) return Promise.resolve(fn(null, MEM[store]));
    return new Promise(function (res, rej) {
      var t = DB.transaction(store, modo), st = t.objectStore(store), out;
      var r = fn(st);
      if (r && 'onsuccess' in r) r.onsuccess = function () { out = r.result; };
      t.oncomplete = function () { res(out); };
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error); };
    });
  }
  function put(store, val, key) {
    return idb(store, 'readwrite', function (st, mem) {
      if (mem) { mem[key || val.id] = val; return; }
      return key === undefined ? st.put(val) : st.put(val, key);
    });
  }
  function get(store, key) { return idb(store, 'readonly', function (st, mem) { return mem ? mem[key] : st.get(key); }); }
  function del(store, key) { return idb(store, 'readwrite', function (st, mem) { if (mem) { delete mem[key]; return; } return st.delete(key); }); }
  function todos(store) {
    if (!DB) return Promise.resolve(Object.keys(MEM[store]).map(function (k) { return { k: k, v: MEM[store][k] }; }));
    return new Promise(function (res, rej) {
      var out = [], t = DB.transaction(store, 'readonly');
      var c = t.objectStore(store).openCursor();
      c.onsuccess = function () { var cur = c.result; if (cur) { out.push({ k: cur.key, v: cur.value }); cur.continue(); } };
      t.oncomplete = function () { res(out); };
      t.onerror = function () { rej(t.error); };
    });
  }
  function salvarLocal() { return put('kv', S.local, 'local').catch(function () {}); }

  // ------------------------------------------------------------ servidor
  var TEMPO_MAX = { uploadFoto: 120000, analisarItem: 120000, analisarFinal: 150000, chat: 150000, statusIA: 60000, configurarIA: 60000 };
  function rpc(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (!ACESSO) return Promise.reject(new Error('Sem link de acesso'));
    if (!navigator.onLine) return Promise.reject(new Error('Sem internet'));
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, TEMPO_MAX[fn] || 45000);
    return fetch(ACESSO.api, {
      method: 'POST', redirect: 'follow', signal: ctl ? ctl.signal : undefined,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },     // text/plain: sem pré-verificação CORS
      body: JSON.stringify({ k: ACESSO.k, fn: fn, args: args })
    }).then(function (res) { return res.text(); }).then(function (txt) {
      var d = null;
      try { d = JSON.parse(txt); } catch (e) { /* resposta não é JSON */ }
      if (!d) throw new Error(/<html/i.test(txt) ? 'O servidor respondeu uma página em vez de dados (implantação ou permissão).' : 'Resposta inválida do servidor.');
      if (!d.ok) { var er = new Error(d.message || d.error); er.code = d.error; throw er; }
      return d.r;
    }, function (e) {
      throw new Error(ctl && ctl.signal.aborted ? 'O servidor demorou demais para responder.' : 'Falha de conexão.');
    }).then(function (r) { clearTimeout(timer); return r; }, function (e) {
      clearTimeout(timer);
      if (e.code === 'chave') { S.semAcesso = true; render(); }
      throw e;
    });
  }

  function aplicarItemServidor(it) {
    if (!it || !S.estado) return;
    S.estado.itens[it.n] = it;
  }

  function carregarEstado() {
    return rpc('getEstado').then(function (e) {
      S.estado = e;
      put('kv', e, 'estado').catch(function () {});
      if (e.resumo && !S.final) S.final = e.resumo;
      reconciliar();
      atualizar();
    }).catch(function (err) { console.warn('getEstado', err); atualizar(); });
  }

  // ------------------------------------------------------------ fila de envio
  function recarregarFila() {
    return todos('fila').then(function (l) {
      S.fila = l.map(function (x) { return x.v; }).sort(function (a, b) { return a.ts - b.ts; });
    });
  }
  function fotosPendentes() { return S.fila.filter(function (o) { return o.tipo === 'foto'; }).length; }
  function naFila(n, slot) { return S.fila.some(function (o) { return o.id === n + '_' + slot; }); }

  function enfileirar(op) {
    op.ts = Date.now(); op.tent = 0; op.esperaAte = 0;
    return put('fila', op).then(recarregarFila).then(function () { atualizar(); processarFila(); });
  }

  function processarFila() {
    if (S.processando) return;
    S.processando = true;
    clearTimeout(S.timerFila);
    (function passo() {
      recarregarFila().then(function () {
        var agora = Date.now();
        var op = S.fila.filter(function (o) { return !o.esperaAte || o.esperaAte <= agora; })[0];
        if (!op || !navigator.onLine) {
          S.processando = false; S.enviandoId = null; atualizar();
          var prox = S.fila.reduce(function (m, o) { return Math.min(m, o.esperaAte || agora + 1000); }, Infinity);
          if (prox !== Infinity) S.timerFila = setTimeout(processarFila, Math.max(1000, prox - agora));
          return;
        }
        S.enviandoId = op.id; atualizar();
        executar(op).then(function (it) {
          return get('fila', op.id).then(function (atual) {     // só remove se não foi substituída (Refazer)
            if (atual && atual.ts === op.ts) return del('fila', op.id);
          }).then(recarregarFila).then(function () { posEnvio(op, it); });
        }, function (err) {
          console.warn('envio falhou', op.id, err);
          op.tent = (op.tent || 0) + 1;
          var espera = ESPERAS[op.tent - 1];
          if (!espera) { op.tent = 0; espera = PAUSA_LONGA; }
          op.esperaAte = Date.now() + espera;
          return get('fila', op.id).then(function (atual) { if (atual && atual.ts === op.ts) return put('fila', op); });
        }).then(passo, passo);
      });
    })();
  }

  function executar(op) {
    if (op.tipo === 'foto') {
      return blobParaBase64(op.blob).then(function (b64) {
        return rpc('uploadFoto', { n: op.n, slot: op.slot, base64: b64, mime: op.mime, hash: op.hash, ts: new Date(op.ts).toISOString() });
      }).then(function (r) { aplicarItemServidor(r.item); return r.item; });
    }
    if (op.tipo === 'item') {
      return rpc('salvarItem', op.dados).then(function (it) { aplicarItemServidor(it); return it; });
    }
    return Promise.resolve(null);
  }

  function posEnvio() {
    if (S.estado && !S.estado.pastaUrl) carregarEstado();   // 1ª foto criou a pasta do dia: pega o link dela
    else atualizar();
  }

  function salvarItemFila(n, dados) {
    var id = 'item_' + n;
    return get('fila', id).then(function (atual) {
      var d = Object.assign({}, atual ? atual.dados : {}, dados, { n: n });
      return enfileirar({ id: id, tipo: 'item', n: n, dados: d });
    });
  }

  // ------------------------------------------------------------ análise pelo Claude (grátis)
  // O app não chama IA paga: ele monta a mensagem e abre o app do Claude, que lê a pasta no Drive.
  function reconciliar() { buscarMiniaturas(); }

  function mensagemClaude() {
    var pasta = (S.estado && S.estado.pastaUrl) || '(pasta Vistorias do Giro Auto no meu Drive)';
    var pend = CK.filter(function (c) { return !v(c.n).concluido; }).map(function (c) { return pad(c.n); });
    var pul = CK.filter(function (c) { return v(c.n).pulado; }).map(function (c) { return pad(c.n) + ' (' + v(c.n).motivo + ')'; });
    var meus = CK.filter(function (c) { return v(c.n).statusManual || v(c.n).obs; }).map(function (c) {
      var x = v(c.n); return pad(c.n) + ': ' + (x.statusManual || '') + (x.obs ? ' — ' + x.obs : '');
    });
    return [
      'Sou o Cleyton, projeto Giro Auto. Estou vistoriando o ' + OP.descricao + ' (placa ' + OP.placa + ') para o leilão.',
      'Leia no meu Google Drive a pasta da vistoria: ' + pasta,
      'Comece pelo arquivo _relatorio_final.json e depois veja as fotos (2 por item; a descrição de cada foto diz o item e o ângulo).',
      'Planilha do projeto (premissas na aba Gastos): ' + BOOT.planilhaUrl,
      'Para cada item: OK, Atenção ou Reprovado, nota de 0 a 10, o que você viu e o custo extra de reparo além do já previsto na aba Gastos.',
      'No fim: nota geral (itens críticos com peso 3), veredito (Seguir para o leilão / Seguir com teto reduzido / Desistir do lote), ' +
        'lance máximo pela fórmula da planilha com lucro mínimo de R$ 8.000, e o que eu ainda preciso olhar aqui no pátio.',
      pend.length ? 'Itens ainda sem foto: ' + pend.join(', ') + '.' : '',
      pul.length ? 'Itens pulados: ' + pul.join('; ') + '.' : '',
      meus.length ? 'Minhas anotações: ' + meus.join('; ') + '.' : '',
      'Depois grave o resultado de cada item na aba Visitação (colunas H e I) da planilha.'
    ].filter(String).join('\n');
  }
  function linkClaude() { return 'https://claude.ai/new?q=' + encodeURIComponent(mensagemClaude()); }
  function htmlBotaoClaude(classe, rotulo) {
    return '<a class="btn ' + (classe || 'pri') + '" data-acao="claude" href="' + esc(linkClaude()) + '" target="_blank" rel="noopener">' + (rotulo || 'Analisar com o Claude') + '</a>';
  }

  // Miniaturas que não estão neste celular (ex.: depois de recomeçar ou trocar de aparelho) vêm do Drive
  function buscarMiniaturas() {
    if (!S.estado || !navigator.onLine || S.buscandoMini) return Promise.resolve();
    var faltam = [];
    CK.forEach(function (c) {
      var s = S.estado.itens[c.n] || {};
      ['A', 'B'].forEach(function (sl) { if (s['id' + sl] && !S.thumbs[c.n + '_' + sl]) faltam.push({ n: c.n, slot: sl, id: s['id' + sl] }); });
    });
    if (!faltam.length) return Promise.resolve();
    S.buscandoMini = true;
    return rpc('miniaturas', faltam.slice(0, 24)).then(function (l) {
      (l || []).forEach(function (m) {
        if (!m.data) return;
        S.thumbs[m.n + '_' + m.slot] = m.data;
        put('thumbs', m.data, m.n + '_' + m.slot).catch(function () {});
      });
    }).catch(function () {}).then(function () { S.buscandoMini = false; atualizar(); });
  }

  // Botão Atualizar: puxa versão nova do app, reenvia o que está na fila e relê fotos e dados lançados
  function atualizarTudo() {
    if (S.atualizandoTudo) return;
    if (!navigator.onLine) { toast('Sem internet. As fotos ficam guardadas e sobem quando o sinal voltar.'); return; }
    S.atualizandoTudo = true; atualizar();
    processarFila();
    var versao = window.Atualizacao ? window.Atualizacao.verificar().catch(function () { return null; }) : Promise.resolve(null);
    Promise.all([versao, carregarBoot(), carregarEstado()]).then(function (r) {
      return buscarMiniaturas().then(function () { return r[0]; });
    }).then(function (ver) {
      S.atualizandoTudo = false;
      if (ver && ver.nova) { toast('Versão nova ' + ver.remota + ' encontrada. Atualizando…'); setTimeout(function () { window.Atualizacao.aplicar(); }, 900); return; }
      toast('Tudo atualizado' + (window.Atualizacao ? ' (versão ' + window.Atualizacao.VERSAO + ')' : '') + '.');
      atualizar();
    });
  }

  function emAnalise() {
    if (!S.estado) return false;
    return Object.keys(S.estado.itens).some(function (k) { return S.estado.itens[k].fase === 'analise'; });
  }

  // ------------------------------------------------------------ fotos: compressão
  function blobParaBase64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1]); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function carregarImg(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('imagem inválida')); };
      img.src = url;
    });
  }
  function canvasBlob(cv, q) {
    return new Promise(function (res) { cv.toBlob(res, 'image/jpeg', q); });
  }
  function comprimir(file) {
    var fonte = (window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: 'from-image' })
      : Promise.reject(new Error('sem createImageBitmap'))
    ).catch(function () { return carregarImg(file); });
    return fonte.then(function (src) {
      var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
      var esc = Math.min(1, 1280 / Math.max(w, h));
      var cv = document.createElement('canvas');
      cv.width = Math.round(w * esc); cv.height = Math.round(h * esc);
      cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
      var tc = document.createElement('canvas'), te = 200 / Math.max(cv.width, cv.height);
      tc.width = Math.round(cv.width * te); tc.height = Math.round(cv.height * te);
      tc.getContext('2d').drawImage(cv, 0, 0, tc.width, tc.height);
      var thumb = tc.toDataURL('image/jpeg', 0.6);
      if (src.close) src.close();
      return canvasBlob(cv, 0.72).then(function (b) {
        return b.size > 300 * 1024 ? canvasBlob(cv, 0.6) : b;     // garante ≤ 300 KB
      }).then(function (b) { return { blob: b, thumb: thumb }; });
    });
  }
  function hashBlob(blob) {
    return blob.arrayBuffer().then(function (buf) {
      if (window.crypto && crypto.subtle) {
        return crypto.subtle.digest('SHA-256', buf).then(function (d) {
          return Array.prototype.map.call(new Uint8Array(d), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('').slice(0, 16);
        });
      }
      var a = new Uint8Array(buf), h = 2166136261;
      for (var i = 0; i < a.length; i += 7) { h ^= a[i]; h = Math.imul(h, 16777619); }
      return (h >>> 0).toString(16) + '_' + a.length;
    });
  }

  function receberArquivo(n, slot, file) {
    if (!file) return;
    var video = /^video\//.test(file.type);
    var trabalho;
    if (video) {
      if (file.size > MAX_VIDEO) { toast('Vídeo grande demais (máx. 20 MB). Grave mais curto ou tire uma foto.'); return; }
      trabalho = Promise.resolve({ blob: file, thumb: '' });
    } else {
      toast('Preparando foto…');
      trabalho = comprimir(file);
    }
    trabalho.then(function (r) {
      return hashBlob(r.blob).then(function (h) {
        S.local[n] = S.local[n] || {};
        S.local[n][slot] = { hash: h, video: video, ts: Date.now() };
        S.local[n].ok = S.local[n].ok || {};
        S.local[n].ok[slot] = false;
        if (r.thumb) { S.thumbs[n + '_' + slot] = r.thumb; put('thumbs', r.thumb, n + '_' + slot).catch(function () {}); }
        salvarLocal();
        return enfileirar({ id: n + '_' + slot, tipo: 'foto', n: n, slot: slot, blob: r.blob, mime: r.blob.type || 'image/jpeg', hash: h });
      });
    }).then(function () { toast(video ? 'Vídeo salvo. Enviando…' : 'Foto salva. Enviando…'); })
      .catch(function (e) { console.error(e); toast('Não consegui ler a foto. Tente de novo.'); });
  }

  // ------------------------------------------------------------ visão combinada de um item
  function v(n) {
    var c = CK[n - 1], s = (S.estado && S.estado.itens[n]) || {}, l = S.local[n] || {};
    var filaItem = S.fila.filter(function (o) { return o.id === 'item_' + n; })[0];
    var pend = filaItem ? filaItem.dados : {};
    var r = {
      c: c, s: s,
      temA: !!(s.idA || l.A), temB: !!(s.idB || l.B),
      envA: !!s.idA && !naFila(n, 'A'), envB: !!s.idB && !naFila(n, 'B'),
      pulado: pend.pulado !== undefined ? pend.pulado : !!s.pulado,
      motivo: pend.motivo || s.motivo || '',
      obs: pend.obs !== undefined ? pend.obs : (s.obs || ''),
      statusManual: pend.statusManual !== undefined ? pend.statusManual : (s.statusManual || ''),
      respostas: pend.respostas || s.respostas || {},
      analise: s.fase === 'analise',
      status: s.status === 'Aguardando análise no chat' ? '' : (s.status || ''), nota: s.nota, achados: s.achados || '', precisa: s.precisa || '',
      fotoRuim: s.fotoRuim || ''
    };
    r.statusFinal = ['OK', 'Atenção', 'Reprovado'].indexOf(r.statusManual) >= 0 ? r.statusManual
      : (['OK', 'Atenção', 'Reprovado'].indexOf(r.status) >= 0 ? r.status : '');
    if (c.semFotos) {
      r.concluido = r.pulado || Object.keys(r.respostas).some(function (k) { return String(r.respostas[k] || '').trim(); });
    } else {
      r.concluido = r.pulado || (r.temA && r.temB);
    }
    r.incompleto = !c.semFotos && !r.pulado && (r.temA !== r.temB || s.fase === 'incompleto') && !(r.temA && r.temB);
    return r;
  }

  function emoji(x) {
    if (x.pulado) return '⏭';
    if (x.analise) return '🟡';
    if (x.c.semFotos && x.concluido && !x.statusFinal) return '🟢';
    return { 'OK': '🟢', 'Atenção': '🟠', 'Reprovado': '🔴' }[x.statusFinal] || '⚪';
  }
  function corStatus(st) { return { 'OK': 'c-ok', 'Atenção': 'c-at', 'Reprovado': 'c-rp' }[st] || 'c-2'; }
  function corNota(nt) { if (nt === null || nt === '' || nt === undefined) return 'c-2'; nt = Number(nt); return nt >= 7 ? 'c-ok' : nt >= 5 ? 'c-ouro' : 'c-rp'; }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
  function pad(n) { return ('0' + n).slice(-2); }
  function brl(x) { return 'R$ ' + Math.round(Number(x) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function temNota(x) { return x.nota !== '' && x.nota !== null && x.nota !== undefined; }

  function proximoPendente(depois) {
    for (var i = 0; i < TOTAL; i++) {
      var n = ((depois || 0) + i) % TOTAL + 1;
      if (!v(n).concluido) return n;
    }
    return 0;
  }

  // ------------------------------------------------------------ SVG de posição
  function tipoAngulo(t) {
    t = String(t || '');
    if (/VOLANTE|PAINEL|BANCO|CARPETE|TRILHO|CINTO|PEDAIS|CONSOLE|hodômetro/i.test(t)) return 'interior';
    if (/COFRE|MOTOR|VARETA|TAMPA|RESERVAT|BATERIA|TERMINAIS|CORREIA|MANGUEIRAS|CHICOTE|FILTRO|BLOCO|Fiação|Líquido/i.test(t)) return 'cofre';
    if (/BAIXO|agachado|CHÃO|ESCAPAMENTO|CÁRTER|SOLEIRA/i.test(t)) return 'baixo';
    if (/45°/.test(t)) return '45';
    if (/LATERAL|perfil|PORTAS|LADO/i.test(t)) return 'lateral';
    if (/TRASEIRA|LANTERNAS|PORTA-MALAS|ESTEPE|vigia|TETO/i.test(t)) return 'traseira';
    return 'frente';
  }
  var CAM = '<circle cx="0" cy="0" r="6" fill="currentColor"/><rect x="-9" y="-5" width="18" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>';
  function svgAngulo(t) {
    var tipo = tipoAngulo(t), corpo = '';
    var lado = '<path d="M10 44 L18 30 L40 24 L78 24 L96 32 L110 36 L110 46 L10 46 Z" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
      '<circle cx="32" cy="47" r="7" fill="#0B0E14" stroke="currentColor" stroke-width="2.5"/><circle cx="90" cy="47" r="7" fill="#0B0E14" stroke="currentColor" stroke-width="2.5"/>';
    var frente = '<rect x="30" y="22" width="60" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
      '<path d="M36 22 L42 10 L78 10 L84 22" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
      '<rect x="33" y="48" width="10" height="8" rx="2" fill="currentColor"/><rect x="77" y="48" width="10" height="8" rx="2" fill="currentColor"/>' +
      '<circle cx="40" cy="32" r="4" fill="currentColor"/><circle cx="80" cy="32" r="4" fill="currentColor"/>';
    if (tipo === 'lateral') corpo = lado + '<g transform="translate(60 8)">' + CAM + '</g><path d="M60 15 L60 20" stroke="currentColor" stroke-width="2"/>';
    else if (tipo === 'baixo') corpo = lado + '<g transform="translate(60 62)">' + CAM + '</g><path d="M60 55 L60 50" stroke="currentColor" stroke-width="2"/>';
    else if (tipo === '45') corpo = '<rect x="44" y="8" width="34" height="50" rx="9" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M48 20 L74 20" stroke="currentColor" stroke-width="2"/>' +
      '<g transform="translate(20 6) rotate(-35)">' + CAM + '</g><path d="M28 12 L40 18" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/>';
    else if (tipo === 'interior') corpo = '<circle cx="60" cy="34" r="22" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="60" cy="34" r="6" fill="currentColor"/>' +
      '<path d="M38 34 L54 34 M66 34 L82 34 M60 40 L60 56" stroke="currentColor" stroke-width="3"/>';
    else if (tipo === 'cofre') corpo = '<path d="M14 40 L30 12 L90 12 L106 40" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
      '<rect x="36" y="30" width="48" height="24" rx="3" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M44 30 L44 22 M56 30 L56 22 M68 30 L68 22 M80 30 L80 22" stroke="currentColor" stroke-width="2.5"/>';
    else if (tipo === 'traseira') corpo = frente.replace(/<circle[^>]*>/g, '') + '<rect x="34" y="28" width="12" height="6" rx="2" fill="currentColor"/><rect x="74" y="28" width="12" height="6" rx="2" fill="currentColor"/><rect x="50" y="36" width="20" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>';
    else corpo = frente;
    return '<svg viewBox="0 0 120 70" aria-hidden="true">' + corpo + '</svg>';
  }

  // ------------------------------------------------------------ telas
  var app = document.getElementById('app');

  function navegar(tela, n) {
    S.tela = tela;
    if (n) S.n = n;
    put('kv', { tela: tela, n: S.n }, 'pos').catch(function () {});
    render();
    window.scrollTo(0, 0);
    if (tela === 'final') gerarFinal();
  }

  function topo(titulo, sub, voltar) {
    return '<header class="topo"><div class="linha">' + (voltar ? '<button class="voltar" data-acao="dash">‹ Lista</button>' : '') +
      '<div style="flex:1 1 auto;min-width:0"><div class="marca">' + titulo + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>' +
      (BOOT && ACESSO ? '<button class="atualizar" id="btnAtualizar" data-acao="atualizarTudo" aria-label="Atualizar">' + htmlBtnAtualizar() + '</button>' : '') +
      '</div><div id="pills">' + htmlPills() + '</div></header>';
  }
  function htmlBtnAtualizar() {
    return S.atualizandoTudo ? '<span class="giro"></span><small>Atualizando</small>' : '<span class="ic">⟳</span><small>Atualizar</small>';
  }

  function htmlPills() {
    var pend = fotosPendentes();
    var pills = '';
    if (!navigator.onLine) pills += '<span class="pill off">Sem internet — fotos guardadas no celular</span>';
    if (pend) pills += '<span class="pill alerta">' + (S.enviandoId ? '<span class="giro"></span> ' : '') + pend + (pend === 1 ? ' foto aguardando envio' : ' fotos aguardando envio') + '</span>';
    else if (S.estado) pills += '<span class="pill ok">Tudo enviado</span>';
    if (S.atualizacao && S.atualizacao.nova) pills += '<span class="pill alerta">Versão nova: toque em Atualizar</span>';
    return pills;
  }

  function render() {
    if (S.semAcesso || !ACESSO) return renderSemAcesso();
    if (!BOOT) return renderSemBoot();
    if (S.tela === 'ajustes') return renderAjustes();
    if (S.tela === 'item') return renderItem();
    if (S.tela === 'final') return renderFinal();
    return renderDash();
  }

  /** Atualização "leve" (polling, envio): não apaga o que o usuário está digitando. */
  function atualizar() {
    if (S.semAcesso || !ACESSO || !BOOT) return render();
    if (S.tela === 'ajustes') { var aj = document.getElementById('ajustes'); if (aj) aj.innerHTML = htmlAjustes(); }
    var p = document.getElementById('pills');
    if (S.tela === 'dash') return renderDash();
    if (p) p.innerHTML = htmlPills();
    var ba = document.getElementById('btnAtualizar'); if (ba) ba.innerHTML = htmlBtnAtualizar();
    if (S.tela === 'item') {
      var sl = document.getElementById('slots'); if (sl) sl.innerHTML = htmlSlots(S.n);
      var ia = document.getElementById('ia'); if (ia) ia.innerHTML = htmlIa(S.n);
      var pb = document.getElementById('pulo'); if (pb) pb.innerHTML = htmlPulo(S.n);
    }
    if (S.tela === 'final') { var f = document.getElementById('final'); if (f) f.innerHTML = htmlFinal(); }
  }

  // --- Tela 1: Dashboard
  function renderDash() {
    var feitos = 0, enviadas = 0, html = '', areaAtual = '';
    CK.forEach(function (c) {
      var x = v(c.n);
      if (x.concluido) feitos++;
      enviadas += (x.envA ? 1 : 0) + (x.envB ? 1 : 0);
      if (c.area !== areaAtual) { areaAtual = c.area; html += '<div class="area">' + esc(c.area) + '</div>'; }
      var ds, cls = 'ds';
      if (x.pulado) ds = 'Pulado · ' + esc(x.motivo);
      else if (x.fotoRuim) { ds = 'Refaça a foto: ' + esc(x.fotoRuim); cls += ' aviso'; }
      else if (x.analise) ds = 'Em análise pela IA…';
      else if (x.achados) ds = esc(x.achados);
      else if (x.status) ds = esc(x.status);
      else if (x.incompleto) { ds = 'Incompleto: falta foto'; cls += ' aviso'; }
      else if (c.semFotos) ds = x.concluido ? 'Respondido' : 'Pendente · sem fotos';
      else if (x.temA && x.temB) ds = (x.envA && x.envB) ? 'Fotos enviadas' : 'Fotos na fila de envio';
      else ds = 'Pendente';
      var mini = '';
      if (!c.semFotos) {
        ['A', 'B'].forEach(function (sl) {
          var th = S.thumbs[c.n + '_' + sl];
          mini += th ? '<img src="' + th + '" alt="">' : '<span>' + (x['tem' + sl] ? '' : '') + '</span>';
        });
      }
      html += '<button class="it" data-acao="abrir" data-n="' + c.n + '"><span class="em">' + emoji(x) + '</span>' +
        '<span class="tx"><div class="nm">' + pad(c.n) + ' · ' + esc(c.item) + (c.c ? '<span class="critico">CRÍTICO</span>' : '') + '</div>' +
        '<div class="' + cls + '">' + ds + '</div></span>' +
        '<span class="mini">' + mini + '</span>' +
        (temNota(x) && !x.pulado ? '<span class="nota ' + corNota(x.nota) + '">' + x.nota + '</span>' : '') + '</button>';
    });
    var pend = fotosPendentes();
    var resumo = S.final ? '<div class="card"><div class="lin" style="display:flex;justify-content:space-between;align-items:center;gap:10px">' +
      '<div><div class="c-2" style="font-size:14px">Último resultado</div><div style="font-weight:800;font-size:18px">' + esc(S.final.veredito) + '</div></div>' +
      '<div class="notao ' + corNota(S.final.nota_geral) + '" style="font-size:40px">' + (S.final.nota_geral === null ? '—' : S.final.nota_geral) + '</div></div></div>' : '';
    var y = window.scrollY;
    app.innerHTML = topo('GIRO AUTO · Vistoria · ' + esc(OP.modelo) + ' · ' + esc(OP.placa), esc(OP.descricao), false) +
      '<main><div class="card">' +
      barra('Itens concluídos', feitos, TOTAL) + barra('Fotos enviadas', enviadas, FOTOS_TOTAL) +
      '<div class="prog"><div class="rot"><span>Fotos pendentes de envio</span><b class="' + (pend ? 'c-at' : 'c-ok') + '">' + pend + '</b></div></div>' +
      '</div>' + htmlBannerAtualizacao() + resumo + html + '</main>' +
      '<div class="rodape"><div class="dentro">' +
      '<button class="btn pri" data-acao="continuar">' + (feitos >= TOTAL ? 'Revisar vistoria' : 'Continuar vistoria') + '</button>' +
      '<div class="lado"><button class="btn sec peq" data-acao="final">Finalizar</button>' + htmlBotaoClaude('sec peq', 'Claude') +
      '<button class="btn sec peq" data-acao="ajustes" style="flex:0 0 56px" aria-label="Ajustes">⚙</button></div>' +
      '</div></div>';
    window.scrollTo(0, y);
  }
  function barra(rot, a, b) {
    return '<div class="prog"><div class="rot"><span>' + rot + '</span><b>' + a + '/' + b + '</b></div><div class="barra"><i style="width:' +
      Math.round(100 * a / Math.max(b, 1)) + '%"></i></div></div>';
  }

  // --- Tela 2: Item
  function renderItem() {
    var n = S.n, c = CK[n - 1], x = v(n);
    var corpo;
    if (c.semFotos) {
      corpo = '<div class="card">' + BOOT.perguntas.map(function (q) {
        return '<label class="cap" for="r_' + q.k + '">' + esc(q.label) + '</label><input type="text" id="r_' + q.k + '" data-resp="' + q.k + '" value="' + esc(x.respostas[q.k] || '') + '" autocomplete="off">';
      }).join('') + '</div>';
    } else {
      corpo = '<div class="card angulo">' + svgAngulo(c.a) + '<div class="como" style="margin:0">' + esc(c.a) + '</div></div>' +
        '<div id="slots">' + htmlSlots(n) + '</div>';
    }
    var status = '<div class="card"><label class="cap" style="margin-top:0">Seu resultado (opcional)</label><div class="chips">' +
      [['OK', 'ok'], ['Atenção', 'at'], ['Reprovado', 'rp']].map(function (s) {
        return '<button class="chip ' + s[1] + (x.statusManual === s[0] ? ' on' : '') + '" data-acao="manual" data-v="' + s[0] + '">' + s[0] + '</button>';
      }).join('') + '</div>' +
      '<label class="cap" for="obs">Observação</label><textarea id="obs" maxlength="500" placeholder="Opcional">' + esc(x.obs) + '</textarea></div>';
    app.innerHTML = topo('Item ' + pad(n) + '/' + TOTAL + ' · ' + esc(c.area), '', true) +
      '<main><h1 class="nome">' + esc(c.item) + (c.c ? ' <span class="critico">CRÍTICO</span>' : '') + '</h1>' +
      '<p class="como">' + esc(c.como) + '</p>' +
      '<div id="pulo">' + htmlPulo(n) + '</div>' +
      '<div id="ia">' + htmlIa(n) + '</div>' + corpo + status + '</main>' +
      '<div class="rodape"><div class="dentro"><div class="lado">' +
      '<button class="btn sec" data-acao="pular">Pular item</button>' +
      '<button class="btn pri" data-acao="proximo">' + (n < TOTAL ? 'Próximo ›' : 'Concluir ›') + '</button>' +
      '</div></div></div>';
  }

  function htmlPulo(n) {
    var x = v(n);
    if (!x.pulado) return '';
    return '<div class="faixa">⏭ Item pulado: <b>' + esc(x.motivo) + '</b> <button class="chip" style="min-height:40px;margin-left:6px" data-acao="despular">Desfazer</button></div>';
  }

  function htmlSlots(n) {
    var c = CK[n - 1], x = v(n), l = S.local[n] || {}, out = '';
    ['A', 'B'].forEach(function (sl) {
      var ang = sl === 'A' ? c.a : c.b;
      var accept = (c.aceitaVideo && sl === 'A') ? 'image/*,video/*' : 'image/*';
      var input = '<input type="file" accept="' + accept + '" capture="environment" data-foto="' + sl + '">';
      var tem = x['tem' + sl], th = S.thumbs[n + '_' + sl];
      out += '<div class="slot"><div class="tt">FOTO ' + sl + '</div><div class="ang">' + esc(ang) + '</div>';
      if (!tem) {
        out += '<label class="captura"><span class="ic">📷</span>Tirar foto ' + sl + (accept.indexOf('video') >= 0 ? ' (ou vídeo até 60 s)' : '') + input + '</label>';
      } else {
        var est;
        if (S.enviandoId === n + '_' + sl) est = '<span class="giro"></span> Enviando…';
        else if (naFila(n, sl)) est = '⏳ Guardada no celular, aguardando envio';
        else est = '<span class="c-ok">✓ Enviada ao Drive</span>';
        var ok = l.ok && l.ok[sl];
        var midia = th ? '<img class="foto' + (ok ? ' compacta' : '') + '" src="' + th + '" alt="Foto ' + sl + '">'
          : '<div class="faixa">' + ((l[sl] && l[sl].video) ? '🎥 Vídeo gravado' : '📷 Foto registrada') + '</div>';
        out += midia + '<div class="est">' + est + '</div><div class="acoes">' +
          '<label class="btn sec peq">Refazer' + input + '</label>' +
          (ok ? '' : '<button class="btn pri peq" data-acao="okfoto" data-slot="' + sl + '">OK</button>') + '</div>';
      }
      out += '</div>';
    });
    return out;
  }

  function htmlIa(n) {
    var x = v(n), out = '';
    if (x.fotoRuim) out += '<div class="aviso-foto">⚠️ Refaça a foto: ' + esc(x.fotoRuim) + '</div>';
    if (x.analise) return out + '<div class="card ia"><span class="giro"></span> Analisando com IA… pode seguir para o próximo item.</div>';
    if (!x.status && !temNota(x)) return out;
    if (CK[n - 1].semFotos) return out;
    out += '<div class="card ia"><div class="lin"><span class="st ' + corStatus(x.statusFinal) + '">' + emoji(x) + ' ' + esc(x.statusFinal || x.status) + '</span>' +
      (temNota(x) ? '<span class="nota ' + corNota(x.nota) + '">' + x.nota + '/10</span>' : '') + '</div>' +
      (x.achados ? '<p>' + esc(x.achados) + '</p>' : '') +
      (x.precisa ? '<p class="c-ouro">Precisa ver: ' + esc(x.precisa) + '</p>' : '') +
      (Number(x.s.cmax) ? '<p class="c-2">Reparo extra estimado: ' + brl(x.s.cmin) + ' a ' + brl(x.s.cmax) + '</p>' : '') + '</div>';
    return out;
  }

  function lerCamposItem() {
    var d = {}, n = S.n, x = v(n), c = CK[n - 1];
    var o = document.getElementById('obs');
    if (o && o.value !== x.obs) d.obs = o.value;
    if (c.semFotos) {
      var r = {}, mudou = false;
      BOOT.perguntas.forEach(function (q) {
        var el = document.querySelector('[data-resp="' + q.k + '"]');
        r[q.k] = el ? el.value.trim() : '';
        if (r[q.k] !== (x.respostas[q.k] || '')) mudou = true;
      });
      if (mudou) d.respostas = r;
    }
    return d;
  }

  function sairDoItem(destino) {
    var n = S.n, x = v(n), c = CK[n - 1], d = lerCamposItem();
    var l = S.local[n];
    if (l && l.ok) { l.ok.A = true; l.ok.B = true; salvarLocal(); }    // sair confirma as fotos
    if (!c.semFotos && !x.pulado && !(x.temA && x.temB) && S.estado && (S.estado.itens[n] || {}).fase !== 'incompleto') d.incompleto = true;
    var p = Object.keys(d).length ? salvarItemFila(n, d) : Promise.resolve();
    if (d.incompleto && !(x.temA || x.temB)) toast('Item ' + pad(n) + ' ficou incompleto (sem fotos).');
    else if (d.incompleto) toast('Item ' + pad(n) + ' ficou incompleto (falta 1 foto).');
    p.then(destino);
  }

  // --- Tela 3: Resultado final
  function gerarFinal() {
    if (S.carregandoFinal) return;
    if (!navigator.onLine) { S.erroFinal = 'Sem internet: mostrando o último resultado salvo.'; atualizar(); return; }
    S.carregandoFinal = true; S.erroFinal = ''; atualizar();
    rpc('analisarFinal').then(function (r) {
      S.final = r; if (S.estado) S.estado.resumo = r;
    }).catch(function (e) {
      S.erroFinal = 'Não consegui gerar agora: ' + (e && e.message ? e.message : e);
    }).then(function () { S.carregandoFinal = false; atualizar(); });
  }

  function renderFinal() {
    app.innerHTML = topo('Resultado final', esc(OP.modelo) + ' · ' + esc(OP.placa), true) +
      '<main><div id="final">' + htmlFinal() + '</div></main>' +
      '<div class="rodape"><div class="dentro">' + htmlBotaoClaude('pri') +
      '<button class="btn sec peq" data-acao="dash">Voltar à lista</button></div></div>';
  }

  function htmlFinal() {
    var f = S.final, out = '';
    var pend = fotosPendentes();
    if (pend) out += '<div class="aviso-foto">Ainda há ' + pend + ' foto(s) para enviar. O resultado pode ficar incompleto.</div>';
    if (S.carregandoFinal) out += '<div class="card"><span class="giro"></span> Calculando resultado…</div>';
    if (S.erroFinal) out += '<div class="aviso-foto">' + esc(S.erroFinal) + '</div>';
    if (!f) return out + (S.carregandoFinal ? '' : '<div class="card">Nenhum resultado ainda.</div>');
    var feitos = CK.filter(function (c) { return v(c.n).concluido; }).length;
    var corV = { 'Seguir para o leilão': 'c-ok', 'Seguir com teto reduzido': 'c-ouro', 'Desistir do lote': 'c-rp' }[f.veredito] || 'c-ouro';
    out += '<div class="card" style="text-align:center"><div class="c-2">Vistoria</div><div class="notao c-ouro">' + feitos + '/' + TOTAL + '</div>' +
      '<div class="c-2">itens concluídos</div>' +
      (f.nota_geral !== null ? '<div class="c-2" style="margin-top:10px">Nota geral</div><div class="notao ' + corNota(f.nota_geral) + '" style="font-size:44px">' + f.nota_geral + '</div>' : '') +
      '<div class="veredito ' + corV + '">' + esc(f.veredito) + '</div></div>';
    out += '<div class="card"><p class="como" style="margin-top:0">O relatório completo (itens, fotos e anotações) já está na pasta do Drive. ' +
      'Toque em <b>Analisar com o Claude</b>: ele lê tudo, dá nota a cada item e calcula o lance, sem custo.</p>' +
      '<div class="kv"><span>Lance máximo pela planilha' + (Number(f.custo_extra_max) ? '' : ' (sem reparos extras)') + '</span><b class="c-ouro">' + brl(f.lance_max) + '</b></div>' +
      (Number(f.custo_extra_max) ? '<div class="kv"><span>Custo extra de reparo</span><b>' + brl(f.custo_extra_min) + ' a ' + brl(f.custo_extra_max) + '</b></div>' : '') +
      '</div>';
    out += '<div class="area">O que mais precisa ver</div><div class="card"><ol class="lista">' +
      ((f.precisa_ver || []).length ? f.precisa_ver.slice(0, 12).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') : '<li>Nada pendente</li>') + '</ol></div>';
    [['Reprovados', f.reprovados, 'c-rp'], ['Atenção', f.atencao, 'c-at']].forEach(function (g) {
      if (!g[1] || !g[1].length) return;
      out += '<div class="area">' + g[0] + '</div>';
      g[1].forEach(function (n) {
        var c = CK[n - 1], x = v(n);
        out += '<button class="it" data-acao="abrir" data-n="' + n + '"><span class="em">' + emoji(x) + '</span><span class="tx"><div class="nm">' + pad(n) + ' · ' + esc(c.item) +
          (c.c ? '<span class="critico">CRÍTICO</span>' : '') + '</div><div class="ds">' + esc(x.achados) + '</div>' +
          '<div class="galeria">' + ['A', 'B'].map(function (sl) { var t = S.thumbs[n + '_' + sl]; return t ? '<img src="' + t + '" alt="">' : ''; }).join('') + '</div></span>' +
          (temNota(x) ? '<span class="nota ' + g[2] + '">' + x.nota + '</span>' : '') + '</button>';
      });
    });
    var pasta = S.estado && S.estado.pastaUrl;
    out += '<div class="lado" style="display:flex;gap:8px;margin-top:12px">' +
      (pasta ? '<a class="btn sec peq" href="' + esc(pasta) + '" target="_blank" rel="noopener">Abrir pasta no Drive</a>' : '') +
      '<a class="btn sec peq" href="' + esc(BOOT.planilhaUrl) + '" target="_blank" rel="noopener">Abrir planilha</a></div>';
    return out;
  }

  // --- Sem link / primeira abertura sem internet
  function renderSemAcesso() {
    app.innerHTML = topo('GIRO AUTO · Vistoria', '', false) +
      '<main><div class="card"><h1 class="nome">Abra pelo seu link de acesso</h1>' +
      '<p class="como">Este app só funciona pelo link pessoal que o Claude te enviou (ele contém a sua chave). ' +
      'Abra esse link no Chrome do celular uma vez; depois o app abre sozinho pelo ícone.</p>' +
      (S.semAcesso ? '<div class="aviso-foto">O servidor recusou a chave deste aparelho. Abra o link pessoal de novo.</div>' : '') +
      '</div></main>';
  }
  function renderSemBoot() {
    app.innerHTML = topo('GIRO AUTO · Vistoria', '', false) +
      '<main><div class="card"><h1 class="nome">Preparando o app…</h1>' +
      '<p class="como">Na primeira vez o app precisa de internet para baixar o checklist. Depois ele abre mesmo sem sinal.</p>' +
      (S.erroBoot ? '<div class="aviso-foto">' + esc(S.erroBoot) + '</div><button class="btn pri" data-acao="tentarBoot">Tentar de novo</button>' : '<span class="giro"></span>') +
      '</div></main>';
  }

  // --- Ajustes (versão, atalhos e recomeçar)
  function renderAjustes() {
    app.innerHTML = topo('Ajustes', esc(OP.modelo) + ' · ' + esc(OP.placa), true) +
      '<main id="ajustes">' + htmlAjustes() + '</main>';
  }
  function htmlAjustes() {
    var A = window.Atualizacao, out = '';
    out += '<div class="area">App</div><div class="card"><div class="kv"><span>Versão instalada</span><b>' + esc(A ? A.VERSAO + ' · ' + A.DATA : '—') + '</b></div>' +
      '<p class="como" style="margin:8px 0 0">Para buscar versão nova, fotos e dados, use o botão <b>⟳ Atualizar</b> no topo.</p></div>';

    out += '<div class="area">Atalhos</div><div class="lado" style="display:flex;gap:8px">' +
      (S.estado && S.estado.pastaUrl ? '<a class="btn sec peq" href="' + esc(S.estado.pastaUrl) + '" target="_blank" rel="noopener">Pasta no Drive</a>' : '') +
      '<a class="btn sec peq" href="' + esc(BOOT.planilhaUrl) + '" target="_blank" rel="noopener">Planilha</a></div>';
    out += '<div class="area">Recomeçar</div><div class="card"><p class="como" style="margin-top:0">Apaga os resultados da planilha e do celular ' +
      '(para limpar testes antes da vistoria real). As fotos já enviadas continuam no Drive.</p>' +
      '<button class="btn sec peq" data-acao="zerar"' + (fotosPendentes() ? ' disabled' : '') + '>Recomeçar vistoria</button>' +
      (fotosPendentes() ? '<p class="como" style="margin-top:8px">Espere as fotos pendentes subirem.</p>' : '') + '</div>';
    return out;
  }
  function htmlBannerAtualizacao() {
    if (S.instalar) {
      return '<div class="card" style="border-color:var(--ouro)"><b class="c-ouro">Instale o app no celular</b>' +
        '<p class="como" style="margin:4px 0 0">Fica com ícone na tela inicial e abre mesmo sem sinal no pátio.</p>' +
        '<button class="btn pri peq" style="margin-top:8px" data-acao="instalar">Instalar app</button></div>';
    }
    return '';
  }
  function buscarAtualizacao() {
    if (!window.Atualizacao) return;
    window.Atualizacao.verificar().then(function (r) { S.atualizacao = r; atualizar(); }).catch(function () {});
  }

  function carregarBoot() {
    S.erroBoot = '';
    return rpc('boot').then(function (b) {
      gravarLS(CHAVE_BOOT, b);
      var primeira = !BOOT;
      aplicarBoot(b);
      if (primeira) render();
    }).catch(function (e) {
      if (!BOOT) { S.erroBoot = 'Não consegui baixar o checklist: ' + e.message; render(); }
    });
  }

  // ------------------------------------------------------------ modal pular
  function abrirPulo() {
    var m = document.getElementById('modal');
    m.innerHTML = '<div class="caixa"><h2>Por que pular o item ' + pad(S.n) + '?</h2><div class="chips">' +
      ['Pátio não deixou', 'Sem acesso', 'Não se aplica', 'Outro'].map(function (t) {
        return '<button class="chip" data-acao="motivo" data-v="' + t + '">' + t + '</button>';
      }).join('') + '</div><div id="outro" class="oculto"><label class="cap" for="motivoOutro">Qual motivo?</label><input type="text" id="motivoOutro">' +
      '<button class="btn pri" style="margin-top:8px" data-acao="motivoOutro">Pular item</button></div>' +
      '<button class="btn sec" style="margin-top:12px" data-acao="fecharModal">Cancelar</button></div>';
    m.classList.remove('oculto');
  }
  function fecharModal() { var m = document.getElementById('modal'); m.classList.add('oculto'); m.innerHTML = ''; }
  function pular(motivo) {
    fecharModal();
    var n = S.n, d = lerCamposItem();
    d.pulado = true; d.motivo = motivo;
    salvarItemFila(n, d).then(function () {
      toast('Item ' + pad(n) + ' pulado.');
      irParaProximo();
    });
  }
  function irParaProximo() {
    if (S.n < TOTAL) navegar('item', S.n + 1); else navegar('dash');
  }

  var tToast;
  function toast(t) {
    var el = document.getElementById('toast');
    el.textContent = t; el.classList.remove('oculto');
    clearTimeout(tToast); tToast = setTimeout(function () { el.classList.add('oculto'); }, 2600);
  }

  // ------------------------------------------------------------ eventos
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-acao]');
    if (!b) return;
    var a = b.getAttribute('data-acao');
    if (a === 'abrir') return navegar('item', Number(b.getAttribute('data-n')));
    if (a === 'dash') { if (S.tela === 'item') return sairDoItem(function () { navegar('dash'); }); return navegar('dash'); }
    if (a === 'continuar') { var p = proximoPendente(0); return navegar('item', p || 1); }
    if (a === 'final') return navegar('final');
    if (a === 'ajustes') return navegar('ajustes');
    if (a === 'atualizarTudo') return atualizarTudo();
    if (a === 'claude') {
      // o link abre o app do Claude com a mensagem pronta; a mensagem também vai para a área de transferência
      b.href = linkClaude();
      try { navigator.clipboard.writeText(mensagemClaude()); } catch (e) { /* sem permissão: o link já leva a mensagem */ }
      if (navigator.onLine) rpc('analisarFinal').then(function (r) { S.final = r; }).catch(function () {});   // relatório atualizado no Drive
      toast('Abrindo o Claude com a mensagem pronta. Se ela não aparecer, cole (já está copiada).');
      return;
    }
    if (a === 'instalar' && S.instalar) {
      var ev2 = S.instalar; S.instalar = null;
      ev2.prompt();
      ev2.userChoice.then(function (c) { if (c && c.outcome === 'accepted') toast('Pronto! O ícone Giro Auto vai aparecer na tela inicial.'); atualizar(); });
      return;
    }
    if (a === 'zerar') {
      if (!window.confirm('Apagar todos os resultados desta vistoria (planilha e celular)? As fotos continuam no Drive.')) return;
      rpc('zerarVistoria', 'RECOMECAR').then(function () {
        return Promise.all([
          idb('thumbs', 'readwrite', function (st, mem) { if (mem) { MEM.thumbs = {}; return; } return st.clear(); }),
          del('kv', 'local'), del('kv', 'estado')
        ]);
      }).then(function () { location.reload(); }, function (e) { toast('Não consegui recomeçar: ' + e.message); });
      return;
    }
    if (a === 'aplicarAtualizacao') return window.Atualizacao && window.Atualizacao.aplicar();
    if (a === 'tentarBoot') { S.erroBoot = ''; render(); return carregarBoot().then(function () { if (BOOT) iniciarVistoria(); }); }
    if (a === 'proximo') return sairDoItem(irParaProximo);
    if (a === 'pular') return abrirPulo();
    if (a === 'fecharModal') return fecharModal();
    if (a === 'motivo') {
      var mv = b.getAttribute('data-v');
      if (mv === 'Outro') { document.getElementById('outro').classList.remove('oculto'); document.getElementById('motivoOutro').focus(); return; }
      return pular(mv);
    }
    if (a === 'motivoOutro') { var t = document.getElementById('motivoOutro').value.trim(); return pular(t ? 'Outro: ' + t : 'Outro'); }
    if (a === 'despular') { salvarItemFila(S.n, { pulado: false, motivo: '' }).then(renderItem); return; }
    if (a === 'okfoto') {
      var sl = b.getAttribute('data-slot');
      S.local[S.n] = S.local[S.n] || {}; S.local[S.n].ok = S.local[S.n].ok || {}; S.local[S.n].ok[sl] = true;
      salvarLocal(); atualizar(); return;
    }
    if (a === 'manual') {
      var val = b.getAttribute('data-v'), x = v(S.n);
      var novo = x.statusManual === val ? '' : val;
      salvarItemFila(S.n, { statusManual: novo }).then(function () {
        document.querySelectorAll('[data-acao="manual"]').forEach(function (c) { c.classList.toggle('on', c.getAttribute('data-v') === novo); });
        atualizar();
      });
    }
  });
  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.matches && el.matches('input[type=file][data-foto]')) {
      var f = el.files && el.files[0];
      receberArquivo(S.n, el.getAttribute('data-foto'), f);
      el.value = '';
    }
  });
  window.addEventListener('online', function () { atualizar(); processarFila(); carregarEstado(); });
  window.addEventListener('offline', atualizar);
  window.addEventListener('beforeinstallprompt', function (ev) { ev.preventDefault(); S.instalar = ev; atualizar(); });
  window.addEventListener('appinstalled', function () { S.instalar = null; atualizar(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { processarFila(); carregarEstado(); }
  });

  // Polling a cada 4 s enquanto houver item "em análise"
  setInterval(function () {
    if (BOOT && navigator.onLine && document.visibilityState === 'visible' && emAnalise()) carregarEstado();
  }, 4000);
  // Reconciliação lenta (itens travados, IA ligada depois)
  setInterval(function () { if (BOOT && navigator.onLine && document.visibilityState === 'visible') carregarEstado(); }, 60000);

  // ------------------------------------------------------------ início
  var iniciada = false;
  function iniciarVistoria() {
    if (iniciada) return;
    iniciada = true;
    S.tela = 'dash';
    render();                                   // abre instantâneo com o cache local
    processarFila();                            // reenvia sozinho o que ficou pendente
    carregarEstado();
    buscarAtualizacao();                        // avisa se houver versão nova do app
  }

  // Dentro do APK (Capacitor) a tela vai até o topo: o cabeçalho desce para não ficar sob a barra do relógio
  if (window.Capacitor || /[?&]k=/.test(location.search) || lerLS('gav-apk')) {
    document.documentElement.classList.add('apk');
    gravarLS('gav-apk', !!window.Capacitor || /[?&]k=/.test(location.search) || lerLS('gav-apk'));
  }
  ACESSO = lerAcesso();
  var bootGuardado = lerLS(CHAVE_BOOT);
  if (bootGuardado) aplicarBoot(bootGuardado);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});   // o Android não apaga as fotos guardadas

  abrirDB().then(function () {
    return Promise.all([
      get('kv', 'estado').then(function (e) { if (e) { S.estado = e; if (e.resumo) S.final = e.resumo; } }).catch(function () {}),
      get('kv', 'local').then(function (l) { if (l) S.local = l; }).catch(function () {}),
      todos('thumbs').then(function (l) { l.forEach(function (x) { S.thumbs[x.k] = x.v; }); }).catch(function () {}),
      recarregarFila().catch(function () {})
    ]);
  }).then(function () {
    if (!ACESSO) return render();
    if (BOOT) { iniciarVistoria(); carregarBoot(); return; }   // checklist guardado: abre já, atualiza por trás
    render();
    return carregarBoot().then(function () { if (BOOT) iniciarVistoria(); });
  });
})();
