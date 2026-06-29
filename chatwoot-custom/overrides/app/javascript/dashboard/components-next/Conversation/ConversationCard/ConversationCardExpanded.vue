<script setup>
import { computed, useTemplateRef } from 'vue';
import { getLastMessage } from 'dashboard/helper/conversationHelper';
import CardAvatar from './CardAvatar.vue';
import CardContent from './CardContent.vue';
import CardLabels from './CardLabelsV5.vue';
import CardPriorityIcon from './CardPriorityIcon.vue';
import InboxName from 'dashboard/components-next/Conversation/InboxName.vue';
import Avatar from 'next/avatar/Avatar.vue';
import TimeAgo from 'dashboard/components/ui/TimeAgo.vue';
import SLACardLabel from 'dashboard/components-next/Conversation/Sla/SLACardLabel.vue';
import CardStatusIcon from './CardStatusIcon.vue';
import Checkbox from 'dashboard/components-next/checkbox/Checkbox.vue';
import Icon from 'dashboard/components-next/icon/Icon.vue';
import { useMapGetter } from 'dashboard/composables/store';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';

const props = defineProps({
  chat: { type: Object, required: true },
  currentContact: { type: Object, required: true },
  assignee: { type: Object, default: () => ({}) },
  inbox: { type: Object, default: () => ({}) },
  selected: { type: Boolean, default: false },
  isActiveChat: { type: Boolean, default: false },
  showAssignee: { type: Boolean, default: false },
  showInboxName: { type: Boolean, default: false },
  isInboxView: { type: Boolean, default: false },
});

const emit = defineEmits([
  'selectConversation',
  'deSelectConversation',
  'click',
  'contextmenu',
]);

const currentUser = useMapGetter('getCurrentUser');
const currentAccountId = useMapGetter('getCurrentAccountId');
const currentRole = useMapGetter('getCurrentRole');

const contactDisplayName = computed(() => {
  return (
    props.currentContact.name ||
    props.currentContact.phone_number ||
    props.currentContact.identifier ||
    props.currentContact.email ||
    'Contato sem nome'
  );
});

const lastMessageInChat = computed(() => getLastMessage(props.chat));
const isSimpleAgentMode = computed(() =>
  isAgentSimpleMode(
    currentUser.value,
    currentAccountId.value,
    currentRole.value
  )
);
const showLabelsSection = computed(
  () => !isSimpleAgentMode.value && props.chat.labels?.length > 0
);

const voiceCallData = computed(() => {
  const last = lastMessageInChat.value;
  if (last?.content_type !== 'voice_call' || !last.call) {
    return { status: null, direction: null };
  }
  return {
    status: last.call.status,
    direction: last.call.direction === 'outgoing' ? 'outbound' : 'inbound',
  };
});

const unreadCount = computed(() => props.chat.unread_count);

const slaCardLabel = useTemplateRef('slaCardLabel');

const hasSlaPolicyId = computed(
  () =>
    !isSimpleAgentMode.value &&
    (props.chat?.sla_policy_id || slaCardLabel.value?.hasSlaThreshold)
);

const selectedModel = computed({
  get: () => props.selected,
  set: value => {
    if (value) {
      emit('selectConversation', props.chat.id, props.inbox.id);
    } else {
      emit('deSelectConversation', props.chat.id, props.inbox.id);
    }
  },
});
</script>

