# Contexto do Projeto Fluvius Local

Este repositório mantém a stack local e de produção do Fluvius, uma distribuição customizada do Chatwoot voltada para atendimento via WhatsApp, CRM comercial, chat interno entre agentes e operação de revenda via Manager.

## Objetivo

O projeto empacota e integra:

- Chatwoot customizado com marca Fluvius, rotas adicionais e initializers próprios.
- Evolution API para conexão com WhatsApp.
- Postgres com pgvector para os bancos do Chatwoot e da Evolution.
- Redis para filas/cache.
- Mailpit no ambiente local para e-mails de convite/verificação.
- `internal-chat`, serviço Node.js/Express que adiciona chat interno, CRM operacional, Manager, onboarding de WhatsApp, automações e integrações.
- Caddy em produção para expor os domínios públicos.

## Estrutura Principal

- `docker-compose.yml`: stack local.
- `docker-compose.prod.yml`: stack de produção, com portas presas em `127.0.0.1` para proxy reverso.
- `.env`: variáveis locais e segredos. Não deve ser commitado.
- `.env.production.example`: referência das variáveis esperadas em produção.
- `README.md`: guia de uso local e fluxos operacionais principais.
- `docs/pos-login-producao.md`: checklist depois do primeiro login em produção.
- `Caddyfile`: proxy para Fluvius, Evolution e chat/Manager em produção.
- `chatwoot-custom/`: imagem customizada do Chatwoot.
- `chatwoot-custom/overrides/`: arquivos que sobrescrevem partes do frontend do Chatwoot.
- `chatwoot-custom/initializers/`: initializers Rails embutidos na imagem customizada.
- `chatwoot-initializers/`: initializers montados por volume no compose local.
- `internal-chat/`: app Node.js/Express com frontend estático e API do chat/Manager/CRM.
- `brand-assets/`: logos e assets de marca.
- `postgres-init/`: inicialização adicional do Postgres em produção.
- `n8n-workflows/`: workflow inicial para eventos do Chatwoot.
- `scripts/`: scripts operacionais de bootstrap, produção, branding, CRM, webhooks e reparos.

## Serviços Locais

Comando principal:

```bash
docker compose up -d
```

URLs locais:

- Fluvius/Chatwoot: `http://localhost:3000`
- Chat interno e Manager: `http://localhost:4000`
- Evolution API: `http://localhost:8080`
- Mailpit: `http://localhost:8025`

Serviços do compose local:

- `postgres`: imagem `pgvector/pgvector:pg16`, expõe `5432`.
- `redis`: imagem `redis:7`, expõe `6379`.
- `mailpit`: SMTP local e interface web.
- `chatwoot`: imagem local `fluvius-chatwoot:local`, roda Rails em `3000`.
- `sidekiq`: workers do Chatwoot.
- `evolution`: imagem `evoapicloud/evolution-api:v2.3.7`, roda em `8080`.
- `internal-chat`: Node 22, roda em `4000` e monta `./internal-chat`.

## Produção

O compose de produção é `docker-compose.prod.yml`.

Diferenças importantes:

- Postgres e Redis não expõem portas públicas.
- Chatwoot, Evolution e internal-chat expõem apenas em `127.0.0.1`.
- Caddy publica:
  - `https://fluvius.finderbit.com.br` -> `127.0.0.1:3000`
  - `https://evolution.fluvius.finderbit.com.br` -> `127.0.0.1:8080`
  - `https://chat.fluvius.finderbit.com.br` -> `127.0.0.1:4000`
- Uploads e instâncias usam volumes persistentes.
- O arquivo de referência para variáveis é `.env.production.example`.

Diretório esperado na VPS, conforme documentação:

```bash
/opt/apps/fluvius-local
```

## Chatwoot Customizado

A imagem customizada é construída em `chatwoot-custom/Dockerfile`, a partir de `chatwoot/chatwoot:latest`.

Ela:

- Copia `chatwoot-custom/overrides/` para `/app`.
- Copia `chatwoot-custom/initializers/` para `/app/config/initializers/`.
- Instala `pnpm`.
- Substitui referências visuais/textuais de Chatwoot para Fluvius em arquivos de frontend, locale e views.
- Executa `rails assets:precompile`.

Overrides conhecidos:

- `dashboard.routes.js`: adiciona as rotas `internal-chat` e `crm`.
- `internalChat/Index.vue`: tela nativa do Chatwoot que consome `VITE_INTERNAL_CHAT_API_URL`.
- `crm/Index.vue`: tela CRM interna do Chatwoot.
- `Sidebar.vue`: adiciona itens nativos na sidebar.
- `message/bubbles/Base.vue`: customização visual/comportamental de bolhas.

