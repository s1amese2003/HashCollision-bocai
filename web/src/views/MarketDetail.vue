<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  api,
  ApiError,
  dateTime,
  OUTCOME_LABEL,
  pct,
  pts,
  relative,
  SCALE,
  STATUS_LABEL,
  toUnits,
  type Market,
  type Outcome,
  type Position,
  type Quote,
  type Side,
  type TradeRow,
} from '../api';
import PriceChart from '../components/PriceChart.vue';
import { onLive, store, toast, toastError } from '../store';

const props = defineProps<{ id: number }>();

const market = ref<Market | null>(null);
const trades = ref<TradeRow[]>([]);
const positions = ref<Record<Outcome, Position> | null>(null);
const history = ref<{ t: number; p: number }[]>([]);
const notFound = ref(false);
const now = ref(Date.now());

async function load() {
  try {
    const [d, h] = await Promise.all([api.market(props.id), api.history(props.id)]);
    market.value = d.market;
    trades.value = d.trades;
    positions.value = d.positions;
    history.value = h.points;
    now.value = Date.now();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound.value = true;
    else toastError(e);
  }
}

// --- trading -------------------------------------------------------------------

const side = ref<Side>('BUY');
const outcome = ref<Outcome>('YES');
const input = ref<number | null>(null);
const quote = ref<Quote | null>(null);
const quoteError = ref('');
const busy = ref(false);

const isOpen = computed(() => market.value?.status === 'OPEN');
const held = computed(() => positions.value?.[outcome.value].shares ?? 0);
const priceOf = (o: Outcome) => (market.value ? (o === 'YES' ? market.value.priceYes : 1 - market.value.priceYes) : 0.5);

let quoteTimer: ReturnType<typeof setTimeout> | undefined;
function requestQuote() {
  clearTimeout(quoteTimer);
  quote.value = null;
  quoteError.value = '';
  const units = toUnits(input.value ?? 0);
  if (!isOpen.value || units <= 0) return;
  quoteTimer = setTimeout(async () => {
    try {
      const body = side.value === 'BUY' ? { outcome: outcome.value, side: 'BUY', amount: units } : { outcome: outcome.value, side: 'SELL', shares: units };
      quote.value = (await api.quote(props.id, body)).quote;
    } catch (e) {
      quoteError.value = e instanceof Error ? e.message : String(e);
    }
  }, 200);
}
watch([side, outcome, input], requestQuote);
watch(side, () => (input.value = null));

function setMax() {
  if (side.value === 'BUY') input.value = Math.floor((store.me?.balance ?? 0) / SCALE);
  else input.value = held.value / SCALE;
}

const insufficient = computed(() => {
  const units = toUnits(input.value ?? 0);
  if (side.value === 'BUY') return units > (store.me?.balance ?? 0);
  return units > held.value;
});

async function submitTrade() {
  if (!quote.value) return;
  busy.value = true;
  try {
    const q = quote.value;
    const body =
      q.side === 'BUY'
        ? { outcome: q.outcome, side: 'BUY', amount: toUnits(input.value ?? 0), minShares: q.shares }
        : { outcome: q.outcome, side: 'SELL', shares: q.shares, minAmount: q.amount };
    const r = await api.trade(props.id, body);
    if (store.me) store.me.balance = r.balance;
    toast(
      r.quote.side === 'BUY'
        ? `买入 ${pts(r.quote.shares)} 份「${OUTCOME_LABEL[r.quote.outcome]}」，花费 ${pts(r.quote.amount)} 积分`
        : `卖出 ${pts(r.quote.shares)} 份，获得 ${pts(r.quote.amount)} 积分`,
    );
    input.value = null;
    await load();
  } catch (e) {
    toastError(e);
    if (e instanceof ApiError && e.code === 'SLIPPAGE') requestQuote();
  } finally {
    busy.value = false;
  }
}

// --- resolution -------------------------------------------------------------

const isCreator = computed(() => !!store.me && market.value?.creatorId === store.me.id);
const isAdmin = computed(() => store.me?.role === 'admin');
const unsettled = computed(() => !!market.value && !['RESOLVED', 'CANCELLED'].includes(market.value.status));
const canPropose = computed(() => isCreator.value && ['OPEN', 'CLOSED'].includes(market.value?.status ?? ''));
const canCancel = computed(() => unsettled.value && (isAdmin.value || (isCreator.value && trades.value.length === 0)));
const note = ref('');
const pending = ref<null | { kind: 'propose' | 'resolve'; outcome: Outcome } | { kind: 'cancel' }>(null);

