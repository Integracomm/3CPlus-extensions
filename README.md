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

## Primeiro uso

1. Painel lateral → domínio, ramal e senha
2. Uma aba de permissão de microfone abre automaticamente — **autorize**
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

## Arquitetura

| Contexto | Arquivo | Papel |
|---|---|---|
| Content script | `src/content/detector.js` | acha telefones, injeta botão |
| Service worker | `src/background/service-worker.js` | roteador + todas as chamadas REST |
| Offscreen | `src/offscreen/offscreen.js` | iframe SIP + WebSocket (persistente) |
| Side panel | `src/sidepanel/panel.js` | login, campanha, chamada, qualificação |

O offscreen document é o único contexto MV3 que fica vivo indefinidamente —
por isso o SIP e o socket moram nele. O service worker hiberna aos ~30s
ociosos, então nenhum estado vive em variável de módulo: tudo em
`chrome.storage.session`.

## Debug

No card da extensão em `chrome://extensions`:
- **service worker** → console do roteador/REST
- **offscreen.html** → console do SIP e do socket

O painel lateral tem DevTools próprio (botão direito → Inspecionar).

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
4. **Justifique cada permissão** — `offscreen`, `storage`, `sidePanel`,
   `contextMenus` e o host `*.3c.plus`. Revisões travam mais por justificativa
   vaga do que por código.
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
