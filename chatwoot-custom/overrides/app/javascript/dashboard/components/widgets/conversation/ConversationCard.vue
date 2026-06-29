<script setup>
import { computed, ref, watch } from 'vue';
import { getLastMessage } from 'dashboard/helper/conversationHelper';
import { useMapGetter } from 'dashboard/composables/store';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';
import Avatar from 'next/avatar/Avatar.vue';
import MessagePreview from './MessagePreview.vue';
import InboxName from '../InboxName.vue';
import TimeAgo from 'dashboard/components/ui/TimeAgo.vue';
import CardLabels from './conversationCardComponents/CardLabels.vue';
import CardPriorityIcon from 'dashboard/components-next/Conversation/ConversationCard/CardPriorityIcon.vue';
import UnreadBadge from 'dashboard/components-next/Conversation/ConversationCard/UnreadBadge.vue';
import SLACardLabel from './components/SLACardLabel.vue';
import VoiceCallStatus from './VoiceCallStatus.vue';
import Checkbox from 'dashboard/components-next/checkbox/Checkbox.vue';

const props = defineProps({
  chat: { type: Object, required: true },
  currentContact: { type: Object, required: true },
  assignee: { type: Object, default: () => ({}) },
  inbox: { type: Object, default: () => ({}) },
  selected: { type: Boolean, default: false },
  isActiveChat: { type: Boolean, default: false },
  showAssignee: { type: Boolean, default: false },
  showInboxName: { type: Boolean, default: false },
  hideThumbnail: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
});

const emit = defineEmits([
  'click',
  'contextmenu',
  'selectConversation',
  'deSelectConversation',
]);

const currentUser = useMapGetter('getCurrentUser');
const currentAccountId = useMapGetter('getCurrentAccountId');
const currentRole = useMapGetter('getCurrentRole');
const hovered = ref(false);

const contactDisplayName = computed(() => {
  return (
    props.currentContact.name ||
    props.currentContact.phone_number ||
    props.currentContact.identifier ||
    props.currentContact.email ||
    'Contato sem nome'
  );
});

const isSimpleAgentMode = computed(() =>
  isAgentSimpleMode(
    currentUser.value,
    currentAccountId.value,
    currentRole.value
  )
);

const unreadCount = computed(() => props.chat.unread_count);
const hasUnread = computed(() => unreadCount.value > 0);
const displayUnreadCount = computed(() =>
  unreadCount.value > 99 ? '99+' : unreadCount.value
);
const lastMessageInChat = computed(() => getLastMessage(props.chat));

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

const showMetaSection = computed(() => {
  if (isSimpleAgentMode.value) return false;
  return (
    props.showInboxName ||
    (props.showAssignee && props.assignee.name) ||
    props.chat.priority
  );
});

const hasSlaPolicyId = computed(() => props.chat?.sla_policy_id);

const showLabelsSection = computed(() => {
  if (isSimpleAgentMode.value) return false;
  return props.chat.labels?.length > 0 || hasSlaPolicyId.value;
});

const messagePreviewClass = computed(() => {
  return [
    hasUnread.value ? 'font-medium text-n-slate-12' : 'text-n-slate-11',
    isSimpleAgentMode.value
      ? 'leading-5 h-5 line-clamp-1 ltr:pr-5 rtl:pl-5'
      : '',
    !props.compact && !isSimpleAgentMode.value && hasUnread.value
      ? 'ltr:pr-4 rtl:pl-4'
      : '',
    props.compact && !isSimpleAgentMode.value && hasUnread.value
      ? 'ltr:pr-6 rtl:pl-6'
      : '',
  ];
});

const onThumbnailHover = () => {
  hovered.value = !props.hideThumbnail;
};

const onThumbnailLeave = () => {
  hovered.value = false;
};

const onSelectConversation = checked => {
  if (checked) {
    emit('selectConversation', props.chat.id, props.inbox.id);
  } else {
    emit('deSelectConversation', props.chat.id, props.inbox.id);
  }
};

const selectedModel = computed({
  get: () => props.selected,
  set: value => onSelectConversation(value),
});

watch(
  () => props.chat.id,
  () => {
    hovered.value = false;
  }
);
</script>

