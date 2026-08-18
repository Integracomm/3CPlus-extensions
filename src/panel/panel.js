// src/panel/panel.js
//
// UI do operador. Nao fala com a API da 3C Plus diretamente: tudo passa pelo
// service worker (que tem host_permissions e escapa do CORS).
//
// Equivalente ao web/app.js do SDK, menos a parte de socket/SIP - essa vive
// no offscreen document.

const $ = (id) => document.getElementById(id);

// Primeira vez que a extensao roda ninguem digitou dominio ainda. Depois do
// primeiro login bem-sucedido o service worker grava o que funcionou em
// Prefs.lastDomain e este padrao deixa de ser usado.
//
// Dois "m": e o subdominio que aparece no Pipedrive da empresa
// (integracomm.pipedrive.com).
const DOMINIO_PADRAO = 'integracomm';

/** Chama uma acao no service worker. */
async function call(type, payload) {
  const res = await chrome.runtime.sendMessage({ target: 'sw', type, payload });
  if (!res?.ok) throw new Error(res?.error ?? 'Falha na comunicacao com a extensao');
  return res.data;
}

function notice(text, level = 'info') {
  const el = $('notice');
  el.textContent = text;
  el.className = level;
  clearTimeout(notice._t);
  notice._t = setTimeout(() => (el.className = ''), 6000);
}

function showSection(id) {
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === id));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let timerHandle = null;
let timerChave = null;

function render(state) {
  renderLog(state?.log);
  $('log-box').style.display = state?.token ? '' : 'none';

  if (!state?.token) {
    showSection('sec-login');
    $('btn-logout').style.display = 'none';
    $('conexao').style.display = 'none';
    $('hdr-ini').textContent = '3C';
    $('hdr-nome').textContent = '3C Plus';
    $('hdr-sub').textContent = 'nao conectado';
    stopTimer();
    return;
  }

  $('btn-logout').style.display = '';
  $('conexao').style.display = '';
  $('hdr-nome').textContent = state.userName ?? 'Operador';
  $('hdr-ini').textContent = iniciais(state.userName);
  $('hdr-sub').textContent =
    `ramal ${state.extension ?? '-'} · ${state.companyName ?? state.domain}`;

  chip($('st-ws'), state.wsOk, 'WebSocket');
  chip($('st-sip'), state.sipOk, 'Ramal SIP');
  renderModo(state);

  if (!state.campaignId) {
    showSection('sec-campanhas');
    stopTimer();
    return;
  }

  showSection('sec-operacao');
  $('op-campanha').textContent = state.campaignName ?? `Campanha ${state.campaignId}`;
  $('op-modo').textContent = state.onBreak
    ? 'em intervalo'
    : state.manualMode
      ? 'modo manual'
      : 'modo dialer - aguardando chamadas';

  $('btn-manual').textContent = state.manualMode ? 'Sair do modo manual' : 'Ativar modo manual';
  $('btn-break').textContent = state.onBreak ? 'Sair do intervalo' : 'Entrar';

  renderStatus(state);
  renderQualificacao(state);
}

/**
 * Card de qualificacao. Aparece sempre que uma chamada encerrou e ainda nao foi
 * qualificada - com a lista, se houver, ou explicando por que nao ha.
 */
function renderQualificacao(state) {
  const precisa = Boolean(state.pendingQualification);
  $('card-qualificacao').style.display = precisa ? '' : 'none';
  if (!precisa) return;

  const quals = state.qualifications ?? [];
  $('qual-vazio').style.display = quals.length ? 'none' : '';

  // Relogio do ACW: a janela tem prazo, e passar dele invalida a chamada.
  if (state.callEndedAt) startTimer(state.callEndedAt, 'qual-tempo');

  const box = $('lista-qualificacoes');

  // A marca inclui a CHAMADA, nao so os ids das qualificacoes.
  //
  // Com os ids sozinhos ela era identica em toda ligacao da mesma campanha:
  // depois da primeira qualificacao os botoes ficavam desabilitados ("Enviando
  // ..."), o card escondia, e na ligacao seguinte a marca batia - entao nada
  // era redesenhado e o operador reencontrava os botoes todos mortos.
  //
  // Com lastCallId junto, cada chamada ganha botoes novos, e os redesenhos
  // durante a MESMA chamada continuam sendo evitados (que e o ponto: nao
  // apagar o clique em andamento a cada STATE do service worker).
  const marca = `${state.lastCallId ?? '-'}:${quals.map((q) => q.id).join(',')}`;
  if (box.dataset.marca === marca) return;
  box.dataset.marca = marca;

  box.innerHTML = '';
  for (const q of quals) {
    const b = document.createElement('button');
    b.textContent = q.name;
    b.onclick = async () => {
      box.querySelectorAll('button').forEach((x) => (x.disabled = true));
      b.textContent = 'Enviando...';
      try {
        render(await call('QUALIFY', { qualificationId: q.id }));
        notice('Chamada qualificada.');
      } catch (e) {
        notice(e.message, 'error');
        b.textContent = q.name;
        box.querySelectorAll('button').forEach((x) => (x.disabled = false));
      }
    };
    box.appendChild(b);
  }
}