async function confirmAction() {
  const p = pending.value;
  if (!p) return;
  busy.value = true;
  try {
    if (p.kind === 'propose') await api.propose(props.id, p.outcome, note.value);
    else if (p.kind === 'resolve') await api.resolve(props.id, p.outcome, note.value);
    else await api.cancel(props.id, note.value);
    toast('操作成功');
    pending.value = null;
    note.value = '';
    await load();
    const me = await api.me();
    store.me = me.user;
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

const pendingLabel = computed(() => {
  const p = pending.value;
  if (!p) return '';
  if (p.kind === 'cancel') return '确认作废这个市场？所有人按净投入退款。';
  const o = OUTCOME_LABEL[p.outcome];
  return p.kind === 'propose' ? `确认提交结果为「${o}」？公示期结束后自动结算。` : `确认最终判定为「${o}」？将立即结算，无法撤销。`;
});

// --- live -------------------------------------------------------------------

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let off: (() => void) | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  load();
  off = onLive((e) => {
    if (e.marketId !== props.id || e.type !== 'market') return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      await load();
      requestQuote();
    }, 150);
  });
  clock = setInterval(() => (now.value = Date.now()), 30_000);
});
onUnmounted(() => {
  off?.();
  clearInterval(clock);
});
watch(() => props.id, load);

const chartEnd = computed(() => {
  const m = market.value;
  if (!m) return now.value;
  if (m.status === 'OPEN') return now.value;
  return Math.min(m.resolvedAt ?? m.closeAt, m.closeAt, now.value);
});
</script>

