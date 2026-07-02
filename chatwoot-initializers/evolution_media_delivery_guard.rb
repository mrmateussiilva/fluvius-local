# Hardens outbound media delivery from Chatwoot API inboxes to Evolution.
#
# Evolution receives agent replies through the API inbox webhook. For messages
# with attachments, the generated ActiveStorage URL must be reachable by the
# Evolution container, and a provider error must not leave the message looking
# successfully sent in Chatwoot.
module FluviusEvolutionMediaDeliveryGuard
  module_function

  ERROR_KEYS = %w[error errors exception].freeze
  FAILURE_STATUS_VALUES = %w[error failed failure false].freeze
  ID_KEYS = %w[messageId message_id keyId key_id wamid].freeze
  TOKEN_KEYS = %w[token access_token api_key apikey key signature].freeze

  def evolution_webhook?(url, webhook_type)
    webhook_type.to_s == 'api_inbox_webhook' && url.to_s.include?('/chatwoot/webhook/')
  end

  def message_id(payload)
    value(payload, :id)
  end

  def value(hash, key)
    return unless hash.respond_to?(:key?)

    return hash[key] if hash.key?(key)

    string_key = key.to_s
    return hash[string_key] if hash.key?(string_key)

    nil
  end

  def media_base_url
    ENV['FLUVIUS_EVOLUTION_MEDIA_BASE_URL'].presence || ENV['CHATWOOT_INTERNAL_URL'].presence
  end

  def with_public_media_urls(payload, message)
    return payload unless message&.attachments&.any?

    duplicated = deep_dup(payload)
    attachments_payload = value(duplicated, :attachments)
    return duplicated unless attachments_payload.is_a?(Array)

    attachments_by_id = message.attachments.index_by(&:id)
    attachments_payload.each do |attachment_payload|
      next unless attachment_payload.is_a?(Hash)

      attachment = attachments_by_id[value(attachment_payload, :id).to_i]
      next unless attachment&.file&.attached?

      url = accessible_attachment_url(attachment)
      attachment_payload[:data_url] = url
      attachment_payload['data_url'] = url

      if attachment.image?
        attachment_payload[:thumb_url] = url
        attachment_payload['thumb_url'] = url
      end
    end

    duplicated
  end

  def accessible_attachment_url(attachment)
    url = attachment.download_url.presence || attachment.file_url
    rewrite_url_host(url)
  end

  def rewrite_url_host(url)
    base = media_base_url
    return url if url.blank? || base.blank?

    uri = URI.parse(url)
    base_uri = URI.parse(base)
    uri.scheme = base_uri.scheme
    uri.host = base_uri.host
    uri.port = base_uri.port
    uri.to_s
  rescue URI::InvalidURIError
    url
  end

  def log_attempt(url, payload, message)
    each_attachment(message) do |attachment|
      Rails.logger.info(
        '[fluvius-evolution-media] send_attempt ' \
        "#{message_context(message)} " \
        "attachment_id=#{attachment.id} media_type=#{attachment.file_type} " \
        "mime_type=#{attachment_mime(attachment)} file_size=#{attachment_size(attachment)} " \
        "media_url=#{mask_url(attachment_payload_url(payload, attachment.id))} " \
        "evolution_endpoint=#{mask_url(url)}",
      )
    end
  end

  def log_response(url, payload, message, status, body)
    each_attachment(message) do |attachment|
      Rails.logger.info(
        '[fluvius-evolution-media] send_response ' \
        "#{message_context(message)} " \
        "attachment_id=#{attachment.id} media_type=#{attachment.file_type} " \
        "mime_type=#{attachment_mime(attachment)} file_size=#{attachment_size(attachment)} " \
        "media_url=#{mask_url(attachment_payload_url(payload, attachment.id))} " \
        "evolution_endpoint=#{mask_url(url)} http_status=#{status} " \
        "response_body=#{summarize_body(body)} external_message_id=#{message.source_id.presence || '-'}",
      )
    end
  end

  def log_failure(url, payload, message, error)
    each_attachment(message) do |attachment|
      Rails.logger.error(
        '[fluvius-evolution-media] send_failure ' \
        "#{message_context(message)} " \
        "attachment_id=#{attachment.id} media_type=#{attachment.file_type} " \
        "mime_type=#{attachment_mime(attachment)} file_size=#{attachment_size(attachment)} " \
        "media_url=#{mask_url(attachment_payload_url(payload, attachment.id))} " \
        "evolution_endpoint=#{mask_url(url)} error_class=#{error.class.name} " \
        "error_message=#{error.message} backtrace=#{Array(error.backtrace).first(8).join(' | ')}",
      )
    end
  end

  def validate_response!(body)
    parsed = parse_json(body)
    return unless parsed

    error = response_error(parsed)
    raise SafeFetch::HttpError, "Evolution response error: #{error}" if error.present?
  end

  def response_error(value)
    case value
    when Hash
      direct_error = ERROR_KEYS.filter_map { |key| self.value(value, key) || self.value(value, key.to_sym) }.first
      return direct_error if direct_error.present?

      status = self.value(value, :status)
      status = self.value(value, :success) if status.nil?
      return "status=#{status}" if FAILURE_STATUS_VALUES.include?(status.to_s.downcase)

      value.each_value do |nested|
        nested_error = response_error(nested)
        return nested_error if nested_error.present?
      end
    when Array
      value.each do |nested|
        nested_error = response_error(nested)
        return nested_error if nested_error.present?
      end
    end

    nil
  end

  def external_message_id(body)
    parsed = parse_json(body)
    return unless parsed

    find_external_id(parsed)
  end

  def find_external_id(value)
    case value
    when Hash
      ID_KEYS.each do |key|
        found = self.value(value, key) || self.value(value, key.to_sym)
        return found if found.present? && found.to_s.length >= 8
      end

      key_id = value.dig('key', 'id') || value.dig(:key, :id)
      return key_id if key_id.present?

      value.each_value do |nested|
        found = find_external_id(nested)
        return found if found.present?
      end
    when Array
      value.each do |nested|
        found = find_external_id(nested)
        return found if found.present?
      end
    end

    nil
  end

  def mark_failed(message, error)
    return unless message

    Messages::StatusUpdateService.new(message, 'failed', user_error(error)).perform
  end

  def user_error(error)
    return 'Falha ao enviar imagem.' if error.message.blank?

    "Falha ao enviar imagem. #{error.message.to_s.truncate(180)}"
  end

  def save_external_id(message, external_id)
    return if message.blank? || external_id.blank? || message.source_id.present?

    message.update!(source_id: external_id.to_s)
  end

  def message_context(message)
    "account_id=#{message.account_id} inbox_id=#{message.inbox_id} " \
      "conversation_id=#{message.conversation_id} message_id=#{message.id}"
  end

  def each_attachment(message, &block)
    return enum_for(:each_attachment, message) unless block
    return if message.blank?

    message.attachments.each(&block)
  end

  def attachment_mime(attachment)
    attachment.file&.content_type.presence || '-'
  end

  def attachment_size(attachment)
    attachment.file&.byte_size || 0
  end

  def attachment_payload_url(payload, attachment_id)
    attachments_payload = value(payload, :attachments)
    return '-' unless attachments_payload.is_a?(Array)

    attachment_payload = attachments_payload.find { |item| value(item, :id).to_i == attachment_id.to_i }
    value(attachment_payload || {}, :data_url).presence || '-'
  end

  def mask_url(url)
    return '-' if url.blank?

    uri = URI.parse(url)
    query = Rack::Utils.parse_nested_query(uri.query).transform_keys(&:to_s)
    query.each_key { |key| query[key] = '[FILTERED]' if sensitive_key?(key) }
    uri.query = query.presence&.to_query
    uri.to_s
  rescue StandardError
    url.to_s.gsub(/(token|access_token|api_key|apikey|key|signature)=([^&\s]+)/i, '\1=[FILTERED]')
  end

  def sensitive_key?(key)
    TOKEN_KEYS.any? { |token_key| key.downcase.include?(token_key) }
  end

  def summarize_body(body)
    return '-' if body.blank?

    body.to_s.squish.truncate(700)
  end

  def parse_json(body)
    return if body.blank?

    JSON.parse(body)
  rescue JSON::ParserError
    nil
  end

  def deep_dup(value)
    Marshal.load(Marshal.dump(value))
  end
