// src/permission/mic.js
//
// Um offscreen document nao consegue exibir o prompt de microfone. Sem esta
// etapa a chamada "acontece" mas ninguem ouve nada - e sem nenhum erro no
// console, que e o pior tipo de bug.
//
// Concedendo aqui, a permissao fica gravada para a origem chrome-extension://
// e vale para o offscreen dali em diante.

const status = document.getElementById('status');

document.getElementById('grant').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // so queriamos a permissao

    await chrome.storage.local.set({ micGranted: true });

    status.className = 'ok';
    status.textContent = 'Microfone liberado. Pode fechar esta aba.';
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    status.className = 'err';
    status.textContent = `Nao foi possivel liberar: ${err.message}`;
  }
});
