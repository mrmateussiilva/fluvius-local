require 'pg'
require 'json'
require 'securerandom'

instance_name = ENV.fetch('EVOLUTION_INSTANCE', 'Finderbit')
account_id = Integer(ENV.fetch('CHATWOOT_ACCOUNT_ID', '1'))
inbox_name = ENV.fetch('CHATWOOT_INBOX_NAME', 'WhatsApp Finderbit')
evolution_db_url = ENV.fetch('EVOLUTION_DATABASE_URL')

cw_config = ActiveRecord::Base.connection_db_config.configuration_hash
cw = PG.connect(
  host: cw_config[:host],
  port: cw_config[:port],
  dbname: cw_config[:database],
  user: cw_config[:username],
  password: cw_config[:password]
)
ev = PG.connect(evolution_db_url)

inbox = cw.exec_params('SELECT id FROM inboxes WHERE account_id = $1 AND name = $2 LIMIT 1', [account_id, inbox_name]).first
raise "Inbox not found: #{inbox_name}" unless inbox

inbox_id = inbox['id']
user = cw.exec_params(
  'SELECT users.id FROM users INNER JOIN account_users ON account_users.user_id = users.id WHERE account_users.account_id = $1 ORDER BY users.id LIMIT 1',
  [account_id]
).first
raise "No user found for account #{account_id}" unless user

user_id = user['id']

instance = ev.exec_params('SELECT id FROM "Instance" WHERE name = $1 LIMIT 1', [instance_name]).first
raise "Evolution instance not found: #{instance_name}" unless instance

instance_id = instance['id']

def content_from(row)
  message = JSON.parse(row['message'] || '{}')
  type = row['messageType']

  case type
  when 'conversation'
    message['conversation'].to_s
  when 'extendedTextMessage'
    message.dig('extendedTextMessage', 'text').to_s
  when 'imageMessage'
    caption = message.dig('imageMessage', 'caption').to_s
    caption.empty? ? '_<Image Message>_' : "_<Image Message>_\n#{caption}"
  when 'videoMessage'
    caption = message.dig('videoMessage', 'caption').to_s
    caption.empty? ? '_<Video Message>_' : "_<Video Message>_\n#{caption}"
  when 'audioMessage'
    '_<Audio Message>_'
  when 'stickerMessage'
    '_<Sticker Message>_'
  when 'documentMessage'
    name = message.dig('documentMessage', 'fileName') || message.dig('documentMessage', 'title')
    name ? "_<Document Message>_ #{name}" : '_<Document Message>_'
  when 'contactMessage'
    display_name = message.dig('contactMessage', 'displayName')
    display_name ? "_<Contact Message>_ #{display_name}" : '_<Contact Message>_'
  when 'interactiveMessage'
    title = message.dig('interactiveMessage', 'header', 'title').to_s
    body = message.dig('interactiveMessage', 'body', 'text').to_s
    ad_title = message.dig('interactiveMessage', 'contextInfo', 'externalAdReply', 'title').to_s
    ad_body = message.dig('interactiveMessage', 'contextInfo', 'externalAdReply', 'body').to_s
    [title, body, ad_title, ad_body].reject(&:empty?).join("\n\n")
  else
    "_<#{type}>_"
  end
end

def jid_phone(jid)
  return nil unless jid&.end_with?('@s.whatsapp.net')

  "+#{jid.split('@').first.gsub(/\D/, '')}"
end

def contact_name(row, remote_jid)
  name = row['chat_name'].to_s.strip
  name = row['pushName'].to_s.strip if name.empty? || name == 'Você'
  name = remote_jid.split('@').first if name.empty? || name == 'Você'
  name
end

def query_one(conn, sql, binds)
  conn.exec_params(sql, binds).first
end

def execute(conn, sql, binds)
  conn.exec_params(sql, binds)
end

rows = ev.exec_params(<<~SQL, [instance_id])
  SELECT
    m.id,
    m.key,
    m."pushName",
    m."messageType",
    m.message,
    m."messageTimestamp",
    c.name AS chat_name
  FROM "Message" m
  LEFT JOIN "Chat" c
    ON c."instanceId" = m."instanceId"
   AND c."remoteJid" = m.key->>'remoteJid'
  WHERE m."instanceId" = $1
    AND m."chatwootMessageId" IS NULL
    AND m.key->>'remoteJid' <> 'status@broadcast'
  ORDER BY m."messageTimestamp" ASC, m.id ASC
SQL

stats = Hash.new(0)
conversation_cache = {}

