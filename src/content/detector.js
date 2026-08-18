// src/content/detector.js
//
// Detector de telefones calibrado para o Pipedrive.
//
// Duas fontes, nesta ordem de confianca:
//
//   1. Links tel:/callto: - o Pipedrive renderiza campo de telefone como
//      ancora. E a fonte confiavel: zero falso positivo, funciona em ficha
//      de pessoa, negocio, organizacao e nas listas.
//
//   2. Regex sobre texto - rede de seguranca para telefone que aparece em
//      nota, descricao de atividade ou campo customizado que nao virou link.
//      Pode gerar falso positivo; desligue em CONFIG.textFallback se incomodar.
//
// Regra que vale ouro: NAO mutar o DOM da pagina. O Pipedrive e React e
// re-renderiza agressivamente - envolver o numero num <span> seria apagado
// (ou entraria em loop de mutacao). Usamos Shadow DOM + botao flutuante,
// entao a pagina hospedeira nunca e tocada.
//
// E nunca usar seletor de classe do Pipedrive: os nomes sao hasheados
// (ex.: .sc-a1b2c3) e mudam a cada release deles.

(() => {
  if (window.__c3plusDetector) return;
  window.__c3plusDetector = true;

  // -------------------------------------------------------------------------
  // Configuracao
  // -------------------------------------------------------------------------

  const CONFIG = {
    // 'right' = botao a direita do numero | 'above' = acima
    position: 'right',

    // Varre tambem o texto solto da pagina, alem dos links tel:.
    textFallback: true,

    // Botao grande fixo no canto inferior direito, so na ficha de lead,
    // negocio, pessoa ou organizacao.
    floatingButton: true
  };

  // So o frame de cima ganha o botao flutuante - senao cada iframe do
  // Pipedrive desenharia o seu, empilhados no mesmo canto.
  const ehTopo = window.top === window;

  // Telefone BR: DDD 11-99 + celular (9XXXX-XXXX) ou fixo (XXXX-XXXX).
  // Seus contatos estao gravados como "(63) 99122-1959", sem +55, mas o
  // prefixo fica aceito para o caso de importacao com codigo de pais.
  const PHONE_RE =
    /(?<![\d])(?:\+?55[\s.-]?)?\(?([1-9][0-9])\)?[\s.-]?(9[0-9]{4}|[2-9][0-9]{3})[\s.-]?([0-9]{4})(?![\d])/g;

  const TEL_LINKS = 'a[href^="tel:"], a[href^="callto:"]';
  const SKIP = '#c3plus-root, script, style, noscript, textarea, code, pre, input, select';

  // Fichas onde o botao flutuante aparece. E URL, nao seletor: a URL do
  // Pipedrive e estavel, as classes nao (sao hasheadas e mudam por release).
  //   /deal/123  /person/123  /organization/123
  //   /leads/inbox/<uuid>  (a lista e /leads/inbox, sem uuid - nao conta)
  const FICHA_RE = /^\/(?:deal|person|organization)\/\d+/i;
  const FICHA_LEAD_RE =
    /^\/leads\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  const emFicha = () => FICHA_RE.test(location.pathname) || FICHA_LEAD_RE.test(location.pathname);

  /**
   * Qual ficha do CRM esta aberta, para a ligacao virar atividade nela.
   *
   * Sai da URL porque e o unico lugar confiavel: e aqui, dentro da pagina, que
   * essa informacao existe - a 3C Plus nao sabe de qual negocio veio uma
   * chamada manual (click2call sai com mailing_data vazio).
   *
   * Lead fica de fora: o id dele e uuid, e a API de atividades quer negocio,
   * pessoa ou organizacao.
   */
  function fichaAberta() {
    const m = /^\/(deal|person|organization)\/(\d+)/i.exec(location.pathname);
    return m ? { tipo: m[1].toLowerCase(), id: Number(m[2]) } : null;
  }

  /** "(63) 99122-1959" | "+55 63 99122-1959" -> "63991221959" */
  function normalize(raw) {
    const d = String(raw ?? '').replace(/\D/g, '');
    const semPais = d.replace(/^55(?=\d{10,11}$)/, '');
    return semPais.length === 10 || semPais.length === 11 ? semPais : null;
  }

  /** "63991221959" -> "(63) 99122-1959" */
  function formatar(d) {
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  }

  // ---------------------------------------------------------------------------
  // Conversa com o service worker
  //
  // Recarregar a extensao em chrome://extensions (ou atualiza-la, ou desliga-la)
  // invalida o contexto de todo content script ja injetado. A pagina continua
  // com os botoes desenhados, mas qualquer chrome.runtime.* dali em diante
  // estoura "Extension context invalidated" - e como sendMessage lanca de forma
  // SINCRONA nesse estado, o .catch() da promise nem chega a rodar.
  //
  // Nao da para reinjetar sozinho: so um F5 recria o content script. Entao o
  // que fazemos e sumir da tela e avisar, em vez de deixar botao fantasma que
  // so joga erro no console.
  // ---------------------------------------------------------------------------

  const RECARREGADA = 'A extensao foi recarregada. Atualize a pagina (F5) para voltar a discar.';

  let morto = false;

  const extensaoViva = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  const pedir = async (type, payload) => {
    if (!extensaoViva()) {
      autodestruir();
      return { ok: false, error: RECARREGADA };
    }
    try {
      return await chrome.runtime.sendMessage({ target: 'sw', type, payload });
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (/context invalidated|receiving end does not exist/i.test(msg)) {
        autodestruir();
        return { ok: false, error: RECARREGADA };
      }
      return { ok: false, error: msg };
    }
  };

  // -------------------------------------------------------------------------
  // Container isolado (Shadow DOM: o CSS do Pipedrive nao afeta o botao)
  // -------------------------------------------------------------------------

  const host = document.createElement('div');
  host.id = 'c3plus-root';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .btn {
        position: fixed;
        z-index: 2147483647;
        display: none;
        align-items: center;
        border: 0;
        border-radius: 4px;
        background: #294ace;
        color: #fff;
        font: 600 11px/1 system-ui, sans-serif;
        padding: 4px 7px;
        cursor: pointer;
        box-shadow: 0 1px 4px rgb(0 0 0 / 25%);
        white-space: nowrap;
      }
      .btn:hover { background: #1f3aa5; }
      .btn[data-busy="1"] { background: #8a8aa3; cursor: default; }

      .fab {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        display: none;
        align-items: center;
        gap: 10px;
        border: 0;
        border-radius: 26px;
        background: #294ace;
        color: #fff;
        padding: 10px 18px 10px 15px;
        font: 13px/1.25 system-ui, sans-serif;
        text-align: left;
        cursor: pointer;
        box-shadow: 0 3px 14px rgb(0 0 0 / 28%);
      }
      .fab.on { display: inline-flex; }
      .fab:hover { background: #1f3aa5; }
      .fab[data-busy="1"] { background: #8a8aa3; cursor: default; }
      .fab-ico { font-size: 15px; }
      .fab-txt { display: flex; flex-direction: column; }
      .fab-acao { font-weight: 600; }
      .fab-num { font-style: normal; font-size: 11px; opacity: 0.85; }
      .fab-num:empty { display: none; }

      .toast {
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
        background: #373753; color: #fff; padding: 10px 16px; border-radius: 6px;
        font: 13px system-ui, sans-serif; max-width: 320px;
        box-shadow: 0 2px 12px rgb(0 0 0 / 30%);
      }
    </style>`;
  document.documentElement.appendChild(host);

  /**
   * @type {{rectOf: () => DOMRect|null, phone: string, fonte: 'link'|'texto',
   *         btn: HTMLButtonElement}[]}
   */
  let items = [];

  // -------------------------------------------------------------------------
  // Botao flutuante
  //
  // Fica SEMPRE no canto inferior direito, em qualquer tela do Pipedrive. Tres
  // caras, nesta ordem de prioridade:
  //
  //   sem sessao            -> "Entrar no 3C Plus", abre a janela do operador;
  //   com telefone na ficha -> disca aquele numero (e mostra qual, para o
  //                            operador conferir antes de clicar);
  //   resto                 -> "Abrir painel".
  //
  // O numero sai SO de link tel:. O fallback de texto continua valendo para os
  // botoezinhos ao lado de cada numero, mas nao para este: ele e um alvo
  // grande e obvio, entao nao pode oferecer palpite de regex sobre nota.
  // -------------------------------------------------------------------------

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.type = 'button';
  fab.innerHTML =
    '<span class="fab-ico">\u{1F4DE}</span>' +
    '<span class="fab-txt"><span class="fab-acao"></span><i class="fab-num"></i></span>';
  const fabAcao = fab.querySelector('.fab-acao');
  const fabNum = fab.querySelector('.fab-num');
  if (CONFIG.floatingButton && ehTopo) shadow.appendChild(fab);

  // null = ainda nao perguntamos ao service worker.
  let logado = null;

  function atualizarFab() {
    if (!CONFIG.floatingButton || !ehTopo) return;
    if (fab.dataset.busy === '1') return; // nao trocar o rotulo no meio da acao

    fab.classList.add('on'); // fica sempre na tela

    // Sem sessao nao ha o que discar: o botao vira porta de entrada do login.
    if (logado === false) {
      fab.dataset.phone = '';
      fabAcao.textContent = 'Entrar no 3C Plus';
      fabNum.textContent = '';
      fab.title = 'Abrir o painel lateral para entrar com seu ramal';
      return;
    }

    // O telefone so e escolhido sozinho na ficha. Numa lista ou no funil, o
    // primeiro link tel: da tela e um contato qualquer - oferecer isso num
    // botao grande seria convidar a ligar para a pessoa errada. Os botoes ao
    // lado de cada numero continuam funcionando normalmente ali.
    const doLink = emFicha() ? items.find((i) => i.fonte === 'link') : null;

    if (doLink) {
      fab.dataset.phone = doLink.phone;
      fabAcao.textContent = 'Ligar';
      fabNum.textContent = formatar(doLink.phone);
      fab.title = `Ligar para ${formatar(doLink.phone)} pela 3C Plus`;
    } else {
      fab.dataset.phone = '';
      fabAcao.textContent = 'Abrir painel';
      fabNum.textContent = '';
      fab.title = 'Abrir o painel lateral da 3C Plus';
    }
  }

  /**
   * Pergunta ao service worker se ha sessao. So booleanos vem de volta - o
   * token nunca chega na pagina do CRM.
   *
   * Chamado em momentos raros de proposito (carga, troca de URL, volta do
   * foco, fim de um clique). Perguntar a cada varredura acordaria o service
   * worker sem parar e ele nunca hibernaria.
   */
  async function atualizarLogin() {
    if (morto || !CONFIG.floatingButton || !ehTopo) return;
    const res = await pedir('UI_STATE');
    if (!res?.ok) return;
    logado = Boolean(res.data?.logado);
    atualizarFab();
  }

  fab.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (fab.dataset.busy === '1') return;

    fab.dataset.busy = '1';
    const phone = fab.dataset.phone;

    // Sem telefone escolhido (ou sem sessao): o botao abre a janela do
    // operador, que e onde da para logar, trocar de campanha e discar a mao.
    if (!phone) {
      const res = await pedir('OPEN_PANEL');
      fab.dataset.busy = '0';

      if (!res?.ok) {
        toast(res?.error ?? 'Nao foi possivel abrir o painel');
      } else if (res.data?.aberto === false) {
        // O Chrome so abre o painel lateral dentro de um gesto do usuario, e
        // as vezes recusa mesmo assim. Ai o icone da extensao resolve.
        toast('Clique no icone da extensao (barra do Chrome) para abrir o painel.');
      }

      atualizarLogin();
      return;
    }

    fabAcao.textContent = 'Discando...';
    const res = await pedir('DIAL', { phone, alvo: fichaAberta() });

    fabAcao.textContent = res?.ok ? 'Chamando' : 'Erro';
    // O service worker ja abre o painel quando falta sessao ou campanha - aqui
    // so contamos o porque.
    if (!res?.ok) toast(res?.error ?? 'Falha ao discar');

    setTimeout(() => {
      fab.dataset.busy = '0';
      atualizarLogin();
      atualizarFab();
    }, 2500);
  });

  // -------------------------------------------------------------------------
  // Coleta
  // -------------------------------------------------------------------------

  function scan() {
    if (morto) return;
    // Checagem barata a cada varredura: assim os botoes somem sozinhos quando
    // a extensao e recarregada, sem esperar o operador clicar num fantasma.
    if (!extensaoViva()) return autodestruir();

    items.forEach((i) => i.btn.remove());
    items = [];

    const vistos = new Set(); // evita dois botoes no mesmo numero/lugar

    // --- 1. Links tel: / callto: (fonte principal no Pipedrive) ---
    for (const a of document.querySelectorAll(TEL_LINKS)) {
      if (a.closest('#c3plus-root')) continue;
      const phone = normalize(decodeURIComponent(a.getAttribute('href').replace(/^\w+:/, '')));
      if (!phone) continue;

      const chave = `${phone}@link`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      items.push({
        phone,
        fonte: 'link',
        rectOf: () => (a.isConnected ? a.getBoundingClientRect() : null),
        btn: makeButton(phone)
      });
    }

    // --- 2. Texto solto (notas, descricoes, campos customizados) ---
    if (CONFIG.textFallback) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !/\d/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
          // ja tratado como link no passo 1
          if (p.closest(TEL_LINKS)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      for (let node; (node = walker.nextNode()); ) {
        PHONE_RE.lastIndex = 0;
        for (let m; (m = PHONE_RE.exec(node.nodeValue)); ) {
          const phone = normalize(m[0]);
          if (!phone) continue;

          const chave = `${phone}@texto`;
          if (vistos.has(chave)) continue;
          vistos.add(chave);

          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);

          items.push({
            phone,
            fonte: 'texto',
            rectOf: () => {
              try {
                return range.getBoundingClientRect();
              } catch {
                return null; // range invalidado por re-render do React
              }
            },
            btn: makeButton(phone)
          });
        }
      }
    }

    place();
    atualizarFab();
  }

  function makeButton(phone) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = 'Ligar';
    btn.title = `Ligar para ${phone} pela 3C Plus`;

    btn.addEventListener('click', async (e) => {
      // O Pipedrive trata clique na linha inteira (abre a ficha) - precisa
      // barrar a propagacao ou a tela muda embaixo do operador.
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.busy === '1') return;

      btn.dataset.busy = '1';
      btn.textContent = '...';

      const res = await pedir('DIAL', { phone, alvo: fichaAberta() });

      btn.textContent = res?.ok ? 'Chamando' : 'Erro';
      if (!res?.ok) {
        btn.title = res?.error ?? 'Falha ao discar';
        toast(res?.error ?? 'Falha ao discar');
      }

      setTimeout(() => {
        btn.dataset.busy = '0';
        btn.textContent = 'Ligar';
        btn.title = `Ligar para ${phone} pela 3C Plus`;
      }, 2500);
    });

    shadow.appendChild(btn);
    return btn;
  }

  // -------------------------------------------------------------------------
  // Posicionamento
  //
  // Separado da coleta de proposito: rolar a pagina so recalcula os rects ja
  // conhecidos. As listas do Pipedrive sao virtualizadas e enormes - revarrer
  // o DOM a cada scroll travaria a tela.
  // -------------------------------------------------------------------------

  function place() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    for (const { rectOf, btn } of items) {
      const rect = rectOf();
      const visivel =
        rect &&
        rect.width > 0 &&
        rect.bottom > 0 &&
        rect.top < vh &&
        rect.right > 0 &&
        rect.left < vw;

      if (!visivel) {
        btn.style.display = 'none';
        continue;
      }

      btn.style.display = 'inline-flex';
      if (CONFIG.position === 'above') {
        btn.style.top = `${rect.top - 24}px`;
        btn.style.left = `${rect.left}px`;
      } else {
        btn.style.top = `${rect.top + rect.height / 2 - 10}px`;
        btn.style.left = `${rect.right + 6}px`;
      }
    }
  }

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    // Sobe o aviso quando o botao flutuante esta ocupando o canto.
    el.style.bottom = fab.classList.contains('on') ? '86px' : '20px';
    shadow.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  let rescanTimer;
  const rescan = () => {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(scan, 350);
  };

  let placeQueued = false;
  const reposition = () => {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      place();
    });
  };

  // O Pipedrive troca de tela sem recarregar a pagina (ficha em slide-over,
  // funil, lista). O MutationObserver pega essas trocas.
  const observer = new MutationObserver(rescan);
  observer.observe(document.body, { childList: true, subtree: true });

  // Rede de seguranca para navegacao que so muda a URL.
  // (Nao da para interceptar history.pushState daqui: o content script roda
  //  num mundo isolado e nao enxerga as chamadas da pagina.)
  let ultimaUrl = location.href;
  const urlTimer = setInterval(() => {
    if (location.href !== ultimaUrl) {
      ultimaUrl = location.href;
      rescan();
      atualizarLogin();
    }
  }, 500);

  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  // Voltar para a aba do CRM depois de logar na janela do operador: e aqui que
  // o rotulo do botao deixa de ser "Entrar no 3C Plus".
  window.addEventListener('focus', atualizarLogin);

  /**
   * Contexto invalidado: tira tudo da tela e para de observar a pagina.
   *
   * O aviso sai antes da remocao do host - depois dele o Shadow DOM esta
   * solto do documento e o toast nao apareceria.
   */
  function autodestruir() {
    if (morto) return;
    morto = true;

    clearTimeout(rescanTimer);
    clearInterval(urlTimer);
    observer.disconnect();
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);

    items.forEach((i) => i.btn.remove());
    items = [];
    fab.classList.remove('on');

    toast(RECARREGADA);
    setTimeout(() => host.remove(), 6500);
  }

  scan();
  atualizarLogin();
})();
