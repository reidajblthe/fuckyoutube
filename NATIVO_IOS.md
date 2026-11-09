# Preparação iOS / CarPlay

O arquivo capacitor.config.json é uma base de empacotamento, não uma implementação CarPlay pronta. appId é um identificador inicial: substitua-o pelo Bundle ID do seu projeto/conta.

Em um Mac com Xcode e o ambiente iOS do Capacitor configurado:

```sh
npm install @capacitor/core@8 @capacitor/ios@8
npm install --save-dev @capacitor/cli@8
npm run build
npx cap add ios
npx cap sync ios
npx cap open ios
```

O frontend compilado fica em dist/. O servidor Express e FFmpeg continuam em um backend Node; não executam dentro do WKWebView. As rotas relativas /api e /auth funcionam atualmente na origem do servidor. Para um wrapper com assets locais, a próxima etapa é adaptar a origem HTTPS do backend, CORS/CSP e o fluxo OAuth/deep links. A configuração básica não inventa um domínio nem inclui credenciais. Não foi gerado/compilado um projeto Xcode nesta máquina Windows.

Para áudio nativo de fundo e integração real ao veículo, será necessário implementar no projeto iOS:

* Capability de Background Modes / Audio e AVAudioSession com categoria playback, com política apropriada de mistura/ducking.
* Tratamento nativo de AVAudioSession.interruptionNotification, respeitando a indicação de retomada e pausas do usuário; bridge para o estado do player web ou um motor nativo de áudio.
* MPNowPlayingInfoCenter e MPRemoteCommandCenter, coordenados com a Media Session para não disparar comandos em duplicidade.
* Entitlement CarPlay Audio aprovado pela Apple, provisioning correspondente, cena CarPlay e implementação das templates do framework, incluindo o fluxo Now Playing e biblioteca.
* Testes em CarPlay Simulator e em veículo real, com chamada, GPS, reconexão Bluetooth/Wi-Fi, suspensão e tela bloqueada.

Uma PWA no Safari ou um simples WKWebView não vira um app CarPlay ao adicionar JSON. A seleção de fontes e os controles apresentados na central dependem do sistema e do veículo. GPS pode reduzir/misturar o volume sem disparar interrupção no navegador; o site não observa cada instrução ou chamada em todos os aparelhos.

Fontes oficiais:

* [Capacitor: configuração](https://capacitorjs.com/docs/config)
* [Apple: solicitar entitlements CarPlay](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)
* [Apple: framework CarPlay](https://developer.apple.com/documentation/carplay)
* [W3C: Audio Session](https://w3c.github.io/audio-session/)
