<script setup lang="ts">
defineProps<{ p: number }>();
</script>

<template>
  <div class="bar" role="img" :aria-label="`是 ${Math.round(p * 100)}%`">
    <div class="fill" :style="{ width: `${p * 100}%` }" />
  </div>
</template>

<style scoped>
.bar {
  height: 6px;
  border-radius: 999px;
  background: var(--no-soft);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--yes);
  border-radius: 999px;
  transition: width 0.4s ease;
}
</style>
