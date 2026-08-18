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

// ---------------------------------------------------------------------------
// QUALIFICACAO
// ---------------------------------------------------------------------------
const QUALS = [{ id: 10, name: 'Interessado' }, { id: 11, name: 'Sem interesse' }];

console.log('\n17) Lista chega DURANTE a chamada e vale no fim');
store.local = {}; // sem cache
await aposDial('Q17');
await emitir('call-was-connected', ag(ON_MANUAL_CALL, {
  call: { id: 'Q17', call_mode: 'manual' },
  qualification: { qualifications: QUALS }
}));
checar('capturou a lista', S().qualifications?.length === 2, JSON.stringify(S().qualifications));
checar('gravou no cache da campanha', store.local['quals:7']?.length === 2);
checar('ainda nao pede qualificacao', !S().pendingQualification);

await emitir('manual-call-was-answered', ag(MANUAL_CONNECTED, { call: { id: 'Q17' } }));
await emitir('call-was-finished', ag(MANUAL_ACW, { call: { id: 'Q17' } }));
checar('pede qualificacao', S().pendingQualification === true);
checar('lista disponivel', S().qualifications?.length === 2);

// ---------------------------------------------------------------------------
console.log('\n18) O REQUISITO: proxima chamada NAO recebe a lista, e ainda assim qualifica');
// cache do cenario 17 continua em store.local
await aposDial('Q18');
await emitir('manual-call-was-answered', ag(MANUAL_CONNECTED, { call: { id: 'Q18' } }));
checar('socket nao mandou lista nesta chamada', true);
await emitir('call-was-finished', ag(MANUAL_ACW, { call: { id: 'Q18' } }));
checar('pede qualificacao mesmo assim', S().pendingQualification === true);
checar('lista veio do cache', S().qualifications?.length === 2, JSON.stringify(S().qualifications));

// ---------------------------------------------------------------------------
console.log('\n19) Qualificar libera a proxima ligacao');
let chamou = null;
globalThis.fetch = async (url, opt) => {
  chamou = { url, body: opt?.body };
  return { ok: true, status: 200, text: async () => '{}' };
};
const r19 = await acao('QUALIFY', { qualificationId: 10 });
checar('QUALIFY aceito', r19?.ok === true, JSON.stringify(r19?.error));
checar('endpoint manual', /agent\/manual_call\/Q18\/qualify$/.test(chamou?.url ?? ''), chamou?.url);
checar('corpo sem note (manual)', chamou?.body === '{"qualification_id":10}', chamou?.body);
checar('pendencia limpa', S().pendingQualification === false);
checar('lastCallId limpo', S().lastCallId === null);

// ---------------------------------------------------------------------------
console.log('\n20) Chamada de dialer usa o outro endpoint E manda a nota');
await aposDial('D20');
await emitir('call-was-connected', ag(ON_CALL, { call: { id: 'D20', call_mode: 'dialer' } }));
await emitir('call-was-finished', ag(ACW, { call: { id: 'D20' } }));
checar('pede qualificacao', S().pendingQualification === true);
const r20 = await acao('QUALIFY', { qualificationId: 11 });
checar('QUALIFY aceito', r20?.ok === true, JSON.stringify(r20?.error));
checar('endpoint dialer', /agent\/call\/D20\/qualify$/.test(chamou?.url ?? ''), chamou?.url);
checar('corpo COM note', /"qualification_note":""/.test(chamou?.body ?? ''), chamou?.body);

// ---------------------------------------------------------------------------
console.log('\n21) Fora da janela de ACW: limpa o card em vez de deixar botao morto');
await aposDial('Q21');
await emitir('call-was-finished', ag(MANUAL_ACW, { call: { id: 'Q21' } }));
checar('pede qualificacao', S().pendingQualification === true);
globalThis.fetch = async () => ({
  ok: false, status: 422,
  text: async () => JSON.stringify({ detail: 'chamada não está mais em estado válido para ser qualificada, precisa estar ativa ou em estado acw' })
});
const r21 = await acao('QUALIFY', { qualificationId: 10 });
checar('recusou com mensagem clara', r21?.ok === false && /ACW/.test(r21?.error ?? ''), r21?.error);
checar('card sumiu', S().pendingQualification === false);
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });

