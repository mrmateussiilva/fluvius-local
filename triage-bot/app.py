import hashlib
import hmac
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


PORT = int(os.getenv("PORT", "4100"))
DATABASE_PATH = os.getenv("TRIAGE_DATABASE_PATH", "/data/triage-bot.sqlite3")
CHATWOOT_BASE_URL = os.getenv("CHATWOOT_BASE_URL", "http://chatwoot:3000").rstrip("/")
CHATWOOT_ACCOUNT_ID = int(os.getenv("CHATWOOT_ACCOUNT_ID", "0") or "0")
CHATWOOT_API_TOKEN = os.getenv("CHATWOOT_API_TOKEN", "")
TRIAGE_WEBHOOK_SECRET = os.getenv("TRIAGE_WEBHOOK_SECRET", "")
TRIAGE_ADMIN_TOKEN = os.getenv("TRIAGE_ADMIN_TOKEN", TRIAGE_WEBHOOK_SECRET)
TRIAGE_DEFAULT_ENABLED = os.getenv("TRIAGE_DEFAULT_ENABLED", "false").lower() == "true"

DEFAULT_GREETING_TEXT = "\n".join(
    [
        "Olá! 👋",
        "Antes de te encaminhar, me diz com quem você deseja falar:",
    ]
)

INVALID_SELECTION_TEXT = "Vou te encaminhar para um atendente."

DEFAULT_OPTIONS = [
    {
        "key": "1",
        "text": "Financeiro",
        "label": "financeiro",
        "team_id": os.getenv("TRIAGE_FINANCE_TEAM_ID", ""),
        "team_aliases": ["financeiro", "finance"],
        "confirmation_text": "Perfeito, vou te encaminhar para Financeiro.",
    },
    {
        "key": "2",
        "text": "Suporte",
        "label": "suporte",
        "team_id": os.getenv("TRIAGE_SUPPORT_TEAM_ID", ""),
        "team_aliases": ["suporte", "support"],
        "confirmation_text": "Perfeito, vou te encaminhar para Suporte.",
    },
    {
        "key": "3",
        "text": "Comercial",
        "label": "comercial",
        "team_id": os.getenv("TRIAGE_SALES_TEAM_ID", ""),
        "team_aliases": ["comercial", "vendas", "sales"],
        "confirmation_text": "Perfeito, vou te encaminhar para Comercial.",
    },
    {
        "key": "4",
        "text": "Falar com atendente",
        "label": "humano",
        "team_id": os.getenv("TRIAGE_HUMAN_TEAM_ID", ""),
        "team_aliases": ["humano", "atendente", "atendimento"],
        "confirmation_text": "Vou te encaminhar para um atendente.",
    },
]

