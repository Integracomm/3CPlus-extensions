// test/ciclo-chamada.mjs — `npm test`
//
// Sobe o service worker com um `chrome` falso e replica sequencias de eventos
// do socket, conferindo o estado depois de cada uma.
//
// Existe porque o ciclo da chamada quebrou varias vezes de formas que so
// apareciam com o ramal na mao. A licao que virou teste: NENHUMA fonte de
// evento e confiavel sozinha. Por isso os cenarios 2, 3 e 4 rodam o ciclo
// inteiro com apenas UMA das fontes disponivel - cada uma tem que sustentar o
// ciclo por conta propria.
//
// Cobre a MAQUINA DE ESTADOS, nao a API da 3C Plus: fetch e stub.

const store = { session: {}, local: {} };
let onMessage = null;
const areaFake = (nome) => ({
  async get(k) {
    if (k === null || k === undefined) return { ...store[nome] };
    if (typeof k === 'string') return k in store[nome] ? { [k]: store[nome][k] } : {};
    return Object.fromEntries(Object.keys(k).map((x) => [x, store[nome][x]]));
  },
  async set(obj) { Object.assign(store[nome], obj); },
  async remove(k) { delete store[nome][k]; }
});

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { onMessage = fn; } },
    sendMessage: async () => ({}),
    getURL: (p) => `chrome-extension://x/${p}`
  },
  contextMenus: { create() {}, onClicked: { addListener() {} } },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  windows: {
    onRemoved: { addListener() {} },
    create: async () => ({ id: 1 }),
    update: async () => {},
    getLastFocused: async () => ({ left: 0, top: 0, width: 1280 })
  },
  offscreen: {
    hasDocument: async () => true,
    createDocument: async () => {},
    closeDocument: async () => {}
  },
  tabs: { create: async () => {} },
  storage: { session: areaFake('session'), local: areaFake('local') }
};
// A API responde OK por padrao: aqui o que importa e o estado resultante, nao
// o payload. Cenarios que precisam de resposta especifica trocam isto.
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"data":{}}' });

await import('../src/background/service-worker.js');

const S = () => store.session.c3plus ?? {};

/** Evento vindo do socket (via offscreen). */
const emitir = async (event, data) => {
  onMessage({ type: 'SOCKET_EVENT', event, data }, {}, () => {});
  await new Promise((r) => setTimeout(r, 25)); // deixa a cadeia de awaits terminar
};

/** Acao disparada pelo painel (o operador clicando). */
const acao = (type, payload) =>
  new Promise((resolve) => onMessage({ target: 'sw', type, payload }, {}, resolve));

// Valores de AGENT_STATUS (src/lib/events.js)
const IDLE = 1, ON_CALL = 2, ACW = 3, ON_MANUAL_CALL = 4, MANUAL_CONNECTED = 5, MANUAL_ACW = 21;

/** Evento COM estado do agente. */
const ag = (status, extra = {}) => ({ agent: { id: 1, status }, ...extra });
/** Evento SEM estado do agente - so os dados da chamada. */
const so = (extra = {}) => ({ ...extra });

let falhas = 0;
const checar = (rotulo, cond, detalhe) => {
  if (cond) return console.log(`  ok    ${rotulo}`);
  falhas++;
  console.log(`  FALHA ${rotulo}${detalhe !== undefined ? ` -> ${detalhe}` : ''}`);
};

/** Como o /dial deixa a sessao antes do primeiro evento. */
async function reset(base = {}) {
  store.session.c3plus = {
    token: 't', domain: 'd', campaignId: 7, manualMode: true,
    currentCallId: null, lastCallId: null,
    callStatus: null, callStatusText: null, callStartedAt: null, callEndedAt: null,
    log: [],
    ...base
  };
}
const aposDial = (id = 'C1') => reset({ currentCallId: id, lastCallId: id, dialingTo: '63991221959' });

