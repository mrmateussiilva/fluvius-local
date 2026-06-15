const socket = io();
const params = new URLSearchParams(window.location.search);

const state = {
  agents: [],
  bootstrapUsers: [],
  currentUserId: Number(localStorage.getItem('fluviusInternalUserId') || 0),
  accountId: Number(localStorage.getItem('fluviusInternalAccountId') || 0),
  currentRoomId: null,
  currentRoom: null,
  rooms: [],
  onlineUserIds: new Set(),
  typingUserIds: new Set(),
  activeTab: 'rooms',
  searchTerm: '',
  pendingAttachment: null,
  embedded: params.get('embedded') === '1',
  forcedUserId: Number(params.get('userId') || 0),
  forcedUserEmail: params.get('userEmail') || '',
};

const agentSelect = document.querySelector('#agentSelect');
const agentList = document.querySelector('#agentList');
const roomList = document.querySelector('#roomList');
const messages = document.querySelector('#messages');
const messageForm = document.querySelector('#messageForm');
const messageInput = document.querySelector('#messageInput');
const sendButton = document.querySelector('#sendButton');
const roomTitle = document.querySelector('#roomTitle');
const roomSubtitle = document.querySelector('#roomSubtitle');
const groupDialog = document.querySelector('#groupDialog');
const groupTitle = document.querySelector('#groupTitle');
const groupParticipants = document.querySelector('#groupParticipants');
const searchInput = document.querySelector('#searchInput');
const roomsTab = document.querySelector('#roomsTab');
const agentsTab = document.querySelector('#agentsTab');
const roomsPanel = document.querySelector('#roomsPanel');
const agentsPanel = document.querySelector('#agentsPanel');
const typingIndicator = document.querySelector('#typingIndicator');
const notice = document.querySelector('#notice');
const roomsCount = document.querySelector('#roomsCount');
const agentsCount = document.querySelector('#agentsCount');
const roomAvatar = document.querySelector('#roomAvatar');
const roomMeta = document.querySelector('#roomMeta');
const attachButton = document.querySelector('#attachButton');
const attachmentInput = document.querySelector('#attachmentInput');
const attachmentPreview = document.querySelector('#attachmentPreview');

let typingTimer = null;
let sending = false;

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[char]);
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase();
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat('pt-BR', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function currentUser() {
  return state.agents.find(agent => Number(agent.id) === state.currentUserId);
}

function agentName(userId) {
  const agent = state.agents.find(item => Number(item.id) === Number(userId));
  return agent?.name || agent?.email || 'Agente';
}

function isOnline(userId) {
  return state.onlineUserIds.has(Number(userId));
}

function matchesSearch(...values) {
  const term = state.searchTerm.trim().toLowerCase();
  if (!term) return true;
  return values.some(value => String(value || '').toLowerCase().includes(term));
}

function showNotice(message, type = 'error') {
  notice.textContent = message;
  notice.className = `notice show ${type}`;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => {
    notice.className = 'notice';
    notice.textContent = '';
  }, 3800);
}

function setComposerState() {
  const hasRoom = Boolean(state.currentRoomId);
  const hasDraft = Boolean(messageInput.value.trim() || state.pendingAttachment);
  messageInput.disabled = !hasRoom || sending;
  attachButton.disabled = !hasRoom || sending;
  sendButton.disabled = !hasRoom || sending || !hasDraft;
  sendButton.classList.toggle('loading', sending);
  sendButton.setAttribute('aria-label', sending ? 'Enviando mensagem' : 'Enviar mensagem');
  sendButton.title = sending ? 'Enviando mensagem' : 'Enviar mensagem';
  messageInput.placeholder = hasRoom
    ? 'Escreva uma mensagem interna'
    : 'Selecione uma conversa para responder';
}