COMPLETED_LABEL = "triagem_concluida"
LABEL_COLORS = {
    "financeiro": "#f59e0b",
    "suporte": "#3b82f6",
    "comercial": "#22c55e",
    "humano": "#8b5cf6",
    "triagem_concluida": "#64748b",
}
STATE_WAITING = "waiting_selection"
STATE_COMPLETED = "completed"
db_lock = threading.Lock()
team_cache = {}
label_cache = {}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def ensure_column(conn, table, column, definition):
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def ensure_database():
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
    with sqlite3.connect(DATABASE_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS triage_conversations (
              conversation_id TEXT NOT NULL,
              account_id INTEGER NOT NULL,
              state TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              selected_department TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (account_id, conversation_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS triage_account_configs (
              account_id INTEGER PRIMARY KEY,
              enabled INTEGER NOT NULL DEFAULT 0,
              finance_team_id TEXT,
              support_team_id TEXT,
              sales_team_id TEXT,
              human_team_id TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        ensure_column(conn, "triage_account_configs", "greeting_text", "TEXT")
        ensure_column(conn, "triage_account_configs", "invalid_behavior", "TEXT")
        ensure_column(conn, "triage_account_configs", "options_json", "TEXT")
        conn.commit()


def default_options():
    return json.loads(json.dumps(DEFAULT_OPTIONS))


def legacy_options_from_team_ids(config):
    options = default_options()
    options[0]["team_id"] = config.get("finance_team_id") or ""
    options[1]["team_id"] = config.get("support_team_id") or ""
    options[2]["team_id"] = config.get("sales_team_id") or ""
    options[3]["team_id"] = config.get("human_team_id") or ""
    return options


def sanitize_options(value, fallback=None):
    raw_options = value if isinstance(value, list) else fallback or default_options()
    options = []
    used_keys = set()
    for index, item in enumerate(raw_options[:6], start=1):
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or index).strip()[:8]
        text = str(item.get("text") or item.get("title") or item.get("department") or "").strip()[:80]
        label = str(item.get("label") or "").strip().lower()[:60]
        team_id = str(item.get("team_id") or "").strip()[:24]
        confirmation_text = str(item.get("confirmation_text") or "").strip()[:240]
        if not key or not text or not label or key in used_keys:
            continue
        used_keys.add(key)
        if not confirmation_text:
            confirmation_text = f"Perfeito, vou te encaminhar para {text}."
        options.append(
            {
                "key": key,
                "text": text,
                "label": label,
                "team_id": team_id,
                "team_aliases": item.get("team_aliases") if isinstance(item.get("team_aliases"), list) else [label, text.lower()],
                "confirmation_text": confirmation_text,
            }
        )
    return options or default_options()


def parse_options_json(value, fallback=None):
    if not value:
        return sanitize_options(fallback)
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return sanitize_options(fallback)
    return sanitize_options(parsed, fallback=fallback)


def menu_text(config):
    lines = [str(config.get("greeting_text") or DEFAULT_GREETING_TEXT).strip(), ""]
    lines.extend(f"{option['key']} - {option['text']}" for option in config.get("options") or default_options())
    return "\n".join(lines).strip()


def account_config_defaults(account_id):
    enabled = TRIAGE_DEFAULT_ENABLED and CHATWOOT_ACCOUNT_ID and int(account_id) == CHATWOOT_ACCOUNT_ID
    options = default_options()
    return {
        "account_id": int(account_id),
        "enabled": bool(enabled),
        "greeting_text": DEFAULT_GREETING_TEXT,
        "invalid_behavior": "route_to_human",
        "options": options,
        "finance_team_id": options[0]["team_id"],
        "support_team_id": options[1]["team_id"],
        "sales_team_id": options[2]["team_id"],
        "human_team_id": options[3]["team_id"],
        "created_at": None,
        "updated_at": None,
    }


def row_to_account_config(row, account_id):
    if not row:
        return account_config_defaults(account_id)
    legacy = {
        "finance_team_id": row[2] or "",
        "support_team_id": row[3] or "",
        "sales_team_id": row[4] or "",
        "human_team_id": row[5] or "",
    }
    options = parse_options_json(row[10] if len(row) > 10 else "", fallback=legacy_options_from_team_ids(legacy))
    return {
        "account_id": int(row[0]),
        "enabled": bool(row[1]),
        "finance_team_id": legacy["finance_team_id"],
        "support_team_id": legacy["support_team_id"],
        "sales_team_id": legacy["sales_team_id"],
        "human_team_id": legacy["human_team_id"],
        "greeting_text": row[8] or DEFAULT_GREETING_TEXT,
        "invalid_behavior": row[9] or "route_to_human",
        "options": options,
        "created_at": row[6],
        "updated_at": row[7],
    }


def get_account_config(account_id):
    with sqlite3.connect(DATABASE_PATH) as conn:
        row = conn.execute(
            """
            SELECT
              account_id,
              enabled,
              finance_team_id,
              support_team_id,
              sales_team_id,
              human_team_id,
              created_at,
              updated_at,
              greeting_text,
              invalid_behavior,
              options_json
            FROM triage_account_configs
            WHERE account_id = ?
            """,
            (account_id,),
        ).fetchone()
    return row_to_account_config(row, account_id)


def save_account_config(account_id, config):
    now = utc_now()
    enabled = 1 if bool(config.get("enabled")) else 0
    options = sanitize_options(config.get("options"), fallback=legacy_options_from_team_ids(config))
    values = {
        "finance_team_id": str(config.get("finance_team_id") or options[0].get("team_id") or "").strip(),
        "support_team_id": str(config.get("support_team_id") or (options[1].get("team_id") if len(options) > 1 else "") or "").strip(),
        "sales_team_id": str(config.get("sales_team_id") or (options[2].get("team_id") if len(options) > 2 else "") or "").strip(),
        "human_team_id": str(config.get("human_team_id") or next((option.get("team_id") for option in options if option.get("label") == "humano"), "") or "").strip(),
        "greeting_text": str(config.get("greeting_text") or DEFAULT_GREETING_TEXT).strip()[:1000],
        "invalid_behavior": "route_to_human",
        "options_json": json.dumps(options, ensure_ascii=False),
    }
    with db_lock, sqlite3.connect(DATABASE_PATH) as conn:
        conn.execute(
            """
            INSERT INTO triage_account_configs
              (account_id, enabled, finance_team_id, support_team_id, sales_team_id, human_team_id, created_at, updated_at, greeting_text, invalid_behavior, options_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
              enabled = excluded.enabled,
              finance_team_id = excluded.finance_team_id,
              support_team_id = excluded.support_team_id,
              sales_team_id = excluded.sales_team_id,
              human_team_id = excluded.human_team_id,
              greeting_text = excluded.greeting_text,
              invalid_behavior = excluded.invalid_behavior,
              options_json = excluded.options_json,
              updated_at = excluded.updated_at
            """,
            (
                account_id,
                enabled,
                values["finance_team_id"],
                values["support_team_id"],
                values["sales_team_id"],
                values["human_team_id"],
                now,
                now,
                values["greeting_text"],
                values["invalid_behavior"],
                values["options_json"],
            ),
        )
        conn.commit()
    team_cache.pop(int(account_id), None)
    return get_account_config(account_id)


def options_for_config(config):
    return {option["key"]: option for option in config.get("options") or default_options()}


def default_options_map():
    return {option["key"]: option for option in default_options()}


def human_option(config):
    options = config.get("options") or default_options()
    for option in options:
        label = str(option.get("label") or "").lower()
        text = str(option.get("text") or "").lower()
        if label == "humano" or "atendente" in text or "humano" in text:
            return option
    return {
        "key": "4",
        "text": "Falar com atendente",
        "label": "humano",
        "team_id": config.get("human_team_id") or "",
        "team_aliases": ["humano", "atendente", "atendimento"],
        "confirmation_text": INVALID_SELECTION_TEXT,
    }


def db_row_to_dict(row):
    if not row:
        return None
    return {
        "conversation_id": row[0],
        "account_id": row[1],
        "state": row[2],
        "attempts": row[3],
        "selected_department": row[4],
        "created_at": row[5],
        "updated_at": row[6],
    }


def get_state(account_id, conversation_id):
    with sqlite3.connect(DATABASE_PATH) as conn:
        row = conn.execute(
            """
            SELECT conversation_id, account_id, state, attempts, selected_department, created_at, updated_at
            FROM triage_conversations
            WHERE account_id = ? AND conversation_id = ?
            """,
            (account_id, conversation_id),
        ).fetchone()
    return db_row_to_dict(row)


def create_waiting_state(account_id, conversation_id):
    now = utc_now()
    with db_lock, sqlite3.connect(DATABASE_PATH) as conn:
        try:
            conn.execute(
                """
                INSERT INTO triage_conversations
                  (conversation_id, account_id, state, attempts, selected_department, created_at, updated_at)
                VALUES (?, ?, ?, 0, NULL, ?, ?)
                """,
                (conversation_id, account_id, STATE_WAITING, now, now),
            )
            conn.commit()
            return True, get_state(account_id, conversation_id)
        except sqlite3.IntegrityError:
            return False, get_state(account_id, conversation_id)


def delete_state(account_id, conversation_id):
    with db_lock, sqlite3.connect(DATABASE_PATH) as conn:
        conn.execute(
            "DELETE FROM triage_conversations WHERE account_id = ? AND conversation_id = ?",
            (account_id, conversation_id),
        )
        conn.commit()


def increment_attempts(account_id, conversation_id):
    now = utc_now()
    with db_lock, sqlite3.connect(DATABASE_PATH) as conn:
        conn.execute(
            """
            UPDATE triage_conversations
            SET attempts = attempts + 1, updated_at = ?
            WHERE account_id = ? AND conversation_id = ?
            """,
            (now, account_id, conversation_id),
        )
        conn.commit()


def complete_state(account_id, conversation_id, department):
    now = utc_now()
    with db_lock, sqlite3.connect(DATABASE_PATH) as conn:
        conn.execute(
            """
            UPDATE triage_conversations
            SET state = ?, selected_department = ?, updated_at = ?
            WHERE account_id = ? AND conversation_id = ?
            """,
            (STATE_COMPLETED, department, now, account_id, conversation_id),
        )
        conn.commit()


def normalize_label(label):
    if isinstance(label, str):
        return label
    if isinstance(label, dict):
        return str(label.get("title") or label.get("name") or label.get("id") or "")
    return ""


def lower_set(values):
    return {str(value).strip().lower() for value in values if str(value).strip()}


def chatwoot_request(method, path, payload=None):
    if not CHATWOOT_API_TOKEN:
        raise RuntimeError("CHATWOOT_API_TOKEN is not configured")

    body = None
    headers = {"api_access_token": CHATWOOT_API_TOKEN}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(
        f"{CHATWOOT_BASE_URL}{path}",
        data=body,
        headers=headers,
        method=method,
    )

    try:
        with urlopen(request, timeout=15) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else {}
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Chatwoot API {method} {path} failed: {error.code} {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Chatwoot API {method} {path} failed: {error.reason}") from error


def extract_payload(data):
    if isinstance(data, dict) and isinstance(data.get("payload"), dict):
        return data["payload"]
    return data


def extract_labels(conversation):
    labels = conversation.get("labels") or conversation.get("label_list") or []
    if isinstance(labels, str):
        labels = [item.strip() for item in labels.split(",")]
    return [normalize_label(label) for label in labels if normalize_label(label)]


def get_conversation(account_id, conversation_id):
    data = chatwoot_request(
        "GET",
        f"/api/v1/accounts/{account_id}/conversations/{conversation_id}",
    )
    payload = extract_payload(data)
    if isinstance(payload.get("conversation"), dict):
        return payload["conversation"]
    return payload


def send_message(account_id, conversation_id, content):
    return chatwoot_request(
        "POST",
        f"/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages",
        {
            "content": content,
            "message_type": "outgoing",
            "private": False,
        },
    )


def add_labels(account_id, conversation_id, current_labels, new_labels):
    for label in new_labels:
        ensure_label(account_id, label)

    merged = []
    seen = set()
    for label in [*current_labels, *new_labels]:
        label = str(label).strip()
        if not label or label.lower() in seen:
            continue
        seen.add(label.lower())
        merged.append(label)

    return chatwoot_request(
        "POST",
        f"/api/v1/accounts/{account_id}/conversations/{conversation_id}/labels",
        {"labels": merged},
    )


def ensure_label(account_id, title):
    title = str(title or "").strip()
    if not title:
        return

    cache_key = (account_id, title.lower())
    if cache_key in label_cache:
        return

    try:
        data = chatwoot_request("GET", f"/api/v1/accounts/{account_id}/labels")
        payload = extract_payload(data)
        labels = payload if isinstance(payload, list) else payload.get("labels", [])
        for label in labels:
            existing = str(label.get("title") or label.get("name") or "").strip().lower()
            if existing == title.lower():
                label_cache[cache_key] = True
                return

        chatwoot_request(
            "POST",
            f"/api/v1/accounts/{account_id}/labels",
            {
                "title": title,
                "description": f"Label automatica de triagem: {title}",
                "color": LABEL_COLORS.get(title.lower(), "#64748b"),
                "show_on_sidebar": True,
            },
        )
        label_cache[cache_key] = True
    except Exception as error:
        print(f"[triage-bot] label ensure skipped for {title}: {error}", flush=True)


def get_team_id(account_id, option):
    raw_team_id = str(option.get("team_id") or "").strip()
    if raw_team_id:
        return int(raw_team_id)

    if account_id in team_cache:
        teams = team_cache[account_id]
    else:
        data = chatwoot_request("GET", f"/api/v1/accounts/{account_id}/teams")
        payload = extract_payload(data)
        teams = payload if isinstance(payload, list) else payload.get("teams", [])
        team_cache[account_id] = teams

    aliases = lower_set(option.get("team_aliases") or [])
    for team in teams:
        name = str(team.get("name") or "").strip().lower()
        if name in aliases:
            return int(team.get("id"))
    return None


def assign_team_if_exists(account_id, conversation_id, option):
    team_id = get_team_id(account_id, option)
    if not team_id:
        return None

    return chatwoot_request(
        "POST",
        f"/api/v1/accounts/{account_id}/conversations/{conversation_id}/assignments",
        {"team_id": team_id},
    )


def is_incoming_message(message):
    message_type = message.get("message_type")
    return message_type in ("incoming", 0, "0")


def is_agent_or_bot_message(message):
    sender_type = str(message.get("sender_type") or "").lower()
    sender = message.get("sender") if isinstance(message.get("sender"), dict) else {}
    sender_kind = str(sender.get("type") or sender.get("sender_type") or "").lower()
    source_id = str(message.get("source_id") or "").lower()
    blocked_types = {"user", "agent", "agentbot", "agent_bot", "bot"}
    if sender_type in blocked_types or sender_kind in blocked_types:
        return True
    return "bot" in source_id


def clean_selection(content, options=None):
    options = options or default_options_map()
    value = str(content or "").strip().lower()
    if not value:
        return ""
    if value[0] in options:
        return value[0]
    return ""


def route_to_human(account_id, conversation_id, current_labels, config):
    option = human_option(config)
    try:
        assign_team_if_exists(account_id, conversation_id, option)
    except Exception as error:
        print(f"[triage-bot] human team assignment skipped: {error}", flush=True)

    label = option.get("label") or "humano"
    send_message(account_id, conversation_id, option.get("confirmation_text") or INVALID_SELECTION_TEXT)
    add_labels(account_id, conversation_id, current_labels, [label, COMPLETED_LABEL])
    complete_state(account_id, conversation_id, option.get("text") or "Falar com atendente")
    return {
        "action": "invalid_selection_routed_to_human",
        "conversation_id": conversation_id,
        "selected_department": option.get("text") or "Falar com atendente",
        "label": label,
    }


def parse_webhook(data):
    message = data.get("message") if isinstance(data.get("message"), dict) else data
    conversation = data.get("conversation") if isinstance(data.get("conversation"), dict) else {}
    if not conversation and isinstance(message.get("conversation"), dict):
        conversation = message["conversation"]

    account = data.get("account") if isinstance(data.get("account"), dict) else {}
    account_id = int(
        account.get("id")
        or conversation.get("account_id")
        or data.get("account_id")
        or CHATWOOT_ACCOUNT_ID
        or 0
    )
    conversation_id = str(
        conversation.get("display_id")
        or conversation.get("id")
        or message.get("conversation_display_id")
        or message.get("conversation_id")
        or ""
    )

    return message, conversation, account_id, conversation_id


def should_ignore(data, config=None):
    event = str(data.get("event") or "").strip()
    if event and event != "message_created":
        return "ignored_event"

    message, conversation, account_id, conversation_id = parse_webhook(data)
    if not account_id or not conversation_id:
        return "missing_conversation"
    if config is not None and not config.get("enabled"):
        return "triage_disabled"
    if message.get("private") is True:
        return "private_message"
    if not is_incoming_message(message):
        return "not_incoming"
    if is_agent_or_bot_message(message):
        return "agent_or_bot_message"
    if not str(message.get("content") or "").strip():
        return "empty_message"

    labels = extract_labels(conversation)
    if COMPLETED_LABEL in lower_set(labels):
        return "triage_already_completed"

    return None


def process_webhook(data):
    _, _, account_id, _ = parse_webhook(data)
    config = get_account_config(account_id) if account_id else None
    ignore_reason = should_ignore(data, config)
    if ignore_reason:
        return {"action": "ignored", "reason": ignore_reason}

    message, conversation, account_id, conversation_id = parse_webhook(data)
    options = options_for_config(config)
    full_conversation = get_conversation(account_id, conversation_id)
    current_labels = extract_labels(full_conversation or conversation)
    if COMPLETED_LABEL in lower_set(current_labels):
        return {"action": "ignored", "reason": "triage_already_completed"}

    created, state = create_waiting_state(account_id, conversation_id)
    if state and state["state"] == STATE_COMPLETED:
        return {"action": "ignored", "reason": "state_completed"}

    if created:
        try:
            send_message(account_id, conversation_id, menu_text(config))
        except Exception:
            delete_state(account_id, conversation_id)
            raise
        return {"action": "menu_sent", "conversation_id": conversation_id}

    selection = clean_selection(message.get("content"), options)
    if not selection:
        increment_attempts(account_id, conversation_id)
        return route_to_human(account_id, conversation_id, current_labels, config)

    option = options[selection]
    try:
        assign_team_if_exists(account_id, conversation_id, option)
    except Exception as error:
        print(f"[triage-bot] team assignment skipped: {error}", flush=True)
    send_message(account_id, conversation_id, option.get("confirmation_text") or f"Perfeito, vou te encaminhar para {option['text']}.")
    add_labels(account_id, conversation_id, current_labels, [option["label"], COMPLETED_LABEL])
    complete_state(account_id, conversation_id, option["text"])

    return {
        "action": "triage_completed",
        "conversation_id": conversation_id,
        "selected_department": option["text"],
        "label": option["label"],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[triage-bot] {self.address_string()} {format % args}", flush=True)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("content-length") or "0")
        return self.rfile.read(length) if length else b"{}"

    def read_json(self, raw_body):
        raw = raw_body.decode("utf-8") if raw_body else "{}"
        return json.loads(raw or "{}")

    def valid_secret(self, raw_body):
        provided_secret = (
            self.headers.get("x-triage-webhook-secret")
            or self.headers.get("x-webhook-secret")
            or ""
        )
        bearer = self.headers.get("authorization") or ""
        if bearer.lower().startswith("bearer "):
            provided_secret = provided_secret or bearer[7:]
        if provided_secret and hmac.compare_digest(provided_secret, TRIAGE_WEBHOOK_SECRET):
            return True

        timestamp = self.headers.get("x-chatwoot-timestamp") or ""
        signature = self.headers.get("x-chatwoot-signature") or ""
        if not timestamp or not signature or not TRIAGE_WEBHOOK_SECRET:
            return False

        body = raw_body.decode("utf-8") if raw_body else "{}"
        expected = "sha256=" + hmac.new(
            TRIAGE_WEBHOOK_SECRET.encode("utf-8"),
            f"{timestamp}.{body}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, signature)

    def valid_admin_token(self):
        provided = self.headers.get("x-triage-admin-token") or ""
        bearer = self.headers.get("authorization") or ""
        if bearer.lower().startswith("bearer "):
            provided = provided or bearer[7:]
        return bool(TRIAGE_ADMIN_TOKEN and provided and hmac.compare_digest(provided, TRIAGE_ADMIN_TOKEN))

    def admin_account_id(self, path):
        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["admin", "accounts"] and parts[3] == "config":
            try:
                return int(parts[2])
            except ValueError:
                return None
        return None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            missing = [
                name
                for name, value in {
                    "CHATWOOT_API_TOKEN": CHATWOOT_API_TOKEN,
                    "TRIAGE_WEBHOOK_SECRET": TRIAGE_WEBHOOK_SECRET,
                }.items()
                if not value
            ]
            self.send_json(200, {"ok": not missing, "missing": missing})
            return

        account_id = self.admin_account_id(path)
        if account_id:
            if not self.valid_admin_token():
                self.send_json(401, {"error": "invalid_admin_token"})
                return
            self.send_json(200, get_account_config(account_id))
            return

        self.send_json(404, {"error": "not_found"})

    def do_PUT(self):
        path = urlparse(self.path).path
        account_id = self.admin_account_id(path)
        if not account_id:
            self.send_json(404, {"error": "not_found"})
            return
        if not self.valid_admin_token():
            self.send_json(401, {"error": "invalid_admin_token"})
            return

        try:
            payload = self.read_json(self.read_body())
            config = save_account_config(account_id, payload)
            self.send_json(200, config)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "invalid_json"})
        except Exception as error:
            self.send_json(500, {"error": "save_config_failed", "detail": str(error)})

    def do_POST(self):
        if urlparse(self.path).path != "/webhook/chatwoot":
            self.send_json(404, {"error": "not_found"})
            return

        raw_body = self.read_body()
        if not TRIAGE_WEBHOOK_SECRET or not self.valid_secret(raw_body):
            self.send_json(401, {"error": "invalid_webhook_secret"})
            return

        try:
            payload = self.read_json(raw_body)
            result = process_webhook(payload)
            self.send_json(200, result)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "invalid_json"})
        except Exception as error:
            print(f"[triage-bot] webhook failed: {error}", flush=True)
            self.send_json(500, {"error": "webhook_processing_failed", "detail": str(error)})


def main():
    ensure_database()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[triage-bot] listening on {PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
