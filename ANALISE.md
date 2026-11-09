# Evidências do APK e decisões de portabilidade

Arquivo encontrado no Desktop: `YMusic-4.0.17-android-arm64.apk`.

SHA-256 do original: `8d268610380c575d825cbacb54d3be09aed22057f851c92989065cf798391f48`.

O APK original foi preservado. A tentativa anterior de modificação Android foi cancelada pelo usuário. A análise desta PWA usa a cópia de trabalho, o manifesto já extraído e o asset JavaScript lido diretamente do ZIP.

## Observações

* Package: `io.ymusic.android`; application: `io.ymusic.android.YMusicApplication`; activity principal: `io.ymusic.android.MainActivity`.
* Recursos de Compose em `assets/composeResources/io.ymusic.ui.resources/`, com traduções `.cvr` e desenhos XML. A interface Android não é HTML reaproveitável.
* Motor JavaScript: `assets/engine_ymusic.js`, 105127 bytes.
* Encontradas referências a `https://music.youtube.com/youtubei/v1/`, cliente `WEB_REMIX`, cabeçalhos de versão/cliente, e rotas como `search`, `browse` e `music/get_search_suggestions`.
* Handlers locais registrados como `yt/search`, `yt/next`, `yt/home`, `ytmusic/search`, `ytmusic/browse`, `ytmusic/suggest` e `get_player_config`.
* Esse asset depende de uma ponte nativa com símbolos como `__hostOpen`, `__hostData`, `__pbNew`, operações de cache/cookies e interface `ymix`. Não é um módulo que possa ser importado diretamente no Safari.
* Bibliotecas nativas arm64-v8a incluem FFmpeg, QuickJS e componentes Android de mídia. Elas não são executáveis em uma PWA iOS.

## Implementação entregue

Foi criada uma implementação web própria. YouTube.js substitui a ponte nativa na comunicação InnerTube, com sessão anônima, parsers de resultado e resolução do stream AAC. O player Android/FFmpeg foi substituído por HTMLAudioElement e Media Session. Persistência Android foi substituída por localStorage/IndexedDB.

Não se afirma conversão automática ou port integral do aplicativo Android. Não foram copiados motor minificado, logotipo, traduções ou bibliotecas nativas para o pacote web. As capas, ícones e instrumentais incluídos são novos. Capa e metadados retornados pelo serviço remoto pertencem às respectivas fontes.

Os testes reais de busca/intervalo inicial de áudio demonstram essas integrações no momento do desenvolvimento. O teste de faixa completa foi recusado pelo CDN com HTTP 403 após o primeiro bloco; portanto não se afirma reprodução integral validada. Recursos nativos como serviço Android em primeiro plano, integração com Android Auto e políticas de energia não têm equivalência direta no navegador iOS.