function emptyConversationMarkup() {
  return `
    <div class="conversationEmpty">
      <div class="emptyCard">
        <strong>Escolha uma conversa interna</strong>
        <span>Converse com outro agente sem sair do atendimento.</span>
        <button type="button" data-switch-agents>Iniciar conversa</button>
      </div>
    </div>
  `;
}

function renderTabs() {
  roomsTab.classList.toggle('active', state.activeTab === 'rooms');
  agentsTab.classList.toggle('active', state.activeTab === 'agents');
  roomsPanel.classList.toggle('hidden', state.activeTab !== 'rooms');
  agentsPanel.classList.toggle('hidden', state.activeTab !== 'agents');
}

function renderEmbeddedUser() {
  const user = currentUser();
  if (!state.embedded || !user) return;
  const label = document.querySelector('#embeddedUser');
  if (label) label.textContent = user.name || user.email || 'Agente';
}

function renderAgents() {
  const selectableUsers = state.embedded ? state.agents : state.bootstrapUsers;
  agentSelect.innerHTML = selectableUsers
    .map(agent => `<option value="${agent.id}">${escapeHtml(agent.name || agent.email)}${agent.account_id ? ` · Conta ${agent.account_id}` : ''}</option>`)
    .join('');
  if (!state.currentUserId && selectableUsers[0]) state.currentUserId = Number(selectableUsers[0].id);
  agentSelect.value = String(state.currentUserId);

  const filteredAgents = state.agents
    .filter(agent => Number(agent.id) !== state.currentUserId)
    .filter(agent => matchesSearch(agent.name, agent.email));
  agentsCount.textContent = String(filteredAgents.length);

  agentList.innerHTML = filteredAgents.length
    ? filteredAgents.map(
      agent => `
        <button class="row" type="button" data-agent-id="${agent.id}">
          <span class="avatar ${isOnline(agent.id) ? 'online' : ''}">${initials(agent.name || agent.email)}</span>
          <span class="rowMain">
            <strong>${escapeHtml(agent.name || agent.email)}</strong>
            <small>${escapeHtml(agent.email || 'Agente interno')}</small>
          </span>
          <span class="statusPill ${isOnline(agent.id) ? 'online' : ''}">${isOnline(agent.id) ? 'Online' : 'Off'}</span>
        </button>
      `,
    ).join('')
    : '<div class="emptyState">Nenhum agente encontrado.</div>';
  renderEmbeddedUser();
}

function renderRooms() {
  const filteredRooms = state.rooms.filter(room => matchesSearch(room.display_name, room.title, room.last_message));
  roomsCount.textContent = String(filteredRooms.length);

  roomList.innerHTML = filteredRooms.length
    ? filteredRooms.map(
      room => `
        <button class="row ${Number(room.id) === Number(state.currentRoomId) ? 'active' : ''}" type="button" data-room-id="${room.id}">
          <span class="avatar ${room.kind === 'group' ? 'group' : ''}">${initials(room.display_name || room.title || 'Chat')}</span>
          <span class="rowMain">
            <strong>${escapeHtml(room.display_name || room.title || 'Conversa')}</strong>
            <small>${escapeHtml(room.last_message || 'Sem mensagens ainda')}</small>
          </span>
          <time>${formatTime(room.last_message_at || room.updated_at)}</time>
          ${Number(room.unread_count || 0) > 0 ? `<em class="unreadPill">${room.unread_count}</em>` : ''}
        </button>
      `,
    ).join('')
    : '<div class="emptyState">Nenhuma conversa encontrada.</div>';
}

