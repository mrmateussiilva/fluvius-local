<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useMapGetter } from 'dashboard/composables/store';

const API_BASE = import.meta.env.VITE_INTERNAL_CHAT_API_URL || 'http://localhost:4000';
const route = useRoute();

const currentUserId = useMapGetter('getCurrentUserID');
const currentUser = useMapGetter('getCurrentUser');

const agents = ref([]);
const rooms = ref([]);
const messages = ref([]);
const currentRoom = ref(null);
const currentRoomId = ref(null);
const activeTab = ref('rooms');
const searchTerm = ref('');
const onlineUserIds = ref(new Set());
const typingUserIds = ref(new Set());
const loading = ref(true);
const loadingRoom = ref(false);
const sending = ref(false);
const notice = ref('');
const showGroupDialog = ref(false);
const groupTitle = ref('');
const groupParticipantIds = ref([]);
const messageInput = ref('');
const selectedAttachment = ref(null);
const recording = ref(false);
const messagesEl = ref(null);
const messageInputEl = ref(null);
const imageInputEl = ref(null);
const fileInputEl = ref(null);

let socket = null;
let noticeTimer = null;
let typingTimer = null;
let roomPollTimer = null;
let mediaRecorder = null;
let audioChunks = [];

const userId = computed(() => Number(currentUserId.value || 0));
const accountId = computed(() => Number(route.params.accountId || route.params.account_id || 0));

const currentAgent = computed(() => {
  return agents.value.find(agent => Number(agent.id) === userId.value) || {
    id: userId.value,
    name: currentUser.value?.name,
    email: currentUser.value?.email,
  };
});

const filteredRooms = computed(() => {
  const term = searchTerm.value.trim().toLowerCase();
  if (!term) return rooms.value;
  return rooms.value.filter(room => {
    return [room.display_name, room.title, room.last_message]
      .some(value => String(value || '').toLowerCase().includes(term));
  });
});

const filteredAgents = computed(() => {
  const term = searchTerm.value.trim().toLowerCase();
  return agents.value
    .filter(agent => Number(agent.id) !== userId.value)
    .filter(agent => {
      if (!term) return true;
      return [agent.name, agent.email]
        .some(value => String(value || '').toLowerCase().includes(term));
    });
});

const roomTitle = computed(() => {
  if (!currentRoomId.value) return 'Selecione uma conversa';
  return currentRoom.value?.display_name || currentRoom.value?.title || 'Conversa';
});

const roomSubtitle = computed(() => {
  if (!currentRoomId.value) return 'Mensagens internas não são enviadas ao cliente.';
  const participants = currentRoom.value?.participants || [];
  if (currentRoom.value?.kind === 'group') return `${participants.length} participantes`;
  const other = participants.find(participant => Number(participant.id) !== userId.value);
  if (!other) return 'Mensagem direta interna';
  return isOnline(other.id) ? 'Online agora' : other.email || 'Mensagem direta interna';
});

const canSend = computed(() => {
  return Boolean(
    currentRoomId.value &&
    !sending.value &&
    (messageInput.value.trim() || selectedAttachment.value)
  );
});

const typingNames = computed(() => {
  return [...typingUserIds.value]
    .filter(id => Number(id) !== userId.value)
    .map(agentName);
});

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

function isOnline(agentId) {
  return onlineUserIds.value.has(Number(agentId));
}

