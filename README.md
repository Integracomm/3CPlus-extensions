# 3C Plus Click-to-Call — extensão Chrome

Extensão Manifest V3 construída sobre o SDK deste repositório. Detecta telefones
na tela do CRM e disca pela 3C Plus com um clique.

## Instalar em modo desenvolvedor

```bash
cd extension
npm install
npm run build      # gera vendor/socket.io.js (MV3 não carrega script de CDN)
```

1. Abra `chrome://extensions`
2. Ligue **Modo do desenvolvedor** (canto superior direito)
3. **Carregar sem compactação** → selecione a pasta `extension/`
4. Fixe a extensão na barra e clique no ícone para abrir o painel lateral

O `manifest.json` já vem apontado para `https://*.pipedrive.com/*`.

## O painel do operador

É o **side panel nativo do Chrome**: fica encaixado na lateral, ao lado do CRM,
e acompanha a janela do navegador. Clicar no ícone da extensão abre e fecha
(`setPanelBehavior({ openPanelOnActionClick: true })`).

O botão flutuante também abre, via `chrome.sidePanel.open()`. Esse método
**exige gesto do usuário** e precisa saber em qual janela do navegador encaixar
— por isso o `sender` da mensagem é repassado até `abrirPainel()`. Se o Chrome
recusar mesmo assim, o fluxo não quebra: o operador vê um aviso mandando clicar
no ícone da extensão.

**A janela do microfone continua sendo janela** (`type: 'normal'`), e não pode
virar side panel — veja o porquê na seção de microfone.

## Primeiro uso

1. Painel lateral → domínio, ramal e senha. O domínio já vem preenchido:
   `DOMINIO_PADRAO` em `src/panel/panel.js` na primeira vez, e depois disso o
   último que deu login (`lastDomain` em `chrome.storage.local`)
2. Um popup de permissão de microfone abre automaticamente — **autorize**
3. Escolha a campanha
4. Abra o Pipedrive: botões “Ligar” aparecem ao lado dos telefones

## Detecção no Pipedrive

Duas fontes, nesta ordem de confiança:

1. **Links `tel:`/`callto:`** — o Pipedrive renderiza campo de telefone como
   âncora. Zero falso positivo; funciona em ficha de pessoa, negócio,
   organização e nas listas.
2. **Regex sobre texto** — rede de segurança para número em nota, descrição de
   atividade ou campo customizado que não virou link.

Nunca use seletor de classe do Pipedrive: os nomes são hasheados (`.sc-a1b2c3`)
e mudam a cada release deles.

## Botão flutuante

Além do botãozinho ao lado de cada número, existe um botão fixo no canto
inferior direito. Ele fica **sempre visível**, em qualquer tela do Pipedrive, e
tem três caras nesta ordem de prioridade:

| Situação | Botão | Ao clicar |
|---|---|---|
| Sem sessão | `📞 Entrar no 3C Plus` | abre o painel lateral para logar |
| Telefone na ficha | `📞 Ligar` + o número | disca aquele número |
| Resto | `📞 Abrir painel` | abre o painel lateral |

O número aparece no próprio botão de propósito: é um alvo grande, o operador
precisa conferir para quem vai ligar antes de clicar.

Três decisões que valem saber:

- **O botão aparece sempre, mas só escolhe telefone sozinho na ficha** — negócio,
  lead, pessoa ou organização. No funil ou numa lista, o primeiro link `tel:` da
  tela é um contato qualquer; oferecer isso num alvo grande seria convidar a
  ligar para a pessoa errada. Os botõezinhos ao lado de cada número continuam
  funcionando ali normalmente.
- **O número sai só de link `tel:`**, nunca do fallback de regex. Mesmo motivo.
- **Se a ficha tiver mais de um telefone** (celular e comercial, por exemplo),
  ele pega o primeiro na ordem do DOM. Para os outros, use o botãozinho ao lado
  do número.

Quem decide "estou numa ficha" é a **URL**, em `FICHA_RE` / `FICHA_LEAD_RE`
(`src/content/detector.js`) — a URL do Pipedrive é estável, as classes não.
Para desligar o botão de vez: `CONFIG.floatingButton = false`.

### Como o botão sabe se há sessão

Perguntando ao service worker (`UI_STATE`), que devolve **só booleanos** —
nenhum token, nome ou telefone chega na página do CRM. É a mesma razão de a
sessão viver em `chrome.storage.session`, que content script não lê.

