// 把 data/hero-services.json 里的服务映射到 simple-icons 的品牌图标，生成
// public/vend/icons/<code>.svg + public/vend/service-icons.json。
// 原则同 scripts/build-flags.cjs：映射不上的**列出来人工确认**，绝不猜。
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(ROOT, 'data/hero-services.json');
const ICONS_SVG_DIR = path.join(ROOT, 'node_modules/simple-icons/icons');

// Windows 保留设备名：CON / PRN / AUX / NUL / COM1-9 / LPT1-9。
// 带扩展名也照样保留（aux.svg 一样打不开），文件能被某些工具建出来，
// 但 git.exe、资源管理器、大部分 Win32 程序都读不了它 ——
// 实际后果是 `git add` 直接 fatal，整个仓库加不进去。
// 服务码里真的有一个 aux，所以这条不是理论问题。
// 规则：保留名后面缀一个 -，前后端用同一个函数算，别两边各写一份。
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeIconName(code) {
  return WIN_RESERVED.test(code) ? `${code}-` : code;
}

const OUT_DIR = path.join(ROOT, 'public/vend/icons');
const OUT_JSON = path.join(ROOT, 'public/vend/service-icons.json');

const simpleIconsData = require('simple-icons/icons.json');
const ICONS = simpleIconsData.icons || simpleIconsData;

// 第二图标源：@iconify-json/logos（gilbarbara/logos，CC0），补 simple-icons 因商标下架的大牌。
// simple-icons 是单色可控的，永远优先；logos 是彩色多元素的，只用来补缺口。
const logosData = require('@iconify-json/logos/icons.json');

// 仓库根由脚本自身位置算出，不写死 —— 写死的话别人 clone 到任何别的目录都跑不了。
const ROOT = require('node:path').join(__dirname, '..').replace(/\\/g, '/');
const LOGOS_ICONS = logosData.icons;
const LOGOS_DEFAULT_WIDTH = logosData.width || 24;
const LOGOS_DEFAULT_HEIGHT = logosData.height || 24;

const LIGHT_REPLACEMENT_HEX = '1D1D1F';
const LUMINANCE_THRESHOLD = 0.72;

// logos 的浅色闸门比 simple-icons 更严：不是"改色兜底"，是"直接不采用"——
// 因为 logos 是多元素多色，无法像单 path 那样安全地整体强改成深色，改了容易把品牌配色改花。
const LOGOS_LUMINANCE_THRESHOLD = 0.82;

// 19x19 图标位的长宽比闸门：横向文字标（wordmark）塞进方框会缩成一条糊线，宁可不用。
const ASPECT_MIN = 0.62;
const ASPECT_MAX = 1.6;

// ---- 人工映射表：上游服务码 -> simple-icons slug ----
// 每一条都是人工核过、能在 node_modules/simple-icons/icons.json 里查到 slug 的。
// 兜自动匹配算法覆盖不到的上游简称/怪名/品牌组合名。
const MANUAL = {
  // 组合名：上游把多个产品线塞进一个名字，明确指定用哪个当图标
  go: 'google',              // "Google,youtube,Gmail"
  ig: 'instagram',           // "Instagram+Threads"
  lf: 'tiktok',              // "TikTok/Douyin"
  tw: 'x',                   // "Twitter/X"（上游沿用旧称，图标用新标）
  al: 'alibabadotcom',       // "Alipay/Alibaba/1688" 主品牌给阿里巴巴
  wb: 'wechat',              // 微信 WeChat
  wx: 'apple',               // Apple ID
  me: 'line',                // LINE messenger（避免误配到 Facebook Messenger）
  vk: 'vk',
  ok: 'odnoklassniki',       // ok.ru
  ka: 'shopee',
  gs: 'samsung',              // "SamsungShop"，suffix "shop" 不在噪声词表里，手动兜
  kf: 'sinaweibo',            // 上游叫 "Weibo"，simple-icons 收录名是 "Sina Weibo"
  gf: 'google',               // "GoogleVoice" 是 Google 产品线，用 Google 主标
  nq: 'tripdotcom',           // 上游简称 "Trip"，实际是 Trip.com
  ny: 'bitcoin',              // "BitcoinBon" 比特币充值券，用比特币符号表意（非同名公司，人工判断保留）
  qf: 'xiaohongshu',          // 上游叫 "RedBook"，就是小红书的英文别名
};

