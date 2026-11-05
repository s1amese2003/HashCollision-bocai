<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  api,
  ApiError,
  dateTime,
  fmtOdds,
  pts,
  relative,
  SCALE,
  STATUS_LABEL,
  toUnits,
  type BetRow,
  type Market,
  type OddsOption,
} from '../api';
import { onLive, refreshMe, store, toast, toastError } from '../store';

const props = defineProps<{ id: number }>();

const market = ref<Market | null>(null);
const bets = ref<BetRow[]>([]);
const myBets = ref<BetRow[] | null>(null);
const notFound = ref(false);
const now = ref(Date.now());

async function load() {
  try {
    const d = await api.market(props.id);
    market.value = d.market;
    bets.value = d.bets ?? [];
    myBets.value = d.myBets ?? null;
    now.value = Date.now();
    if (selectedId.value === null && d.market.options?.length) selectedId.value = d.market.options[0]!.id;
    if (!editingOdds.value) resetOddsDraft();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound.value = true;
    else toastError(e);
  }
}

const options = computed<OddsOption[]>(() => market.value?.options ?? []);
const optionLabel = (id: number | null) => options.value.find((o) => o.id === id)?.label ?? '';
const totalStake = computed(() => options.value.reduce((s, o) => s + o.stakeTotal, 0));
const pool = computed(() => (market.value?.subsidy ?? 0) + totalStake.value);

const isOpen = computed(() => market.value?.status === 'OPEN');
const canBet = computed(() => isOpen.value && !market.value?.paused && !store.tradingHalted);
const isCreator = computed(() => !!store.me && market.value?.creatorId === store.me.id);
const isAdmin = computed(() => store.me?.role === 'admin');
const unsettled = computed(() => !!market.value && !['RESOLVED', 'CANCELLED'].includes(market.value.status));

// --- betting -------------------------------------------------------------------

const selectedId = ref<number | null>(null);
const selected = computed(() => options.value.find((o) => o.id === selectedId.value) ?? null);
const stake = ref<number | null>(null);
const busy = ref(false);

const stakeUnits = computed(() => toUnits(stake.value ?? 0));
const payout = computed(() => (selected.value ? Math.floor((stakeUnits.value * selected.value.odds) / 100) : 0));
const minStake = computed(() => store.config?.minStake ?? SCALE);
const betProblem = computed(() => {
  const s = stakeUnits.value;
  if (!selected.value || s <= 0) return '';
  if (s < minStake.value) return `每注至少 ${pts(minStake.value)} 积分`;
  if (s > (store.me?.balance ?? 0)) return '积分不足';
  if (s > selected.value.maxStake) {
    return selected.value.maxStake < minStake.value
      ? '庄家保证金不足，这个选项暂时不能下注'
      : `庄家保证金不足，这个选项最多还能下注 ${pts(selected.value.maxStake)} 积分`;
  }
  return '';
});

function setMax() {
  if (!selected.value) return;
  const cap = Math.min(store.me?.balance ?? 0, selected.value.maxStake);
  stake.value = Math.floor(cap / SCALE);
}

async function submitBet() {
  const o = selected.value;
  if (!o || stakeUnits.value <= 0 || betProblem.value) return;
  busy.value = true;
  try {
    const r = await api.bet(props.id, { optionId: o.id, stake: stakeUnits.value, odds: o.odds });
    if (store.me) store.me.balance = r.balance;
    toast(`已下注「${o.label}」${pts(r.bet.stake)} 积分，赔率 ${fmtOdds(r.bet.odds)}，猜中可得 ${pts(r.bet.payout)}`);
    stake.value = null;
    await load();
  } catch (e) {
    toastError(e);
    // Stale odds or capacity: show the current numbers.
    if (e instanceof ApiError && ['SLIPPAGE', 'LIABILITY_LIMIT'].includes(e.code)) await load();
  } finally {
    busy.value = false;
  }
}

// --- bookmaker controls ---------------------------------------------------------

const oddsDraft = ref<Record<number, number>>({});
const editingOdds = ref(false);
function resetOddsDraft() {
  oddsDraft.value = Object.fromEntries(options.value.map((o) => [o.id, o.odds / 100]));
}
const changedOdds = computed(() =>
  options.value
    .map((o) => ({ optionId: o.id, odds: Math.round((oddsDraft.value[o.id] ?? 0) * 100) }))
    .filter((u) => u.odds !== options.value.find((o) => o.id === u.optionId)!.odds),
);
const oddsInvalid = computed(() => {
  const lo = store.config?.minOdds ?? 101;
  const hi = store.config?.maxOdds ?? 10000;
  return changedOdds.value.some((u) => !(u.odds >= lo && u.odds <= hi));
});