// ---------------------------------------------------------------------------
console.log('\n1) Fluxo completo: as duas fontes chegando');
await aposDial();
await emitir('call-was-connected', ag(ON_MANUAL_CALL, { call: { id: 'C1', call_mode: 'manual', phone: '63991221959' } }));
checar('status = chamando', S().callStatus === 'chamando', S().callStatus);
checar('cronometro ainda nao comecou', !S().callStartedAt);

await emitir('manual-call-was-answered', ag(MANUAL_CONNECTED, { call: { id: 'C1' } }));
checar('status = falando', S().callStatus === 'falando', S().callStatus);
checar('cronometro comecou', Boolean(S().callStartedAt));

const t0 = S().callStartedAt;
await emitir('manual-call-was-answered', ag(MANUAL_CONNECTED, { call: { id: 'C1' } }));
checar('evento repetido NAO reinicia o cronometro', S().callStartedAt === t0);

await emitir('call-was-finished', ag(MANUAL_ACW, { call: { id: 'C1' } }));
checar('status = encerrada', S().callStatus === 'encerrada', S().callStatus);
checar('cronometro parou', S().callStartedAt === null);
checar('sem chamada ativa', S().currentCallId === null, String(S().currentCallId));

// ---------------------------------------------------------------------------
console.log('\n2) SO eventos de chamada (agent.status nunca vem)');
await aposDial('C2');
await emitir('call-was-connected', so({ call: { id: 'C2', call_mode: 'manual' } }));
checar('status = chamando', S().callStatus === 'chamando', S().callStatus);
await emitir('manual-call-was-answered', so({ call: { id: 'C2' } }));
checar('status = falando', S().callStatus === 'falando', S().callStatus);
checar('cronometro rodando', Boolean(S().callStartedAt));
await emitir('call-was-finished', so({ call: { id: 'C2' } }));
checar('status = encerrada', S().callStatus === 'encerrada', S().callStatus);
checar('cronometro parou', S().callStartedAt === null);

// ---------------------------------------------------------------------------
console.log('\n3) SO agent.status (nenhum evento de chamada chega)');
await aposDial('C3');
await emitir('agent-is-acw', ag(MANUAL_CONNECTED)); // nome do evento nao importa
checar('status = falando', S().callStatus === 'falando', S().callStatus);
checar('cronometro rodando', Boolean(S().callStartedAt));
await emitir('agent-is-acw', ag(MANUAL_ACW));
checar('detectou o fim', S().currentCallId === null, String(S().currentCallId));
checar('status NAO ficou preso em falando', S().callStatus === 'encerrada', S().callStatus);
checar('cronometro parou', S().callStartedAt === null);

// ---------------------------------------------------------------------------
console.log('\n4) O BUG RELATADO: atende e desliga sem call-was-finished');
await aposDial('C4');
await emitir('manual-call-was-answered', ag(MANUAL_CONNECTED, { call: { id: 'C4' } }));
checar('em chamada', S().callStatus === 'falando', S().callStatus);
checar('cronometro rodando', Boolean(S().callStartedAt));
await emitir('agent-is-acw', ag(MANUAL_ACW)); // unico aviso de que acabou
checar('saiu de "em chamada"', S().callStatus !== 'falando', S().callStatus);
checar('cronometro parou', S().callStartedAt === null);
checar('botao desligar some', S().currentCallId === null);

// ---------------------------------------------------------------------------
console.log('\n5) agent.status como STRING ("5" em vez de 5)');
await aposDial('C5');
await emitir('manual-call-was-answered', ag('5', { call: { id: 'C5' } }));
checar('reconheceu o status string', S().agentStatusText === 'ON_MANUAL_CALL_CONNECTED', S().agentStatusText);
checar('em chamada', S().callStatus === 'falando', S().callStatus);