function agentName(agentId) {
  const agent = agents.value.find(item => Number(item.id) === Number(agentId));
  return agent?.name || agent?.email || 'Agente';
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentLabel(message) {
  if (message.attachment_name) return message.attachment_name;
  if (message.attachment_kind === 'image') return 'Imagem';
  if (message.attachment_kind === 'audio') return 'Audio';
  return 'Arquivo';
}

function attachmentIcon(kind) {
  if (kind === 'image') return 'i-lucide-image';
  if (kind === 'audio') return 'i-lucide-mic';
  return 'i-lucide-paperclip';
}

function attachmentUrl(message) {
  if (message.attachment_url) return `${API_BASE}${message.attachment_url}`;
  return message.attachment_data_url;
}

function showNotice(message) {
  notice.value = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice.value = '';
  }, 3800);
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function uploadFile(file) {
  const response = await fetch(`${API_BASE}/api/uploads?userId=${userId.value}&accountId=${accountId.value}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'arquivo'),
    },
    body: file,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function buildAttachment(file, forcedKind = null) {
  if (!file) return null;
  if (file.size > 12 * 1024 * 1024) {
    showNotice('O arquivo precisa ter ate 12 MB.');
    return null;
  }

  const mime = file.type || 'application/octet-stream';
  const uploaded = await uploadFile(file);
  return {
    ...uploaded,
    kind: forcedKind || uploaded.kind,
    previewUrl: URL.createObjectURL(file),
  };
}

async function handleFileSelection(event, forcedKind = null) {
  const file = event.target.files?.[0];
  event.target.value = '';
  const attachment = await buildAttachment(file, forcedKind);
  if (attachment) selectedAttachment.value = attachment;
}

function clearAttachment() {
  if (selectedAttachment.value?.previewUrl) URL.revokeObjectURL(selectedAttachment.value.previewUrl);
  selectedAttachment.value = null;
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
}

async function loadAgents() {
  const payload = await request(`/api/agents?userId=${userId.value}&accountId=${accountId.value}`);
  agents.value = payload.agents || [];
}

async function loadRooms() {
  if (!userId.value) return;
  rooms.value = await request(`/api/rooms?userId=${userId.value}&accountId=${accountId.value}`);
}

async function markRoomRead(roomId) {
  await request(`/api/rooms/${roomId}/read`, {
    method: 'POST',
    body: JSON.stringify({ userId: userId.value, accountId: accountId.value }),
  });
}

async function openRoom(roomId) {
  currentRoomId.value = Number(roomId);
  loadingRoom.value = true;
  typingUserIds.value.clear();
  socket?.emit('join', { userId: userId.value, accountId: accountId.value, roomId: currentRoomId.value });

  try {
    const [room, items] = await Promise.all([
      request(`/api/rooms/${currentRoomId.value}?userId=${userId.value}&accountId=${accountId.value}`),
      request(`/api/rooms/${currentRoomId.value}/messages?userId=${userId.value}&accountId=${accountId.value}`),
    ]);
    currentRoom.value = {
      ...room,
      display_name: room.title || room.participants
        ?.filter(participant => Number(participant.id) !== userId.value)
        .map(participant => participant.name || participant.email)
        .join(', '),
    };
    messages.value = items;
    await markRoomRead(currentRoomId.value);
    await loadRooms();
    scrollToBottom();
    nextTick(() => messageInputEl.value?.focus());
  } catch {
    showNotice('Nao foi possivel abrir esta conversa.');
  } finally {
    loadingRoom.value = false;
  }
}

async function refreshCurrentRoomMessages() {
  if (!currentRoomId.value || loadingRoom.value) return;
  try {
    const items = await request(`/api/rooms/${currentRoomId.value}/messages?userId=${userId.value}&accountId=${accountId.value}`);
    if (items.length !== messages.value.length || items.at(-1)?.id !== messages.value.at(-1)?.id) {
      messages.value = items;
      scrollToBottom();
    }
    await markRoomRead(currentRoomId.value);
  } catch {
    // Polling should stay quiet; explicit actions surface errors.
  }
}

async function startDm(otherUserId) {
  try {
    const room = await request('/api/rooms/dm', {
      method: 'POST',
      body: JSON.stringify({ userId: userId.value, accountId: accountId.value, otherUserId }),
    });
    activeTab.value = 'rooms';
    await loadRooms();
    await openRoom(room.id);
  } catch {
    showNotice('Nao foi possivel iniciar a conversa.');
  }
}

async function createGroup() {
  const participantIds = groupParticipantIds.value.map(Number);
  if (!groupTitle.value.trim() || participantIds.length === 0) {
    showNotice('Informe o nome do grupo e pelo menos um agente.');
    return;
  }

  try {
    const room = await request('/api/rooms/group', {
      method: 'POST',
      body: JSON.stringify({
        userId: userId.value,
        accountId: accountId.value,
        title: groupTitle.value,
        participantIds,
      }),
    });
    showGroupDialog.value = false;
    groupTitle.value = '';
    groupParticipantIds.value = [];
    activeTab.value = 'rooms';
    await loadRooms();
    await openRoom(room.id);
  } catch {
    showNotice('Nao foi possivel criar o grupo.');
  }
}

function emitTyping() {
  if (!currentRoomId.value) return;
  socket?.emit('typing:start', { userId: userId.value, accountId: accountId.value, roomId: currentRoomId.value });
  window.clearTimeout(typingTimer);
  typingTimer = window.setTimeout(() => {
    socket?.emit('typing:stop', { userId: userId.value, accountId: accountId.value, roomId: currentRoomId.value });
  }, 1200);
}

async function toggleRecording() {
  if (recording.value) {
    mediaRecorder?.stop();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showNotice('Gravacao de audio nao suportada neste navegador.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      recording.value = false;
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const file = new File([blob], `audio-${Date.now()}.webm`, { type: blob.type });
      const attachment = await buildAttachment(file, 'audio');
      if (attachment) selectedAttachment.value = attachment;
    };
    mediaRecorder.start();
    recording.value = true;
  } catch {
    showNotice('Nao foi possivel acessar o microfone.');
  }
}

function sendMessage() {
  const content = messageInput.value.trim();
  const attachment = selectedAttachment.value;
  if ((!content && !attachment) || !currentRoomId.value || sending.value) return;

  sending.value = true;
  socket?.emit('typing:stop', { userId: userId.value, accountId: accountId.value, roomId: currentRoomId.value });

  const finishSend = response => {
    sending.value = false;
    if (!response?.ok) {
      showNotice('Nao foi possivel enviar a mensagem.');
      return;
    }
    messageInput.value = '';
    clearAttachment();
    if (response.message && !messages.value.some(item => Number(item.id) === Number(response.message.id))) {
      messages.value = [...messages.value, response.message];
      scrollToBottom();
    }
    loadRooms();
  };

  if (socket?.connected && !attachment) {
    socket.emit('message:create', {
      userId: userId.value,
      accountId: accountId.value,
      roomId: currentRoomId.value,
      content,
      attachment,
    }, finishSend);

    window.setTimeout(() => {
      if (!sending.value) return;
      sending.value = false;
      showNotice('A mensagem demorou para confirmar. Verifique a conversa.');
      refreshCurrentRoomMessages();
    }, 7000);
    return;
  }

  request(`/api/rooms/${currentRoomId.value}/messages`, {
    method: 'POST',
    body: JSON.stringify({ userId: userId.value, accountId: accountId.value, content, attachment }),
  })
    .then(message => finishSend({ ok: true, message }))
    .catch(() => finishSend({ ok: false }));
}

function handleComposerKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  sendMessage();
}

function handleNewMessage(message) {
  typingUserIds.value.delete(Number(message.sender_id));
  if (Number(message.room_id) === Number(currentRoomId.value)) {
    if (messages.value.some(item => Number(item.id) === Number(message.id))) return;
    messages.value = [...messages.value, message];
    markRoomRead(currentRoomId.value).then(loadRooms);
    scrollToBottom();
    return;
  }
  loadRooms();
}

function loadSocketScript() {
  if (window.io) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${API_BASE}/socket.io/socket.io.js`;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function connectSocket() {
  await loadSocketScript();
  socket = window.io(API_BASE, { transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    socket.emit('user:join', { userId: userId.value, accountId: accountId.value });
    if (currentRoomId.value) {
      socket.emit('join', { userId: userId.value, accountId: accountId.value, roomId: currentRoomId.value });
    }
  });
  socket.on('message:new', handleNewMessage);
  socket.on('presence:update', payload => {
    onlineUserIds.value = new Set((payload.onlineUserIds || []).map(Number));
  });
  socket.on('typing:update', payload => {
    if (Number(payload.roomId) !== Number(currentRoomId.value)) return;
    const nextTyping = new Set(typingUserIds.value);
    if (payload.typing) nextTyping.add(Number(payload.userId));
    else nextTyping.delete(Number(payload.userId));
    typingUserIds.value = nextTyping;
  });
}

function startRoomPolling() {
  roomPollTimer = window.setInterval(() => {
    loadRooms().catch(() => {});
    refreshCurrentRoomMessages();
  }, 10000);
}

onMounted(async () => {
  try {
    await loadAgents();
    await loadRooms();
    await connectSocket().catch(() => {
      showNotice('Chat em tempo real indisponivel. Usando atualizacao automatica.');
    });
    startRoomPolling();
  } catch {
    showNotice('Nao foi possivel carregar o chat interno.');
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  window.clearTimeout(noticeTimer);
  window.clearTimeout(typingTimer);
  window.clearInterval(roomPollTimer);
  if (recording.value) mediaRecorder?.stop();
  socket?.disconnect();
});

watch(userId, async nextUserId => {
  if (!nextUserId) return;
  currentRoom.value = null;
  currentRoomId.value = null;
  messages.value = [];
  socket?.emit('user:join', { userId: nextUserId, accountId: accountId.value });
  await loadAgents();
  await loadRooms();
});
</script>

<template>
  <main class="internal-chat-view bg-n-background text-n-slate-12">
    <aside class="internal-chat-sidebar bg-n-solid-1 border-n-weak">
      <header class="internal-chat-sidebar__header border-n-weak">
        <div>
          <h1>Chat interno</h1>
          <p>{{ currentAgent?.name || currentAgent?.email || 'Agente' }}</p>
        </div>
        <button
          type="button"
          class="icon-button"
          title="Novo grupo"
          @click="showGroupDialog = true"
        >
          <i class="i-lucide-plus" />
        </button>
      </header>

      <div class="internal-chat-search">
        <i class="i-lucide-search" />
        <input
          v-model="searchTerm"
          type="search"
          placeholder="Buscar conversa ou agente"
        >
      </div>

      <div class="internal-chat-tabs">
        <button
          type="button"
          :class="{ active: activeTab === 'rooms' }"
          @click="activeTab = 'rooms'"
        >
          Conversas
        </button>
        <button
          type="button"
          :class="{ active: activeTab === 'agents' }"
          @click="activeTab = 'agents'"
        >
          Agentes
        </button>
      </div>

      <div class="internal-chat-list">
        <div v-if="loading" class="internal-chat-muted">Carregando conversas...</div>

        <template v-else-if="activeTab === 'rooms'">
          <button
            v-for="room in filteredRooms"
            :key="room.id"
            type="button"
            class="internal-chat-row"
            :class="{ active: Number(room.id) === Number(currentRoomId) }"
            @click="openRoom(room.id)"
          >
            <span class="avatar" :class="{ group: room.kind === 'group' }">
              {{ initials(room.display_name || room.title || 'Chat') }}
            </span>
            <span class="internal-chat-row__body">
              <strong>{{ room.display_name || room.title || 'Conversa' }}</strong>
              <small>{{ room.last_message || 'Sem mensagens ainda' }}</small>
            </span>
            <span class="internal-chat-row__meta">
              <time>{{ formatTime(room.last_message_at || room.updated_at) }}</time>
              <em v-if="Number(room.unread_count || 0) > 0">{{ room.unread_count }}</em>
            </span>
          </button>

          <div v-if="!filteredRooms.length" class="internal-chat-empty-list">
            Nenhuma conversa ainda.
          </div>
        </template>

        <template v-else>
          <button
            v-for="agent in filteredAgents"
            :key="agent.id"
            type="button"
            class="internal-chat-row"
            @click="startDm(agent.id)"
          >
            <span class="avatar" :class="{ online: isOnline(agent.id) }">
              {{ initials(agent.name || agent.email) }}
            </span>
            <span class="internal-chat-row__body">
              <strong>{{ agent.name || agent.email }}</strong>
              <small>{{ isOnline(agent.id) ? 'Online agora' : agent.email }}</small>
            </span>
          </button>

          <div v-if="!filteredAgents.length" class="internal-chat-empty-list">
            Nenhum agente encontrado.
          </div>
        </template>
      </div>
    </aside>

    <section class="internal-chat-thread bg-n-solid-1">
      <header class="internal-chat-thread__header border-n-weak">
        <div>
          <h2>{{ roomTitle }}</h2>
          <p>{{ roomSubtitle }}</p>
        </div>
      </header>

      <div ref="messagesEl" class="internal-chat-messages">
        <div v-if="!currentRoomId && !loadingRoom" class="internal-chat-empty-thread">
          <div>
            <i class="i-lucide-messages-square" />
            <strong>Escolha uma conversa interna</strong>
            <span>Converse com outro agente sem sair do atendimento.</span>
            <button type="button" @click="activeTab = 'agents'">
              Iniciar conversa
            </button>
          </div>
        </div>

        <div v-else-if="loadingRoom" class="internal-chat-loading">
          <span /><span /><span />
        </div>

        <template v-else>
          <article
            v-for="message in messages"
            :key="message.id"
            class="internal-chat-bubble"
            :class="{ mine: Number(message.sender_id) === userId }"
          >
            <header>
              <strong>
                {{ Number(message.sender_id) === userId ? 'Voce' : message.sender_name }}
              </strong>
              <time>{{ formatTime(message.created_at) }}</time>
            </header>
            <div
              v-if="message.attachment_kind"
              class="internal-chat-attachment"
              :class="message.attachment_kind"
            >
              <img
                v-if="message.attachment_kind === 'image'"
                :src="attachmentUrl(message)"
                :alt="attachmentLabel(message)"
              >
              <audio
                v-else-if="message.attachment_kind === 'audio'"
                :src="attachmentUrl(message)"
                controls
              />
              <a
                v-else
                :href="attachmentUrl(message)"
                :download="attachmentLabel(message)"
              >
                <i :class="attachmentIcon(message.attachment_kind)" />
                <span>
                  <strong>{{ attachmentLabel(message) }}</strong>
                  <small>{{ formatBytes(message.attachment_size) }}</small>
                </span>
              </a>
            </div>
            <p v-if="message.content">{{ message.content }}</p>
          </article>

          <div v-if="!messages.length" class="internal-chat-empty-thread">
            <div>
              <i class="i-lucide-message-circle-plus" />
              <strong>Comece a conversa por aqui</strong>
              <span>Essa conversa fica visivel apenas para os agentes envolvidos.</span>
            </div>
          </div>
        </template>
      </div>

      <div class="internal-chat-typing">
        <template v-if="[...typingUserIds].filter(id => Number(id) !== userId).length">
          {{ typingNames.join(', ') }} digitando...
        </template>
      </div>

      <footer class="internal-chat-composer border-n-weak">
        <input
          ref="imageInputEl"
          class="hidden-input"
          type="file"
          accept="image/*"
          @change="handleFileSelection($event, 'image')"
        >
        <input
          ref="fileInputEl"
          class="hidden-input"
          type="file"
          @change="handleFileSelection($event)"
        >

        <div v-if="selectedAttachment" class="internal-chat-attachment-preview">
          <img
            v-if="selectedAttachment.kind === 'image'"
            :src="selectedAttachment.previewUrl"
            :alt="selectedAttachment.name"
          >
          <i v-else :class="attachmentIcon(selectedAttachment.kind)" />
          <span>
            <strong>{{ selectedAttachment.name }}</strong>
            <small>{{ formatBytes(selectedAttachment.size) }}</small>
          </span>
          <button type="button" title="Remover anexo" @click="clearAttachment">
            <i class="i-lucide-x" />
          </button>
        </div>

        <div class="internal-chat-composer__row">
          <div class="internal-chat-tools">
            <button
              type="button"
              title="Enviar imagem"
              :disabled="!currentRoomId || sending"
              @click="imageInputEl?.click()"
            >
              <i class="i-lucide-image" />
            </button>
            <button
              type="button"
              title="Anexar arquivo"
              :disabled="!currentRoomId || sending"
              @click="fileInputEl?.click()"
            >
              <i class="i-lucide-paperclip" />
            </button>
            <button
              type="button"
              :title="recording ? 'Parar gravacao' : 'Gravar audio'"
              :class="{ recording }"
              :disabled="!currentRoomId || sending"
              @click="toggleRecording"
            >
              <i :class="recording ? 'i-lucide-square' : 'i-lucide-mic'" />
            </button>
          </div>

          <textarea
            ref="messageInputEl"
            v-model="messageInput"
            rows="1"
            :disabled="!currentRoomId || sending"
            :placeholder="currentRoomId ? 'Escreva uma mensagem interna' : 'Selecione uma conversa para responder'"
            @input="emitTyping"
            @keydown="handleComposerKeydown"
          />
          <button
            type="button"
            class="send-button"
            :disabled="!canSend"
            @click="sendMessage"
          >
            {{ sending ? 'Enviando' : 'Enviar' }}
          </button>
        </div>
      </footer>
    </section>

    <div v-if="notice" class="internal-chat-notice">
      {{ notice }}
    </div>

    <div
      v-if="showGroupDialog"
      class="internal-chat-dialog-backdrop"
      @click.self="showGroupDialog = false"
    >
      <section class="internal-chat-dialog">
        <header>
          <h2>Novo grupo</h2>
          <button type="button" class="icon-button" @click="showGroupDialog = false">
            <i class="i-lucide-x" />
          </button>
        </header>

        <label class="internal-chat-field">
          <span>Nome do grupo</span>
          <input v-model="groupTitle" type="text" placeholder="Ex: Suporte comercial">
        </label>

        <div class="internal-chat-checks">
          <label
            v-for="agent in filteredAgents"
            :key="agent.id"
          >
            <input
              v-model="groupParticipantIds"
              type="checkbox"
              :value="agent.id"
            >
            <span>{{ agent.name || agent.email }}</span>
          </label>
        </div>

        <footer>
          <button type="button" class="secondary" @click="showGroupDialog = false">
            Cancelar
          </button>
          <button type="button" @click="createGroup">
            Criar grupo
          </button>
        </footer>
      </section>
    </div>
  </main>
</template>

<style scoped>
.internal-chat-view {
  display: grid;
  grid-template-columns: 21.5rem minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.internal-chat-sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right-width: 1px;
  border-right-style: solid;
}

.internal-chat-sidebar__header,
.internal-chat-thread__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 3.75rem;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  padding: 0 1rem;
}

.internal-chat-sidebar__header h1,
.internal-chat-thread__header h2 {
  margin: 0;
  color: rgb(var(--slate-12));
  font-size: 0.9375rem;
  font-weight: 650;
}

.internal-chat-sidebar__header p,
.internal-chat-thread__header p {
  max-width: 18rem;
  margin: 0.125rem 0 0;
  overflow: hidden;
  color: rgb(var(--slate-10));
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-button {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid rgb(var(--slate-4));
  border-radius: 0.375rem;
  background: rgb(var(--slate-1));
  color: rgb(var(--slate-11));
}

.icon-button:hover {
  background: rgb(var(--slate-3));
}

.internal-chat-search {
  position: relative;
  margin: 0.75rem 0.75rem 0;
}

.internal-chat-search i {
  position: absolute;
  top: 50%;
  left: 0.75rem;
  width: 1rem;
  height: 1rem;
  color: rgb(var(--slate-9));
  transform: translateY(-50%);
}

.internal-chat-search input,
.internal-chat-field input {
  width: 100%;
  min-height: 2.375rem;
  border: 1px solid rgb(var(--slate-4));
  border-radius: 0.5rem;
  background: rgb(var(--slate-2));
  color: rgb(var(--slate-12));
  outline: none;
}

.internal-chat-search input {
  padding: 0.5rem 0.75rem 0.5rem 2.25rem;
}

.internal-chat-search input:focus,
.internal-chat-field input:focus,
.internal-chat-composer textarea:focus {
  border-color: rgb(var(--green-8));
  background: rgb(var(--white));
  box-shadow: 0 0 0 2px rgba(var(--green-7), 0.18);
}

.internal-chat-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.25rem;
  margin: 0.75rem;
  padding: 0.25rem;
  border-radius: 0.5rem;
  background: rgb(var(--slate-3));
}

.internal-chat-tabs button {
  min-height: 2rem;
  border: 0;
  border-radius: 0.375rem;
  background: transparent;
  color: rgb(var(--slate-10));
  font-size: 0.8125rem;
  font-weight: 650;
}

.internal-chat-tabs button.active {
  background: rgb(var(--white));
  color: rgb(var(--slate-12));
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
}

.internal-chat-list {
  min-height: 0;
  overflow: auto;
  padding: 0 0.5rem 0.75rem;
}

.internal-chat-row {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr) auto;
  gap: 0.625rem;
  align-items: center;
  width: 100%;
  min-height: 3.625rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  padding: 0.5rem;
  text-align: left;
}

.internal-chat-row:hover {
  background: rgb(var(--slate-2));
}

.internal-chat-row.active {
  border-color: rgba(var(--green-7), 0.45);
  background: rgba(var(--green-3), 0.72);
}

.avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  border: 1px solid rgb(var(--slate-5));
  border-radius: 999px;
  background: rgb(var(--slate-2));
  color: rgb(var(--slate-11));
  font-size: 0.75rem;
  font-weight: 700;
}

