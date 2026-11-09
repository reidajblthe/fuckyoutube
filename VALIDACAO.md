# F*ckyoutube — identidade 2.0

* Marca atualizada em título HTML, cabeçalhos, navegação, player, Media Session, manifesto, nome iOS/Capacitor e documentação de autenticação.
* Tema: fundo #0B0C10; superfícies #16181E; bordas #2A2D37; crimson #FF2A54; champagne #E5C158; textos #F3F4F6/#9CA3AF. Verdes dos estilos e das artes incluídas substituídos. Capas externas do catálogo preservam as cores originais dos artistas.
* Botões em gradiente, modais com backdrop blur, nova marca vetorial F* e PNGs 180/192/512 px, incluindo maskable.
* Manifesto e meta theme-color atualizados; shell offline fckyoutube-shell-v2 migra os caches antigos. Assets atuais: app-v7.js e styles-v3.css, premium.css e car-mode.css.
* Biblioteca local usa os identificadores anteriores para preservar os arquivos/playlists existentes. Nomes das sessions demonstrativas salvas são atualizados em memória para Fckyoutube Studio.
* 55 testes aprovados, análise sintática e build aprovados. Não foram escritos testes artificiais para as alterações de cor/texto.
* Navegador: Home e player conferidos, áudio demonstrativo reproduzido; nova marca verificada em texto visível. Em 390×844, body clientWidth=375 e scrollWidth=375, sem overflow horizontal. A configuração temporária de viewport foi restaurada.
* Capturas: fckyoutube-desktop-v2.png, fckyoutube-mobile-v2.png e fckyoutube-player-v2.png. São imagens de navegador, não de iPhone físico.
* A nova interface foi ativada pelo botão Atualizar app no localhost.

---

# Revisão 1.6.1 com Ruflo

55 testes aprovados, sintaxe e build aprovados; npm audit do app sem alertas conhecidos. Áudio integral e trecho do clipe oficial validados em HTTP 206 no localhost. Correções e limites detalhados em REVISAO_RUFLO.md; relatórios brutos em review/.

---

# Validação — versão 1.6 — 9 de novembro de 2026

* 52 testes automatizados aprovados; nove novos cobrem interrupção/retomada, pausa/stop, troca de faixa, estado inactive, play adiado, autoplay bloqueado, ausência de API, oito ações Media Session e as cinco resoluções de artwork com fallback.
* Sintaxe e build aprovados; módulos car-mode.css, audio-focus.js e media-controls.js incluídos no shell offline reidajbl-shell-v12.
* Testes de foco e comandos de volante são simulações controladas, não uma execução em CarPlay/Bluetooth real.
* Navegador desktop: Modo Carro abriu o player ampliado, reproduziu as faixas locais, avançou para Golden hour, prosseguiu na fila e permitiu sair/voltar ao modo. A preferência persistiu após reload.
* Viewport 800×480: controles anterior/próxima de 72×72 px e play de 100×100 px; área do diálogo clientHeight=454/scrollHeight=454, sem overflow horizontal.
* Viewport 390×844: anterior/próxima de 58×58 px e play de 82×82 px; clientWidth/scrollWidth=375 e clientHeight/scrollHeight=844, sem overflow. São dimensões simuladas em navegador, não iPhone físico.
* Captura do Modo Carro: preview-car-mode-v16.png. A resolução temporária do navegador foi restaurada.
* Configuração básica capacitor.config.json incluída, webDir=dist. Nenhum app Xcode/CarPlay foi compilado ou assinado. Consulte NATIVO_IOS.md.

---

# Validação — versão 1.5 — 9 de novembro de 2026

* 43 testes automatizados aprovados; quatro novos cobrem escolha de clipe, rejeição de áudio/letras/canal ou versão divergentes, query/cache/deduplicação e fallback HTTP 200 da rota.
* Navegador: Never Gonna Give You Up começou no ID de áudio lYBUbBu4W08. Ao selecionar Vídeo, buscou e carregou dQw4w9WgXcQ, do canal Rick Astley, com cenas do clipe oficial em movimento (640×360), paused=false e error=null.
* Áudio em 8,72 s antes da troca; vídeo retomou desse ponto e foi observado avançando em 21,96 s. O preparo/consulta pausa a progressão durante a troca.
* Retorno ao áudio: vídeo em 34,09 s; áudio original lYBUbBu4W08 observado em 34,56 s, tocando e sem erro.
* Sing, Sing, Sing / Benny Goodman: busca retornou available:false. O player restaurou áudio/capa e continuou reproduzindo. Não afirmou que um vídeo de capa era clipe oficial.
* Captura do clipe real: preview-official-video-v15.png. Captura do aviso no próprio player: preview-video-fallback-v15.png.
* Verificação final após reinício do servidor: endpoint de busca HTTP 200 retornou dQw4w9WgXcQ para Rick Astley; stream do clipe HTTP 206 com bytes 0-1023/11903240 e 1024 bytes no corpo. Benny Goodman retornou HTTP 200 available:false.
* Frontend final com cache reidajbl-shell-v9: clipe novamente observado em 14,59 s, 640×360, paused=false e error=null.
* Busca oficial é heurística conservadora por metadados, com fallback se não houver confiança. Não se promete encontrar todo clipe publicado.
* Sem teste em iPhone físico, tela bloqueada ou deploy. O teste do clipe foi de trecho, não até o fim.

