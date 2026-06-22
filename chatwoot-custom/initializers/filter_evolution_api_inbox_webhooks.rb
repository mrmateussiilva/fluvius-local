# Keep Evolution API inbox queues focused on outbound messages.
#
# Chatwoot emits API inbox webhooks for many events. Evolution only needs the
# agent-created outbound message event to send WhatsApp messages. Letting
# incoming/message_updated/conversation_updated events reach WebhookJob can
# flood the medium Sidekiq queue and delay real outbound delivery.
module FluviusEvolutionApiInboxWebhookFilter
  module_function

  def enabled?
    ENV.fetch('FLUVIUS_FILTER_EVOLUTION_WEBHOOKS', 'true') != 'false'
  end

  def api_inbox_webhook?(webhook_type)
    webhook_type.to_s == 'api_inbox_webhook'
  end

  def evolution_webhook_url?(url)
    url.to_s.include?('/chatwoot/webhook/')
  end

  def value(payload, key)
    return payload[key] if payload.respond_to?(:key?) && payload.key?(key)

    string_key = key.to_s
    return payload[string_key] if payload.respond_to?(:key?) && payload.key?(string_key)

    nil
  end

  def allowed?(url, payload, webhook_type)
    return true unless enabled?
    return true unless api_inbox_webhook?(webhook_type)
    return true unless evolution_webhook_url?(url)

    value(payload, :event).to_s == 'message_created' &&
      value(payload, :message_type).to_s == 'outgoing'
  end

  def describe(payload)
    "#{value(payload, :event) || 'unknown'}:#{value(payload, :message_type) || 'unknown'}"
  end
end

module FluviusWebhookJobEnqueueFilter
  def perform_later(*args, **kwargs, &block)
    url = args[0]
    payload = args[1] || {}
    webhook_type = args[2] || :account_webhook

    unless FluviusEvolutionApiInboxWebhookFilter.allowed?(url, payload, webhook_type)
      Rails.logger.info(
        "[fluvius-webhook-filter] dropped enqueue #{FluviusEvolutionApiInboxWebhookFilter.describe(payload)} #{url}",
      )
      return false
    end

    super
  end
end

module FluviusWebhookJobPerformFilter
  def perform(url, payload, webhook_type = :account_webhook, *args, **kwargs)
    unless FluviusEvolutionApiInboxWebhookFilter.allowed?(url, payload || {}, webhook_type)
      Rails.logger.info(
        "[fluvius-webhook-filter] skipped perform #{FluviusEvolutionApiInboxWebhookFilter.describe(payload || {})} #{url}",
      )
      return
    end

    super
  end
end

Rails.application.config.after_initialize do
  unless WebhookJob.singleton_class.ancestors.include?(FluviusWebhookJobEnqueueFilter)
    WebhookJob.singleton_class.prepend(FluviusWebhookJobEnqueueFilter)
  end

  unless WebhookJob.ancestors.include?(FluviusWebhookJobPerformFilter)
    WebhookJob.prepend(FluviusWebhookJobPerformFilter)
  end
end
