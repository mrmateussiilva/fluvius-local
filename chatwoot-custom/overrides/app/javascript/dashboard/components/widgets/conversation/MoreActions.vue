<script setup>
import { computed, onUnmounted } from 'vue';
import { useToggle } from '@vueuse/core';
import { useStore } from 'vuex';
import { useMapGetter } from 'dashboard/composables/store';
import { useAlert } from 'dashboard/composables';
import { useI18n } from 'vue-i18n';
import { emitter } from 'shared/helpers/mitt';
import EmailTranscriptModal from './EmailTranscriptModal.vue';
import ResolveAction from '../../buttons/ResolveAction.vue';
import ButtonV4 from 'dashboard/components-next/button/Button.vue';
import DropdownMenu from 'dashboard/components-next/dropdown-menu/DropdownMenu.vue';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';
import { copyTextToClipboard } from 'shared/helpers/clipboard';
import wootConstants from 'dashboard/constants/globals';

import {
  CMD_MUTE_CONVERSATION,
  CMD_SEND_TRANSCRIPT,
  CMD_UNMUTE_CONVERSATION,
} from 'dashboard/helper/commandbar/events';

const store = useStore();
const { t } = useI18n();

const currentUser = useMapGetter('getCurrentUser');
const currentAccountId = useMapGetter('getCurrentAccountId');
const currentRole = useMapGetter('getCurrentRole');

const [showEmailActionsModal, toggleEmailModal] = useToggle(false);
const [showActionsDropdown, toggleDropdown] = useToggle(false);

const currentChat = computed(() => store.getters.getSelectedChat);
const currentContact = computed(() => {
  const senderId = currentChat.value?.meta?.sender?.id;
  if (!senderId) return currentChat.value?.meta?.sender || {};
  return store.getters['contacts/getContact'](senderId) || {};
});

const isSimpleMode = computed(() =>
  isAgentSimpleMode(
    currentUser.value,
    currentAccountId.value,
    currentRole.value
  )
);

const needsAssignmentToCurrentUser = computed(() => {
  const assigneeId = currentChat.value?.meta?.assignee?.id;
  return !assigneeId || assigneeId !== currentUser.value?.id;
});

const hasUnreadMessages = computed(
  () =>
    Number(
      currentChat.value?.unread_count || currentChat.value?.unreadCount || 0
    ) > 0
);

const isResolved = computed(
  () => currentChat.value?.status === wootConstants.STATUS_TYPE.RESOLVED
);

const contactPhone = computed(
  () =>
    currentContact.value?.phone_number ||
    currentChat.value?.meta?.sender?.phone_number ||
    ''
);

const assignButtonLabel = computed(() =>
  isSimpleMode.value
    ? t('CONVERSATION.HEADER.ASSUME_SHORT')
    : t('CONVERSATION.ASSUME_ATTENDANCE')
);

const actionMenuItems = computed(() => {
  const items = [];

  if (isSimpleMode.value) {
    if (needsAssignmentToCurrentUser.value) {
      items.push({
        icon: 'i-lucide-user-check',
        label: t('CONVERSATION.ASSUME_ATTENDANCE'),
        action: 'assign_to_me',
        value: 'assign_to_me',
      });
    }

    items.push({
      icon: hasUnreadMessages.value ? 'i-lucide-mail-open' : 'i-lucide-mail',
      label: hasUnreadMessages.value
        ? t('CONVERSATION.CARD_CONTEXT_MENU.MARK_AS_READ')
        : t('CONVERSATION.CARD_CONTEXT_MENU.MARK_AS_UNREAD'),
      action: hasUnreadMessages.value ? 'mark_read' : 'mark_unread',
      value: hasUnreadMessages.value ? 'mark_read' : 'mark_unread',
    });

    if (contactPhone.value) {
      items.push({
        icon: 'i-lucide-copy',
        label: t('CONVERSATION.CARD_CONTEXT_MENU.COPY_PHONE'),
        action: 'copy_phone',
        value: 'copy_phone',
      });
    }

    items.push({
      icon: isResolved.value ? 'i-lucide-archive-restore' : 'i-lucide-archive',
      label: isResolved.value
        ? t('CONVERSATION.CARD_CONTEXT_MENU.UNARCHIVE')
        : t('CONVERSATION.CARD_CONTEXT_MENU.ARCHIVE'),
      action: isResolved.value ? 'reopen' : 'archive',
      value: isResolved.value ? 'reopen' : 'archive',
    });

    if (!isResolved.value) {
      items.push({
        icon: 'i-lucide-check-check',
        label: t('CONVERSATION.HEADER.FINALIZE_ATTENDANCE_ACTION'),
        action: 'finalize',
        value: 'finalize',
      });
    }

    return items;
  }

  if (!currentChat.value.muted) {
    items.push({
      icon: 'i-lucide-volume-off',
      label: t('CONTACT_PANEL.MUTE_CONTACT'),
      action: 'mute',
      value: 'mute',
    });
  } else {
    items.push({
      icon: 'i-lucide-volume-1',
      label: t('CONTACT_PANEL.UNMUTE_CONTACT'),
      action: 'unmute',
      value: 'unmute',
    });
  }

  items.push({
    icon: 'i-lucide-share',
    label: t('CONTACT_PANEL.SEND_TRANSCRIPT'),
    action: 'send_transcript',
    value: 'send_transcript',
  });

  return items;
});

