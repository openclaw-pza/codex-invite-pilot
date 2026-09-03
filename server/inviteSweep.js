// inviteSweep.js — 把「领了号却迟迟不点『我已发出邀请』」的号收回来。
//
// 为什么必须有：领号是幂等且长期占用的 —— 买家验完卡、拿到邮箱，然后关掉页面
// 去干别的，那个号就永久挂在他名下，别人再也领不到。号是买来的、用一个少一个。
//
// 🔴 但**光看时间就收回是危险的**：
// 买家很可能已经把邀请发出去了，只是还没回来点按钮。这时收回 = 号被派给下一个人，
// 而第一个买家的邀请名额已经花在这个地址上了 —— 两边都赔。
//
// 所以判据落在**证据**上而不是计时器上：到点之后先去读那个信箱。
//   · 邀请信已经在里面 → 买家确实发了，直接**替他确认**，推进队列（比收回好得多）
//   · 信箱是空的       → 他没发，收回池子
//   · 信箱读不出来     → **什么都不做**。读不到不等于没发，宁可多占一会儿

import { confirmInvite, listByStatus, releaseAccount, updateRefreshToken } from './accountPool.js';
import { fetchMessagesWithToken } from './outlookToken.js';
import { normalizeGraphMail } from './outlookMail.js';
import { findInvitationMail } from './automationMatch.js';

// 老卡（expires_at 为 NULL）没有到期时间，用这个兜底年龄判断。
// 正常卡一律走卡自己的有效期，买家只需要理解「1 小时」这一个数字。
export const ASSIGN_TTL_MS = Number(process.env.INVITE_ASSIGN_TTL_MS) || 60 * 60 * 1000;

/**
 * 这个号该不该动？判据是**它挂的那张卡过期了没有**，不是另起一个计时器。
 *
 * 为什么绑卡而不是绑领号时间：买家只该记住一个数字（卡 1 小时有效）。
 * 两套计时器并存的话，必然出现"卡还有效但号被收走了"——那是我们自己造的纠纷。
 *
 * 返回 'expired' / 'alive' / 'unknown'。**unknown 一律不动**：
 * 查不到卡不等于卡失效了，宁可多占一会儿也别把号从买家手里抢走。
 */
export function expiryVerdict({ row, card, now = Date.now(), fallbackTtlMs = ASSIGN_TTL_MS }) {
  if (!row || row.status !== 'assigned') return 'unknown';
  // 🔴 必须先挡掉 null/空串再 Number()：Number(null) 是 **0** 不是 NaN，
  // 于是 expires_at 为 NULL 的老卡（本意是永不过期）会被判成"早就过期"，
  // 一扫就把所有老卡的号全部收回。测试钉着这条。
  const exp = card == null || card.expires_at == null || card.expires_at === ''
    ? NaN
    : Number(card.expires_at);
  if (Number.isFinite(exp)) {
    return now > exp ? 'expired' : 'alive';
  }
  // 卡查不到，或是没有到期时间的老卡 —— 退回按领号时间兜底
  const at = Date.parse(row.assigned_at || '');
  if (!Number.isFinite(at)) return 'unknown';   // 时间戳也读不出来：什么都不做
  return now - at > fallbackTtlMs ? 'expired' : 'alive';
}

/**
 * 拿到「信箱里有没有邀请信」之后该怎么办。
 * hasInvite 为 null / undefined = 读不出来 → keep（读不到 ≠ 没发）。
 */
export function sweepDecision(hasInvite) {
  if (hasInvite === true) return 'confirm';
  if (hasInvite === false) return 'release';
  return 'keep';
}

/** 读这个号的信箱，看有没有邀请信。读不出来返回 null，**不要**当成 false。 */
export async function mailboxHasInvite(row) {
  if (!row?.refresh_token) return null;   // 网页号没有令牌，这里读不了 → 不做判断
  const result = await fetchMessagesWithToken({
    refreshToken: row.refresh_token,
    clientId: row.client_id,
  });
  if (!result.ok) return null;
  // 读信这一趟微软可能顺手轮换了 refresh_token。存回去，否则库里那份
  // 会越来越旧，最后在真要用的时候失效。CAS：只有库里还是我这次拿去换的
  // 那个值才写，免得把别的流程推进过的链掰回上一环。
  if (result.refreshToken && result.refreshToken !== row.refresh_token) {
    try { updateRefreshToken(row.address, result.refreshToken, { expect: row.refresh_token }); }
    catch (error) { console.warn(`[sweep] ${row.address} 存新令牌失败：${error?.message || error}`); }
  }
  const mails = (result.messages || []).map(normalizeGraphMail);
  return Boolean(findInvitationMail(mails, []));
}

/**
 * 扫一遍 assigned，该确认的确认、该收回的收回。
 * 每次只处理 limit 个，别让一次 claim 请求卡在几十个信箱读取上。
 */
export async function sweepAssigned({
  resolveCard = null, voidCard = null, maxAgeMs = ASSIGN_TTL_MS, limit = 5, now = Date.now(),
} = {}) {
  const stale = listByStatus('assigned', 50).filter((row) => {
    const card = resolveCard ? resolveCard(row.assigned_ref) : null;
    return expiryVerdict({ row, card, now, fallbackTtlMs: maxAgeMs }) === 'expired';
  });
  const out = { checked: 0, confirmed: 0, released: 0, kept: 0 };
  for (const row of stale.slice(0, limit)) {
    out.checked += 1;
    let decision = 'keep';
    try {
      decision = sweepDecision(await mailboxHasInvite(row));
    } catch (error) {
      console.warn(`[sweep] ${row.address} 读信箱出错，保持不动：${error?.message || error}`);
    }
    try {
      if (decision === 'confirm') {
        confirmInvite(row.address);
        out.confirmed += 1;
        console.log(`[sweep] ${row.address} 信箱里已有邀请信 —— 替买家确认，推进队列`);
      } else if (decision === 'release') {
        releaseAccount(row.address);
        out.released += 1;
        // 🔴 卡必须一并注销。不注销的话这张卡再拿去领会领到**另一个**号，
        // 而买家的邀请可能已经花在前一个地址上了 —— 一个 outlook 只能被邀请一次，
        // 于是一张卡吃掉两个不可再生的名额。买家还需要就找客服，客服那边能补发。
        // （2026-09-02 安哥确认：这条不能改成"只退号不注销卡"。）
        if (voidCard && row.assigned_ref) {
          try { voidCard(row.assigned_ref, '卡已过期，号已退回池子'); }
          catch (error) { console.warn(`[sweep] 注销卡 ${row.assigned_ref} 失败：${error?.message || error}`); }
        }
        // 注意措辞：号进的是**隔离区**不是可用池 —— 它可能在这一刻之后才收到
        // 买家迟发的邀请，直接再卖会把两个买家的钱货错配（见 releaseAccount 的注释）。
        console.log(`[sweep] ${row.address} 卡已过期且信箱里没有邀请信 —— 转入隔离区待复检（pool.mjs cooling），卡同时注销`);
      } else {
        out.kept += 1;
      }
    } catch (error) {
      // 状态在这几毫秒里被别人改了（买家正好点了按钮）—— 让对方赢，不覆盖
      console.warn(`[sweep] ${row.address} 处置失败（多半是状态刚被改），跳过：${error?.message || error}`);
      out.kept += 1;
    }
  }
  return out;
}
