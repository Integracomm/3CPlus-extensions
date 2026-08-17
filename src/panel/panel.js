// src/sidepanel/panel.js
//
// UI do operador. Nao fala com a API da 3C Plus diretamente: tudo passa pelo
// service worker (que tem host_permissions e escapa do CORS).
//
// Equivalente ao web/app.js do SDK, menos a parte de socket/SIP - essa vive
// no offscreen document.

const $ = (id) => document.getElementById(id);

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

function render(state) {
  if (!state?.token) {
    showSection('sec-login');
    $('btn-logout').style.display = 'none';
    $('hdr-nome').textContent = '3C Plus';
    $('hdr-sub').textContent = 'nao conectado';
    return;
  }

  $('btn-logout').style.display = '';
  $('hdr-nome').textContent = state.userName ?? 'Operador';
  $('hdr-sub').textContent = `ramal ${state.extension ?? '-'} - ${state.companyName ?? state.domain}`;

  if (!state.campaignId) {
    showSection('sec-campanhas');
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
  $('btn-break').textContent = state.onBreak ? 'Sair' : 'Entrar';

  // Chamada ativa
  const emChamada = Boolean(state.currentCallId);
  $('card-chamada').style.display = emChamada ? '' : 'none';
  $('card-discador').style.display = emChamada ? 'none' : '';

  if (emChamada) {
    $('call-phone').textContent = formatPhone(state.callPhone);
    $('call-id').textContent = state.currentCallId;
    $('call-mailing').textContent = state.mailing
      ? Object.entries(state.mailing)
          .filter(([, v]) => v && typeof v !== 'object')
          .slice(0, 6)
          .map(([k, v]) => `${k}: ${v}`)
          .join('  |  ')
      : '';
    startTimer(state.callStartedAt);
  } else {
    stopTimer();
  }

  // Qualificacao: chega DEPOIS do fim da chamada
  const quals = state.qualifications ?? [];
  const precisa = state.pendingQualification && quals.length > 0;
  $('card-qualificacao').style.display = precisa ? '' : 'none';
  if (precisa) renderQualificacoes(quals);
}

function renderQualificacoes(quals) {
  const box = $('lista-qualificacoes');
  box.innerHTML = '';
  for (const q of quals) {
    const b = document.createElement('button');
    b.textContent = q.name;
    b.onclick = async () => {
      box.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        render(await call('QUALIFY', { qualificationId: q.id }));
        notice('Chamada qualificada.');
      } catch (e) {
        notice(e.message, 'error');
        box.querySelectorAll('button').forEach((x) => (x.disabled = false));
      }
    };
    box.appendChild(b);
  }
}

function startTimer(startedAt) {
  if (timerHandle) return;
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000));
    $('call-timer').textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
  $('call-timer').textContent = '00:00';
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
      domain: $('in-domain').value.trim(),
      user: $('in-user').value.trim(),
      password: $('in-pass').value
    });
    $('in-pass').value = '';
    render(state);
    await carregarCampanhas();
    await carregarIntervalos();
  } catch (e) {
    notice(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
};

$('btn-logout').onclick = async () => {
  await call('LOGOUT').catch(() => {});
  render(null);
};

async function carregarCampanhas() {
  const box = $('lista-campanhas');
  box.textContent = 'carregando...';
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
        try {
          render(await call('SELECT_CAMPAIGN', { id: c.id, name: c.name }));
        } catch (e) {
          notice(e.message, 'error');
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
    notice('Discando...');
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

// ---------------------------------------------------------------------------
// Mensagens do service worker
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'ui') return;

  if (msg.type === 'STATE') render(msg.state);
  if (msg.type === 'NOTICE') notice(msg.text, msg.level);

  if (msg.type === 'SOCKET_EVENT') {
    if (msg.event === 'connect') $('st-ws').classList.add('ok');
    if (msg.event === 'disconnect') $('st-ws').classList.remove('ok');
    if (msg.event === 'agent-is-connected') $('st-sip').classList.add('ok');
    if (msg.event === 'call-dial-failed' || msg.event === 'agent-login-failed') {
      notice(msg.data?.message ?? 'Falha reportada pela 3C Plus', 'error');
    }
  }
});

// Reabrir o painel deve reencontrar a sessao em andamento.
(async () => {
  const state = await call('STATE').catch(() => null);
  render(state);
  if (state?.token) {
    await carregarIntervalos();
    if (!state.campaignId) await carregarCampanhas();
  }
})();
