<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useMapGetter } from 'dashboard/composables/store';
import Button from 'dashboard/components-next/button/Button.vue';

const API_BASE = import.meta.env.VITE_INTERNAL_CHAT_API_URL || 'http://localhost:4000';

const route = useRoute();
const currentUserId = useMapGetter('getCurrentUserID');

const loading = ref(true);
const analyzingLeadId = ref(null);
const savingConversationId = ref(null);
const savingFieldsId = ref(null);
const error = ref('');
const summary = ref(null);
const leadsPayload = ref({ stages: [], leads: [] });
const stageFilter = ref('');
const priorityFilter = ref('');
const assigneeFilter = ref('');
const followupOnly = ref(false);
const reviewOnly = ref(false);
const searchTerm = ref('');
const selectedLeadId = ref(null);

const accountId = computed(() => Number(route.params.accountId || route.params.account_id || 0));
const userId = computed(() => Number(currentUserId.value || 0));
const stages = computed(() => leadsPayload.value.stages || summary.value?.stages || []);
const leads = computed(() => leadsPayload.value.leads || []);
const stageCards = computed(() => summary.value?.stages || []);
const aiConfigured = computed(() => Boolean(summary.value?.ai_configured ?? leadsPayload.value.ai_configured));
const selectedLead = computed(() => {
  return leads.value.find(lead => lead.id === selectedLeadId.value)
    || visibleLeads.value[0]
    || leads.value[0]
    || null;
});
const assigneeOptions = computed(() => {
  const agents = new Map();
  leads.value.forEach(lead => {
    const key = lead.assignee_id ? String(lead.assignee_id) : 'unassigned';
    const label = lead.assignee_name || 'Sem responsável';
    agents.set(key, label);
  });
  return [...agents.entries()].map(([value, label]) => ({ value, label }));
});
const visibleLeads = computed(() => {
  const query = searchTerm.value.trim().toLowerCase();
  return leads.value.filter(lead => {
    if (stageFilter.value && lead.stage_key !== stageFilter.value) return false;
    if (priorityFilter.value && lead.ai_priority !== priorityFilter.value) return false;
    if (followupOnly.value && !lead.needs_followup) return false;
    if (reviewOnly.value && !lead.ai_needs_review) return false;
    if (assigneeFilter.value) {
      const assigneeKey = lead.assignee_id ? String(lead.assignee_id) : 'unassigned';
      if (assigneeKey !== assigneeFilter.value) return false;
    }
    if (!query) return true;
    const text = [
      lead.contact_name,
      lead.phone_number,
      lead.contact_email,
      lead.assignee_name,
      lead.last_message,
      lead.ai_next_action,
      lead.ai_risk_reason,
      lead.ai_stage_reason,
      commercialField(lead, 'origem_lead'),
      commercialField(lead, 'produto_interesse'),
      commercialField(lead, 'observacao_comercial'),
    ].filter(Boolean).join(' ').toLowerCase();
    return text.includes(query);
  });
});
const leadsByStage = computed(() => {
  return Object.fromEntries(stages.value.map(stage => [
    stage.key,
    visibleLeads.value.filter(lead => lead.stage_key === stage.key),
  ]));
});
const stageSummaryByKey = computed(() => {
  return Object.fromEntries(stageCards.value.map(stage => [stage.key, stage]));
});

async function request(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${API_BASE}${path}${separator}userId=${userId.value}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || data.message || text || 'Não foi possível concluir a operação.');
  }
  return data;
}

