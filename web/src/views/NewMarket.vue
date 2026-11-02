<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, pts, SCALE, toUnits } from '../api';
import { refreshMe, store, toast, toastError } from '../store';

const router = useRouter();

function localInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

const title = ref('');
const description = ref('');
const rules = ref('');
const sourceUrl = ref('');
const closeAt = ref(localInput(Date.now() + 7 * 86400_000));
const subsidy = ref(100);
const busy = ref(false);

const minS = computed(() => (store.config?.minSubsidy ?? 20 * SCALE) / SCALE);
const maxS = computed(() => (store.config?.maxSubsidy ?? 2000 * SCALE) / SCALE);
const canAfford = computed(() => toUnits(subsidy.value) <= (store.me?.balance ?? 0));

async function submit() {
  busy.value = true;
  try {
    const r = await api.createMarket({
      title: title.value,
      description: description.value,
      rules: rules.value,
      sourceUrl: sourceUrl.value.trim(),
      closeAt: new Date(closeAt.value).getTime(),
      subsidy: toUnits(subsidy.value),
    });
    await refreshMe();
    toast('市场已创建');
    router.push(`/m/${r.id}`);
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="store.loaded && !store.me" class="empty card">
    请先 <RouterLink to="/login" class="link">登录</RouterLink> 再创建市场。
  </div>
  <form v-else class="card stack form" @submit.prevent="submit">
    <h1>创建市场</h1>
    <p class="muted small">
      提一个将来会有明确答案的“是/否”问题。你需要拿出一部分积分作为流动性补贴，市场结算后剩余部分会返还给你。
    </p>

    <div>
      <label for="t">问题</label>
      <input id="t" v-model="title" maxlength="120" placeholder="例如：本周五之前北京会下雪吗？" required />
    </div>

    <div>
      <label for="r">判定规则</label>
      <textarea id="r" v-model="rules" maxlength="2000" placeholder="什么情况算“是”，什么情况算“否”，以哪个信息来源为准。写得越清楚，越不容易起争议。" required />
    </div>

    <div>
      <label for="d">补充说明（可选）</label>
      <textarea id="d" v-model="description" maxlength="2000" />
    </div>

    <div>
      <label for="s">信息来源链接（可选）</label>
      <input id="s" v-model="sourceUrl" type="url" placeholder="https://" />
    </div>

    <div class="two">
      <div>
        <label for="c">交易截止时间</label>
        <input id="c" v-model="closeAt" type="datetime-local" required />
        <div class="hint">截止后停止交易，由你提交结果。</div>
      </div>
      <div>
        <label for="sub">流动性补贴：{{ subsidy }} 积分</label>
        <input id="sub" v-model.number="subsidy" type="range" :min="minS" :max="maxS" step="10" />
        <div class="hint">
          平台会额外补贴 {{ (store.config?.houseSubsidy ?? 0) / SCALE }} 积分流动性。补贴越多，价格越不容易被单笔交易推动；你的补贴是你最多可能亏掉的积分。
        </div>
      </div>
    </div>

    <div class="row">
      <span class="muted small num">可用 {{ pts(store.me?.balance ?? 0) }} 积分</span>
      <div class="spacer" />
      <button class="primary" :disabled="busy || !canAfford">
        {{ canAfford ? `支付 ${subsidy} 积分并创建` : '积分不足' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.form {
  max-width: 680px;
  margin: 0 auto;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
input[type='range'] {
  padding: 0;
  border: none;
  accent-color: var(--accent);
  margin-top: 10px;
}
.link {
  color: var(--accent);
}
@media (max-width: 640px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
