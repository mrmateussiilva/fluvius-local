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
const error = ref('');
const summary = ref(null);
const leadsPayload = ref({ stages: [], leads: [] });
const stageFilter = ref('');
const followupOnly = ref(false);

const accountId = computed(() => Number(route.params.accountId || route.params.account_id || 0));
const userId = computed(() => Number(currentUserId.value || 0));
const stages = computed(() => leadsPayload.value.stages || summary.value?.stages || []);
const leads = computed(() => leadsPayload.value.leads || []);
const stageCards = computed(() => summary.value?.stages || []);

async function request(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${API_BASE}${path}${separator}userId=${userId.value}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
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
    leadsPayload.value = leadsData;
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

onMounted(loadCrm);
</script>

<template>
  <main class="flex flex-col w-full min-h-full overflow-auto bg-n-background text-n-slate-12">
    <header class="px-4 py-4 border-b border-n-weak bg-n-background">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <h1 class="m-0 text-xl font-semibold text-n-slate-12">
            CRM WhatsApp
          </h1>
          <p class="mt-1 mb-0 text-sm text-n-slate-11">
            Acompanhe leads, follow-ups e oportunidades vindas do WhatsApp.
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
    </header>

    <section class="px-4 py-3 border-b border-n-weak bg-n-solid-1">
      <div class="flex flex-wrap items-end gap-2">
        <label class="grid gap-1">
          <span class="text-xs font-medium text-n-slate-11">Etapa</span>
          <select
            v-model="stageFilter"
            class="h-9 min-w-[180px] rounded-md border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 outline-none"
            @change="loadCrm"
          >
            <option value="">Todas as etapas</option>
            <option v-for="stage in stages" :key="stage.key" :value="stage.key">
              {{ stage.title }}
            </option>
          </select>
        </label>

        <label class="flex items-center h-9 gap-2 px-3 rounded-md border border-n-weak bg-n-background text-sm text-n-slate-12">
          <input
            v-model="followupOnly"
            type="checkbox"
            class="m-0"
            @change="loadCrm"
          />
          <span>Somente follow-up pendente</span>
        </label>
      </div>
    </section>

    <section class="flex-1 p-4">
      <div
        v-if="error"
        class="mb-4 rounded-md border border-n-ruby-5 bg-n-ruby-2 px-3 py-2.5 text-sm text-n-ruby-11"
      >
        {{ error }}
      </div>

      <div v-if="summary" class="grid grid-cols-1 gap-2 mb-4 md:grid-cols-3 xl:grid-cols-5">
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-3">
          <span class="text-sm text-n-slate-11">Leads novos</span>
          <strong class="block mt-2 text-2xl font-semibold text-n-slate-12">
            {{ summary.new_leads }}
          </strong>
        </article>
        <article class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-3">
          <span class="text-sm text-n-slate-11">Conversas abertas</span>
          <strong class="block mt-2 text-2xl font-semibold text-n-slate-12">
            {{ summary.open_conversations }}
          </strong>
        </article>
        <article class="rounded-md border border-n-amber-5 bg-n-amber-2 px-3 py-3">
          <span class="text-sm text-n-amber-11">Follow-up pendente</span>
          <strong class="block mt-2 text-2xl font-semibold text-n-amber-12">
            {{ summary.followups }}
          </strong>
        </article>
        <article
          v-for="stage in stageCards"
          :key="stage.key"
          class="rounded-md border border-n-weak bg-n-solid-1 px-3 py-3"
        >
          <span class="block truncate text-sm text-n-slate-11">{{ stage.title }}</span>
          <strong class="block mt-2 text-2xl font-semibold text-n-slate-12">
            {{ stage.total }}
          </strong>
        </article>
      </div>

      <div class="overflow-hidden rounded-md border border-n-weak bg-n-solid-1">
        <div
          v-if="loading"
          class="flex min-h-48 items-center justify-center text-sm text-n-slate-11"
        >
          Carregando CRM...
        </div>
        <div
          v-else-if="!leads.length"
          class="flex min-h-48 flex-col items-center justify-center gap-1 text-center"
        >
          <strong class="text-sm text-n-slate-12">Nenhum lead encontrado.</strong>
          <span class="text-sm text-n-slate-11">
            As conversas do WhatsApp aparecerão aqui quando chegarem.
          </span>
        </div>
        <table v-else class="w-full border-collapse">
          <thead class="bg-n-solid-2">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-n-slate-11">
                Lead
              </th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-n-slate-11">
                Etapa
              </th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-n-slate-11">
                Responsável
              </th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-n-slate-11">
                Última mensagem
              </th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-n-slate-11">
                Follow-up
              </th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-n-slate-11">
                Atividade
              </th>
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="lead in leads"
              :key="lead.id"
              class="border-t border-n-weak hover:bg-n-alpha-1"
            >
              <td class="px-4 py-3 align-middle">
                <strong class="block text-sm font-medium text-n-slate-12">
                  {{ lead.contact_name || lead.phone_number || 'Contato sem nome' }}
                </strong>
                <span class="block text-sm text-n-slate-11">
                  {{ lead.phone_number || lead.contact_email || 'Sem telefone' }}
                </span>
                <small
                  v-if="commercialField(lead, 'produto_interesse')"
                  class="block text-xs text-n-slate-10"
                >
                  {{ commercialField(lead, 'produto_interesse') }}
                </small>
              </td>
              <td class="px-4 py-3 align-middle">
                <select
                  :value="lead.stage_key"
                  :disabled="savingConversationId === lead.id"
                  class="h-8 max-w-44 rounded-md border border-n-weak bg-n-background px-2 text-sm text-n-slate-12 outline-none"
                  @change="updateStage(lead, $event)"
                >
                  <option v-for="stage in stages" :key="stage.key" :value="stage.key">
                    {{ stage.title }}
                  </option>
                </select>
              </td>
              <td class="px-4 py-3 text-sm text-n-slate-12 align-middle">
                {{ lead.assignee_name || 'Sem responsável' }}
              </td>
              <td class="px-4 py-3 text-sm text-n-slate-11 align-middle">
                <span class="block max-w-64 truncate">
                  {{ lead.last_message || 'Sem mensagem' }}
                </span>
              </td>
              <td class="px-4 py-3 align-middle">
                <span
                  class="inline-flex min-h-6 items-center rounded-md px-2 text-xs font-medium"
                  :class="
                    lead.needs_followup
                      ? 'bg-n-amber-3 text-n-amber-11'
                      : 'bg-n-slate-3 text-n-slate-11'
                  "
                >
                  {{ lead.needs_followup ? 'Pendente' : (commercialField(lead, 'proximo_follow_up') || '-') }}
                </span>
              </td>
              <td class="px-4 py-3 text-sm text-n-slate-11 align-middle">
                {{ formatDate(lead.last_activity_at || lead.created_at) }}
              </td>
              <td class="px-4 py-3 text-right align-middle">
                <Button
                  label="Abrir"
                  size="sm"
                  slate
                  @click="openConversation(lead)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>
