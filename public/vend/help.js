// help.js — 说明页的活数据
//
// 这个页面上所有会变的数字（服务总数、号码有效期、换号规则、邮箱天数）
// 一律**从接口现取**，不写死在 HTML 里。
//
// 上一版就是写死的，结果配置改了页面没改：换号规则早就从「最多 5 次」
// 变成了「有效期内不限次数」，邮箱从 24 小时变成 3 天，说明页还在讲老规矩——
// 买家照着老说明操作，对不上就来退款。
//
// HTML 里留的静态值是**兜底**（接口挂了 / 爬虫不跑 JS 时看到的），
// 所以静态值也必须是当下正确的，不能当占位符乱填。

const $ = (id) => document.getElementById(id);
const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };

async function get(path) {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(String(r.status));
  const payload = await r.json();
  if (payload.ok === false) throw new Error(payload.error || 'bad');
  return payload.data;
}

async function fillLiveNumbers() {
  try {
    const meta = await get('/api/vend/meta');
    const minutes = Math.round((meta.activationTtlSec || 1200) / 60);
    set('cTtl', minutes);
    set('cPoll', meta.pollIntervalSec || 5);
    if (meta.mailTtlDays) { set('cMail', meta.mailTtlDays); set('cMail2', meta.mailTtlDays); }

    // 换号规则的措辞跟着配置走。maxChanges 为 null = 不限次数，
    // 但上游 90 秒内不许退号，所以实际是「不限次数、每次间隔约 90 秒」，
    // 不能写成真·无限 —— 那是承诺一件上游做不到的事。
    const unlimited = meta.maxChanges == null;
    set('cChange', unlimited
      ? `号码有效期（${minutes} 分钟）内可以反复换，每次之间要隔约 90 秒`
      : `一张卡密最多换 ${meta.maxChanges} 次`);
    set('cChange2', unlimited
      ? `号码有效期内可以反复换号，只受 90 秒间隔限制`
      : `一张卡密最多换 ${meta.maxChanges} 次号`);
  } catch (error) {
    console.warn('[help] meta 取不到，用页面上的兜底数字', error);
  }

  try {
    const data = await get('/api/vend/services?q=');
    if (data?.total) set('cSvc', data.total);
  } catch (error) {
    console.warn('[help] 服务总数取不到', error);
  }
}

// FAQPage 结构化数据现在是**静态写在 help.html 里**的，这里不再运行时生成。
//
// 之前是 JS 生成的，问题在于：robots.txt 专门放行了 GPTBot / ClaudeBot 这些不跑 JS 的爬虫，
// 它们抓到的是一个空 <script> —— 等于没有。而且再往前一版是手写第二份，
// 结果和正文完全对不上（实测 16 条全部落空），那是会吃 Google 人工处置的类型。
//
// 现在只留一道自检：JSON-LD 里的每一问，必须在页面上真的看得见。
function auditFaq() {
  let data;
  try { data = JSON.parse($('faqLd')?.textContent || '{}'); } catch { return; }
  const text = document.body.innerText;
  const miss = (data.mainEntity || []).filter((q) => !text.includes(q.name));
  if (miss.length) console.warn('[help] FAQ 结构化数据和页面对不上：', miss.map((q) => q.name));
}

auditFaq();
fillLiveNumbers();
