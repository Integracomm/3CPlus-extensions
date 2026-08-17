// src/lib/storage.js
//
// Porte do src/storage/TokenStorage.ts do SDK: la o token ia para um
// token.json no disco, aqui vai para chrome.storage.session.
//
// Por que "session" e nao "local":
//  - fica so em memoria, some quando o Chrome fecha (o operador re-loga a
//    cada turno, que e o comportamento correto para call center);
//  - por padrao o nivel de acesso e TRUSTED_CONTEXTS, ou seja, content
//    scripts NAO conseguem ler. O JWT nunca chega na pagina do CRM.

const KEY = 'c3plus';

/** Estado compartilhado entre service worker, side panel e offscreen. */
export const Session = {
  async get() {
    const data = await chrome.storage.session.get(KEY);
    return data[KEY] ?? null;
  },

  /** Merge raso: passe so os campos que mudaram. */
  async set(patch) {
    const next = { ...((await Session.get()) ?? {}), ...patch };
    await chrome.storage.session.set({ [KEY]: next });
    return next;
  },

  async clear() {
    await chrome.storage.session.remove(KEY);
  }
};

/**
 * Flags que devem sobreviver ao fechamento do navegador (ex.: ja pedimos
 * permissao de microfone uma vez). Vai em "local" mesmo.
 */
export const Prefs = {
  async get(key, fallback = null) {
    const data = await chrome.storage.local.get(key);
    return data[key] ?? fallback;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }
};
