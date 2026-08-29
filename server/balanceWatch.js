// balanceWatch.js — 上游余额告警。
//
// 余额见底时的表现不是「报错」，而是取号**静默失败**：HeroSMS 回 NO_BALANCE，
// 我们翻译成「这个地区暂时取不了号，先换一个地区试试」（刻意不告诉买家是卖家没钱了）。
// 买家于是一个地区一个地区地换，全都失败，最后退款+差评 —— 而卖家这边一无所知。
// 所以这条告警不是锦上添花：它是这个静默失败模式唯一的可见出口。

import { getBalance } from './vend-hero.js';
import { sendMail, smtpConfigFromEnv } from './smtpMail.js';

const CHECK_MS = 30 * 60 * 1000;      // 半小时查一次，够用且不打扰上游
const RESEND_MS = 6 * 60 * 60 * 1000; // 同一次「见底」最多 6 小时提醒一次

// 状态只放内存：进程重启后最多多发一封提醒，
// 而「余额见底却没人知道」的代价远大于多收一封信。为这个上数据库不划算。
let lastAlertAt = 0;
let wasLow = false;

export function balanceThresholdUsd() {
  const raw = Number(process.env.VEND_BALANCE_ALERT_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export async function checkBalanceOnce({ now = Date.now(), notify = defaultNotify } = {}) {
  const threshold = balanceThresholdUsd();
  let balance;
  try {
    ({ balance } = await getBalance());
  } catch (error) {
    // 查不到余额本身不告警：上游抖一下就发信会变成狼来了，
    // 真没钱的话下一轮（半小时后）照样会查出来。
    console.warn(`[vend] 余额查询失败：${error?.message || '未知错误'}`);
    return { checked: false, reason: error?.message || '查询失败' };
  }
  // getBalance 对 BAD_KEY 这类错误**不抛异常**，而是返回 balance: null。
  // 照着 `low = balance < threshold` 写的话，null 会让 low 恒为 false ——
  // 密钥坏掉时我们永远不会告警、也永远不知道，正是这条告警要防的那类静默失败。
  // 所以拿不到数就明确算「没查成」，并留一行日志。
  if (!Number.isFinite(balance)) {
    console.warn('[vend] 余额查询返回了非数字（多为 API key 失效），本轮不告警');
    return { checked: false, reason: 'non_numeric_balance' };
  }
  const low = balance < threshold;

  // 回到阈值以上就重置，这样「充值后再次见底」能立刻再提醒一次，
  // 不会被 6 小时的冷却压住。
  if (!low) { wasLow = false; return { checked: true, balance, low: false, sent: false }; }

  const firstTime = !wasLow;
  wasLow = true;
  if (!firstTime && now - lastAlertAt < RESEND_MS) {
    return { checked: true, balance, low: true, sent: false, reason: 'cooldown' };
  }
  lastAlertAt = now;
  const sent = await notify(balance, threshold);
  return { checked: true, balance, low: true, sent };
}

async function defaultNotify(balance, threshold) {
  const smtp = smtpConfigFromEnv();
  if (!smtp) {
    console.warn(`[vend] 上游余额只剩 $${balance}（低于 $${threshold}），但没配 SMTP，发不出提醒`);
    return false;
  }
  try {
    await sendMail({
      ...smtp,
      subject: `【取号站】上游余额只剩 $${balance}`,
      text: [
        `HeroSMS 账户余额：$${balance}`,
        `告警阈值：$${threshold}`,
        '',
        '余额见底时买家侧的表现是「换哪个地区都取不到号」，',
        '页面不会说是余额问题（那句话不能给买家看），所以只有这封信会提醒你。',
        '',
        '充值后本提醒会自动复位；余额回到阈值以上再次见底时会重新提醒。',
      ].join('\n'),
    });
    console.warn(`[vend] 上游余额只剩 $${balance}，已发提醒邮件`);
    return true;
  } catch (error) {
    console.warn(`[vend] 余额提醒邮件发送失败：${error.message}`);
    return false;
  }
}

export function startBalanceWatch() {
  checkBalanceOnce().catch(() => {});
  const timer = setInterval(() => { checkBalanceOnce().catch(() => {}); }, CHECK_MS);
  timer.unref();
  return timer;
}

// 只给测试用：把模块级状态清干净，否则用例之间会互相污染
export function __resetBalanceWatch() {
  lastAlertAt = 0;
  wasLow = false;
}