.avatar.online::after {
  content: "";
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 0.625rem;
  height: 0.625rem;
  border: 2px solid rgb(var(--white));
  border-radius: 999px;
  background: rgb(var(--green-8));
}

.avatar.group {
  border-color: rgba(var(--green-7), 0.55);
  background: rgba(var(--green-3), 0.9);
  color: rgb(var(--green-11));
}

.internal-chat-row__body {
  min-width: 0;
}

.internal-chat-row__body strong,
.internal-chat-row__body small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.internal-chat-row__body strong {
  color: rgb(var(--slate-12));
  font-size: 0.875rem;
  font-weight: 620;
}

.internal-chat-row__body small,
.internal-chat-row__meta time,
.internal-chat-muted,
.internal-chat-empty-list {
  color: rgb(var(--slate-10));
  font-size: 0.75rem;
}

.internal-chat-row__meta {
  display: grid;
  justify-items: end;
  gap: 0.25rem;
  align-self: start;
  padding-top: 0.1875rem;
}

.internal-chat-row__meta em {
  display: grid;
  place-items: center;
  min-width: 1.125rem;
  height: 1.125rem;
  border-radius: 999px;
  background: rgb(var(--green-9));
  color: rgb(var(--white));
  font-size: 0.6875rem;
  font-style: normal;
  font-weight: 700;
}

