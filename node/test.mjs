// 셀프체크: node test.mjs  (네트워크 없이 fetch를 가짜로 주입해 전 구간 검증)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CariPay, CariPayError, sign, nowKst14, newTransSeqno } from "./index.js";

const KEY = "secret-key";
const cfg = { platformCode: "PC0001", storeCode: "SD0001", apiKey: KEY, mode: "test" };

// 1. 서명 = 5개 값 무구분자 연결 후 sha256 소문자 hex
{
  const s = sign({ transSeqno: "T1", platformCode: "PC0001", storeCode: "SD0001", transAt: "20260819120000", apiKey: KEY });
  assert.equal(s, createHash("sha256").update("T1PC0001SD000120260819120000" + KEY).digest("hex"));
  assert.match(s, /^[0-9a-f]{64}$/);
}

// 2. TRANS_AT은 KST 14자리
{
  assert.equal(nowKst14(new Date("2026-08-19T00:00:00Z")), "20260819090000");
  assert.match(newTransSeqno("svc"), /^svc\d{18}$/);
  assert.throws(() => newTransSeqno("bad prefix!"), CariPayError);
}

// 3. 결제 생성: 바디 필드·서명이 규격대로 실리는가
{
  let sent;
  const pay = new CariPay({ ...cfg, fetch: async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ result_code: 0, result_msg: "성공", result_data: { RESULT_CODE: "0000", REDIRECT_URL: "https://pay/x" } }));
  }});
  const r = await pay.createPayment({
    transSeqno: "svc001", amount: 12000, mobileNo: "010-1234-5678",
    payerName: "홍길동", reason: "8월 수강료", confirmUrl: "https://me/cb",
  });
  assert.equal(r.redirectUrl, "https://pay/x");
  assert.equal(sent.url, "https://dev-api.chewingpay.com/api/requestPayment");
  assert.equal(sent.body.APPROVAL_AMOUNT, "12000");        // 문자열 금액
  assert.equal(sent.body.MOBILE_NO, "01012345678");        // 하이픈 제거
  assert.equal(sent.body.orderType, "BILL");
  assert.equal(sent.body.API_SIGN, sign({ transSeqno: "svc001", platformCode: "PC0001", storeCode: "SD0001", transAt: sent.body.TRANS_AT, apiKey: KEY }));
  assert.match(sent.body.TRANS_AT, /^\d{14}$/);
}

// 4. 입력 검증 — 잘못된 금액/전화번호는 호출 전에 막는다
{
  const pay = new CariPay({ ...cfg, fetch: async () => assert.fail("호출되면 안 됨") });
  const base = { mobileNo: "01012345678", payerName: "홍", reason: "r", confirmUrl: "https://c" };
  await assert.rejects(() => pay.createPayment({ ...base, amount: 0 }), CariPayError);
  await assert.rejects(() => pay.createPayment({ ...base, amount: -1 }), CariPayError);
  await assert.rejects(() => pay.createPayment({ ...base, amount: 1000, mobileNo: "123" }), CariPayError);
  await assert.rejects(() => pay.createPayment({ ...base, amount: 1000, confirmUrl: "" }), CariPayError);
  await assert.rejects(() => pay.createPayment({ ...base, amount: 1000, orderType: "X" }), CariPayError);
}

// 5. 실패 응답은 RESULT_CODE 기준으로 던진다 (최상위 result_code는 0/"0" 흔들림 무시)
{
  const pay = new CariPay({ ...cfg, fetch: async () =>
    new Response(JSON.stringify({ result_code: "0", result_data: { RESULT_CODE: "5001", RESULT_MSG: "청구서 없음" } })) });
  await assert.rejects(() => pay.getPayment("svc001"), (e) => e instanceof CariPayError && e.code === "5001");
}

// 6. 조회 정규화 + 콜백 이중확인
{
  const pay = new CariPay({ ...cfg, fetch: async () => new Response(JSON.stringify({
    result_code: 0, result_data: {
      RESULT_CODE: "0000", TRANS_SEQNO: "svc001", APPROVE_STATUS: "APPROVE_COMPLETE",
      APPROVAL_AMOUNT: 12000, APPROVAL_NUMBER: "30001234", METHOD_NAME: "신용카드", MOBILE_NO: "01012345678",
    },
  })) });
  const p = await pay.getPayment("svc001");
  assert.equal(p.paid, true);
  assert.equal(p.canceled, false);
  assert.equal(p.amount, 12000);
  // 콜백 본문으로도, 거래번호 문자열로도 동일 결과 (멱등)
  assert.deepEqual(await pay.confirmCallback({ TRANS_SEQNO: "svc001" }), p);
  assert.deepEqual(await pay.confirmCallback("svc001"), p);
}

// 7. 취소: 금액/번호 생략 시 조회로 채워 전액 취소
{
  const calls = [];
  const pay = new CariPay({ ...cfg, fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return new Response(JSON.stringify(url.endsWith("searchPayment")
      ? { result_data: { RESULT_CODE: "0000", APPROVE_STATUS: "APPROVE_COMPLETE", APPROVAL_AMOUNT: 12000, MOBILE_NO: "01012345678" } }
      : { result_data: { RESULT_CODE: "0000", APPROVAL_AMOUNT: 12000 } }));
  }});
  const r = await pay.cancelPayment({ transSeqno: "svc001" });
  assert.equal(r.canceledAmount, 12000);
  assert.equal(calls.at(-1).url, "https://dev-api.chewingpay.com/api/requestPaymentCancel");
  assert.equal(calls.at(-1).body.REQUEST_TYPE, "CANCEL");
  assert.equal(calls.at(-1).body.APPROVAL_AMOUNT, "12000");
}

// 8. 폴링: 미승인이면 계속 보다가 승인되면 즉시 반환
{
  let n = 0;
  const pay = new CariPay({ ...cfg, fetch: async () => new Response(JSON.stringify({
    result_data: { RESULT_CODE: "0000", APPROVE_STATUS: ++n < 3 ? "STORE_REQUEST" : "APPROVE_COMPLETE" },
  })) });
  const p = await pay.waitForPayment("svc001", { intervalMs: 1, timeoutMs: 1000 });
  assert.equal(p.paid, true);
  assert.equal(n, 3);
}

// 9. live 모드 주소
assert.equal(new CariPay({ ...cfg, mode: "live" }).baseUrl, "https://api.chewingpay.com");
assert.throws(() => new CariPay({ ...cfg, mode: "prod" }), CariPayError);
assert.throws(() => new CariPay({ platformCode: "PC", storeCode: "SD" }), CariPayError);

console.log("✅ 전부 통과");
