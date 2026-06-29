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
</script>

<template>
  <div class="flex flex-col items-center justify-center h-full">
    <img
      class="m-4 w-32 hidden dark:block"
      src="dashboard/assets/images/no-chat-dark.svg"
      alt="No Chat dark"
    />
    <img
      class="m-4 w-32 block dark:hidden"
      src="dashboard/assets/images/no-chat.svg"
      alt="No Chat"
    />
    <span class="text-sm text-n-slate-12 font-medium text-center">
      {{ displayMessage }}
    </span>
    <span
      v-if="shouldShowSimpleSubtitle"
      class="mt-2 text-sm text-n-slate-10 text-center"
    >
      {{ $t('CONVERSATION.SIMPLE_EMPTY_STATE_SUBTITLE') }}
    </span>
    <FeaturePlaceholder v-if="shouldShowFeaturePlaceholder" />
  </div>
</template>