end

module FluviusEvolutionWebhookRequestGuard
  private

  def perform_request
    return super unless FluviusEvolutionMediaDeliveryGuard.evolution_webhook?(@url, @webhook_type)

    guarded_message = message
    guarded_payload = FluviusEvolutionMediaDeliveryGuard.with_public_media_urls(@payload, guarded_message)
    body = guarded_payload.to_json

    FluviusEvolutionMediaDeliveryGuard.log_attempt(@url, guarded_payload, guarded_message)

    response_body = nil
    SafeFetch.fetch(
      @url,
      method: :post,
      body: body,
      headers: request_headers(body),
      open_timeout: webhook_timeout,
      read_timeout: webhook_timeout,
      validate_content_type: false
    ) do |response|
      response_body = response.tempfile.read
    end

    FluviusEvolutionMediaDeliveryGuard.validate_response!(response_body)
    FluviusEvolutionMediaDeliveryGuard.save_external_id(
      guarded_message,
      FluviusEvolutionMediaDeliveryGuard.external_message_id(response_body),
    )
    FluviusEvolutionMediaDeliveryGuard.log_response(@url, guarded_payload, guarded_message, 200, response_body)
  rescue StandardError => e
    FluviusEvolutionMediaDeliveryGuard.log_failure(@url, guarded_payload || @payload, guarded_message, e)
    FluviusEvolutionMediaDeliveryGuard.mark_failed(guarded_message, e)
    raise
  end
end

Rails.application.config.after_initialize do
  unless Webhooks::Trigger.ancestors.include?(FluviusEvolutionWebhookRequestGuard)
    Webhooks::Trigger.prepend(FluviusEvolutionWebhookRequestGuard)
  end
end
