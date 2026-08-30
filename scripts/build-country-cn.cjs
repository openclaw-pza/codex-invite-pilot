// build-country-cn.cjs — 生成规范的国家简体中文名表。
//
// 为什么要有这个：上游 hero-countries.json 的 chn 字段质量不稳定 ——
//   · 简繁混杂：法國 / 義大利 / 比利時 / 澳大利亞 和简体名混在同一份列表里
//   · 有明显错译：id 158 上游叫「丁烷」（butane，丁烷是一种气体，不是国家）
// 这些名字会直接出现在地区列表、实时可用榜、补差价弹窗上，买家一眼就看得见。
//
// 做法：拿已经建好的 country-iso.json（id → ISO2，195/195 全覆盖），
// 用 i18n-iso-countries 的 zh 词表取规范简体名。这套词表是标准来源，
// 比逐个手改可靠，也不会随上游改动而腐烂。
//
// 用法：node scripts/build-country-cn.cjs

const fs = require('fs');
const countries = require('i18n-iso-countries');
countries.registerLocale(require('i18n-iso-countries/langs/zh.json'));

const ISO = JSON.parse(fs.readFileSync(`${ROOT}/public/vend/country-iso.json`, 'utf8'));
const RAW = JSON.parse(fs.readFileSync(`${ROOT}/data/hero-countries.json`, 'utf8'));
const list = Array.isArray(RAW) ? RAW : (RAW.countries || Object.values(RAW));
const byId = new Map(list.map((c) => [String(c.id), c]));

// ISO 词表偶尔会给一个不如上游常用的写法，这里按中文电商习惯覆盖回来。
// 只列真正需要的，不要变成又一张需要维护的大表。
const OVERRIDE = {
  印尼: '印度尼西亚',   // ISO 给简称，但我们卖得最多的就是这个地区，用全称更正式
};

const out = {};
const changed = [];
const kept = [];
for (const [id, v] of Object.entries(ISO)) {
  const upstream = byId.get(id)?.chn || '';
  let zh = v.iso ? countries.getName(v.iso, 'zh') : '';
  if (zh && OVERRIDE[zh]) zh = OVERRIDE[zh];
  if (!zh) {
    // 查不到就保留上游的，绝不留空 —— 宁可名字旧，也不能列表里出现空白行
    out[id] = upstream || `地区 ${id}`;
    kept.push(`${id} 无 ISO 中文名，沿用上游「${upstream}」`);
    continue;
  }
  out[id] = zh;
  if (upstream && upstream !== zh) changed.push(`${id}\t${upstream}\t->\t${zh}`);
}

fs.writeFileSync(`${ROOT}/data/country-cn.json`, JSON.stringify(out, null, 0), 'utf8');

// 顺带把国际区号写进 country-iso.json：前端要按区号把号码拆成「区号 + 本地号码」。
// 区号长度 1~4 位不定（+1 / +63 / +852 / +1876），靠正则猜必错 ——
// 用 libphonenumber-js 按 ISO2 查真值，构建期算好，运行时零成本。
const { getCountryCallingCode } = require('libphonenumber-js');

// 仓库根由脚本自身位置算出，不写死 —— 写死的话别人 clone 到任何别的目录都跑不了。
const ROOT = require('node:path').join(__dirname, '..').replace(/\\/g, '/');
let ccOk = 0;
let ccMiss = [];
for (const [id, v] of Object.entries(ISO)) {
  try {
    v.cc = getCountryCallingCode(v.iso);
    ccOk += 1;
  } catch {
    ccMiss.push(id + '/' + v.iso);   // 查不到就不写，前端会退回整串显示
  }
}
fs.writeFileSync(`${ROOT}/public/vend/country-iso.json`, JSON.stringify(ISO, null, 0), 'utf8');
console.log('calling codes: ' + ccOk + ' ok, ' + ccMiss.length + ' missing' + (ccMiss.length ? ' -> ' + ccMiss.join(' ') : ''));

fs.writeFileSync(
  'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad/country-cn-diff.txt',
  changed.join('\n') + '\n\n--- kept ---\n' + kept.join('\n'),
  'utf8',
);
console.log('total', Object.keys(out).length, '| renamed', changed.length, '| kept upstream', kept.length);