function renderCurrentHeader() {
  if (!state.currentRoomId) {
    roomTitle.textContent = 'Selecione uma conversa';
    roomSubtitle.textContent = 'Mensagens internas não são enviadas ao cliente.';
    roomAvatar.textContent = 'FI';
    roomAvatar.className = 'avatar headerAvatar';
    roomMeta.textContent = 'Interno';
    messages.innerHTML = emptyConversationMarkup();
    setComposerState();
    return;
  }

  const room = state.currentRoom || state.rooms.find(item => Number(item.id) === state.currentRoomId);
  const title = room?.display_name || room?.title || 'Conversa';
  const participants = room?.participants || [];
  const participantNames = participants
    .filter(participant => Number(participant.id) !== state.currentUserId)
    .map(participant => participant.name || participant.email)
    .filter(Boolean);

  roomTitle.textContent = title;
  roomAvatar.textContent = initials(title);
  roomAvatar.className = `avatar headerAvatar ${room?.kind === 'group' ? 'group' : ''}`;
  roomMeta.textContent = room?.kind === 'group' ? 'Grupo' : 'Direto';
  roomSubtitle.textContent = room?.kind === 'group'
    ? `${participants.length} participantes`
    : participantNames[0] || 'Mensagem direta interna';

  if (room?.kind === 'dm') {
    const other = participants.find(participant => Number(participant.id) !== state.currentUserId);
    roomSubtitle.textContent = other && isOnline(other.id) ? 'Online agora' : 'Mensagem direta interna';
    roomAvatar.classList.toggle('online', Boolean(other && isOnline(other.id)));
  }
  setComposerState();
}

function renderTyping() {
  const typingNames = [...state.typingUserIds]
    .filter(userId => Number(userId) !== state.currentUserId)
    .map(agentName);
  typingIndicator.textContent = typingNames.length ? `${typingNames.join(', ')} digitando...` : '';
}

function renderMessages(items) {
  if (!items.length) {
    messages.innerHTML = '<div class="conversationEmpty">Comece a conversa interna por aqui.</div>';
    return;
  }

  messages.innerHTML = items
    .map(message => {
      const mine = Number(message.sender_id) === state.currentUserId;
      return `
        <article class="bubble ${mine ? 'mine' : ''}">
          <header>${mine ? 'Você' : escapeHtml(message.sender_name)}</header>
          ${message.content ? `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>` : ''}
          ${renderAttachment(message)}
          <footer><time>${formatTime(message.created_at)}</time>${mine ? '<span class="messageStatus">✓✓</span>' : ''}</footer>
        </article>
      `;
    })
    .join('');
  messages.scrollTop = messages.scrollHeight;
}

function appendMessage(message) {
  if (messages.querySelector('.conversationEmpty')) messages.innerHTML = '';
  const mine = Number(message.sender_id) === state.currentUserId;
  const element = document.createElement('article');
  element.className = `bubble ${mine ? 'mine' : ''}`;
  element.innerHTML = `
    <header>${mine ? 'Você' : escapeHtml(message.sender_name)}</header>
    ${message.content ? `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>` : ''}
    ${renderAttachment(message)}
    <footer><time>${formatTime(message.created_at)}</time>${mine ? '<span class="messageStatus">✓✓</span>' : ''}</footer>
  `;
  messages.appendChild(element);
  messages.scrollTop = messages.scrollHeight;
}

function messageAttachment(message) {
  const kind = message.attachment_kind || message.kind || '';
  if (!kind) return null;
  return {
    kind,
    name: message.attachment_name || message.name || 'arquivo',
    mime: message.attachment_mime || message.mime || '',
    size: message.attachment_size || message.size || 0,
    url: message.attachment_url || message.attachment_data_url || message.url || message.dataUrl || '',
  };
}

function renderAttachment(message) {
  const attachment = messageAttachment(message);
  if (!attachment?.url) return '';
  const name = escapeHtml(attachment.name);
  const size = escapeHtml(formatFileSize(attachment.size));
  if (attachment.kind === 'image') {
    return `
      <a class="messageAttachment imageAttachment" href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener">
        <img src="${escapeHtml(attachment.url)}" alt="${name}" loading="lazy" />
      </a>
    `;
  }
  if (attachment.kind === 'audio') {
    return `
      <div class="messageAttachment audioAttachment">
        <strong>${name}</strong>
        <audio controls src="${escapeHtml(attachment.url)}"></audio>
      </div>
    `;
  }
  return `
    <a class="messageAttachment fileAttachment" href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener" download>
      <span class="fileIcon">ARQ</span>
      <span>
        <strong>${name}</strong>
        <small>${size || 'Arquivo'}</small>
      </span>
    </a>
  `;
}

