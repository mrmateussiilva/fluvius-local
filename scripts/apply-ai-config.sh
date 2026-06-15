#!/usr/bin/env bash
set -euo pipefail

dotenv_value() {
  local key="$1"
  if [[ -f .env ]]; then
    grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- || true
  fi
}

provider="${1:-${CAPTAIN_PROVIDER:-$(dotenv_value CAPTAIN_PROVIDER)}}"
provider="${provider:-openai}"

case "${provider}" in
  openai)
    api_key="${OPENAI_API_KEY:-${CAPTAIN_OPEN_AI_API_KEY:-$(dotenv_value OPENAI_API_KEY)}}"
    model="${CAPTAIN_OPEN_AI_MODEL:-$(dotenv_value CAPTAIN_OPEN_AI_MODEL)}"
    endpoint="${CAPTAIN_OPEN_AI_ENDPOINT:-$(dotenv_value CAPTAIN_OPEN_AI_ENDPOINT)}"
    model="${model:-gpt-4.1-mini}"
    endpoint="${endpoint:-https://api.openai.com}"
    ;;
  gemini)
    api_key="${GEMINI_API_KEY:-${CAPTAIN_OPEN_AI_API_KEY:-$(dotenv_value GEMINI_API_KEY)}}"
    model="${CAPTAIN_GEMINI_MODEL:-$(dotenv_value CAPTAIN_GEMINI_MODEL)}"
    endpoint="${CAPTAIN_GEMINI_ENDPOINT:-$(dotenv_value CAPTAIN_GEMINI_ENDPOINT)}"
    model="${model:-gemini-2.5-flash}"
    endpoint="${endpoint:-https://generativelanguage.googleapis.com/v1beta/openai}"
    ;;
  *)
    echo "Unsupported provider: ${provider}" >&2
    echo "Use: openai or gemini" >&2
    exit 1
    ;;
esac

if [[ -z "${api_key}" ]]; then
  echo "Missing API key for ${provider}." >&2
  echo "Set OPENAI_API_KEY=... or GEMINI_API_KEY=... in .env, then run this script again." >&2
  exit 1
fi

echo "Applying Captain AI config for provider=${provider}, model=${model}, endpoint=${endpoint}"

docker compose exec -T chatwoot env \
  CAPTAIN_PROVIDER_VALUE="${provider}" \
  CAPTAIN_API_KEY_VALUE="${api_key}" \
  CAPTAIN_MODEL_VALUE="${model}" \
  CAPTAIN_ENDPOINT_VALUE="${endpoint}" \
  bundle exec rails runner "
    {
      'CAPTAIN_OPEN_AI_API_KEY' => ENV.fetch('CAPTAIN_API_KEY_VALUE'),
      'CAPTAIN_OPEN_AI_MODEL' => ENV.fetch('CAPTAIN_MODEL_VALUE'),
      'CAPTAIN_OPEN_AI_ENDPOINT' => ENV.fetch('CAPTAIN_ENDPOINT_VALUE')
    }.each do |name, value|
      config = InstallationConfig.where(name: name).first_or_initialize
      config.value = value
      config.locked = false
      config.save!
    end

    GlobalConfig.clear_cache
    puts \"Captain AI configured for #{ENV.fetch('CAPTAIN_PROVIDER_VALUE')} / #{ENV.fetch('CAPTAIN_MODEL_VALUE')}\"
  "

echo "Restarting Fluvius and Sidekiq so AI settings are loaded..."
docker compose restart chatwoot sidekiq

echo "Done."
