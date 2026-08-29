const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload.data;
}

function message(text, type = '') {
  const el = $('adminMessage');
  el.textContent = text;
  el.className = `admin-message ${type}`;
}

function fill(config) {
  $('mailBaseUrl').value = config.mail.baseUrl || '';
  $('mailDomain').value = config.mail.domain || '';
  $('mailAdminAuth').placeholder = config.mail.adminAuthSet ? '已配置 · 留空保留现有值' : '尚未配置';
  $('heroBaseUrl').value = config.heroSms.baseUrl || '';
  $('heroApiKey').placeholder = config.heroSms.apiKeySet ? '已配置 · 留空保留现有值' : '尚未配置';
  $('heroService').value = config.heroSms.service || 'dr';
  const country = String(config.heroSms.country || 52);
  if (![...$('heroCountry').options].some((option) => option.value === country)) {
    const fallback = document.createElement('option');
    fallback.value = country;
    fallback.textContent = `其他国家（HeroSMS ID ${country}）`;
    $('heroCountry').append(fallback);
  }
  $('heroCountry').value = country;
  $('heroOperator').value = config.heroSms.operator || 'any';
  $('heroPriority').value = config.heroSms.priority || 'price';
  $('heroMaxPrice').value = config.heroSms.maxPrice || '';
}

async function loadCountries(preferredCountry = $('heroCountry').value || '52') {
  const select = $('heroCountry');
  select.disabled = true;
  const service = $('heroService').value.trim() || 'dr';
  try {
    const result = await api(`/api/sms/countries?service=${encodeURIComponent(service)}`);
    select.innerHTML = '';
    for (const country of result.countries || []) {
      const option = document.createElement('option');
      option.value = String(country.id);
      option.dataset.countryName = country.name;
      const minPrice = country.minPrice == null ? '' : ` · 最低 $${country.minPrice}`;
      option.textContent = `${country.name}${minPrice} · ${Number(country.count || 0).toLocaleString('zh-CN')} 个`;
      select.append(option);
    }
    if (![...select.options].some((option) => option.value === String(preferredCountry))) {
      const fallback = document.createElement('option');
      fallback.value = String(preferredCountry);
      fallback.dataset.countryName = `当前配置国家 ${preferredCountry}`;
      fallback.textContent = `当前配置国家（HeroSMS ID ${preferredCountry}，本服务暂时无报价）`;
      select.prepend(fallback);
    }
    select.value = String(preferredCountry);
  } catch (error) {
    select.innerHTML = '';
    const fallback = document.createElement('option');
    fallback.value = String(preferredCountry);
    fallback.dataset.countryName = `国家 ID ${preferredCountry}`;
    fallback.textContent = `国家列表读取失败（保留 ID ${preferredCountry}）`;
    select.append(fallback);
    throw error;
  } finally {
    select.disabled = false;
  }
}

function renderQuotes(result) {
  const list = $('heroQuoteList');
  list.innerHTML = '';
  const selected = Number($('heroMaxPrice').value);
  for (const quote of result.quotes || []) {
    const label = document.createElement('label');
    label.className = 'quote-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'heroPriceQuote';
    radio.value = String(quote.price);
    radio.checked = Number.isFinite(selected) && Math.abs(selected - Number(quote.price)) < 0.00001;
    const price = document.createElement('strong');
    price.textContent = `$${Number(quote.price).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
    const stock = document.createElement('span');
    stock.textContent = `${Number(quote.count).toLocaleString('zh-CN')} 个可用`;
    radio.onchange = () => {
      $('heroMaxPrice').value = radio.value;
      $('heroPriority').value = 'fixed';
    };
    label.append(radio, price, stock);
    list.append(label);
  }
  const selectedCountry = [...$('heroCountry').options].find((option) => option.value === String(result.country));
  const countryName = selectedCountry?.dataset.countryName || `国家 ID ${result.country}`;
  $('heroQuoteMeta').textContent = result.quotes?.length
    ? `服务 ${result.service} · ${countryName} · 共 ${Number(result.total || 0).toLocaleString('zh-CN')} 个（实体 ${Number(result.physical || 0).toLocaleString('zh-CN')}）`
    : '当前没有可用报价。';
}

async function loadBalance() {
  const element = $('heroBalance');
  element.textContent = '余额读取中…';
  element.classList.remove('err');
  try {
    const result = await api('/api/sms/balance');
    if (result.balance == null) throw new Error('平台未返回金额');
    const formatted = Number(result.balance).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    element.textContent = `余额 $${formatted}`;
    element.title = 'HeroSMS 当前账户余额';
  } catch (error) {
    element.textContent = '余额读取失败';
    element.title = error.message;
    element.classList.add('err');
  }
}

async function refreshQuotes() {
  const button = $('refreshHeroPrices');
  button.disabled = true;
  $('heroQuoteMeta').textContent = '正在读取 HeroSMS 实时报价…';
  const balanceRequest = loadBalance();
  try {
    const query = new URLSearchParams({
      service: $('heroService').value.trim() || 'dr',
      country: $('heroCountry').value,
    });
    renderQuotes(await api(`/api/sms/prices?${query}`));
  } catch (error) {
    $('heroQuoteList').innerHTML = '';
    $('heroQuoteMeta').textContent = `报价读取失败：${error.message}`;
  } finally {
    await balanceRequest;
    button.disabled = false;
  }
}

async function load() {
  try {
    const config = await api('/api/admin/config');
    fill(config);
    await loadCountries(config.heroSms.country);
    await refreshQuotes();
  } catch (error) {
    message(`读取失败：${error.message}`, 'err');
  }
}

$('adminForm').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('btnSave');
  button.disabled = true;
  message('正在保存…');
  try {
    const config = await api('/api/admin/config', {
      method: 'POST',
      body: {
        mail: {
          baseUrl: $('mailBaseUrl').value,
          domain: $('mailDomain').value,
          adminAuth: $('mailAdminAuth').value,
          clearAdminAuth: $('clearMailAuth').checked,
        },
        heroSms: {
          baseUrl: $('heroBaseUrl').value,
          apiKey: $('heroApiKey').value,
          clearApiKey: $('clearHeroKey').checked,
          service: $('heroService').value,
          country: $('heroCountry').value,
          operator: $('heroOperator').value,
          priority: $('heroPriority').value,
          maxPrice: $('heroMaxPrice').value,
        },
      },
    });
    $('mailAdminAuth').value = '';
    $('heroApiKey').value = '';
    $('clearMailAuth').checked = false;
    $('clearHeroKey').checked = false;
    fill(config);
    message('配置已安全保存，并已立即生效。', 'ok');
  } catch (error) {
    message(`保存失败：${error.message}`, 'err');
  } finally {
    button.disabled = false;
  }
};

$('refreshHeroPrices').onclick = refreshQuotes;
$('heroCountry').addEventListener('change', () => {
  $('heroMaxPrice').value = '';
  $('heroPriority').value = 'price';
  refreshQuotes();
});
$('heroService').addEventListener('change', async () => {
  $('heroMaxPrice').value = '';
  $('heroPriority').value = 'price';
  try {
    await loadCountries('52');
    await refreshQuotes();
  } catch (error) {
    $('heroQuoteMeta').textContent = `国家列表读取失败：${error.message}`;
  }
});
$('heroMaxPrice').addEventListener('input', () => {
  document.querySelectorAll('input[name="heroPriceQuote"]').forEach((radio) => {
    radio.checked = Math.abs(Number(radio.value) - Number($('heroMaxPrice').value)) < 0.00001;
  });
});

load();
