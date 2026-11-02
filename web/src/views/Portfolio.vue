<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, dateTime, OUTCOME_LABEL, pts, REASON_LABEL, STATUS_LABEL, type LedgerRow, type PortfolioItem } from '../api';
import { store, toastError } from '../store';

const positions = ref<PortfolioItem[]>([]);
const ledger = ref<LedgerRow[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    const r = await api.portfolio();
    positions.value = r.positions;
    ledger.value = r.ledger;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
});

const totalValue = computed(() => positions.value.reduce((s, p) => s + p.value, 0));
const totalCost = computed(() => positions.value.reduce((s, p) => s + p.costBasis, 0));

function refLink(r: LedgerRow): string | null {
  const m = /^m(\d+)$/.exec(r.refId);
  return m ? `/m/${m[1]}` : null;
}
</script>

<template>
  <div v-if="store.loaded && !store.me" class="empty card">请先 <RouterLink to="/login">登录</RouterLink>。</div>
  <div v-else class="stack">
    <div class="stats">
      <div class="card stat">
        <div class="muted small">可用积分</div>
        <div class="v num">{{ pts(store.me?.balance ?? 0) }}</div>
      </div>
      <div class="card stat">
        <div class="muted small">持仓现值</div>
        <div class="v num">{{ pts(totalValue) }}</div>
      </div>
      <div class="card stat">
        <div class="muted small">持仓浮动盈亏</div>
        <div class="v num" :class="totalValue - totalCost >= 0 ? 'yes-text' : 'no-text'">
          {{ totalValue - totalCost >= 0 ? '+' : '' }}{{ pts(totalValue - totalCost) }}
        </div>
      </div>
    </div>

    <div class="card">
      <h3>当前持仓</h3>
      <div v-if="loading" class="muted small pad">加载中…</div>
      <div v-else-if="positions.length === 0" class="muted small pad">
        暂无持仓，去 <RouterLink to="/" class="link">市场</RouterLink> 看看。
      </div>
      <div v-else class="table-wrap">
        <table class="small">
          <thead><tr><th>市场</th><th>方向</th><th>份数</th><th>成本</th><th>现值</th><th>盈亏</th></tr></thead>
          <tbody>
            <tr v-for="p in positions" :key="`${p.marketId}-${p.outcome}`">
              <td>
                <RouterLink :to="`/m/${p.marketId}`" class="link">{{ p.title }}</RouterLink>
                <span class="badge" :class="p.status">{{ STATUS_LABEL[p.status] }}</span>
              </td>
              <td :class="p.outcome === 'YES' ? 'yes-text' : 'no-text'">{{ OUTCOME_LABEL[p.outcome] }}</td>
              <td class="num">{{ pts(p.shares) }}</td>
              <td class="num">{{ pts(p.costBasis) }}</td>
              <td class="num">{{ pts(p.value) }}</td>
              <td class="num" :class="p.value - p.costBasis >= 0 ? 'yes-text' : 'no-text'">
                {{ p.value - p.costBasis >= 0 ? '+' : '' }}{{ pts(p.value - p.costBasis) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>积分流水</h3>
      <div v-if="!loading && ledger.length === 0" class="muted small pad">暂无记录</div>
      <div v-else class="table-wrap">
        <table class="small">
          <thead><tr><th>时间</th><th>类型</th><th>变动</th><th>余额</th></tr></thead>
          <tbody>
            <tr v-for="l in ledger" :key="l.id">
              <td class="muted">{{ dateTime(l.createdAt) }}</td>
              <td>
                <RouterLink v-if="refLink(l)" :to="refLink(l)!" class="link">{{ REASON_LABEL[l.reason] ?? l.reason }}</RouterLink>
                <span v-else>{{ REASON_LABEL[l.reason] ?? l.reason }}</span>
              </td>
              <td class="num" :class="l.delta >= 0 ? 'yes-text' : 'no-text'">{{ l.delta >= 0 ? '+' : '' }}{{ pts(l.delta) }}</td>
              <td class="num">{{ pts(l.balanceAfter) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.stat .v {
  font-size: 24px;
  font-weight: 700;
  margin-top: 2px;
}
h3 {
  font-size: 15px;
  margin-bottom: 6px;
}
.pad {
  padding-top: 8px;
}
.link {
  color: var(--accent);
  margin-right: 6px;
}
@media (max-width: 640px) {
  .stats {
    grid-template-columns: 1fr;
  }
}
</style>