async function saveOdds() {
  if (changedOdds.value.length === 0) return;
  busy.value = true;
  try {
    await api.setOdds(props.id, changedOdds.value);
    toast('赔率已更新，只对之后的新投注生效');
    editingOdds.value = false;
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

const depositInput = ref<number | null>(null);
async function submitDeposit() {
  const units = toUnits(depositInput.value ?? 0);
  if (units <= 0) return;
  busy.value = true;
  try {
    await api.addDeposit(props.id, units);
    await refreshMe();
    toast(`已追加保证金 ${pts(units)} 积分`);
    depositInput.value = null;
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

/** Bookmaker's result if each option wins: pool - payouts - own deposit. */
const scenarios = computed(() =>
  options.value.map((o) => ({ ...o, net: pool.value - o.liability - (market.value?.subsidy ?? 0) })),
);

// --- resolution -------------------------------------------------------------------

const canPropose = computed(() => isCreator.value && ['OPEN', 'CLOSED'].includes(market.value?.status ?? ''));
const canCancel = computed(() => unsettled.value && (isAdmin.value || (isCreator.value && bets.value.length === 0)));
const note = ref('');
const pending = ref<null | { kind: 'propose' | 'resolve'; optionId: number } | { kind: 'cancel' }>(null);

const pendingLabel = computed(() => {
  const p = pending.value;
  if (!p) return '';
  if (p.kind === 'cancel') return '确认作废这个市场？所有投注原数退回，保证金退还庄家。';
  const l = optionLabel(p.optionId);
  return p.kind === 'propose'
    ? `确认提交结果为「${l}」？公示期结束后自动结算。`
    : `确认最终判定为「${l}」？将立即结算，无法撤销。`;
});

async function confirmAction() {
  const p = pending.value;
  if (!p) return;
  busy.value = true;
  try {
    if (p.kind === 'propose') await api.propose(props.id, { optionId: p.optionId }, note.value);
    else if (p.kind === 'resolve') await api.resolve(props.id, { optionId: p.optionId }, note.value);
    else await api.cancel(props.id, note.value);
    toast('操作成功');
    pending.value = null;
    note.value = '';
    await load();
    await refreshMe();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

async function togglePause() {
  if (!market.value) return;
  busy.value = true;
  try {
    await api.pause(props.id, !market.value.paused);
    toast(market.value.paused ? '已恢复下注' : '已暂停下注');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

// --- live ---------------------------------------------------------------------------

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let off: (() => void) | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  load();
  off = onLive((e) => {
    if (e.type !== 'market' || e.marketId !== props.id) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 150);
  });
  clock = setInterval(() => (now.value = Date.now()), 30_000);
});
onUnmounted(() => {
  off?.();
  clearInterval(clock);
});
watch(() => props.id, load);
</script>

<template>
  <div v-if="notFound" class="empty card">市场不存在。<RouterLink to="/">返回列表</RouterLink></div>
  <div v-else-if="!market" class="empty">加载中…</div>

  <div v-else class="layout">
    <section class="main-col stack">
      <div class="card">
        <div class="row small muted wrap">
          <span class="badge" :class="market.status">{{ STATUS_LABEL[market.status] }}</span>
          <span class="badge kind">固定赔率</span>
          <span>庄家 {{ market.creatorName }}</span>
          <span>·</span>
          <span v-if="market.status === 'OPEN'">{{ relative(market.closeAt, now) }}截止（{{ dateTime(market.closeAt) }}）</span>
          <span v-else>截止于 {{ dateTime(market.closeAt) }}</span>
        </div>
        <h1 class="title">{{ market.title }}</h1>

        <div class="opt-grid">
          <div
            v-for="o in options"
            :key="o.id"
            class="opt"
            :class="{
              won: market.status === 'RESOLVED' && market.resolvedOptionId === o.id,
              lost: market.status === 'RESOLVED' && market.resolvedOptionId !== o.id,
            }"
          >
            <div class="opt-label">{{ o.label }}</div>
            <div class="opt-odds num">{{ fmtOdds(o.odds) }}</div>
            <div class="small muted num">已投 {{ pts(o.stakeTotal) }}</div>
          </div>
        </div>
        <div class="row small muted num stats">
          <span>保证金 {{ pts(market.subsidy) }}</span>
          <span>·</span>
          <span>总投注 {{ pts(market.volume) }}</span>
        </div>
      </div>

      <div v-if="market.status === 'PROPOSED'" class="card notice warn">
        <b>庄家已提交结果：{{ optionLabel(market.proposedOptionId) }}</b>
        <p v-if="market.proposalNote">{{ market.proposalNote }}</p>
        <p class="small">
          公示期至 {{ dateTime(market.finalizesAt!) }}（{{ relative(market.finalizesAt!, now) }}），到期自动结算。如有异议请联系管理员。
        </p>
      </div>
      <div v-else-if="market.status === 'RESOLVED'" class="card notice yes">
        <b>已结算，结果为「{{ optionLabel(market.resolvedOptionId) }}」</b>
        <p v-if="market.resolutionNote">{{ market.resolutionNote }}</p>
        <p class="small muted">结算时间 {{ dateTime(market.resolvedAt!) }}，猜中的投注按下注时的赔率兑付（含本金）。</p>
      </div>
      <div v-else-if="market.status === 'CANCELLED'" class="card notice">
        <b>市场已作废</b>
        <p v-if="market.resolutionNote">{{ market.resolutionNote }}</p>
        <p class="small muted">所有投注已原数退回，保证金已退还庄家。</p>
      </div>
      <div v-else-if="market.status === 'OPEN' && market.paused" class="card notice warn">
        <b>管理员已暂停本市场的下注。</b>
        <p class="small">已下的注不受影响。</p>
      </div>
      <div v-else-if="market.status === 'CLOSED'" class="card notice warn">
        <b>下注已截止，等待庄家提交结果。</b>
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
        <h3>最近投注</h3>
        <div v-if="bets.length === 0" class="muted small pad">还没有人下注。</div>
        <div v-else class="table-wrap">
          <table class="small">
            <thead>
              <tr><th>用户</th><th>选项</th><th>金额</th><th>赔率</th><th>猜中可得</th><th>时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="b in bets" :key="b.id">
                <td>{{ b.username }}</td>
                <td>{{ b.label }}</td>
                <td class="num">{{ pts(b.stake) }}</td>
                <td class="num">{{ fmtOdds(b.odds) }}</td>
                <td class="num">{{ pts(b.payout) }}</td>
                <td class="muted">{{ dateTime(b.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <aside class="side-col stack">
      <!-- Bet slip -->
      <div v-if="!isCreator" class="card stack">
        <h3>下注</h3>
        <div class="pick">
          <button
            v-for="o in options"
            :key="o.id"
            class="pick-btn"
            :class="{ sel: selectedId === o.id }"
            @click="selectedId = o.id"
          >
            <span>{{ o.label }}</span>
            <span class="num">{{ fmtOdds(o.odds) }}</span>
          </button>
        </div>

        <template v-if="!store.me">
          <RouterLink to="/login"><button class="primary full">登录后下注</button></RouterLink>
        </template>
        <template v-else-if="!canBet">
          <div class="muted small center">
            {{ !isOpen ? '该市场已停止下注' : store.tradingHalted ? '全站交易已暂停' : '该市场已被管理员暂停下注' }}
          </div>
        </template>
        <template v-else-if="selected">
          <div>
            <label for="stake">下注积分</label>
            <div class="row">
              <input id="stake" v-model.number="stake" type="number" min="0" step="any" inputmode="decimal" placeholder="0" />
              <button class="small" @click="setMax">最大</button>
            </div>
            <div class="hint num">
              可用 {{ pts(store.me.balance) }} 积分 · 本选项最多还能下 {{ pts(selected.maxStake) }}
            </div>
          </div>

          <div v-if="stakeUnits > 0" class="quote small num">
            <div class="row"><span class="muted">赔率（下注时锁定）</span><div class="spacer" />{{ fmtOdds(selected.odds) }}</div>
            <div class="row strong">
              <span>若「{{ selected.label }}」胜出可得</span><div class="spacer" />
              <span class="yes-text">{{ pts(payout) }}（+{{ pts(payout - stakeUnits) }}）</span>
            </div>
            <div class="row"><span class="muted">否则</span><div class="spacer" /><span class="no-text">-{{ pts(stakeUnits) }}</span></div>
          </div>
          <div v-if="betProblem" class="small no-text">{{ betProblem }}</div>

          <button class="primary full" :disabled="busy || stakeUnits <= 0 || !!betProblem" @click="submitBet">
            下注「{{ selected.label }}」
          </button>
        </template>
      </div>

      <!-- Bookmaker panel -->
      <div v-if="isCreator" class="card stack">
        <h3>庄家面板</h3>
        <table class="small num">
          <thead><tr><th>若胜出</th><th>赔付</th><th>庄家盈亏</th></tr></thead>
          <tbody>
            <tr v-for="s in scenarios" :key="s.id">
              <td>{{ s.label }}</td>
              <td>{{ pts(s.liability) }}</td>
              <td :class="s.net >= 0 ? 'yes-text' : 'no-text'">{{ s.net >= 0 ? '+' : '' }}{{ pts(s.net) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="hint">保证金 {{ pts(market.subsidy) }} + 投注 {{ pts(totalStake) }} 必须够赔任何一个结果，超出的投注会被拒绝。</p>

        <template v-if="isOpen">
          <div>
            <label>调整赔率（只影响之后的新投注）</label>
            <div v-for="o in options" :key="o.id" class="row odds-row">
              <span class="grow">{{ o.label }}</span>
              <input
                v-model.number="oddsDraft[o.id]"
                type="number"
                min="1.01"
                max="100"
                step="0.01"
                class="odds-input"
                @focus="editingOdds = true"
              />
            </div>
            <div v-if="oddsInvalid" class="small no-text">赔率需在 1.01 到 100 之间</div>
            <div class="row">
              <button class="primary grow" :disabled="busy || changedOdds.length === 0 || oddsInvalid" @click="saveOdds">保存赔率</button>
              <button v-if="changedOdds.length" class="grow" @click="resetOddsDraft(); editingOdds = false">还原</button>
            </div>
          </div>
          <div>
            <label for="dep">追加保证金</label>
            <div class="row">
              <input id="dep" v-model.number="depositInput" type="number" min="0" step="10" placeholder="积分" />
              <button class="primary" :disabled="busy || !depositInput" @click="submitDeposit">追加</button>
            </div>
            <div class="hint">保证金越多，能接的注越多。结算后剩余部分全部返还给你。</div>
          </div>
        </template>
      </div>

      <!-- My bets -->
      <div v-if="myBets && myBets.length" class="card">
        <h3>我的投注</h3>
        <table class="small num">
          <thead><tr><th>选项</th><th>金额</th><th>赔率</th><th>猜中可得</th></tr></thead>
          <tbody>
            <tr v-for="b in myBets" :key="b.id">
              <td>{{ b.label }}</td>
              <td>{{ pts(b.stake) }}</td>
              <td>{{ fmtOdds(b.odds) }}</td>
              <td
                :class="
                  market.status === 'RESOLVED' ? (market.resolvedOptionId === b.optionId ? 'yes-text' : 'no-text') : ''
                "
              >
                {{ market.status === 'RESOLVED' && market.resolvedOptionId !== b.optionId ? '0' : pts(b.payout) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Resolution controls -->
      <div v-if="canPropose || (isAdmin && unsettled) || canCancel" class="card stack">
        <h3>{{ isAdmin ? '管理' : '提交结果' }}</h3>
        <template v-if="!pending">
          <textarea v-model="note" placeholder="判定说明（可选），例如比分和新闻链接" />
          <template v-if="canPropose">
            <div class="small muted">提交结果：</div>
            <div class="pick">
              <button v-for="o in options" :key="o.id" @click="pending = { kind: 'propose', optionId: o.id }">{{ o.label }}</button>
            </div>
          </template>
          <template v-if="isAdmin && unsettled">
            <div class="small muted">最终判定（立即结算）：</div>
            <div class="pick">
              <button v-for="o in options" :key="o.id" @click="pending = { kind: 'resolve', optionId: o.id }">{{ o.label }}</button>
            </div>
          </template>
          <button v-if="canCancel" class="full" @click="pending = { kind: 'cancel' }">作废市场</button>
          <p v-if="canPropose" class="hint">
            提交后进入 {{ Math.round((store.config?.disputeWindowMs ?? 0) / 3600_000) }} 小时公示期，期间管理员可以更正。
          </p>
        </template>
        <template v-else>
          <p>{{ pendingLabel }}</p>
          <div class="row">
            <button class="primary grow" :disabled="busy" @click="confirmAction">确认</button>
            <button class="grow" @click="pending = null">取消</button>
          </div>
        </template>
      </div>

      <div v-if="isAdmin && unsettled" class="card stack">
        <h3>交易控制</h3>
        <button class="full" :disabled="busy" @click="togglePause">
          {{ market.paused ? '恢复本市场下注' : '暂停本市场下注' }}
        </button>
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
  margin: 10px 0 14px;
}
.badge.kind {
  background: var(--accent-soft);
  color: var(--accent);
}
.opt-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}
.opt {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  text-align: center;
}
.opt.won {
  border-color: var(--yes);
  background: var(--yes-soft);
}
.opt.lost {
  opacity: 0.55;
}
.opt-label {
  font-weight: 600;
}
.opt-odds {
  font-size: 26px;
  font-weight: 700;
  color: var(--accent);
  margin: 4px 0;
}
.stats {
  margin-top: 12px;
  gap: 6px;
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
.pick {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 8px;
}
.pick-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 6px;
  font-weight: 600;
}
.pick-btn .num {
  color: var(--accent);
}
.pick-btn.sel {
  background: var(--accent-soft);
  border-color: var(--accent);
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
.odds-row {
  margin-top: 6px;
}
.odds-input {
  width: 90px;
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