<template>
  <div v-if="notFound" class="empty card">市场不存在。<RouterLink to="/">返回列表</RouterLink></div>
  <div v-else-if="!market" class="empty">加载中…</div>

  <div v-else class="layout">
    <section class="main-col stack">
      <div class="card">
        <div class="row small muted wrap">
          <span class="badge" :class="market.status">{{ STATUS_LABEL[market.status] }}</span>
          <span>由 {{ market.creatorName }} 创建</span>
          <span>·</span>
          <span v-if="market.status === 'OPEN'">{{ relative(market.closeAt, now) }}截止（{{ dateTime(market.closeAt) }}）</span>
          <span v-else>截止于 {{ dateTime(market.closeAt) }}</span>
        </div>
        <h1 class="title">{{ market.title }}</h1>

        <div class="row prob-line">
          <template v-if="market.status === 'RESOLVED' && market.resolution">
            <span class="big" :class="market.resolution === 'YES' ? 'yes-text' : 'no-text'">
              结果：{{ OUTCOME_LABEL[market.resolution] }}
            </span>
          </template>
          <template v-else-if="market.status === 'CANCELLED'">
            <span class="big muted">已作废</span>
          </template>
          <template v-else>
            <span class="big num yes-text">{{ pct(market.priceYes) }}</span>
            <span class="muted">的概率认为“是”</span>
          </template>
          <div class="spacer" />
          <span class="muted small num">成交 {{ pts(market.volume) }} · 流动性 {{ pts(market.subsidy) }}</span>
        </div>

        <PriceChart :points="history" :end="chartEnd" />
      </div>

      <!-- Resolution status -->
      <div v-if="market.status === 'PROPOSED'" class="card notice warn">
        <b>创建者已提交结果：{{ OUTCOME_LABEL[market.proposedOutcome!] }}</b>
        <p v-if="market.proposalNote">{{ market.proposalNote }}</p>
        <p class="small">公示期至 {{ dateTime(market.finalizesAt!) }}（{{ relative(market.finalizesAt!, now) }}），到期自动结算。如有异议请联系管理员。</p>
      </div>
      <div v-else-if="market.status === 'RESOLVED'" class="card notice" :class="market.resolution === 'YES' ? 'yes' : 'no'">
        <b>已结算，结果为「{{ OUTCOME_LABEL[market.resolution!] }}」</b>
        <p v-if="market.resolutionNote">{{ market.resolutionNote }}</p>
        <p class="small muted">结算时间 {{ dateTime(market.resolvedAt!) }}，猜对的每份兑付 1 积分。</p>
      </div>
      <div v-else-if="market.status === 'CANCELLED'" class="card notice">
        <b>市场已作废</b>
        <p v-if="market.resolutionNote">{{ market.resolutionNote }}</p>
        <p class="small muted">所有参与者已按净投入退款。</p>
      </div>
      <div v-else-if="market.status === 'CLOSED'" class="card notice warn">
        <b>交易已截止，等待创建者提交结果。</b>
      </div>

      <div class="card stack">
        <h3>判定规则</h3>
        <p class="pre">{{ market.rules }}</p>
        <template v-if="market.description">
          <h3>说明</h3>
          <p class="pre">{{ market.description }}</p>
        </template>
        <p v-if="market.sourceUrl" class="small">
          信息来源：<a :href="market.sourceUrl" target="_blank" rel="noopener noreferrer" class="link">{{ market.sourceUrl }}</a>
        </p>
      </div>

      <div class="card">
        <h3>最近成交</h3>
        <div v-if="trades.length === 0" class="muted small pad">还没有人交易。</div>
        <div v-else class="table-wrap">
          <table class="small">
            <thead>
              <tr><th>用户</th><th>操作</th><th>份数</th><th>积分</th><th>成交后</th><th>时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="t in trades" :key="t.id">
                <td>{{ t.username }}</td>
                <td>
                  {{ t.side === 'BUY' ? '买入' : '卖出' }}
                  <span :class="t.outcome === 'YES' ? 'yes-text' : 'no-text'">{{ OUTCOME_LABEL[t.outcome] }}</span>
                </td>
                <td class="num">{{ pts(t.shares) }}</td>
                <td class="num">{{ pts(t.amount) }}</td>
                <td class="num">{{ pct(t.priceAfter) }}</td>
                <td class="muted">{{ dateTime(t.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <aside class="side-col stack">
      <!-- Trade panel -->
      <div class="card stack">
        <div class="tabs">
          <button :class="{ active: side === 'BUY' }" @click="side = 'BUY'">买入</button>
          <button :class="{ active: side === 'SELL' }" @click="side = 'SELL'">卖出</button>
        </div>
        <div class="outcomes">
          <button class="oc" :class="{ sel: outcome === 'YES', yesb: true }" @click="outcome = 'YES'">
            是 <span class="num">{{ pct(priceOf('YES')) }}</span>
          </button>
          <button class="oc" :class="{ sel: outcome === 'NO', nob: true }" @click="outcome = 'NO'">
            否 <span class="num">{{ pct(priceOf('NO')) }}</span>
          </button>
        </div>

        <template v-if="!store.me">
          <RouterLink to="/login"><button class="primary full">登录后交易</button></RouterLink>
        </template>
        <template v-else-if="!isOpen">
          <div class="muted small center">该市场已停止交易</div>
        </template>
        <template v-else>
          <div>
            <label for="amt">{{ side === 'BUY' ? '花费积分' : '卖出份数' }}</label>
            <div class="row">
              <input id="amt" v-model.number="input" type="number" min="0" step="any" inputmode="decimal" placeholder="0" />
              <button class="small" @click="setMax">最大</button>
            </div>
            <div class="hint num">
              <template v-if="side === 'BUY'">可用 {{ pts(store.me.balance) }} 积分</template>
              <template v-else>持有 {{ pts(held) }} 份「{{ OUTCOME_LABEL[outcome] }}」</template>
            </div>
          </div>

          <div v-if="quote" class="quote small num">
            <template v-if="quote.side === 'BUY'">
              <div class="row"><span class="muted">获得份数</span><div class="spacer" />{{ pts(quote.shares) }}</div>
              <div class="row"><span class="muted">平均价格</span><div class="spacer" />{{ (quote.avgPrice * 100).toFixed(1) }}%</div>
              <div class="row"><span class="muted">成交后概率（是）</span><div class="spacer" />{{ pct(quote.priceYesAfter) }}</div>
              <div class="row strong">
                <span>若结果为「{{ OUTCOME_LABEL[quote.outcome] }}」可得</span><div class="spacer" />
                <span class="yes-text">{{ pts(quote.shares) }}（+{{ pts(quote.shares - quote.amount) }}）</span>
              </div>
            </template>
            <template v-else>
              <div class="row"><span class="muted">可得积分</span><div class="spacer" />{{ pts(quote.amount) }}</div>
              <div class="row"><span class="muted">平均价格</span><div class="spacer" />{{ (quote.avgPrice * 100).toFixed(1) }}%</div>
              <div class="row"><span class="muted">成交后概率（是）</span><div class="spacer" />{{ pct(quote.priceYesAfter) }}</div>
            </template>
          </div>
          <div v-else-if="quoteError" class="small no-text">{{ quoteError }}</div>

          <button
            class="full"
            :class="outcome === 'YES' ? 'yes' : 'no'"
            :disabled="!quote || busy || insufficient"
            @click="submitTrade"
          >
            <template v-if="insufficient">{{ side === 'BUY' ? '积分不足' : '份数不足' }}</template>
            <template v-else>{{ side === 'BUY' ? '买入' : '卖出' }}「{{ OUTCOME_LABEL[outcome] }}」</template>
          </button>
        </template>
      </div>

      <!-- Positions -->
      <div v-if="positions && (positions.YES.shares > 0 || positions.NO.shares > 0)" class="card">
        <h3>我的持仓</h3>
        <table class="small num">
          <thead><tr><th>方向</th><th>份数</th><th>成本</th><th>现值</th></tr></thead>
          <tbody>
            <template v-for="o in (['YES', 'NO'] as const)" :key="o">
              <tr v-if="positions[o].shares > 0">
                <td :class="o === 'YES' ? 'yes-text' : 'no-text'">{{ OUTCOME_LABEL[o] }}</td>
                <td>{{ pts(positions[o].shares) }}</td>
                <td>{{ pts(positions[o].cost_basis) }}</td>
                <td>{{ market.status === 'RESOLVED' ? (market.resolution === o ? pts(positions[o].shares) : '0') : pts(positions[o].shares * priceOf(o)) }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- Resolution controls -->
      <div v-if="canPropose || (isAdmin && unsettled) || canCancel" class="card stack">
        <h3>{{ isAdmin ? '管理' : '提交结果' }}</h3>
        <template v-if="!pending">
          <textarea v-model="note" placeholder="判定说明（可选），例如依据的新闻链接" />
          <div v-if="canPropose" class="row">
            <button class="yes grow" @click="pending = { kind: 'propose', outcome: 'YES' }">结果为「是」</button>
            <button class="no grow" @click="pending = { kind: 'propose', outcome: 'NO' }">结果为「否」</button>
          </div>
          <div v-if="isAdmin && unsettled" class="row">
            <button class="yes grow" @click="pending = { kind: 'resolve', outcome: 'YES' }">最终判定「是」</button>
            <button class="no grow" @click="pending = { kind: 'resolve', outcome: 'NO' }">最终判定「否」</button>
          </div>
          <button v-if="canCancel" class="full" @click="pending = { kind: 'cancel' }">作废市场</button>
          <p v-if="canPropose" class="hint">提交后进入 {{ Math.round((store.config?.disputeWindowMs ?? 0) / 3600_000) }} 小时公示期，期间管理员可以更正。</p>
        </template>
        <template v-else>
          <p>{{ pendingLabel }}</p>
          <div class="row">
            <button class="primary grow" :disabled="busy" @click="confirmAction">确认</button>
            <button class="grow" @click="pending = null">取消</button>
          </div>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 16px;
  align-items: start;
}
.side-col {
  position: sticky;
  top: 76px;
}
.wrap {
  flex-wrap: wrap;
  gap: 6px;
}
.title {
  font-size: 22px;
  margin: 10px 0 6px;
}
.prob-line {
  align-items: baseline;
  margin-bottom: 10px;
  flex-wrap: wrap;
  gap: 8px;
}
.big {
  font-size: 30px;
  font-weight: 700;
}
.pre {
  white-space: pre-wrap;
  margin: 0;
}
h3 {
  font-size: 15px;
  margin-bottom: 4px;
}
.link {
  color: var(--accent);
  word-break: break-all;
}
.pad {
  padding: 12px 0 0;
}
.notice p {
  margin: 6px 0 0;
}
.notice.warn {
  background: var(--warn-soft);
  border-color: transparent;
}
.notice.yes {
  background: var(--yes-soft);
  border-color: transparent;
}
.notice.no {
  background: var(--no-soft);
  border-color: transparent;
}
.outcomes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.oc {
  padding: 12px;
  font-size: 16px;
  font-weight: 600;
}
.oc.yesb.sel {
  background: var(--yes-soft);
  border-color: var(--yes);
  color: var(--yes);
}
.oc.nob.sel {
  background: var(--no-soft);
  border-color: var(--no);
  color: var(--no);
}
.quote {
  background: var(--surface-2);
  border-radius: 9px;
  padding: 10px 12px;
  display: grid;
  gap: 4px;
}
.strong {
  font-weight: 600;
  margin-top: 4px;
}
.full {
  width: 100%;
  padding: 11px;
}
.grow {
  flex: 1;
}
.center {
  text-align: center;
  padding: 8px 0;
}
@media (max-width: 860px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side-col {
    position: static;

  }
}
</style>
