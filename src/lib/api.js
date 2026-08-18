// src/lib/api.js
//
// Porte de src/services/*.ts do SDK: axios -> fetch.
//
// Roda SEMPRE dentro do service worker. Como o manifest declara
// host_permissions para https://*.3c.plus/*, esses fetch nao passam por
// CORS - por isso nenhuma chamada REST sai do content script ou do painel.

import { Session } from './storage.js';

const base = (domain) => `https://${domain}.3c.plus/api/v1/`;

async function req(path, method = 'GET', body) {
  const auth = await Session.get();
  if (!auth?.token) throw new Error('Nao autenticado. Faca login no painel.');

  const res = await fetch(base(auth.domain) + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${auth.token}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  const json = text ? safeParse(text) : null;

  if (!res.ok) throw new Error(mensagemDeErro(json, res.status, text));
  return json;
}

/**
 * A 3C Plus responde erro em dois formatos:
 *   { message: "..." }                          - o que o SDK assumia
 *   { status, title, detail, transaction_id }   - o que ela manda de verdade
 *
 * Sem tratar o segundo, o painel mostrava o JSON cru na cara do operador.
 * "detail" vem primeiro: e a frase util ("Agente nao esta ocioso."), enquanto
 * "title" e generico ("Erro de validacao").
 */
function mensagemDeErro(json, status, text) {
  // Os erros por campo vem PRIMEIRO: quando existe { errors: {...} }, o detail
  // costuma ser o generico "Erros de validacao foram encontrados ao processar
  // sua requisicao" - que nao diz absolutamente nada sobre o que esta errado.
  const erros = json?.errors;
  if (erros && typeof erros === 'object') {
    const lista = Object.entries(erros)
      .flatMap(([campo, msgs]) =>
        (Array.isArray(msgs) ? msgs : [msgs]).filter(Boolean).map((m) => `${campo}: ${m}`)
      )
      .slice(0, 3);
    if (lista.length) return lista.join(' | ');
  }

  const frase = json?.detail || json?.message || json?.title;
  if (frase) return String(frase);

  return `${status} - ${String(text ?? '').slice(0, 200)}`;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const caminhoQualify = (callId, callMode) =>
  callMode === 'dialer'
    ? `agent/call/${callId}/qualify`
    : `agent/manual_call/${callId}/qualify`;

/** A API valida o id como inteiro; o socket as vezes manda como string. */
const comoNumero = (v) => {
  const n = Number(v);
  return v != null && `${v}`.trim() !== '' && Number.isFinite(n) ? n : v;
};

/**
 * O corpo muda com o endpoint.
 *
 * No SDK, CallQualify (dialer) tem qualification_id E qualification_note;
 * ManualCallQualify tem so o id. Mandar o corpo do manual para o endpoint de
 * dialer da erro de validacao - com a mensagem generica "Erros de validacao
 * foram encontrados ao processar sua requisicao".
 */
const corpoQualify = (qualificationId, callMode) =>
  callMode === 'dialer'
    ? { qualification_id: comoNumero(qualificationId), qualification_note: '' }
    : { qualification_id: comoNumero(qualificationId) };

export const api = {
  // --- AuthService ---
  async authenticate(domain, user, password) {
    const res = await fetch(base(domain) + 'authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ user, password, token_type: 'jwt' })
    });
    const json = safeParse(await res.text());
    if (!res.ok) throw new Error(json?.message || `Falha na autenticacao (${res.status})`);
    return json;
  },

  // --- CampaignService ---
  campaigns: () => req('groups-and-campaigns?all=true&paused=0'),

  // --- AgentService ---
  // O SDK sempre loga em modo dialer; o modo manual e um SEGUNDO passo.
  agentLogin: (campaignId) => req('agent/login', 'POST', { campaign: campaignId, mode: 'dialer' }),
  agentLogout: () => req('agent/logout', 'POST'),

  // --- IntervalService ---
  intervals: () => req('agent/work_break_intervals?per_page=-1'),
  workBreakEnter: (intervalId) => req(`agent/work_break/${intervalId}/enter`, 'POST'),
  workBreakExit: () => req('agent/work_break/exit', 'POST'),

  // --- ManualCallService ---
  manualEnter: () => req('agent/manual_call/enter', 'POST'),
  manualExit: () => req('agent/manual_call/exit', 'POST'),
  // Atencao: a API espera phone como INTEIRO, so digitos.
  dial: (phone) => req('agent/manual_call/dial', 'POST', { phone: parseInt(phone, 10) }),

  // --- CallService ---
  hangup: (callId) => req(`agent/call/${callId}/hangup`, 'POST'),

  // O endpoint de qualificacao MUDA conforme o tipo da chamada.
  qualify: (callId, qualificationId, callMode) =>
    req(caminhoQualify(callId, callMode), 'POST', corpoQualify(qualificationId, callMode)),

  /**
   * O outro caminho, para a segunda tentativa.
   *
   * callMode so existe se o socket tiver informado. Quando nao informa,
   * cairiamos sempre no endpoint manual e a chamada de dialer voltaria erro de
   * validacao - melhor tentar o outro do que travar o ramal em ACW.
   */
  qualifyOutro: (callId, qualificationId, callMode) => {
    const outro = callMode === 'dialer' ? 'manual' : 'dialer';
    return req(caminhoQualify(callId, outro), 'POST', corpoQualify(qualificationId, outro));
  }
};