.internal-chat-muted,
.internal-chat-empty-list {
  padding: 1rem 0.75rem;
}

.internal-chat-thread {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  min-width: 0;
  min-height: 0;
}

.internal-chat-messages {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  min-height: 0;
  overflow: auto;
  background: rgb(var(--slate-2));
  padding: 1.25rem 1.5rem;
}

.internal-chat-bubble {
  max-width: min(42rem, 78%);
  border: 1px solid rgb(var(--slate-4));
  border-radius: 0.5rem;
  background: rgb(var(--white));
  padding: 0.5625rem 0.6875rem;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}

.internal-chat-bubble.mine {
  align-self: flex-end;
  border-color: rgba(var(--green-7), 0.45);
  background: rgba(var(--green-3), 0.82);
}

.internal-chat-bubble header {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
  color: rgb(var(--slate-10));
  font-size: 0.6875rem;
}

.internal-chat-bubble p {
  margin: 0;
  color: rgb(var(--slate-12));
  font-size: 0.875rem;
  line-height: 1.45;
  white-space: pre-wrap;
}

.internal-chat-attachment {
  margin-bottom: 0.5rem;
}

.internal-chat-attachment.image img {
  display: block;
  max-width: min(24rem, 100%);
  max-height: 18rem;
  border-radius: 0.5rem;
  object-fit: contain;
}

