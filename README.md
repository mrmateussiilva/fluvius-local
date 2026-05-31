# Fluvius Local

Stack local com Fluvius, uma imagem customizada do Chatwoot, Evolution API, Postgres com pgvector e Redis.

## Subir

```bash
docker compose up -d
```

Servicos:

- Chatwoot: http://localhost:3000
- Chat interno Fluvius: http://localhost:4000
- Evolution API: http://localhost:8080
- Mailpit, caixa de e-mails local: http://localhost:8025
- Evolution API key: definida em `.env` como `EVOLUTION_API_KEY`

## Configuracao

As credenciais e valores locais ficam em `.env`.

Principais variaveis:

- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `CHATWOOT_SECRET_KEY_BASE`
- `EVOLUTION_API_KEY`
- `EVOLUTION_SERVER_URL`
- `MAILER_SENDER_EMAIL`
- `SMTP_ADDRESS`
- `SMTP_PORT`
- `N8N_WEBHOOK_URL`

O arquivo `.env` esta no `.gitignore` para evitar commit de segredos.

## Criar agentes

No Chatwoot:

1. Acesse `Configuracoes` > `Agentes`.
2. Clique em adicionar agente.
3. Informe nome, e-mail e permissao.
4. Abra http://localhost:8025 para ver o e-mail de convite/verificacao.
5. Clique no link do e-mail dentro do Mailpit.

Neste ambiente local, os e-mails nao vao para a caixa real do Gmail/Outlook. Eles ficam presos no Mailpit.

## Chat interno entre agentes

O servico `internal-chat` cria o backend do chat interno entre agentes.

No Fluvius/Chatwoot, ele aparece como item nativo da sidebar:

```text
Chat interno
```

Rota interna:

```text
http://localhost:3000/app/accounts/1/internal-chat
```

Tambem pode ser aberto diretamente para debug:

```text
http://localhost:4000
```

Como usar:

1. Selecione o agente em `Entrar como`.
2. Clique em outro agente para iniciar uma conversa direta.
3. Use `Grupo` para criar conversa com varios agentes.
4. As mensagens sao internas e nao sao enviadas ao WhatsApp nem ao cliente.

O chat le os agentes do banco do Chatwoot e grava as mensagens em tabelas proprias:

- `internal_chat_rooms`
- `internal_chat_participants`
- `internal_chat_messages`

## Customizacao do Chatwoot

O Fluvius usa uma imagem local customizada:

```text
fluvius-chatwoot:local
```

Os overrides ficam em:

```text
chatwoot-custom/overrides
```

Hoje a customizacao adiciona:

- rota nativa `/app/accounts/:accountId/internal-chat`
- item `Chat interno` na sidebar do Chatwoot
- tela Vue que embute o servico `internal-chat`

Para reconstruir:

```bash
docker compose build chatwoot
docker compose up -d chatwoot sidekiq
```

## n8n

Esta stack usa o n8n externo:

```text
https://n8n.corrigeja.com.br
```

Workflow inicial:

```text
n8n-workflows/chatwoot-events-starter.json
```

Como ativar eventos do Chatwoot para o n8n:

1. Abra o n8n em `https://n8n.corrigeja.com.br`.
2. Importe o workflow `n8n-workflows/chatwoot-events-starter.json`.
3. Ative o workflow no n8n.
4. Rode:

```bash
./scripts/register-chatwoot-n8n-webhook.sh
```

Isso registra no Chatwoot o webhook:

```text
https://n8n.corrigeja.com.br/webhook/chatwoot-events
```

Eventos enviados:

- `conversation_created`
- `conversation_updated`
- `conversation_status_changed`
- `message_created`
- `message_updated`
- `contact_created`
- `contact_updated`

Para remover:

```bash
./scripts/unregister-chatwoot-n8n-webhook.sh
```

Nao registre o webhook antes de ativar o workflow no n8n, porque o Chatwoot vai tentar entregar eventos e receber erro 404.

## Enderecos entre containers

Dentro da rede Docker, nao use `localhost` entre servicos:

- Evolution chama Chatwoot em `http://chatwoot:3000`
- Chatwoot chama Evolution em `http://evolution:8080`

## Reparar integracao Chatwoot/Evolution

Se recriar inbox, instancia ou a Evolution voltar a gravar webhook com `localhost`, rode:

```bash
./scripts/repair-chatwoot-evolution.sh
```

Para outra instancia:

```bash
./scripts/repair-chatwoot-evolution.sh NomeDaInstancia
```

Esse script:

- corrige a URL do webhook da inbox API do Chatwoot para `http://evolution:8080/chatwoot/webhook/<instancia>`
- ajusta `WEBHOOK_TIMEOUT=30` no Chatwoot
- limpa o cache de configuracao do Chatwoot

## Reaplicar marca Fluvius

Se o container ou as configuracoes do Chatwoot forem recriados, rode:

```bash
./scripts/apply-fluvius-branding.sh
```

Esse script define:

- nome da instalacao como `Fluvius`
- logos em `/brand-assets`
- paleta principal em tons de verde

## Configurar IA do Chatwoot

O Captain AI do Chatwoot usa as configs:

- `CAPTAIN_OPEN_AI_API_KEY`
- `CAPTAIN_OPEN_AI_MODEL`
- `CAPTAIN_OPEN_AI_ENDPOINT`

Neste projeto, configure pelo `.env` e aplique com o script.

Para OpenAI:

```bash
# edite .env e preencha OPENAI_API_KEY
CAPTAIN_PROVIDER=openai
OPENAI_API_KEY=sk-...
CAPTAIN_OPEN_AI_MODEL=gpt-4.1-mini

./scripts/apply-ai-config.sh openai
```

Para Gemini:

```bash
# edite .env e preencha GEMINI_API_KEY
CAPTAIN_PROVIDER=gemini
GEMINI_API_KEY=...
CAPTAIN_GEMINI_MODEL=gemini-2.5-flash

./scripts/apply-ai-config.sh gemini
```

O script grava as configs no banco do Chatwoot e reinicia `chatwoot` e `sidekiq`.

## Observacoes

O servico `sidekiq` e necessario para envio de mensagens pelo Chatwoot. Sem ele, mensagens podem aparecer no Chatwoot, mas nao sair para o WhatsApp.

`ALLOW_PRIVATE_WEBHOOK_URLS=true` e o initializer local permitem webhooks para containers Docker internos. Use isso apenas neste ambiente local.
