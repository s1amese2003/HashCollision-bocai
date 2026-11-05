<script setup lang="ts">
import { useRouter } from 'vue-router';
import { api, pts } from './api';
import { store, toast, toastError } from './store';

const router = useRouter();

async function toggleHalt() {
  try {
    const r = await api.halt(!store.tradingHalted);
    store.tradingHalted = r.tradingHalted;
    toast(r.tradingHalted ? '已暂停全站交易' : '已恢复全站交易');
  } catch (e) {
    toastError(e);
  }
}

async function logout() {
  await api.logout().catch(() => {});
  store.me = null;
  router.push('/');
}
</script>

<template>
  <header class="topbar">
    <div class="container row nav">
      <RouterLink to="/" class="brand">
        <img src="/favicon.svg" alt="" width="24" height="24" />
        <span>预测盘</span>
      </RouterLink>
      <nav class="links">
        <RouterLink to="/">市场</RouterLink>
        <RouterLink to="/leaderboard">排行榜</RouterLink>
        <RouterLink v-if="store.me" to="/portfolio">我的</RouterLink>
      </nav>
      <div class="spacer" />
      <template v-if="store.loaded">
        <template v-if="store.me">
          <RouterLink to="/portfolio" class="balance num" title="可用积分">
            {{ pts(store.me.balance) }} <span class="muted small">积分</span>
          </RouterLink>
          <RouterLink to="/new"><button class="primary">创建市场</button></RouterLink>
          <button class="ghost small hide-sm" @click="logout">退出</button>
        </template>
        <RouterLink v-else to="/login"><button class="primary">登录 / 注册</button></RouterLink>
      </template>
    </div>
  </header>

  <div v-if="store.tradingHalted" class="halt-banner">
    <div class="container row">
      <span>全站交易已暂停，可以浏览，但暂时不能买卖。</span>
      <div class="spacer" />
      <button v-if="store.me?.role === 'admin'" class="small" @click="toggleHalt">恢复交易</button>
    </div>
  </div>

  <main class="container main">
    <RouterView />
  </main>

  <footer class="container footer muted small">
    积分仅用于娱乐和练习预测能力，不可充值、提现或兑换。
    <a v-if="store.me" href="#" class="hide-lg" @click.prevent="logout">退出登录</a>
    <template v-if="store.me?.role === 'admin' && !store.tradingHalted">
      · <a href="#" class="admin-link" @click.prevent="toggleHalt">暂停全站交易</a>
    </template>
  </footer>

  <Transition name="fade">
    <div v-if="store.toast" class="toast" :class="store.toastKind">{{ store.toast }}</div>
  </Transition>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.nav {
  height: 60px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 17px;
}
.links {
  display: flex;
  gap: 4px;
  margin-left: 16px;
}
.links a {
  padding: 6px 10px;
  border-radius: 8px;
  color: var(--muted);
  font-weight: 500;
}
.links a.router-link-exact-active {
  color: var(--text);
  background: var(--surface-2);
}
.balance {
  font-weight: 600;
  padding: 6px 4px;
}
.main {
  padding-top: 24px;
  padding-bottom: 32px;
  min-height: calc(100vh - 140px);
}
.halt-banner {
  background: var(--warn-soft);
  color: var(--warn);
  font-weight: 500;
  padding: 10px 0;
}
.admin-link {
  color: var(--warn);
}
.footer {
  padding-bottom: 32px;
  text-align: center;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  background: var(--text);
  color: var(--bg);
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 14px;
  z-index: 50;
  max-width: calc(100vw - 32px);
}
.toast.error {
  background: var(--no);
  color: #fff;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.hide-lg {
  display: none;
}
@media (max-width: 640px) {
  .brand span {
    display: none;
  }
  .links {
    margin-left: 4px;
  }
  .links a {
    padding: 6px 7px;
  }
  .hide-sm {
    display: none;
  }
  .hide-lg {
    display: inline;
  }
  .nav {
    gap: 6px;
  }
}
</style>
