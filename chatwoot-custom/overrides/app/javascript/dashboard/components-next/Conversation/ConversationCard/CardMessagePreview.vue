<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessageFormatter } from 'shared/composables/useMessageFormatter';
import { useMapGetter } from 'dashboard/composables/store';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';

import Avatar from 'dashboard/components-next/avatar/Avatar.vue';

const props = defineProps({
  conversation: {
    type: Object,
    required: true,
  },
  displayUnreadCount: {
    type: [String, Number],
    default: '',
  },
});

const { t } = useI18n();
const currentUser = useMapGetter('getCurrentUser');
const currentAccountId = useMapGetter('getCurrentAccountId');
const currentRole = useMapGetter('getCurrentRole');

const { getPlainText } = useMessageFormatter();

const lastNonActivityMessageContent = computed(() => {
  const {
    lastNonActivityMessage = {},
    customAttributes,
    custom_attributes,
  } = props.conversation;
  const attributes = customAttributes || custom_attributes || {};
  const { email: { subject } = {} } = attributes;
  return getPlainText(
    subject || lastNonActivityMessage?.content || t('CHAT_LIST.NO_CONTENT')
  );
});

const assignee = computed(() => {
  const { meta: { assignee: agent = {} } = {} } = props.conversation;
  return {
    name: agent.name ?? agent.availableName,
    thumbnail: agent.thumbnail,
    status: agent.availabilityStatus,
  };
});

const unreadMessagesCount = computed(() => {
  return props.conversation.unread_count || props.conversation.unreadCount || 0;
});

const isSimpleAgentMode = computed(() =>
  isAgentSimpleMode(
    currentUser.value,
    currentAccountId.value,
    currentRole.value
  )
);
</script>

<template>
  <div
    class="flex items-end w-full gap-2"
    :class="isSimpleAgentMode ? 'pb-0.5' : 'pb-1'"
  >
    <p
      class="w-full mb-0 text-sm text-n-slate-12"
      :class="
        isSimpleAgentMode ? 'leading-5 line-clamp-1' : 'leading-7 line-clamp-2'
      "
    >
      {{ lastNonActivityMessageContent }}
    </p>
    <div
      class="flex items-center flex-shrink-0 gap-2"
      :class="{ 'pb-2': !isSimpleAgentMode }"
    >
      <Avatar
        v-if="assignee.name && !isSimpleAgentMode"
        :name="assignee.name"
        :src="assignee.thumbnail"
        :size="20"
        :status="assignee.status"
        rounded-full
      />
      <div
        v-if="unreadMessagesCount > 0"
        class="inline-flex items-center justify-center rounded-full bg-n-brand"
        :class="isSimpleAgentMode ? 'min-w-5 h-5 px-1.5' : 'size-5'"
      >
        <span
          class="font-semibold text-white"
          :class="isSimpleAgentMode ? 'text-[0.625rem] leading-4' : 'text-xs'"
        >
          {{ displayUnreadCount || unreadMessagesCount }}
        </span>
      </div>
    </div>
  </div>
</template>