<template>
  <div
    class="relative flex items-start flex-grow-0 flex-shrink-0 w-auto max-w-full py-0 cursor-pointer conversation group hover:z-[1]"
    :class="{
      'active animate-card-select bg-n-background !border-n-surface-1':
        isActiveChat && !isSimpleAgentMode,
      'selected bg-n-slate-2 !border-n-surface-1':
        selected && !isSimpleAgentMode,
      'mx-2 mb-1 rounded-xl border border-transparent px-0 transition hover:bg-n-alpha-2':
        isSimpleAgentMode,
      'border-b border-n-slate-3 hover:border-n-surface-1 hover:bg-n-alpha-1 dark:hover:bg-n-alpha-3 before:content-[none] before:absolute before:-top-px before:inset-x-0 before:h-px before:bg-n-surface-1 before:pointer-events-none hover:before:content-[\'\']':
        !isSimpleAgentMode,
      '!border-n-brand/40 bg-n-alpha-2 shadow-none ring-1 ring-n-brand/20':
        isSimpleAgentMode && isActiveChat,
      '!border-n-weak bg-n-alpha-2':
        isSimpleAgentMode && selected && !isActiveChat,
      'px-0': compact || isSimpleAgentMode,
      'px-3': !compact && !isSimpleAgentMode,
    }"
    @click="$emit('click', $event)"
    @contextmenu="$emit('contextmenu', $event)"
  >
    <div
      class="relative"
      @mouseenter="onThumbnailHover"
      @mouseleave="onThumbnailLeave"
    >
      <Avatar
        v-if="!hideThumbnail"
        :name="contactDisplayName"
        :src="currentContact.thumbnail"
        :size="isSimpleAgentMode ? 40 : 32"
        :status="
          currentContact.availability_status ||
          currentContact.availabilityStatus
        "
        :class="
          isSimpleAgentMode ? 'mt-4 ml-3' : !showInboxName ? 'mt-4' : 'mt-8'
        "
        hide-offline-status
      >
        <template #overlay="{ size }">
          <label
            v-if="hovered || selected"
            class="flex items-center justify-center rounded-full cursor-pointer absolute inset-0 z-10 backdrop-blur-[2px]"
            :style="{ width: `${size}px`, height: `${size}px` }"
            @click.stop
          >
            <Checkbox v-model="selectedModel" />
          </label>
        </template>
      </Avatar>
    </div>
    <div
      class="px-0 flex-1 min-w-0 border-line"
      :class="isSimpleAgentMode ? 'py-3 pr-3' : 'py-3'"
    >
      <div
        v-if="showMetaSection"
        class="flex items-center min-w-0 gap-1"
        :class="{
          'ltr:ml-2 rtl:mr-2': !compact,
          'mx-2': compact,
        }"
      >
        <InboxName v-if="showInboxName" :inbox="inbox" class="flex-1 min-w-0" />
        <div
          class="flex items-baseline gap-2 flex-shrink-0"
          :class="{
            'flex-1 justify-between': !showInboxName,
          }"
        >
          <span
            v-if="showAssignee && assignee.name"
            class="text-n-slate-11 text-xs font-medium leading-3 py-0.5 px-0 inline-flex items-center truncate"
          >
            <fluent-icon icon="person" size="12" class="text-n-slate-11" />
            {{ assignee.name }}
          </span>
          <CardPriorityIcon
            :priority="chat.priority"
            class="flex-shrink-0 !size-3.5"
          />
        </div>
      </div>
      <h4
        class="conversation--user my-0 mx-2 capitalize text-ellipsis overflow-hidden whitespace-nowrap flex-1 min-w-0 text-n-slate-12"
        :class="
          isSimpleAgentMode
            ? 'text-sm pt-0 ltr:pr-12 rtl:pl-12 font-semibold'
            : hasUnread
              ? 'text-sm pt-0.5 ltr:pr-16 rtl:pl-16 font-semibold'
              : 'text-sm pt-0.5 ltr:pr-16 rtl:pl-16 font-medium'
        "
      >
        {{ contactDisplayName }}
      </h4>
      <VoiceCallStatus
        v-if="voiceCallData.status"
        key="voice-status-row"
        :status="voiceCallData.status"
        :direction="voiceCallData.direction"
        :message-preview-class="messagePreviewClass"
      />
      <MessagePreview
        v-else-if="lastMessageInChat"
        key="message-preview"
        :message="lastMessageInChat"
        class="my-0 mx-2 flex-1 min-w-0 text-sm"
        :class="messagePreviewClass"
      />
      <p
        v-else
        key="no-messages"
        class="text-n-slate-11 text-sm my-0 mx-2 leading-6 h-6 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        :class="messagePreviewClass"
      >
        <fluent-icon
          size="16"
          class="-mt-0.5 align-middle inline-block text-n-slate-10"
          icon="info"
        />
        <span class="mx-0.5">
          {{ $t(`CHAT_LIST.NO_MESSAGES`) }}
        </span>
      </p>
      <div
        class="absolute flex flex-col ltr:right-3 rtl:left-3"
        :class="
          isSimpleAgentMode ? 'top-4' : showMetaSection ? 'top-8' : 'top-4'
        "
      >
        <button
          v-if="isSimpleAgentMode"
          v-tooltip="$t('CONVERSATION.HEADER.MORE_ACTIONS')"
          type="button"
          class="absolute -top-1 hidden size-7 items-center justify-center rounded-full bg-n-solid-1 text-n-slate-10 shadow-sm transition hover:text-n-slate-12 ltr:right-0 rtl:left-0 group-hover:inline-flex"
          @click.stop="$emit('contextmenu', $event)"
        >
          <span class="i-lucide-more-vertical size-4" />
        </button>
        <span
          class="ml-auto font-normal leading-4"
          :class="
            isSimpleAgentMode
              ? 'text-[0.6875rem] text-n-slate-10 transition-opacity group-hover:opacity-0'
              : 'text-xxs'
          "
        >
          <TimeAgo
            :last-activity-timestamp="chat.timestamp"
            :created-at-timestamp="chat.created_at"
            :conversation-id="chat.id"
          />
        </span>
        <UnreadBadge
          v-if="hasUnread"
          :count="displayUnreadCount"
          class="ltr:ml-auto rtl:mr-auto"
          :class="isSimpleAgentMode ? 'mt-2' : 'mt-1'"
        />
      </div>
      <CardLabels
        v-if="showLabelsSection"
        :conversation-labels="chat.labels"
        class="mt-0.5 mx-2 mb-0"
      >
        <template v-if="hasSlaPolicyId" #before>
          <SLACardLabel :chat="chat" class="ltr:mr-1 rtl:ml-1" />
        </template>
      </CardLabels>
    </div>
  </div>
</template>
