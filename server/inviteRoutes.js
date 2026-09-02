// inviteRoutes.js — Codex 邀请助手的网页接口（全自动版）。
//
// 买家侧只有三个动作：验卡 → 拿到专属邮箱 → 用自己的 Codex 发出邀请后点「我已发出邀请」。
// 之后建号、收信、过验证码、接码、登录桌面端、发消息全在 VPS 上自动完成。
//
// 这里**不直接起跑**。起跑交给 scripts/invite-worker.mjs 那个单进程队列：
// 桌面端的 CDP 端口和 ~/.codex 凭据是**独占资源**，两轮并行会互相清凭据、抢端口，
// 结果是两轮一起死、两个不可再生的邀请名额一起烧。HTTP handler 里 spawn 挡不住并发，
// 单进程消费队列天然串行 —— 顺带把「排队中」这个状态也白送了。
//
// 卡与号的绑定用 assigned_ref = 卡密，DB 上有唯一索引兜底：
// 一张卡永远只可能挂一个活号，应用层再出并发 bug 也超发不了。

import {
  claimAccount, confirmInvite, getAccount, getAnyByRef, getByRef, nextReady, queueAheadOf, requeueRun,
  markFinished, markRunning, poolStats, reclaimStaleRunning,
} from './accountPool.js';
import { secretEquals } from './cards.js';
import { sweepAssigned } from './inviteSweep.js';

// 买家能看到的状态文案。左边是号池里的真实状态，右边是给人看的话。
//
// 这里刻意**不把技术原因透出去**：失败原因（OAuth 超时、接码没到、账号被停）
// 对买家没有任何可操作性，只会变成"你们系统有问题"的争执。
// 安哥的要求就是一句话：失败就显示"邀请失败，请联系客服"。
const VIEW = {
  assigned: {
    phase: 'need_invite',
    text: '把上面的邮箱填进你自己的 Codex 邀请页并发送，发完点下面的按钮',
    done: false,
  },
  ready: {
    phase: 'queued',
    text: '已排队，正在等待空闲通道…',
    done: false,
  },
  running: {
    phase: 'running',
    text: '正在自动完成注册与激活，请保持页面打开（通常 3～5 分钟）',
    done: false,
  },
  done: {
    phase: 'done',
    text: '邀请已完成 —— 回你自己的 Codex 看额度',
    done: true,
  },
  failed: {
    phase: 'failed',
    text: '邀请失败，请联系客服',
    done: true,
  },
};

// 排队时把**真实排位**说出来，而不是一句含糊的「正在等待空闲通道」。
//
// 2026-09-02 出过一次：一轮卡了 40 分钟，买家在页面上只看到"正在等待"，
// 以为系统死了，又下了一单 —— 于是两张卡吃掉两个不可再生的邀请名额。
// 队列本来就是串行的，缺的从来不是限流，是**让买家知道自己排第几**。
//
// 每人 3～5 分钟是实测区间（近期成功轮次 150～230 秒，取整并留出取任务的间隔）。
function queueText(ahead) {
  if (!Number.isFinite(ahead)) return VIEW.ready.text;
  if (ahead <= 0) return '已排队，马上就轮到你了，请保持页面打开。';
  return `前面还有 ${ahead} 个人在排队，预计等待 ${ahead * 3}～${ahead * 5} 分钟。请保持页面打开，不用重复提交。`;
}

// available 是"还没派给任何人"的号，正常不会出现在按卡反查的结果里；
// 真出现了当成异常处理，别把一个没绑定的号显示给买家。
//
// ahead 只对 ready 有意义，缺省 null —— 不传就退回原来那句通用文案，
// 老调用点（含测试）不用改。
export function viewOf(row, ahead = null) {
  if (!row) return { phase: 'none', text: '', done: false };
  const view = VIEW[row.status];
  if (!view) return { phase: 'failed', text: '邀请失败，请联系客服', done: true };
  if (row.status === 'ready') return { ...view, text: queueText(ahead), ahead: Number.isFinite(ahead) ? ahead : null };
  return { ...view };
}

// 邀请卡的标记。写进 cards.locked_service。
export const INVITE_CARD = 'codex-invite';