// ---- 人工映射表（第二源）：上游服务码 -> @iconify-json/logos 的 icon key ----
// 每一条都是逐个在 node_modules/@iconify-json/logos/icons.json 里 grep 核过、
// 确认存在的（不是凭印象猜的）。只解决 simple-icons 因商标下架/根本没收录的品牌。
// 注意：这里登记的是"logos 里确实有这个 key"，不代表最终会被采用——
// 还要过下面的长宽比闸门和浅色闸门，过不了的会在报告里单独列出来，不会被塞进方框。
//
// 核实方法（供复核）：
//   node -e "const d=require('@iconify-json/logos/icons.json');
//            console.log(Object.keys(d.icons).filter(k=>k.includes('yahoo')))"
// missing-top60.txt 里另外 14 个（Grindr/Walmart/AOL/pof.com/Yalla/Mamba/Imo/
// Craigslist/JDcom/Blizzard/OLX/BIGO LIVE/Bolt/Wolt）逐个 grep 过，logos 里
// 确认不存在，未登记——按红线宁可留空，不硬凑。
const MANUAL_LOGOS = {
  tn: 'linkedin-icon', // LinkedIN；logos 同时有 'linkedin'(512x128 长条 wordmark，会被长宽比闸门挡) 和
                        // 'linkedin-icon'(256x256 方形"in"字标)，手动指定后者，不让自动匹配抓错那个
  mb: 'yahoo',          // Yahoo；logos 只有 512x143 的横向 wordmark，没有方形变体 —— 预期会被长宽比闸门挡下，
                        // 登记它是为了让闸门跑一遍、把"两库都有但形状不适配"和"两库都没有"区分开来报告
  ya: 'yandex-ru',      // Yandex；同上，logos 只有 512x201 的横向 wordmark，预期同样被长宽比闸门挡下
};

// ---- 手写表：无法/不该套用任何品牌 logo 的服务码，构建时直接写文件 ----
// 目前只有 ot（Any other，通用号，无品牌可言）。不走 MANUAL/simple-icons/logos 任何一条
// 匹配路径，也不受长宽比/浅色闸门约束——是我们自己画的，形状色值当场就能看清楚。
// 简洁短信气泡轮廓，深色 #1D1D1F，viewBox 0 0 24 24。
const HANDMADE = {
  ot: {
    name: '通用短信气泡（无品牌，手绘）',
    viewBox: '0 0 24 24',
    body:
      '<path fill="#1D1D1F" d="M4 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2v3.5a.5.5 0 0 0 .8.4L11.33 17H20a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Z"/>' +
      '<circle cx="8" cy="9.5" r="1.3" fill="#FFFFFF"/>' +
      '<circle cx="12" cy="9.5" r="1.3" fill="#FFFFFF"/>' +
      '<circle cx="16" cy="9.5" r="1.3" fill="#FFFFFF"/>',
  },
};

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function segmentsOf(str) {
  return String(str || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
const SUFFIX_NOISE = ['messenger', 'app', 'mail', 'com', 'net'];
function stripSuffixNoise(norm) {
  for (const w of SUFFIX_NOISE) {
    if (norm.length > w.length && norm.endsWith(w)) return norm.slice(0, -w.length);
  }
  return norm;
}

// ---- 建索引：归一化 title/slug/别名 -> icon 条目 ----
const bySlug = new Map();
const byNorm = new Map();
const collisions = [];
for (const icon of ICONS) {
  bySlug.set(icon.slug, icon);
  const keys = new Set([normalize(icon.title), normalize(icon.slug)]);
  for (const a of icon.aliases?.aka || []) keys.add(normalize(a));
  for (const v of Object.values(icon.aliases?.loc || {})) keys.add(normalize(v));
  keys.delete('');
  for (const k of keys) {
    if (byNorm.has(k)) {
      if (byNorm.get(k).slug !== icon.slug) collisions.push(`${k}: ${byNorm.get(k).slug} vs ${icon.slug}（先到先得）`);
      continue;
    }
    byNorm.set(k, icon);
  }
}

function candidatesFor(rawName) {
  const list = [];
  const push = (v) => { if (v && !list.includes(v)) list.push(v); };
  const full = normalize(rawName);
  push(full);
  push(stripSuffixNoise(full));
  for (const seg of segmentsOf(rawName)) {
    const n = normalize(seg);
    push(n);
    push(stripSuffixNoise(n));
  }
  return list;
}

function matchIcon(code, rawName) {
  if (MANUAL[code]) {
    const icon = bySlug.get(MANUAL[code]);
    if (icon) return { icon, via: `manual:${MANUAL[code]}` };
    return { icon: null, via: `manual-slug-not-found:${MANUAL[code]}` };
  }
  for (const cand of candidatesFor(rawName)) {
    if (byNorm.has(cand)) return { icon: byNorm.get(cand), via: `auto:${cand}` };
  }
  return { icon: null, via: null };
}

function relativeLuminance(hex) {
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function extractPathD(slug) {
  const file = path.join(ICONS_SVG_DIR, `${slug}.svg`);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf8');
  const match = content.match(/<path\s+d="([^"]+)"/);
  return match ? match[1] : null;
}

// ---------- logos 源：拼 SVG / 校验 / 长宽比闸门 / 浅色闸门 ----------

// logos 的 body 里偶尔用 CSS 命名色（比如 yandex-ru 用的是 fill="red"），不是每个都是 hex。
// 只登记常见的 CSS3 命名色——遇到没登记的（rgb()/hsl()/生僻命名色）一律当"解析不了"处理，
// 不采用、报出来，绝不当它是深色就放行（"拿不准宁可留空"同一条规矩）。
const NAMED_COLORS = {
  red: 'ff0000', white: 'ffffff', black: '000000', blue: '0000ff', green: '008000',
  yellow: 'ffff00', orange: 'ffa500', purple: '800080', pink: 'ffc0cb', brown: 'a52a2a',
  gray: '808080', grey: '808080', cyan: '00ffff', magenta: 'ff00ff', lime: '00ff00',
  navy: '000080', teal: '008080', maroon: '800000', olive: '808000', silver: 'c0c0c0',
  gold: 'ffd700', indigo: '4b0082', violet: 'ee82ee', salmon: 'fa8072', coral: 'ff7f50',
  crimson: 'dc143c', tomato: 'ff6347', khaki: 'f0e68c', beige: 'f5f5dc', ivory: 'fffff0',
  azure: 'f0ffff', lavender: 'e6e6fa', turquoise: '40e0d0', chocolate: 'd2691e', tan: 'd2b48c',
  wheat: 'f5deb3', snow: 'fffafa', whitesmoke: 'f5f5f5', skyblue: '87ceeb', royalblue: '4169e1',
  darkblue: '00008b', darkgreen: '006400', darkred: '8b0000', lightgray: 'd3d3d3', lightgrey: 'd3d3d3',
  transparent: null,
};

function hexToLuminance(hex) {
  const h = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return relativeLuminance(h.toUpperCase());
}

// 返回 { ok:true, lum } 或 { ok:false }（none/currentColor/transparent/无法识别）
function resolveColorLuminance(raw) {
  const c = String(raw || '').trim().toLowerCase();
  if (!c || c === 'none' || c === 'currentcolor' || c === 'transparent') return { ok: false, skip: true };
  const hexMatch = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) return { ok: true, lum: hexToLuminance(hexMatch[1]) };
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, c)) {
    const hex = NAMED_COLORS[c];
    if (hex === null) return { ok: false, skip: true }; // transparent 类，不参与判浅色
    return { ok: true, lum: hexToLuminance(hex) };
  }
  return { ok: false, skip: false }; // rgb()/hsl()/生僻命名色：解析不了，不是"跳过"
}

