<script setup>
import { computed } from 'vue';
import { useMessageContext } from '../../provider.js';

import MessageFormatter from 'shared/helpers/MessageFormatter.js';
import { MESSAGE_VARIANTS } from '../../constants';

const props = defineProps({
  content: {
    type: String,
    required: true,
  },
});

const { variant, conversationSearchTerm } = useMessageContext();

const normalizeSearchText = value =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const appendText = (fragment, text) => {
  if (text) {
    fragment.appendChild(document.createTextNode(text));
  }
};

const buildNormalizedTextMap = text => {
  let normalizedText = '';
  const positions = [];
  let offset = 0;

  Array.from(text).forEach(character => {
    const start = offset;
    const end = start + character.length;
    const normalizedCharacter = normalizeSearchText(character);

    Array.from(normalizedCharacter).forEach(normalizedValue => {
      normalizedText += normalizedValue;
      positions.push({ start, end });
    });

    offset = end;
  });

  return { normalizedText, positions };
};

const highlightedTextFragment = (text, searchTerm) => {
  const normalizedTerm = normalizeSearchText(searchTerm);
  const { normalizedText, positions } = buildNormalizedTextMap(text);

  if (!normalizedTerm || !normalizedText.includes(normalizedTerm)) {
    return document.createTextNode(text);
  }

  const fragment = document.createDocumentFragment();
  let normalizedIndex = 0;
  let lastOriginalIndex = 0;

  while (normalizedIndex < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedTerm, normalizedIndex);
    if (matchIndex === -1) break;

    const matchEndIndex = matchIndex + normalizedTerm.length - 1;
    const originalStart = positions[matchIndex]?.start;
    const originalEnd = positions[matchEndIndex]?.end;

    if (originalStart === undefined || originalEnd === undefined) break;

    appendText(fragment, text.slice(lastOriginalIndex, originalStart));

    const mark = document.createElement('mark');
    mark.className =
      'rounded bg-n-amber-5 px-0.5 text-inherit outline outline-1 outline-n-amber-8';
    mark.textContent = text.slice(originalStart, originalEnd);
    fragment.appendChild(mark);

    lastOriginalIndex = originalEnd;
    normalizedIndex = matchIndex + normalizedTerm.length;
  }

  appendText(fragment, text.slice(lastOriginalIndex));
  return fragment;
};

const highlightTextNodes = (node, searchTerm) => {
  if (node.nodeType === Node.TEXT_NODE) {
    const highlightedFragment = highlightedTextFragment(
      node.textContent || '',
      searchTerm
    );
    node.parentNode?.replaceChild(highlightedFragment, node);
    return;
  }

  Array.from(node.childNodes).forEach(childNode => {
    highlightTextNodes(childNode, searchTerm);
  });
};

const addSearchHighlight = html => {
  if (
    !conversationSearchTerm?.value ||
    typeof document === 'undefined' ||
    typeof Node === 'undefined'
  ) {
    return html;
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  highlightTextNodes(template.content, conversationSearchTerm.value);
  return template.innerHTML;
};

const formattedContent = computed(() => {
  const html =
    variant.value === MESSAGE_VARIANTS.ACTIVITY
      ? props.content
      : new MessageFormatter(props.content).formattedMessage;

  return addSearchHighlight(html);
});
</script>

<template>
  <span v-dompurify-html="formattedContent" class="prose prose-bubble" />
</template>