<template>
  <div
    class="conversation relative cursor-pointer group grid gap-4 items-center px-3 h-12 border-b border-n-slate-3 hover:border-n-surface-1 hover:z-[1] before:content-[none] before:absolute before:-top-px before:inset-x-0 before:h-px before:bg-n-surface-1 before:pointer-events-none hover:before:content-['']"
    :class="{
      'active animate-card-select bg-n-alpha-1 dark:bg-n-alpha-3 !border-n-surface-1':
        isActiveChat,
      'selected bg-n-slate-2 dark:bg-n-slate-3 !border-n-surface-1': selected,
      'hover:bg-n-alpha-1': !isActiveChat && !selected,
      'mx-2 mb-1 h-[4.5rem] rounded-2xl border border-transparent hover:bg-n-alpha-2':
        isSimpleAgentMode,
      '!border-n-brand bg-n-alpha-2': isSimpleAgentMode && isActiveChat,
      'grid-cols-[minmax(0,2fr)_minmax(0,1fr)]': showLabelsSection,
      'grid-cols-[minmax(0,2fr)_max-content]': !showLabelsSection,
    }"
    @click="$emit('click', $event)"
    @contextmenu="$emit('contextmenu', $event)"
  >
    <!-- LEFT SECTION -->
    <div class="flex items-center gap-2 min-w-0 flex-1">
      <div class="flex items-center justify-center flex-shrink-0" @click.stop>
        <Checkbox v-model="selectedModel" />
      </div>

      <div
        v-if="!isSimpleAgentMode"
        class="w-px h-3 bg-n-slate-6 flex-shrink-0"
      />

      <div
        v-if="!isSimpleAgentMode"
        class="w-4 flex items-center justify-center flex-shrink-0"
      >
        <CardPriorityIcon :priority="chat.priority" show-empty />
      </div>

      <div
        v-if="!isSimpleAgentMode"
        class="w-4 flex items-center justify-center flex-shrink-0"
      >
        <Avatar
          v-if="showAssignee && assignee.name"
          v-tooltip.top="{
            content: assignee.name,
            delay: { show: 500, hide: 0 },
          }"
          :name="assignee.name"
          :src="assignee.thumbnail"
          :size="14"
          :status="assignee.availability_status"
          hide-offline-status
        />
        <Icon
          v-else
          icon="i-woot-empty-assignee"
          class="size-4 text-n-slate-7"
        />
      </div>

      <div
        v-if="!isSimpleAgentMode"
        class="w-4 flex items-center justify-center flex-shrink-0"
      >
        <CardStatusIcon :status="chat.status" show-empty />
      </div>

      <div
        v-if="!isSimpleAgentMode"
        class="w-px h-3 bg-n-slate-6 flex-shrink-0"
      />

      <div
        v-if="!isSimpleAgentMode && !isInboxView && showInboxName"
        class="w-20 flex-shrink-0"
      >
        <InboxName v-if="showInboxName" :inbox="inbox" class="min-w-0" />
      </div>

      <div
        v-if="!isSimpleAgentMode && !isInboxView && showInboxName"
        class="w-px h-3 bg-n-slate-6 flex-shrink-0"
      />

      <div
        v-if="!isSimpleAgentMode"
        v-tooltip.top="{
          content: chat.id,
          delay: { show: 500, hide: 0 },
        }"
        class="h-6 flex items-center gap-1 max-w-20 w-full min-w-0 flex-shrink-0"
      >
        <Icon
          icon="i-woot-hash"
          class="size-3.5 text-n-slate-10 flex-shrink-0"
        />
        <span class="text-body-main text-n-slate-11 truncate">
          {{ chat.id }}
        </span>
      </div>

      <CardAvatar
        :contact="currentContact"
        :selected="false"
        :enable-selection="false"
        :hide-thumbnail="false"
      />

      <h4
        class="my-0 capitalize truncate text-n-slate-12 flex-shrink-0"
        :class="
          isSimpleAgentMode
            ? 'text-sm font-semibold w-36'
            : 'text-heading-3 font-medium w-32'
        "
      >
        {{ contactDisplayName }}
      </h4>

      <CardContent
        :last-message="lastMessageInChat"
        :voice-call-status="voiceCallData.status"
        :voice-call-direction="voiceCallData.direction"
        :unread-count="unreadCount"
        :show-expanded-preview="false"
      />
    </div>

    <!-- RIGHT SECTION -->
    <div class="flex items-center justify-end gap-1.5 flex-shrink-0">
      <div v-if="showLabelsSection" class="min-w-0 w-full">
        <CardLabels
          :labels="chat.labels"
          disable-toggle
          class="my-0 [&>div]:justify-end justify-end"
        />
      </div>

      <div v-if="hasSlaPolicyId" class="flex-shrink-0">
        <SLACardLabel ref="slaCardLabel" :chat="chat" />
      </div>

      <div class="flex-shrink-0 w-[4.375rem] text-end">
        <TimeAgo
          :conversation-id="chat.id"
          :last-activity-timestamp="chat.timestamp"
          :created-at-timestamp="chat.created_at"
          class="font-440 text-n-slate-11"
          :class="isSimpleAgentMode ? '!text-[0.6875rem]' : '!text-xs'"
        />
      </div>
    </div>
  </div>
</template>