---

# Validação — versão 1.4 — 9 de novembro de 2026

* 39 testes automatizados aprovados: remux real de fixtures H.264/AAC com FFmpeg, decodificação de ambas as trilhas, Range no MP4 combinado, cache/deduplicação, sincronização após metadados, troca rápida, preservação da pausa e rejeições obsoletas, além das regressões anteriores.
* Vídeo real: /api/stream?id=6VHt4hazMG0&type=video respondeu HTTP 206, video/mp4, Content-Range bytes 0-1023/6027613, corpo de 1024 bytes. Primeiro preparo levou aproximadamente 4,9 segundos nesta rede.
* Navegador: o clique em Vídeo ocultou a capa e abriu o elemento video nativo, com imagem decodificada 360×360, paused=false e error=null. A fonte desta faixa apresenta arte de álbum como imagem do próprio vídeo.
* Áudio → vídeo: áudio estava em 8,25 s antes do clique; o vídeo começou desse ponto e foi observado avançando a 14,28 s.
* Vídeo → áudio: vídeo em 23,68 s antes do clique; áudio observado em 24,15 s, reproduzindo e sem erro, com capa restaurada.
* Troca pausada: áudio pausado em 49,44 s; vídeo manteve 49,44 s e paused=true. Reproduzir retomou o vídeo, observado em 55,82 s, sem erro.
* Cache PWA atualizado pela interface; novo frontend app-v4.js e video-player-v2.js.
* Captura: preview-video-v14.png. Localhost mantido em execução.
* Não foi feito teste em iPhone físico/tela bloqueada nem deploy. Os testes do vídeo real são de trecho, não de reprodução integral até o final. A transferência de áudio integral foi validada na versão anterior, conforme o registro abaixo.

---

# Validação — versão 1.3 — 9 de novembro de 2026

Motor: @distube/ytdl-core 5.2.1, Node 22.23.4. Servidor local em http://localhost:3000. Cliente nativo selecionado: VisionOS, AAC itag 140. Nenhum cookie de conta ou token manual foi necessário.

| Verificação | Resultado |
| --- | --- |
| Sintaxe e build | Aprovados |
| Testes automatizados | 35/35 aprovados |
| Busca real músicas/artistas/álbuns | HTTP 200, 20 resultados em cada tipo |
| Primeiro intervalo AAC | HTTP 206, 1024 bytes |
| Sing, Sing, Sing (6VHt4hazMG0) | 4.899.246 bytes completos, HTTP 206, sem 403 |
| Stormy Weather (9jDpI5-NzXI) | 3.040.064 bytes completos, HTTP 206, sem 403 |
| Últimos 2048 bytes | HTTP 206; corpo idêntico ao final de cada resposta integral |
| Intervalo fora do arquivo | HTTP 416 e Content-Range bytes */tamanho |
| HEAD sem Range | HTTP 200 e Content-Length integral |
| Navegador, áudio remoto | Avançou continuamente de 0:00 até 3:11; paused=false, readyState=4, error=null |
| Regressão de vídeo | MPD HTTP 200; primeiro Range H.264 HTTP 206, 1024 bytes |
| iPhone físico / Safari bloqueado | Não testado |
| Deploy nas plataformas | Não realizado |
| Cookies autenticados e geração de PO Token | Suporte implementado pela biblioteca; não exigidos no teste aprovado |

As duas faixas foram consumidas integralmente em memória, sem salvar áudio comercial no pacote. O teste do navegador acompanhou 191 segundos dos 302,58 segundos da primeira faixa; não se afirma que ela tenha sido ouvida até o fim no navegador. O hash da transferência integral confirma os bytes recebidos, não a validação de decodificação de todos os frames.

SHA-256 da resposta integral de 6VHt4hazMG0:
52317b63c35c923d1b52ad4ed8754e6314de5c12875f50e0d91ee656c15a0195

SHA-256 da resposta integral de 9jDpI5-NzXI:
f116350adea5636dd60b7ada6643c967820f239299e607594e851d0838dfaa67

O teste final após reiniciar a versão atual terminou em 2026-11-09T12:01:29Z. Captura do player: preview-stream-v13.png.

O proxy usa Media.read e pipeline com backpressure e cancelamento, preserva AAC sem vídeo e atende Range aberto, fechado e suffix. A biblioteca gerencia versões/cabeçalhos de cliente, VisitorData, assinatura, geração de PO tokens quando necessária e retomada após expiração/403. A retomada após um 403 não foi acionada no teste real, pois não houve recusa.

Os testes controlados verificam o contrato de Range da nova leitura, sessão única e configuração de cookies/clientes, além das regressões existentes de OAuth, reconexão do player, service worker, DASH, validação e falhas de transporte. O login Google real depende das credenciais OAuth do proprietário e não foi efetuado.

Resultados valem para esta execução/rede. Alterações do YouTube ou bloqueios de conta/região/IP podem exigir atualização do motor. Hospedagem e reprodução com tela bloqueada no iOS precisam de validação própria.
