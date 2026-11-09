# F*ckyoutube

PWA de música com interface escura e dourada, coroa própria, player HTML5 e backend InnerTube. Sem SDKs de anúncios, banners ou analytics na aplicação. Frontend em HTML/CSS/JavaScript puro e servidor Express com YouTube.js 18.3.0. A versão atual mantém login Google e biblioteca pessoal via API oficial e usa MP4 nativo para vídeo. Consulte [AUTENTICACAO.md](AUTENTICACAO.md) para configurar o OAuth.

**Versão 2.0 — nova identidade:** F*ckyoutube, fundo grafite #0B0C10, superfícies #16181E, crimson #FF2A54 e detalhes champagne #E5C158. Ícones, manifesto, meta tags e cache do PWA atualizados.

**Revisão técnica 1.6.1:** Ruflo 3.74.1 executado em cópia dos fontes, auditoria de dependências e revisão manual. Corrigidos timeout e liberação de conexões pendentes no proxy, reserva de vagas do cache de vídeo e nomes únicos dos arquivos temporários. Consulte REVISAO_RUFLO.md para evidências e limites.

**Versão 1.6:** controles Media Session completos, capas PNG reais em cinco tamanhos, tratamento de interrupções via Audio Session quando suportada e Modo Carro com botões maiores e apenas áudio. A configuração básica do Capacitor está incluída; integração nativa CarPlay é uma etapa futura, descrita em [NATIVO_IOS.md](NATIVO_IOS.md).

**Busca de clipe (1.5):** ao mudar para Vídeo, busca música + artista + Official Video, seleciona um ID de clipe correspondente e carrega o MP4 desse ID. Sem correspondência confiável, volta ao áudio/capa com aviso discreto dentro do player. A posição numérica é preservada nas duas direções; introduções/edições diferentes podem ter alinhamento musical diferente.

**Transporte de vídeo (1.4):** alternância de vídeo corrigida. O frontend usa um MP4 combinado H.264/AAC em /api/stream?id=VIDEO_ID&type=video, com seek sincronizado nos dois sentidos e preservação de pausa/volume. Não depende de Shaka/MediaSource para vídeo. O backend combina as trilhas com FFmpeg, sem recodificar. Primeira abertura prepara o arquivo; as seguintes usam cache temporário.

**Motor de áudio (1.3):** extração e transporte de mídia com @distube/ytdl-core 5.2.1. Cliente nativo VisionOS priorizado pelo padrão da biblioteca; fallback entre os clientes atualmente suportados, geração automática de PO tokens quando necessária e retomada após expiração/403. O teste integral no localhost passou: 4.899.246 bytes AAC/MP4, HTTP 206, sem 403. Consulte [VALIDACAO.md](VALIDACAO.md).

## Executar

Instale **Node.js 22.22.2+ da série 22, 24.15+ da série 24 ou 26+** e execute dentro da pasta do projeto:

```sh
npm ci
npm start
```

Abra **http://localhost:3000**. Para desenvolvimento com reinício do backend:

```sh
npm run dev
```

Neste computador também há um Node portátil na área de trabalho do Codex. O atalho abaixo o encontra sem alterar o PATH global:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\iniciar.ps1
```

Se a porta estiver ocupada: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\iniciar.ps1 -Port 3001`.

## Estrutura

```text
F*ckyoutube/
├── server.js                   # Express, InnerTube, metadados, proxy AAC e Range
├── combined-video.js           # FFmpeg e cache temporário de MP4 combinado
├── media.js                    # Extração e transporte com ytdl-core 5.2.1
├── auth.js                     # OAuth Google, cookie cifrado e API pessoal
├── package.json
├── package-lock.json           # Dependências fixadas
├── iniciar.ps1
├── public/
│   ├── index.html              # Interface e meta tags iOS
│   ├── styles.css
│   ├── tokens.css
│   ├── app.js                  # Player, Media Session, fila, playlists e IndexedDB
│   ├── account.js              # Perfil, biblioteca Google e logout
│   ├── video-player.js         # MP4 nativo e seek após loadedmetadata
│   ├── vendor/                 # Shaka Player e licença Apache-2.0
│   ├── manifest.json
│   ├── service-worker.js       # Interface offline e áudio demonstrativo com Range
│   ├── icons/                  # 180, 192 e 512 px, maskable e SVG
│   ├── covers/                 # Capas SVG originais
│   └── audio/                  # Três instrumentais demonstrativos originais
├── scripts/
│   ├── assets.js               # Gera SVGs e áudio demonstrativo
│   ├── build.js                # Copia frontend para dist/
│   └── live-check.js           # Teste opcional com YouTube real
├── test/
├── api/index.js                # Adaptador Vercel
├── functions/api/[[path]].js    # Proxy HTTP para Cloudflare Pages
├── render.yaml
├── vercel.json
├── Dockerfile
└── ANALISE.md
```

