<script setup>
import { computed, useTemplateRef } from 'vue';
import { useElementSize } from '@vueuse/core';
import { useMapGetter } from 'dashboard/composables/store';
import { REPLY_EDITOR_MODES } from './constants';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';

const props = defineProps({
  mode: {
    type: String,
    default: REPLY_EDITOR_MODES.REPLY,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  isReplyRestricted: {
    type: Boolean,
    default: false,
  },
});

defineEmits(['toggleMode']);

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

const wootEditorReplyMode = useTemplateRef('wootEditorReplyMode');
const wootEditorPrivateMode = useTemplateRef('wootEditorPrivateMode');

const replyModeSize = useElementSize(wootEditorReplyMode);
const privateModeSize = useElementSize(wootEditorPrivateMode);

const isPrivate = computed(() => {
  if (props.isReplyRestricted) {
    return true;
  }
  return props.mode === REPLY_EDITOR_MODES.NOTE;
});

const width = computed(() => {
  const widthToUse = isPrivate.value
    ? privateModeSize.width.value
    : replyModeSize.width.value;

  const widthWithPadding = widthToUse + 16;
  return `${widthWithPadding}px`;
});

const translateValue = computed(() => {
  const xTranslate = isPrivate.value ? replyModeSize.width.value + 16 : 0;

  return `${xTranslate}px`;
});
</script>

<template>
  <button
    class="flex items-center w-auto p-1 transition-all border rounded-full group relative duration-300 ease-in-out z-0 active:scale-[0.995] active:duration-75"
    :class="
      isSimpleMode
        ? 'h-8 bg-transparent border-transparent'
        : 'h-8 bg-n-alpha-2 border-transparent'
    "
    :disabled="disabled || isReplyRestricted"
    @click="$emit('toggleMode')"
  >
    <div
      ref="wootEditorReplyMode"
      class="flex items-center gap-1 px-2 z-20"
      :class="
        isSimpleMode
          ? mode === REPLY_EDITOR_MODES.REPLY
            ? 'text-xs font-semibold text-n-slate-12'
            : 'text-xs font-medium text-n-slate-10'
          : ''
      "
    >
      {{ $t('CONVERSATION.REPLYBOX.REPLY') }}
    </div>
    <div
      ref="wootEditorPrivateMode"
      class="flex items-center gap-1 px-2 z-20"
      :class="
        isSimpleMode
          ? mode === REPLY_EDITOR_MODES.NOTE
            ? 'text-xs font-medium text-n-slate-11'
            : 'text-xs text-n-slate-9'
          : ''
      "
    >
      {{ $t('CONVERSATION.REPLYBOX.PRIVATE_NOTE') }}
    </div>
    <div
      class="absolute shadow-sm rounded-full ease-in-out translate-x-[var(--translate-x)] rtl:translate-x-[var(--rtl-translate-x)] bg-n-solid-1"
      :class="
        isSimpleMode
          ? 'h-6 w-[var(--chip-width)] bg-n-alpha-2 shadow-none'
          : 'h-6 w-[var(--chip-width)]'
      "
      :style="{
        '--chip-width': width,
        '--translate-x': translateValue,
        '--rtl-translate-x': `calc(-1 * var(--translate-x))`,
      }"
    />
  </button>
</template>
