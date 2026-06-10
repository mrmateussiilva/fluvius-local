#!/usr/bin/env bash
set -euo pipefail

BRAND_NAME="${BRAND_NAME:-Fluvius}"
BRAND_URL="${BRAND_URL:-http://localhost:3000}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

docker compose -f "$COMPOSE_FILE" exec -T chatwoot bundle exec rails runner "
  brand_name = ENV.fetch('BRAND_NAME', '${BRAND_NAME}')
  brand_url = ENV.fetch('BRAND_URL', '${BRAND_URL}')

  dashboard_scripts = <<~HTML
    <style id=\"fluvius-brand-theme\">
      :root {
        --blue-1: 247 254 249;
        --blue-2: 240 253 244;
        --blue-3: 220 252 231;
        --blue-4: 187 247 208;
        --blue-5: 134 239 172;
        --blue-6: 74 222 128;
        --blue-7: 34 197 94;
        --blue-8: 22 163 74;
        --blue-9: 21 128 61;
        --blue-10: 22 101 52;
        --blue-11: 21 128 61;
        --blue-12: 5 46 28;
        --border-blue: 21, 128, 61, 0.5;
        --border-blue-strong: 22 101 52;
        --text-blue: 5 46 28;
        --solid-blue: 220 252 231;
        --solid-blue-2: 247 254 249;
      }

      body.dark {
        --blue-1: 2 20 12;
        --blue-2: 5 46 28;
        --blue-3: 6 78 45;
        --blue-4: 20 83 45;
        --blue-5: 22 101 52;
        --blue-6: 21 128 61;
        --blue-7: 22 163 74;
        --blue-8: 34 197 94;
        --blue-9: 74 222 128;
        --blue-10: 134 239 172;
        --blue-11: 187 247 208;
        --blue-12: 220 252 231;
        --border-blue: 74, 222, 128, 0.45;
        --border-blue-strong: 134 239 172;
        --text-blue: 220 252 231;
        --solid-blue: 5 46 28;
        --solid-blue-2: 2 20 12;
      }

      .banner.primary {
        background-color: #15803d !important;
      }

    </style>
    <script id=\"fluvius-internal-chat-script\">
      (() => {
        function cleanupInternalChat() {
          [
            'fluvius-internal-chat-button',
            'fluvius-internal-chat-backdrop',
            'fluvius-internal-chat-panel',
            'fluvius-internal-chat-launcher',
            'fluvius-internal-chat-dock',
            'fluvius-internal-chat-nav',
            'fluvius-internal-chat-view',
          ].forEach(id => document.getElementById(id)?.remove());
          document.body.classList.remove('fluvius-internal-chat-open');
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', cleanupInternalChat);
        } else {
          cleanupInternalChat();
        }

        setInterval(cleanupInternalChat, 2000);
      })();
    </script>
  HTML

  {
    'INSTALLATION_NAME' => brand_name,
    'BRAND_NAME' => brand_name,
    'BRAND_URL' => brand_url,
    'WIDGET_BRAND_URL' => brand_url,
    'LOGO' => '/brand-assets/logo.svg',
    'LOGO_DARK' => '/brand-assets/logo_dark.svg',
    'LOGO_THUMBNAIL' => '/brand-assets/logo_thumbnail.svg',
    'DASHBOARD_SCRIPTS' => dashboard_scripts
  }.each do |name, value|
    config = InstallationConfig.where(name: name).first_or_initialize
    config.value = value
    config.locked = false
    config.save!
  end

  GlobalConfig.clear_cache
  puts \"Applied #{brand_name} branding\"
"
