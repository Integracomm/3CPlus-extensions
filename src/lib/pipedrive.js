// src/lib/pipedrive.js
//
// Cliente da API do Pipedrive (v1). Roda SEMPRE no service worker, como o
// api.js da 3C Plus: o manifest declara host_permissions para
// https://api.pipedrive.com/*, entao estes fetch nao passam por CORS.
//
// O token e PESSOAL de cada operador, guardado em chrome.storage.local na
// maquina dele. Nao e token de admin da empresa - assim a atividade nasce
// atribuida a pessoa certa no CRM, e ninguem carrega credencial de outro.

const BASE = 'https://api.pipedrive.com/v1/';

async function req(token, path, method = 'GET', body) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}api_token=${encodeURIComponent(token)}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const texto = await res.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }

  if (!res.ok || json?.success === false) {
    throw new Error(json?.error || json?.error_info || `Pipedrive ${res.status}`);
  }
  return json;
}

/**
 * O campo do dono muda conforme o tipo da ficha. A atividade aceita os tres,
 * e vincular no mais especifico que temos e o que faz ela aparecer na tela
 * certa do CRM.
 */
export const campoDoAlvo = (tipo) =>
  ({ deal: 'deal_id', person: 'person_id', organization: 'org_id' })[tipo] ?? null;

const COLECAO = { deal: 'deals', person: 'persons', organization: 'organizations' };

export const pipedrive = {
  /**
   * Atividades ja lancadas na ficha. Serve so para deduplicar: sem isto, um
   * reenvio vira atividade repetida no CRM.
   */
  async atividadesDe(token, alvo) {
    const colecao = COLECAO[alvo?.tipo];
    if (!colecao || !alvo?.id) return [];
    const res = await req(token, `${colecao}/${alvo.id}/activities?limit=100`);
    return res?.data ?? [];
  },

  /** O negocio sabe a pessoa; vincular as duas deixa a atividade completa. */
  async pessoaDoNegocio(token, dealId) {
    const res = await req(token, `deals/${dealId}`);
    const p = res?.data?.person_id;
    // person_id vem ora como numero, ora como objeto { value, name, ... }.
    if (typeof p === 'number') return p;
    if (p && typeof p === 'object' && Number.isFinite(Number(p.value))) return Number(p.value);
    return null;
  },

  criarAtividade: (token, atividade) => req(token, 'activities', 'POST', atividade),

  /** Confere se o token e valido, sem efeito colateral. */
  quemSou: (token) => req(token, 'users/me')
};
