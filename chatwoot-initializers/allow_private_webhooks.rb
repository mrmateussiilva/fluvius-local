# Required when Chatwoot sends webhooks to sibling services on the private
# Docker network, for example http://evolution:8080.
if ENV['ALLOW_PRIVATE_WEBHOOK_URLS'] == 'true'
  require 'ssrf_filter'

  class SsrfFilter
    class << self
      def unsafe_ip_address?(_ip_address)
        false
      end

      private :unsafe_ip_address?
    end
  end
end
