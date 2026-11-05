import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { connectLive, refreshMe } from './store';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/Markets.vue') },
    { path: '/m/:id(\\d+)', component: () => import('./views/MarketPage.vue'), props: (r) => ({ id: Number(r.params.id) }) },
    { path: '/new', component: () => import('./views/NewMarket.vue') },
    { path: '/portfolio', component: () => import('./views/Portfolio.vue') },
    { path: '/leaderboard', component: () => import('./views/Leaderboard.vue') },
    { path: '/login', component: () => import('./views/Login.vue') },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

refreshMe().catch(() => {});
connectLive();
createApp(App).use(router).mount('#app');