Ao mexer nos overrides, verifique compatibilidade com a versão atual da imagem base `chatwoot/chatwoot:latest`, porque caminhos e componentes internos podem mudar.

## Internal Chat

O app `internal-chat` é um serviço Node.js com:

- Express.
- Socket.IO.
- PostgreSQL via `pg`.
- Frontend estático em `internal-chat/public`.

Comando do pacote:

```bash
npm start
```

Arquivo principal:

```text
internal-chat/server.js
```

Responsabilidades principais:

- Chat interno entre agentes.
- Uploads de anexos para mensagens internas.
- Presença online e eventos em tempo real via Socket.IO.
- API de CRM por conta.
- Manager administrativo para revenda/operação.
- Criação e gestão de clientes/contas.
- Gestão de conexões WhatsApp via Evolution.
- Onboarding por token para conexão de WhatsApp.
- Integração com Chatwoot APIs usando tokens do `.env`.
- Automação opcional de CRM e triagem via Gemini.

Tabelas próprias criadas pelo serviço:

- `internal_chat_rooms`
- `internal_chat_participants`
- `internal_chat_messages`

Rotas relevantes:

- `GET /health`
- `GET /api/agents`
- `GET /api/bootstrap-users`
- `GET /api/rooms`
- `POST /api/rooms/dm`
- `POST /api/rooms/group`
- `GET /api/rooms/:roomId/messages`
- `POST /api/rooms/:roomId/messages`
- `POST /api/uploads`
- `GET /api/accounts/:accountId/crm/summary`
- `GET /api/accounts/:accountId/crm/leads`
- `POST /api/accounts/:accountId/crm/leads/:conversationId/stage`
- `PATCH /api/accounts/:accountId/crm/leads/:conversationId/fields`
- `POST /api/accounts/:accountId/crm/leads/:conversationId/analyze`
- `GET /manager`
- `POST /manager/login`
- `GET /manager/api/clients`
- `POST /manager/api/clients`
- `GET /onboard/:token`

Se `MANAGER_ADMIN_TOKEN` estiver definido, as rotas `/manager/api/*` exigem autenticação.

## CRM

O CRM usa labels e atributos personalizados nativos do Chatwoot/Fluvius.

Labels padrão do funil:

- `novo-lead`
- `em-atendimento`
- `orcamento-enviado`
- `follow-up`
- `fechado`
- `perdido`
- `pos-venda`

Campos comerciais padrão:

- `origem_lead`
- `produto_interesse`
- `valor_estimado`
- `proximo_follow_up`
- `observacao_comercial`

Aplicar padrões em contas existentes:

```bash
./scripts/apply-crm-defaults.sh
```

Em produção:

```bash
COMPOSE_FILE=docker-compose.prod.yml ./scripts/apply-crm-defaults.sh
```

## Variáveis de Ambiente

As variáveis reais ficam em `.env`. Não registre valores sensíveis em documentação, logs ou commits.

Principais grupos:

- Banco: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `CHATWOOT_POSTGRES_DB`, `EVOLUTION_POSTGRES_DB`.
- Chatwoot/Fluvius: `CHATWOOT_SECRET_KEY_BASE`, `CHATWOOT_FRONTEND_URL`, `CHATWOOT_DEFAULT_LOCALE`, `CHATWOOT_ENABLE_ACCOUNT_SIGNUP`.
- Tokens Chatwoot: `CHATWOOT_USER_ACCESS_TOKEN`, `CHATWOOT_PLATFORM_TOKEN`, `CHATWOOT_ACCOUNT_ID`.
- Chat interno: `INTERNAL_CHAT_PUBLIC_URL`, `INTERNAL_CHAT_ALLOWED_ORIGINS`, `CHATWOOT_PUBLIC_URL`.
- Manager: `MANAGER_ADMIN_TOKEN`.
- SMTP: `MAILER_SENDER_EMAIL`, `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`.
- Evolution: `EVOLUTION_API_KEY`, `EVOLUTION_SERVER_URL`, `EVOLUTION_SESSION_PHONE_CLIENT`.
- n8n: `N8N_WEBHOOK_URL`.
- IA: `GEMINI_API_KEY`, `CAPTAIN_*`, `CRM_AI_*`, `TRIAGE_BOT_*`.

## Scripts Operacionais

