# Evolution media delivery

## Fluxo de envio de imagem

1. O atendente envia a imagem pelo composer da conversa.
2. O frontend chama `POST /api/v1/accounts/:account_id/conversations/:conversation_id/messages` com `attachments[]`.
3. `Messages::MessageBuilder` cria `Message` outgoing e `Attachment` com ActiveStorage.
4. Depois do commit, `Message#send_reply` agenda `SendReplyJob` com pequeno atraso quando ha anexo.
5. Para `Channel::Api`, o envio externo acontece pelo webhook de inbox API, filtrado para `message_created:outgoing`.
6. O webhook chama a Evolution em `/chatwoot/webhook/:instance`.
7. `evolution_media_delivery_guard.rb` reescreve URLs de anexos para `FLUVIUS_EVOLUTION_MEDIA_BASE_URL`, valida a resposta da Evolution, salva `source_id` quando a resposta traz id externo e marca a mensagem como `failed` se a Evolution retornar erro ou se o job falhar.

## Reproducao manual

1. Abrir uma conversa de WhatsApp no Fluvius.
2. Anexar uma imagem pequena, por exemplo PNG ou JPEG.
3. Enviar a mensagem.
4. Conferir se a mensagem aparece na conversa do Fluvius.
5. Conferir no WhatsApp real do cliente se a imagem chegou.
6. Conferir logs:
   `docker compose logs --tail=200 chatwoot-sidekiq chatwoot evolution`
7. Procurar por:
   `[fluvius-evolution-media] send_attempt`,
   `[fluvius-evolution-media] send_response` ou
   `[fluvius-evolution-media] send_failure`.

## Hipoteses validadas

- UI otimista: o frontend pode exibir a mensagem antes da entrega externa final. Quando a Evolution falha, o backend atualiza a mensagem para `failed` com `external_error`, e o componente de mensagem existente mostra o erro e aciona retry quando disponivel.
- URL inacessivel: anexos enviados para a Evolution agora usam `FLUVIUS_EVOLUTION_MEDIA_BASE_URL`, por padrao `http://chatwoot:3000`, para evitar `localhost` ou host publico inacessivel de dentro do container Evolution.
- Payload de midia: o payload original do Chatwoot e preservado, mas `data_url` e `thumb_url` de anexos sao trocados pela URL de download do ActiveStorage acessivel pela Evolution.
- MIME e tamanho: os logs registram `media_type`, `mime_type` e `file_size` por anexo.
- Job silencioso: exception no webhook marca a mensagem como `failed` e grava log com classe, mensagem e backtrace resumido.
- Erro ignorado: corpo JSON da Evolution e validado para `error`, `errors`, `exception`, `status` de falha ou `success=false`.
- Texto versus midia: a mudanca e limitada a webhooks Evolution. Logs detalhados aparecem para mensagens com anexo; erros da Evolution tambem podem falhar texto se a resposta do provider indicar falha.

## Configuracao

`FLUVIUS_EVOLUTION_MEDIA_BASE_URL` deve ser uma URL que o container Evolution consegue abrir e que aponta para o Chatwoot Rails.

No Docker Compose padrao:

```env
FLUVIUS_EVOLUTION_MEDIA_BASE_URL=http://chatwoot:3000
```

Se a Evolution estiver fora da rede Docker, configure uma URL publica HTTPS do Chatwoot.