## O que funciona

* Home com sessions demonstrativas e seleções reais do YouTube Music quando disponíveis.
* Busca de músicas, artistas e álbuns. Abertura de álbuns e seções de artistas.
* Proxy AAC/M4A pelo mesmo domínio do frontend, sem CORS no navegador. Disponibilidade integral depende da sessão aceita pelo YouTube, conforme os limites abaixo.
* Um único elemento de áudio persistente entre as telas; play, pause, anterior, próxima, progresso, fila, aleatório e repetição de faixa.
* Media Session com título, artista, álbum, capa, posição e handlers de tela bloqueada/fones.
* Toggle “Apenas Áudio / Vídeo”: vídeo nativo MP4 H.264/AAC, áudio nativo AAC. Ao trocar, a faixa continua da posição anterior; o estado pausado e o volume são preservados. A capa só aparece no modo de áudio. Não depende de suporte DASH no navegador.
* Perfil Google, nome/foto, playlists próprias, Gostei, inscrições e logout quando o OAuth estiver configurado. Tokens ficam em cookie cifrado HttpOnly, não em localStorage.
* Curtidas, histórico e playlists em localStorage; arquivos importados em IndexedDB, sem upload ao backend.
* Exportação das playlists em JSON. Arquivos de áudio não são incluídos nesse JSON. Importação de JSON de playlists não foi implementada.
* Interface e três sessions incluídas em cache; suporte a seek offline nessas sessions. Áudio externo não é baixado nem cacheado automaticamente.
* Instalação PWA com manifesto e ícone próprio. Orientação portrait é uma preferência do manifesto; o iOS pode ignorá-la.

Arquivos locais usam o nome do arquivo como título e “Seu arquivo local” como artista. Leitura de tags ID3/capas embutidas não foi implementada. O suporte aos formatos locais é o suporte do navegador, sem transcodificação.

## iPhone e tela bloqueada

1. Publique em **HTTPS**, ou use um ambiente HTTPS de desenvolvimento confiável. `localhost` no PC não é o endereço do PC visto pelo iPhone.
2. No Safari do iPhone, abra o endereço HTTPS, toque em **Compartilhar → Adicionar à Tela de Início**.
3. Abra a PWA e toque em uma faixa para autorizar o primeiro áudio.
4. Bloqueie a tela e verifique os controles do sistema. Repita o teste com várias faixas na fila.

O código usa `<audio playsinline>`, Media Session e `navigator.audioSession.type = 'playback'` quando disponível. Não usa áudio silencioso, timers para manter a página acordada ou truques de bateria. A Media Session envia metadados e controles; **não concede uma permissão irrestrita de execução em segundo plano**. O Safari/iOS pode interromper áudio por falta de memória, mudança de saída, ligações, políticas de energia ou suspensão. A transição automática para a próxima faixa também precisa de teste na versão específica do iOS. Não é possível garantir reprodução ininterrupta apenas com JavaScript.

O volume no iOS fica a cargo dos botões do iPhone; a interface esconde o slider nesse sistema. Em outros navegadores, o slider ajusta o elemento de áudio. Arquivos IndexedDB e cache pertencem à origem e podem ser removidos pelo sistema ou ao limpar os dados do site. Preserve seus arquivos originais.

## API e arquitetura

