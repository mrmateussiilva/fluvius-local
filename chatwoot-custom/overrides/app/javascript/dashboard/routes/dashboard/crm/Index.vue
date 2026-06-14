<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useMapGetter } from 'dashboard/composables/store';
import Button from 'dashboard/components-next/button/Button.vue';

const API_BASE = import.meta.env.VITE_INTERNAL_CHAT_API_URL || 'http://localhost:4000';

const route = useRoute();
const currentUserId = useMapGetter('getCurrentUserID');

const loading = ref(true);
const savingConversationId = ref(null);
const savingFieldsId = ref(null);
const error = ref('');
const summary = ref(null);
const leadsPayload = ref({ stages: [], leads: [] });
const stageFilter = ref('');
const followupOnly = ref(false);
const searchTerm = ref('');
const selectedLeadId = ref(null);

const accountId = computed(() => Number(route.params.accountId || route.params.account_id || 0));
const userId = computed(() => Number(currentUserId.value || 0));
const stages = computed(() => leadsPayload.value.stages || summary.value?.stages || []);
const leads = computed(() => leadsPayload.value.leads || []);
const stageCards = computed(() => summary.value?.stages || []);
const selectedLead = computed(() => {
  return visibleLeads.value.find(lead => lead.id === selectedLeadId.value) || visibleLeads.value[0] || null;
});
const visibleLeads = computed(() => {
  const query = searchTerm.value.trim().toLowerCase();
  if (!query) return leads.value;
  return leads.value.filter(lead => {
    const text = [
      lead.contact_name,
      lead.phone_number,
      lead.contact_email,
      lead.assignee_name,
      lead.last_message,
      commercialField(lead, 'origem_lead'),
      commercialField(lead, 'produto_interesse'),
      commercialField(lead, 'observacao_comercial'),
    ].filter(Boolean).join(' ').toLowerCase();
    return text.includes(query);
  });
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
      produto_interesse: commercialField(lead, 'produto_interesse'),
      valor_estimado: commercialField(lead, 'valor_estimado'),
      proximo_follow_up: commercialField(lead, 'proximo_follow_up'),
      observacao_comercial: commercialField(lead, 'observacao_comercial'),
    },
  };
}

function leadInitial(lead) {
  return String(lead?.contact_name || lead?.phone_number || '?').trim().charAt(0).toUpperCase();
}

function stageByKey(key) {
  return stages.value.find(stage => stage.key === key) || stages.value[0] || {};
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
    const params = new URLSearchParams({ limit: '120' });
    if (stageFilter.value) params.set('stage', stageFilter.value);
    if (followupOnly.value) params.set('followup', 'true');

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
  } catch (err) {
    error.value = err.message || 'Não foi possível salvar os campos comerciais.';
  } finally {
    savingFieldsId.value = null;
  }
}

onMounted(loadCrm);
</script>

