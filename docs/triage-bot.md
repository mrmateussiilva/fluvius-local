# Triage Bot por Webhook Chatwoot

## Arquitetura

O `triage-bot` é um serviço isolado que recebe `message_created` do Chatwoot em `POST /webhook/chatwoot`.

Fluxo:

1. Evolution entrega a mensagem no Chatwoot.
2. Chatwoot cria a mensagem e dispara webhook `message_created`.
3. `triage-bot` valida o `secret` nativo do Chatwoot (`X-Chatwoot-Signature`) ou o header manual `X-Triage-Webhook-Secret`.
4. O bot ignora mensagens `outgoing`, privadas, de agentes, de bots e conversas com label `triagem_concluida`.
5. Na primeira mensagem válida, o bot envia o menu usando API oficial do Chatwoot.
6. Na resposta do cliente, o bot procura a opção configurada para aquela empresa, aplica labels, tenta atribuir ao time e envia a confirmação usando API oficial do Chatwoot.
7. Se a resposta não bater com nenhuma opção, o bot encaminha para a opção humana, aplica `humano` e `triagem_concluida`, e não insiste no menu.

O bot não chama a Evolution e não escreve em tabelas do Chatwoot. O estado próprio fica em SQLite no volume `triage_bot_data`.

## Arquivos criados

- `triage-bot/app.py`: servidor HTTP, regras de triagem, SQLite e cliente da API Chatwoot.
- `triage-bot/Dockerfile`: imagem Python sem dependências externas.
- `docs/triage-bot.md`: este guia.

## Variáveis de ambiente

```env
CHATWOOT_BASE_URL=http://chatwoot:3000
CHATWOOT_ACCOUNT_ID=3
CHATWOOT_API_TOKEN=token_do_usuario_chatwoot
TRIAGE_WEBHOOK_SECRET=um_segredo_forte
TRIAGE_ADMIN_TOKEN=mesmo_segredo_ou_outro_segredo
TRIAGE_FINANCE_TEAM_ID=
TRIAGE_SUPPORT_TEAM_ID=
TRIAGE_SALES_TEAM_ID=
TRIAGE_HUMAN_TEAM_ID=
```

Os `TRIAGE_*_TEAM_ID` são apenas fallback para a configuração inicial. A configuração real por empresa fica no SQLite do `triage-bot` e é editada pelo Manager.

Se o `team_id` de uma opção ficar vazio, o bot tenta encontrar times por nome/alias:

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
3. Edite a **Mensagem inicial**.
4. Configure até 6 opções com número, texto, label, time ID opcional e mensagem de confirmação.
5. Salve.

Se o bot estiver desativado para a empresa, ele recebe o webhook mas retorna `ignored` com motivo `triage_disabled`.

Cada empresa pode ter um menu diferente. Exemplo:

```text
1 - Financeiro
2 - Segunda via
3 - Suporte tecnico
4 - Falar com atendente
```

A label da opção é aplicada na conversa junto com `triagem_concluida`. Para encaminhar para um time específico, preencha o `Time ID` daquela opção no Manager.

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
3. Responda com o número de uma opção configurada.
4. Confirme no Chatwoot que a conversa recebeu a label do setor e `triagem_concluida`.
5. Confirme que a conversa foi atribuída ao time quando o time existir.
6. Em outra conversa nova, responda algo inválido e confirme que foi encaminhada para humano e concluída.

## Como validar que não criou loop

- Envie uma mensagem depois da label `triagem_concluida`: o bot deve retornar `ignored`.
- Envie mensagem `outgoing` pelo Chatwoot: o bot deve ignorar.
- Veja logs:

```bash
docker compose logs -f triage-bot
```

O bot só responde a `incoming` público de contato. As respostas que ele mesmo cria são `outgoing`, então o próximo webhook gerado pelo Chatwoot é ignorado.
