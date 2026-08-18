// src/background/service-worker.js
//
// Roteador central da extensao. Responsabilidades:
//  1. executar TODAS as chamadas REST (host_permissions mata o CORS);
//  2. criar/destruir o offscreen document, que segura SIP + WebSocket;
//  3. receber os eventos do socket vindos do offscreen, atualizar o estado
//     e repassar para o painel do operador.
//
// Ele hiberna quando ocioso - por isso nenhum estado vive em variavel de
// modulo, so em chrome.storage.session.

import { api } from '../lib/api.js';
import { pipedrive, campoDoAlvo } from '../lib/pipedrive.js';
import { montarAtividade, jaLancada } from '../lib/atividade.js';
import { Session, Prefs, Windows } from '../lib/storage.js';
import { EV, AGENT_STATUS } from '../lib/events.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'c3-dial-selection',
    title: 'Ligar para "%s" (3C Plus)',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'c3-dial-selection') return;
  const phone = (info.selectionText || '').replace(/\D/g, '');
  // { tab } imita o shape do sender: e o que abrirPainel precisa para saber
  // em qual janela do navegador encaixar o painel lateral.
  if (phone.length >= 10) dial(phone, { tab }).catch((e) => notifyUI('error', e.message));
});

// ---------------------------------------------------------------------------
// Painel do operador (side panel) e janela do microfone
//
// O painel e o side panel nativo do Chrome: fica encaixado na lateral, ao lado
// do CRM, e acompanha a janela do navegador. Clicar no icone da extensao abre
// e fecha.
//
// O microfone NAO pode ser side panel nem popup: a bolha de permissao do
// Chrome ancora embaixo da barra de endereco. Sem barra de endereco nao ha onde
// ancorar, a bolha nunca aparece e o getUserMedia devolve NotAllowedError como
// se o operador tivesse clicado em Bloquear. Por isso ela e uma janela
// 'normal', pequena, mas com barra de endereco.
// ---------------------------------------------------------------------------

const MIC = { name: 'mic', path: 'src/permission/mic.html', tipo: 'normal', width: 520, height: 620 };

// Clicar no icone da extensao abre o painel lateral.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('[3c] side panel:', e));

/**
 * Abre o painel lateral.
 *
 * chrome.sidePanel.open() exige gesto do usuario. Todos os caminhos que chegam
 * aqui vem de um clique (botao na pagina, item do menu de contexto), entao a
 * janela de gesto esta valida - mas se o Chrome recusar mesmo assim, nao
 * quebramos o fluxo: o operador ainda tem o icone da extensao.
 */
async function abrirPainel(sender) {
  const windowId = sender?.tab?.windowId;
  try {
    await chrome.sidePanel.open(windowId != null ? { windowId } : {});
    return true;
  } catch (e) {
    await logar('aviso', 'Nao consegui abrir o painel lateral', e?.message);
    return false;
  }
}

/** Abre a janela do microfone, ou foca a que ja estiver aberta. */
async function openPopup(spec) {
  const known = await Windows.get(spec.name);
  if (known !== null) {
    try {
      await chrome.windows.update(known, { focused: true, drawAttention: true });
      return known;
    } catch {
      // Ja foi fechada e o onRemoved nao chegou (worker hibernado). Segue.
      await Windows.clear(spec.name);
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(spec.path),
    type: spec.tipo ?? 'popup',
    focused: true,
    width: spec.width,
    height: spec.height,
    ...(await cantoDireito(spec))
  });

  await Windows.set(spec.name, win.id);
  return win.id;
}

/** Encosta no canto superior direito do navegador. */
async function cantoDireito({ width }) {
  try {
    const w = await chrome.windows.getLastFocused();
    return {
      left: Math.max(0, (w.left ?? 0) + (w.width ?? 1280) - width - 24),
      top: Math.max(0, (w.top ?? 0) + 72)
    };
  } catch {
    return {}; // Chrome decide onde por
  }
}

chrome.windows.onRemoved.addListener(async (id) => {
  const name = await Windows.nameOf(id);
  if (name) await Windows.clear(name);
});

// ---------------------------------------------------------------------------
// Offscreen document (SIP + socket)
// ---------------------------------------------------------------------------

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WEB_RTC'],
    justification:
      'Manter a conexao SIP e o WebSocket da 3C Plus ativos durante o turno do operador.'
  });
}

async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

const toOffscreen = (msg) =>
  chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});

/** Broadcast para o painel do operador (se estiver aberto). */
const toUI = (msg) => chrome.runtime.sendMessage({ target: 'ui', ...msg }).catch(() => {});

const notifyUI = (level, text) => toUI({ type: 'NOTICE', level, text });
const pushState = async () => toUI({ type: 'STATE', state: await Session.get() });

// ---------------------------------------------------------------------------
// Leitura defensiva do que a 3C Plus devolve
// ---------------------------------------------------------------------------

/**
 * A 3C Plus as vezes manda o ramal como string ("1001") e as vezes como
 * objeto ({ id, extension, ... }). Sem isso o painel escreve
 * "ramal [object Object]".
 */
function textoDe(v, nivel = 0) {
  if (v == null || nivel > 3) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'object') return null;

  for (const k of ['extension', 'extension_number', 'number', 'name', 'label', 'value', 'id']) {
    const achado = textoDe(v[k], nivel + 1);
    if (achado) return achado;
  }
  return null;
}