const handleActionClick = ({ action }) => {
  toggleDropdown(false);

  if (action === 'mute') {
    store.dispatch('muteConversation', currentChat.value.id);
    useAlert(t('CONTACT_PANEL.MUTED_SUCCESS'));
  } else if (action === 'unmute') {
    store.dispatch('unmuteConversation', currentChat.value.id);
    useAlert(t('CONTACT_PANEL.UNMUTED_SUCCESS'));
  } else if (action === 'send_transcript') {
    toggleEmailModal();
  }

  if (action === 'assign_to_me') {
    onAssignToMe();
  } else if (action === 'mark_unread') {
    markConversationUnread();
  } else if (action === 'mark_read') {
    markConversationRead();
  } else if (action === 'copy_phone') {
    copyPhone();
  } else if (action === 'archive' || action === 'finalize') {
    finalizeAttendance();
  } else if (action === 'reopen') {
    reopenConversation();
  }
};

const selfAssignConversation = async () => {
  const { avatar_url, ...rest } = currentUser.value || {};
  const agent = { ...rest, thumbnail: avatar_url };

  await store.dispatch('setCurrentChatAssignee', {
    conversationId: currentChat.value?.id,
    assignee: agent,
  });

  await store.dispatch('assignAgent', {
    conversationId: currentChat.value?.id,
    agentId: currentUser.value?.id,
  });
};

const onAssignToMe = async () => {
  try {
    useAlert(t('CONVERSATION.FEEDBACK.ASSIGNING'));
    await selfAssignConversation();
    useAlert(t('CONVERSATION.FEEDBACK.ASSIGNED'));
  } catch (error) {
    useAlert(t('CONVERSATION.FEEDBACK.ACTION_FAILED'));
  }
};

const markConversationUnread = async () => {
  try {
    await store.dispatch('markMessagesUnread', {
      id: currentChat.value.id,
    });
    useAlert(t('CONVERSATION.FEEDBACK.MARKED_UNREAD'));
  } catch (error) {
    useAlert(t('CONVERSATION.FEEDBACK.ACTION_FAILED'));
  }
};

const markConversationRead = async () => {
  try {
    await store.dispatch('markMessagesRead', {
      id: currentChat.value.id,
    });
    useAlert(t('CONVERSATION.FEEDBACK.MARKED_READ'));
  } catch (error) {
    useAlert(t('CONVERSATION.FEEDBACK.ACTION_FAILED'));
  }
};

const copyPhone = async () => {
  try {
    await copyTextToClipboard(contactPhone.value);
    useAlert(t('CONVERSATION.FEEDBACK.PHONE_COPIED'));
  } catch (error) {
    useAlert(t('CONVERSATION.FEEDBACK.ACTION_FAILED'));
  }
};

const updateStatus = async status => {
  await store.dispatch('toggleStatus', {
    conversationId: currentChat.value.id,
    status,
  });
};

const finalizeAttendance = async () => {
  try {
    useAlert(t('CONVERSATION.FEEDBACK.FINALIZING'));
    await updateStatus(wootConstants.STATUS_TYPE.RESOLVED);
    useAlert(t('CONVERSATION.FEEDBACK.FINALIZED'));
  } catch (error) {
    useAlert(t('CONVERSATION.FEEDBACK.ACTION_FAILED'));
  }
};

const reopenConversation = async () => {
  try {
    await updateStatus(wootConstants.STATUS_TYPE.OPEN);
    useAlert(t('CONVERSATION.FEEDBACK.UNARCHIVED'));
  } catch (error) {
    useAlert(t('CONVERSATION.FEEDBACK.ACTION_FAILED'));
  }
};

const mute = () => {
  store.dispatch('muteConversation', currentChat.value.id);
  useAlert(t('CONTACT_PANEL.MUTED_SUCCESS'));
};

const unmute = () => {
  store.dispatch('unmuteConversation', currentChat.value.id);
  useAlert(t('CONTACT_PANEL.UNMUTED_SUCCESS'));
};

emitter.on(CMD_MUTE_CONVERSATION, mute);
emitter.on(CMD_UNMUTE_CONVERSATION, unmute);
emitter.on(CMD_SEND_TRANSCRIPT, toggleEmailModal);

onUnmounted(() => {
  emitter.off(CMD_MUTE_CONVERSATION, mute);
  emitter.off(CMD_UNMUTE_CONVERSATION, unmute);
  emitter.off(CMD_SEND_TRANSCRIPT, toggleEmailModal);
});
</script>

<template>
  <div class="relative flex items-center gap-2 actions--container">
    <ButtonV4
      v-if="isSimpleMode && needsAssignmentToCurrentUser"
      v-tooltip="$t('CONVERSATION.ASSUME_ATTENDANCE')"
      :label="assignButtonLabel"
      :aria-label="$t('CONVERSATION.ASSUME_ATTENDANCE')"
      size="sm"
      color="slate"
      class="rounded-full !bg-n-alpha-2 px-3 text-n-slate-12 hover:!bg-n-alpha-3"
      @click="onAssignToMe"
    />
    <ResolveAction
      v-else
      :conversation-id="currentChat.id"
      :status="currentChat.status"
    />
    <div
      v-on-clickaway="() => toggleDropdown(false)"
      class="relative flex items-center group"
    >
      <ButtonV4
        v-tooltip="$t('CONVERSATION.HEADER.MORE_ACTIONS')"
        size="sm"
        variant="ghost"
        color="slate"
        icon="i-lucide-more-vertical"
        class="rounded-full group-hover:bg-n-alpha-2"
        @click="toggleDropdown()"
      />
      <DropdownMenu
        v-if="showActionsDropdown"
        :menu-items="actionMenuItems"
        class="mt-1 ltr:right-0 rtl:left-0 top-full"
        @action="handleActionClick"
      />
    </div>
    <EmailTranscriptModal
      v-if="showEmailActionsModal"
      :show="showEmailActionsModal"
      :current-chat="currentChat"
      @cancel="toggleEmailModal"
    />
  </div>
</template>