// ---------------------------------------------------------------------------
console.log('\n6) Nao atendida: desfecho especifico sobrevive ao ACW generico');
await aposDial('C6');
await emitir('call-was-not-answered', so({ call: { id: 'C6' }, reason: 'no answer' }));
checar('status = nao-atendida', S().callStatus === 'nao-atendida', S().callStatus);
await emitir('agent-is-acw', ag(MANUAL_ACW));
checar('ACW nao sobrescreveu', S().callStatus === 'nao-atendida', S().callStatus);
await emitir('call-history-was-created', ag(MANUAL_ACW, { call: { id: 'C6' } }));
checar('evento tardio nao sobrescreveu', S().callStatus === 'nao-atendida', S().callStatus);

// ---------------------------------------------------------------------------
console.log('\n7) Falhou e caixa postal');
await aposDial('C7');
await emitir('call-was-failed', so({ call: { id: 'C7' }, reason: 'circuit busy' }));
checar('status = falhou', S().callStatus === 'falhou', S().callStatus);
checar('motivo guardado', S().callStatusDetail === 'circuit busy', S().callStatusDetail);

await aposDial('C7b');
await emitir('call-was-failed', so({ call: { id: 'C7b' }, reason: 'voicemail detected' }));
checar('status = caixa', S().callStatus === 'caixa', S().callStatus);

// ---------------------------------------------------------------------------
console.log('\n8) Ramal ocioso libera o ramal, mas o desfecho fica na tela');
await reset({ lastCallId: 'C8', callEndedAt: Date.now(), callStatus: 'encerrada', callStatusText: 'Chamada encerrada' });
await emitir('agent-is-idle', ag(IDLE));
checar('lastCallId limpo', S().lastCallId === null, String(S().lastCallId));
checar('cronometro parado', S().callStartedAt === null);
// De proposito: o operador precisa ler o que aconteceu. Quem limpa e o proximo dial().
checar('desfecho preservado', S().callStatusText === 'Chamada encerrada', S().callStatusText);

// ---------------------------------------------------------------------------
console.log('\n9) Chamada de dialer: conectou = ja falando');
await aposDial('D9');
await emitir('call-was-connected', ag(ON_CALL, {
  call: { id: 'D9', call_mode: 'dialer', phone: '1133334444' },
  mailing: { nome: 'Fulano' }
}));
checar('status = falando', S().callStatus === 'falando', S().callStatus);
checar('cronometro rodando', Boolean(S().callStartedAt));
checar('modo dialer', S().callMode === 'dialer', S().callMode);
checar('mailing guardado', Boolean(S().mailing));
await emitir('call-was-finished', ag(ACW, { call: { id: 'D9' } }));
checar('encerrou', S().currentCallId === null && S().callStatus === 'encerrada');

// ---------------------------------------------------------------------------
console.log('\n10) Socket manda outro call id: o do /dial vence');
await aposDial('DIAL-10');
await emitir('call-was-connected', ag(MANUAL_CONNECTED, { call: { id: 'OUTRO-99', call_mode: 'manual' } }));
checar('id do /dial preservado', S().lastCallId === 'DIAL-10', String(S().lastCallId));

// ---------------------------------------------------------------------------
console.log('\n11) Ordem invertida: ACW chega ANTES do call-was-finished');
await aposDial('C11');
await emitir('manual-call-was-answered', ag(MANUAL_CONNECTED, { call: { id: 'C11' } }));
const fim0 = (await emitir('agent-is-acw', ag(MANUAL_ACW)), S().callEndedAt);
checar('marcou o fim', Boolean(fim0));
await emitir('call-was-finished', ag(MANUAL_ACW, { call: { id: 'C11' } }));
checar('nao remarcou o fim', S().callEndedAt === fim0);
checar('segue encerrada', S().callStatus === 'encerrada', S().callStatus);

