<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, pts, type LeaderRow } from '../api';
import { store, toastError } from '../store';

const rows = ref<LeaderRow[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    rows.value = (await api.leaderboard()).leaderboard;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="card board">
    <h1>排行榜</h1>
    <p class="muted small">盈利 = 当前总资产（积分 + 持仓现值 + 锁定的补贴）− 系统累计发放的积分。签到不算本事，预测准才算。</p>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="rows.length === 0" class="empty">还没有用户</div>
    <table v-else>
      <thead><tr><th>#</th><th>用户</th><th>总资产</th><th>盈利</th></tr></thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="r.userId" :class="{ me: store.me?.id === r.userId }">
          <td class="num rank">{{ i + 1 }}</td>
          <td>{{ r.username }}</td>
          <td class="num">{{ pts(r.netWorth) }}</td>
          <td class="num" :class="r.profit >= 0 ? 'yes-text' : 'no-text'">{{ r.profit >= 0 ? '+' : '' }}{{ pts(r.profit) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.board {
  max-width: 680px;
  margin: 0 auto;
}
h1 {
  margin-bottom: 4px;
}
table {
  margin-top: 12px;
}
.rank {
  width: 40px;
  color: var(--muted);
}
tr.me td {
  background: var(--accent-soft);
}
</style>
