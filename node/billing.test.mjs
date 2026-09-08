import assert from 'node:assert/strict';
import { CariPayBilling, CariPayError } from './index.js';

const input = { requestId: 'order_20260908_001', amount: 128000,
  recipient: { name: '테스트 고객', phone: '010-0000-0000' }, reason: '수리비', message: '내역을 확인해 주세요.' };
const calls = [];
const billing = new CariPayBilling({ accessToken: 'mock-merchant-token', mode: 'live', fetch: async (url, init) => {
  calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
  return new Response(JSON.stringify({ result_code: 0, result_data: null }));
} });
assert.deepEqual(await billing.sendInvoice(input), { accepted: true, requestId: input.requestId });
assert.equal(calls[0].url, 'https://api.caripay.co.kr/app/v1/sales/bill');
assert.equal(calls[0].headers['x-access-token'], 'mock-merchant-token');
assert.equal(calls[0].redirect, 'error');
assert.equal(calls[0].body.members[0].studentPhone, '01000000000');
assert.equal(calls[0].body.members[0].studentName, input.recipient.name);
assert.equal(calls[0].body.amount, input.amount);
assert.equal(calls[0].body.requestId, input.requestId);
assert.equal(calls[0].body.reason, '수리비');
assert.equal(calls[0].body.API_SIGN, undefined);
await billing.sendInvoice(input);
assert.deepEqual(calls[0].body, calls[1].body); // Retry preserves the server's idempotency contract.
await billing.listInvoices({ month: '2026-09', page: 2, size: 20 });
assert.equal(calls[2].method, 'GET');
assert.match(calls[2].url, /page=2&size=20&month=2026-09$/);
await billing.getInvoice('invoice-uuid');
assert.match(calls[3].url, /\/bill\/invoice-uuid$/);

const blocked = new CariPayBilling({ accessToken: 'mock-token', fetch: () => assert.fail('Invalid input must not call the API') });
for (const changes of [{ amount: 99 }, { amount: 2147483648 }, { amount: 100.5 }, { amount: '100' },
  { requestId: 'short' }, { reason: '' }, { reason: 'x'.repeat(61) }, { message: '\n' },
  { recipient: { name: '고객', phone: 'abc01000000000' } }, { recipient: { name: '', phone: '01000000000' } }]) {
  await assert.rejects(() => blocked.sendInvoice({ ...input, ...changes }), CariPayError);
}
await assert.rejects(() => blocked.getInvoice('../admin'), CariPayError);
await assert.rejects(() => blocked.listInvoices({ size: 101 }), CariPayError);
await assert.rejects(() => blocked.listInvoices({ month: '2026-13' }), CariPayError);
assert.throws(() => new CariPayBilling({ accessToken: 'mock', baseUrl: 'http://remote.example' }), CariPayError);
assert.throws(() => new CariPayBilling({ accessToken: 'mock', baseUrl: 'https://user:pass@example.com' }), CariPayError);
assert.throws(() => new CariPayBilling({ accessToken: 'mock', baseUrl: 'https://example.com/?token=mock' }), CariPayError);
assert.throws(() => new CariPayBilling({ accessToken: 'mock', timeoutMs: 0 }), CariPayError);
assert.throws(() => new CariPayBilling({ accessToken: '' }), CariPayError);
assert.equal(CariPayBilling.fromEnv({ CARIPAY_BILLING_ACCESS_TOKEN: 'mock' }).baseUrl, 'https://api.dev.chewing.io');

for (const [status, body] of [[200, { result_code: -1, result_msg: 'PRIVATE-CUSTOMER-DATA' }],
  [503, { result_code: 0 }], [200, { result_code: null }], [200, { result_code: false }]]) {
  const failed = new CariPayBilling({ accessToken: 'mock', fetch: async () => new Response(JSON.stringify(body), { status }) });
  await assert.rejects(() => failed.sendInvoice(input), e => e instanceof CariPayError && !e.message.includes('PRIVATE-CUSTOMER-DATA'));
}
let attempts = 0;
const timedOut = new CariPayBilling({ accessToken: 'mock', fetch: async () => { attempts++; throw new Error('PRIVATE-CUSTOMER-DATA'); } });
await assert.rejects(() => timedOut.sendInvoice(input), e => e.message.includes('requestId') && !e.message.includes('PRIVATE-CUSTOMER-DATA'));
assert.equal(attempts, 1);
console.log('Billing SDK checks passed: payload, tenant token, validation, idempotent retry, no redirect/retry, safe errors (mock only)');
