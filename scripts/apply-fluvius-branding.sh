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
        --fluvius-ink: #052e1c;
        --fluvius-ink-2: #0f3f2a;
        --fluvius-green: #16a34a;
        --fluvius-green-2: #22c55e;
        --fluvius-mint: #dcfce7;
        --fluvius-mint-2: #ecfdf5;
        --fluvius-paper: #f6fbf7;
        --fluvius-line: #c7ead2;
        --fluvius-shadow: 0 18px 44px rgba(5, 46, 28, 0.12);
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

      body:not(.dark) {
        background:
          radial-gradient(circle at top left, rgba(34, 197, 94, 0.14), transparent 32rem),
          linear-gradient(180deg, #f6fbf7 0%, #eef8f1 100%);
      }

      body.dark {
        background:
          radial-gradient(circle at top left, rgba(34, 197, 94, 0.16), transparent 32rem),
          #02140c;
      }

      a[href*='chatwoot.com'],
      a[href*='www.chatwoot.com'],
      [data-testid='sidebar-changelog-card'],
      .sidebar-changelog-card {
        display: none !important;
      }

      .woot-logo,
      img[alt='Fluvius'],
      img[alt='chatwoot'] {
        content: url('/brand-assets/logo.svg') !important;
        object-fit: contain;
      }

      body.dark .woot-logo,
      body.dark img[alt='Fluvius'],
      body.dark img[alt='chatwoot'] {
        content: url('/brand-assets/logo_dark.svg') !important;
      }

      button[type='submit'],
      .button.primary,
      .btn.primary,
      .bg-woot-500,
      .bg-blue-500,
      .bg-n-brand,
      .bg-n-blue-9 {
        background-color: var(--fluvius-green) !important;
        border-color: var(--fluvius-green) !important;
      }

      button[type='submit']:hover,
      .button.primary:hover,
      .btn.primary:hover {
        background-color: #15803d !important;
        border-color: #15803d !important;
      }

      input:focus,
      textarea:focus,
      select:focus {
        border-color: var(--fluvius-green) !important;
        box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.16) !important;
      }

      [class*='sidebar'] {
        --color-sidebar-background: 5 46 28;
      }

      aside,
      nav[aria-label='Main navigation'] {
        scrollbar-color: rgba(134, 239, 172, 0.55) transparent;
      }

      aside [role='button'],
      aside a,
      nav[aria-label='Main navigation'] a {
        border-radius: 8px !important;
      }

      aside a.router-link-active,
      aside a[aria-current='page'],
      nav[aria-label='Main navigation'] a.router-link-active,
      nav[aria-label='Main navigation'] a[aria-current='page'] {
        background: rgba(220, 252, 231, 0.16) !important;
        color: #ecfdf5 !important;
      }

      .login-page,
      [class*='login'],
      [class*='Login'] {
        --fluvius-login-panel: rgba(255, 255, 255, 0.94);
      }

      .login-page::before,
      body:has(form[action*='auth'])::before {
        content: 'Fluvius';
        position: fixed;
        top: 32px;
        left: 32px;
        z-index: 0;
        color: var(--fluvius-ink);
        font-size: 18px;
        font-weight: 800;
        letter-spacing: 0;
      }

      body:has(form[action*='auth']) {
        background:
          linear-gradient(120deg, rgba(5, 46, 28, 0.92), rgba(15, 63, 42, 0.82)),
          radial-gradient(circle at 72% 22%, rgba(134, 239, 172, 0.45), transparent 24rem),
          var(--fluvius-paper) !important;
      }

      body:has(form[action*='auth']) main,
      body:has(form[action*='auth']) .auth,
      body:has(form[action*='auth']) [class*='auth'] {
        position: relative;
      }

      body:has(form[action*='auth']) form {
        border: 1px solid rgba(199, 234, 210, 0.82) !important;
        border-radius: 16px !important;
        background: rgba(255, 255, 255, 0.96) !important;
        box-shadow: var(--fluvius-shadow) !important;
      }

      body:has(form[action*='auth']) h1,
      body:has(form[action*='auth']) h2 {
        color: var(--fluvius-ink) !important;
        letter-spacing: 0 !important;
      }

      .fluvius-brand-mark {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-height: 36px;
        color: var(--fluvius-ink);
        font-weight: 800;
      }

      .fluvius-brand-mark::before {
        content: '';
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: url('/brand-assets/logo_thumbnail.svg') center / cover no-repeat;
        box-shadow: 0 8px 22px rgba(5, 46, 28, 0.2);
      }

      .conversation--container,
      .conversation-details-wrap,
      .contact--profile,
      [class*='conversation'] [class*='header'] {
        border-color: rgba(199, 234, 210, 0.75) !important;
      }

      .message--bubble,
      [class*='message'] [class*='bubble'] {
        border-radius: 8px !important;
      }

      .label,
      .badge,
      [class*='badge'] {
        letter-spacing: 0 !important;
      }

    </style>
    <script id=\"fluvius-internal-chat-script\">
      (() => {
        const brandName = #{brand_name.to_json};

        function applyFluviusIdentity() {
          if (document.title && /chatwoot/i.test(document.title)) {
            document.title = document.title.replace(/chatwoot/ig, brandName);
          }

          const selectors = [
            'img[alt=\"Fluvius\"]',
            'img[alt=\"chatwoot\"]',
            '.woot-logo'
          ];

          selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(element => {
              if (element.tagName === 'IMG') {
                element.src = '/brand-assets/logo.svg';
                element.alt = brandName;
              }
            });
          });

          document.querySelectorAll('a, span, p, small, h1, h2, h3, button').forEach(element => {
            if (!element.childElementCount && /chatwoot/i.test(element.textContent || '')) {
              element.textContent = element.textContent.replace(/chatwoot/ig, brandName);
            }
          });
        }

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

        function boot() {
          applyFluviusIdentity();
          cleanupInternalChat();
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', boot);
        } else {
          boot();
        }

        setInterval(boot, 2000);
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
