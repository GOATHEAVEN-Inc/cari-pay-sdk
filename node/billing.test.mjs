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
assert.equal(calls[0].url, 'https://api.dev.caripay.co.kr/app/v1/sales/bill');
assert.equal(calls[0].body.sendChannel, 'ALIMTALK');
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
assert.equal(CariPayBilling.fromEnv({ CARIPAY_BILLING_ACCESS_TOKEN: 'mock' }).baseUrl, 'https://api.dev.caripay.co.kr');

for (const [status, body] of [[200, { result_code: -1, result_msg: 'PRIVATE-CUSTOMER-DATA' }],
  [503, { result_code: 0 }], [200, { result_code: null }], [200, { result_code: false }]]) {
  const failed = new CariPayBilling({ accessToken: 'mock', fetch: async () => new Response(JSON.stringify(body), { status }) });
  await assert.rejects(() => failed.sendInvoice(input), e => e instanceof CariPayError && !e.message.includes('PRIVATE-CUSTOMER-DATA'));
}
let attempts = 0;
const timedOut = new CariPayBilling({ accessToken: 'mock', fetch: async () => { attempts++; throw new Error('PRIVATE-CUSTOMER-DATA'); } });
await assert.rejects(() => timedOut.sendInvoice(input), e => e.message.includes('requestId') && !e.message.includes('PRIVATE-CUSTOMER-DATA'));
assert.equal(attempts, 1);
// 발송 수단: 기본 ALIMTALK, 지정값 그대로, 모르는 값은 호출 전에 거절
{
  const sent = [];
  const b = new CariPayBilling({ accessToken: 'mock', fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ result_code: 0 })); } });
  await b.sendInvoice({ ...input, channel: 'SMS' });
  await b.sendInvoice({ ...input, channel: 'ALIMTALK_THEN_SMS' });
  assert.deepEqual(sent.map((x) => x.sendChannel), ['SMS', 'ALIMTALK_THEN_SMS']);
  await assert.rejects(() => blocked.sendInvoice({ ...input, channel: 'EMAIL' }), CariPayError);
}

// 로그인 → 토큰 만료(-2) → 갱신 → 재시도 → 갱신 실패 시 재로그인. 발송 요청 본문은 그대로 다시 나간다.
{
  const log = [];
  let refreshOk = true;
  let n = 0;
  const fetchMock = async (url, init) => {
    const path = new URL(url).pathname;
    log.push({ path, token: init.headers['x-access-token'] });
    if (path === '/app/v1/auth/login') return new Response(JSON.stringify({ result_code: 0, result_data: { accessToken: `A${++n}`, refreshToken: `R${n}` } }));
    if (path === '/app/v1/auth/refresh') return new Response(JSON.stringify(refreshOk ? { result_code: 0, result_data: { accessToken: `A${++n}`, refreshToken: `R${n}` } } : { result_code: -10 }));
    const expired = log.filter((l) => l.path === '/app/v1/sales/bill').length % 2 === 1; // 첫 호출은 만료, 재시도는 성공
    return new Response(JSON.stringify(expired ? { result_code: -2, result_msg: '토큰이 만료되었습니다' } : { result_code: 0 }));
  };
  const billing = await CariPayBilling.login({ email: ' owner@example.com ', password: 'pw', mode: 'live', fetch: fetchMock });
  assert.equal(billing.accessToken, 'A1');
  await billing.sendInvoice(input);                      // A1 만료 → refresh(A2) → 재시도
  assert.deepEqual(log.map((l) => l.path), ['/app/v1/auth/login', '/app/v1/sales/bill', '/app/v1/auth/refresh', '/app/v1/sales/bill']);
  assert.equal(log.at(-1).token, 'A2');
  refreshOk = false;
  await billing.sendInvoice(input);                      // A2 만료 → refresh 실패 → 재로그인(A3) → 재시도
  assert.deepEqual(log.slice(4).map((l) => l.path), ['/app/v1/sales/bill', '/app/v1/auth/refresh', '/app/v1/auth/login', '/app/v1/sales/bill']);
  assert.equal(log.at(-1).token, 'A3');
  await assert.rejects(() => CariPayBilling.login({ email: '', password: 'pw' }), CariPayError);
  // 갱신 수단이 없으면 -2 를 그대로 오류로 올린다(무한 재시도 없음)
  let calls = 0;
  const bare = new CariPayBilling({ accessToken: 'stale', fetch: async () => { calls++; return new Response(JSON.stringify({ result_code: -2 })); } });
  await assert.rejects(() => bare.sendInvoice(input), (e) => e instanceof CariPayError && String(e.code) === '-2');
  assert.equal(calls, 1);
}
console.log('Billing SDK checks passed: payload, tenant token, validation, idempotent retry, no redirect/retry, safe errors (mock only)');
