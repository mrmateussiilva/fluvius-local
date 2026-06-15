# Keeps the visible installation identity aligned with the Fluvius brand.
Rails.application.config.after_initialize do
  next unless defined?(InstallationConfig)

  {
    'INSTALLATION_NAME' => 'Fluvius',
    'BRAND_NAME' => 'Fluvius',
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