// ---------------------------------------------------------------------------
console.log('\n22) Discar com qualificacao pendente e barrado');
await aposDial('Q22');
await emitir('call-was-finished', ag(MANUAL_ACW, { call: { id: 'Q22' } }));
checar('pendencia ativa', S().pendingQualification === true);
const r22 = await acao('DIAL', { phone: '63991221959' });
checar('discagem barrada', r22?.ok === false && /Qualifique/.test(r22?.error ?? ''), r22?.error);

// ---------------------------------------------------------------------------
console.log('\n23) Ramal ocioso NAO some com a pendencia');
await emitir('agent-is-idle', ag(IDLE));
checar('pendencia sobrevive', S().pendingQualification === true);
checar('lastCallId preservado para o POST', S().lastCallId === 'Q22', String(S().lastCallId));

// ---------------------------------------------------------------------------
console.log('\n24) Dispensar limpa sem chamar a API');
chamou = null;
const r24 = await acao('DISMISS_QUAL');
checar('aceito', r24?.ok === true);
checar('nao chamou a API', chamou === null);
checar('pendencia limpa', S().pendingQualification === false);

// ---------------------------------------------------------------------------
// ATIVIDADE NO PIPEDRIVE
// ---------------------------------------------------------------------------

/** Roteador de fetch: 3C Plus responde OK, Pipedrive responde o que o teste quiser. */
function comPipedrive({ atividades = [], aoCriar } = {}) {
  const chamadas = [];
  globalThis.fetch = async (url, opt) => {
    chamadas.push({ url, method: opt?.method ?? 'GET', body: opt?.body });

    if (!String(url).includes('api.pipedrive.com')) {
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (/\/activities\?/.test(url) || /\/activities$/.test(String(url).split('?')[0])) {
      if (opt?.method === 'POST') {
        if (aoCriar) return aoCriar();
        return { ok: true, status: 200, text: async () => '{"success":true,"data":{"id":9001}}' };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ success: true, data: atividades })
      };
    }
    if (/\/deals\/\d+\?/.test(url)) {
      return {
        ok: true, status: 200,
        text: async () => '{"success":true,"data":{"person_id":{"value":555}}}'
      };
    }
    return { ok: true, status: 200, text: async () => '{"success":true,"data":{}}' };
  };
  return chamadas;
}

const criarAtividade = (c) => c.find((x) => x.method === 'POST' && /activities/.test(x.url));

/** Estado tipico logo apos uma chamada encerrada, pronta para qualificar. */
async function prontaParaQualificar(extra = {}) {
  const inicio = Date.UTC(2026, 7, 17, 13, 0, 0);
  store.session.c3plus = {
    token: 't', domain: 'd', campaignId: 7, campaignName: 'Campanha Fernanda',
    userName: 'Fernanda', manualMode: true, callMode: 'manual',
    currentCallId: null, lastCallId: 'CALL-1', callPhone: '63991221959',
    callStatus: 'encerrada', callStatusText: 'Chamada encerrada',
    callStartedAt: null, callTalkStartedAt: inicio, callTalkSeconds: 125,
    callEndedAt: inicio + 125000,
    qualifications: QUALS, pendingQualification: true,
    alvo: { tipo: 'deal', id: 26280 },
    log: [],
    ...extra
  };
}

console.log('\n25) Sem token do Pipedrive: qualifica e nao tenta atividade');
store.local = {};
await prontaParaQualificar();
let ch = comPipedrive();
const r25 = await acao('QUALIFY', { qualificationId: 10 });
checar('qualificou', r25?.ok === true, JSON.stringify(r25?.error));
checar('nao chamou o Pipedrive', !ch.some((x) => /pipedrive/.test(x.url)));

// ---------------------------------------------------------------------------
console.log('\n26) Com token e ficha aberta: cria a atividade');
store.local = { pipedriveToken: 'PD-TOKEN' };
await prontaParaQualificar();
ch = comPipedrive();
const r26 = await acao('QUALIFY', { qualificationId: 10 });
checar('qualificou', r26?.ok === true, JSON.stringify(r26?.error));

