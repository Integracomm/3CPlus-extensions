// test/painel.mjs — `npm test`
//
// Sobe o painel com um DOM falso e empurra estados do service worker, para
// conferir o que o operador veria na tela.
//
// Existe porque os dois bugs mais recentes foram AQUI, e o outro teste so
// cobre o service worker: cronometro travado em 00:00, e botoes de
// qualificacao mortos a partir da segunda ligacao. Nenhum dos dois aparecia
// num teste de estado - o estado estava certo, a tela e que nao.

// ---------------------------------------------------------------------------
// DOM minimo
// ---------------------------------------------------------------------------

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c)
    };
    this.textContent = '';
    this.disabled = false;
    this.value = '';
    this.onclick = null;
  }
  set innerHTML(v) {
    this._html = v;
    if (v === '') this.children = [];
  }
  get innerHTML() {
    return this._html ?? '';
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  append(...cs) {
    cs.forEach((c) => this.children.push(c));
  }
  remove() {}
  addEventListener() {}
  focus() {}
  querySelectorAll(sel) {
    const alvo = sel.replace(/^\s+|\s+$/g, '');
    const achados = [];
    const anda = (n) => {
      for (const c of n.children) {
        if (alvo === 'button' && c.tagName === 'BUTTON') achados.push(c);
        if (alvo === '.item' && c.classList.contains('item')) achados.push(c);
        anda(c);
      }
    };
    anda(this);
    return achados;
  }
}

const elementos = new Map();
const pegar = (id) => {
  if (!elementos.has(id)) elementos.set(id, new El());
  return elementos.get(id);
};

globalThis.document = {
  getElementById: pegar,
  createElement: (tag) => new El(tag),
  querySelectorAll: (sel) => (sel === 'section' ? [] : [])
};
globalThis.window = { addEventListener() {} };

let aoReceber = null;
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => (aoReceber = fn) },
    sendMessage: async (msg) => respostaDoSw(msg)
  },
  storage: {
    // Com estado de verdade: o token do Pipedrive precisa sobreviver entre
    // renders, que e justamente o que este teste confere.
    local: {
      _d: {},
      async get(k) {
        const chaves = Array.isArray(k) ? k : [k];
        return Object.fromEntries(
          chaves.filter((c) => c in chrome.storage.local._d).map((c) => [c, chrome.storage.local._d[c]])
        );
      },
      async set(obj) {
        Object.assign(chrome.storage.local._d, obj);
      },
      async remove(k) {
        for (const c of Array.isArray(k) ? k : [k]) delete chrome.storage.local._d[c];
      }
    },
    onChanged: { addListener() {} }
  }
};

// O service worker de mentira: responde o que cada cenario mandar.
let respostaDoSw = async () => ({ ok: true, data: null });

const painel = await import('../src/panel/panel.js');
await new Promise((r) => setTimeout(r, 20)); // deixa o IIFE de abertura terminar

const empurrarEstado = async (state) => {
  aoReceber({ target: 'ui', type: 'STATE', state });
  await new Promise((r) => setTimeout(r, 10));
};

let falhas = 0;
const checar = (rotulo, cond, detalhe) => {
  if (cond) return console.log(`  ok    ${rotulo}`);
  falhas++;
  console.log(`  FALHA ${rotulo}${detalhe !== undefined ? ` -> ${detalhe}` : ''}`);
};

const QUALS = [{ id: 10, name: 'Interessado' }, { id: 11, name: 'Sem interesse' }];
const botoes = () => pegar('lista-qualificacoes').children;

const logado = (extra = {}) => ({
  token: 't', domain: 'd', userName: 'Fernanda', extension: '1001',
  campaignId: 7, campaignName: 'Campanha Fernanda', manualMode: true,
  ...extra
});

// ---------------------------------------------------------------------------
console.log('\nP1) Cronometro: sem inicio nao finge 00:00 parado');
await empurrarEstado(logado({ currentCallId: 'C1', callStatus: 'falando', callStatusText: 'Em chamada', callStartedAt: null }));
checar('mostra --:-- em vez de 00:00', pegar('call-timer').textContent === '--:--', pegar('call-timer').textContent);

await empurrarEstado(logado({ currentCallId: 'C1', callStatus: 'falando', callStatusText: 'Em chamada', callStartedAt: Date.now() - 65000 }));
checar('conta a partir do inicio', pegar('call-timer').textContent === '01:05', pegar('call-timer').textContent);

// ---------------------------------------------------------------------------
console.log('\nP2) O BUG: botoes de qualificacao na SEGUNDA ligacao');
await empurrarEstado(logado({
  lastCallId: 'C1', pendingQualification: true, qualifications: QUALS, callEndedAt: Date.now()
}));
checar('card visivel', pegar('card-qualificacao').style.display === '');
checar('dois botoes', botoes().length === 2, String(botoes().length));
checar('botoes habilitados', botoes().every((b) => !b.disabled));

// o operador clica: os botoes travam enquanto envia
respostaDoSw = async () => ({ ok: true, data: logado({ pendingQualification: false }) });
await botoes()[0].onclick();
await new Promise((r) => setTimeout(r, 10));
checar('card escondeu apos qualificar', pegar('card-qualificacao').style.display === 'none');

