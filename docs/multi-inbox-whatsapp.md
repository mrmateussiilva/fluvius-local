# Multi-Inbox WhatsApp — Múltiplos Números por Empresa

Permite associar **vários números/canais WhatsApp** a uma única conta Fluvius/Chatwoot, sem criar contas separadas.

---

## Como funciona

Cada empresa já tem um número principal provisionado em `fluvius_clients`. As conexões adicionais ficam em `fluvius_client_inboxes` e compartilham a mesma conta Chatwoot, aparecendo como inboxes independentes dentro do painel de atendimento do cliente.

```
fluvius_clients (empresa)
  └── inbox principal (chatwoot_account_id + inbox_id)
  └── fluvius_client_inboxes
        ├── "Vendas"    → instância Evolution + inbox Chatwoot
        ├── "Suporte"   → instância Evolution + inbox Chatwoot
        └── "WhatsApp 2" → ...
```

---

## Banco de dados

Tabela criada automaticamente no boot do `internal-chat`:

```sql
CREATE TABLE IF NOT EXISTS fluvius_client_inboxes (
  id                       SERIAL PRIMARY KEY,
  client_id                INTEGER NOT NULL REFERENCES fluvius_clients(id),
  label                    TEXT NOT NULL,
  instance_name            TEXT,
  channel_display_name     TEXT,
  inbox_id                 INTEGER,
  inbox_token              TEXT,
  token                    TEXT UNIQUE NOT NULL,   -- link de onboarding independente
  status                   TEXT DEFAULT 'pending',
  phone                    TEXT,
  integration_status       TEXT DEFAULT 'pending',
  integration_last_checked_at TIMESTAMP,
  integration_last_error   TEXT,
  integration_repaired_at  TIMESTAMP,
  created_at               TIMESTAMP DEFAULT NOW(),
  updated_at               TIMESTAMP DEFAULT NOW()
);
```

---

## API — Rotas do Manager

Todas as rotas exigem autenticação de sessão do Manager.

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET`  | `/manager/api/clients/:id/inboxes` | Lista conexões extras da empresa |
| `POST` | `/manager/api/clients/:id/inboxes` | Adiciona nova conexão |
| `DELETE` | `/manager/api/clients/:id/inboxes/:inboxId` | Remove conexão + limpa Evolution/Chatwoot |
| `GET`  | `/manager/api/clients/:id/inboxes/:inboxId/integration/status` | Diagnóstico da integração |
| `POST` | `/manager/api/clients/:id/inboxes/:inboxId/integration/repair` | Tenta reparar a integração |

### POST `/manager/api/clients/:id/inboxes`

**Body:**
```json
{ "label": "Suporte" }
```

**O que acontece internamente:**
1. Cria instância na Evolution API (`fluvius-<empresa>-<label>-<ts>`)
2. Cria inbox no Chatwoot da empresa (tipo `api`)
3. Vincula Evolution ao Chatwoot via `/chatwoot/set/:instance`
4. Habilita sincronização de histórico
5. Atualiza webhook da inbox com a URL da Evolution
6. Grava em `fluvius_client_inboxes`

Se qualquer passo falhar, a instância Evolution criada é deletada automaticamente (rollback parcial).

**Resposta:** registro completo da nova inbox, incluindo `token` (link de onboarding).

### DELETE `/manager/api/clients/:id/inboxes/:inboxId`

Remove a instância da Evolution API, deleta a inbox no Chatwoot e apaga o registro do banco.

---

## Onboarding (pareamento do WhatsApp)

Cada conexão extra tem seu próprio token único. O link de pareamento segue o mesmo formato da conexão principal:

```
https://<dominio>/onboard/<token>
```

A rota `/onboard/:token` detecta automaticamente se o token pertence à tabela principal (`fluvius_clients`) ou à de extras (`fluvius_client_inboxes`) e atualiza o status no lugar correto ao conectar.

---

## Usando no Manager

1. Acesse o Manager → **"Ver empresa"** em qualquer cliente
2. Role até a seção **"Conexões WhatsApp Extras"**
3. Clique em **"+ Adicionar conexão"**
4. Informe o nome do setor/canal (ex: `Suporte`, `Vendas`, `WhatsApp 2`)
5. Copie o link de **Onboarding** gerado e envie para o responsável parear o aparelho
6. O novo número aparece imediatamente como inbox separado dentro do Chatwoot da empresa

Ações disponíveis por conexão extra: **Onboarding**, **Copiar link**, **Reparar integração**, **Remover**.
