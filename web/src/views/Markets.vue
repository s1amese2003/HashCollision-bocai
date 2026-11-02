<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { api, pct, pts, relative, STATUS_LABEL, OUTCOME_LABEL, type Market } from '../api';
import ProbBar from '../components/ProbBar.vue';
import { onLive, store, toastError } from '../store';

const filters = [
  { key: 'active', label: '交易中' },
  { key: 'closed', label: '待判定' },
  { key: 'settled', label: '已结算' },
] as const;

const filter = ref<(typeof filters)[number]['key']>('active');
const markets = ref<Market[]>([]);
const loading = ref(true);

async function load() {
  try {
    markets.value = (await api.markets(filter.value)).markets;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

watch(filter, () => {
  loading.value = true;
  load();
});

let off: (() => void) | undefined;
onMounted(() => {
  load();
  off = onLive((e) => {
    if (e.type !== 'market') return;
    const m = markets.value.find((x) => x.id === e.marketId);
    if (m && m.status === e.status) {
      m.priceYes = e.priceYes;
      m.volume = e.volume;
    } else {
      load();
    }
  });
});
onUnmounted(() => off?.());
</script>

<template>
  <div class="head row">
    <h1>市场</h1>
    <div class="spacer" />
    <div class="tabs filter">
      <button v-for="f in filters" :key="f.key" :class="{ active: filter === f.key }" @click="filter = f.key">
        {{ f.label }}
      </button>
    </div>
  </div>

  <div v-if="loading" class="empty">加载中…</div>
  <div v-else-if="markets.length === 0" class="empty card">
    <p>这里还没有市场。</p>
    <RouterLink v-if="store.me && filter === 'active'" to="/new"><button class="primary">创建第一个市场</button></RouterLink>
  </div>

  <div v-else class="grid">
    <RouterLink v-for="m in markets" :key="m.id" :to="`/m/${m.id}`" class="card market">
      <div class="title">{{ m.title }}</div>
      <div class="prob row">
        <template v-if="m.status === 'RESOLVED' && m.resolution">
          <span class="badge" :class="m.resolution">结果：{{ OUTCOME_LABEL[m.resolution] }}</span>
        </template>
        <template v-else-if="m.status === 'CANCELLED'">
          <span class="badge">已作废</span>
        </template>
        <template v-else>
          <span class="big num yes-text">{{ pct(m.priceYes) }}</span>
          <span class="muted small">认为“是”</span>
        </template>
      </div>
      <ProbBar v-if="m.status !== 'CANCELLED'" :p="m.priceYes" />
      <div class="meta row small muted">
        <span class="badge" :class="m.status">{{ STATUS_LABEL[m.status] }}</span>
        <span class="num">成交 {{ pts(m.volume) }}</span>
        <div class="spacer" />
        <span v-if="m.status === 'OPEN'">{{ relative(m.closeAt) }}截止</span>
        <span v-else>{{ m.creatorName }}</span>
      </div>
    </RouterLink>
  </div>
</template>

<style scoped>
.head {
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.filter {
  min-width: 260px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.market {
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s, transform 0.15s;
}
.market:hover {
  border-color: var(--accent);
}
.title {
  font-weight: 600;
  font-size: 16px;
  min-height: 2.6em;
}
.prob {
  gap: 8px;
  align-items: baseline;
}
.big {
  font-size: 26px;
  font-weight: 700;
}
.meta {
  gap: 8px;
}
@media (max-width: 640px) {
  .filter {
    min-width: 0;
    width: 100%;
    margin-top: 10px;
  }
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