// SEGUNDA ligacao, MESMA campanha: lista identica, chamada diferente
await empurrarEstado(logado({
  lastCallId: 'C2', pendingQualification: true, qualifications: QUALS, callEndedAt: Date.now()
}));
checar('card voltou', pegar('card-qualificacao').style.display === '');
checar('botoes REDESENHADOS', botoes().length === 2, String(botoes().length));
checar('botoes clicaveis de novo', botoes().every((b) => !b.disabled), JSON.stringify(botoes().map((b) => b.disabled)));
checar('rotulo restaurado', botoes()[0].textContent === 'Interessado', botoes()[0].textContent);

// ---------------------------------------------------------------------------
console.log('\nP3) Redesenho durante a MESMA chamada nao apaga o clique');
const antes = botoes()[0];
await empurrarEstado(logado({
  lastCallId: 'C2', pendingQualification: true, qualifications: QUALS, callEndedAt: Date.now()
}));
checar('mesmo botao preservado', botoes()[0] === antes);

// ---------------------------------------------------------------------------
console.log('\nP4) Falha ao qualificar reabilita os botoes');
respostaDoSw = async () => ({ ok: false, error: 'Agente nao esta ocioso.' });
await botoes()[0].onclick();
await new Promise((r) => setTimeout(r, 10));
checar('botoes reabilitados', botoes().every((b) => !b.disabled));
checar('rotulo restaurado', botoes()[0].textContent === 'Interessado', botoes()[0].textContent);
checar('erro na tela', /ocioso/.test(pegar('notice').textContent), pegar('notice').textContent);

// ---------------------------------------------------------------------------
console.log('\nP5) Sem lista: mostra a explicacao e o escape');
await empurrarEstado(logado({
  lastCallId: 'C3', pendingQualification: true, qualifications: [], callEndedAt: Date.now()
}));
checar('card visivel', pegar('card-qualificacao').style.display === '');
checar('bloco de explicacao visivel', pegar('qual-vazio').style.display === '');
checar('sem botoes de qualificacao', botoes().length === 0, String(botoes().length));

// ---------------------------------------------------------------------------
console.log('\nP6) Discador some com qualificacao pendente');
checar('discador escondido', pegar('card-discador').style.display === 'none');
await empurrarEstado(logado({ pendingQualification: false }));
checar('discador volta', pegar('card-discador').style.display === '');

// ---------------------------------------------------------------------------
console.log('\nP7) Token do Pipedrive: coloca uma vez, fica salvo, da para trocar');
const campo = pegar('in-pd-token');
const chip = pegar('pd-chip');
const btnSalvar = pegar('btn-pd-salvar');
const btnRemover = pegar('btn-pd-remover');

// estado inicial: nada configurado
chrome.storage.local._d = {};
await painel.renderPipedrive();
checar('chip diz nao configurado', chip.textContent === 'não configurado', chip.textContent);
checar('botao Remover escondido', btnRemover.style.display === 'none');
checar('botao diz Salvar', btnSalvar.textContent === 'Salvar', btnSalvar.textContent);

// salvar sem digitar nada e recusado
campo.value = '  ';
await btnSalvar.onclick();
checar('recusa token vazio', /Cole o token/.test(pegar('notice').textContent), pegar('notice').textContent);

// salva de verdade: o service worker valida e grava
respostaDoSw = async (msg) => {
  if (msg.type !== 'PIPEDRIVE_TOKEN') return { ok: true, data: null };
  await chrome.storage.local.set({ pipedriveToken: msg.payload.token, pipedriveUser: 'Fernanda' });
  return { ok: true, data: 'Fernanda' };
};
campo.value = 'PD-TOKEN-1';
await btnSalvar.onclick();
await new Promise((r) => setTimeout(r, 10));
checar('token guardado', chrome.storage.local._d.pipedriveToken === 'PD-TOKEN-1');
checar('chip mostra o usuario', chip.textContent === 'Fernanda', chip.textContent);
checar('botao vira Trocar', btnSalvar.textContent === 'Trocar', btnSalvar.textContent);
checar('botao Remover aparece', btnRemover.style.display === '');

// o segredo nao volta para a tela
checar('campo limpo apos salvar', campo.value === '', campo.value);
checar('placeholder avisa que ja tem', /token salvo/.test(campo.placeholder), campo.placeholder);

// reabrir o painel: continua salvo, sem redigitar
await painel.renderPipedrive();
checar('sobrevive ao reabrir', chip.textContent === 'Fernanda', chip.textContent);
checar('campo segue vazio', campo.value === '');

// trocar por outro
campo.value = 'PD-TOKEN-2';
await btnSalvar.onclick();
await new Promise((r) => setTimeout(r, 10));
checar('token trocado', chrome.storage.local._d.pipedriveToken === 'PD-TOKEN-2');

// remover
await btnRemover.onclick();
await new Promise((r) => setTimeout(r, 10));
checar('token removido', !chrome.storage.local._d.pipedriveToken);
checar('chip volta a nao configurado', chip.textContent === 'não configurado', chip.textContent);
checar('Remover some', btnRemover.style.display === 'none');

console.log(falhas ? `\n=== ${falhas} FALHA(S) NO PAINEL ===\n` : '\n=== painel ok ===\n');
process.exit(falhas ? 1 : 0);
