<script setup>
import { computed } from 'vue';
import { useKeyboardEvents } from 'dashboard/composables/useKeyboardEvents';
import { useMapGetter } from 'dashboard/composables/store';
import { isAgentSimpleMode } from 'dashboard/helper/agentSimpleMode';
import wootConstants from 'dashboard/constants/globals';

const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  activeTab: {
    type: String,
    default: wootConstants.ASSIGNEE_TYPE.ME,
  },
});

const emit = defineEmits(['chatTabChange']);

const currentUser = useMapGetter('getCurrentUser');
const currentAccountId = useMapGetter('getCurrentAccountId');
const currentRole = useMapGetter('getCurrentRole');

const activeTabIndex = computed(() => {
  return props.items.findIndex(item => item.key === props.activeTab);
});

const isSimpleMode = computed(() =>
  isAgentSimpleMode(
    currentUser.value,
    currentAccountId.value,
    currentRole.value
  )
);

const onTabChange = selectedTabIndex => {
  if (selectedTabIndex >= 0 && selectedTabIndex < props.items.length) {
    const selectedItem = props.items[selectedTabIndex];
    if (selectedItem.key !== props.activeTab) {
      emit('chatTabChange', selectedItem.key);
    }
  }
};

const keyboardEvents = {
  'Alt+KeyN': {
    action: () => {
      if (props.activeTab === wootConstants.ASSIGNEE_TYPE.ALL) {
        onTabChange(0);
      } else {
        const nextIndex = (activeTabIndex.value + 1) % props.items.length;
        onTabChange(nextIndex);
      }
    },
  },
};

useKeyboardEvents(keyboardEvents);
</script>

<template>
  <div
    v-if="isSimpleMode"
    class="agent-conversation-chip-list flex flex-wrap gap-1.5 border-b border-n-weak bg-n-background px-4 py-2"
  >
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      class="agent-conversation-chip inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition"
      :class="
        item.key === activeTab
          ? 'bg-n-alpha-3 text-n-slate-12 ring-1 ring-n-weak dark:bg-n-brand/20 dark:text-n-slate-12 dark:ring-n-brand/40'
          : 'bg-transparent text-n-slate-10 hover:bg-n-alpha-2 hover:text-n-slate-12'
      "
      @click="emit('chatTabChange', item.key)"
    >
      <span>{{ item.name }}</span>
      <span
        class="inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[0.625rem] leading-none"
        :class="
          item.key === activeTab
            ? 'bg-n-solid-1 text-n-slate-11 dark:bg-n-brand/20 dark:text-n-slate-12'
            : 'bg-n-solid-1 text-n-slate-10'
        "
      >
        {{ item.displayCount ?? item.count }}
      </span>
    </button>
  </div>

  <woot-tabs
    v-else
    :index="activeTabIndex"
    class="w-full px-3 -mt-1 py-0 [&_ul]:p-0 h-10"
    @change="onTabChange"
  >
    <woot-tabs-item
      v-for="(item, index) in items"
      :key="item.key"
      class="text-sm [&_a]:font-medium"
      :index="index"
      :name="item.name"
      :count="item.displayCount ?? item.count"
      is-compact
    />
  </woot-tabs>
</template>