- `scripts/bootstrap-chatwoot-local.sh`: cria/configura admin e tokens no ambiente local.
- `scripts/auto-configure-production.sh`: automatiza configuração inicial em produção.
- `scripts/setup-vps.sh`: prepara VPS Ubuntu com Docker, Caddy e usuário de deploy.
- `scripts/update-from-git.sh`: atualiza deploy a partir do Git na VPS.
- `scripts/backup-postgres.sh`: gera dumps dos bancos Chatwoot e Evolution.
- `scripts/apply-fluvius-branding.sh`: reaplica identidade visual no banco do Chatwoot.
- `scripts/apply-crm-defaults.sh`: cria labels e atributos comerciais padrão.
- `scripts/apply-ai-config.sh`: aplica configuração de IA.
- `scripts/register-chatwoot-n8n-webhook.sh`: registra webhook do Chatwoot para o n8n.
- `scripts/unregister-chatwoot-n8n-webhook.sh`: remove webhook do n8n.
- `scripts/repair-chatwoot-evolution.sh`: repara vínculo Chatwoot/Evolution de uma instância.
- `scripts/repair-evolution-chatwoot-link.sh`: repara configuração de integração Evolution/Chatwoot.
- `scripts/repair-deleted-chatwoot-conversations.sh`: limpa referências órfãs da Evolution quando conversas/mensagens foram apagadas no Chatwoot.
- `scripts/repair-whatsapp-incoming.sh`: diagnostica e repara entrada WhatsApp -> Evolution -> Fluvius para uma instância.
- `scripts/sync-evolution-history-to-chatwoot.rb`: sincroniza histórico da Evolution para o Chatwoot.

## Comandos Úteis

Subir local:

```bash
docker compose up -d
```

Rebuild do Chatwoot customizado:

```bash
docker compose build chatwoot
docker compose up -d chatwoot sidekiq
```

Logs locais:

```bash
docker compose logs -f chatwoot sidekiq internal-chat evolution
```

Status em produção:

```bash
docker compose -f docker-compose.prod.yml ps
```

Logs em produção:

```bash
docker compose -f docker-compose.prod.yml logs -f chatwoot internal-chat evolution
```

## Integração n8n

O workflow simples de teste está em:

```text
n8n-workflows/chatwoot-events-starter.json
```

Esse workflow recebe webhooks do Chatwoot, processa apenas `message_created` de mensagens públicas incoming e responde `hello world` na mesma conversa usando a API pública do Chatwoot.

O workflow chama a API pública do Chatwoot diretamente. No n8n, crie/associe uma credencial `Header Auth` chamada `Fluvius Chatwoot API` com header `api_access_token`.

Variáveis esperadas:

- No ambiente do n8n: `CHATWOOT_BASE_URL` ou `FLUVIUS_CHATWOOT_BASE_URL`, apontando para o domínio público do Fluvius.
- No ambiente que registra o webhook: `N8N_WEBHOOK_URL`, apontando para `https://<dominio-n8n>/webhook/fluvius-events`.

Evento enviado ao n8n:

- `message_created`

Registre o webhook somente depois de ativar o workflow no n8n, para evitar erro 404 nas entregas do Chatwoot.

Quando o workflow n8n estiver ativo, mantenha o bot de triagem interno desativado com `TRIAGE_BOT_ENABLED=false` para evitar respostas duplicadas.

## Cuidados ao Alterar

- Não commitar `.env`, `.env.production` ou tokens reais.
- Evitar mudanças amplas em `chatwoot-custom/overrides` sem validar contra a imagem base atual do Chatwoot.
- O serviço `internal-chat` escreve no banco do Chatwoot e também lê o banco da Evolution; mudanças de schema precisam considerar ambos.
- `internal-chat/server.js` concentra muitas responsabilidades. Antes de alterar fluxos de Manager, CRM ou onboarding, localizar as rotas e helpers relacionados no mesmo arquivo.
- Em produção, preferir `COMPOSE_FILE=docker-compose.prod.yml` nos scripts que aceitam essa variável.
- Depois de alterar frontend embutido no Chatwoot, reconstruir a imagem e subir `chatwoot` e `sidekiq`.
- Depois de alterar `internal-chat`, no local basta reiniciar o serviço; em produção, reconstruir a imagem se estiver usando build/imagem versionada.

## Lacunas Conhecidas

- Não há script de teste automatizado definido no `internal-chat/package.json`; existe apenas `npm start`.
- O arquivo `test_signup.js` existe na raiz, mas não há comando documentado para executá-lo.
- O workflow n8n usa `CHATWOOT_BASE_URL`/`FLUVIUS_CHATWOOT_BASE_URL` no node `Prepare Incoming`; confirme essas variáveis antes de ativar em cada ambiente.