.internal-chat-attachment.audio audio {
  display: block;
  width: min(20rem, 100%);
}

.internal-chat-attachment a {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-width: min(18rem, 100%);
  border: 1px solid rgb(var(--slate-4));
  border-radius: 0.5rem;
  background: rgb(var(--slate-1));
  color: rgb(var(--slate-12));
  padding: 0.625rem;
  text-decoration: none;
}

.internal-chat-attachment a i {
  width: 1.25rem;
  height: 1.25rem;
  color: rgb(var(--slate-10));
}

.internal-chat-attachment a span,
.internal-chat-attachment a strong,
.internal-chat-attachment a small {
  display: block;
  min-width: 0;
}

.internal-chat-attachment a strong {
  overflow: hidden;
  color: rgb(var(--slate-12));
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.internal-chat-attachment a small {
  color: rgb(var(--slate-10));
  font-size: 0.75rem;
}

.internal-chat-empty-thread,
.internal-chat-loading {
  display: grid;
  place-items: center;
  min-height: 100%;
  text-align: center;
}

.internal-chat-empty-thread > div {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
  width: min(22rem, 90%);
  color: rgb(var(--slate-10));
  font-size: 0.875rem;
}

.internal-chat-empty-thread i {
  width: 2rem;
  height: 2rem;
  color: rgb(var(--slate-9));
}

.internal-chat-empty-thread strong {
  color: rgb(var(--slate-12));
  font-size: 1rem;
  font-weight: 650;
}

.internal-chat-empty-thread button {
  min-height: 2.125rem;
  margin-top: 0.375rem;
  border: 1px solid rgb(var(--slate-5));
  border-radius: 0.375rem;
  background: rgb(var(--white));
  color: rgb(var(--slate-12));
  padding: 0.4375rem 0.75rem;
  font-weight: 650;
}

.internal-chat-loading {
  display: flex;
  justify-content: center;
  gap: 0.375rem;
}

.internal-chat-loading span {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 999px;
  background: rgb(var(--slate-9));
  animation: pulse 0.9s ease-in-out infinite;
}

.internal-chat-loading span:nth-child(2) {
  animation-delay: 0.12s;
}

.internal-chat-loading span:nth-child(3) {
  animation-delay: 0.24s;
}

@keyframes pulse {
  0%,
  80%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }

  40% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

.internal-chat-typing {
  min-height: 1.5rem;
  background: rgb(var(--slate-2));
  color: rgb(var(--slate-10));
  font-size: 0.75rem;
  padding: 0.25rem 1.5rem 0;
}

.internal-chat-composer {
  display: grid;
  gap: 0.5rem;
  border-top-width: 1px;
  border-top-style: solid;
  padding: 0.75rem 1rem;
}

.internal-chat-composer__row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.625rem;
  align-items: end;
}