function formatDate(value) {
  if (!value) return 'Sem atividade';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function commercialField(lead, key) {
  return lead.conversation_custom_attributes?.[key]
    || lead.contact_custom_attributes?.[key]
    || '';
}

function normalizeLead(lead) {
  return {
    ...lead,
    crm_fields: {
      origem_lead: commercialField(lead, 'origem_lead'),
      produto_interesse: commercialField(lead, 'produto_interesse') || lead.conversation_custom_attributes?.crm_ai_interest || '',
      valor_estimado: commercialField(lead, 'valor_estimado') || lead.conversation_custom_attributes?.crm_ai_estimated_value || '',
      proximo_follow_up: commercialField(lead, 'proximo_follow_up'),
      observacao_comercial: commercialField(lead, 'observacao_comercial'),
    },
  };
}

function leadInitial(lead) {
  return String(lead?.contact_name || lead?.phone_number || '?').trim().charAt(0).toUpperCase();
}

function priorityLabel(priority) {
  return { alta: 'Alta', media: 'Média', baixa: 'Baixa' }[priority] || 'Sem prioridade';
}

function priorityClass(priority) {
  if (priority === 'alta') return 'border-n-ruby-5 bg-n-ruby-2 text-n-ruby-11';
  if (priority === 'media') return 'border-n-amber-5 bg-n-amber-2 text-n-amber-11';
  return 'border-n-weak bg-n-alpha-2 text-n-slate-11';
}

function selectLead(lead) {
  selectedLeadId.value = lead.id;
}

function openConversation(lead) {
  window.location.href = `/app/accounts/${accountId.value}/conversations/${lead.display_id}`;
}

async function loadCrm() {
  if (!accountId.value || !userId.value) return;
  loading.value = true;
  error.value = '';

  try {
    const params = new URLSearchParams({ limit: '200' });
    const [summaryData, leadsData] = await Promise.all([
      request(`/api/accounts/${accountId.value}/crm/summary`),
      request(`/api/accounts/${accountId.value}/crm/leads?${params.toString()}`),
    ]);

    summary.value = summaryData;
    leadsPayload.value = {
      ...leadsData,
      leads: (leadsData.leads || []).map(normalizeLead),
    };
    if (!selectedLeadId.value || !leads.value.some(lead => lead.id === selectedLeadId.value)) {
      selectedLeadId.value = leads.value[0]?.id || null;
    }
  } catch (err) {
    error.value = err.message || 'Não foi possível carregar o CRM.';
  } finally {
    loading.value = false;
  }
}

async function updateStage(lead, event) {
  const nextStage = event.target.value;
  const previousStage = lead.stage_key;
  savingConversationId.value = lead.id;
  error.value = '';

  try {
    const data = await request(`/api/accounts/${accountId.value}/crm/leads/${lead.id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ userId: userId.value, stage: nextStage }),
    });
    lead.stage_key = data.stage_key;
    lead.stage = data.stage;
    await loadCrm();
  } catch (err) {
    event.target.value = previousStage;
    error.value = err.message || 'Não foi possível atualizar a etapa.';
  } finally {
    savingConversationId.value = null;
  }
}

async function analyzeLead(lead) {
  analyzingLeadId.value = lead.id;
  error.value = '';

  try {
    await request(`/api/accounts/${accountId.value}/crm/leads/${lead.id}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ userId: userId.value, apply: true }),
    });
    selectedLeadId.value = lead.id;
    await loadCrm();
  } catch (err) {
    error.value = err.message || 'Não foi possível analisar o lead com IA.';
  } finally {
    analyzingLeadId.value = null;
  }
}

async function saveCommercialFields(lead) {
  savingFieldsId.value = lead.id;
  error.value = '';

  try {
    const data = await request(`/api/accounts/${accountId.value}/crm/leads/${lead.id}/fields`, {
      method: 'PATCH',
      body: JSON.stringify({ userId: userId.value, fields: lead.crm_fields }),
    });
    lead.conversation_custom_attributes = data.conversation_custom_attributes || {};
    lead.crm_fields = {
      ...lead.crm_fields,
      ...lead.conversation_custom_attributes,
    };
    await loadCrm();
  } catch (err) {
    error.value = err.message || 'Não foi possível salvar os campos comerciais.';
  } finally {
    savingFieldsId.value = null;
  }
}

onMounted(loadCrm);
</script>

