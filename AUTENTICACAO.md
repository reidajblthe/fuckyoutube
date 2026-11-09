# Login Google / YouTube — F*ckyoutube

O fluxo OAuth está implementado, mas precisa das credenciais **do seu próprio projeto Google Cloud**. Elas não podem ser criadas ou substituídas por valores genéricos. Não envie Client Secret, cookies ou tokens pelo chat.

## Configuração no Google Cloud

1. No Google Cloud Console, crie/selecione um projeto e ative **YouTube Data API v3**.
2. Em Google Auth Platform, configure a marca e a audiência do aplicativo. Para testar com audiência External, cadastre a sua conta como usuário de teste.
3. Em Data Access, adicione `openid`, `profile` e `https://www.googleapis.com/auth/youtube.readonly`.
4. Crie um OAuth Client do tipo **Web application**.
5. Para desenvolvimento, registre exatamente:
   - Origem: `http://localhost:3000`
   - Redirect URI: `http://localhost:3000/auth/google/callback`
6. Copie o Client ID e o Client Secret para o arquivo `.env` local, não para arquivos em `public/`.

Dentro da pasta do projeto:

```powershell
Copy-Item .env.example .env
notepad .env
```

Preencha/descomente:

```dotenv
PORT=3000
PUBLIC_ORIGIN=http://localhost:3000
GOOGLE_CLIENT_ID=seu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=seu-client-secret
SESSION_SECRET=um-segredo-aleatorio-exclusivo-com-32-caracteres-ou-mais
YOUTUBE_PLAYER_CLIENT=IOS
```

Gere um segredo aleatório local para SESSION_SECRET; não reutilize senha pessoal. Reinicie o servidor com leitura do `.env`:

```sh
node --env-file=.env server.js
```

Ou, neste computador:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\iniciar.ps1
```

Abra **http://localhost:3000**, entre no perfil e clique **Entrar com a Conta Google**. Não troque `localhost` por `127.0.0.1` durante esse fluxo: a origem e o callback precisam ser os registrados no Google.

## Produção

Use `PUBLIC_ORIGIN=https://seu-dominio`, adicione `https://seu-dominio/auth/google/callback` ao cliente OAuth e configure os mesmos segredos no ambiente da hospedagem. SESSION_SECRET com pelo menos 32 caracteres é obrigatório para ativar OAuth em produção. Todas as réplicas precisam usar o mesmo segredo. Não envie `.env` ao Git ou ao ZIP público.

Com Cloudflare Pages à frente do backend, PUBLIC_ORIGIN deve ser a URL **da PWA Pages**, não a origem interna do Render. As Functions incluídas encaminham cookies e as rotas `/auth/*`. O código de logout verifica Origin para evitar solicitações de outros sites.

## Dados disponíveis e limites

| Recurso | Implementação |
| --- | --- |
| Nome e foto | OpenID Connect userinfo, após autorização |
| Playlists criadas pelo usuário | YouTube Data API `playlists.list(mine=true)` |
| Faixas/vídeos com Gostei | `videos.list(myRating=like)` |
| Canais inscritos | `subscriptions.list(mine=true)` |
| Faixas de uma playlist própria | `playlistItems.list` |
| Playlists de terceiros salvas na biblioteca | A API oficial não fornece uma listagem completa equivalente à interface YouTube Music |
| Histórico global do YouTube | Não acessível pela API oficial |
| Histórico do F*ckyoutube | Continua salvo localmente e aparece no início |

Gostei no YouTube pode conter vídeos que não são músicas. Inscrições são canais, não necessariamente artistas musicais; a interface oferece um link para o canal correspondente. Paginação está implementada com “Carregar mais”. Não há alteração de playlists, likes ou inscrições na conta: o escopo é de leitura.

Login OAuth oficial **não transforma o token em cookies InnerTube WEB_REMIX** e não garante que o CDN autorize streams. Autenticação de biblioteca e reprodução são integrações separadas. O proxy ainda pode receber 403 por políticas de mídia, sessão, atestação ou disponibilidade do conteúdo.

## Armazenamento e logout

O servidor troca o authorization code usando PKCE, valida `state` e consulta o perfil via HTTPS. Tokens não são retornados pela API de perfil, nem gravados em localStorage/sessionStorage. A sessão é cifrada com AES-256-GCM em cookie HttpOnly, SameSite=Lax e Secure em HTTPS. O cookie contém o estado cifrado; JavaScript do app não consegue lê-lo. A duração máxima local da sessão é de sete dias, sujeita à validade/revogação pelo Google.

Quando o access token expira, o backend tenta renová-lo com refresh token. O botão Sair limpa os cookies, remove o perfil da interface e tenta revogar a credencial da sessão. As playlists/arquivos locais do usuário permanecem. Não há endpoint para receber cookies de contas ou senhas.

## Rotas

```text
GET  /auth/google
GET  /auth/google/callback
GET  /api/account
GET  /api/account/library?section=playlists|likes|subscriptions|history
GET  /api/account/playlist/ID
POST /api/auth/logout
```

Os testes automatizados cobrem autorização simulada, PKCE/state, cookie cifrado, refresh, perfil, biblioteca, rejeição de acesso anônimo e logout com proteção de origem. Não foi realizado login real, pois Client ID/Client Secret não foram fornecidos. Escopos sensíveis podem exigir verificação do aplicativo Google para distribuição pública; no modo de teste, use os usuários de teste configurados.

Referências oficiais:

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/youtube/data/reference/rest/v3/playlists/list
- https://developers.google.com/youtube/data/reference/rest/v3/videos/list
- https://developers.google.com/youtube/data/reference/rest/v3/subscriptions/list
- https://developers.google.com/youtube/data/revision_history (restrições de histórico)
- https://ytjs.dev/guide/authentication (limites entre OAuth TV e cookies de clientes web)
