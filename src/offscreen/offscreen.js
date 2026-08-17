// src/offscreen/offscreen.js
//
// Equivalente a loadSipExtension() + connectSocket() de web/app.js.
//
// Nao faz regra de negocio: carrega o SIP, abre o socket e repassa TUDO
// para o service worker, que decide o que fazer.

let socket = null;

// O que ja esta rodando, no formato "dominio|token". Serve para o START vindo
// por mensagem nao derrubar e resubir uma conexao identica que ja existe.
let atual = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'START') start(msg.auth);
  if (msg.type === 'STOP') stop();
});

// O service worker manda START logo depois de criar este documento - e essa
// mensagem chega antes do listener acima existir com frequencia suficiente
// para o operador terminar o turno inteiro sem socket e sem SIP, em silencio.
//
// Entao nao dependemos dela: ao carregar, PEDIMOS a credencial. O START
// continua valendo como reforco.
//
// Tem que ser por mensagem, nao por storage: um offscreen document so enxerga
// chrome.runtime. chrome.storage e undefined aqui - todo o resto da API da
// extensao precisa passar pelo service worker.
chrome.runtime
  .sendMessage({ target: 'sw', type: 'OFFSCREEN_READY' })
  .then((res) => {
    if (res?.ok && res.data?.token) start(res.data);
  })
  .catch(() => {
    // service worker ainda subindo: o START resolve
  });

function start({ token, domain }) {
  const chave = `${domain}|${token}`;
  if (atual === chave) return; // ja no ar com esta credencial
  stop();
  atual = chave;

  // 0. O webphone dentro do iframe SIP precisa do microfone para registrar.
  //    Bloqueado, ele carrega a pagina, nao registra, e o agent-is-connected
  //    nunca chega - a campanha recusa o login depois e ninguem entende por
  //    que. Perguntamos daqui porque esta e a origem que o iframe herda.
  //
  //    navigator.permissions e API do DOM, nao da extensao: funciona no
  //    offscreen mesmo sem chrome.storage.
  navigator.permissions
    ?.query({ name: 'microphone' })
    .then((p) => relay('mic-permissao', { state: p.state }))
    .catch(() => {});

  // 1. SIP - precisa continuar carregado. Se cair, a 3C Plus desloga o ramal.
  const frame = document.getElementById('sip');
  frame.addEventListener('load', () => relay('sip-carregou', {}), { once: true });
  frame.src = `https://${domain}.3c.plus/extension?api_token=${encodeURIComponent(token)}`;

  // 2. WebSocket - a API REST so confirma que o comando foi aceito; quem
  //    avisa que a chamada conectou/terminou e o socket.
  socket = io('https://socket.3c.plus', {
    transports: ['websocket'],
    query: { token }
  });

  socket.on('connect', () => relay('connect', {}));
  socket.on('disconnect', (reason) => relay('disconnect', { reason }));
  socket.on('connect_error', (err) => relay('connect_error', { message: err?.message }));

  // onAny nao dispara para os eventos reservados acima - dai o tratamento
  // explicito deles.
  socket.onAny((event, data) => relay(event, data));
}

function stop() {
  atual = null;
  socket?.disconnect();
  socket = null;
  const frame = document.getElementById('sip');
  if (frame) frame.src = 'about:blank';
}

function relay(event, data) {
  chrome.runtime.sendMessage({ type: 'SOCKET_EVENT', event, data }).catch(() => {});
}
