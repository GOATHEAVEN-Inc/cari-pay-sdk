// @caripay/sdk — CARI PAY 결제 게이트웨이 SDK
// 의존성 0개 (node:crypto + 내장 fetch). Node 18+
import { createHash, randomInt } from "node:crypto";

export const BASE_URLS = {
  test: "https://dev-api.chewingpay.com",
  live: "https://api.chewingpay.com",
};

const PATHS = {
  create: "/api/requestPayment",
  search: "/api/searchPayment",
  cancel: "/api/requestPaymentCancel",
};

/** 승인완료 상태값. 그 외는 미승인으로 취급한다. */
export const APPROVED = "APPROVE_COMPLETE";
const CANCELED = new Set(["CANCEL_COMPLETE", "STORE_DELETE"]);

export class CariPayError extends Error {
  constructor(message, { code, transSeqno, response } = {}) {
    super(message);
    this.name = "CariPayError";
    this.code = code;
    this.transSeqno = transSeqno;
    this.response = response;
  }
}

/** KST 기준 yyyyMMddHHmmss (14자리) */
export function nowKst14(date = new Date()) {
  const d = new Date(date.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** 거래번호 채번: 접두어 + KST14 + 난수 4자리 (전 시스템 유일해야 함) */
export function newTransSeqno(prefix = "cp") {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(prefix)) {
    throw new CariPayError("prefix는 영숫자/_/- 1~16자여야 합니다.");
  }
  return `${prefix}${nowKst14()}${String(randomInt(0, 10000)).padStart(4, "0")}`;
}

/** API_SIGN = sha256(TRANS_SEQNO + PLATFORM_CODE + STORE_CODE + TRANS_AT + API_KEY) */
export function sign({ transSeqno, platformCode, storeCode, transAt, apiKey }) {
  return createHash("sha256")
    .update(transSeqno + platformCode + storeCode + transAt + apiKey, "utf8")
    .digest("hex");
}

const req = (v, name) => {
  if (v === undefined || v === null || v === "") {
    throw new CariPayError(`${name}은(는) 필수입니다.`);
  }
  return v;
};

function checkAmount(amount) {
  const s = String(req(amount, "amount"));
  if (!/^\d{1,12}$/.test(s) || s === "0") {
    throw new CariPayError(`amount는 1~12자리 양의 정수여야 합니다: ${amount}`);
  }
  return s;
}

function checkMobile(mobileNo) {
  const s = String(req(mobileNo, "mobileNo")).replace(/\D/g, "");
  if (!/^\d{10,11}$/.test(s)) {
    throw new CariPayError(`mobileNo는 숫자 10~11자리여야 합니다: ${mobileNo}`);
  }
  return s;
}

function checkTransSeqno(transSeqno) {
  const s = String(req(transSeqno, "transSeqno"));
  if (s.length > 64) throw new CariPayError("transSeqno는 64자 이하여야 합니다.");
  return s;
}

export class CariPay {
  /**
   * @param {object} o
   * @param {string} o.platformCode  발급받은 PLATFORM_CODE
   * @param {string} o.storeCode     발급받은 STORE_CODE (정산 가맹점)
   * @param {string} o.apiKey        서명 시크릿 — 서버 환경변수/시크릿매니저에만 보관
   * @param {"test"|"live"} [o.mode] 기본 "test"
   * @param {string} [o.baseUrl]     mode 대신 직접 지정
   * @param {number} [o.timeoutMs]   기본 10000
   */
  constructor({ platformCode, storeCode, apiKey, mode = "test", baseUrl, timeoutMs = 10_000, fetch: f } = {}) {
    this.platformCode = req(platformCode, "platformCode");
    this.storeCode = req(storeCode, "storeCode");
    this.apiKey = req(apiKey, "apiKey");
    this.baseUrl = (baseUrl || BASE_URLS[mode] || "").replace(/\/+$/, "");
    if (!this.baseUrl) throw new CariPayError(`알 수 없는 mode: ${mode} (test | live)`);
    this.timeoutMs = timeoutMs;
    this.fetch = f || globalThis.fetch;
  }

  /** 환경변수(CARIPAY_*)로 생성 */
  static fromEnv(env = process.env) {
    return new CariPay({
      platformCode: env.CARIPAY_PLATFORM_CODE,
      storeCode: env.CARIPAY_STORE_CODE,
      apiKey: env.CARIPAY_API_KEY,
      mode: env.CARIPAY_MODE || "test",
      baseUrl: env.CARIPAY_BASE_URL,
    });
  }

  async #call(path, transSeqno, extra) {
    const transAt = nowKst14();
    const body = {
      TRANS_SEQNO: transSeqno,
      PLATFORM_CODE: this.platformCode,
      STORE_CODE: this.storeCode,
      TRANS_AT: transAt,
      ...extra,
      API_SIGN: sign({
        transSeqno,
        platformCode: this.platformCode,
        storeCode: this.storeCode,
        transAt,
        apiKey: this.apiKey,
      }),
    };

    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new CariPayError(`게이트웨이 호출 실패: ${e.message}`, { transSeqno });
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CariPayError(`응답 파싱 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`, { transSeqno });
    }

    // 성공 판정은 result_data.RESULT_CODE === "0000" 하나로만 한다.
    // (최상위 result_code는 게이트웨이 버전에 따라 0 / "0" 으로 흔들림)
    const d = json?.result_data;
    if (!d) {
      throw new CariPayError(`result_data 없음: ${json?.result_msg ?? text.slice(0, 200)}`, { transSeqno, response: json });
    }
    if (d.RESULT_CODE !== "0000") {
      throw new CariPayError(`${d.RESULT_MSG || "요청 실패"} (${d.RESULT_CODE})`, {
        code: d.RESULT_CODE,
        transSeqno,
        response: json,
      });
    }
    return d;
  }

  /**
   * 결제 생성 → 고객에게 보낼 결제 페이지 링크 발급
   * 금액은 반드시 서버 카탈로그 기준으로 결정해 넘길 것.
   * @returns {Promise<{transSeqno:string, redirectUrl:string, raw:object}>}
   */
  async createPayment({
    transSeqno = newTransSeqno(),
    amount,
    mobileNo,
    payerName,
    reason,
    confirmUrl,
    infoMessage = "",
    orderType = "BILL",
    items,
  } = {}) {
    const seq = checkTransSeqno(transSeqno);
    if (orderType !== "BILL" && orderType !== "SHOP") {
      throw new CariPayError(`orderType은 BILL | SHOP 이어야 합니다: ${orderType}`);
    }
    const d = await this.#call(PATHS.create, seq, {
      APPROVAL_AMOUNT: checkAmount(amount),
      MOBILE_NO: checkMobile(mobileNo),
      PAY_USER_NAME: req(payerName, "payerName"),
      REQUEST_REASON: req(reason, "reason"),
      INFO_MESSAGE: infoMessage,
      CONFIRM_URL: req(confirmUrl, "confirmUrl"),
      orderType,
      ...(items ? { ITEMS: items } : {}),
    });
    if (!d.REDIRECT_URL) {
      throw new CariPayError("REDIRECT_URL이 없습니다.", { transSeqno: seq, response: d });
    }
    return { transSeqno: seq, redirectUrl: d.REDIRECT_URL, raw: d };
  }

  /** 결제 상태 조회 (승인 확인의 유일한 근거) */
  async getPayment(transSeqno) {
    const d = await this.#call(PATHS.search, checkTransSeqno(transSeqno));
    return {
      transSeqno: d.TRANS_SEQNO ?? transSeqno,
      status: d.APPROVE_STATUS ?? null,
      paid: d.APPROVE_STATUS === APPROVED,
      canceled: CANCELED.has(d.APPROVE_STATUS),
      amount: d.APPROVAL_AMOUNT ?? null,
      cancelAmount: d.CANCEL_AMOUNT ?? null,
      approvedAt: d.APPROVAL_DATETIME ?? null,
      approvalNumber: d.APPROVAL_NUMBER ?? null,
      methodName: d.METHOD_NAME ?? null,
      issuerName: d.ISSUER_NAME ?? null,
      cancelReason: d.CANCEL_REASON ?? null,
      raw: d,
    };
  }

  /** 결제 취소(환불). amount 미지정 시 승인금액 전액 */
  async cancelPayment({ transSeqno, amount, mobileNo }) {
    const seq = checkTransSeqno(transSeqno);
    let amt = amount;
    let phone = mobileNo;
    if (amt === undefined || phone === undefined) {
      const p = await this.getPayment(seq);
      amt = amt ?? p.amount;
      phone = phone ?? p.raw.MOBILE_NO;
    }
    const d = await this.#call(PATHS.cancel, seq, {
      REQUEST_TYPE: "CANCEL",
      APPROVAL_AMOUNT: checkAmount(amt),
      MOBILE_NO: checkMobile(phone),
    });
    return { transSeqno: seq, canceledAmount: d.APPROVAL_AMOUNT ?? null, raw: d };
  }

  /** 미결제 청구서 삭제 (승인건 환불은 cancelPayment) */
  async deleteBill({ transSeqno, amount, mobileNo }) {
    const seq = checkTransSeqno(transSeqno);
    const d = await this.#call(PATHS.cancel, seq, {
      REQUEST_TYPE: "DELETE",
      APPROVAL_AMOUNT: checkAmount(amount),
      MOBILE_NO: checkMobile(mobileNo),
    });
    return { transSeqno: seq, raw: d };
  }

  /**
   * CONFIRM_URL 콜백 처리용. 콜백 본문을 믿지 말고 조회로 이중확인한다.
   * 중복 콜백이 와도 결과가 같으므로 멱등 처리에 그대로 쓸 수 있다.
   * @param {string|object} input 거래번호, 또는 TRANS_SEQNO를 담은 콜백 본문
   */
  async confirmCallback(input) {
    const seq = typeof input === "string" ? input : input?.TRANS_SEQNO ?? input?.transSeqno;
    return this.getPayment(checkTransSeqno(seq));
  }

  /** 완료 대기 폴링 (UX 패턴 B: 결제 링크 문자 발송 후 대기 화면) */
  async waitForPayment(transSeqno, { intervalMs = 3000, timeoutMs = 600_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await this.getPayment(transSeqno);
      if (p.paid || p.canceled) return p;
      if (Date.now() + intervalMs >= deadline) return p;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export default CariPay;
