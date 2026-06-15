# Allows local Fluvius to use OpenAI-compatible providers whose base URL
# already includes the OpenAI compatibility path, such as Gemini.
Rails.application.config.after_initialize do
  require 'agents'

  api_key = InstallationConfig.find_by(name: 'CAPTAIN_OPEN_AI_API_KEY')&.value
  model = InstallationConfig.find_by(name: 'CAPTAIN_OPEN_AI_MODEL')&.value.presence || LlmConstants::DEFAULT_MODEL
  api_endpoint = InstallationConfig.find_by(name: 'CAPTAIN_OPEN_AI_ENDPOINT')&.value.presence || LlmConstants::OPENAI_API_ENDPOINT

  next if api_key.blank?

  api_base = api_endpoint.chomp('/')
  api_base = "#{api_base}/v1" unless api_base.include?('/openai')

  if defined?(Llm::Config) && Llm::Config.const_defined?(:DEFAULT_MODEL, false)
    Llm::Config.send(:remove_const, :DEFAULT_MODEL)
    Llm::Config.const_set(:DEFAULT_MODEL, model.freeze)
  end

  [Captain::BaseTaskService, Integrations::LlmBaseService].each do |klass|
    klass.send(:remove_const, :GPT_MODEL) if klass.const_defined?(:GPT_MODEL, false)
    klass.const_set(:GPT_MODEL, model.freeze)
  end

  if defined?(Llm::Config)
    Llm::Config.singleton_class.class_eval do
      define_method(:fluvius_gemini_base) do |base|
        base = base.to_s.chomp('/')
        base = 'https://generativelanguage.googleapis.com/v1beta' if base.blank?
        base.sub(%r{/openai/?\z}, '')
      end

      define_method(:with_api_key) do |runtime_api_key, api_base: nil, &block|
        initialize!

        context = RubyLLM.context do |config|
          config.openai_api_key = runtime_api_key
          config.openai_api_base = api_base if api_base.present?
          config.gemini_api_key = runtime_api_key
          config.gemini_api_base = fluvius_gemini_base(api_base)
        end

        block.call(context)
      end
    end

    RubyLLM.configure do |config|
      config.gemini_api_key = api_key
      config.gemini_api_base = api_endpoint.chomp('/').sub(%r{/openai/?\z}, '')
    end
  end

  api_base_override = Module.new do
    define_method(:api_base) do
      endpoint = InstallationConfig.find_by(name: 'CAPTAIN_OPEN_AI_ENDPOINT')&.value.presence || 'https://api.openai.com'
      endpoint = endpoint.chomp('/')
      endpoint.include?('/openai') ? endpoint : "#{endpoint}/v1"
    end
  end

  Captain::BaseTaskService.prepend(api_base_override)
  Integrations::LlmBaseService.prepend(api_base_override)

  Agents.configure do |config|
    config.openai_api_key = api_key
    config.openai_api_base = api_base
    config.default_model = model
    config.debug = false
  end
rescue StandardError => e
  Rails.logger.error "Failed to configure Fluvius AI Agents SDK override: #{e.message}"
end
