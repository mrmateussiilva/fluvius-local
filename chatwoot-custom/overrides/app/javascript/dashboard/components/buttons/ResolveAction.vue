<script setup>
import { ref, computed } from 'vue';
import { useAlert } from 'dashboard/composables';
import { useToggle } from '@vueuse/core';
import { useI18n } from 'vue-i18n';
import {
  useMapGetter,
  useStore,
  useStoreGetters,
} from 'dashboard/composables/store';
import { useEmitter } from 'dashboard/composables/emitter';
import { useKeyboardEvents } from 'dashboard/composables/useKeyboardEvents';
import { useConversationRequiredAttributes } from 'dashboard/composables/useConversationRequiredAttributes';

import WootDropdownItem from 'shared/components/ui/dropdown/DropdownItem.vue';
import WootDropdownMenu from 'shared/components/ui/dropdown/DropdownMenu.vue';
import wootConstants from 'dashboard/constants/globals';
import {
  CMD_REOPEN_CONVERSATION,
  CMD_RESOLVE_CONVERSATION,
} from 'dashboard/helper/commandbar/events';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';

import ButtonGroup from 'dashboard/components-next/buttonGroup/ButtonGroup.vue';
import Button from 'dashboard/components-next/button/Button.vue';
import ConversationResolveAttributesModal from 'dashboard/components-next/ConversationWorkflow/ConversationResolveAttributesModal.vue';

const store = useStore();
const getters = useStoreGetters();
const { t } = useI18n();
const { checkMissingAttributes } = useConversationRequiredAttributes();

const arrowDownButtonRef = ref(null);
const isLoading = ref(false);
const resolveAttributesModalRef = ref(null);

const [showActionsDropdown, toggleDropdown] = useToggle();
const closeDropdown = () => toggleDropdown(false);
const openDropdown = () => toggleDropdown(true);

const currentChat = computed(() => getters.getSelectedChat.value);
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

const isOpen = computed(
  () => currentChat.value.status === wootConstants.STATUS_TYPE.OPEN
);
const isPending = computed(
  () => currentChat.value.status === wootConstants.STATUS_TYPE.PENDING
);
const isResolved = computed(
  () => currentChat.value.status === wootConstants.STATUS_TYPE.RESOLVED
);
const isSnoozed = computed(
  () => currentChat.value.status === wootConstants.STATUS_TYPE.SNOOZED
);

const showAdditionalActions = computed(
  () => !isPending.value && !isSnoozed.value
);

const showOpenButton = computed(() => {
  return isPending.value || isSnoozed.value;
});

const resolveActionLabel = computed(() => {
  return isSimpleMode.value
    ? t('CONVERSATION.HEADER.FINALIZE_ATTENDANCE_ACTION')
    : t('CONVERSATION.HEADER.RESOLVE_ACTION');
});

const getConversationParams = () => {
  const allConversations = document.querySelectorAll(
    '.conversations-list .conversation'
  );

  const activeConversation = document.querySelector(
    'div.conversations-list div.conversation.active'
  );
  const activeConversationIndex = [...allConversations].indexOf(
    activeConversation
  );
  const lastConversationIndex = allConversations.length - 1;

  return {
    all: allConversations,
    activeIndex: activeConversationIndex,
    lastIndex: lastConversationIndex,
  };
};

const openSnoozeModal = () => {
  const ninja = document.querySelector('ninja-keys');
  ninja.open({ parent: 'snooze_conversation' });
};

const toggleStatus = (status, snoozedUntil, customAttributes = null) => {
  closeDropdown();
  isLoading.value = true;

  const payload = {
    conversationId: currentChat.value.id,
    status,
    snoozedUntil,
  };

  if (customAttributes) {
    payload.customAttributes = customAttributes;
  }

  store
    .dispatch('toggleStatus', payload)
    .then(() => {
      if (isSimpleMode.value && status === wootConstants.STATUS_TYPE.RESOLVED) {
        useAlert(t('CONVERSATION.FEEDBACK.FINALIZED'));
      } else {
        useAlert(t('CONVERSATION.CHANGE_STATUS'));
      }
    })
    .catch(() => {
      useAlert(t('CONVERSATION.FEEDBACK.ACTION_FAILED'));
    })
    .finally(() => {
      isLoading.value = false;
    });
};

const handleResolveWithAttributes = ({ attributes, context }) => {
  if (context) {
    const currentCustomAttributes = currentChat.value.custom_attributes || {};
    const mergedAttributes = { ...currentCustomAttributes, ...attributes };
    toggleStatus(
      wootConstants.STATUS_TYPE.RESOLVED,
      context.snoozedUntil,
      mergedAttributes
    );
  }
};

const onCmdOpenConversation = () => {
  toggleStatus(wootConstants.STATUS_TYPE.OPEN);
};

