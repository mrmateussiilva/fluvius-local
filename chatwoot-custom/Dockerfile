FROM chatwoot/chatwoot:latest

ARG VITE_INTERNAL_CHAT_API_URL=http://localhost:4000
ENV VITE_INTERNAL_CHAT_API_URL=${VITE_INTERNAL_CHAT_API_URL}

COPY overrides/ /app/

# Embutir os initializers diretamente na imagem (sem depender de volume mount na VPS)
COPY initializers/ /app/config/initializers/

RUN apk add --no-cache npm && \
    npm install -g pnpm@10.2.0 && \
    pnpm install --frozen-lockfile && \
    find app/javascript -type f -name "*.json" -exec sed -i 's/[Cc]hatwoot/Fluvius/g' {} + && \
    find app/javascript -type f -name "*.json" -exec sed -i 's/chatwoot/fluvius/g' {} + && \
    find config/locales -type f -name "*.yml" -exec sed -i 's/[Cc]hatwoot/Fluvius/g' {} + && \
    find config/locales -type f -name "*.yml" -exec sed -i 's/chatwoot/fluvius/g' {} + && \
    NODE_OPTIONS="--max-old-space-size=4096" SECRET_KEY_BASE=fluvius_assets_precompile RAILS_ENV=production bundle exec rails assets:precompile
