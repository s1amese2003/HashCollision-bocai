import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import {
  type User,
  createSession,
  deleteSession,
  login,
  purgeExpiredSessions,
  register,
  syncAdmins,
  userFromSession,
} from './auth.js';
import type { Config } from './config.js';
import { type DB, isTradingHalted, setSetting } from './db.js';
import { AppError, forbidden, unauthorized } from './errors.js';
import { Hub } from './hub.js';
import { reconcile } from './ledger.js';
import { SCALE } from './market/lmsr.js';
import {
  type BoundedQuote,
  addLiquidity,
  adminResolve,
  cancelMarket,
  closeExpired,
  createMarket,
  executeTrade,
  finalizeProposals,
  getMarket,
  leaderboard,
  listMarkets,
  portfolio,
  priceHistory,
  proposeResolution,
  quoteLiquidity,
  quoteTrade,
  recentTrades,
  setMarketPaused,
  userPositions,
} from './markets.js';
import {
  MAX_ODDS,
  MAX_OPTIONS,
  MIN_ODDS,
  MIN_OPTIONS,
  MIN_STAKE,
  addDeposit,
  createOddsMarket,
  openBets,
  placeBet,
  recentBets,
  updateOdds,
  userBets,
} from './odds.js';

const SESSION_COOKIE = 'sid';

export interface AppDeps {
  cfg: Config;
  db: DB;
  /** Injectable clock (ms since epoch) so tests can move time. */
  now?: () => number;
  /** Disable rate limiting (tests). */
  rateLimit?: boolean;
}

export interface App {
  fastify: FastifyInstance;
  hub: Hub;
  /** Periodic housekeeping: close expired markets, finalize proposals, purge sessions. */
  tick: () => void;
}

const username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_一-龥]{2,20}$/, '用户名需为 2-20 位字母、数字、下划线或汉字')
  .refine((s) => !s.startsWith('__'), '用户名不能以两个下划线开头');
const password = z.string().min(6, '密码至少 6 位').max(100);
const outcome = z.enum(['YES', 'NO']);
const unitsInt = z.number().int().positive().max(1e12);
const idParam = z.object({ id: z.coerce.number().int().positive() });

const credentials = z.object({ username, password });
const marketBase = {
  title: z.string().trim().min(5, '标题至少 5 个字').max(120),
  description: z.string().trim().max(2000).default(''),
  rules: z.string().trim().min(5, '请写清判定规则').max(2000),
  sourceUrl: z.union([z.url().max(500), z.literal('')]).optional(),
  closeAt: z.number().int().positive(),
};
const createMarketBody = z.object({ ...marketBase, kind: z.literal('LMSR').optional(), subsidy: unitsInt });
/** Decimal odds x 100, e.g. 185 = 1.85. */
const oddsInt = z.number().int('赔率最多两位小数');
const createOddsMarketBody = z.object({
  ...marketBase,
  kind: z.literal('ODDS'),
  deposit: unitsInt,
  options: z
    .array(z.object({ label: z.string().trim().min(1, '选项名称不能为空').max(30, '选项名称最多 30 个字'), odds: oddsInt }))
    .min(MIN_OPTIONS, `至少 ${MIN_OPTIONS} 个选项`)
    .max(MAX_OPTIONS, `最多 ${MAX_OPTIONS} 个选项`),
});
const betBody = z.object({ optionId: z.number().int().positive(), stake: unitsInt, odds: oddsInt });
const oddsBody = z.object({
  odds: z.array(z.object({ optionId: z.number().int().positive(), odds: oddsInt })).min(1).max(MAX_OPTIONS),
});
const depositBody = z.object({ amount: unitsInt });
const tradeBody = z.object({
  outcome,
  side: z.enum(['BUY', 'SELL']),
  amount: unitsInt.optional(),
  shares: unitsInt.optional(),
  minShares: z.number().int().nonnegative().optional(),
  minAmount: z.number().int().nonnegative().optional(),
});
/** `outcome` for YES/NO markets, `optionId` for fixed-odds markets. */
const resolveBody = z.object({
  outcome: outcome.optional(),
  optionId: z.number().int().positive().optional(),
  note: z.string().trim().max(1000).default(''),
});
const cancelBody = z.object({ note: z.string().trim().max(1000).default('') });
const pauseBody = z.object({ paused: z.boolean() });
const haltBody = z.object({ halted: z.boolean() });
const liquidityBody = z.object({ amount: unitsInt, maxDeposit: z.number().int().nonnegative().optional() });
const listQuery = z.object({ filter: z.enum(['active', 'closed', 'settled', 'all']).default('active') });

