// config.js — 读取 .env 并暴露归一化后的配置（零依赖）
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const ENV_PATH = join(ROOT_DIR, '.env');

function parseEnvFile(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const result = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

// 优先级：真实环境变量 > .env 文件
const fileEnv = parseEnvFile(ENV_PATH);
function env(key, fallback = '') {
  const value = process.env[key] ?? fileEnv[key];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function firstDomain(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^@+/, ''))
    .filter(Boolean)[0] || '';
}

export const config = {
  port: Number(env('PORT', '8787')) || 8787,
  mail: {
    baseUrl: stripTrailingSlash(env('MAIL_BASE_URL')),
    adminAuth: env('MAIL_ADMIN_AUTH'),
    domain: firstDomain(env('MAIL_DOMAIN')),
  },
  heroSms: {
    apiKey: env('HERO_SMS_API_KEY'),
    baseUrl: env('HERO_SMS_BASE_URL', 'https://hero-sms.com/stubs/handler_api.php'),
    service: env('HERO_SMS_SERVICE', 'dr'),
    country: Number(env('HERO_SMS_COUNTRY', '52')) || 52,
    operator: env('HERO_SMS_OPERATOR', 'any'),
    maxPrice: env('HERO_SMS_MAX_PRICE'),
    // fixed = 按管理员选择的报价锁价；price = 自动低价优先；country = 直接取号
    priority: ['fixed', 'country'].includes(env('HERO_SMS_PRIORITY', 'price').toLowerCase())
      ? env('HERO_SMS_PRIORITY', 'price').toLowerCase()
      : 'price',
  },
};

// 暴露给前端的非敏感状态：只说明「配齐没」，绝不返回密钥本身
export function publicConfigStatus() {
  return {
    mail: {
      baseUrlSet: Boolean(config.mail.baseUrl),
      adminAuthSet: Boolean(config.mail.adminAuth),
      domain: config.mail.domain,
    },
    heroSms: {
      apiKeySet: Boolean(config.heroSms.apiKey),
      service: config.heroSms.service,
      country: config.heroSms.country,
      operator: config.heroSms.operator,
      priority: config.heroSms.priority,
    },
  };
}

// 管理页面只读取非敏感值；密钥仅返回「是否已配置」。
export function adminConfig() {
  return {
    mail: {
      baseUrl: config.mail.baseUrl,
      domain: config.mail.domain,
      adminAuthSet: Boolean(config.mail.adminAuth),
    },
    heroSms: {
      baseUrl: config.heroSms.baseUrl,
      apiKeySet: Boolean(config.heroSms.apiKey),
      service: config.heroSms.service,
      country: config.heroSms.country,
      operator: config.heroSms.operator,
      priority: config.heroSms.priority,
      maxPrice: config.heroSms.maxPrice,
    },
  };
}

function clean(value, label) {
  const text = String(value ?? '').trim();
  if (/\r|\n/.test(text)) throw new Error(`${label} 不能包含换行`);
  return text;
}

function validUrl(value, label) {
  const text = clean(value, label);
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} 不是合法 URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} 仅支持 HTTP/HTTPS`);
  return stripTrailingSlash(text);
}

function replaceEnvValues(values) {
  let text = '';
  try {
    text = readFileSync(ENV_PATH, 'utf8');
  } catch {
    text = '';
  }
  const pending = new Map(Object.entries(values));
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  if (lines.length && lines.at(-1) !== '') lines.push('');
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  const output = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  const tempPath = `${ENV_PATH}.tmp`;
  writeFileSync(tempPath, output, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, ENV_PATH);
}

// 保存到 .env 并同步更新进程内配置，不需要重启服务。
// 密钥字段留空代表保留；显式 clear* 才会清除。
export function updateAdminConfig(input = {}) {
  const mail = input.mail || {};
  const hero = input.heroSms || {};
  const mailBaseUrl = validUrl(mail.baseUrl, '邮箱后台地址');
  const mailDomain = firstDomain(clean(mail.domain, '收件域名'));
  const heroBaseUrl = validUrl(hero.baseUrl, 'HeroSMS API 地址');
  const service = clean(hero.service, '服务码') || 'dr';
  const country = Number(clean(hero.country, '国家 ID'));
  if (!Number.isInteger(country) || country <= 0) throw new Error('国家 ID 必须是正整数');
  const operator = clean(hero.operator, '运营商') || 'any';
  const requestedPriority = clean(hero.priority, '取号策略');
  const priority = ['fixed', 'country'].includes(requestedPriority) ? requestedPriority : 'price';
  const maxPrice = clean(hero.maxPrice, '选定价格');
  if (maxPrice && (!Number.isFinite(Number(maxPrice)) || Number(maxPrice) <= 0)) {
    throw new Error('选定价格必须是大于 0 的数字，或留空表示自动选择');
  }
  if (priority === 'fixed' && !maxPrice) throw new Error('锁定报价模式必须先选择或填写价格');

  const mailAdminAuth = mail.clearAdminAuth
    ? ''
    : clean(mail.adminAuth, '邮箱鉴权') || config.mail.adminAuth;
  const heroApiKey = hero.clearApiKey
    ? ''
    : clean(hero.apiKey, 'HeroSMS API Key') || config.heroSms.apiKey;

  replaceEnvValues({
    MAIL_BASE_URL: mailBaseUrl,
    MAIL_ADMIN_AUTH: mailAdminAuth,
    MAIL_DOMAIN: mailDomain,
    HERO_SMS_API_KEY: heroApiKey,
    HERO_SMS_BASE_URL: heroBaseUrl,
    HERO_SMS_SERVICE: service,
    HERO_SMS_COUNTRY: String(country),
    HERO_SMS_OPERATOR: operator,
    HERO_SMS_PRIORITY: priority,
    HERO_SMS_MAX_PRICE: maxPrice,
  });

  Object.assign(config.mail, { baseUrl: mailBaseUrl, adminAuth: mailAdminAuth, domain: mailDomain });
  Object.assign(config.heroSms, {
    baseUrl: heroBaseUrl,
    apiKey: heroApiKey,
    service,
    country,
    operator,
    priority,
    maxPrice,
  });
  return adminConfig();
}