<template>
  <main class="flex flex-col w-full min-h-full overflow-auto bg-n-background text-n-slate-12">
    <header class="border-b border-n-weak bg-n-background">
      <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div class="min-w-0">
          <h1 class="m-0 text-xl font-semibold text-n-slate-12">
            CRM
          </h1>
          <p class="mt-1 mb-0 text-sm text-n-slate-11">
            Leads, etapas e follow-ups do WhatsApp em uma tela operacional.
          </p>
        </div>
        <Button
          label="Atualizar"
          icon="i-lucide-refresh-cw"
          size="sm"
          :is-loading="loading"
          @click="loadCrm"
        />
      </div>

      <div class="grid gap-3 px-5 pb-4 md:grid-cols-[minmax(240px,1fr)_auto_auto] md:items-end">
        <label class="grid gap-1">
          <span class="text-xs font-medium text-n-slate-11">Buscar lead</span>
          <div class="relative">
            <span class="i-lucide-search absolute left-3 top-1/2 size-4 -translate-y-1/2 text-n-slate-10" />
            <input
              v-model="searchTerm"
              type="search"
              class="h-10 w-full rounded-md border border-n-weak bg-n-solid-1 pl-9 pr-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
              placeholder="Nome, telefone, produto ou observação"
            />
          </div>
        </label>

        <label class="grid gap-1">
          <span class="text-xs font-medium text-n-slate-11">Etapa</span>
          <select
            v-model="stageFilter"
            class="h-10 min-w-48 rounded-md border border-n-weak bg-n-solid-1 px-3 text-sm text-n-slate-12 outline-none focus:border-n-brand"
            @change="loadCrm"
          >
            <option value="">Todas as etapas</option>
            <option v-for="stage in stages" :key="stage.key" :value="stage.key">
              {{ stage.title }}
            </option>
          </select>
        </label>

        <label class="flex h-10 items-center gap-2 rounded-md border border-n-weak bg-n-solid-1 px-3 text-sm text-n-slate-12">
          <input
            v-model="followupOnly"
            type="checkbox"
            class="m-0 size-4"
            @change="loadCrm"
          />
          <span>Follow-up pendente</span>
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

      <div v-if="summary" class="grid grid-cols-2 gap-3 mb-5 lg:grid-cols-4 xl:grid-cols-6">
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-3">
          <span class="text-xs font-medium text-n-slate-11">Leads novos</span>
          <strong class="block mt-2 text-2xl font-semibold text-n-slate-12">{{ summary.new_leads }}</strong>
        </article>
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-3">
          <span class="text-xs font-medium text-n-slate-11">Conversas abertas</span>
          <strong class="block mt-2 text-2xl font-semibold text-n-slate-12">{{ summary.open_conversations }}</strong>
        </article>
        <article class="rounded-md border border-n-amber-5 bg-n-amber-2 px-3 py-3">
          <span class="text-xs font-medium text-n-amber-11">Follow-up</span>
          <strong class="block mt-2 text-2xl font-semibold text-n-amber-12">{{ summary.followups }}</strong>
        </article>
        <article
          v-for="stage in stageCards"
          :key="stage.key"
          class="rounded-md border bg-n-solid-1 px-3 py-3"
          :style="{ borderColor: `${stage.color}66` }"
        >
          <span class="block truncate text-xs font-medium text-n-slate-11">{{ stage.title }}</span>
          <strong class="block mt-2 text-2xl font-semibold text-n-slate-12">{{ stage.total }}</strong>
        </article>
      </div>

      <div class="grid min-h-[520px] overflow-hidden rounded-md border border-n-weak bg-n-solid-1 lg:grid-cols-[380px_minmax(0,1fr)]">
        <aside class="border-b border-n-weak lg:border-b-0 lg:border-r">
          <div class="flex items-center justify-between gap-2 border-b border-n-weak px-4 py-3">
            <strong class="text-sm text-n-slate-12">Leads</strong>
            <span class="text-xs text-n-slate-11">{{ visibleLeads.length }} de {{ leads.length }}</span>
          </div>

          <div
            v-if="loading"
            class="flex min-h-48 items-center justify-center text-sm text-n-slate-11"
          >
            Carregando CRM...
          </div>
          <div
            v-else-if="!visibleLeads.length"
            class="flex min-h-48 flex-col items-center justify-center gap-1 px-4 text-center"
          >
            <strong class="text-sm text-n-slate-12">Nenhum lead encontrado.</strong>
            <span class="text-sm text-n-slate-11">Ajuste os filtros ou aguarde novas conversas do WhatsApp.</span>
          </div>
          <div v-else class="max-h-[680px] overflow-auto">
            <button
              v-for="lead in visibleLeads"
              :key="lead.id"
              type="button"
              class="grid w-full grid-cols-[40px_minmax(0,1fr)] gap-3 border-b border-n-weak px-4 py-3 text-left hover:bg-n-alpha-1"
              :class="lead.id === selectedLead?.id ? 'bg-n-alpha-2' : ''"
              @click="selectLead(lead)"
            >
              <span class="flex size-10 items-center justify-center rounded-md bg-n-brand/10 text-sm font-semibold text-n-brand">
                {{ leadInitial(lead) }}
              </span>
              <span class="min-w-0">
                <span class="flex items-center justify-between gap-2">
                  <strong class="truncate text-sm font-medium text-n-slate-12">
                    {{ lead.contact_name || lead.phone_number || 'Contato sem nome' }}
                  </strong>
                  <span
                    v-if="lead.needs_followup"
                    class="shrink-0 rounded-md bg-n-amber-3 px-2 py-0.5 text-xs font-medium text-n-amber-11"
                  >
                    Follow-up
                  </span>
                </span>
                <span class="mt-1 block truncate text-xs text-n-slate-11">
                  {{ commercialField(lead, 'produto_interesse') || lead.last_message || 'Sem produto registrado' }}
                </span>
                <span class="mt-2 inline-flex rounded-md px-2 py-0.5 text-xs font-medium text-n-slate-12" :style="{ backgroundColor: `${stageByKey(lead.stage_key).color || '#94a3b8'}22` }">
                  {{ lead.stage }}
                </span>
              </span>
            </button>
          </div>
        </aside>

        <section v-if="selectedLead" class="min-w-0">
          <div class="flex flex-wrap items-start justify-between gap-3 border-b border-n-weak px-5 py-4">
            <div class="min-w-0">
              <h2 class="m-0 truncate text-lg font-semibold text-n-slate-12">
                {{ selectedLead.contact_name || selectedLead.phone_number || 'Contato sem nome' }}
              </h2>
              <p class="mt-1 mb-0 text-sm text-n-slate-11">
                {{ selectedLead.phone_number || selectedLead.contact_email || 'Sem telefone' }}
              </p>
            </div>
            <Button
              label="Abrir conversa"
              icon="i-lucide-message-square"
              size="sm"
              slate
              @click="openConversation(selectedLead)"
            />
          </div>

          <div class="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_280px]">
            <form class="grid gap-4" @submit.prevent="saveCommercialFields(selectedLead)">
              <div class="grid gap-4 md:grid-cols-2">
                <label class="grid gap-1">
                  <span class="text-xs font-medium text-n-slate-11">Produto ou interesse</span>
                  <input
                    v-model="selectedLead.crm_fields.produto_interesse"
                    class="h-10 rounded-md border border-n-weak bg-n-background px-3 text-sm outline-none focus:border-n-brand"
                    placeholder="Ex.: plano mensal, orçamento, suporte"
                  />
                </label>
                <label class="grid gap-1">
                  <span class="text-xs font-medium text-n-slate-11">Origem</span>
                  <input
                    v-model="selectedLead.crm_fields.origem_lead"
                    class="h-10 rounded-md border border-n-weak bg-n-background px-3 text-sm outline-none focus:border-n-brand"
                    placeholder="Ex.: Instagram, indicação, site"
                  />
                </label>
                <label class="grid gap-1">
                  <span class="text-xs font-medium text-n-slate-11">Valor estimado</span>
                  <input
                    v-model="selectedLead.crm_fields.valor_estimado"
                    class="h-10 rounded-md border border-n-weak bg-n-background px-3 text-sm outline-none focus:border-n-brand"
                    placeholder="Ex.: R$ 1.500"
                  />
                </label>
                <label class="grid gap-1">
                  <span class="text-xs font-medium text-n-slate-11">Próximo follow-up</span>
                  <input
                    v-model="selectedLead.crm_fields.proximo_follow_up"
                    type="date"
                    class="h-10 rounded-md border border-n-weak bg-n-background px-3 text-sm outline-none focus:border-n-brand"
                  />
                </label>
              </div>

              <label class="grid gap-1">
                <span class="text-xs font-medium text-n-slate-11">Observação comercial</span>
                <textarea
                  v-model="selectedLead.crm_fields.observacao_comercial"
                  class="min-h-28 resize-y rounded-md border border-n-weak bg-n-background px-3 py-2 text-sm outline-none focus:border-n-brand"
                  placeholder="Contexto, objeções, próximos passos e detalhes importantes."
                />
              </label>

              <div class="flex flex-wrap items-center justify-between gap-3">
                <label class="grid gap-1">
                  <span class="text-xs font-medium text-n-slate-11">Etapa do funil</span>
                  <select
                    :value="selectedLead.stage_key"
                    :disabled="savingConversationId === selectedLead.id"
                    class="h-10 min-w-56 rounded-md border border-n-weak bg-n-background px-3 text-sm outline-none focus:border-n-brand"
                    @change="updateStage(selectedLead, $event)"
                  >
                    <option v-for="stage in stages" :key="stage.key" :value="stage.key">
                      {{ stage.title }}
                    </option>
                  </select>
                </label>
                <Button
                  label="Salvar campos"
                  icon="i-lucide-save"
                  type="submit"
                  size="sm"
                  :is-loading="savingFieldsId === selectedLead.id"
                />
              </div>
            </form>

            <aside class="grid content-start gap-3">
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
            </aside>
          </div>
        </section>
      </div>
    </section>
  </main>
</template>
