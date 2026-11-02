<script setup lang="ts">
import { computed, ref } from 'vue';
import { dateTime } from '../api';

const props = defineProps<{ points: { t: number; p: number }[]; end: number }>();

const W = 640;
const H = 220;
const PAD = { l: 8, r: 40, t: 12, b: 24 };
const hover = ref<number | null>(null);

const series = computed(() => {
  const pts = props.points.length ? props.points : [{ t: props.end, p: 0.5 }];
  const last = pts[pts.length - 1]!;
  // Extend the last price to "now" (or the close time) so the line reaches the right edge.
  return last.t < props.end ? [...pts, { t: props.end, p: last.p }] : pts;
});

const t0 = computed(() => series.value[0]!.t);
const t1 = computed(() => Math.max(series.value[series.value.length - 1]!.t, t0.value + 1));
const x = (t: number) => PAD.l + ((t - t0.value) / (t1.value - t0.value)) * (W - PAD.l - PAD.r);
const y = (p: number) => PAD.t + (1 - p) * (H - PAD.t - PAD.b);

/** Step line: price holds until the next trade. */
const path = computed(() => {
  const s = series.value;
  let d = `M${x(s[0]!.t)},${y(s[0]!.p)}`;
  for (let i = 1; i < s.length; i++) d += ` H${x(s[i]!.t)} V${y(s[i]!.p)}`;
  return d;
});
const area = computed(() => `${path.value} V${y(0)} H${x(t0.value)} Z`);

const hovered = computed(() => {
  if (hover.value === null) return null;
  const s = series.value;
  const t = t0.value + ((hover.value - PAD.l) / (W - PAD.l - PAD.r)) * (t1.value - t0.value);
  let pt = s[0]!;
  for (const q of s) if (q.t <= t) pt = q;
  return { t: Math.min(Math.max(t, t0.value), t1.value), p: pt.p };
});

function onMove(e: PointerEvent) {
  const svg = e.currentTarget as SVGSVGElement;
  const r = svg.getBoundingClientRect();
  const vx = ((e.clientX - r.left) / r.width) * W;
  hover.value = Math.min(Math.max(vx, PAD.l), W - PAD.r);
}
</script>

<template>
  <div class="chart">
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      @pointermove="onMove"
      @pointerleave="hover = null"
    >
      <g class="grid">
        <template v-for="g in [0, 0.25, 0.5, 0.75, 1]" :key="g">
          <line :x1="PAD.l" :x2="W - PAD.r" :y1="y(g)" :y2="y(g)" />
          <text :x="W - PAD.r + 6" :y="y(g) + 4">{{ g * 100 }}%</text>
        </template>
      </g>
      <path :d="area" class="area" />
      <path :d="path" class="line" />
      <template v-if="hovered">
        <line class="cursor" :x1="x(hovered.t)" :x2="x(hovered.t)" :y1="PAD.t" :y2="H - PAD.b" />
        <circle :cx="x(hovered.t)" :cy="y(hovered.p)" r="4" class="dot" />
      </template>
      <text class="axis" :x="PAD.l" :y="H - 6">{{ dateTime(t0) }}</text>
      <text class="axis" :x="W - PAD.r" :y="H - 6" text-anchor="end">{{ dateTime(t1) }}</text>
    </svg>
    <div v-if="hovered" class="tip small">
      <b class="num">{{ Math.round(hovered.p * 100) }}%</b> · {{ dateTime(hovered.t) }}
    </div>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
}
svg {
  width: 100%;
  height: auto;
  display: block;
  touch-action: pan-y;
}
.grid line {
  stroke: var(--border);
  stroke-dasharray: 3 4;
}
.grid text,
.axis {
  fill: var(--muted);
  font-size: 11px;
}
.line {
  fill: none;
  stroke: var(--yes);
  stroke-width: 2;
}
.area {
  fill: var(--yes);
  opacity: 0.08;
}
.cursor {
  stroke: var(--muted);
  stroke-width: 1;
}
.dot {
  fill: var(--yes);
  stroke: var(--surface);
  stroke-width: 2;
}
.tip {
  position: absolute;
  top: 0;
  left: 8px;
  background: var(--surface-2);
  padding: 2px 8px;
  border-radius: 6px;
}
</style>
