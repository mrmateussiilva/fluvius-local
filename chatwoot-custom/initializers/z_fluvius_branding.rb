# Keeps the visible installation identity aligned with the Fluvius brand.
# Injects branding via CUSTOM_DASHBOARD_SCRIPT (CSS + JS) loaded in every page.
Rails.application.config.after_initialize do
  next unless defined?(InstallationConfig)

  custom_script = <<~HTML
    <style id="fluvius-brand-css">
      :root {
        --fluvius-green: #22c55e;
        --fluvius-green-dark: #15803d;
        --fluvius-ink: #052e1c;
        --fluvius-paper: #f6fbf7;
        --fluvius-shadow: 0 8px 32px rgba(5,46,28,0.18);
        --color-woot-800: 5 46 28;
        --color-woot-700: 21 128 61;
        --color-woot-600: 22 163 74;
        --color-woot-500: 34 197 94;
        --color-woot-400: 74 222 128;
        --color-woot-300: 134 239 172;
        --color-woot-200: 187 247 208;
        --color-woot-100: 220 252 231;
        --color-woot-50:  240 253 244;
        --color-woot-25:  247 254 249;
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
      }

      /* ---- Cores primárias ---- */
      .bg-woot-500, [class*="bg-n-brand"], [class*="bg-n-blue-9"] {
        background-color: #22c55e !important;
      }
      .text-woot-500, [class*="text-n-brand"], [class*="text-n-blue-9"] {
        color: #22c55e !important;
      }
      .border-woot-500, [class*="border-n-brand"] {
        border-color: #22c55e !important;
      }

      /* Botões primários */
      button[type="submit"]:not(:disabled),
      .button.primary:not(:disabled),
      .btn.primary:not(:disabled) {
        background-color: #22c55e !important;
        border-color: #22c55e !important;
        color: #052e1c !important;
      }
      button[type="submit"]:hover:not(:disabled),
      .button.primary:hover:not(:disabled) {
        background-color: #15803d !important;
        border-color: #15803d !important;
      }

      /* Inputs com foco */
      input:focus, textarea:focus, select:focus {
        border-color: #22c55e !important;
        box-shadow: 0 0 0 2px rgba(34,197,94,0.2) !important;
        outline: none !important;
      }

      /* Sidebar escura */
      aside, .sidebar, [class*="sidebar-wrap"] {
        background-color: #052e1c !important;
      }
      .sidebar-item--active, [class*="sidebar"] a[aria-current="page"],
      [class*="sidebar"] a.router-link-active {
        background: rgba(34,197,94,0.18) !important;
        color: #ecfdf5 !important;
      }

      /* Favicon / logo via CSS content */
      .woot-logo,
      img[alt="Chatwoot"], img[alt="chatwoot"],
      img[src*="chatwoot-logo"], img[src*="chatwoot_logo"] {
        content: url("/brand-assets/logo.png") !important;
      }
      body.dark .woot-logo,
      body.dark img[alt="Chatwoot"], body.dark img[alt="chatwoot"] {
        content: url("/brand-assets/logo_dark.png") !important;
      }

      /* Esconder links do Chatwoot externo */
      a[href*="chatwoot.com"],
      [data-testid="sidebar-changelog-card"],
      .sidebar-changelog-card {
        display: none !important;
      }

      /* Tela de login */
      body:has(form[action*="auth"]),
      .login-container, [class*="login-page"] {
        background: linear-gradient(120deg, rgba(5,46,28,0.95), rgba(15,63,42,0.88)),
                    radial-gradient(circle at 70% 20%, rgba(74,222,128,0.4), transparent 28rem) !important;
      }
      body:has(form[action*="auth"]) form,
      .login-container form, [class*="login-page"] form {
        background: rgba(255,255,255,0.97) !important;
        border: 1px solid rgba(187,247,208,0.8) !important;
        border-radius: 16px !important;
        box-shadow: 0 16px 48px rgba(5,46,28,0.25) !important;
      }
    </style>

    <script id="fluvius-identity-js">
      (function() {
        var BRAND = "Fluvius";

        function applyIdentity() {
          /* Título da aba */
          if (document.title && /chatwoot/i.test(document.title)) {
            document.title = document.title.replace(/chatwoot/gi, BRAND);
          }

          /* Logos */
          document.querySelectorAll('img[alt="Chatwoot"], img[alt="chatwoot"], .woot-logo, img[src*="chatwoot"]').forEach(function(el) {
            el.src = document.body.classList.contains("dark")
              ? "/brand-assets/logo_dark.png"
              : "/brand-assets/logo.png";
            el.alt = BRAND;
          });

          /* Textos visíveis com "Chatwoot" */
          document.querySelectorAll("h1,h2,h3,h4,p,span,a,label,button,small,title").forEach(function(el) {
            if (!el.childElementCount && /chatwoot/i.test(el.textContent || "")) {
              el.textContent = el.textContent.replace(/chatwoot/gi, BRAND);
            }
          });

          /* Favicon dinâmico */
          var favicon = document.querySelector("link[rel*='icon']");
          if (favicon && !/brand-assets/.test(favicon.href)) {
            favicon.href = "/brand-assets/logo_thumbnail.png";
          }
        }

        /* Roda na carga e depois a cada 1.5s para cobrir SSR e rotas SPA */
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", applyIdentity);
        } else {
          applyIdentity();
        }
        setInterval(applyIdentity, 1500);
      })();
    </script>
  HTML

  {
    'INSTALLATION_NAME' => 'Fluvius',
    'BRAND_NAME'        => 'Fluvius',
    'LOGO'              => '/brand-assets/logo.png',
    'LOGO_DARK'         => '/brand-assets/logo_dark.png',
    'LOGO_THUMBNAIL'    => '/brand-assets/logo_thumbnail.png',
    'CUSTOM_DASHBOARD_SCRIPT' => custom_script.strip,
  }.each do |name, value|
    config = InstallationConfig.where(name: name).first_or_initialize
    config.value = value
    config.locked = false if config.respond_to?(:locked=)
    config.save! if config.changed?
  end

  GlobalConfig.clear_cache if defined?(GlobalConfig)
rescue StandardError => e
  Rails.logger.error "Failed to apply Fluvius branding config: #{e.message}"
end