// ---------------------------------------------------------------------------
console.log('\n12) Destino recusa: evento de fim COM agent.status atrasado');
await aposDial('C12');
await emitir('call-was-connected', ag(ON_MANUAL_CALL, { call: { id: 'C12', call_mode: 'manual' } }));
checar('status = chamando', S().callStatus === 'chamando', S().callStatus);
// o payload do fim ainda diz ON_MANUAL_CALL - status do agente atrasado
await emitir('call-was-not-answered', ag(ON_MANUAL_CALL, { call: { id: 'C12' }, reason: 'rejected' }));
checar('status = nao-atendida', S().callStatus === 'nao-atendida', S().callStatus);
checar('NAO voltou para chamando', S().callStatusText !== 'Chamando...', S().callStatusText);
checar('sem chamada ativa', S().currentCallId === null, String(S().currentCallId));
// e um evento posterior, ainda atrasado, tambem nao pode ressuscitar
await emitir('call-history-was-created', ag(ON_MANUAL_CALL, { call: { id: 'C12' } }));
checar('segue nao-atendida', S().callStatus === 'nao-atendida', S().callStatus);

// ---------------------------------------------------------------------------
console.log('\n13) Destino recusa e so chega agent-is-idle (sem ACW)');
await aposDial('C13');
await emitir('call-was-connected', ag(ON_MANUAL_CALL, { call: { id: 'C13', call_mode: 'manual' } }));
checar('status = chamando', S().callStatus === 'chamando', S().callStatus);
await emitir('agent-is-idle', ag(IDLE));
checar('saiu de chamando', S().callStatus !== 'chamando', S().callStatus);
checar('virou nao-atendida', S().callStatus === 'nao-atendida', S().callStatus);
checar('sem chamada ativa', S().currentCallId === null, String(S().currentCallId));
checar('desfecho fica na tela', Boolean(S().callStatusText), String(S().callStatusText));

// ---------------------------------------------------------------------------
console.log('\n14) Discagem nova reabre o ciclo depois de um desfecho');
// simula o que o dial() grava por cima do estado terminal do cenario 13
await reset({
  currentCallId: 'C14', lastCallId: 'C14', dialingTo: '63991221959',
  callStatus: 'discando', callStatusText: 'Discando...', callEndedAt: null
});
await emitir('call-was-connected', ag(ON_MANUAL_CALL, { call: { id: 'C14', call_mode: 'manual' } }));
checar('ciclo recomecou', S().callStatus === 'chamando', S().callStatus);
await emitir('manual-call-was-answered', ag(MANUAL_CONNECTED, { call: { id: 'C14' } }));
checar('atendeu', S().callStatus === 'falando', S().callStatus);
checar('cronometro rodando', Boolean(S().callStartedAt));

// ---------------------------------------------------------------------------
console.log('\n15) Operador desliga PELA EXTENSAO (socket nao avisa nada)');
await aposDial('C15');
await emitir('manual-call-was-answered', ag(MANUAL_CONNECTED, { call: { id: 'C15' } }));
checar('em chamada', S().callStatus === 'falando', S().callStatus);
checar('cronometro rodando', Boolean(S().callStartedAt));

const r15 = await acao('HANGUP');
checar('HANGUP aceito', r15?.ok === true, JSON.stringify(r15));
checar('status = encerrada', S().callStatus === 'encerrada', S().callStatus);
checar('cronometro parou', S().callStartedAt === null);
checar('sem chamada ativa', S().currentCallId === null, String(S().currentCallId));
checar('marcou o fim', Boolean(S().callEndedAt));

// evento tardio (se vier) nao pode reabrir nem remarcar
const fim15 = S().callEndedAt;
await emitir('call-was-finished', ag(MANUAL_ACW, { call: { id: 'C15' } }));
checar('evento tardio nao remarcou o fim', S().callEndedAt === fim15);
checar('segue encerrada', S().callStatus === 'encerrada', S().callStatus);

// ---------------------------------------------------------------------------
console.log('\n16) Desligar sem chamada ativa e recusado');
await reset();
const r16 = await acao('HANGUP');
checar('recusou com mensagem', r16?.ok === false && /Nenhuma chamada/.test(r16?.error ?? ''), JSON.stringify(r16));

console.log(falhas ? `\n=== ${falhas} FALHA(S) ===\n` : '\n=== todos os cenarios passaram ===\n');
process.exit(falhas ? 1 : 0);
