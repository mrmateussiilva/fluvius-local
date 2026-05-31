# Local Docker-only setting for integrations that call sibling containers.
# Do not enable this in a public production deployment.
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
