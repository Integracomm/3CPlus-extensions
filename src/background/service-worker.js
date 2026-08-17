// src/background/service-worker.js
//
// Roteador central da extensao. Responsabilidades:
//  1. executar TODAS as chamadas REST (host_permissions mata o CORS);
//  2. criar/destruir o offscreen document, que segura SIP + WebSocket;
//  3. receber os eventos do socket vindos do offscreen, atualizar o estado
//     e repassar para o side panel.
//
// Ele hiberna quando ocioso - por isso nenhum estado vive em variavel de
// modulo, so em chrome.storage.session.

import { api } from '../lib/api.js';
import { Session, Prefs } from '../lib/storage.js';
import { EV } from '../lib/events.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.contextMenus.create({
    id: 'c3-dial-selection',
    title: 'Ligar para "%s" (3C Plus)',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'c3-dial-selection') return;
  const phone = (info.selectionText || '').replace(/\D/g, '');
  if (phone.length >= 10) dial(phone).catch((e) => notifyUI('error', e.message));
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

/** Broadcast para o side panel (se estiver aberto). */
const toUI = (msg) => chrome.runtime.sendMessage({ target: 'ui', ...msg }).catch(() => {});

const notifyUI = (level, text) => toUI({ type: 'NOTICE', level, text });
const pushState = async () => toUI({ type: 'STATE', state: await Session.get() });

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

/**
 * Discagem. O ponto que mais quebra: dial so funciona se o agente ja estiver
 * em modo manual, e o login na campanha entra em modo dialer. Entao entramos
 * no modo manual sob demanda.
 */
async function dial(phone) {
  const st = await Session.get();
  if (!st?.token) throw new Error('Faca login no painel da extensao primeiro.');
  if (!st.campaignId) throw new Error('Entre em uma campanha antes de discar.');
  if (st.currentCallId) throw new Error('Ja existe uma chamada em andamento.');
  if (st.pendingQualification) throw new Error('Qualifique a chamada anterior antes de discar.');

  if (!st.manualMode) {
    await api.manualEnter();
    await Session.set({ manualMode: true });
  }

  await api.dial(phone);
  await Session.set({ dialingTo: phone });
  await pushState();
  return { phone };
}

// ---------------------------------------------------------------------------
// Handlers de mensagem (side panel e content script)
// ---------------------------------------------------------------------------

const handlers = {
  STATE: () => Session.get(),

  async LOGIN({ domain, user, password }) {
    const res = await api.authenticate(domain, user, password);
    const d = res?.data;
    if (!d?.api_token) throw new Error('Resposta de autenticacao sem api_token.');

    await Session.set({
      token: d.api_token,
      domain,
      userName: d.name,
      extension: d.extension ?? user,
      companyName: d.company?.name ?? null,
      campaignId: null,
      manualMode: false,
      currentCallId: null,
      pendingQualification: false,
      qualifications: []
    });

    // O iframe SIP precisa estar carregado ANTES de entrar na campanha,
    // senao a 3C Plus desloga o ramal.
    await ensureOffscreen();
    await toOffscreen({ type: 'START', auth: { token: d.api_token, domain } });

    // Sem microfone liberado a chamada acontece sem audio, e em silencio:
    // nenhum erro aparece. Pedimos uma unica vez, em aba normal.
    if (!(await Prefs.get('micGranted'))) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/permission/mic.html') });
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
    await api.agentLogin(id);
    await Session.set({ campaignId: id, campaignName: name, manualMode: false });
    return Session.get();
  },

  async LEAVE_CAMPAIGN() {
    await api.agentLogout();
    await Session.set({
      campaignId: null,
      campaignName: null,
      manualMode: false,
      currentCallId: null,
      pendingQualification: false,
      qualifications: []
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

  DIAL: ({ phone }) => dial(phone),

  async HANGUP() {
    const st = await Session.get();
    if (!st?.currentCallId) throw new Error('Nenhuma chamada ativa.');
    await api.hangup(st.currentCallId);
    return { ok: true };
  },

  async QUALIFY({ qualificationId }) {
    const st = await Session.get();
    const callId = st?.currentCallId ?? st?.lastCallId;
    if (!callId) throw new Error('Nenhuma chamada para qualificar.');

    await api.qualify(callId, qualificationId, st.callMode);
    await Session.set({
      pendingQualification: false,
      qualifications: [],
      lastCallId: null,
      currentCallId: null,
      mailing: null
    });
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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
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

  Promise.resolve(handler(msg.payload ?? {}))
    .then((data) => reply({ ok: true, data }))
    .catch((err) => reply({ ok: false, error: err?.message ?? String(err) }));

  return true; // resposta assincrona
});

// ---------------------------------------------------------------------------
// Eventos do socket -> estado -> UI
//
// A logica aqui e a mesma de web/app.js (handleSocketEvent, linhas 706+),
// so que gravando em chrome.storage em vez de num objeto AppState global.
// ---------------------------------------------------------------------------

async function onSocketEvent(event, data) {
  switch (event) {
    case EV.CALL_WAS_CONNECTED: {
      const st = await Session.get();
      const callId = st?.currentCallId ?? data?.call?.id;
      await Session.set({
        currentCallId: callId,
        lastCallId: callId,
        callMode: data?.call?.call_mode ?? 'manual',
        callPhone: data?.call?.phone ?? data?.call?.number ?? st?.dialingTo,
        callStartedAt: Date.now(),
        mailing: data?.call?.call_mode === 'dialer' ? (data?.mailing ?? null) : null,
        qualifications: data?.qualification?.qualifications ?? st?.qualifications ?? [],
        dialingTo: null
      });
      break;
    }

    case EV.MANUAL_CALL_WAS_ANSWERED:
    case EV.CALL_HISTORY_WAS_CREATED: {
      const quals = data?.qualification?.qualifications ?? data?.qualifications ?? [];
      if (quals.length) await Session.set({ qualifications: quals });
      break;
    }

    case EV.CALL_WAS_FINISHED:
    case EV.CALL_WAS_NOT_ANSWERED:
    case EV.CALL_WAS_FAILED: {
      const st = await Session.get();
      // lastCallId sobrevive: a qualificacao acontece DEPOIS do fim da chamada.
      await Session.set({
        currentCallId: null,
        callStartedAt: null,
        pendingQualification: Boolean(st?.lastCallId && st?.qualifications?.length)
      });
      break;
    }

    case EV.AGENT_ENTERED_MANUAL:
      await Session.set({ manualMode: true });
      break;

    case EV.AGENT_ENTERED_WORK_BREAK:
      await Session.set({ onBreak: true });
      break;

    case EV.AGENT_LEFT_WORK_BREAK:
      await Session.set({ onBreak: false });
      break;

    case EV.AGENT_WAS_LOGGED_OUT:
      // Causa mais comum: o mesmo ramal aberto em outro lugar (app web da 3C).
      await toOffscreen({ type: 'STOP' });
      await closeOffscreen();
      await Session.clear();
      notifyUI('error', 'Voce foi deslogado pela 3C Plus. O ramal esta em uso em outro lugar?');
      break;

    default:
      break;
  }

  toUI({ type: 'SOCKET_EVENT', event, data });
  await pushState();
}