.hidden-input {
  display: none;
}

.internal-chat-tools {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-height: 2.625rem;
}

.internal-chat-tools button,
.internal-chat-attachment-preview button {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  background: transparent;
  color: rgb(var(--slate-10));
  padding: 0;
}

.internal-chat-tools button:hover,
.internal-chat-attachment-preview button:hover {
  background: rgb(var(--slate-3));
  color: rgb(var(--slate-12));
}

.internal-chat-tools button.recording {
  border-color: rgba(var(--red-7), 0.45);
  background: rgba(var(--red-3), 0.9);
  color: rgb(var(--red-10));
}

.internal-chat-tools button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.internal-chat-tools i,
.internal-chat-attachment-preview button i {
  width: 1rem;
  height: 1rem;
}

.internal-chat-attachment-preview {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr) auto;
  gap: 0.625rem;
  align-items: center;
  width: min(26rem, 100%);
  border: 1px solid rgb(var(--slate-4));
  border-radius: 0.5rem;
  background: rgb(var(--slate-2));
  padding: 0.5rem;
}

.internal-chat-attachment-preview img {
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 0.375rem;
  object-fit: cover;
}

.internal-chat-attachment-preview > i {
  width: 1.25rem;
  height: 1.25rem;
  justify-self: center;
  color: rgb(var(--slate-10));
}

