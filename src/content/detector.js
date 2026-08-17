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
    textFallback: true
  };

  // Telefone BR: DDD 11-99 + celular (9XXXX-XXXX) ou fixo (XXXX-XXXX).
  // Seus contatos estao gravados como "(63) 99122-1959", sem +55, mas o
  // prefixo fica aceito para o caso de importacao com codigo de pais.
  const PHONE_RE =
    /(?<![\d])(?:\+?55[\s.-]?)?\(?([1-9][0-9])\)?[\s.-]?(9[0-9]{4}|[2-9][0-9]{3})[\s.-]?([0-9]{4})(?![\d])/g;

  const TEL_LINKS = 'a[href^="tel:"], a[href^="callto:"]';
  const SKIP = '#c3plus-root, script, style, noscript, textarea, code, pre, input, select';

  /** "(63) 99122-1959" | "+55 63 99122-1959" -> "63991221959" */
  function normalize(raw) {
    const d = String(raw ?? '').replace(/\D/g, '');
    const semPais = d.replace(/^55(?=\d{10,11}$)/, '');
    return semPais.length === 10 || semPais.length === 11 ? semPais : null;
  }

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
      .toast {
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
        background: #373753; color: #fff; padding: 10px 16px; border-radius: 6px;
        font: 13px system-ui, sans-serif; max-width: 320px;
        box-shadow: 0 2px 12px rgb(0 0 0 / 30%);
      }
    </style>`;
  document.documentElement.appendChild(host);

  /** @type {{rectOf: () => DOMRect|null, phone: string, btn: HTMLButtonElement}[]} */
  let items = [];

  // -------------------------------------------------------------------------
  // Coleta
  // -------------------------------------------------------------------------

  function scan() {
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

      const res = await chrome.runtime
        .sendMessage({ target: 'sw', type: 'DIAL', payload: { phone } })
        .catch((err) => ({ ok: false, error: err.message }));

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
  new MutationObserver(rescan).observe(document.body, { childList: true, subtree: true });

  // Rede de seguranca para navegacao que so muda a URL.
  // (Nao da para interceptar history.pushState daqui: o content script roda
  //  num mundo isolado e nao enxerga as chamadas da pagina.)
  let ultimaUrl = location.href;
  setInterval(() => {
    if (location.href !== ultimaUrl) {
      ultimaUrl = location.href;
      rescan();
    }
  }, 500);

  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  scan();
})();