function renderAttachmentPreview() {
  if (!state.pendingAttachment) {
    attachmentPreview.classList.add('hidden');
    attachmentPreview.innerHTML = '';
    return;
  }
  const file = state.pendingAttachment;
  attachmentPreview.classList.remove('hidden');
  attachmentPreview.innerHTML = `
    <span class="fileIcon">${file.type.startsWith('image/') ? 'IMG' : file.type.startsWith('audio/') ? 'AUD' : 'ARQ'}</span>
    <span>
      <strong>${escapeHtml(file.name)}</strong>
      <small>${escapeHtml(formatFileSize(file.size))}</small>
    </span>
    <button type="button" data-clear-attachment aria-label="Remover anexo" title="Remover anexo">&times;</button>
  `;
}

async function uploadAttachment(file) {
  const contentType = file.type === 'application/json'
    ? 'application/octet-stream'
    : file.type || 'application/octet-stream';
  const response = await fetch(`/api/uploads?userId=${state.currentUserId}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-File-Name': encodeURIComponent(file.name || 'arquivo'),
    },
    body: file,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function createSocketMessage(payload) {
  return new Promise(resolve => {
    const sendTimeout = window.setTimeout(() => resolve({ ok: false, timeout: true }), 7000);
    socket.emit('message:create', payload, response => {
      window.clearTimeout(sendTimeout);
      resolve(response || { ok: false });
    });
  });
}

async function loadRooms() {
  if (!state.currentUserId) return;
  try {
    state.rooms = await request(`/api/rooms?userId=${state.currentUserId}&accountId=${state.accountId}`);
    renderRooms();
  } catch (error) {
    showNotice('Nao foi possivel carregar as conversas internas.');
  }
}

async function openRoom(roomId) {
  state.currentRoomId = Number(roomId);
  state.typingUserIds.clear();
  renderTyping();
  messages.innerHTML = '<div class="loadingState"><span></span><span></span><span></span></div>';
  setComposerState();
  socket.emit('join', { userId: state.currentUserId, accountId: state.accountId, roomId: state.currentRoomId });
  try {
    const [room, items] = await Promise.all([
      request(`/api/rooms/${state.currentRoomId}?userId=${state.currentUserId}&accountId=${state.accountId}`),
      request(`/api/rooms/${state.currentRoomId}/messages?userId=${state.currentUserId}&accountId=${state.accountId}`),
    ]);
    state.currentRoom = room;
    renderCurrentHeader();
    renderMessages(items);
    await markRoomRead(state.currentRoomId);
    await loadRooms();
    messageInput.focus();
  } catch (error) {
    showNotice('Nao foi possivel abrir esta conversa.');
    messages.innerHTML = emptyConversationMarkup();
  } finally {
    setComposerState();
  }
}

async function markRoomRead(roomId) {
  await request(`/api/rooms/${roomId}/read`, {
    method: 'POST',
    body: JSON.stringify({ userId: state.currentUserId, accountId: state.accountId }),
  });
}

async function startDm(otherUserId) {
  const room = await request('/api/rooms/dm', {
    method: 'POST',
    body: JSON.stringify({ userId: state.currentUserId, accountId: state.accountId, otherUserId }),
  });
  state.activeTab = 'rooms';
  renderTabs();
  await loadRooms();
  await openRoom(room.id);
}

function renderGroupParticipants() {
  groupParticipants.innerHTML = state.agents
    .filter(agent => Number(agent.id) !== state.currentUserId)
    .map(
      agent => `
        <label>
          <input type="checkbox" value="${agent.id}" />
          <span>${escapeHtml(agent.name || agent.email)}</span>
        </label>
      `,
    )
    .join('');
}

function resizeComposer() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
}

function emitTyping() {
  if (!state.currentRoomId) return;
  socket.emit('typing:start', { userId: state.currentUserId, accountId: state.accountId, roomId: state.currentRoomId });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit('typing:stop', { userId: state.currentUserId, accountId: state.accountId, roomId: state.currentRoomId });
  }, 1200);
}

agentSelect.addEventListener('change', async event => {
  state.currentUserId = Number(event.target.value);
  const selected = state.bootstrapUsers.find(user => Number(user.id) === state.currentUserId);
  if (selected?.account_id) state.accountId = Number(selected.account_id);
  localStorage.setItem('fluviusInternalUserId', String(state.currentUserId));
  localStorage.setItem('fluviusInternalAccountId', String(state.accountId));
  state.currentRoomId = null;
  state.currentRoom = null;
  messages.innerHTML = '';
  await loadAccountAgents();
  renderCurrentHeader();
  renderAgents();
  renderGroupParticipants();
  socket.emit('user:join', { userId: state.currentUserId, accountId: state.accountId });
  await loadRooms();
});

searchInput.addEventListener('input', event => {
  state.searchTerm = event.target.value;
  renderAgents();
  renderRooms();
});

roomsTab.addEventListener('click', () => {
  state.activeTab = 'rooms';
  renderTabs();
});

agentsTab.addEventListener('click', () => {
  state.activeTab = 'agents';
  renderTabs();
});

agentList.addEventListener('click', event => {
  const button = event.target.closest('[data-agent-id]');
  if (button) startDm(Number(button.dataset.agentId));
});

roomList.addEventListener('click', event => {
  const button = event.target.closest('[data-room-id]');
  if (button) openRoom(Number(button.dataset.roomId));
});

messageForm.addEventListener('submit', async event => {
  event.preventDefault();
  const content = messageInput.value.trim();
  const file = state.pendingAttachment;
  if ((!content && !file) || !state.currentRoomId || sending) return;
  sending = true;
  setComposerState();
  socket.emit('typing:stop', { userId: state.currentUserId, accountId: state.accountId, roomId: state.currentRoomId });
  try {
    const attachment = file ? await uploadAttachment(file) : null;
    const response = await createSocketMessage({
      userId: state.currentUserId,
      accountId: state.accountId,
      roomId: state.currentRoomId,
      content,
      attachment,
    });
    if (!response?.ok) {
      showNotice(response?.timeout ? 'A mensagem demorou para confirmar. Verifique a conversa.' : 'Nao foi possivel enviar a mensagem.');
      return;
    }
    messageInput.value = '';
    state.pendingAttachment = null;
    renderAttachmentPreview();
    resizeComposer();
    loadRooms();
  } catch (error) {
    showNotice('Nao foi possivel enviar o anexo.');
  } finally {
    sending = false;
    setComposerState();
  }
});

messageInput.addEventListener('input', () => {
  resizeComposer();
  emitTyping();
  setComposerState();
});

messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

attachButton.addEventListener('click', () => {
  if (attachButton.disabled) return;
  attachmentInput.click();
});

attachmentInput.addEventListener('change', event => {
  const file = event.target.files?.[0];
  attachmentInput.value = '';
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) {
    showNotice('O anexo pode ter no maximo 12 MB.');
    return;
  }
  state.pendingAttachment = file;
  renderAttachmentPreview();
  setComposerState();
});

attachmentPreview.addEventListener('click', event => {
  if (!event.target.closest('[data-clear-attachment]')) return;
  state.pendingAttachment = null;
  renderAttachmentPreview();
  setComposerState();
  messageInput.focus();
});

document.querySelector('#newGroupButton').addEventListener('click', () => {
  groupTitle.value = '';
  renderGroupParticipants();
  groupDialog.showModal();
});

document.querySelector('#createGroupButton').addEventListener('click', async () => {
  const participantIds = [...groupParticipants.querySelectorAll('input:checked')].map(input => Number(input.value));
  if (!groupTitle.value.trim() || participantIds.length === 0) {
    showNotice('Informe o nome do grupo e pelo menos um agente.');
    return;
  }
  try {
    const room = await request('/api/rooms/group', {
      method: 'POST',
      body: JSON.stringify({ userId: state.currentUserId, accountId: state.accountId, title: groupTitle.value, participantIds }),
    });
    groupDialog.close();
    state.activeTab = 'rooms';
    renderTabs();
    await loadRooms();
    await openRoom(room.id);
  } catch (error) {
    showNotice('Nao foi possivel criar o grupo.');
  }
});

messages.addEventListener('click', event => {
  if (!event.target.closest('[data-switch-agents]')) return;
  state.activeTab = 'agents';
  renderTabs();
  searchInput.focus();
});

socket.on('message:new', message => {
  state.typingUserIds.delete(Number(message.sender_id));
  renderTyping();
  if (Number(message.room_id) === Number(state.currentRoomId)) {
    appendMessage(message);
    markRoomRead(state.currentRoomId).then(loadRooms);
    return;
  }
  loadRooms();
});

socket.on('presence:update', payload => {
  state.onlineUserIds = new Set((payload.onlineUserIds || []).map(Number));
  renderAgents();
  renderCurrentHeader();
});

socket.on('typing:update', payload => {
  if (Number(payload.roomId) !== Number(state.currentRoomId)) return;
  if (payload.typing) state.typingUserIds.add(Number(payload.userId));
  else state.typingUserIds.delete(Number(payload.userId));
  renderTyping();
});

async function loadAccountAgents() {
  const agentPayload = await request(`/api/agents?userId=${state.currentUserId}&accountId=${state.accountId}`);
  state.accountId = Number(agentPayload.accountId || state.accountId || 0);
  state.agents = agentPayload.agents || [];
}

async function boot() {
  if (state.embedded) document.body.classList.add('embedded');
  state.bootstrapUsers = await request('/api/bootstrap-users');

  const forcedById = state.bootstrapUsers.find(user => Number(user.id) === state.forcedUserId);
  const forcedByEmail = state.bootstrapUsers.find(user => user.email && user.email.toLowerCase() === state.forcedUserEmail.toLowerCase());
  const savedUser = state.bootstrapUsers.find(user => Number(user.id) === state.currentUserId);
  const selectedUser = forcedById || forcedByEmail || savedUser || state.bootstrapUsers[0];

  state.currentUserId = Number(selectedUser?.id || 0);
  state.accountId = Number(selectedUser?.account_id || state.accountId || 0);
  await loadAccountAgents();
  const agentById = state.agents.find(agent => Number(agent.id) === state.forcedUserId);
  const agentByEmail = state.agents.find(agent => agent.email && agent.email.toLowerCase() === state.forcedUserEmail.toLowerCase());

  if (agentById) {
    state.currentUserId = Number(agentById.id);
  } else if (agentByEmail) {
    state.currentUserId = Number(agentByEmail.id);
  } else if (!state.agents.some(agent => Number(agent.id) === state.currentUserId)) {
    state.currentUserId = Number(state.agents[0]?.id || 0);
  }
  localStorage.setItem('fluviusInternalUserId', String(state.currentUserId));
  localStorage.setItem('fluviusInternalAccountId', String(state.accountId));
  socket.emit('user:join', { userId: state.currentUserId, accountId: state.accountId });

  renderTabs();
  renderAgents();
  renderEmbeddedUser();
  renderGroupParticipants();
  renderCurrentHeader();
  await loadRooms();
  setComposerState();
}

boot().catch(error => {
  document.body.innerHTML = `
    <main class="fatalError">
      <strong>Nao foi possivel carregar o chat interno.</strong>
      <span>${escapeHtml(error.message)}</span>
    </main>
  `;
});
