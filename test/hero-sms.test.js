import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccessNumber, parseOfferQuotes } from '../server/heroSms.js';

test('解析 HeroSMS offers 完整报价档位与库存', () => {
  const result = parseOfferQuotes({
    data: {
      dr: {
        52: {
          prices: { default: 0.33, retail: 0.33 },
          counts: { total: 10136, physical: 5090 },
          map: { '0.9412': 10129, '0.3300': 8496, '0.4530': 9456, '0.0000': 100 },
        },
      },
    },
  }, 'dr', 52);
  assert.deepEqual(result.quotes, [
    { price: 0.33, count: 8496 },
    { price: 0.453, count: 9456 },
    { price: 0.9412, count: 10129 },
  ]);
  assert.equal(result.total, 10136);
  assert.equal(result.physical, 5090);
  assert.equal(result.defaultPrice, 0.33);
});

test('从 HeroSMS 国际号码解析区号和本地号码', () => {
  const result = parseAccessNumber('ACCESS_NUMBER:12345:442079460018');
  assert.equal(result.activationId, '12345');
  assert.equal(result.dialCode, '44');
  assert.equal(result.nationalNumber, '2079460018');
  assert.equal(result.isoCountry, 'GB');
});
