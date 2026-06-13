# Pos-login em producao

Este guia continua a partir do ponto em que o deploy ja subiu e voce conseguiu entrar no Chatwoot.

## Contexto da VPS

Na VPS atual, o projeto esta em:

```bash
/opt/apps/fluvius-local
```

Sempre rode os comandos a partir desse diretorio:

```bash
cd /opt/apps/fluvius-local
```

## Validar servicos

Confira se os containers estao ativos:

```bash
docker compose -f docker-compose.prod.yml ps
```

Os principais servicos esperados sao:

- `chatwoot`
- `chatwoot-sidekiq`
- `fluvius-internal-chat`
- `evolution`
- `postgres`
- `redis`

Para acompanhar logs:

```bash
docker compose -f docker-compose.prod.yml logs -f chatwoot internal-chat evolution
```

## Admin do Chatwoot

As credenciais do admin ficam no `.env`:

```bash
grep '^CHATWOOT_ADMIN_EMAIL=' .env
grep '^CHATWOOT_ADMIN_PASSWORD=' .env
```

Se a senha estiver entre aspas no `.env`, remova as aspas antes de rodar a configuracao automatica novamente.

Exemplo:

```env
CHATWOOT_ADMIN_PASSWORD=MJs119629@03770
```

Depois rode:

```bash
VPS_DIR="/opt/apps/fluvius-local" \
ENV_FILE="/opt/apps/fluvius-local/.env" \
COMPOSE_FILE="/opt/apps/fluvius-local/docker-compose.prod.yml" \
bash scripts/auto-configure-production.sh
```

Se houver bloqueio por muitas tentativas de login, reinicie o Redis:

```bash
docker compose -f docker-compose.prod.yml restart redis
```

## Confirmar tokens gerados

Depois do bootstrap automatico, o `.env` deve conter tokens reais:

```bash
grep -E 'CHATWOOT_ACCOUNT_ID|CHATWOOT_USER_ACCESS_TOKEN|CHATWOOT_PLATFORM_TOKEN' .env
```

Os valores de token nao devem estar como:

```text
auto-generated-by-deploy
```

Se ainda estiverem assim, rode novamente:

```bash
VPS_DIR="/opt/apps/fluvius-local" \
ENV_FILE="/opt/apps/fluvius-local/.env" \
COMPOSE_FILE="/opt/apps/fluvius-local/docker-compose.prod.yml" \
bash scripts/auto-configure-production.sh
```

## Acessar Manager

Abra:

```text
https://chat.fluvius.finderbit.com.br/manager
```

Se o Manager pedir token administrativo, consulte:

```bash
grep '^MANAGER_ADMIN_TOKEN=' .env
```

## Separacao dos paineis

Use o Manager Fluvius apenas para sua operacao privada de revenda/plataforma:

- criar empresas
- abrir o detalhe operacional de cada empresa
- copiar acesso da empresa
- conectar ou reconectar WhatsApp
- adicionar agentes
- redefinir senhas
- importar historico
- verificar integracoes tecnicas

A empresa deve usar o Fluvius/Chatwoot para atendimento diario e CRM:

```text
https://fluvius.finderbit.com.br
```

No Manager, cada empresa tem um botao para abrir diretamente o Chatwoot na conta correta:

```text
Abrir Chatwoot da empresa
```

O admin da empresa ve conversas, contatos, agentes, atribuicoes, labels do funil e campos comerciais dentro do Chatwoot. O Manager nao e tela de atendimento nem painel do cliente final.

Tela CRM dentro do Chatwoot da empresa:

```text
https://fluvius.finderbit.com.br/app/accounts/<ID_DA_CONTA>/crm
```

O item tambem aparece na sidebar como `CRM`.

O CRM inicial do cliente usa labels e atributos personalizados nativos do Chatwoot:

```text
novo-lead
em-atendimento
orcamento-enviado
follow-up
fechado
perdido
pos-venda
```

Campos comerciais:

```text
origem_lead
produto_interesse
valor_estimado
proximo_follow_up
observacao_comercial
```

Para aplicar esses padroes em empresas ja existentes:

```bash
COMPOSE_FILE=docker-compose.prod.yml ./scripts/apply-crm-defaults.sh
```

## Criar primeira conexao WhatsApp

No Manager:

1. Crie um cliente ou conexao.
2. Gere o QR Code.
3. Escaneie o QR Code com o WhatsApp.
4. Aguarde o status ficar conectado.
5. Envie uma mensagem de teste para esse numero.
6. Confirme se a conversa aparece no Chatwoot.

## URLs de producao

```text
Chatwoot:  https://fluvius.finderbit.com.br
Manager:   https://chat.fluvius.finderbit.com.br/manager
Evolution: https://evolution.fluvius.finderbit.com.br
```

## Problemas comuns

### Login retorna 401

Verifique email e senha no `.env`, remova aspas da senha e rode novamente o bootstrap automatico.

```bash
VPS_DIR="/opt/apps/fluvius-local" \
ENV_FILE="/opt/apps/fluvius-local/.env" \
COMPOSE_FILE="/opt/apps/fluvius-local/docker-compose.prod.yml" \
bash scripts/auto-configure-production.sh
```

Se houve muitas tentativas:

```bash
docker compose -f docker-compose.prod.yml restart redis
```

### Chatwoot abriu onboarding

Rode a configuracao automatica:

```bash
VPS_DIR="/opt/apps/fluvius-local" \
ENV_FILE="/opt/apps/fluvius-local/.env" \
COMPOSE_FILE="/opt/apps/fluvius-local/docker-compose.prod.yml" \
bash scripts/auto-configure-production.sh
```

### Evolution nao conecta no banco

Confira se o banco `evolution` existe. Em ambientes com volume Postgres ja criado, o script de `postgres-init` nao roda novamente automaticamente.

```bash
docker compose -f docker-compose.prod.yml exec postgres psql \
  -U "$POSTGRES_USER" \
  -d "$CHATWOOT_POSTGRES_DB" \
  -c '\l'
```

Se necessario, crie manualmente o banco `evolution` usando os valores do `.env`.

### Evolution mostra `getaddrinfo ENOTFOUND host`

Esse erro indica que a configuracao Chatwoot gravada na Evolution esta apontando para um host invalido.

Repare todas as instancias cadastradas. O script tambem garante `ALLOW_PRIVATE_WEBHOOK_URLS=true`, recria Chatwoot/Sidekiq se necessario e espera o Chatwoot ficar pronto:

```bash
cd /opt/apps/fluvius-local

VPS_DIR="/opt/apps/fluvius-local" \
ENV_FILE="/opt/apps/fluvius-local/.env" \
COMPOSE_FILE="/opt/apps/fluvius-local/docker-compose.prod.yml" \
bash scripts/repair-evolution-chatwoot-link.sh
```

Ou repare apenas uma instancia:

```bash
bash scripts/repair-evolution-chatwoot-link.sh NomeDaInstancia
```

Depois envie uma nova mensagem e confira:

```bash
docker compose -f docker-compose.prod.yml logs --tail=120 chatwoot
docker compose -f docker-compose.prod.yml logs --tail=120 evolution
```

## Proximo teste obrigatorio

Depois de conectar o WhatsApp, envie uma mensagem real para validar o caminho completo:

```text
WhatsApp -> Evolution -> Chatwoot -> Manager
```

Esse e o teste que confirma que o deploy esta funcional para uso.