function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    balance: u.balance,
  };
}

function quoteView(q: BoundedQuote) {
  return {
    outcome: q.outcome,
    side: q.side,
    shares: q.shares,
    amount: q.amount,
    priceYesBefore: q.priceYesBefore,
    priceYesAfter: q.priceYesAfter,
    avgPrice: q.avgPrice,
    capped: q.capped,
    cappedBy: q.cappedBy,
  };
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const { cfg, db } = deps;
  const now = deps.now ?? Date.now;
  const hub = new Hub();
  syncAdmins(db, cfg);

  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(cookie);
  await app.register(websocket);
  await app.register(rateLimit, { global: false });

  const strictLimit =
    deps.rateLimit === false ? {} : { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const tradeLimit =
    deps.rateLimit === false ? {} : { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      const message = err.issues[0]?.message ?? '参数错误';
      return reply.status(400).send({ error: { code: 'VALIDATION', message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: 'REQUEST', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器错误' } });
  });

  const currentUser = (req: FastifyRequest): User | undefined =>
    userFromSession(db, req.cookies[SESSION_COOKIE], now());
  const requireUser = (req: FastifyRequest): User => {
    const u = currentUser(req);
    if (!u) throw unauthorized();
    return u;
  };
  const requireAdmin = (req: FastifyRequest): User => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    return u;
  };
  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.cookieSecure,
      maxAge: Math.floor(cfg.sessionTtlMs / 1000),
    });

  const emitMarket = (id: number) => {
    const m = getMarket(db, cfg, id, now());
    hub.broadcast({ type: 'market', marketId: id, priceYes: m.priceYes, status: m.status, volume: m.volume });
  };

  // --- auth -----------------------------------------------------------------

  app.post('/api/register', strictLimit, async (req, reply) => {
    const body = credentials.parse(req.body);
    const t = now();
    const user = await register(db, cfg, body.username, body.password, t);
    setSession(reply, createSession(db, cfg, user.id, t));
    return { user: publicUser(user) };
  });

  app.post('/api/login', strictLimit, async (req, reply) => {
    const body = credentials.parse(req.body);
    const t = now();
    const user = await login(db, body.username, body.password);
    setSession(reply, createSession(db, cfg, user.id, t));
    return { user: publicUser(user) };
  });

  app.post('/api/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const u = currentUser(req);
    return {
      user: u ? publicUser(u) : null,
      config: {
        scale: SCALE,
        signupBonus: cfg.signupBonus,
        minSubsidy: cfg.minSubsidy,
        maxSubsidy: cfg.maxSubsidy,
        houseSubsidy: cfg.houseSubsidy,
        positionCapB: cfg.positionCapB,
        minDeposit: cfg.minDeposit,
        minStake: MIN_STAKE,
        minOdds: MIN_ODDS,
        maxOdds: MAX_ODDS,
        maxOptions: MAX_OPTIONS,
        disputeWindowMs: cfg.disputeWindowMs,
      },
      tradingHalted: isTradingHalted(db),
    };
  });


  // --- markets --------------------------------------------------------------

  app.get('/api/markets', async (req) => {
    const { filter } = listQuery.parse(req.query);
    return { markets: listMarkets(db, cfg, filter, now()) };
  });

  app.post('/api/markets', tradeLimit, async (req) => {
    const u = requireUser(req);
    let id: number;
    if ((req.body as { kind?: unknown } | null)?.kind === 'ODDS') {
      const body = createOddsMarketBody.parse(req.body);
      id = createOddsMarket(db, cfg, u, { ...body, sourceUrl: body.sourceUrl || null }, now());
    } else {
      const body = createMarketBody.parse(req.body);
      id = createMarket(db, cfg, u, { ...body, sourceUrl: body.sourceUrl || null }, now());
    }
    emitMarket(id);
    return { id };
  });

  app.get('/api/markets/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const t = now();
    const u = currentUser(req);
    const market = getMarket(db, cfg, id, t);
    if (market.kind === 'ODDS') {
      return { market, bets: recentBets(db, id), myBets: u ? userBets(db, u.id, id) : null };
    }
    return {
      market,
      trades: recentTrades(db, id),
      positions: u ? userPositions(db, u.id, id) : null,
    };
  });

  app.get('/api/markets/:id/history', async (req) => {
    const { id } = idParam.parse(req.params);
    return { points: priceHistory(db, id) };
  });

  app.post('/api/markets/:id/quote', tradeLimit, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = tradeBody.parse(req.body);
    return { quote: quoteView(quoteTrade(db, cfg, id, body, now(), currentUser(req)?.id)) };
  });

  app.post('/api/markets/:id/trade', tradeLimit, async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = tradeBody.parse(req.body);
    const r = executeTrade(db, cfg, u.id, id, body, now());
    emitMarket(id);
    hub.broadcast({
      type: 'trade',
      marketId: id,
      username: u.username,
      outcome: r.quote.outcome,
      side: r.quote.side,
      amount: r.quote.amount,
      priceAfter: r.quote.priceYesAfter,
    });
    return { tradeId: r.tradeId, quote: quoteView(r.quote), balance: r.balance };
  });

  // --- fixed-odds markets -------------------------------------------------------

  app.post('/api/markets/:id/bet', tradeLimit, async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = betBody.parse(req.body);
    const r = placeBet(db, u, id, body, now());
    emitMarket(id);
    hub.broadcast({ type: 'bet', marketId: id, username: u.username, label: r.label, stake: r.stake, odds: r.odds });
    return { bet: r, balance: r.balance };
  });

  app.post('/api/markets/:id/odds', async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = oddsBody.parse(req.body);
    updateOdds(db, u, id, body.odds, now());
    emitMarket(id);
    return { market: getMarket(db, cfg, id, now()) };
  });

  app.post('/api/markets/:id/deposit', async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = depositBody.parse(req.body);
    addDeposit(db, u, id, body.amount, now());
    emitMarket(id);
    return { market: getMarket(db, cfg, id, now()) };
  });

  app.post('/api/markets/:id/propose', async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = resolveBody.parse(req.body);
    proposeResolution(db, u, id, { outcome: body.outcome, optionId: body.optionId }, body.note, now());
    emitMarket(id);
    return { market: getMarket(db, cfg, id, now()) };
  });

  app.post('/api/markets/:id/resolve', async (req) => {
    const u = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const body = resolveBody.parse(req.body);
    adminResolve(db, u, id, { outcome: body.outcome, optionId: body.optionId }, body.note, now());
    emitMarket(id);
    return { market: getMarket(db, cfg, id, now()) };
  });

  app.post('/api/markets/:id/cancel', async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = cancelBody.parse(req.body);
    cancelMarket(db, u, id, body.note, now());
    emitMarket(id);
    return { market: getMarket(db, cfg, id, now()) };
  });

  // --- admin controls ---------------------------------------------------------

  app.post('/api/markets/:id/pause', async (req) => {
    const u = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const { paused } = pauseBody.parse(req.body);
    setMarketPaused(db, u, id, paused);
    emitMarket(id);
    return { market: getMarket(db, cfg, id, now()) };
  });

  app.post('/api/admin/halt', async (req) => {
    requireAdmin(req);
    const { halted } = haltBody.parse(req.body);
    setSetting(db, 'trading_halted', halted ? '1' : '0');
    hub.broadcast({ type: 'halt', halted });
    return { tradingHalted: halted };
  });

  app.post('/api/markets/:id/liquidity/quote', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const body = liquidityBody.parse(req.body);
    return { quote: quoteLiquidity(db, id, body.amount, now()) };
  });

  app.post('/api/markets/:id/liquidity', async (req) => {
    const u = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const body = liquidityBody.parse(req.body);
    const quote = addLiquidity(db, u, id, body.amount, now(), body.maxDeposit);
    emitMarket(id);
    return { quote, market: getMarket(db, cfg, id, now()) };
  });

  // --- users ----------------------------------------------------------------

  app.get('/api/portfolio', async (req) => {
    const u = requireUser(req);
    const t = now();
    return { ...portfolio(db, u.id, t), bets: openBets(db, u.id, t) };
  });

  app.get('/api/leaderboard', async () => ({ leaderboard: leaderboard(db) }));

  app.get('/api/admin/reconcile', async (req) => {
    requireAdmin(req);
    return reconcile(db);
  });

  app.get('/api/health', async () => ({ ok: true, clients: hub.size }));

  app.get('/ws', { websocket: true }, (socket) => hub.add(socket));

  // --- frontend -------------------------------------------------------------

  if (cfg.webDir) {
    const root = resolve(cfg.webDir);
    if (!existsSync(root)) app.log.warn(`WEB_DIR ${root} does not exist`);
    await app.register(fastifyStatic, { root, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && req.url !== '/ws') {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '不存在' } });
    });
  }

  const tick = () => {
    const t = now();
    const closed = closeExpired(db, t);
    const finalized = finalizeProposals(db, cfg, t);
    purgeExpiredSessions(db, t);
    for (const id of new Set([...closed, ...finalized])) emitMarket(id);
  };

  return { fastify: app, hub, tick };
}