/** Primeiro texto legivel que sirva de motivo, dentro do payload do evento. */
function motivoDe(data) {
  const cand = [
    data?.reason,
    data?.message,
    data?.cause,
    data?.hangup_cause,
    data?.status_description,
    data?.call?.hangup_cause,
    data?.call?.status_description,
    data?.call?.reason,
    data?.call?.status
  ];
  for (const c of cand) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

// Os payloads da 3C Plus carregam api_token do agente. O log fica visivel no
// painel e gravado em storage, entao nada de segredo passa por aqui.
const SEGREDO_RE = /token|password|senha|secret|authorization|api_key/i;

/** Resumo curto do payload, para a lista de eventos do painel. */
function resumo(data) {
  const m = motivoDe(data);
  if (m) return m;
  try {
    const s = JSON.stringify(data, (k, v) => (SEGREDO_RE.test(k) ? '[oculto]' : v));
    return s && s !== '{}' && s !== 'null' ? s.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/**
 * Procura a lista de qualificacoes dentro do payload.
 *
 * O lugar muda conforme o evento (data.qualifications, data.qualification.
 * qualifications, dentro de data.call...), entao em vez de fixar um caminho
 * procuramos um array de {id, name} sob chaves de qualificacao.
 *
 * Basta id + name por item. Exigir que TODOS batessem descartava a lista
 * inteira por causa de um item fora do formato.
 */
function qualificacoesDe(data, nivel = 0) {
  if (!data || typeof data !== 'object' || nivel > 4) return null;

  if (Array.isArray(data)) {
    const validos = data.filter((q) => q && q.id != null && typeof q.name === 'string');
    return validos.length ? validos : null;
  }

  for (const k of ['qualifications', 'qualification', 'qualification_list', 'call', 'data']) {
    if (k in data) {
      const achado = qualificacoesDe(data[k], nivel + 1);
      if (achado) return achado;
    }
  }
  for (const [k, v] of Object.entries(data)) {
    if (/qualifica/i.test(k)) {
      const achado = qualificacoesDe(v, nivel + 1);
      if (achado) return achado;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache das qualificacoes, por campanha
//
// A exigencia e "sempre que encerrar uma ligacao eu consigo qualificar", e a
// lista so chega pelo socket - em call-was-connected, DURANTE a chamada, e nem
// sempre. Depender disso a cada ligacao nao atende "sempre".
//
// Mas a lista e configuracao da CAMPANHA, nao da chamada: nao muda entre uma
// ligacao e outra. Entao recebida uma vez, fica gravada em storage.local e
// serve para todas as proximas - inclusive depois de fechar o Chrome.
// ---------------------------------------------------------------------------

const chaveQuals = (campaignId) => `quals:${campaignId}`;

async function guardarQualificacoes(campaignId, lista) {
  if (!campaignId || !lista?.length) return;
  await Prefs.set(chaveQuals(campaignId), lista);
}

const qualificacoesDaCampanha = (campaignId) =>
  campaignId ? Prefs.get(chaveQuals(campaignId), null) : null;

/**
 * Estado do agente do lado da 3C Plus (IDLE, ACW, ON_CALL...).
 *
 * E o que decide se a discagem passa: entrar em modo manual exige o agente
 * OCIOSO. Preso em ACW - tipico de chamada anterior sem qualificar - a API
 * devolve 422 "Agente nao esta ocioso."
 */
function statusAgente(data) {
  const s = data?.agent?.status ?? data?.agent_status ?? data?.status_agent;
  // Aceita "5" alem de 5: a API mistura numero e string conforme o evento, e
  // exigir number fazia a reconciliacao inteira nunca rodar.
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (typeof s === 'string' && s.trim() !== '' && Number.isFinite(Number(s))) return Number(s);
  return null;
}

/** Frase util para o 422 mais comum, olhando o estado que temos. */
function comDica(msg, st) {
  if (!/ocioso|idle/i.test(msg ?? '')) return msg;

  if (st?.lastCallId) {
    return `${msg} Qualifique a chamada anterior — o ramal fica em ACW até isso acontecer.`;
  }
  if (st?.onBreak) {
    return `${msg} Você está em intervalo: saia dele antes de discar.`;
  }
  if (st?.currentCallId) {
    return `${msg} Já existe uma chamada em andamento.`;
  }
  return `${msg} O ramal está ocupado (chamada, ACW ou intervalo). Se travou, use "Trocar" para sair da campanha e entrar de novo.`;
}

/** Id da chamada, nos lugares onde ele costuma aparecer. */
function idDaChamada(data) {
  const cand = [data?.call?.id, data?.call?.call_id, data?.call_id, data?.callId];
  for (const c of cand) if (c != null && c !== '') return c;
  return null;
}

// A 3C Plus nao tem evento proprio de caixa postal. O que da para fazer e
// procurar a marca dela no payload do fim da chamada - varia por operadora,
// entao a lista cresce conforme aparecer no log de eventos do painel.
const CAIXA_POSTAL_RE =
  /voice-?mail|caixa[ _-]?postal|mailbox|answering[ _-]?machine|secret[aá]ria[ _-]?eletr[oô]nica/i;

const ehCaixaPostal = (data) => {
  try {
    return CAIXA_POSTAL_RE.test(JSON.stringify(data ?? {}));
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Status da chamada + log de eventos
//
// Os dois existem pelo mesmo motivo: ate agora a extensao falhava em silencio.
// Se o socket nao subia ou a API recusava a discagem, nada aparecia na tela.
// ---------------------------------------------------------------------------

const LOG_MAX = 40;

async function logar(nivel, texto, detalhe = null) {
  const st = (await Session.get()) ?? {};
  const log = [...(st.log ?? []), { t: Date.now(), nivel, texto, detalhe }].slice(-LOG_MAX);
  await Session.set({ log });
}

/** status: chave curta usada pelo CSS | texto: o que o operador le. */
const setStatus = (status, texto, detalhe = null) =>
  Session.set({ callStatus: status, callStatusText: texto, callStatusDetail: detalhe });

/**
 * Espera o ramal REGISTRAR no SIP (evento agent-is-connected).
 *
 * O iframe ter carregado nao basta: o registro vem alguns segundos depois. Se
 * a campanha e logada antes disso, a 3C Plus aceita no REST e manda
 * agent-login-failed pelo socket em seguida - o agente fica meio logado, e a
 * discagem seguinte volta 422 "Agente nao esta ocioso."
 */
async function esperarSip(ms = 12000) {
  const ate = Date.now() + ms;
  while (Date.now() < ate) {
    const st = await Session.get();
    if (st?.sipOk) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Atividade no Pipedrive
//
// Roda DEPOIS da qualificacao, que e quando a ligacao esta completa: so ai
// existem desfecho, duracao e qualificacao para escrever na nota.
//
// Nunca derruba a qualificacao. Se o Pipedrive recusar, a chamada ja foi
// qualificada na 3C Plus e o ramal ja esta livre - o erro vira linha no log,
// nao um erro na cara do operador no meio do turno.
// ---------------------------------------------------------------------------

async function lancarAtividade(qualificationName) {
  const token = await Prefs.get('pipedriveToken');
  if (!token) return { pulou: 'sem_token' };

  const st = await Session.get();
  const alvo = st?.alvo;
  const callId = st?.lastCallId ?? st?.currentCallId;

  // Sem ficha aberta nao ha onde lancar. Atividade solta no CRM e lixo, entao
  // a ligacao pelo funil ou pelo menu de contexto nao gera atividade.
  if (!alvo?.id || !campoDoAlvo(alvo.tipo)) return { pulou: 'sem_ficha' };
  if (!callId) return { pulou: 'sem_call_id' };

  const chamada = {
    callId,
    phone: st.callPhone ?? st.dialingTo,
    result: st.callStatus,
    startedAt: st.callTalkStartedAt ?? st.callStartedAt,
    endedAt: st.callEndedAt,
    talkSeconds: st.callTalkSeconds ?? 0,
    campaignName: st.campaignName,
    agentName: st.userName,
    qualificationName
  };

  // Deduplicacao: o operador pode qualificar duas vezes se a primeira parecer
  // ter falhado. A marca na nota e o que reconhece o reenvio.
  const antigas = await pipedrive.atividadesDe(token, alvo).catch(() => []);
  if (jaLancada(antigas, callId)) return { pulou: 'ja_lancada' };

  const personId =
    alvo.tipo === 'deal' ? await pipedrive.pessoaDoNegocio(token, alvo.id).catch(() => null) : null;

  const atividade = montarAtividade(chamada, {
    campoAlvo: campoDoAlvo(alvo.tipo),
    alvoId: alvo.id,
    personId
  });

  const res = await pipedrive.criarAtividade(token, atividade);
  return { id: res?.data?.id ?? null };
}

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

/**
 * Discagem. O ponto que mais quebra: dial so funciona se o agente ja estiver
 * em modo manual, e o login na campanha entra em modo dialer. Entao entramos
 * no modo manual sob demanda.
 */
async function dial(phone, sender, alvo) {
  const st = await Session.get();

  // Faltando sessao ou campanha, o operador precisa do painel de qualquer
  // jeito - entao abrimos em vez de so reclamar. Vale para os tres caminhos
  // que chegam aqui: botao flutuante, botao de cada numero e menu de contexto.
  if (!st?.token) {
    await abrirPainel(sender);
    throw new Error('Entre com seu ramal para discar.');
  }
  if (!st.campaignId) {
    await abrirPainel(sender);
    throw new Error('Escolha uma campanha no painel antes de discar.');
  }

  if (st.currentCallId) throw new Error('Ja existe uma chamada em andamento.');

  // A 3C Plus recusaria com 422 "Agente nao esta ocioso" - o ramal fica em ACW
  // ate qualificar. Barrar aqui diz o que fazer, em vez de um erro de API.
  if (st.pendingQualification) {
    throw new Error('Qualifique a chamada anterior antes de discar.');
  }

  if (!st.manualMode) {
    try {
      await api.manualEnter();
    } catch (e) {
      // 422 "Agente nao esta ocioso." e o erro mais comum aqui - e sozinho ele
      // nao diz o que fazer.
      throw new Error(comDica(e?.message ?? String(e), st));
    }
    await Session.set({ manualMode: true });
    await logar('info', 'Entrou em modo manual');
  }

  const res = await api.dial(phone);

  // O id da chamada vem DAQUI, da resposta do /dial - nao do socket.
  //
  // O SDK e explicito ("Mantem o ID original do /dial, nao sobrescreve!"):
  // os eventos do socket podem trazer outro id, ou nao trazer nenhum. Sem
  // isto, chamada que nao dispara call-was-connected fica sem id e o botao
  // Desligar nao tem o que desligar.
  const callId = res?.call?.id ?? res?.data?.call?.id ?? null;

  await Session.set({
    dialingTo: phone,
    callPhone: res?.call?.number ?? res?.data?.call?.number ?? phone,
    currentCallId: callId,
    lastCallId: callId,
    // De qual ficha do CRM saiu a ligacao. E a unica chance de saber: a 3C
    // Plus nao guarda isso em chamada manual, e depois nao ha como descobrir.
    alvo: alvo ?? null,
    // Chamada nova: nada da anterior sobrevive.
    callEndedAt: null,
    atividadeId: null
  });

  await setStatus('discando', 'Discando...');
  await logar('info', `Discagem enviada para ${phone}`, callId ? `call ${callId}` : 'sem call id!');
  await pushState();
  return { phone, callId };
}

// ---------------------------------------------------------------------------
// Handlers de mensagem (janela do operador e content script)
// ---------------------------------------------------------------------------

const handlers = {
  STATE: () => Session.get(),

  // Chamado pelo botao flutuante quando a ficha nao tem telefone: ai ele vira
  // atalho para trazer a janela do operador para a frente.
  async OPEN_PANEL(_payload, sender) {
    return { aberto: await abrirPainel(sender) };
  },

  // Reabrir a tela de permissao sem precisar deslogar e logar de novo.
  async OPEN_MIC() {
    await openPopup(MIC);
    return { ok: true };
  },

  /**
   * Status minimo para o content script decidir o rotulo do botao flutuante.
   *
   * Devolve so booleanos. Nada de token, nome ou telefone: isto roda na pagina
   * do CRM, e e por isso que a sessao mora em chrome.storage.session com acesso
   * restrito a contextos confiaveis.
   */
  /**
   * O offscreen document acabou de carregar e esta pedindo a credencial.
   *
   * Ele nao consegue ler chrome.storage - um offscreen so enxerga
   * chrome.runtime. Por isso a credencial vai por mensagem, e por isso este
   * handshake existe: sem ele, um START que chegue antes do listener do
   * offscreen se perde e o turno inteiro roda sem socket e sem SIP.
   */
  async OFFSCREEN_READY() {
    const st = await Session.get();
    if (!st?.token || !st?.domain) return {};
    await logar('info', 'Offscreen pediu a credencial ao carregar');
    return { token: st.token, domain: st.domain };
  },

  /**
   * Confere o token contra a API antes de guardar.
   *
   * Token errado so apareceria no fim do turno, quando as atividades nao
   * estivessem la - e as ligacoes ja teriam passado.
   */
  async PIPEDRIVE_TOKEN({ token }) {
    const eu = await pipedrive.quemSou(token);
    const nome = eu?.data?.name ?? 'usuario do Pipedrive';
    await Prefs.set('pipedriveToken', token);
    await Prefs.set('pipedriveUser', nome);
    await logar('ok', `Pipedrive conectado como ${nome}`);
    return nome;
  },

  async UI_STATE() {
    const st = await Session.get();
    return {
      logado: Boolean(st?.token),
      emCampanha: Boolean(st?.campaignId)
    };
  },

  async LOGIN({ domain, user, password }) {
    const res = await api.authenticate(domain, user, password);
    const d = res?.data;
    if (!d?.api_token) throw new Error('Resposta de autenticacao sem api_token.');

    await Session.set({
      token: d.api_token,
      domain,
      userName: textoDe(d.name) ?? 'Operador',
      // d.extension as vezes vem como objeto - textoDe cava ate achar o numero.
      extension: textoDe(d.extension) ?? textoDe(d.extension_number) ?? user,
      companyName: textoDe(d.company?.name) ?? null,
      campaignId: null,
      manualMode: false,
      currentCallId: null,
      wsOk: false,
      sipOk: false,
      callStatus: null,
      callStatusText: null,
      log: []
    });

    // Proximo login ja vem com este dominio preenchido.
    await Prefs.set('lastDomain', domain);
    await logar('ok', `Autenticado como ${textoDe(d.name) ?? user}`);

    // O iframe SIP precisa estar carregado ANTES de entrar na campanha,
    // senao a 3C Plus desloga o ramal.
    await ensureOffscreen();
    await toOffscreen({ type: 'START', auth: { token: d.api_token, domain } });

    // Sem microfone liberado a chamada acontece sem audio, e em silencio:
    // nenhum erro aparece. Pedimos uma unica vez, num popup por cima de tudo -
    // em aba o operador nao ve o pedido e comeca o turno mudo.
    if (!(await Prefs.get('micGranted'))) {
      await openPopup(MIC).catch(() => {});
    }

    return Session.get();
  },

  async LOGOUT() {
    try {
      await api.agentLogout();
    } catch {
      // ja pode estar deslogado do lado da 3C - segue o fluxo
    }
    await toOffscreen({ type: 'STOP' });
    await closeOffscreen();
    await Session.clear();
    return null;
  },

  async CAMPAIGNS() {
    const res = await api.campaigns();
    return res?.data ?? [];
  },

  async SELECT_CAMPAIGN({ id, name }) {
    // Ordem que importa: SIP registrado ANTES do login na campanha.
    if (!(await esperarSip())) {
      const st = await Session.get();

      // Microfone bloqueado nao e "talvez": o webphone nao registra sem ele, e
      // entrar assim so produz um agente meio logado que recusa toda discagem.
      if (st?.micOk === false) {
        await openPopup(MIC);
        await logar('erro', 'SIP nao registrou: microfone bloqueado');
        throw new Error(
          'O ramal não registrou porque o microfone está bloqueado. Libere na janela que abriu e entre na campanha de novo.'
        );
      }

      await logar('aviso', 'O ramal nao registrou no SIP a tempo - entrando assim mesmo');
    }

    try {
      await api.agentLogin(id);
    } catch (e) {
      // Causa mais comum da recusa: sessao anterior do ramal ainda presa do
      // lado da 3C Plus (turno que nao encerrou, aba fechada no meio). Deslogar
      // e tentar de novo resolve; se nao resolver, o erro sobe de verdade.
      await logar('aviso', 'Login na campanha recusado, deslogando para tentar de novo', e?.message);
      try {
        await api.agentLogout();
      } catch {
        // ja estava deslogado - segue
      }
      await api.agentLogin(id);
    }

    await Session.set({ campaignId: id, campaignName: name, manualMode: false });
    await logar('ok', `Entrou na campanha ${name}`);

    // Carrega a lista que ja foi vista nesta campanha (sobrevive ao Chrome
    // fechar), para a primeira chamada do turno ja poder qualificar.
    const guardadas = await qualificacoesDaCampanha(id);
    if (guardadas?.length) {
      await Session.set({ qualifications: guardadas });
      await logar('info', `${guardadas.length} qualificacoes desta campanha em cache`);
    } else {
      await logar('aviso', 'Sem qualificacoes em cache - esperando o socket mandar');
    }

    return Session.get();
  },

  async LEAVE_CAMPAIGN() {
    await api.agentLogout();
    await Session.set({
      campaignId: null,
      campaignName: null,
      manualMode: false,
      currentCallId: null,
    });
    return Session.get();
  },

  async TOGGLE_MANUAL() {
    const st = await Session.get();
    if (st.manualMode) {
      await api.manualExit();
      return Session.set({ manualMode: false });
    }
    await api.manualEnter();
    return Session.set({ manualMode: true });
  },

  DIAL: ({ phone, alvo }, sender) => dial(phone, sender, alvo),

  async HANGUP() {
    const st = await Session.get();
    const callId = st?.currentCallId;
    if (!callId) throw new Error('Nenhuma chamada ativa.');

    await api.hangup(callId);
    await logar('info', `Desligou a chamada ${callId}`);

    // Encerra AQUI, sem esperar o socket. Quando o proprio operador desliga, a
    // 3C Plus nao manda evento de fim de volta - nao ha novidade a anunciar
    // para quem causou o fim. Sem isto o painel ficava em "Em chamada" com o
    // cronometro correndo depois de desligar pela extensao.
    //
    // Se um evento chegar depois, encerrarChamada nao refaz nada: callEndedAt
    // ja esta gravado e o status ja e terminal.
    await encerrarChamada('encerrada', 'Chamada encerrada');
    await pushState();
    return { ok: true };
  },

  /**
   * Envia a qualificacao da ultima chamada.
   *
   * Duas incertezas tratadas aqui: o endpoint depende do tipo da chamada (e o
   * tipo nem sempre chega pelo socket), e a janela de ACW tem prazo.
   */
  async QUALIFY({ qualificationId }) {
    const st = await Session.get();
    const callId = st?.currentCallId ?? st?.lastCallId;
    if (!callId) throw new Error('Nenhuma chamada para qualificar.');

    const modo = st.callMode ?? 'desconhecido';
    await logar('info', `Qualificando ${callId} com ${qualificationId}`, `modo ${modo}`);

    try {
      await api.qualify(callId, qualificationId, st.callMode);
    } catch (e) {
      if (foraDaJanela(e?.message)) return recusaPorJanela(e?.message);

      // Endpoint errado e a outra causa provavel: tenta o par antes de desistir.
      await logar('aviso', 'Recusada, tentando o outro endpoint', e?.message);
      try {
        await api.qualifyOutro(callId, qualificationId, st.callMode);
        await logar('ok', 'Qualificada pelo endpoint alternativo');
      } catch (e2) {
        if (foraDaJanela(e2?.message)) return recusaPorJanela(e2?.message);
        throw e2;
      }
    }

    await logar('ok', 'Chamada qualificada');

    // A atividade vem DEPOIS e nunca derruba o que ja deu certo: a chamada ja
    // esta qualificada na 3C Plus e o ramal ja esta livre.
    const nome = st.qualifications?.find((q) => q.id === qualificationId)?.name ?? null;
    try {
      const r = await lancarAtividade(nome);
      if (r.id) await logar('ok', `Atividade ${r.id} criada no Pipedrive`);
      else await logar('info', `Atividade nao criada: ${r.pulou}`);
    } catch (e) {
      await logar('erro', 'Pipedrive recusou a atividade', e?.message);
      notifyUI('error', `Chamada qualificada, mas a atividade falhou: ${e?.message}`);
    }

    await limparQualificacao();
    return Session.get();
  },

  /**
   * Saida quando a lista nao veio, ou veio errada: o operador dispensa e segue.
   * So limpa o estado local - nao qualifica nada na 3C Plus.
   */
  async DISMISS_QUAL() {
    await limparQualificacao();
    await logar('aviso', 'Qualificacao dispensada pelo operador');
    return Session.get();
  },

  async INTERVALS() {
    const res = await api.intervals();
    return res?.data ?? [];
  },

  async BREAK_ENTER({ intervalId }) {
    await api.workBreakEnter(intervalId);
    return Session.set({ onBreak: true });
  },

  async BREAK_EXIT() {
    await api.workBreakExit();
    return Session.set({ onBreak: false });
  }
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Eventos vindos do offscreen tem tratamento proprio, mais abaixo.
  if (msg?.type === 'SOCKET_EVENT') {
    onSocketEvent(msg.event, msg.data);
    return false;
  }
  if (msg?.target !== 'sw') return false;

  const handler = handlers[msg.type];
  if (!handler) {
    reply({ ok: false, error: `Acao desconhecida: ${msg.type}` });
    return false;
  }

  // O sender vai junto: abrir o side panel exige saber em qual janela do
  // navegador, e o gesto do usuario veio dessa aba.
  Promise.resolve(handler(msg.payload ?? {}, sender))
    .then((data) => reply({ ok: true, data }))
    .catch(async (err) => {
      const texto = err?.message ?? String(err);
      reply({ ok: false, error: texto });
      // Toda recusa da API vira linha no log - e o rastro de "nao discou".
      await logar('erro', `${msg.type} falhou`, texto);
      if (msg.type === 'DIAL') {
        await setStatus('falhou', 'Nao consegui discar', texto);
        await pushState();
      }
    });

  return true; // resposta assincrona
});
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Ciclo da chamada
//
// Regra que veio de errar: NENHUMA fonte sozinha e confiavel.
//
//  - Os eventos de chamada nem sempre chegam todos. Ja vimos chamada manual sem
//    call-was-connected e sem call-was-finished.
//  - agent.status vem de carona em quase todo evento, mas nem sempre vem, e
//    nem sempre como numero.
//
// Entao as DUAS fontes escrevem o mesmo estado, e cada transicao e idempotente:
// quem chegar primeiro resolve, quem chegar depois confirma. Se uma sumir, a
// outra sustenta o ciclo sozinha.
//
// Estados: discando -> chamando -> falando -> encerrada|nao-atendida|falhou
// ---------------------------------------------------------------------------

/** A chamada esta no ar: cronometro correndo, botao de desligar valendo. */
async function entrarEmChamada({ modo, phone, mailing } = {}) {
  const st = (await Session.get()) ?? {};
  await Session.set({
    currentCallId: st.currentCallId ?? st.lastCallId,
    // O cronometro comeca aqui e NAO e reiniciado por evento repetido.
    callStartedAt: st.callStartedAt ?? Date.now(),
    callEndedAt: null,
    dialingTo: null,
    ...(modo ? { callMode: modo } : {}),
    ...(phone ? { callPhone: phone } : {}),
    ...(mailing !== undefined ? { mailing } : {})
  });
  await setStatus('falando', 'Em chamada');
}

/** Discou e esta tocando do outro lado. */
async function entrarEmChamando({ modo, phone } = {}) {
  const st = (await Session.get()) ?? {};
  await Session.set({
    currentCallId: st.currentCallId ?? st.lastCallId,
    callEndedAt: null,
    ...(modo ? { callMode: modo } : {}),
    ...(phone ? { callPhone: phone } : {})
  });
  if (st.callStatus !== 'falando') await setStatus('chamando', 'Chamando...');
}

/**
 * Acabou. `desfecho` so e aplicado se ninguem ja tiver dito algo mais
 * especifico - assim o ACW generico nao apaga um "nao atendida" que chegou
 * antes.
 */
const DESFECHO_ESPECIFICO = ['caixa', 'nao-atendida', 'falhou'];

// Estados de onde a chamada NAO volta. Depois de um deles, so uma discagem
// nova (ou um call-was-connected explicito) recomeca o ciclo.
const TERMINAIS = [...DESFECHO_ESPECIFICO, 'encerrada'];

/**
 * A chamada ja acabou?
 *
 * Serve para a reconciliacao nao ressuscitar chamada morta: o payload que
 * anuncia o fim as vezes carrega um agent.status ATRASADO (ainda
 * ON_MANUAL_CALL), e sem esta trava ele reescrevia "Chamando..." por cima do
 * "Nao atendida" que o proprio evento tinha acabado de gravar.
 */
const chamadaEncerrada = (st) => Boolean(st?.callEndedAt) || TERMINAIS.includes(st?.callStatus);

async function encerrarChamada(desfecho, texto, detalhe = null) {
  const st = (await Session.get()) ?? {};

  // A lista que vale: a que o socket mandou nesta chamada, senao a da campanha.
  // E o que sustenta "sempre que encerrar eu consigo qualificar".
  const lista = st.qualifications?.length
    ? st.qualifications
    : ((await qualificacoesDaCampanha(st.campaignId)) ?? []);

  const fim = st.callEndedAt ?? Date.now();

  await Session.set({
    currentCallId: null,
    // callStartedAt zera para o cronometro parar, mas a duracao ainda e
    // necessaria depois: a atividade do Pipedrive so e montada na
    // qualificacao, e ate la o inicio ja teria se perdido.
    callStartedAt: null,
    callTalkStartedAt: st.callTalkStartedAt ?? st.callStartedAt ?? null,
    callTalkSeconds: st.callStartedAt ? Math.max(0, Math.round((fim - st.callStartedAt) / 1000)) : 0,
    dialingTo: null,
    callEndedAt: fim,
    qualifications: lista,
    // Toda chamada que teve id entra em pendencia. O card aparece mesmo sem
    // lista - explicando por que - em vez de sumir sem o operador entender.
    pendingQualification: Boolean(st.lastCallId)
  });

  if (!DESFECHO_ESPECIFICO.includes(st.callStatus)) await setStatus(desfecho, texto, detalhe);
}

// "chamada nao esta mais em estado valido para ser qualificada, precisa estar
// ativa ou em estado acw" - a janela fechou e nenhum endpoint aceita mais.
const foraDaJanela = (msg) =>
  /estado v[aá]lido|em estado acw|precisa estar ativa|no longer.*valid/i.test(msg ?? '');

/** Recusa por prazo: limpa o card em vez de deixar botao que so da erro. */
async function recusaPorJanela(msg) {
  await limparQualificacao();
  await logar('aviso', 'Chamada saiu do ACW antes da qualificacao', msg);
  throw new Error('Essa chamada saiu do ACW e nao aceita mais qualificacao. Liberei o painel.');
}

/** Fecha a pendencia: qualificada, dispensada, ou fora da janela. */
const limparQualificacao = () =>
  Session.set({
    pendingQualification: false,
    lastCallId: null,
    callEndedAt: null,
    mailing: null
  });

/**
 * Ramal livre: nada em curso.
 *
 * O desfecho da ultima chamada FICA na tela ate a proxima discagem - o
 * operador precisa ler o que aconteceu. Quem limpa e o dial() seguinte.
 */
async function liberarRamal() {
  const st = (await Session.get()) ?? {};

  // Ficou ocioso com chamada no ar e ninguem avisou o fim. Foi o que acontece
  // quando o destino recusa antes de atender: nao ha ACW, o ramal volta direto
  // para ocioso. Sem isto o painel ficava em "Chamando..." para sempre.
  if ((st.currentCallId || st.dialingTo) && !TERMINAIS.includes(st.callStatus)) {
    await encerrarChamada('nao-atendida', 'Nao atendida');
  }

  // Qualificacao pendente sobrevive ao ramal ficar ocioso: lastCallId e
  // preciso para o POST. Quem decide se ainda da tempo e a API - se recusar
  // por estar fora do ACW, o handler QUALIFY limpa. Melhor tentar e ouvir um
  // nao do que esconder o card e nunca deixar qualificar.
  const st2 = (await Session.get()) ?? {};
  await Session.set({
    currentCallId: null,
    callStartedAt: null,
    dialingTo: null,
    ...(st2.pendingQualification ? {} : { lastCallId: null, mailing: null })
  });
}

// Estados do agente, agrupados pelo que significam para o ciclo.
const AG_FALANDO = ['ON_CALL', 'ON_MANUAL_CALL_CONNECTED'];
const AG_CHAMANDO = ['ON_MANUAL_CALL'];
const AG_ENCERROU = ['ACW', 'ON_MANUAL_CALL_ACW'];

/**
 * Reconcilia o ciclo pelo estado do agente.
 *
 * Nao substitui os eventos de chamada - completa. Quando o evento de fim nao
 * chega, e isto que tira a UI de "em chamada".
 */
async function aplicarStatusAgente(status) {
  const nome = AGENT_STATUS[status];
  if (!nome) return;

  const st = (await Session.get()) ?? {};
  if (st.agentStatusText !== nome) {
    await Session.set({ agentStatus: status, agentStatusText: nome });
    await logar('evento', `Ramal: ${nome}`);
  }

  // A reconciliacao so avanca chamada VIVA. Depois do desfecho ela nao mexe
  // mais: o agent.status que vem junto do evento de fim costuma estar
  // atrasado, e reescrevia "Chamando..." por cima de "Nao atendida".
  if (AG_FALANDO.includes(nome)) return chamadaEncerrada(st) ? undefined : entrarEmChamada();
  if (AG_CHAMANDO.includes(nome)) return chamadaEncerrada(st) ? undefined : entrarEmChamando();

  if (AG_ENCERROU.includes(nome)) return encerrarChamada('encerrada', 'Chamada encerrada');
  if (nome === 'IDLE' && (st.currentCallId || st.lastCallId || st.dialingTo)) {
    return liberarRamal();
  }
  if (nome === 'ON_WORK_BREAK') await Session.set({ onBreak: true });
}

// ---------------------------------------------------------------------------
// Eventos do socket -> estado -> UI
// ---------------------------------------------------------------------------

async function onSocketEvent(event, data) {
  // O id do /dial tem prioridade: o socket so preenche o que faltar. Trocar um
  // id valido pelo do evento e o caminho para desligar a chamada errada.
  const id = idDaChamada(data);
  if (id != null) {
    const st = await Session.get();
    if (!st?.lastCallId) await Session.set({ lastCallId: id });
  }

  // A lista de qualificacoes e procurada em TODO evento, nao so nos de chamada:
  // o SDK a le em call-was-connected, manual-call-was-answered e
  // call-history-was-created, e nada garante que sejam os unicos.
  const quals = qualificacoesDe(data);
  if (quals?.length) {
    const st = await Session.get();
    await Session.set({ qualifications: quals });
    await guardarQualificacoes(st?.campaignId, quals);
    await logar('ok', `Qualificacoes recebidas em "${event}"`, `${quals.length} itens`);
  }

  switch (event) {
    // ---- conexao -----------------------------------------------------------
    case 'connect':
      await Session.set({ wsOk: true });
      await logar('ok', 'WebSocket conectado');
      break;

    case 'disconnect':
      await Session.set({ wsOk: false, sipOk: false });
      await logar('erro', 'WebSocket caiu', data?.reason);
      break;

    case 'connect_error':
      await Session.set({ wsOk: false });
      await logar('erro', 'Nao consegui abrir o WebSocket', data?.message);
      break;

    case 'sip-carregou':
      await logar('info', 'Pagina do SIP carregou no offscreen');
      break;

    // Estado real do microfone, lido pela origem que o iframe SIP herda.
    // 'granted' e pre-requisito para o webphone registrar.
    case 'mic-permissao': {
      const ok = data?.state === 'granted';
      await Session.set({ micOk: ok });
      await Prefs.set('micGranted', ok); // mantem a faixa do painel honesta
      await logar(
        ok ? 'ok' : 'erro',
        ok
          ? 'Microfone liberado'
          : `Microfone ${data?.state ?? 'indisponivel'} - o SIP nao vai registrar`
      );
      break;
    }

    case EV.AGENT_IS_CONNECTED:
      await Session.set({ sipOk: true });
      await logar('ok', 'Ramal registrado (SIP no ar)');
      break;

    // ---- ciclo da chamada ---------------------------------------------------
    case EV.CALL_WAS_CONNECTED: {
      const modo = data?.call?.call_mode ?? 'manual';
      const phone = data?.call?.phone ?? data?.call?.number ?? null;

      // No dialer o cliente ja esta na linha. No manual a ponte saiu e ainda
      // esta tocando - o "atendida" vem depois.
      if (modo === 'dialer') {
        await entrarEmChamada({ modo, phone, mailing: data?.mailing ?? null });
      } else {
        await entrarEmChamando({ modo, phone });
      }
      await logar('ok', `Chamada conectada (${modo})`);
      break;
    }

    case EV.MANUAL_CALL_WAS_ANSWERED:
      // Tambem estabelece a chamada sozinho: se call-was-connected nao vier,
      // e daqui que saem cronometro e status.
      await entrarEmChamada({
        modo: 'manual',
        phone: data?.call?.phone ?? data?.call?.number ?? null
      });
      await logar('ok', 'Atendida');
      break;

    case EV.CALL_WAS_FINISHED:
      await encerrarChamada('encerrada', 'Chamada encerrada', motivoDe(data));
      await logar('info', 'Chamada encerrada', motivoDe(data));
      break;

    case EV.CALL_WAS_NOT_ANSWERED:
      await setStatus('nao-atendida', 'Nao atendida', motivoDe(data));
      await encerrarChamada('nao-atendida', 'Nao atendida', motivoDe(data));
      await logar('aviso', 'Nao atendida', motivoDe(data));
      break;

    case EV.CALL_WAS_FAILED: {
      const caixa = ehCaixaPostal(data);
      const texto = caixa ? 'Caiu na caixa postal' : 'Chamada falhou';
      await setStatus(caixa ? 'caixa' : 'falhou', texto, motivoDe(data));
      await encerrarChamada(caixa ? 'caixa' : 'falhou', texto, motivoDe(data));
      await logar(caixa ? 'aviso' : 'erro', texto, motivoDe(data));
      break;
    }

    case EV.CALL_HISTORY_WAS_CREATED:
      await logar('evento', 'Historico da chamada criado', resumo(data));
      break;

    // ---- agente -------------------------------------------------------------
    case EV.AGENT_ENTERED_MANUAL:
      await Session.set({ manualMode: true });
      await logar('info', 'Modo manual ativo');
      break;

    case EV.AGENT_MANUAL_ENTER_FAILED:
      await Session.set({ manualMode: false });
      await setStatus('falhou', 'Nao consegui entrar em modo manual', motivoDe(data));
      await logar('erro', 'Falha ao entrar em modo manual', resumo(data));
      break;

    // Nao esta na lista do SDK, mas e o evento que aparece quando a discagem e
    // aceita pelo REST e recusada depois - o caso classico de "nao ligou".
    case 'call-dial-failed':
      await setStatus('falhou', 'A 3C Plus recusou a discagem', motivoDe(data));
      await encerrarChamada('falhou', 'A 3C Plus recusou a discagem', motivoDe(data));
      await logar('erro', 'Discagem recusada', resumo(data));
      break;

    case EV.AGENT_LOGIN_FAILED:
      // O REST pode ter dito OK e o socket recusar depois. Quem manda e o
      // socket: sem isso o painel mostra "na campanha" e toda discagem volta
      // 422, sem o operador entender por que.
      await Session.set({ campaignId: null, campaignName: null, manualMode: false });
      await setStatus('falhou', 'A 3C Plus recusou o login na campanha', motivoDe(data));
      await logar('erro', 'Login na campanha recusado', resumo(data));
      notifyUI(
        'error',
        'A 3C Plus recusou a entrada na campanha. Espere o chip do SIP ficar verde e entre de novo.'
      );
      break;

    case EV.AGENT_ENTERED_WORK_BREAK:
      await Session.set({ onBreak: true });
      await logar('info', 'Entrou em intervalo');
      break;

    case EV.AGENT_LEFT_WORK_BREAK:
      await Session.set({ onBreak: false });
      await logar('info', 'Saiu do intervalo');
      break;

    case EV.AGENT_WAS_LOGGED_OUT:
      // Causa mais comum: o mesmo ramal aberto em outro lugar (app web da 3C).
      await toOffscreen({ type: 'STOP' });
      await closeOffscreen();
      await Session.clear();
      notifyUI('error', 'Voce foi deslogado pela 3C Plus. O ramal esta em uso em outro lugar?');
      return; // sessao morreu: nao ha estado para reconciliar

    case EV.ERROR:
    case EV.EXCEPTION:
      await logar('erro', `Erro da 3C Plus (${event})`, resumo(data));
      break;

    // agent-is-idle e agent-is-acw caem aqui de proposito: quem trata os dois
    // e aplicarStatusAgente, logo abaixo, junto com os demais estados.
    default:
      await logar('evento', event, resumo(data));
      break;
  }

  // Reconciliacao: completa o que o evento nao disse (ou corrige se divergiu).
  const status = statusAgente(data);
  if (status != null) await aplicarStatusAgente(status);

  toUI({ type: 'SOCKET_EVENT', event, data });
  await pushState();
}