const onCmdResolveConversation = () => {
  const currentCustomAttributes = currentChat.value.custom_attributes || {};
  const { hasMissing, missing } = checkMissingAttributes(
    currentCustomAttributes
  );

  if (hasMissing) {
    const conversationContext = {
      id: currentChat.value.id,
      snoozedUntil: null,
    };
    resolveAttributesModalRef.value?.open(
      missing,
      currentCustomAttributes,
      conversationContext
    );
  } else {
    if (isSimpleMode.value) {
      useAlert(t('CONVERSATION.FEEDBACK.FINALIZING'));
    }
    toggleStatus(wootConstants.STATUS_TYPE.RESOLVED);
  }
};

const keyboardEvents = {
  'Alt+KeyM': {
    action: () => arrowDownButtonRef.value?.$el.click(),
    allowOnFocusedInput: true,
  },
  'Alt+KeyE': {
    action: async () => {
      onCmdResolveConversation();
    },
  },
  '$mod+Alt+KeyE': {
    action: async event => {
      const { all, activeIndex, lastIndex } = getConversationParams();
      onCmdResolveConversation();

      if (activeIndex < lastIndex) {
        all[activeIndex + 1].click();
      } else if (all.length > 1) {
        all[0].click();
        document.querySelector('.conversations-list').scrollTop = 0;
      }
      event.preventDefault();
    },
  },
};

useKeyboardEvents(keyboardEvents);

useEmitter(CMD_REOPEN_CONVERSATION, onCmdOpenConversation);
useEmitter(CMD_RESOLVE_CONVERSATION, onCmdResolveConversation);
</script>

<template>
  <div class="flex relative justify-end items-center resolve-actions">
    <ButtonGroup
      class="flex-shrink-0 outline-1 outline"
      :class="
        isSimpleMode
          ? 'rounded-full shadow-sm outline-transparent'
          : !showOpenButton
            ? 'rounded-lg shadow outline-n-container'
            : 'rounded-lg outline-transparent'
      "
    >
      <Button
        v-if="isOpen"
        :label="resolveActionLabel"
        size="sm"
        :color="isSimpleMode ? 'blue' : 'slate'"
        no-animation
        class="!outline-0"
        :class="
          showAdditionalActions
            ? 'ltr:rounded-r-none rtl:rounded-l-none'
            : isSimpleMode
              ? 'rounded-full'
              : ''
        "
        :is-loading="isLoading"
        @click="onCmdResolveConversation"
      />
      <Button
        v-else-if="isResolved"
        :label="t('CONVERSATION.HEADER.REOPEN_ACTION')"
        size="sm"
        :color="isSimpleMode ? 'blue' : 'slate'"
        no-animation
        class="!outline-0"
        :class="
          showAdditionalActions
            ? 'ltr:rounded-r-none rtl:rounded-l-none'
            : isSimpleMode
              ? 'rounded-full'
              : ''
        "
        :is-loading="isLoading"
        @click="onCmdOpenConversation"
      />
      <Button
        v-else-if="showOpenButton"
        :label="t('CONVERSATION.HEADER.OPEN_ACTION')"
        size="sm"
        :color="isSimpleMode ? 'blue' : 'slate'"
        no-animation
        :class="isSimpleMode ? 'rounded-full' : ''"
        :is-loading="isLoading"
        @click="onCmdOpenConversation"
      />
      <Button
        v-if="showAdditionalActions"
        ref="arrowDownButtonRef"
        icon="i-lucide-chevron-down"
        :disabled="isLoading"
        size="sm"
        no-animation
        class="ltr:rounded-l-none rtl:rounded-r-none !outline-0"
        :class="isSimpleMode ? 'bg-n-brand text-white hover:opacity-90' : ''"
        :color="isSimpleMode ? 'blue' : 'slate'"
        trailing-icon
        @click="openDropdown"
      />
    </ButtonGroup>
    <div
      v-if="showActionsDropdown"
      v-on-clickaway="closeDropdown"
      class="border rounded-lg shadow-lg border-n-strong dark:border-n-strong box-content p-2 w-fit z-10 bg-n-alpha-3 backdrop-blur-[100px] absolute block left-auto top-full mt-0.5 start-0 xl:start-auto xl:end-0 max-w-[12.5rem] min-w-[9.75rem] [&_ul>li]:mb-0"
    >
      <WootDropdownMenu class="mb-0">
        <WootDropdownItem v-if="!isPending">
          <Button
            :label="t('CONVERSATION.RESOLVE_DROPDOWN.SNOOZE_UNTIL')"
            ghost
            slate
            sm
            start
            icon="i-lucide-alarm-clock-minus"
            class="w-full"
            @click="() => openSnoozeModal()"
          />
        </WootDropdownItem>
        <WootDropdownItem v-if="!isPending">
          <Button
            :label="t('CONVERSATION.RESOLVE_DROPDOWN.MARK_PENDING')"
            ghost
            slate
            sm
            start
            icon="i-lucide-circle-dot-dashed"
            class="w-full"
            @click="() => toggleStatus(wootConstants.STATUS_TYPE.PENDING)"
          />
        </WootDropdownItem>
      </WootDropdownMenu>
    </div>
    <ConversationResolveAttributesModal
      ref="resolveAttributesModalRef"
      @submit="handleResolveWithAttributes"
    />
  </div>
</template>
