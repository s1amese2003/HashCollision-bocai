<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, ApiError, type MarketKind } from '../api';
import { toastError } from '../store';
import MarketDetail from './MarketDetail.vue';
import OddsDetail from './OddsDetail.vue';

/** Picks the detail page for the market's kind. */
const props = defineProps<{ id: number }>();
const kind = ref<MarketKind | null>(null);
const notFound = ref(false);

async function load() {
  kind.value = null;
  notFound.value = false;
  try {
    kind.value = (await api.market(props.id)).market.kind;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound.value = true;
    else toastError(e);
  }
}
watch(() => props.id, load, { immediate: true });
</script>

<template>
  <div v-if="notFound" class="empty card">市场不存在。<RouterLink to="/">返回列表</RouterLink></div>
  <div v-else-if="!kind" class="empty">加载中…</div>
  <OddsDetail v-else-if="kind === 'ODDS'" :id="id" />
  <MarketDetail v-else :id="id" />
</template>