// 这张卡能不能用来领邀请号？
//
// 只认标记，不做任何兜底。没有这道闸时，一张 ¥1.9 的接码卡能直接领走一个邀请号
// —— 而邀请号是不可再生的成本。
//
// 曾经想过"没标记的按面额兜底"，因为线上有 17 张买家已付款的 ¥3.99 老卡。
// 2026-08-27 安哥确认那批不要了、已全部注销，兜底随之删除 ——
// 留着它就等于给任何 ≥3 元的卡开后门（当时线上就还有一张 ¥5 的）。
export function cardMayInvite(card) {
  return String(card?.locked_service || '') === INVITE_CARD;
}

export function createInviteRoutes({
  requireSession, VendError, workerSecret = '', resolveCard = null, voidCard = null,
} = {}) {
  const sweep = () => sweepAssigned({ resolveCard, voidCard })
    .catch((error) => console.warn(`[invite] 扫描 assigned 失败：${error?.message || error}`));

  function requireInviteCard(card) {
    if (!cardMayInvite(card)) {
      throw new VendError('这张卡不是「Codex 一键邀请」的卡，不能在这里用', 409, 'wrong_card_kind');
    }
  }

  // 领号绝不能提前：微软号第一次登录会被强制绑一个恢复邮箱，而我们用的是
  // 临时邮箱（约 10 分钟失效）。邀请还没发就先登录，等于白赔一个号。
  // 所以 claim 只在 DB 里做一次指派，**一个字节都不碰账号本身**。
  function claim(token) {
    const { card } = requireSession(token, { allowUsed: true });
    requireInviteCard(card);
    const ref = String(card.code);
    const existing = getByRef(ref);
    // 幂等：买家刷新页面、重复点，都只会拿回同一个号
    if (existing) return { address: existing.address, ...viewOf(existing, queueAheadOf(existing)) };

    let account;
    try {
      account = claimAccount(ref);
    } catch (error) {
      const stats = poolStats();
      console.error(`[invite] 领号失败 card=${ref} 池况=${JSON.stringify(stats)}：${error?.message || error}`);
      throw new VendError('暂时没有可用名额了，请联系客服', 409, 'pool_empty');
    }
    const row = getByRef(ref);
    return { address: account.address, ...viewOf(row, queueAheadOf(row)) };
  }

  const routes = [
    {
      method: 'POST',
      path: '/api/invite/claim',
      handler: async ({ body }) => {
        // 领号之前先把僵着的号腾出来 —— 这是最该扫的时刻：正好有人要号。
        // 扫描本身失败不能挡住领号（买家已经付过钱了）。
        await sweep();
        return claim(body?.token);
      },
    },

    {
      method: 'POST',
      path: '/api/invite/sent',
      // 买家点「我已发出邀请」。这一下才把号推进队列 ——
      // 在此之前脚本一次也不会登录这个邮箱。
      handler: async ({ body }) => {
        const { card } = requireSession(body?.token, { allowUsed: true });
        requireInviteCard(card);
        const row = getByRef(String(card.code));
        if (!row) throw new VendError('还没领取邮箱，请先点上面的领取按钮', 400, 'not_claimed');
        // 已经在跑或已跑完的，重复点不做任何事，直接回当前状态
        if (row.status === 'assigned') confirmInvite(row.address);
        const after = getByRef(String(card.code));
        return { address: after.address, ...viewOf(after, queueAheadOf(after)) };
      },
    },

    {
      method: 'GET',
      path: '/api/invite/status',
      handler: async ({ query }) => {
        const { card } = requireSession(query?.token, { allowUsed: true });
        const row = getByRef(String(card.code));
        if (!row) {
          // 号被标 dead 了（令牌失效/被封，运维的日常动作）。这时**不能**回空壳：
          // 前端按 address 判「领取」按钮的显隐，而它缓存着上次拿到的 address，
          // 于是按钮不出现；phase='none' 又让结论区和转圈区一起隐藏；done=false
          // 让轮询永不停。买家页面上从此一个字都没有，每 4 秒空转一次。
          // 给他一个明确终态，让他知道该找客服 —— 后端其实允许他重新领一个号。
          const dead = getAnyByRef(String(card.code));
          if (dead) return { address: '', phase: 'failed', text: '邀请失败，请联系客服', done: true };
          return { address: '', phase: 'none', text: '', done: false };
        }
        return { address: row.address, ...viewOf(row, queueAheadOf(row)) };
      },
    },
  ];

  // ---------- worker 侧 ----------
  //
  // 桌面端跑在另一台机器上（网站 DMIT-1 / worker DMIT-2），而号池是本地 SQLite，
  // 两边 import 同一个文件只会各自建一个空库。所以方向定成**worker 反向来拉**：
  // 网站持有队列，worker 当 HTTPS 客户端来取任务、回报结果。
  // 这样 worker 不用开任何入站端口，也不用为它改防火墙。
  function requireWorker(secret) {
    if (!workerSecret) throw new VendError('接口未启用', 404, 'disabled');
    if (!secretEquals(String(secret || ''), workerSecret)) throw new VendError('无权访问', 403, 'forbidden');
  }

  routes.push({
    method: 'POST',
    path: '/api/invite/worker/next',
    handler: async ({ body }) => {
      requireWorker(body?.secret);
      // worker 每 5 秒来一次，顺手也扫一遍 assigned —— 就算没人来领号，
      // 僵着的号也能自己回到池子里。
      await sweep();
      // 取任务前先清一次陈旧的 running（worker 中途挂掉留下的），
      // 否则那个号会永久卡住 —— markFinished 只认 running→终态，reset 又拒绝 running。
      reclaimStaleRunning();
      // 队头按**买家确认发出邀请**的先后取，和 queueAheadOf 共用同一个判据 ——
      // 两边不一致的话，页面上显示的排位就是假的（见 accountPool.QUEUE_ORDER 的注释）。
      const next = nextReady();
      if (!next) return { job: null };
      // 先置 running 再交出去：交出去之后才置的话，两次拉取之间会把同一个号发给两个 worker。
      markRunning(next.address);
      // 带上 refresh_token：有它就能跳过设备码授权（省约 150 秒，
      // 而且不用再走"强制绑临时恢复邮箱"那一步）。没有就是老的网页号，照旧走授权。
      return {
        job: {
          address: next.address,
          password: next.password,
          refreshToken: next.refresh_token || '',
          clientId: next.client_id || '',
        },
      };
    },
  });

  routes.push({
    method: 'POST',
    path: '/api/invite/worker/report',
    handler: async ({ body }) => {
      requireWorker(body?.secret);
      const address = String(body?.address || '').trim().toLowerCase();
      const before = getAccount(address);
      if (!before) throw new VendError('没有这个号', 404, 'no_account');

      // 🔴 「worker 压根没开跑」的失败不能写 failed —— failed 在买家侧是终态死路
      // （卡不退、号不回队列、买家侧三条路由一条都救不了，只能运维手工 reset）。
      // 本机锁被占、spawn 失败、静默看门狗回收都属于这一类：买家已经付过钱、
      // 邀请名额已经发到那个地址上了，凭一次调度打嗝把他判死是这套系统里最贵的错。
      // 放回队列他还站在原位（invite_confirmed_at 没动），下一轮就轮到他。
      if (!body?.ok && body?.requeue) {
        // 🔴 这条分支自己也要幂等。worker 回报会重试 5 次，而「第一次已落库、
        // 响应在网络上丢了」按提交信息自己的说法是常态 —— 第 2 次进来时号已经是
        // ready，requeueRun 只认 running 会返回 false，于是掉进下面的 markFinished
        // 当场 500，日志刷 5 条假告警。那**正是**下面那段注释说要消灭的现象，
        // 而新加的分支没享受到这个修复。（2026-09-02 审计实测：第 2、3 次都是 500。）
        if (before.status === 'ready') return { ok: true, status: 'ready', requeued: true, idempotent: true };
        if (requeueRun(address, { note: String(body?.note || '') })) {
          return { ok: true, status: 'ready', requeued: true };
        }
        // 没能放回去（重试预算用尽，或已被陈旧清扫捡走）就照常走终态，别静默吞掉
      }

      // 幂等：worker 回报会重试 5 次，而「第一次已落库、响应在网络上丢了」是常态。
      // 不认幂等的话第 2 次起必然 500，日志刷 5 条假告警，运维会以为号卡在
      // running 跑去手工 reset —— 而它其实早就是终态了。
      const want = body?.ok ? 'done' : 'failed';
      if (before.status === want) return { ok: true, status: want, idempotent: true };

      markFinished(address, {
        ok: Boolean(body?.ok),
        result: String(body?.result || ''),
        note: String(body?.note || ''),
      });
      return { ok: true, status: getAccount(address).status };
    },
  });

  return routes;
}
