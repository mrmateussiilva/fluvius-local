<script setup>
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useStore } from 'vuex';
import { useElementSize } from '@vueuse/core';
import { useMapGetter } from 'dashboard/composables/store';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';
import BackButton from '../BackButton.vue';
import InboxName from '../InboxName.vue';
import MoreActions from './MoreActions.vue';
import Avatar from 'next/avatar/Avatar.vue';
import SLACardLabel from './components/SLACardLabel.vue';
import ConversationCallButton from './ConversationCallButton.vue';
import wootConstants from 'dashboard/constants/globals';
import { conversationListPageURL } from 'dashboard/helper/URLHelper';
import { snoozedReopenTime } from 'dashboard/helper/snoozeHelpers';
import { useInbox } from 'dashboard/composables/useInbox';
import { useAlert } from 'dashboard/composables';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from 'shared/helpers/clipboard';

const props = defineProps({
  chat: {
    type: Object,
    default: () => ({}),
  },
  showBackButton: {
    type: Boolean,
    default: false,
  },
});

const { t } = useI18n();
const store = useStore();
const route = useRoute();
const conversationHeader = ref(null);
const { width } = useElementSize(conversationHeader);
const { isAWebWidgetInbox } = useInbox();

const currentUser = useMapGetter('getCurrentUser');
const currentAccountId = useMapGetter('getCurrentAccountId');
const currentRole = useMapGetter('getCurrentRole');

const currentChat = computed(() => store.getters.getSelectedChat);
const accountId = computed(() => store.getters.getCurrentAccountId);

const chatMetadata = computed(() => props.chat.meta || {});

const backButtonUrl = computed(() => {
  const {
    params: { inbox_id: inboxId, label, teamId, id: customViewId },
    name,
  } = route;

  const conversationTypeMap = {
    conversation_through_mentions: 'mention',
    conversation_through_participating: 'participating',
    conversation_through_unattended: 'unattended',
  };
  return conversationListPageURL({
    accountId: accountId.value,
    inboxId,
    label,
    teamId,
    conversationType: conversationTypeMap[name],
    customViewId,
  });
});

const isSimpleMode = computed(() =>
  isAgentSimpleMode(
    currentUser.value,
    currentAccountId.value,
    currentRole.value
  )
);

const isHMACVerified = computed(() => {
  if (!isAWebWidgetInbox.value) {
    return true;
  }
  return chatMetadata.value.hmac_verified;
});

const currentContact = computed(() => {
  const senderId = props.chat?.meta?.sender?.id;
  if (!senderId) return {};
  return store.getters['contacts/getContact'](senderId);
});

const contactDisplayName = computed(() => {
  return (
    currentContact.value?.name ||
    currentContact.value?.phone_number ||
    currentContact.value?.identifier ||
    currentContact.value?.email ||
    'Contato sem nome'
  );
});

const secondaryIdentifier = computed(() => {
  return (
    currentContact.value?.phone_number ||
    currentContact.value?.identifier ||
    currentContact.value?.email ||
    `#${props.chat.id}`
  );
});

const isSnoozed = computed(
  () => currentChat.value.status === wootConstants.STATUS_TYPE.SNOOZED
);

const snoozedDisplayText = computed(() => {
  const { snoozed_until: snoozedUntil } = currentChat.value;
  if (snoozedUntil) {
    return `${t('CONVERSATION.HEADER.SNOOZED_UNTIL')} ${snoozedReopenTime(snoozedUntil)}`;
  }
  return t('CONVERSATION.HEADER.SNOOZED_UNTIL_NEXT_REPLY');
});

const inbox = computed(() => {
  const { inbox_id: inboxId } = props.chat;
  return store.getters['inboxes/getInbox'](inboxId);
});

const hasMultipleInboxes = computed(
  () => store.getters['inboxes/getInboxes'].length > 1
);

const hasSlaPolicyId = computed(() => props.chat?.sla_policy_id);

