# Triage Bot por Webhook Chatwoot

## Arquitetura

O `triage-bot` é um serviço isolado que recebe `message_created` do Chatwoot em `POST /webhook/chatwoot`.

Fluxo:

1. Evolution entrega a mensagem no Chatwoot.
2. Chatwoot cria a mensagem e dispara webhook `message_created`.
3. `triage-bot` valida o `secret` nativo do Chatwoot (`X-Chatwoot-Signature`) ou o header manual `X-Triage-Webhook-Secret`.
4. O bot ignora mensagens `outgoing`, privadas, de agentes, de bots e conversas com label `triagem_concluida`.
5. Na primeira mensagem válida, o bot envia o menu usando API oficial do Chatwoot.
6. Na resposta `1`, `2`, `3` ou `4`, o bot aplica labels, tenta atribuir ao time e envia a confirmação usando API oficial do Chatwoot.

O bot não chama a Evolution e não escreve em tabelas do Chatwoot. O estado próprio fica em SQLite no volume `triage_bot_data`.

## Arquivos criados

- `triage-bot/app.py`: servidor HTTP, regras de triagem, SQLite e cliente da API Chatwoot.
- `triage-bot/Dockerfile`: imagem Python sem dependências externas.
- `docs/triage-bot.md`: este guia.

## Variáveis de ambiente

```env
CHATWOOT_BASE_URL=http://chatwoot:3000
TRIAGE_CHATWOOT_ACCOUNT_ID=3
TRIAGE_CHATWOOT_API_TOKEN=token_do_usuario_chatwoot
TRIAGE_WEBHOOK_SECRET=um_segredo_forte
TRIAGE_FINANCE_TEAM_ID=
TRIAGE_SUPPORT_TEAM_ID=
TRIAGE_SALES_TEAM_ID=
TRIAGE_HUMAN_TEAM_ID=
```

Se `TRIAGE_*_TEAM_ID` ficar vazio, o bot tenta encontrar times por nome:

- `Financeiro`
- `Suporte`
- `Comercial`
- `Humano`, `Atendente` ou `Atendimento`

Mantenha o bot antigo do `internal-chat` desligado:

```env
TRIAGE_BOT_ENABLED=false
```

## Docker Compose

Local:

```bash
docker compose up -d --build triage-bot
```

Produção:

```bash
docker compose -f docker-compose.prod.yml up -d --build triage-bot
```

Health:

```bash
docker compose exec triage-bot wget -qO- http://127.0.0.1:4100/health
```

## Como configurar webhook no Chatwoot

Pelo Manager, abra a empresa e use o painel **Bot de triagem inicial**. Ao ativar e salvar, o Manager grava a configuração da conta no `triage-bot` e registra/atualiza o webhook assinado no Chatwoot.

Configuração manual equivalente:

```text
URL: http://triage-bot:4100/webhook/chatwoot
Evento: message_created
Secret: <TRIAGE_WEBHOOK_SECRET>
```

Use a URL interna acima porque Chatwoot e `triage-bot` rodam na mesma rede Docker. Não precisa expor no Caddy.

O campo `secret` do Chatwoot gera a assinatura `X-Chatwoot-Signature`. O bot também aceita `X-Triage-Webhook-Secret` para testes manuais com `curl`.

## Configuração por empresa no Manager

No detalhe da empresa:

1. Abra **Bot de triagem inicial**.
2. Marque ou desmarque **Ativar bot nesta empresa**.
3. Preencha IDs de times se quiser roteamento explícito.
4. Salve.

Se o bot estiver desativado para a empresa, ele recebe o webhook mas retorna `ignored` com motivo `triage_disabled`.

## Como testar

Teste autenticação e filtros sem chamar a API do Chatwoot:

```bash
curl -i http://localhost:4100/webhook/chatwoot \
  -H 'Content-Type: application/json' \
  -H 'X-Triage-Webhook-Secret: <TRIAGE_WEBHOOK_SECRET>' \
  -d '{
    "event": "message_created",
    "account": { "id": 3 },
    "conversation": { "display_id": 123, "labels": [] },
    "message": {
      "message_type": "outgoing",
      "private": false,
      "content": "teste",
      "sender": { "type": "user" }
    }
  }'
```

A resposta esperada é `{"action":"ignored",...}`.

Para teste real:

1. Abra uma conversa nova pelo WhatsApp.
2. Confirme que o bot respondeu com o menu.
3. Responda `1`, `2`, `3` ou `4`.
4. Confirme no Chatwoot que a conversa recebeu a label do setor e `triagem_concluida`.
5. Confirme que a conversa foi atribuída ao time quando o time existir.

## Como validar que não criou loop

- Envie uma mensagem depois da label `triagem_concluida`: o bot deve retornar `ignored`.
- Envie mensagem `outgoing` pelo Chatwoot: o bot deve ignorar.
- Veja logs:

```bash
docker compose logs -f triage-bot
```

O bot só responde a `incoming` público de contato. As respostas que ele mesmo cria são `outgoing`, então o próximo webhook gerado pelo Chatwoot é ignorado.
