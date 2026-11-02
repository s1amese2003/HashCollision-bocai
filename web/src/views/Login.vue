<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, pts } from '../api';
import { store, toast, toastError } from '../store';

const router = useRouter();
const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const busy = ref(false);

async function submit() {
  busy.value = true;
  try {
    const fn = mode.value === 'login' ? api.login : api.register;
    const r = await fn(username.value.trim(), password.value);
    store.me = r.user;
    if (mode.value === 'register') toast(`注册成功，送你 ${pts(store.config?.signupBonus ?? 0)} 积分`);
    router.push('/');
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card auth">
    <div class="tabs">
      <button :class="{ active: mode === 'login' }" @click="mode = 'login'">登录</button>
      <button :class="{ active: mode === 'register' }" @click="mode = 'register'">注册</button>
    </div>
    <form class="stack" @submit.prevent="submit">
      <div>
        <label for="u">用户名</label>
        <input id="u" v-model="username" autocomplete="username" required />
        <div v-if="mode === 'register'" class="hint">2-20 位字母、数字、下划线或汉字</div>
      </div>
      <div>
        <label for="p">密码</label>
        <input
          id="p"
          v-model="password"
          type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          minlength="6"
          required
        />
      </div>
      <button class="primary full" :disabled="busy">{{ mode === 'login' ? '登录' : '注册并领取积分' }}</button>
    </form>
  </div>
</template>

<style scoped>
.auth {
  max-width: 380px;
  margin: 40px auto;
}
form {
  margin-top: 18px;
}
.full {
  width: 100%;
  padding: 10px;
}
</style>
