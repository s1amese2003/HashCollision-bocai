<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { api, fmtOdds, pct, pts, relative, STATUS_LABEL, OUTCOME_LABEL, type Market } from '../api';
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
      // Odds and remaining capacity are not in the live event.
      if (m.kind === 'ODDS') load();
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
      <template v-if="m.kind === 'ODDS'">
        <div class="odds-row">
          <span
            v-for="o in m.options ?? []"
            :key="o.id"
            class="odds-chip"
            :class="{ won: m.status === 'RESOLVED' && m.resolvedOptionId === o.id }"
          >
            {{ o.label }} <b class="num">{{ fmtOdds(o.odds) }}</b>
          </span>
        </div>
        <div v-if="m.status === 'CANCELLED'"><span class="badge">已作废</span></div>
      </template>
      <div v-else class="prob row">
        <template v-if="m.status === 'RESOLVED' && m.resolution">
          <span class="badge" :class="m.resolution">结果：{{ OUTCOME_LABEL[m.resolution] }}</span>
        </template>
        <template v-else-if="m.status === 'CANCELLED'">
          <span class="badge">已作废</span>
        </template>
        <template v-else>
          <span class="big num yes-text">{{ pct(m.priceYes ?? 0.5) }}</span>
          <span class="muted small">认为“是”</span>
        </template>
      </div>
      <ProbBar v-if="m.kind === 'LMSR' && m.status !== 'CANCELLED'" :p="m.priceYes ?? 0.5" />
      <div class="meta row small muted">
        <span class="badge" :class="m.status">{{ STATUS_LABEL[m.status] }}</span>
        <span v-if="m.kind === 'ODDS'" class="badge kind">固定赔率</span>
        <span v-if="m.paused && m.status === 'OPEN'" class="badge CLOSED">已暂停</span>
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
.odds-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.odds-chip {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 13px;
}
.odds-chip b {
  color: var(--accent);
  margin-left: 2px;
}
.odds-chip.won {
  border-color: var(--yes);
  background: var(--yes-soft);
}
.badge.kind {
  background: var(--accent-soft);
  color: var(--accent);
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