A pergunta é feita em momentos raros de propósito: na carga, na troca de URL, ao
voltar o foco para a aba, e no fim de cada clique. Perguntar a cada varredura
acordaria o service worker sem parar e ele nunca hibernaria.

Quando falta sessão ou campanha, **o próprio service worker abre o painel** em
vez de só recusar — vale para os três caminhos que discam: botão flutuante,
botão de cada número e menu de contexto.

## Arquitetura

| Contexto | Arquivo | Papel |
|---|---|---|
| Content script | `src/content/detector.js` | acha telefones, injeta botões |
| Service worker | `src/background/service-worker.js` | roteador + todas as chamadas REST |
| Offscreen | `src/offscreen/offscreen.js` | iframe SIP + WebSocket (persistente) |
| Painel (side panel) | `src/panel/panel.js` | login, campanha, status da chamada |

O offscreen document é o único contexto MV3 que fica vivo indefinidamente —
por isso o SIP e o socket moram nele. O service worker hiberna aos ~30s
ociosos, então nenhum estado vive em variável de módulo: tudo em
`chrome.storage.session`.

**Um offscreen document só enxerga `chrome.runtime`.** `chrome.storage` é
`undefined` lá — todo o resto da API da extensão tem que passar por mensagem
para o service worker. É por isso que ele pede a credencial com
`OFFSCREEN_READY` em vez de ler a sessão do storage.

### Ordem que importa na entrada

`SELECT_CAMPAIGN` espera o **SIP registrar** (evento `agent-is-connected`)
antes de chamar `agent/login`. O iframe ter carregado não basta: o registro vem
alguns segundos depois. Logando a campanha antes disso, a 3C Plus aceita no
REST e manda `agent-login-failed` pelo socket em seguida — o agente fica meio
logado e a discagem seguinte volta 422 "Agente não está ocioso."

Quando o socket recusa, quem manda é o socket: a extensão limpa `campaignId`.
Sem isso o painel mostraria "na campanha" enquanto toda discagem falha.

## Ciclo da chamada: duas fontes, nenhuma obrigatória

A lição que custou caro: **nenhuma fonte de evento é confiável sozinha.**

- Os eventos de chamada nem sempre chegam todos. Já vimos chamada manual sem
  `call-was-connected` e sem `call-was-finished`.
- `agent.status` vem de carona em quase todo evento, mas nem sempre vem — e nem
  sempre como número (aceita `5` e `"5"`).

Então as **duas** escrevem o mesmo estado, por transições idempotentes
(`entrarEmChamada`, `entrarEmChamando`, `encerrarChamada`, `liberarRamal`):
quem chegar primeiro resolve, quem chegar depois confirma. Se uma sumir, a
outra sustenta o ciclo sozinha.

```
discando → chamando → falando → encerrada | nao-atendida | falhou | caixa
```

| `agent.status` | Significa |
|---|---|
| `ON_CALL`, `ON_MANUAL_CALL_CONNECTED` | falando — cronômetro corre |
| `ON_MANUAL_CALL` | chamando — tocando do outro lado |
| `ACW`, `ON_MANUAL_CALL_ACW` | encerrada — para o cronômetro |
| `IDLE` | ramal livre — limpa tudo |

Duas garantias que os testes fixam:

- **O cronômetro não reinicia** com evento repetido (`callStartedAt` só é
  gravado uma vez por chamada) e só corre com um início de verdade — sem ele o
  painel mostra `--:--`, não um `00:00` que parece travado.
- **Um desfecho específico não é sobrescrito** pelo genérico "encerrada" quando
  o ACW chega depois.
- **Estado terminal não é ressuscitado.** O payload que anuncia o fim costuma
  carregar um `agent.status` *atrasado* (ainda `ON_MANUAL_CALL`). Sem trava, a
  reconciliação reescrevia "Chamando..." por cima do "Não atendida" que o
  próprio evento acabara de gravar — era o que travava o painel quando o
  destino recusava a ligação. Depois de um desfecho a reconciliação não mexe
  mais; só uma discagem nova (ou um `call-was-connected` explícito) recomeça.
- **Recusa sem ACW vira "Não atendida".** Quando o destino desliga antes de
  atender não há ACW: o ramal volta direto para `IDLE`. Nesse caso o desfecho é
  inferido, em vez de o painel ficar em "Chamando..." para sempre.
- **O desfecho fica na tela** até a próxima discagem. Quem limpa é o `dial()`
  seguinte, não o `IDLE`.
