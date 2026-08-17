// src/permission/mic.js
//
// Um offscreen document nao consegue exibir o prompt de microfone. Sem esta
// etapa a chamada "acontece" mas ninguem ouve nada - e sem nenhum erro no
// console, que e o pior tipo de bug.
//
// Concedendo aqui, a permissao fica gravada para a origem chrome-extension://
// e vale para o offscreen dali em diante.
//
// Roda numa janela propria, nao numa aba: em aba o pedido fica atras do CRM e
// o operador comeca o turno mudo sem perceber.
//
// A janela e do tipo 'normal' (com barra de endereco) e nao 'popup', porque a
// bolha de permissao do Chrome ancora embaixo da barra de endereco. Numa popup
// nao ha onde ancorar: a bolha nunca aparece e o getUserMedia devolve
// NotAllowedError como se o operador tivesse recusado.
//
// O botao "Tentar em uma aba" fica como ultimo recurso.

const $ = (id) => document.getElementById(id);

function mostrar(classe, titulo, corpoHtml = '') {
  const el = $('status');
  el.className = `on ${classe}`;
  el.innerHTML = '';

  const b = document.createElement('b');
  b.textContent = titulo;
  el.appendChild(b);

  if (corpoHtml) {
    const div = document.createElement('div');
    div.innerHTML = corpoHtml; // conteudo fixo deste arquivo, nunca da rede
    el.appendChild(div);
  }
}

/** Linha crua embaixo: e o que interessa quando a mensagem amigavel nao basta. */
function tecnico(texto) {
  $('tecnico').textContent = texto ?? '';
}

// ---------------------------------------------------------------------------
// Diagnostico por tipo de erro
// ---------------------------------------------------------------------------

const AJUDA = {
  NotAllowedError: [
    'O Chrome bloqueou o microfone para esta extensão.',
    '' // o passo a passo fica no bloco #desbloquear, com os atalhos prontos
  ],
  NotFoundError: [
    'Nenhum microfone encontrado.',
    '<ul><li>Conecte o headset e clique de novo.</li>' +
      '<li>Confira se o Windows está enxergando o dispositivo em Configurações → Sistema → Som.</li></ul>'
  ],
  NotReadableError: [
    'O microfone existe, mas está ocupado.',
    '<ul><li>Feche o que estiver usando o microfone (Teams, Meet, Zoom, o app web da 3C Plus) e tente de novo.</li></ul>'
  ],
  OverconstrainedError: [
    'O microfone não aceita a configuração pedida.',
    '<ul><li>Troque o dispositivo padrão do Windows e tente de novo.</li></ul>'
  ],
  SecurityError: [
    'O Chrome recusou por contexto inseguro.',
    '<ul><li>Aconteceu algo fora do previsto — me mande a linha técnica abaixo.</li></ul>'
  ],
  AbortError: [
    'O pedido foi interrompido pelo sistema.',
    '<ul><li>Tente de novo. Se repetir, reinicie o Chrome.</li></ul>'
  ]
};

// Nomes antigos que o Chrome ainda usa em alguns caminhos.
const APELIDOS = {
  PermissionDeniedError: 'NotAllowedError',
  DevicesNotFoundError: 'NotFoundError',
  TrackStartError: 'NotReadableError',
  ConstraintNotSatisfiedError: 'OverconstrainedError'
};

/**
 * O estado guardado da permissao, sem disparar prompt nenhum.
 * 'denied' aqui e a prova de que existe bloqueio salvo - nao e bolha que
 * deixou de aparecer.
 */
async function estadoGuardado() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    return p.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return null;
  }
}

async function explicar(err) {
  const nome = APELIDOS[err?.name] ?? err?.name ?? 'Erro';
  const [titulo, corpo] = AJUDA[nome] ?? [
    'Não foi possível liberar o microfone.',
    '<ul><li>Tente pela aba, e se continuar me mande a linha técnica abaixo.</li></ul>'
  ];
  mostrar('err', titulo, corpo);

  const estado = await estadoGuardado();
  tecnico(
    `${err?.name ?? 'Erro'}: ${err?.message ?? String(err)}` +
      (estado ? ` · permissions.query: ${estado}` : '')
  );

  // Bloqueio salvo: mostra o caminho para limpar, com os atalhos prontos.
  $('desbloquear').classList.toggle('on', nome === 'NotAllowedError');
}

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

$('grant').addEventListener('click', async () => {
  const btn = $('grant');
  btn.disabled = true;
  mostrar('', 'Pedindo permissão...');
  tecnico('');

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('navigator.mediaDevices indisponível nesta janela'), {
        name: 'SecurityError'
      });
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // so queriamos a permissao

    await chrome.storage.local.set({ micGranted: true });

    mostrar('ok', 'Microfone liberado.', '<div>Pode fechar esta janela.</div>');
    setTimeout(() => window.close(), 1600);
  } catch (err) {
    await explicar(err);
    btn.disabled = false;
  }
});

// Plano B: abrir esta mesma pagina numa aba normal.
$('aba').addEventListener('click', async () => {
  await chrome.tabs.create({ url: location.href });
  window.close();
});

// ---------------------------------------------------------------------------
// Atalhos para as configuracoes do Chrome
//
// Nao da para navegar para chrome:// programaticamente em todo caminho, entao
// se a criacao da aba falhar a origem fica na tela para copiar e colar.
// ---------------------------------------------------------------------------

$('origem').textContent = location.origin;

async function abrirConfig(url) {
  try {
    await chrome.tabs.create({ url });
  } catch {
    mostrar(
      'err',
      'O Chrome não deixou abrir a configuração daqui.',
      '<div>Copie o endereço abaixo e cole na barra do Chrome:</div>' +
        `<code style="user-select:all">${url}</code>`
    );
  }
}

// Deep link direto para as permissoes desta extensao - poupa procurar na lista.
$('abrir-site').addEventListener('click', () =>
  abrirConfig(`chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`)
);

$('abrir-mic').addEventListener('click', () =>
  abrirConfig('chrome://settings/content/microphone')
);

// ---------------------------------------------------------------------------
// Ao abrir: le o estado guardado antes de pedir qualquer coisa
// ---------------------------------------------------------------------------

(async () => {
  const estado = await estadoGuardado();

  if (estado === 'denied') {
    // Nao adianta clicar em Permitir: o Chrome nega na hora, sem bolha.
    mostrar('err', 'O Chrome está com o microfone bloqueado para esta extensão.');
    tecnico('permissions.query: denied');
    $('desbloquear').classList.add('on');
    return;
  }

  if (estado === 'granted') {
    // Liberado por fora (nas configuracoes do Chrome): registra e sai.
    await chrome.storage.local.set({ micGranted: true });
    mostrar('ok', 'Microfone já liberado.', '<div>Pode fechar esta janela.</div>');
    $('grant').disabled = true;
  }
})();
