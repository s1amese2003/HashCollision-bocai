import { reactive } from 'vue';
import { api, type Me, type SiteConfig } from './api';

export const store = reactive({
  me: null as Me | null,
  config: null as SiteConfig | null,
  loaded: false,
  tradingHalted: false,
  toast: '' as string,
  toastKind: 'info' as 'info' | 'error',
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  store.toast = msg;
  store.toastKind = kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (store.toast = ''), 3000);
}

export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), 'error');
}

export async function refreshMe() {
  const r = await api.me();
  store.me = r.user;
  store.config = r.config;
  store.tradingHalted = r.tradingHalted;
  store.loaded = true;
}

// --- live updates -------------------------------------------------------------

export type LiveEvent =
  | { type: 'market'; marketId: number; priceYes: number | null; status: string; volume: number }
  | { type: 'halt'; halted: boolean }
  | { type: 'trade'; marketId: number; username: string; outcome: string; side: string; amount: number; priceAfter: number }
  | { type: 'bet'; marketId: number; username: string; label: string; stake: number; odds: number };

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();

export function onLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let retry = 1000;
export function connectLive() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => (retry = 1000);
  ws.onmessage = (msg) => {
    try {
      const e = JSON.parse(msg.data) as LiveEvent;
      if (e.type === 'halt') store.tradingHalted = e.halted;
      for (const fn of listeners) fn(e);
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = () => {
    setTimeout(connectLive, retry);
    retry = Math.min(retry * 2, 30_000);
  };
}