- **Desligar pela extensão encerra na hora**, sem esperar o socket. Quando o
  próprio operador desliga, a 3C Plus não manda evento de fim de volta — não há
  novidade a anunciar para quem causou o fim. Sem isso o painel ficava em "Em
  chamada" com o cronômetro correndo depois de clicar em Desligar.

## Testes

```bash
npm test
```

`test/ciclo-chamada.mjs` sobe o service worker com um `chrome` falso e replica
sequências de eventos do socket, conferindo o estado resultante. Cada cenário é
um bug que já aconteceu de verdade — os de número 2, 3 e 4 rodam o ciclo inteiro
com **apenas uma** das fontes disponível:

1. fluxo completo, com as duas fontes chegando
2. **só eventos de chamada** — `agent.status` nunca vem
3. **só `agent.status`** — nenhum evento de chamada chega
4. **o bug relatado**: atende e desliga sem `call-was-finished`
5. `agent.status` como string (`"5"` em vez de `5`)
6. "não atendida" sobrevive ao ACW genérico e a eventos tardios
7. falhou e caixa postal, com motivo
8. ramal ocioso libera tudo
9. chamada de dialer: conectou já é falando, com mailing
10. socket manda outro `call id` → o do `/dial` vence
11. ordem invertida: ACW antes do `call-was-finished` (não remarca o fim)
12. **destino recusa** com `agent.status` atrasado → não volta para "Chamando..."
13. destino recusa e só chega `agent-is-idle`, sem ACW
14. discagem nova reabre o ciclo depois de um desfecho
15. **operador desliga pela extensão** — o socket não avisa nada
16. desligar sem chamada ativa é recusado

Cobre a **máquina de estados**, não a API: `fetch` é stub. O que ele garante é
que, dada uma sequência de eventos, o estado resultante é o certo.

## Status da chamada

O painel mostra o que está acontecendo com a ligação, alimentado
pelos eventos do socket (o REST só confirma que o comando foi aceito):

| Estado | Quando | Cor |
|---|---|---|
| `discando` | o `POST .../dial` foi aceito | azul |
| `chamando` | `call-was-connected` em modo manual — tocando do outro lado | âmbar |
| `falando` | `manual-call-was-answered`, ou `call-was-connected` no dialer | verde |
| `caixa` | marca de caixa postal no payload do fim da chamada | âmbar |
| `nao-atendida` | `call-was-not-answered` | cinza |
| `encerrada` | `call-was-finished` | cinza |
| `falhou` | `call-was-failed`, `call-dial-failed`, ou a API recusar a discagem | vermelho |

O card **fica na tela depois de desligar** de propósito: o operador precisa ler
o desfecho, não ver o card sumir sem explicação.

**Caixa postal não é um evento da 3C Plus.** Não existe nada como
`call-went-to-voicemail` no SDK. O que dá para fazer é procurar a marca dela no
payload do fim da chamada — `CAIXA_POSTAL_RE` em `service-worker.js`. A lista
cobre `voicemail`, `caixa postal`, `mailbox`, `answering machine` e
`secretária eletrônica`; se a sua operadora usa outro termo, ele aparece cru no
log de eventos e é só acrescentar na regex.

## Log de eventos

Rodapé da janela, `Eventos da 3C Plus`: os últimos 40 eventos, com hora e
motivo. Existe porque até então a extensão **falhava em silêncio** — socket que
não subia, API que recusava a discagem, nada aparecia na tela.

Todo evento que não está mapeado cai ali com o payload resumido. É de lá que
sai o próximo mapeamento.

## Microfone

**O microfone não é só o áudio: é pré-requisito para o ramal existir.**

O webphone dentro do iframe SIP precisa do microfone para registrar. Bloqueado,
ele carrega a página, não registra, e `agent-is-connected` nunca chega. A
cadeia inteira cai atrás disso:

```
microfone bloqueado
  → webphone não registra
    → agent-is-connected nunca chega
      → agent-login-failed na entrada da campanha
        → 422 "Agente não está ocioso." em toda discagem
```

Quem descobre isso é o **offscreen document**, com
`navigator.permissions.query({name:'microphone'})` — API do DOM, não da
extensão, então funciona lá mesmo sem `chrome.storage`. É a origem que o iframe
SIP herda, então é a leitura que vale.

Com o microfone bloqueado, `SELECT_CAMPAIGN` **recusa entrar** e abre a tela de
permissão. Entrar assim só produziria um agente meio logado que rejeita toda
discagem.