| Rota | Função |
| --- | --- |
| `GET /api/health` | Saúde do processo, sem contatar YouTube |
| `GET /api/home` | Feed público do YouTube Music |
| `GET /api/search?q=jazz&type=songs` | Busca; tipos: songs, artists, albums |
| `GET /api/collection/ID?type=album` | Faixas de um álbum; aceita também artist |
| `GET /api/stream/VIDEO_ID` | Resolve áudio AAC e encaminha bytes/Range |

O frontend consulta somente /api. YouTube.js 18.3.0 continua responsável pelas buscas e metadados. O novo módulo media.js usa @distube/ytdl-core 5.2.1 para extração, decipher e entrega da mídia, com uma única sessão por processo. VisitorData, versões, User-Agent, Origin e x-youtube-client-name/version são mantidos pela biblioteca, sem substituir o agente nativo por um Chrome fixo.

O padrão da biblioteca começa com VisionOS e inclui WebEmbedded, TVHTML5, MWEB, WebCreator e WebMusic. Não se inventam clientes ANDROID_MUSIC/IOS ausentes dessa versão. PO tokens são gerados automaticamente por worker local quando o cliente exige atestação; o teste aprovado usou VisionOS sem cookies. Tokens estáticos de outra sessão não são injetados no motor de mídia.

No modo áudio, o proxy abre Media.read e usa pipeline para entregar o Readable diretamente, sem HTTP 302, URL assinada pública ou arquivo completo em memória. Seleciona AAC/MP4 estritamente sem vídeo para áudio e H.264 para vídeo. Normaliza Range aberto/fechado/suffix para os bytes inclusivos da biblioteca. Content-Length e Content-Range são calculados a partir do tamanho do formato selecionado: 206 para Range, 200 sem Range, 416 para intervalo impossível. A biblioteca faz seus próprios pedidos em blocos e retoma o mesmo formato após expiração/403; uma resposta do navegador permanece contínua. Backpressure e cancelamento por desconexão são preservados. Descritores de mídia ficam em cache por 90 segundos; Media atualiza sua resolução ao retomar. O servidor não aceita URLs fornecidas pelo usuário. /api/dash/VIDEO_ID gera o MPD do vídeo usando o mesmo transporte.

O frontend de áudio usa `/api/stream?id=VIDEO_ID&mode=audio`. Em falha, `audio-retry.js` agenda uma única reconexão após 700 ms, recupera a posição em loadedmetadata e só então exibe falha definitiva se necessário. Não renova o orçamento a cada evento playing. Pausar, trocar de faixa/modo ou iniciar uma reprodução nova cancela a tentativa anterior; vídeos e arquivos locais não entram nesse retry de áudio remoto.

InnerTube não é uma API pública estável com SLA. Respostas podem exigir login, atestação, cookies ou ser bloqueadas por região/IP de datacenter. O projeto não fornece cookies de contas nem mecanismos para contornar essas exigências. Nessas situações exibe um erro e preserva a biblioteca local. Não há download do catálogo, rádio infinito ou reprodução de conteúdo com DRM. O login Google consulta a biblioteca pela API oficial; não autentica automaticamente o cliente InnerTube de mídia. Seleções online não são recomendações personalizadas.

### Sessão opcional

O teste local passou anonimamente. Se um conteúdo exigir sua conta, configure no servidor YOUTUBE_COOKIE_FILE (arquivo Netscape ou texto de Cookie header) **ou** YOUTUBE_COOKIE. Nunca configure ambos, publique esses dados ou coloque-os no frontend. A biblioteca valida os cookies; cookies expirados precisam ser substituídos e o processo reiniciado. O login OAuth do perfil não fornece cookies para o motor de mídia.

YOUTUBE_CLIENTS pode restringir os clientes suportados: visionos, web_embedded, tv, mweb, web_creator, web_music. O padrão da biblioteca é recomendado; web_creator requer conta. PO tokens e VisitorData são gerenciados automaticamente na mesma identidade de rede. YOUTUBE_PLAYER_CLIENT, YOUTUBE_PO_TOKEN e YOUTUBE_VISITOR_DATA das versões anteriores não configuram este motor de mídia; remova valores antigos do ambiente. Estes dois últimos permanecem opcionais apenas para o serviço de metadados YouTube.js.