/**
 * A "telinha do ramal": o que esta acontecendo com a chamada agora.
 *
 * Fica visivel enquanto houver algo a dizer - inclusive depois de desligar,
 * para o operador ler o desfecho (nao atendida, caixa postal, falhou) em vez
 * de ver o card sumir sem explicacao.
 */
function renderStatus(state) {
  const emChamada = Boolean(state.currentCallId);
  const discando = Boolean(state.dialingTo);
  const temStatus = Boolean(state.callStatusText);

  $('card-status').style.display = temStatus || emChamada ? '' : 'none';
  // O discador some enquanto ha qualificacao pendente: discar ali so traria o
  // 422 "Agente nao esta ocioso".
  $('card-discador').style.display =
    emChamada || discando || state.pendingQualification ? 'none' : '';
  if (!temStatus && !emChamada) {
    stopTimer();
    return;
  }

  $('card-status').dataset.st = state.callStatus ?? '';
  $('status-texto').textContent = state.callStatusText ?? '-';
  $('call-phone').textContent = formatPhone(state.callPhone ?? state.dialingTo);
  $('call-id').textContent = state.currentCallId ? `chamada ${state.currentCallId}` : '';
  $('call-detalhe').textContent = state.callStatusDetail ?? '';
  $('btn-hangup').style.display = emChamada ? '' : 'none';

  $('call-mailing').textContent = state.mailing
    ? Object.entries(state.mailing)
        .filter(([, v]) => v && typeof v !== 'object')
        .slice(0, 6)
        .map(([k, v]) => `${k}: ${v}`)
        .join('  |  ')
    : '';

  // O cronometro so corre com um inicio de verdade. Sem callStartedAt ele
  // marcava 00:00 fixo, que parece cronometro travado - pior do que nao ter.
  if (emChamada && state.callStartedAt) startTimer(state.callStartedAt);
  else {
    stopTimer();
    $('call-timer').textContent = emChamada ? '--:--' : '00:00';
  }
}

// Como a 3C Plus enxerga o ramal. Nao e enfeite: entrar em modo manual exige
// o agente OCIOSO, e preso em ACW a discagem volta 422.
const AGENTE = {
  OFFLINE: ['Offline', 'ruim'],
  IDLE: ['Ocioso', 'ok'],
  ON_CALL: ['Em chamada', 'ok'],
  ACW: ['Em ACW', 'alerta'],
  ON_MANUAL_CALL: ['Chamada manual', 'ok'],
  ON_MANUAL_CALL_CONNECTED: ['Em chamada', 'ok'],
  ON_WORK_BREAK: ['Em intervalo', 'alerta'],
  ON_MANUAL_CALL_ACW: ['Em ACW', 'alerta']
};

function renderModo(state) {
  const el = $('st-modo');

  // O estado do agente manda, quando a 3C Plus informou.
  const [texto, classe] = AGENTE[state.agentStatusText] ?? [null, null];
  if (texto) {
    el.textContent = texto;
    el.className = `chip ${classe}`;
    return;
  }

  el.className = 'chip';
  if (state.onBreak) {
    el.textContent = 'Em intervalo';
  } else if (state.manualMode) {
    el.textContent = 'Modo manual';
    el.classList.add('ok');
  } else if (state.campaignId) {
    el.textContent = 'Modo dialer';
  } else {
    el.textContent = 'Sem campanha';
  }
}

function chip(el, ok, rotulo) {
  el.textContent = rotulo;
  el.className = `chip ${ok ? 'ok' : 'ruim'}`;
}