const post = criarAtividade(ch);
checar('criou atividade', Boolean(post), 'nenhum POST /activities');
const corpo = post ? JSON.parse(post.body) : {};
checar('vinculou ao negocio', corpo.deal_id === 26280, String(corpo.deal_id));
checar('vinculou a pessoa do negocio', corpo.person_id === 555, String(corpo.person_id));
checar('marcada como concluida', corpo.done === 1);
checar('tipo call', corpo.type === 'call', corpo.type);
// O campo duration do Pipedrive e HH:MM: 125s = 2 minutos.
checar('duracao 00:02 (HH:MM)', corpo.duration === '00:02', corpo.duration);
checar('assunto com desfecho', /^Ligação atendida - /.test(corpo.subject ?? ''), corpo.subject);
checar('nota traz a qualificacao', /Interessado/.test(corpo.note ?? ''));
// Na nota o tempo e legivel, nao HH:MM - "00:02" seria lido como dois segundos.
checar('nota traz o tempo legivel', /2 min 5 s/.test(corpo.note ?? ''), corpo.note);
checar('nota traz a campanha', /Campanha Fernanda/.test(corpo.note ?? ''));
checar('marca VISIVEL da chamada', /ID da chamada na 3C:<\/b> CALL-1/.test(corpo.note ?? ''), corpo.note);
checar('marca NAO e comentario HTML', !/<!--/.test(corpo.note ?? ''));

// ---------------------------------------------------------------------------
console.log('\n27) Dedup: atividade ja lancada nao vira duplicata');
store.local = { pipedriveToken: 'PD-TOKEN' };
await prontaParaQualificar();
ch = comPipedrive({
  atividades: [{ id: 1, note: 'algo<br><b>ID da chamada na 3C:</b> CALL-1' }]
});
const r27 = await acao('QUALIFY', { qualificationId: 10 });
checar('qualificou', r27?.ok === true);
checar('NAO criou segunda atividade', !criarAtividade(ch));

// ---------------------------------------------------------------------------
console.log('\n28) Sem ficha aberta (funil/menu): nao lanca atividade solta');
store.local = { pipedriveToken: 'PD-TOKEN' };
await prontaParaQualificar({ alvo: null });
ch = comPipedrive();
const r28 = await acao('QUALIFY', { qualificationId: 10 });
checar('qualificou', r28?.ok === true);
checar('nao criou atividade', !criarAtividade(ch));

// ---------------------------------------------------------------------------
console.log('\n29) Pipedrive recusando NAO derruba a qualificacao');
store.local = { pipedriveToken: 'PD-TOKEN' };
await prontaParaQualificar();
ch = comPipedrive({
  aoCriar: () => ({ ok: false, status: 401, text: async () => '{"error":"token invalido"}' })
});
const r29 = await acao('QUALIFY', { qualificationId: 10 });
checar('qualificacao sobreviveu', r29?.ok === true, JSON.stringify(r29?.error));
checar('pendencia limpa mesmo assim', S().pendingQualification === false);
checar('erro registrado no log', (S().log ?? []).some((l) => /Pipedrive recusou/.test(l.texto)));

// ---------------------------------------------------------------------------
console.log('\n30) Ficha de pessoa vincula em person_id');
store.local = { pipedriveToken: 'PD-TOKEN' };
await prontaParaQualificar({ alvo: { tipo: 'person', id: 777 } });
ch = comPipedrive();
await acao('QUALIFY', { qualificationId: 11 });
const corpo30 = JSON.parse(criarAtividade(ch)?.body ?? '{}');
checar('vinculou a pessoa', corpo30.person_id === 777, String(corpo30.person_id));
checar('sem deal_id', corpo30.deal_id === undefined, String(corpo30.deal_id));

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });

console.log(falhas ? `\n=== ${falhas} FALHA(S) ===\n` : '\n=== todos os cenarios passaram ===\n');
process.exit(falhas ? 1 : 0);