rows.each do |row|
  key = JSON.parse(row['key'])
  remote_jid = key['remoteJid']
  next if remote_jid.to_s.empty?

  key_id = key['id'].to_s
  source_id = "WAID:#{key_id.empty? ? row['id'] : key_id}"
  existing_message = query_one(
    cw,
    <<~SQL,
      SELECT messages.id, messages.inbox_id, messages.conversation_id, contact_inboxes.source_id AS contact_inbox_source_id
      FROM messages
      INNER JOIN conversations ON conversations.id = messages.conversation_id
      LEFT JOIN contact_inboxes ON contact_inboxes.id = conversations.contact_inbox_id
      WHERE messages.source_id = $1
      LIMIT 1
    SQL
    [source_id]
  )

  if existing_message
    ev.exec_params(
      'UPDATE "Message" SET "chatwootMessageId" = $1, "chatwootInboxId" = $2, "chatwootConversationId" = $3, "chatwootContactInboxSourceId" = $4, "chatwootIsRead" = true WHERE id = $5',
      [existing_message['id'], existing_message['inbox_id'], existing_message['conversation_id'], existing_message['contact_inbox_source_id'], row['id']]
    )
    stats[:messages_relinked] += 1
    next
  end

  content = content_from(row)
  next if content.strip.empty?

  created_at = Time.at(Integer(row['messageTimestamp'])).utc
  name = contact_name(row, remote_jid)
  phone = jid_phone(remote_jid)
  source = "evolution:#{remote_jid}"

  conversation = conversation_cache[remote_jid]
  unless conversation
    contact = query_one(cw, 'SELECT id FROM contacts WHERE account_id = $1 AND identifier = $2 LIMIT 1', [account_id, remote_jid])
    unless contact
      contact = query_one(
        cw,
        <<~SQL,
          INSERT INTO contacts
            (name, phone_number, account_id, created_at, updated_at, additional_attributes, identifier, custom_attributes, contact_type, middle_name, last_name, location, country_code, blocked)
          VALUES
            ($1, $2, $3, $4, $4, '{}', $5, '{}', 0, '', '', '', '', false)
          RETURNING id
        SQL
        [name, phone, account_id, created_at, remote_jid]
      )
      stats[:contacts_created] += 1
    end

    contact_inbox = query_one(cw, 'SELECT id FROM contact_inboxes WHERE inbox_id = $1 AND source_id = $2 LIMIT 1', [inbox_id, source])
    unless contact_inbox
      contact_inbox = query_one(
        cw,
        <<~SQL,
          INSERT INTO contact_inboxes
            (contact_id, inbox_id, source_id, created_at, updated_at, hmac_verified, pubsub_token)
          VALUES
            ($1, $2, $3, $4, $4, false, $5)
          RETURNING id
        SQL
        [contact['id'], inbox_id, source, created_at, SecureRandom.hex(16)]
      )
    end

    conversation = query_one(cw, 'SELECT id FROM conversations WHERE account_id = $1 AND inbox_id = $2 AND contact_inbox_id = $3 LIMIT 1', [account_id, inbox_id, contact_inbox['id']])
    unless conversation
      conversation = query_one(
        cw,
        <<~SQL,
          INSERT INTO conversations
            (account_id, inbox_id, status, created_at, updated_at, contact_id, contact_inbox_id, additional_attributes, custom_attributes, last_activity_at, identifier)
          VALUES
            ($1, $2, 0, $3, $3, $4, $5, '{}', '{}', $3, $6)
          RETURNING id
        SQL
        [account_id, inbox_id, created_at, contact['id'], contact_inbox['id'], remote_jid]
      )
      stats[:conversations_created] += 1
    end

    conversation = conversation.merge('contact_id' => contact['id'], 'contact_inbox_source_id' => source)
    conversation_cache[remote_jid] = conversation
  end

  from_me = key['fromMe'] == true || key['fromMe'].to_s == 'true'
  sender_type = from_me ? 'User' : 'Contact'
  sender_id = from_me ? user_id : query_one(cw, 'SELECT contact_id FROM conversations WHERE id = $1', [conversation['id']])['contact_id']
  message_type = from_me ? 1 : 0

  message = query_one(
    cw,
    <<~SQL,
      INSERT INTO messages
        (content, account_id, inbox_id, conversation_id, message_type, created_at, updated_at, private, status, source_id, content_type, content_attributes, sender_type, sender_id, external_source_ids, additional_attributes, processed_message_content, sentiment)
      VALUES
        ($1, $2, $3, $4, $5, $6, $6, false, 0, $7, 0, '{}', $8, $9, '{}', '{}', $1, '{}')
      RETURNING id
    SQL
    [content, account_id, inbox_id, conversation['id'], message_type, created_at, source_id, sender_type, sender_id]
  )

  execute(
    cw,
    'UPDATE conversations SET last_activity_at = GREATEST(last_activity_at, $1), updated_at = GREATEST(updated_at, $1) WHERE id = $2',
    [created_at, conversation['id']]
  )

  ev.exec_params(
    'UPDATE "Message" SET "chatwootMessageId" = $1, "chatwootInboxId" = $2, "chatwootConversationId" = $3, "chatwootContactInboxSourceId" = $4, "chatwootIsRead" = true WHERE id = $5',
    [message['id'], inbox_id, conversation['id'], conversation['contact_inbox_source_id'], row['id']]
  )

  stats[:messages_imported] += 1
end

puts({
  instance: instance_name,
  inbox_id: inbox_id,
  contacts_created: stats[:contacts_created],
  conversations_created: stats[:conversations_created],
  messages_imported: stats[:messages_imported],
  messages_relinked: stats[:messages_relinked]
}.to_json)