.internal-chat-attachment-preview span,
.internal-chat-attachment-preview strong,
.internal-chat-attachment-preview small {
  display: block;
  min-width: 0;
}

.internal-chat-attachment-preview strong {
  overflow: hidden;
  color: rgb(var(--slate-12));
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.internal-chat-attachment-preview small {
  color: rgb(var(--slate-10));
  font-size: 0.75rem;
}

.internal-chat-composer textarea {
  width: 100%;
  min-height: 2.625rem;
  max-height: 7.5rem;
  border: 1px solid rgb(var(--slate-5));
  border-radius: 0.5rem;
  background: rgb(var(--white));
  color: rgb(var(--slate-12));
  line-height: 1.4;
  outline: none;
  padding: 0.625rem 0.75rem;
  resize: vertical;
}

.internal-chat-composer .send-button,
.internal-chat-dialog footer button {
  min-height: 2.625rem;
  border: 1px solid rgb(var(--green-9));
  border-radius: 0.375rem;
  background: rgb(var(--green-9));
  color: rgb(var(--white));
  padding: 0.5rem 0.875rem;
  font-weight: 650;
}

.internal-chat-composer .send-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.internal-chat-notice {
  position: fixed;
  right: 1.125rem;
  bottom: 1.125rem;
  z-index: 80;
  max-width: min(22rem, calc(100vw - 2.25rem));
  border: 1px solid rgba(var(--red-7), 0.45);
  border-radius: 0.5rem;
  background: rgb(var(--white));
  color: rgb(var(--slate-12));
  box-shadow: 0 12px 30px rgba(16, 24, 40, 0.16);
  font-size: 0.8125rem;
  padding: 0.625rem 0.75rem;
}

.internal-chat-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  background: rgba(16, 24, 40, 0.32);
  padding: 1rem;
}