<template>
  <main class="flex min-h-full w-full flex-col overflow-auto bg-n-background text-n-slate-12">
    <header class="border-b border-n-weak bg-n-background">
      <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div class="min-w-0">
          <h1 class="m-0 text-base font-semibold text-n-slate-12">
            Pipeline comercial
          </h1>
          <p class="mt-1 mb-0 text-xs text-n-slate-11">
            Gestão de oportunidades do WhatsApp com score, valor e próxima ação por IA.
          </p>
        </div>
        <Button
          label="Atualizar"
          icon="i-lucide-refresh-cw"
          size="sm"
          slate
          :is-loading="loading"
          @click="loadCrm"
        />
      </div>

      <div class="grid gap-3 px-5 pb-3 xl:grid-cols-[minmax(220px,1fr)_auto_auto_auto_auto_auto] xl:items-end">
        <label class="grid gap-1">
          <span class="text-xs font-medium text-n-slate-11">Buscar oportunidade</span>
          <div class="relative">
            <span class="i-lucide-search absolute left-3 top-1/2 size-4 -translate-y-1/2 text-n-slate-10" />
            <input
              v-model="searchTerm"
              type="search"
              class="h-10 w-full rounded-md border border-n-weak bg-n-solid-1 pl-9 pr-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
              placeholder="Nome, telefone, ação, risco ou produto"
            />
          </div>
        </label>

        <label class="grid gap-1">
          <span class="text-xs font-medium text-n-slate-11">Etapa</span>
          <select
            v-model="stageFilter"
            class="h-10 min-w-44 rounded-md border border-n-weak bg-n-solid-1 px-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
          >
            <option value="">Todas</option>
            <option v-for="stage in stages" :key="stage.key" :value="stage.key">
              {{ stage.title }}
            </option>
          </select>
        </label>

        <label class="grid gap-1">
          <span class="text-xs font-medium text-n-slate-11">Responsável</span>
          <select
            v-model="assigneeFilter"
            class="h-10 min-w-44 rounded-md border border-n-weak bg-n-solid-1 px-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
          >
            <option value="">Todos</option>
            <option v-for="agent in assigneeOptions" :key="agent.value" :value="agent.value">
              {{ agent.label }}
            </option>
          </select>
        </label>

        <label class="grid gap-1">
          <span class="text-xs font-medium text-n-slate-11">Prioridade</span>
          <select
            v-model="priorityFilter"
            class="h-10 min-w-36 rounded-md border border-n-weak bg-n-solid-1 px-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
          >
            <option value="">Todas</option>
            <option value="alta">Alta</option>
            <option value="media">Média</option>
            <option value="baixa">Baixa</option>
          </select>
        </label>

        <label class="flex h-10 items-center gap-2 rounded-md border border-n-weak bg-n-solid-1 px-3 text-sm text-n-slate-12">
          <input v-model="reviewOnly" type="checkbox" class="m-0 size-4" />
          <span>Revisar IA</span>
        </label>

        <label class="flex h-10 items-center gap-2 rounded-md border border-n-weak bg-n-solid-1 px-3 text-sm text-n-slate-12">
          <input v-model="followupOnly" type="checkbox" class="m-0 size-4" />
          <span>Parados</span>
        </label>
      </div>
    </header>

    <section class="flex-1 p-5">
      <div
        v-if="error"
        class="mb-4 rounded-md border border-n-ruby-5 bg-n-ruby-2 px-3 py-2.5 text-sm text-n-ruby-11"
      >
        {{ error }}
      </div>

      <div
        v-if="summary && !aiConfigured"
        class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-n-amber-5 bg-n-amber-2 px-3 py-2.5 text-sm text-n-amber-12"
      >
        <span>IA do CRM indisponível. Configure `CRM_AI_ENABLED=true` e `GEMINI_API_KEY` para gerar score, prioridade e próxima ação.</span>
      </div>

      <div v-if="summary" class="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-6">
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-2">
          <span class="text-xs font-medium text-n-slate-11">Pipeline aberto</span>
          <strong class="mt-1 block text-lg font-semibold leading-none text-n-slate-12">{{ formatCurrency(summary.pipeline_value_open) }}</strong>
        </article>
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-2">
          <span class="text-xs font-medium text-n-slate-11">Ganho</span>
          <strong class="mt-1 block text-lg font-semibold leading-none text-n-slate-12">{{ formatCurrency(summary.pipeline_value_won) }}</strong>
        </article>
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-2">
          <span class="text-xs font-medium text-n-slate-11">Perdido</span>
          <strong class="mt-1 block text-lg font-semibold leading-none text-n-slate-12">{{ formatCurrency(summary.pipeline_value_lost) }}</strong>
        </article>
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-2">
          <span class="text-xs font-medium text-n-slate-11">Em risco</span>
          <strong class="mt-1 block text-lg font-semibold leading-none text-n-slate-12">{{ summary.at_risk_count || 0 }}</strong>
        </article>
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-2">
          <span class="text-xs font-medium text-n-slate-11">Revisar IA</span>
          <strong class="mt-1 block text-lg font-semibold leading-none text-n-slate-12">{{ summary.needs_ai_review_count || 0 }}</strong>
        </article>
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-2">
          <span class="text-xs font-medium text-n-slate-11">Oportunidades</span>
          <strong class="mt-1 block text-lg font-semibold leading-none text-n-slate-12">{{ visibleLeads.length }} / {{ leads.length }}</strong>
        </article>
      </div>

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section class="min-w-0">
          <div
            v-if="loading"
            class="flex min-h-72 items-center justify-center rounded-md border border-n-weak bg-n-solid-1 text-sm text-n-slate-11"
          >
            Carregando pipeline...
          </div>

          <div
            v-else-if="!visibleLeads.length"
            class="flex min-h-72 flex-col items-center justify-center gap-1 rounded-md border border-n-weak bg-n-solid-1 px-4 text-center"
          >
            <strong class="text-sm text-n-slate-12">Nenhuma oportunidade encontrada.</strong>
            <span class="text-sm text-n-slate-11">Ajuste os filtros ou analise novas conversas do WhatsApp.</span>
          </div>

          <div v-else class="overflow-x-auto pb-2">
            <div class="grid min-w-[1820px] grid-cols-7 gap-3">
              <section
                v-for="stage in stages"
                :key="stage.key"
                class="min-h-[620px] rounded-md border border-n-weak bg-n-solid-1"
              >
                <header class="border-b border-n-weak px-3 py-3">
                  <div class="flex items-center justify-between gap-2">
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="size-2 rounded-full bg-n-slate-8" :style="stage.color ? { backgroundColor: stage.color } : undefined" />
                      <strong class="truncate text-sm font-semibold text-n-slate-12">{{ stage.title }}</strong>
                    </span>
                    <span class="text-xs text-n-slate-11">{{ (leadsByStage[stage.key] || []).length }}</span>
                  </div>
                  <div class="mt-2 flex items-center justify-between gap-2 text-xs text-n-slate-11">
                    <span>{{ stageSummaryByKey[stage.key]?.total || 0 }} no total</span>
                    <span>{{ formatCurrency(stageSummaryByKey[stage.key]?.estimated_value_total || 0) }}</span>
                  </div>
                </header>

                <div class="grid gap-2 p-2">
                  <button
                    v-for="lead in leadsByStage[stage.key] || []"
                    :key="lead.id"
                    type="button"
                    class="grid gap-2 rounded-md border border-n-weak bg-n-background p-3 text-left transition-colors hover:bg-n-alpha-1"
                    :class="lead.id === selectedLead?.id ? 'outline outline-1 outline-n-brand' : ''"
                    @click="selectLead(lead)"
                  >
                    <span class="flex items-start justify-between gap-2">
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-n-alpha-2 text-xs font-semibold text-n-slate-11">
                          {{ leadInitial(lead) }}
                        </span>
                        <span class="min-w-0">
                          <strong class="block truncate text-sm font-medium text-n-slate-12">
                            {{ lead.contact_name || lead.phone_number || 'Contato sem nome' }}
                          </strong>
                          <span class="block truncate text-xs text-n-slate-11">
                            {{ lead.phone_number || lead.contact_email || 'Sem telefone' }}
                          </span>
                        </span>
                      </span>
                      <span class="shrink-0 text-sm font-semibold text-n-slate-12">
                        {{ formatCurrency(lead.estimated_value_number) }}
                      </span>
                    </span>

                    <span class="flex flex-wrap items-center gap-1.5">
                      <span class="rounded-md border px-1.5 py-0.5 text-xs font-medium" :class="priorityClass(lead.ai_priority)">
                        {{ priorityLabel(lead.ai_priority) }}
                      </span>
                      <span class="rounded-md border border-n-weak bg-n-alpha-2 px-1.5 py-0.5 text-xs font-medium text-n-slate-11">
                        Score {{ lead.ai_score || 0 }}
                      </span>
                      <span
                        v-if="lead.ai_needs_review"
                        class="rounded-md border border-n-amber-5 bg-n-amber-2 px-1.5 py-0.5 text-xs font-medium text-n-amber-11"
                      >
                        Revisar IA
                      </span>
                    </span>

                    <span class="grid gap-1 text-xs text-n-slate-11">
                      <span class="line-clamp-2 text-n-slate-12">
                        {{ lead.ai_next_action || 'Analisar conversa para definir próxima ação.' }}
                      </span>
                      <span v-if="lead.ai_risk_reason" class="line-clamp-2">
                        Risco: {{ lead.ai_risk_reason }}
                      </span>
                    </span>

                    <span class="flex items-center justify-between gap-2 text-xs text-n-slate-11">
                      <span class="truncate">{{ lead.assignee_name || 'Sem responsável' }}</span>
                      <span>{{ formatDate(lead.last_activity_at || lead.created_at) }}</span>
                    </span>
                  </button>
                </div>
              </section>
            </div>
          </div>
        </section>

        <aside v-if="selectedLead" class="min-w-0 rounded-md border border-n-weak bg-n-solid-1">
          <header class="border-b border-n-weak p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 class="m-0 truncate text-base font-semibold text-n-slate-12">
                  {{ selectedLead.contact_name || selectedLead.phone_number || 'Contato sem nome' }}
                </h2>
                <p class="mt-1 mb-0 truncate text-sm text-n-slate-11">
                  {{ selectedLead.phone_number || selectedLead.contact_email || 'Sem telefone' }}
                </p>
              </div>
              <span class="rounded-md border px-2 py-1 text-xs font-medium" :class="priorityClass(selectedLead.ai_priority)">
                {{ priorityLabel(selectedLead.ai_priority) }}
              </span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button
                label="Abrir conversa"
                icon="i-lucide-message-square"
                size="sm"
                slate
                @click="openConversation(selectedLead)"
              />
              <Button
                label="Analisar IA"
                icon="i-lucide-sparkles"
                size="sm"
                :disabled="!aiConfigured"
                :is-loading="analyzingLeadId === selectedLead.id"
                @click="analyzeLead(selectedLead)"
              />
            </div>
          </header>

          <div class="grid gap-4 p-4">
            <section class="grid gap-2">
              <div class="grid grid-cols-2 gap-2">
                <article class="rounded-md border border-n-weak bg-n-background p-3">
                  <span class="text-xs font-medium text-n-slate-11">Valor</span>
                  <strong class="mt-1 block text-base text-n-slate-12">{{ formatCurrency(selectedLead.estimated_value_number) }}</strong>
                </article>
                <article class="rounded-md border border-n-weak bg-n-background p-3">
                  <span class="text-xs font-medium text-n-slate-11">Score IA</span>
                  <strong class="mt-1 block text-base text-n-slate-12">{{ selectedLead.ai_score || 0 }}/100</strong>
                </article>
              </div>

              <article class="rounded-md border border-n-weak bg-n-background p-3">
                <span class="text-xs font-medium text-n-slate-11">Próxima ação</span>
                <p class="mt-1 mb-0 text-sm leading-5 text-n-slate-12">
                  {{ selectedLead.ai_next_action || 'Analise esta conversa com IA para gerar uma ação objetiva.' }}
                </p>
              </article>
              <article v-if="selectedLead.ai_risk_reason" class="rounded-md border border-n-ruby-5 bg-n-ruby-2 p-3">
                <span class="text-xs font-medium text-n-ruby-11">Risco</span>
                <p class="mt-1 mb-0 text-sm leading-5 text-n-ruby-12">
                  {{ selectedLead.ai_risk_reason }}
                </p>
              </article>
              <article class="rounded-md border border-n-weak bg-n-background p-3">
                <span class="text-xs font-medium text-n-slate-11">Motivo da etapa</span>
                <p class="mt-1 mb-0 text-sm leading-5 text-n-slate-12">
                  {{ selectedLead.ai_stage_reason || 'Sem justificativa da IA registrada.' }}
                </p>
              </article>
            </section>

            <form class="grid gap-3" @submit.prevent="saveCommercialFields(selectedLead)">
              <label class="grid gap-1">
                <span class="text-xs font-medium text-n-slate-11">Etapa do funil</span>
                <select
                  :value="selectedLead.stage_key"
                  :disabled="savingConversationId === selectedLead.id"
                  class="h-10 rounded-md border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
                  @change="updateStage(selectedLead, $event)"
                >
                  <option v-for="stage in stages" :key="stage.key" :value="stage.key">
                    {{ stage.title }}
                  </option>
                </select>
              </label>

              <label class="grid gap-1">
                <span class="text-xs font-medium text-n-slate-11">Produto ou interesse</span>
                <input
                  v-model="selectedLead.crm_fields.produto_interesse"
                  class="h-10 rounded-md border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
                />
              </label>
              <label class="grid gap-1">
                <span class="text-xs font-medium text-n-slate-11">Valor estimado</span>
                <input
                  v-model="selectedLead.crm_fields.valor_estimado"
                  class="h-10 rounded-md border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
                  placeholder="Ex.: R$ 1.500"
                />
              </label>
              <label class="grid gap-1">
                <span class="text-xs font-medium text-n-slate-11">Próximo follow-up</span>
                <input
                  v-model="selectedLead.crm_fields.proximo_follow_up"
                  type="date"
                  class="h-10 rounded-md border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
                />
              </label>
              <label class="grid gap-1">
                <span class="text-xs font-medium text-n-slate-11">Observação comercial</span>
                <textarea
                  v-model="selectedLead.crm_fields.observacao_comercial"
                  class="min-h-24 resize-y rounded-md border border-n-weak bg-n-background px-3 py-2 text-sm text-n-slate-12 outline-none focus:border-n-brand"
                />
              </label>
              <Button
                label="Salvar campos"
                icon="i-lucide-save"
                type="submit"
                size="sm"
                :is-loading="savingFieldsId === selectedLead.id"
              />
            </form>

            <section class="grid gap-2">
              <article class="rounded-md border border-n-weak bg-n-background p-3">
                <span class="text-xs font-medium text-n-slate-11">Responsável</span>
                <strong class="mt-1 block text-sm text-n-slate-12">{{ selectedLead.assignee_name || 'Sem responsável' }}</strong>
              </article>
              <article class="rounded-md border border-n-weak bg-n-background p-3">
                <span class="text-xs font-medium text-n-slate-11">Última atividade</span>
                <strong class="mt-1 block text-sm text-n-slate-12">{{ formatDate(selectedLead.last_activity_at || selectedLead.created_at) }}</strong>
              </article>
              <article class="rounded-md border border-n-weak bg-n-background p-3">
                <span class="text-xs font-medium text-n-slate-11">Última mensagem</span>
                <p class="mt-2 mb-0 text-sm leading-5 text-n-slate-12">
                  {{ selectedLead.last_message || 'Sem mensagem registrada.' }}
                </p>
              </article>
            </section>
          </div>
        </aside>
      </div>
    </section>
  </main>
</template>