const copyConversationId = async () => {
  try {
    await copyTextToClipboard(String(props.chat.id));
    useAlert(t('CONVERSATION.HEADER.COPY_ID_SUCCESS'));
  } catch (error) {
    // noop
  }
};
</script>

<template>
  <div
    ref="conversationHeader"
    class="flex w-full min-w-0 flex-1 items-center justify-between"
    :class="
      isSimpleMode
        ? 'border-b border-n-weak bg-n-background px-4 py-3'
        : 'flex-col gap-3 px-3 pt-3 pb-2 h-24 xl:flex-row xl:h-12'
    "
  >
    <div
      class="flex items-center justify-start max-w-full min-w-0"
      :class="isSimpleMode ? 'flex-1 gap-3' : 'w-full xl:w-auto xl:flex-1'"
    >
      <BackButton
        v-if="showBackButton"
        :back-url="backButtonUrl"
        class="ltr:mr-2 rtl:ml-2"
      />
      <Avatar
        :name="contactDisplayName"
        :src="currentContact.thumbnail"
        :size="isSimpleMode ? 40 : 32"
        :status="currentContact.availability_status"
        hide-offline-status
      />
      <div
        class="min-w-0 overflow-hidden"
        :class="
          isSimpleMode
            ? 'flex-1'
            : 'flex flex-col items-start ml-2 rtl:ml-0 rtl:mr-2'
        "
      >
        <div class="flex max-w-full items-center gap-1">
          <span
            class="truncate text-n-slate-12"
            :class="
              isSimpleMode
                ? 'text-base font-semibold'
                : 'text-sm font-medium leading-tight'
            "
          >
            {{ contactDisplayName }}
          </span>
          <fluent-icon
            v-if="!isHMACVerified"
            v-tooltip="$t('CONVERSATION.UNVERIFIED_SESSION')"
            size="14"
            class="text-n-amber-10 my-0 mx-0 min-w-[14px] flex-shrink-0"
            icon="warning"
          />
        </div>

        <div
          v-if="isSimpleMode"
          class="mt-0.5 flex items-center gap-1 overflow-hidden text-xs text-n-slate-10"
        >
          <span class="truncate">{{ secondaryIdentifier }}</span>
          <span v-if="isSnoozed">•</span>
          <span v-if="isSnoozed" class="truncate font-medium text-n-amber-10">
            {{ snoozedDisplayText }}
          </span>
        </div>

        <div
          v-else
          class="flex items-center gap-1 overflow-hidden text-xs conversation--header--actions text-n-slate-11 text-ellipsis whitespace-nowrap"
        >
          <button
            type="button"
            class="truncate text-label-small text-n-slate-11 hover:text-n-slate-12 !p-0 cucursor-pointer"
            @click="copyConversationId"
          >
            {{ `#${chat.id}` }}
          </button>
          <span v-if="hasMultipleInboxes">•</span>
          <InboxName v-if="hasMultipleInboxes" :inbox="inbox" class="!mx-0" />
          <span v-if="isSnoozed">•</span>
          <span v-if="isSnoozed" class="font-medium text-n-amber-10">
            {{ snoozedDisplayText }}
          </span>
        </div>
      </div>
    </div>
    <div
      class="flex flex-row items-center justify-end flex-shrink-0 gap-2 header-actions-wrap"
      :class="isSimpleMode ? 'ml-3' : 'w-full xl:w-auto'"
    >
      <SLACardLabel
        v-if="hasSlaPolicyId && !isSimpleMode"
        :chat="chat"
        show-extended-info
        :parent-width="width"
        class="hidden md:flex"
      />
      <ConversationCallButton :inbox="inbox" :chat="currentChat" />
      <button
        v-if="isSimpleMode"
        type="button"
        class="hidden rounded-full px-3 py-1.5 text-xs font-medium text-n-slate-10 transition hover:bg-n-alpha-2 sm:inline-flex"
        @click="copyConversationId"
      >
        {{ `#${chat.id}` }}
      </button>
      <MoreActions :conversation-id="currentChat.id" />
    </div>
  </div>
</template>