.internal-chat-dialog {
  display: grid;
  gap: 1rem;
  width: min(28rem, 100%);
  border: 1px solid rgb(var(--slate-4));
  border-radius: 0.5rem;
  background: rgb(var(--white));
  box-shadow: 0 24px 48px rgba(16, 24, 40, 0.18);
  padding: 1rem;
}

.internal-chat-dialog header,
.internal-chat-dialog footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.internal-chat-dialog h2 {
  margin: 0;
  color: rgb(var(--slate-12));
  font-size: 0.9375rem;
  font-weight: 650;
}

.internal-chat-field {
  display: grid;
  gap: 0.375rem;
}

.internal-chat-field span {
  color: rgb(var(--slate-10));
  font-size: 0.75rem;
}

.internal-chat-field input {
  padding: 0.5rem 0.625rem;
}

.internal-chat-checks {
  display: grid;
  gap: 0.5rem;
  max-height: 16rem;
  overflow: auto;
}

.internal-chat-checks label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: rgb(var(--slate-12));
  font-size: 0.875rem;
}

.internal-chat-dialog footer {
  justify-content: flex-end;
}

.internal-chat-dialog footer button.secondary {
  border-color: rgb(var(--slate-5));
  background: rgb(var(--white));
  color: rgb(var(--slate-12));
}

@media (max-width: 900px) {
  .internal-chat-view {
    grid-template-columns: 18rem minmax(0, 1fr);
  }
}
</style>