Referência do motor: [clientes](https://distube.js.org/ytdl-core/guides/clients/), [PO tokens](https://distube.js.org/ytdl-core/guides/po-tokens/), [cookies](https://distube.js.org/ytdl-core/guides/cookies/) e [downloads/retomada](https://distube.js.org/ytdl-core/guides/download/). Um teste aprovado nesta rede não garante disponibilidade futura, de toda faixa ou de IPs de datacenter.

Para usar arquivo de ambiente local, copie `.env.example` para `.env`, preencha somente o que for necessário e execute `node --env-file=.env server.js` ou `iniciar.ps1`. `npm start` usa as variáveis do ambiente do processo; não lê `.env` automaticamente. Nunca publique `.env` no Git. Em Render/Vercel, use os campos de variáveis de ambiente da plataforma.

## Build e testes

```sh
npm run check
npm test
npm run build
```

`dist/` contém o frontend estático. O backend usa `server.js`, `media.js`, `combined-video.js`, `official-video.js` e `auth.js`; copiar só o `dist` para hospedagem estática não cria `/api` nem `/auth`. `postinstall` copia Shaka Player e sua licença para `public/vendor`. O build gera `app-v7.js` e `styles-v3.css` a partir dos arquivos fonte para migrar instalações com cache antigo. Não há compilação React/Tailwind nem CDN: CSS e player DASH estão incluídos no projeto e funcionam sem dependências de CDN.

Teste opcional do provedor com o servidor ligado:

```sh
node scripts/live-check.js
node scripts/live-check.js --full
```

O primeiro comando testa buscas e um intervalo de 1024 bytes; `--full` também tenta consumir a faixa inteira e retorna erro se a conexão for recusada/interrompida. Depende da rede e da disponibilidade atual do YouTube. Os testes automatizados usam respostas controladas para verificar validação, cache, metadados e encaminhamento de bytes sem depender de músicas específicas.

## Deploy: Render — opção mais direta

1. Suba **o conteúdo desta pasta** em um repositório Git seu, sem `node_modules/`.
2. No Render, escolha **New → Blueprint** e conecte o repositório para usar `render.yaml`. Alternativamente crie um **Web Service / Node**.
3. Build: `npm ci && npm run build`. Start: `npm start`. Health check: `/api/health`.
4. Escolha o plano Free quando disponível. O serviço expõe o frontend e a API no mesmo endereço HTTPS.

Render injeta `PORT`; o servidor escuta `0.0.0.0`. `TRUST_PROXY=1` é usado apenas atrás do proxy da plataforma. Localmente não é necessário. Plano gratuito pode dormir por inatividade, ter partida lenta e cotas de banda. Como o áudio atravessa o servidor, streaming consome tráfego de saída. Não se promete gratuidade ilimitada. Referência: https://render.com/docs/free.

## Deploy: Vercel

O adaptador `api/index.js` e o `vercel.json` encaminham `/api/*` ao Express. Importe o repositório como projeto **Other**, use Node.js 22 e mantenha o build `npm run build` e diretório público `public` declarados na configuração.

Também é possível usar a CLI oficial instalada separadamente:

```sh
npm install -g vercel
vercel
vercel --prod
```

A função está configurada com `maxDuration: 60`. Duração máxima, limites de payload/stream e tráfego dependem do plano. Sessões/cache são efêmeros entre invocações. Uma faixa longa, uma conexão lenta ou bloqueio do IP pode falhar. Para áudio contínuo, prefira o backend Node persistente no Render ou outro host. A configuração foi preparada, mas não foi publicada nem verificada na conta Vercel. Referência: https://vercel.com/docs/functions/limitations.

## Deploy: Cloudflare Pages + backend Node

Cloudflare Pages hospeda o frontend. **Não executa este `server.js` Express diretamente.** O arquivo `functions/api/[[path]].js` é um proxy HTTP para um backend Node já publicado:

1. Publique o backend no Render e copie a origem, por exemplo `https://seu-backend.onrender.com`.
2. Crie um projeto Pages por integração Git. Build: `npm ci && npm run build`. Output: `dist`.
3. Configure **BACKEND_ORIGIN** com a origem HTTPS do backend, sem caminho ou credenciais, tanto em produção como em preview.
4. Publique. As rotas `/api/*` são atendidas pela Pages Function e encaminhadas ao Node; o frontend continua no mesmo domínio e não requer CORS aberto.

Use integração Git ou Wrangler com suporte a Functions, não apenas upload dos arquivos estáticos. Não publique somente `public/` esperando busca/stream sem um backend. A Pages Function também tem cotas e seu tráfego de áudio passa pelas duas plataformas. Referência: https://developers.cloudflare.com/pages/functions/.

## Docker

```sh
docker build -t reidajbl-tube .
docker run --rm -p 3000:3000 reidajbl-tube
```

## Validação realizada

* Testes automatizados e build: consulte VALIDACAO.md.
* Integração real no localhost: buscas com 20 músicas/artistas/álbuns; primeiro Range com 1024 bytes; faixa completa AAC de 4.899.246 bytes entregue em uma resposta HTTP 206 sem 403.
* O teste consome bytes sem gravar áudio comercial no pacote.
* Interface, biblioteca local, fila, OAuth simulado e service worker preservados.
* Não houve teste em iPhone físico, Safari iOS com tela bloqueada ou publicação nas plataformas.

## Atualizações

Os assets de marca e as três sessions foram criados para este projeto. `node scripts/assets.js` regenera os SVGs e WAVs; os PNGs já estão incluídos. Para atualizar o cache do app em produção, altere `CACHE` no service worker (ex.: `reidajbl-shell-v4`) e publique. A versão nova aguarda fechamento das abas antigas ou o clique em “Atualizar app”.

Para atualizar YouTube.js, consulte o projeto oficial, atualize a dependência e o lockfile e rode os testes/live-check novamente: https://ytjs.dev/guide/getting-started. Uma versão fixada ajuda na reprodução, mas não impede alterações do serviço remoto.

O projeto foi entregue como fonte local para execução e deploy pelo usuário. Não foi criado um site hospedado nesta tarefa. O localhost é mantido em execução para teste da versão 1.6. O botão “Atualizar app”, quando exibido, ativa a nova versão do service worker e recarrega a página, pausando a reprodução por escolha do usuário.

## Vídeo combinado — versão 1.4

GET /api/stream?id=VIDEO_ID&type=video devolve video/mp4 com imagem H.264 e áudio AAC no mesmo arquivo, sem redirect e com Range 206/416 e HEAD. Não se rotula uma trilha muda como vídeo combinado: quando o provedor entrega áudio e vídeo separados, FFmpeg recebe ambos por pipes e faz remux com -c copy -movflags +faststart. O modo de áudio mantém o transporte da versão anterior. A rota legada mode=video continua representando a trilha de vídeo isolada do MPD; use type=video para o player nativo com som.

A primeira abertura pode levar alguns segundos: o servidor precisa preparar um MP4 seekable antes de responder ao Range. O cache usa a pasta temporária do sistema, expira após dez minutos e não é exposto como arquivo público. Limites: até quatro arquivos prontos, dois preparos simultâneos, 256 MiB por vídeo e 120 segundos por remux. Vídeos que excedam esses limites recebem erro; o modo só-áudio continua disponível. O cache é operacional no servidor, não é um download offline no dispositivo. Nenhum vídeo do YouTube está no ZIP do projeto.

ffmpeg-static 5.3.0 instala o executável correspondente ao sistema durante npm ci; o build precisa permitir o download dessa dependência. Prefira servidor Node persistente com disco temporário gravável (ou Docker). Cloudflare Pages continua exigindo backend Node; Workers não executam esse binário. O deploy e os limites de funções Vercel precisam de validação própria. O binário FFmpeg tem sua licença própria, documentada na dependência.

O frontend carrega app-v7.js e video-player-v3.js; cache PWA reidajbl-shell-v12. Se a versão antiga estiver aberta, clique em Atualizar app ou feche e reabra as abas. Os controles Media Session passam a usar o elemento ativo e voltam ao audio nativo na troca. Não foi feito teste em Safari/iPhone físico.

## Busca de clipe oficial — versão 1.5

GET /api/official-video?id=ID_DA_FAIXA&title=MUSICA&artist=ARTISTA&duration=SEGUNDOS consulta vídeos públicos com @distube/ytdl-core. A consulta usa título + artista + Official Video. O módulo official-video.js exige indicação explícita de vídeo oficial, título/artista correspondentes, canal verificado e duração compatível. Exclui capas/lyrics/karaokê/visualizers, Official Audio e canais Topic. A escolha é conservadora e baseada nos metadados da plataforma, não uma prova independente de autenticidade. Pode deixar de selecionar um clipe legítimo com metadados insuficientes; nesse caso mantém áudio/capa.

Resposta positiva: available:true e video.id/title/artist/duration. Negativa: available:false e o aviso Vídeo oficial indisponível para esta faixa. Resultados positivos ficam em cache por uma hora; negativos por cinco minutos. No máximo quatro buscas simultâneas. Erro de rede exibe mensagem distinta e retoma áudio.

O ID original da música não é substituído em playlists/histórico/fila. Apenas o player de vídeo usa o ID encontrado, via /api/stream?type=video. Voltar ao áudio carrega novamente o ID original. Buscas pendentes são canceladas/ignoradas ao trocar de faixa ou retornar ao áudio; o vídeo anterior é parado antes da busca. A posição fica congelada durante consulta e preparo. O play após a consulta respeita a intenção atual de pausa. O aviso fica dentro do dialog para não ser ocultado pela camada modal.

Sincronização é por segundos, não por reconhecimento de música: um clipe com introdução extra ou outra edição pode não coincidir musicalmente com a gravação de álbum. A versão não identifica offsets por waveform e não promete alinhamento de versões diferentes.

## Central multimídia / Modo Carro — 1.6

Media Session registra play, pause, stop, previoustrack, nexttrack, seekbackward, seekforward e seekto individualmente. Ações não suportadas não impedem as demais. Seek padrão de dez segundos, com limites de zero/duração; seekto respeita fastSeek quando disponível. Stop pausa, cancela retomadas e volta ao início, mantendo a fila. O elemento ativo e a posição são atualizados junto à interface.

As capas são recortadas/redimensionadas em Canvas para PNGs quadrados reais de 96, 128, 192, 256 e 512 px. Não se declara um tamanho fictício para a mesma imagem. O metadado inicial é publicado imediatamente, e as variantes substituem a capa apenas se ainda forem da faixa atual. Se o servidor da capa impedir Canvas por CORS, usa a marca local nas cinco resoluções. A biblioteca offline mantém os assets desses módulos em cache; APIs e streams remotos continuam fora do cache.

Audio Session é experimental e não existe em todos os navegadores. Quando suportada, type=playback e statechange acompanham interrupted/active. Na interrupção, conserva posição/volume/intenção e pausa o elemento sem recarregá-lo. Ao voltar a active, tenta retomar uma vez somente a faixa/modo ainda válidos, se o usuário não pausou/parou. Não duplica play já feito pelo sistema. inactive não comprova fim de uma ligação: não provoca retomada automática; um Play explícito pode pedir foco novamente. Bloqueio de autoplay mostra pedido para tocar em Reproduzir. Sem API, usa o comportamento nativo e os comandos Media Session, sem inferir chamadas por blur/visibilitychange e sem loops que disputem foco. O SO pode pausar ou fazer ducking antes do JavaScript; não se promete fade controlado ou detecção de toda instrução do GPS.

Modo Carro é ativado pelo botão no topo ou no player. Lembra a preferência, abre o player ampliado, usa só áudio, esconde vídeo e amplia texto/áreas de toque. O botão Sair do Modo Carro continua dentro do player. A interface não representa uma template CarPlay nativa. Capacitor/configuração iOS: NATIVO_IOS.md. Teste físico com iPhone, Bluetooth/central e chamada/GPS continua necessário.
