// src/lib/atividade.js
//
// Monta a atividade do Pipedrive a partir do que a extensao sabe da ligacao.
// Porte do buildActivity/buildNote do pipe-to-3cplus, para o formato ficar
// igual ao das ligacoes que nascem por la.
//
// Duas coisas o click2call NAO tem, e por isso nao aparecem na nota:
//   - link da gravacao, que sai do relatorio da 3C Plus;
//   - dados do lead, porque chamada manual sai com mailing_data vazio.

/** Como o desfecho interno aparece escrito na atividade. */
const ROTULO = {
  encerrada: 'atendida',
  falando: 'atendida',
  'nao-atendida': 'não atendida',
  falhou: 'falhou',
  caixa: 'caixa postal'
};

/**
 * Marca que amarra a atividade a chamada da 3C, e que permite reconhecer um
 * reenvio como "ja lancado".
 *
 * VISIVEL de proposito. No pipe-to-3cplus a primeira versao usou comentario
 * HTML (`<!-- 3c-call:id -->`), invisivel na tela - mas o Pipedrive sanitiza o
 * HTML da nota e descarta comentarios: a marca sumia no salvamento, a
 * deduplicacao nunca achava nada e todo reenvio virava atividade repetida.
 * Foi medido em producao. Como linha de texto ela sobrevive.
 */
export const MARCA_LABEL = 'ID da chamada na 3C';

export const marcaDaChamada = (callId) =>
  `<b>${MARCA_LABEL}:</b> ${escapar(String(callId ?? ''))}`;

export const jaLancada = (atividades, callId) => {
  const marca = marcaDaChamada(callId);
  return (atividades ?? []).some((a) => (a?.note ?? '').includes(marca));
};

/** "Ligação atendida - Fulano" */
export function assunto(call) {
  const quem = call.customerName?.trim() || formatarTelefone(call.phone);
  return `Ligação ${ROTULO[call.result] ?? call.result ?? 'realizada'} - ${quem}`;
}

/**
 * Nota em HTML, que e como o Pipedrive renderiza o campo. A ordem segue a
 * leitura natural do desfecho: quando, por qual campanha, o que deu, e quem
 * falou.
 */
export function nota(call) {
  const linhas = [];

  linhas.push(linha('Início', dataHora(call.startedAt)));
  linhas.push(linha('Fim', dataHora(call.endedAt)));
  if (call.talkSeconds > 0) linhas.push(linha('Tempo de conversa', tempoLegivel(call.talkSeconds)));
  if (call.campaignName) linhas.push(linha('Campanha', call.campaignName));

  linhas.push(linha('Resultado', ROTULO[call.result] ?? call.result ?? '-'));
  if (call.agentName) linhas.push(linha('Agente', call.agentName));
  linhas.push(linha('Qualificação', call.qualificationName || 'não qualificada'));
  linhas.push(linha('Telefone', formatarTelefone(call.phone)));

  return `${linhas.join('<br>')}<br>${marcaDaChamada(call.callId)}`;
}

/**
 * Atividade completa, pronta para o POST.
 *
 * `done: 1` porque a ligacao ja aconteceu: atividade em aberto viraria tarefa
 * pendente na agenda do operador.
 */
export function montarAtividade(call, { campoAlvo, alvoId, personId, tipo = 'call' }) {
  const fim = new Date(call.endedAt ?? Date.now());

  return {
    subject: assunto(call),
    type: tipo,
    done: 1,
    // O Pipedrive guarda due_date/due_time em UTC.
    due_date: fim.toISOString().slice(0, 10),
    due_time: fim.toISOString().slice(11, 16),
    ...(call.talkSeconds > 0 ? { duration: duracao(call.talkSeconds) } : {}),
    [campoAlvo]: alvoId,
    ...(personId && campoAlvo !== 'person_id' ? { person_id: personId } : {}),
    note: nota(call)
  };
}

// ---------------------------------------------------------------------------

const linha = (rotulo, valor) => `<b>${escapar(rotulo)}:</b> ${escapar(String(valor ?? '-'))}`;

function escapar(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Segundos -> "HH:MM", que e o formato que o campo `duration` aceita.
 *
 * Perde os segundos por definicao: uma ligacao de 2min05 vira "00:02". Por isso
 * a NOTA usa tempoLegivel(), que preserva - senao o operador leria "00:02" e
 * entenderia dois segundos.
 */
function duracao(segundos) {
  const m = Math.round((segundos ?? 0) / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Segundos -> "2 min 5 s", para leitura humana dentro da nota. */
function tempoLegivel(segundos) {
  const s = Math.max(0, Math.round(segundos ?? 0));
  const min = Math.floor(s / 60);
  const seg = s % 60;
  if (!min) return `${seg} s`;
  return seg ? `${min} min ${seg} s` : `${min} min`;
}

function dataHora(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatarTelefone(p) {
  const d = String(p ?? '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return p ?? '-';
}
