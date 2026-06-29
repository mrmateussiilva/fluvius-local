<script setup>
import { computed } from 'vue';

import MessageMeta from '../MessageMeta.vue';

import { emitter } from 'shared/helpers/mitt';
import { useMessageContext } from '../provider.js';
import { useI18n } from 'vue-i18n';
import { useMapGetter } from 'dashboard/composables/store';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';

import MessageFormatter from 'shared/helpers/MessageFormatter.js';
import { BUS_EVENTS } from 'shared/constants/busEvents';
import { MESSAGE_TYPES, MESSAGE_VARIANTS, ORIENTATION } from '../constants';

const props = defineProps({
  hideMeta: { type: Boolean, default: false },
});

const {
  variant,
  orientation,
  inReplyTo,
  shouldGroupWithNext,
  messageType,
  sender,
} = useMessageContext();
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

const varaintBaseMap = {
  [MESSAGE_VARIANTS.AGENT]: 'bg-n-solid-blue text-n-slate-12',
  [MESSAGE_VARIANTS.PRIVATE]:
    'bg-n-solid-amber text-n-amber-12 [&_.prosemirror-mention-node]:font-semibold',
  [MESSAGE_VARIANTS.USER]: 'bg-n-slate-4 text-n-slate-12',
  [MESSAGE_VARIANTS.ACTIVITY]: 'bg-n-alpha-1 text-n-slate-11 text-sm',
  [MESSAGE_VARIANTS.BOT]: 'bg-n-solid-iris text-n-slate-12',
  [MESSAGE_VARIANTS.TEMPLATE]: 'bg-n-solid-iris text-n-slate-12',
  [MESSAGE_VARIANTS.ERROR]: 'bg-n-ruby-4 text-n-ruby-12',
  [MESSAGE_VARIANTS.EMAIL]: 'w-full',
  [MESSAGE_VARIANTS.UNSUPPORTED]:
    'bg-n-solid-amber/70 border border-dashed border-n-amber-12 text-n-amber-12',
};

const orientationMap = {
  [ORIENTATION.LEFT]:
    'left-bubble rounded-xl ltr:rounded-bl-sm rtl:rounded-br-sm',
  [ORIENTATION.RIGHT]:
    'right-bubble rounded-xl ltr:rounded-br-sm rtl:rounded-bl-sm',
  [ORIENTATION.CENTER]: 'rounded-md',
};

const flexOrientationClass = computed(() => {
  const map = {
    [ORIENTATION.LEFT]: 'justify-start',
    [ORIENTATION.RIGHT]: 'justify-end',
    [ORIENTATION.CENTER]: 'justify-center',
  };

  return map[orientation.value];
});

const messageClass = computed(() => {
  if (isSimpleMode.value) {
    const classToApply = [
      'agent-message-bubble px-3 py-2 leading-5 shadow-none',
    ];

    if (variant.value === MESSAGE_VARIANTS.ACTIVITY) {
      return [
        'agent-message-bubble rounded-lg bg-transparent px-2 py-1 text-xs text-n-slate-10',
      ];
    }

    if (variant.value === MESSAGE_VARIANTS.EMAIL) {
      return ['w-full'];
    }

    if (orientation.value === ORIENTATION.RIGHT) {
      classToApply.push(
        'right-bubble rounded-2xl ltr:rounded-br-md rtl:rounded-bl-md bg-n-brand/10 text-n-slate-12 dark:bg-n-brand/20'
      );
    } else if (orientation.value === ORIENTATION.LEFT) {
      classToApply.push(
        'left-bubble rounded-2xl ltr:rounded-bl-md rtl:rounded-br-md bg-n-solid-1 text-n-slate-12'
      );
    } else {
      classToApply.push('rounded-lg bg-n-alpha-1 text-n-slate-11');
    }

    if (variant.value === MESSAGE_VARIANTS.PRIVATE) {
      classToApply.push('!bg-n-amber-3 !text-n-amber-12');
    }

    return classToApply;
  }

  const classToApply = [varaintBaseMap[variant.value]];

  if (variant.value !== MESSAGE_VARIANTS.ACTIVITY) {
    classToApply.push(orientationMap[orientation.value]);
  } else {
    classToApply.push('rounded-lg');
  }

  return classToApply;
});

const agentName = computed(() => String(sender.value?.name || '').trim());
const shouldShowAgentName = computed(
  () =>
    messageType.value === MESSAGE_TYPES.OUTGOING &&
    variant.value === MESSAGE_VARIANTS.AGENT &&
    agentName.value
);

const scrollToMessage = () => {
  emitter.emit(BUS_EVENTS.SCROLL_TO_MESSAGE, {
    messageId: inReplyTo.value.id,
  });
};

const shouldShowMeta = computed(
  () =>
    !props.hideMeta &&
    !shouldGroupWithNext.value &&
    variant.value !== MESSAGE_VARIANTS.ACTIVITY
);

const replyToPreview = computed(() => {
  if (!inReplyTo) return '';

  const { content, attachments } = inReplyTo.value;

  if (content) return new MessageFormatter(content).formattedMessage;
  if (attachments?.length) {
    const firstAttachment = attachments[0];
    const fileType = firstAttachment.fileType ?? firstAttachment.file_type;

    return t(`CHAT_LIST.ATTACHMENTS.${fileType}.CONTENT`);
  }

  return t('CONVERSATION.REPLY_MESSAGE_NOT_FOUND');
});
</script>

<template>
  <div
    class="text-sm min-w-0"
    :class="[
      messageClass,
      {
        'max-w-[74%] sm:max-w-[42rem]':
          isSimpleMode && variant !== MESSAGE_VARIANTS.EMAIL,
        'max-w-lg': !isSimpleMode && variant !== MESSAGE_VARIANTS.EMAIL,
      },
    ]"
  >
    <div
      v-if="inReplyTo"
      class="p-2 -mx-1 mb-2 rounded-lg cursor-pointer bg-n-alpha-black1"
      @click="scrollToMessage"
    >
      <div
        v-dompurify-html="replyToPreview"
        class="prose prose-bubble line-clamp-2"
      />
    </div>
    <div
      v-if="shouldShowAgentName"
      class="mb-1 text-xs font-semibold leading-4 text-n-slate-12"
    >
      {{ agentName }}
    </div>
    <slot />
    <MessageMeta
      v-if="shouldShowMeta"
      :class="[
        flexOrientationClass,
        variant === MESSAGE_VARIANTS.EMAIL ? 'px-3 pb-3' : '',
        isSimpleMode
          ? 'text-[0.6875rem] text-n-slate-9'
          : variant === MESSAGE_VARIANTS.PRIVATE
            ? 'text-n-amber-12/50'
            : 'text-n-slate-11',
      ]"
      class="mt-2"
    />
  </div>
</template>

<style scoped>
.agent-message-bubble :deep(img),
.agent-message-bubble :deep(video) {
  border-radius: 0.875rem;
  max-width: min(100%, 22rem);
}

.agent-message-bubble :deep(.prose) {
  line-height: 1.45;
}
</style>
