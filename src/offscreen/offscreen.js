// src/offscreen/offscreen.js
//
// Equivalente a loadSipExtension() + connectSocket() de web/app.js.
//
// Nao faz regra de negocio: carrega o SIP, abre o socket e repassa TUDO
// para o service worker, que decide o que fazer.

let socket = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'START') start(msg.auth);
  if (msg.type === 'STOP') stop();
});

function start({ token, domain }) {
  stop();

  // 1. SIP - precisa continuar carregado. Se cair, a 3C Plus desloga o ramal.
  document.getElementById('sip').src =
    `https://${domain}.3c.plus/extension?api_token=${encodeURIComponent(token)}`;

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
  socket?.disconnect();
  socket = null;
  const frame = document.getElementById('sip');
  if (frame) frame.src = 'about:blank';
}

function relay(event, data) {
  chrome.runtime.sendMessage({ type: 'SOCKET_EVENT', event, data }).catch(() => {});
}
