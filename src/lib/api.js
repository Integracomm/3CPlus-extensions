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

  if (!res.ok) {
    throw new Error(json?.message || `${res.status} - ${text.slice(0, 200)}`);
  }
  return json;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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
    req(
      callMode === 'dialer'
        ? `agent/call/${callId}/qualify`
        : `agent/manual_call/${callId}/qualify`,
      'POST',
      { qualification_id: qualificationId }
    )
};