function iniciais(nome) {
  const p = String(nome ?? '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '3C';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/**
 * Log de eventos. Existe por um motivo pratico: quando a ligacao nao sai, o
 * erro esta quase sempre num evento do socket que ninguem via.
 */
function renderLog(log) {
  const box = $('log');
  const linhas = log ?? [];
  // Marca do estado atual. Nao da para usar so o tamanho: passando de 40 o log
  // trunca e o tamanho para de mudar, mas o conteudo continua andando.
  const marca = `${linhas.length}:${linhas.at(-1)?.t ?? 0}`;
  if (box.dataset.marca === marca) return;
  box.dataset.marca = marca;

  box.innerHTML = '';
  for (const l of [...linhas].reverse()) {
    const div = document.createElement('div');
    div.className = `linha ${l.nivel ?? 'evento'}`;

    const hora = document.createElement('span');
    hora.className = 'hora';
    hora.textContent = new Date(l.t).toLocaleTimeString('pt-BR', { hour12: false });

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = l.texto;
    if (l.detalhe) {
      const i = document.createElement('i');
      i.textContent = l.detalhe;
      txt.appendChild(i);
    }

    div.append(hora, txt);
    box.appendChild(div);
  }
}

/**
 * Um relogio de cada vez: ou o da chamada em andamento, ou o do ACW correndo.
 * A chave (alvo + inicio) evita reiniciar a contagem a cada render.
 */
function startTimer(startedAt, alvo = 'call-timer') {
  const chave = `${alvo}:${startedAt ?? 0}`;
  if (timerChave === chave) return;
  stopTimer();
  timerChave = chave;

  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000));
    $(alvo).textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
  timerChave = null;
}

