<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, pts, SCALE, toUnits, type MarketKind } from '../api';
import { refreshMe, store, toast, toastError } from '../store';

const router = useRouter();

function localInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

const kind = ref<MarketKind>('LMSR');
const title = ref('');
const description = ref('');
const rules = ref('');
const sourceUrl = ref('');
const closeAt = ref(localInput(Date.now() + 7 * 86400_000));
const busy = ref(false);

// LMSR
const subsidy = ref(50);
const minS = computed(() => (store.config?.minSubsidy ?? 20 * SCALE) / SCALE);
const maxS = computed(() => (store.config?.maxSubsidy ?? 2000 * SCALE) / SCALE);

// ODDS
const deposit = ref(50);
const options = ref<{ label: string; odds: number | null }[]>([
  { label: '主胜', odds: 1.85 },
  { label: '平', odds: 3.2 },
  { label: '客胜', odds: 4.0 },
]);
const maxOptions = computed(() => store.config?.maxOptions ?? 10);
const minDeposit = computed(() => (store.config?.minDeposit ?? 10 * SCALE) / SCALE);
const oddsInt = (v: number | null) => Math.round((v ?? 0) * 100);
const optionsProblem = computed(() => {
  const labels = options.value.map((o) => o.label.trim());
  if (labels.some((l) => !l)) return '选项名称不能为空';
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) return '选项名称不能重复';
  const lo = store.config?.minOdds ?? 101;
  const hi = store.config?.maxOdds ?? 10000;
  if (options.value.some((o) => !(oddsInt(o.odds) >= lo && oddsInt(o.odds) <= hi))) return '赔率需在 1.01 到 100 之间';
  return '';
});
/** Sum of implied probabilities; above 100% means the book has a margin for the bookmaker. */
const overround = computed(() => options.value.reduce((s, o) => s + (o.odds && o.odds > 0 ? 1 / o.odds : 0), 0));

const cost = computed(() => (kind.value === 'ODDS' ? deposit.value : subsidy.value));
const canAfford = computed(() => toUnits(cost.value) <= (store.me?.balance ?? 0));
const invalid = computed(
  () => kind.value === 'ODDS' && (!!optionsProblem.value || !(deposit.value >= minDeposit.value)),
);

async function submit() {
  busy.value = true;
  try {
    const base = {
      title: title.value,
      description: description.value,
      rules: rules.value,
      sourceUrl: sourceUrl.value.trim(),
      closeAt: new Date(closeAt.value).getTime(),
    };
    const r =
      kind.value === 'ODDS'
        ? await api.createMarket({
            ...base,
            kind: 'ODDS',
            deposit: toUnits(deposit.value),
            options: options.value.map((o) => ({ label: o.label.trim(), odds: oddsInt(o.odds) })),
          })
        : await api.createMarket({ ...base, kind: 'LMSR', subsidy: toUnits(subsidy.value) });
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

    <div class="tabs">
      <button type="button" :class="{ active: kind === 'LMSR' }" @click="kind = 'LMSR'">是/否预测</button>
      <button type="button" :class="{ active: kind === 'ODDS' }" @click="kind = 'ODDS'">固定赔率（坐庄）</button>
    </div>
    <p v-if="kind === 'LMSR'" class="muted small">
      提一个将来会有明确答案的“是/否”问题。价格由系统自动做市，随买卖变化。你需要拿出一部分积分作为流动性补贴，市场结算后剩余部分会返还给你。
    </p>
    <p v-else class="muted small">
      你来当庄家：自己定每个选项的赔率，押一笔保证金。别人下注时锁定当时的赔率，猜中按赔率兑付（含本金），猜错的投注归你。
      保证金加上收到的投注必须够赔任何一个结果，所以保证金越多，能接的注越多。
    </p>

    <div>
      <label for="t">{{ kind === 'ODDS' ? '赛事 / 问题' : '问题' }}</label>
      <input
        id="t"
        v-model="title"
        maxlength="120"
        :placeholder="kind === 'ODDS' ? '例如：周六 曼城 vs 阿森纳 全场胜平负' : '例如：本周五之前北京会下雪吗？'"
        required
      />
    </div>

    <div v-if="kind === 'ODDS'">
      <label>选项和赔率</label>
      <div v-for="(o, i) in options" :key="i" class="row opt-row">
        <input v-model="o.label" maxlength="30" placeholder="选项名称" class="grow" />
        <input v-model.number="o.odds" type="number" min="1.01" max="100" step="0.01" placeholder="赔率" class="odds" />
        <button type="button" class="small" :disabled="options.length <= 2" @click="options.splice(i, 1)">删除</button>
      </div>
      <div class="row">
        <button
          type="button"
          class="small"
          :disabled="options.length >= maxOptions"
          @click="options.push({ label: '', odds: 2 })"
        >
          添加选项
        </button>
        <div class="spacer" />
        <span class="hint num">隐含概率合计 {{ (overround * 100).toFixed(1) }}%</span>
      </div>
      <div class="hint">
        赔率为小数赔率（含本金）：赔率 1.85 押 10 积分，猜中拿回 18.5。隐含概率合计超过 100% 的部分是庄家的优势。
      </div>
      <div v-if="optionsProblem" class="small no-text">{{ optionsProblem }}</div>
    </div>

    <div>
      <label for="r">判定规则</label>
      <textarea
        id="r"
        v-model="rules"
        maxlength="2000"
        :placeholder="
          kind === 'ODDS'
            ? '以哪个比分为准（是否含加时、点球），比赛延期或取消怎么处理，以哪个信息来源为准。'
            : '什么情况算“是”，什么情况算“否”，以哪个信息来源为准。写得越清楚，越不容易起争议。'
        "
        required
      />
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
        <label for="c">{{ kind === 'ODDS' ? '停止下注时间' : '交易截止时间' }}</label>
        <input id="c" v-model="closeAt" type="datetime-local" required />
        <div class="hint">{{ kind === 'ODDS' ? '一般设为开赛时间。截止后由你提交结果。' : '截止后停止交易，由你提交结果。' }}</div>
      </div>
      <div v-if="kind === 'LMSR'">
        <label for="sub">流动性补贴：{{ subsidy }} 积分</label>
        <input id="sub" v-model.number="subsidy" type="range" :min="minS" :max="maxS" step="10" />
        <div class="hint">
          平台会额外补贴 {{ (store.config?.houseSubsidy ?? 0) / SCALE }} 积分流动性。补贴越多，价格越不容易被单笔交易推动；你的补贴是你最多可能亏掉的积分。
        </div>
      </div>
      <div v-else>
        <label for="dep">保证金（积分）</label>
        <input id="dep" v-model.number="deposit" type="number" :min="minDeposit" step="10" />
        <div class="hint">至少 {{ minDeposit }} 积分，开盘后还可以追加。这是你最多可能亏掉的积分。</div>
      </div>
    </div>

    <div class="row">
      <span class="muted small num">可用 {{ pts(store.me?.balance ?? 0) }} 积分</span>
      <div class="spacer" />
      <button class="primary" :disabled="busy || !canAfford || invalid">
        {{ canAfford ? `支付 ${cost} 积分并创建` : '积分不足' }}
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
.opt-row {
  margin-bottom: 8px;
  gap: 8px;
}
.odds {
  width: 96px;
}
.grow {
  flex: 1;
  min-width: 0;
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
