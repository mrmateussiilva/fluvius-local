#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

docker compose -f "$COMPOSE_FILE" exec -T chatwoot bundle exec rails runner '
  stages = [
    ["novo-lead", "Novo lead", "#3b82f6"],
    ["em-atendimento", "Em atendimento", "#22c55e"],
    ["orcamento-enviado", "Orçamento enviado", "#f59e0b"],
    ["follow-up", "Follow-up", "#8b5cf6"],
    ["fechado", "Fechado", "#10b981"],
    ["perdido", "Perdido", "#ef4444"],
    ["pos-venda", "Pós-venda", "#06b6d4"]
  ]

  attributes = [
    ["origem_lead", "Origem do lead", "Canal, campanha ou indicação que originou o contato.", "contact_attribute", "text"],
    ["produto_interesse", "Produto/interesse", "Produto, serviço ou necessidade principal do lead.", "contact_attribute", "text"],
    ["valor_estimado", "Valor estimado", "Valor comercial estimado para a oportunidade.", "contact_attribute", "currency"],
    ["proximo_follow_up", "Próximo follow-up", "Data combinada para retomar o atendimento comercial.", "conversation_attribute", "date"],
    ["observacao_comercial", "Observação comercial", "Notas comerciais internas sobre a oportunidade.", "conversation_attribute", "text"]
  ]

  client_accounts = ActiveRecord::Base.connection.exec_query(
    "SELECT DISTINCT chatwoot_account_id FROM fluvius_clients WHERE chatwoot_account_id IS NOT NULL"
  ).rows.flatten

  client_accounts.each do |account_id|
    stages.each do |key, title, color|
      label = Label.where(account_id: account_id).where("lower(title) = lower(?)", key).first
      label ||= Label.new(account_id: account_id, title: key)
      label.description = "Etapa do funil comercial Fluvius: #{title}" if label.description.blank?
      label.color = color if label.color.blank?
      label.show_on_sidebar = true if label.respond_to?(:show_on_sidebar=)
      label.save!
    end

    attributes.each do |key, name, description, model, display_type|
      attribute = CustomAttributeDefinition
        .where(account_id: account_id, attribute_model: model)
        .where("lower(attribute_key) = lower(?)", key)
        .first
      attribute ||= CustomAttributeDefinition.new(account_id: account_id, attribute_key: key, attribute_model: model)
      attribute.attribute_display_name = name
      attribute.attribute_display_type = display_type
      attribute.attribute_description = description
      attribute.default_value = "" if attribute.default_value.nil?
      attribute.save!
    end
  end

  puts "Applied CRM labels and commercial attributes to #{client_accounts.size} account(s)"
'