// 极简 XML 良构性校验：标签栈平衡 + 标签外文本不含裸露的 < 或未转义的 &。
// 不是完整 XML 校验器，但足以抓出 logos 数据里偶发的标签不闭合/属性写崩的情况。
function isWellFormedXml(str) {
  const tagRe = /<(\/?)([a-zA-Z_][\w:.-]*)((?:\s+[a-zA-Z_][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
  const stack = [];
  let lastIndex = 0;
  let m;
  const hasStrayMarkup = (text) => /[<&]/.test(text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, ''));
  while ((m = tagRe.exec(str))) {
    if (hasStrayMarkup(str.slice(lastIndex, m.index))) return false;
    lastIndex = tagRe.lastIndex;
    const [, closing, name, , selfClose] = m;
    if (closing) {
      if (!stack.length || stack[stack.length - 1] !== name) return false;
      stack.pop();
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (hasStrayMarkup(str.slice(lastIndex))) return false;
  return stack.length === 0;
}

// 尝试用 logos 的一个 icon key 生成可用图标。
// 返回 { ok:true, svg, width, height } 或 { ok:false, reason, ...detail }。
function tryLogosIcon(slug) {
  const icon = LOGOS_ICONS[slug];
  if (!icon) return { ok: false, reason: 'slug-not-found' };

  const width = icon.width || LOGOS_DEFAULT_WIDTH;
  const height = icon.height || LOGOS_DEFAULT_HEIGHT;
  const left = icon.left || 0;
  const top = icon.top || 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}">${icon.body}</svg>\n`;

  if (!isWellFormedXml(svg)) return { ok: false, reason: 'xml-malformed' };

  const ratio = width / height;
  if (ratio > ASPECT_MAX || ratio < ASPECT_MIN) {
    return { ok: false, reason: 'aspect-ratio', ratio: Number(ratio.toFixed(3)), width, height };
  }

  const rawColors = [...icon.body.matchAll(/(?:fill|stop-color)\s*=\s*"([^"]+)"/g)].map((mm) => mm[1]);
  const uniqColors = [...new Set(rawColors.map((c) => c.trim().toLowerCase()))];
  const lums = [];
  for (const c of uniqColors) {
    const res = resolveColorLuminance(c);
    if (res.skip) continue; // none/currentColor/transparent：不算一个"颜色"，不参与判浅色
    if (!res.ok) return { ok: false, reason: 'color-parse-failed', color: c };
    lums.push(res.lum);
  }
  if (lums.length && lums.every((l) => l > LOGOS_LUMINANCE_THRESHOLD)) {
    return { ok: false, reason: 'too-light', lums: lums.map((l) => Number(l.toFixed(3))) };
  }

  return { ok: true, svg, width, height };
}

function main() {
  const rows = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const serviceIcons = {};
  const unmatched = [];
  const recolored = [];
  const failedExtract = [];
  const logosMatched = [];
  const logosAspectBlocked = [];
  const logosLightBlocked = [];
  const logosXmlFailed = [];
  const logosColorParseFailed = [];
  const logosSlugNotFound = [];
  const handmadeMatched = [];
  let matched = 0;

  for (const row of rows) {
    const { code, name, stock } = row;

    // 手写表优先级最高：这几个码不走任何品牌匹配，直接落盘。
    if (HANDMADE[code]) {
      const h = HANDMADE[code];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${h.viewBox}">${h.body}</svg>\n`;
      fs.writeFileSync(path.join(OUT_DIR, `${safeIconName(code)}.svg`), svg);
      serviceIcons[code] = { source: 'handmade', name: h.name };
      handmadeMatched.push({ code, name });
      matched += 1;
      continue;
    }

    const { icon, via } = matchIcon(code, name);
    if (icon) {
      const d = extractPathD(icon.slug);
      if (!d) {
        failedExtract.push({ code, slug: icon.slug });
        unmatched.push({ code, name, stock, via: `extract-failed:${icon.slug}` });
        continue;
      }

      let hex = icon.hex.toUpperCase();
      const lum = relativeLuminance(hex);
      if (lum > LUMINANCE_THRESHOLD) {
        recolored.push({ code, slug: icon.slug, title: icon.title, originalHex: `#${hex}`, luminance: Number(lum.toFixed(3)) });
        hex = LIGHT_REPLACEMENT_HEX;
      }

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}" fill="#${hex}"/></svg>\n`;
      fs.writeFileSync(path.join(OUT_DIR, `${safeIconName(code)}.svg`), svg);
      serviceIcons[code] = { source: 'simple-icons', slug: icon.slug, hex: `#${hex}` };
      matched += 1;
      continue;
    }

    // simple-icons 没有 -> 第二源：logos（只查人工核过的 MANUAL_LOGOS 表，不做自动模糊匹配——
    // 自动匹配在全量 567 个未匹配码上试跑过，命中的十几个里一半是同名撞车的假阳性
    // 如 "Spark Driver"->Apache Spark、"Fetch"->JS Fetch API、"AIS PLAY"->通用"play"图标，
    // 挂错比留空更糟，所以只信人工核过的条目）。
    const logosSlug = MANUAL_LOGOS[code];
    if (logosSlug) {
      const r = tryLogosIcon(logosSlug);
      if (r.ok) {
        fs.writeFileSync(path.join(OUT_DIR, `${safeIconName(code)}.svg`), r.svg);
        serviceIcons[code] = { source: 'logos', slug: logosSlug, width: r.width, height: r.height };
        logosMatched.push({ code, name, slug: logosSlug });
        matched += 1;
        continue;
      }
      if (r.reason === 'aspect-ratio') logosAspectBlocked.push({ code, name, slug: logosSlug, ...r });
      else if (r.reason === 'too-light') logosLightBlocked.push({ code, name, slug: logosSlug, ...r });
      else if (r.reason === 'xml-malformed') logosXmlFailed.push({ code, name, slug: logosSlug });
      else if (r.reason === 'color-parse-failed') logosColorParseFailed.push({ code, name, slug: logosSlug, color: r.color });
      else if (r.reason === 'slug-not-found') logosSlugNotFound.push({ code, name, slug: logosSlug });
      unmatched.push({ code, name, stock, via: `logos-blocked:${logosSlug}:${r.reason}` });
      continue;
    }

    unmatched.push({ code, name, stock, via });
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(serviceIcons, null, 2));

  console.log(`匹配成功 ${matched} / ${rows.length} 个服务`);
  console.log(`  其中 simple-icons ${matched - logosMatched.length - handmadeMatched.length} 个 / logos ${logosMatched.length} 个 / 手写 ${handmadeMatched.length} 个`);
  console.log(`生成 SVG：${matched} 个 -> ${OUT_DIR}`);
  console.log(`生成索引：${Object.keys(serviceIcons).length} 键 -> ${OUT_JSON}`);

  if (recolored.length) {
    console.log(`\n🎨 亮度 > ${LUMINANCE_THRESHOLD} 被强制改色为 #${LIGHT_REPLACEMENT_HEX} 的品牌（${recolored.length} 个，供人工复核）：`);
    for (const r of recolored) console.log(`  ${r.code} (${r.slug}/${r.title}) 原色 ${r.originalHex} 亮度 ${r.luminance}`);
  }

  if (failedExtract.length) {
    console.log(`\n⚠ icons.json 里有条目但对应 .svg 文件缺失/解析失败（数据集自身问题，需人工看）：`);
    for (const f of failedExtract) console.log(`  ${f.code} -> ${f.slug}`);
  }

  if (collisions.length) {
    console.log(`\nℹ 归一化后撞名的品牌（不影响结果，先到先得，供参考）：${collisions.length} 处（仅列前 10）`);
    for (const c of collisions.slice(0, 10)) console.log(`  ${c}`);
  }

  if (logosMatched.length) {
    console.log(`\n🖼 logos 源补上的服务（${logosMatched.length} 个）：`);
    for (const l of logosMatched) console.log(`  ${l.code}\t${l.name}\t-> logos:${l.slug}`);
  }

  if (logosAspectBlocked.length) {
    console.log(`\n📐 logos 里查得到但被长宽比闸门挡下的（viewBox 宽/高 超出 [${ASPECT_MIN}, ${ASPECT_MAX}]，${logosAspectBlocked.length} 个，宁可留首字母牌）：`);
    for (const l of logosAspectBlocked) console.log(`  ${l.code}\t${l.name}\t-> logos:${l.slug}\t${l.width}x${l.height}\t比值 ${l.ratio}`);
  }

  if (logosLightBlocked.length) {
    console.log(`\n☀ logos 里查得到但被浅色闸门挡下的（所有颜色亮度 > ${LOGOS_LUMINANCE_THRESHOLD}，${logosLightBlocked.length} 个）：`);
    for (const l of logosLightBlocked) console.log(`  ${l.code}\t${l.name}\t-> logos:${l.slug}\t亮度 ${JSON.stringify(l.lums)}`);
  }

  if (logosXmlFailed.length) {
    console.log(`\n⚠ logos 拼出来的 SVG 解析不过（标签不闭合等），已丢弃（${logosXmlFailed.length} 个）：`);
    for (const l of logosXmlFailed) console.log(`  ${l.code}\t${l.name}\t-> logos:${l.slug}`);
  }

  if (logosColorParseFailed.length) {
    console.log(`\n⚠ logos 里颜色写法认不出（非 hex/未登记的命名色），无法判浅色闸门，已丢弃（${logosColorParseFailed.length} 个）：`);
    for (const l of logosColorParseFailed) console.log(`  ${l.code}\t${l.name}\t-> logos:${l.slug}\t颜色 "${l.color}"`);
  }

  if (logosSlugNotFound.length) {
    console.log(`\n⚠ MANUAL_LOGOS 表登记的 slug 在 logos icons.json 里查不到（表写错了，需要修表）：`);
    for (const l of logosSlugNotFound) console.log(`  ${l.code}\t${l.name}\t-> logos:${l.slug}`);
  }

  if (handmadeMatched.length) {
    console.log(`\n✍ 手写表直接落盘的（${handmadeMatched.length} 个）：`);
    for (const h of handmadeMatched) console.log(`  ${h.code}\t${h.name}`);
  }

  const unmatchedSorted = unmatched.slice().sort((a, b) => (b.stock || 0) - (a.stock || 0));
  console.log(`\n❗ 未匹配服务（按库存降序，前 60 个，供下一轮补 MANUAL 表）：共 ${unmatched.length} 个`);
  for (const u of unmatchedSorted.slice(0, 60)) {
    console.log(`  ${u.code}\t${u.name}\t库存 ${u.stock}\t${u.via || ''}`);
  }
}

main();