Sem permissão a chamada **acontece e ninguém ouve nada** — em silêncio, sem
erro em lugar nenhum. Por isso o painel mantém uma faixa âmbar no topo enquanto
`micGranted` for falso, com um botão **Liberar** que reabre a tela sem precisar
deslogar.

A tela de permissão (`src/permission/mic.js`) traduz o erro do `getUserMedia`
em vez de só imprimir a mensagem crua:

| `err.name` | Significa |
|---|---|
| `NotAllowedError` | bloqueado — ou o usuário clicou em Bloquear, ou a bolha nunca apareceu |
| `NotFoundError` | não tem microfone conectado |
| `NotReadableError` | tem microfone, mas outro app está usando |
| `OverconstrainedError` | o dispositivo não aceita a configuração pedida |

### Por que a janela do microfone é `type: 'normal'` e a do painel é `'popup'`

A bolha de permissão do Chrome **ancora embaixo da barra de endereço**. Uma
janela `popup` não tem barra de endereço — não há onde ancorar, a bolha nunca
aparece, e o `getUserMedia` acaba devolvendo `NotAllowedError` como se o
operador tivesse clicado em Bloquear.

Por isso `MIC.tipo = 'normal'` (janelinha pequena, mas com barra de endereço) e
`PANEL.tipo = 'popup'` (o painel não pede permissão nenhuma). As duas continuam
sendo janelas soltas por cima do CRM.

O botão **Tentar em uma aba** fica como último recurso.

## "Extension context invalidated"

Recarregar a extensão em `chrome://extensions` invalida o contexto de **todo
content script já injetado**. A aba do Pipedrive continua com os botões
desenhados, mas qualquer `chrome.runtime.*` dali em diante estoura — e como
`sendMessage` lança de forma **síncrona** nesse estado, um `.catch()` na promise
nem chega a rodar.

Não dá para reinjetar sozinho: só um F5 recria o content script. Então o
detector se remove — some com os botões, para o `MutationObserver` e o
`setInterval`, e avisa para atualizar a página. A checagem roda a cada
varredura, então os botões somem sozinhos, sem esperar um clique.

**Sempre dê F5 na aba do Pipedrive depois de recarregar a extensão.**

## Debug

No card da extensão em `chrome://extensions`:
- **service worker** → console do roteador/REST
- **offscreen.html** → console do SIP e do socket

O painel tem DevTools próprio (botão direito → Inspecionar).

## Ajustes comuns

**Posição do botão** — `src/content/detector.js`, `CONFIG.position`:
`'right'` (padrão) ou `'above'`.

**Falso positivo em nota/descrição** — `CONFIG.textFallback = false` deixa só
os links `tel:`. Perde número solto em texto, mas fica cirúrgico.


## Publicar na Chrome Web Store

```bash
npm run zip     # gera 3cplus-extension.zip
```

1. Registre-se no [Developer Dashboard](https://chrome.google.com/webstore/devconsole) — taxa única de US$ 5
2. Adicione ícones 16/48/128 px em `manifest.json` (obrigatório para publicar)
3. Suba o ZIP e preencha: descrição, prints, política de privacidade
4. **Justifique cada permissão** — `offscreen`, `storage`, `contextMenus` e o
   host `*.3c.plus`. Revisões travam mais por justificativa vaga do que por
   código.
5. Revisão: dias a semanas. Escopo amplo (`<all_urls>`) alonga bastante — por
   isso o `matches` está restrito a `*.pipedrive.com`.

**Alternativa para uso interno:** se a extensão é só para os operadores da
empresa, publique como **não listada** ou distribua por política do Google
Workspace (instalação forçada por domínio). Evita revisão pública.

## Limitações conhecidas

- Não cobre mudo, transferência, hold, conferência ou gravação — esses
  endpoints não existem no SDK.
- Telefone em campo de edição (`<input>`) não é detectado — o `TreeWalker` lê
  nós de texto, não o `value` de campos. Na ficha do Pipedrive em modo leitura
  o número é link `tel:`, então isso só afeta o modo de edição.
- Não grava a ligação como atividade no Pipedrive. Precisaria de um segundo
  passo chamando a API do Pipedrive (`addActivity`) depois da qualificação.
- Fechar o Chrome encerra a sessão: `chrome.storage.session` é só memória.
- Um ramal por vez. Se o operador deixar o app web da 3C Plus aberto junto,
  as duas sessões SIP se derrubam.
#   3 C P l u s - e x t e n s i o n s  
 