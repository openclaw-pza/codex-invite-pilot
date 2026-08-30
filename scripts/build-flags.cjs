// 把上游 195 个国家映射到 ISO2，并从 flag-icons 拷出对应国旗。
// 原则：映射不上的**列出来人工确认**，绝不猜——挂错国旗比不挂糟。
const fs = require('fs');
const path = require('path');
const countries = require('i18n-iso-countries');

// 仓库根由脚本自身位置算出，不写死 —— 写死的话别人 clone 到任何别的目录都跑不了。
const ROOT = require('node:path').join(__dirname, '..').replace(/\\/g, '/');
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const SRC = `${ROOT}/node_modules/flag-icons/flags/4x3`;
const OUT = `${ROOT}/public/vend/flags`;
const raw = JSON.parse(fs.readFileSync(`${ROOT}/data/hero-countries.json`, 'utf8'));

// 上游用的英文名跟 ISO 标准名对不上的，在这里显式对应。
// 每一条都是人工核过的，不是猜的。
const MANUAL = {
  England: 'GB',            // 上游把英国叫 England
  Papua: 'PG',              // 上游简称，中文名是巴布亚新几内亚
  Salvador: 'SV',           // 上游简称，中文名是萨尔瓦多
  Usa: 'US', USA: 'US',
  Russia: 'RU',
  Vietnam: 'VN',
  Laos: 'LA',
  Syria: 'SY',
  Iran: 'IR',
  Tanzania: 'TZ',
  Bolivia: 'BO',
  Venezuela: 'VE',
  Moldova: 'MD',
  Macedonia: 'MK',
  'North Macedonia': 'MK',
  Palestine: 'PS',
  Brunei: 'BN',
  'Cape Verde': 'CV',
  'Ivory Coast': 'CI',
  'Congo': 'CG',
  'DR Congo': 'CD',
  'Democratic Republic of the Congo': 'CD',
  'South Korea': 'KR',
  'North Korea': 'KP',
  Taiwan: 'TW',
  'Hong Kong': 'HK',
  Macau: 'MO', Macao: 'MO',
  Czech: 'CZ', 'Czech Republic': 'CZ', Czechia: 'CZ',
  Swaziland: 'SZ', Eswatini: 'SZ',
  Burma: 'MM', Myanmar: 'MM',
  'East Timor': 'TL', 'Timor-Leste': 'TL',
  Kosovo: 'XK',
  'Bosnia and Herzegovina': 'BA', Bosnia: 'BA',
  'Antigua and Barbuda': 'AG',
  'Trinidad and Tobago': 'TT',
  'Saint Kitts and Nevis': 'KN',
  'Saint Lucia': 'LC',
  'Saint Vincent and the Grenadines': 'VC',
  'Sao Tome and Principe': 'ST',
  'Papua New Guinea': 'PG',
  'New Caledonia': 'NC',
  'French Polynesia': 'PF',
  'Puerto Rico': 'PR',
  'Dominican Republic': 'DO',
  'Costa Rica': 'CR',
  'El Salvador': 'SV',
  'South Sudan': 'SS',
  'Sierra Leone': 'SL',
  'Guinea-Bissau': 'GW',
  'Equatorial Guinea': 'GQ',
  'Burkina Faso': 'BF',
  'Central African Republic': 'CF',
  'Western Sahara': 'EH',
  'United Arab Emirates': 'AE',
  'Saudi Arabia': 'SA',
  'Sri Lanka': 'LK',
  'New Zealand': 'NZ',
  'South Africa': 'ZA',
  Reunion: 'RE',
  Guadeloupe: 'GP',
  Martinique: 'MQ',
  Gibraltar: 'GI',
  Aruba: 'AW',
  Curacao: 'CW',
  Bermuda: 'BM',
  Maldives: 'MV',
  Mauritius: 'MU',
  Seychelles: 'SC',
  Comoros: 'KM',
  Djibouti: 'DJ',
  Eritrea: 'ER',
  Gambia: 'GM',
  Lesotho: 'LS',
  Malawi: 'MW',
  Mozambique: 'MZ',
  Namibia: 'NA',
  Rwanda: 'RW',
  Somalia: 'SO',
  Sudan: 'SD',
  Zambia: 'ZM',
  Zimbabwe: 'ZW',
  Botswana: 'BW',
  Madagascar: 'MG',
  Mauritania: 'MR',
  Niger: 'NE',
  Chad: 'TD',
  Togo: 'TG',
  Benin: 'BJ',
  Gabon: 'GA',
  Cameroon: 'CM',
  Senegal: 'SN',
  Mali: 'ML',
  Guinea: 'GN',
  Liberia: 'LR',
  Ghana: 'GH',
  Uganda: 'UG',
  Kenya: 'KE',
  Ethiopia: 'ET',
  Angola: 'AO',
  Algeria: 'DZ',
  Morocco: 'MA',
  Tunisia: 'TN',
  Libya: 'LY',
  Egypt: 'EG',
  Nigeria: 'NG',
};

const mapping = {};
const unresolved = [];
const missingFlag = [];
const needed = new Set();

for (const c of Object.values(raw)) {
  const eng = String(c.eng || '').trim();
  const iso = MANUAL[eng] || countries.getAlpha2Code(eng, 'en') || null;
  if (!iso) { unresolved.push(`${c.id} ${eng} (${c.chn})`); continue; }
  const file = path.join(SRC, `${iso.toLowerCase()}.svg`);
  if (!fs.existsSync(file)) { missingFlag.push(`${eng} -> ${iso}`); continue; }
  mapping[c.id] = { iso: iso.toUpperCase(), name: c.chn || eng, eng };
  needed.add(iso.toLowerCase());
}

fs.mkdirSync(OUT, { recursive: true });
let bytes = 0;
for (const iso of needed) {
  const buf = fs.readFileSync(path.join(SRC, `${iso}.svg`));
  fs.writeFileSync(path.join(OUT, `${iso}.svg`), buf);
  bytes += buf.length;
}

fs.writeFileSync(
  `${ROOT}/public/vend/country-iso.json`,
  JSON.stringify(mapping),
);

console.log(`映射成功 ${Object.keys(mapping).length} / ${Object.keys(raw).length} 个国家`);
console.log(`拷出国旗 ${needed.size} 面，共 ${(bytes / 1024).toFixed(0)} KB`);
if (unresolved.length) console.log(`\n❗ 映射不到 ISO（不会显示国旗，需人工补）：\n  ${unresolved.join('\n  ')}`);
if (missingFlag.length) console.log(`\n❗ flag-icons 里没有这面旗：\n  ${missingFlag.join('\n  ')}`);