function formatPhone(p) {
  const d = String(p ?? '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return p ?? '-';
}

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

$('btn-login').onclick = async () => {
  const btn = $('btn-login');
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  try {
    const state = await call('LOGIN', {
      domain: $('in-domain').value.trim().replace(/\.3c\.plus.*$/i, ''),
      user: $('in-user').value.trim(),
      password: $('in-pass').value
    });
    $('in-pass').value = '';
    render(state);
    // Intervalos so depois da campanha: antes disso o agente ainda nao esta
    // online e a API responde "O agente nao esta online".
    await carregarCampanhas();
  } catch (e) {
    notice(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
};

// Enter em qualquer campo do login entra.
for (const id of ['in-domain', 'in-user', 'in-pass']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-login').click();
  });
}

// ---------------------------------------------------------------------------
// Token do Pipedrive
//
// Fica so nesta maquina (chrome.storage.local) e e conferido contra a API antes
// de salvar - token errado descoberto no fim do turno, quando as atividades nao
// apareceram, seria bem pior.
// ---------------------------------------------------------------------------

async function renderPipedrive() {
  const guardado = await chrome.storage.local
    .get(['pipedriveToken', 'pipedriveUser'])
    .catch(() => ({}));
  const temToken = Boolean(guardado?.pipedriveToken);

  // O token NAO volta para a tela. Sai uma vez do teclado e fica no storage:
  // reecoar o segredo no DOM nao ajuda a editar - digitar outro ja troca.
  $('in-pd-token').value = '';
  $('in-pd-token').placeholder = temToken
    ? 'token salvo — digite outro para trocar'
    : 'cole aqui o seu token do Pipedrive';

  $('pd-chip').textContent = temToken
    ? (guardado.pipedriveUser ?? 'conectado')
    : 'não configurado';
  $('pd-chip').className = `chip ${temToken ? 'ok' : ''}`;
  $('btn-pd-remover').style.display = temToken ? '' : 'none';
  $('btn-pd-salvar').textContent = temToken ? 'Trocar' : 'Salvar';
}

$('btn-pd-salvar').onclick = async () => {
  const btn = $('btn-pd-salvar');
  const token = $('in-pd-token').value.trim();
  if (!token) return notice('Cole o token antes de salvar.', 'error');

  btn.disabled = true;
  try {
    const nome = await call('PIPEDRIVE_TOKEN', { token });
    await renderPipedrive();
    notice(`Token válido. Atividades sairão como ${nome}.`);
  } catch (e) {
    notice(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
};

$('btn-pd-remover').onclick = async () => {
  await chrome.storage.local.remove(['pipedriveToken', 'pipedriveUser']);
  await renderPipedrive();
  notice('Token removido. As ligações não vão mais gerar atividade.');
};

// ---------------------------------------------------------------------------
// Microfone
//
// Sem permissao a chamada acontece e ninguem ouve nada - e em silencio, sem
// erro em lugar nenhum. Por isso o aviso fica fixo no topo enquanto nao for
// liberado, com um caminho de volta: se a tela de permissao falhar, da para
// tentar de novo sem deslogar.
// ---------------------------------------------------------------------------

async function renderMic() {
  const { micGranted } = await chrome.storage.local.get('micGranted').catch(() => ({}));
  $('aviso-mic').style.display = micGranted ? 'none' : 'flex';
}

$('btn-mic').onclick = async () => {
  try {
    await call('OPEN_MIC');
  } catch (e) {
    notice(e.message, 'error');
  }
};

// A tela de permissao grava micGranted; o aviso some sozinho quando isso muda.
chrome.storage.onChanged.addListener((mudou, area) => {
  if (area === 'local' && 'micGranted' in mudou) renderMic();
});

$('btn-logout').onclick = async () => {
  await call('LOGOUT').catch(() => {});
  render(null);
};

async function carregarCampanhas() {
  const box = $('lista-campanhas');
  box.innerHTML = '<span class="muted">carregando...</span>';
  try {
    const campanhas = await call('CAMPAIGNS');
    box.innerHTML = '';
    if (!campanhas.length) {
      box.innerHTML = '<span class="muted">Nenhuma campanha disponivel.</span>';
      return;
    }
    for (const c of campanhas) {
      const div = document.createElement('div');
      div.className = 'item';
      div.textContent = c.name;
      div.onclick = async () => {
        box.querySelectorAll('.item').forEach((x) => (x.style.pointerEvents = 'none'));
        div.textContent = `${c.name} — entrando...`;
        try {
          render(await call('SELECT_CAMPAIGN', { id: c.id, name: c.name }));
          await carregarIntervalos();
        } catch (e) {
          notice(e.message, 'error');
          await carregarCampanhas();
        }
      };
      box.appendChild(div);
    }
  } catch (e) {
    box.innerHTML = '';
    notice(e.message, 'error');
  }
}

async function carregarIntervalos() {
  const sel = $('sel-intervalo');
  try {
    const lista = await call('INTERVALS');
    sel.innerHTML = lista.map((i) => `<option value="${i.id}">${i.name}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">indisponivel</option>';
  }
}

$('btn-sair-campanha').onclick = async () => {
  try {
    render(await call('LEAVE_CAMPAIGN'));
    await carregarCampanhas();
  } catch (e) {
    notice(e.message, 'error');
  }
};

$('btn-manual').onclick = async () => {
  try {
    render(await call('TOGGLE_MANUAL'));
  } catch (e) {
    notice(e.message, 'error');
  }
};

$('btn-dial').onclick = async () => {
  const phone = $('in-phone').value.replace(/\D/g, '');
  if (phone.length < 10) return notice('Numero invalido. Use DDD + numero.', 'error');
  try {
    await call('DIAL', { phone });
    $('in-phone').value = '';
  } catch (e) {
    notice(e.message, 'error');
  }
};

$('in-phone').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-dial').click();
});

$('btn-qual-dispensar').onclick = async () => {
  try {
    render(await call('DISMISS_QUAL'));
    notice('Dispensada. Isso não qualifica na 3C Plus — o ramal pode seguir em ACW lá.');
  } catch (e) {
    notice(e.message, 'error');
  }
};

$('btn-hangup').onclick = async () => {
  try {
    await call('HANGUP');
  } catch (e) {
    notice(e.message, 'error');
  }
};

$('btn-break').onclick = async () => {
  try {
    const st = await call('STATE');
    render(
      st?.onBreak
        ? await call('BREAK_EXIT')
        : await call('BREAK_ENTER', { intervalId: Number($('sel-intervalo').value) })
    );
  } catch (e) {
    notice(e.message, 'error');
  }
};

// Exportado so para o teste (test/painel.mjs) conseguir simular "reabriu o
// painel" sem recarregar o modulo. No navegador ninguem importa este arquivo.
export { renderPipedrive };

// ---------------------------------------------------------------------------
// Mensagens do service worker
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'ui') return;
  if (msg.type === 'STATE') render(msg.state);
  if (msg.type === 'NOTICE') notice(msg.text, msg.level);
});

// Reabrir a janela deve reencontrar a sessao em andamento.
(async () => {
  const { lastDomain } = await chrome.storage.local.get('lastDomain').catch(() => ({}));
  $('in-domain').value = lastDomain ?? DOMINIO_PADRAO;

  const state = await call('STATE').catch(() => null);
  render(state);
  await renderMic();
  await renderPipedrive();

  if (state?.token) {
    if (state.campaignId) await carregarIntervalos();
    else await carregarCampanhas();
  } else {
    $('in-user').focus();
  }
})();
