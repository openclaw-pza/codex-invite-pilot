const $ = (id) => document.getElementById(id);

async function api(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload.data;
}

function log(message, level = 'info') {
  const li = document.createElement('li');
  li.className = level === 'ok' ? 'ok' : level === 'err' ? 'err' : '';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const text = document.createElement('span');
  text.className = 'log-msg';
  text.textContent = message;
  li.append(time, text);
  $('logList').prepend(li);
}

async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    log(`${label}已复制`, 'ok');
  } catch {
    log(`复制失败，请手动复制：${value}`, 'err');
  }
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    const chips = [
      { label: config.mail.adminAuthSet && config.mail.baseUrlSet ? '邮箱已连接' : '邮箱未配置', ok: config.mail.adminAuthSet && config.mail.baseUrlSet },
      { label: config.heroSms.apiKeySet ? 'HeroSMS 已连接' : 'HeroSMS 未配置', ok: config.heroSms.apiKeySet },
      { label: '邀请手动打开 v0.2.1', ok: true },
    ];
    $('statusChips').innerHTML = '';
    for (const chip of chips) {
      const span = document.createElement('span');
      span.className = `chip ${chip.ok ? 'ok' : 'bad'}`;
      span.textContent = chip.label;
      $('statusChips').append(span);
    }
    log('本地服务正常，等待安装或打开 Chrome 扩展', 'ok');
  } catch (error) {
    log(`本地服务异常：${error.message}`, 'err');
  }
}

$('copyExtensionPath').onclick = () => copyText($('extensionPath').textContent.trim(), '扩展目录');
$('copyExtensionsUrl').onclick = () => copyText('chrome://extensions', '扩展管理页地址');
loadConfig();
