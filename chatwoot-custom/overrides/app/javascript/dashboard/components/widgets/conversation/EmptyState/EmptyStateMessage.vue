<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMapGetter } from 'dashboard/composables/store';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';

import FeaturePlaceholder from './FeaturePlaceholder.vue';

const props = defineProps({
  message: {
    type: String,
    required: true,
  },
});

const { t } = useI18n();
const currentUser = useMapGetter('getCurrentUser');
const currentAccountId = useMapGetter('getCurrentAccountId');
const currentRole = useMapGetter('getCurrentRole');

const isSimpleMode = computed(() =>
  isAgentSimpleMode(
    currentUser.value,
    currentAccountId.value,
    currentRole.value
  )
);

const isConversationSelectionPrompt = computed(
  () => props.message === t('CONVERSATION.SELECT_A_CONVERSATION')
);

const displayMessage = computed(() => {
  if (isSimpleMode.value && isConversationSelectionPrompt.value) {
    return t('CONVERSATION.SIMPLE_EMPTY_STATE_TITLE');
  }

  return props.message;
});

const shouldShowSimpleSubtitle = computed(
  () => isSimpleMode.value && isConversationSelectionPrompt.value
);

const shouldShowFeaturePlaceholder = computed(
  () => !(isSimpleMode.value && isConversationSelectionPrompt.value)
);

const emitAgentMessengerAction = detail => {
  window.dispatchEvent(
    new CustomEvent('fluvius:agent-messenger-action', { detail })
  );
};
</script>

<template>
  <div
    class="flex flex-col items-center justify-center h-full"
    :class="isSimpleMode ? 'agent-empty-state px-6 text-center' : ''"
  >
    <img
      v-if="!isSimpleMode"
      class="m-4 w-32 hidden dark:block"
      src="dashboard/assets/images/no-chat-dark.svg"
      alt="No Chat dark"
    />
    <img
      v-if="!isSimpleMode"
      class="m-4 w-32 block dark:hidden"
      src="dashboard/assets/images/no-chat.svg"
      alt="No Chat"
    />
    <span
      class="text-n-slate-12 text-center"
      :class="isSimpleMode ? 'text-base font-semibold' : 'text-sm font-medium'"
    >
      {{ displayMessage }}
    </span>
    <span
      v-if="shouldShowSimpleSubtitle"
      class="mt-2 text-center text-n-slate-10"
      :class="isSimpleMode ? 'text-sm max-w-xs leading-6' : 'text-sm'"
    >
      {{ $t('CONVERSATION.SIMPLE_EMPTY_STATE_SUBTITLE') }}
    </span>
    <div
      v-if="shouldShowSimpleSubtitle"
      class="mt-5 flex flex-wrap items-center justify-center gap-2"
    >
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-full bg-n-brand px-4 py-2 text-sm font-medium text-white"
        @click="emitAgentMessengerAction({ action: 'new_conversation' })"
      >
        <span class="i-lucide-message-circle-plus size-4" />
        {{ $t('CONVERSATION.SIMPLE_EMPTY_ACTIONS.NEW_CONVERSATION') }}
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-full bg-n-alpha-2 px-4 py-2 text-sm font-medium text-n-slate-11"
        @click="emitAgentMessengerAction({ filter: 'unassigned' })"
      >
        <span class="i-lucide-user-plus size-4" />
        {{ $t('CONVERSATION.SIMPLE_EMPTY_ACTIONS.NEW_CUSTOMERS') }}
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-full bg-n-alpha-2 px-4 py-2 text-sm font-medium text-n-slate-11"
        @click="emitAgentMessengerAction({ filter: 'unread' })"
      >
        <span class="i-lucide-mail-open size-4" />
        {{ $t('CONVERSATION.SIMPLE_EMPTY_ACTIONS.UNREAD') }}
      </button>
    </div>
    <FeaturePlaceholder v-if="shouldShowFeaturePlaceholder" />
  </div>
</template>
