// @caripay/sdk — CARI PAY 결제 게이트웨이 SDK
// 의존성 0개 (node:crypto + 내장 fetch). Node 18+
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const BASE_URLS = {
  test: "https://dev-api.chewingpay.com",
  live: "https://api.chewingpay.com",
};

export const BILLING_BASE_URLS = {
  // 청구 API는 현재 단일 환경이다(실제 발송·과금). test/live 모두 같은 주소를 가리킨다.
  test: "https://api.dev.caripay.co.kr",
  live: "https://api.dev.caripay.co.kr",
};

/** 청구서 발송 수단. ALIMTALK=카카오 알림톡, SMS=문자, ALIMTALK_THEN_SMS=알림톡 실패 시 문자 */
export const SEND_CHANNELS = ["ALIMTALK", "SMS", "ALIMTALK_THEN_SMS"];
const WEBHOOK_SECRET_RE = /^[\x21-\x7E]{16,128}$/;

/**
 * 청구서 웹훅 서명 검증. `signature` 는 요청 헤더 X-CariPay-Signature("t=<unix초>,v1=<hex>"),
 * `body` 는 받은 본문 원문(파싱 전 문자열 또는 Buffer). v1 = HMAC-SHA256(secret, `${t}.${body}`).
 * 서명이 맞고 t 가 toleranceSec(기본 5분) 안이면 true. 검증 뒤에도 확정은 getInvoice 로 한다.
 */
export function verifyWebhookSignature({ secret, signature, body, toleranceSec = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof secret !== "string" || !secret || typeof signature !== "string") return false;
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(signature.trim());
  if (!m) return false;
  const t = Number(m[1]);
  if (typeof toleranceSec !== "number" || Math.abs(now - t) > toleranceSec) return false;
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const expected = createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
  const given = Buffer.from(m[2], "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
const TOKEN_ERROR_CODES = new Set([-1, -2, "-1", "-2"]); // 토큰 없음 / 토큰 만료

function billingBaseUrl(mode, baseUrl) {
  let url;
  try { url = new URL(baseUrl || BILLING_BASE_URLS[mode]); } catch {
    throw new CariPayError("올바른 청구 API mode 또는 baseUrl이 필요합니다.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash) throw new CariPayError("청구 API는 HTTPS를 사용해야 합니다.");
  return url.href.replace(/\/+$/, "");
}

async function billingAuth({ baseUrl, timeoutMs, fetch: f }, path, body) {
  let res;
  try {
    res = await f(baseUrl + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new CariPayError("청구 API 인증 서버에 연결하지 못했습니다.");
  }
  let json;
  try { json = await res.json(); } catch { throw new CariPayError(`청구 API 인증 응답 형식 오류 (HTTP ${res.status})`); }
  const d = json?.result_data;
  if (!res.ok || ![0, "0"].includes(json?.result_code) || typeof d?.accessToken !== "string" || !d.accessToken) {
    throw new CariPayError(`청구 API 로그인 실패 (HTTP ${res.status})`, { code: json?.result_code });
  }
  return { accessToken: d.accessToken, refreshToken: typeof d.refreshToken === "string" ? d.refreshToken : undefined };
}

/** 청구서 생성 + 카리 알림톡 발송. 결제 링크 생성 API와 별개의 가맹점 인증을 사용한다. */
export class CariPayBilling {
  /**
   * @param {object} o
   * @param {string} o.accessToken    가맹점 접근 토큰 (x-access-token). 결제 서명 API_KEY와 다르다
   * @param {string} [o.refreshToken] 있으면 접근 토큰 만료 시 자동 갱신
   * @param {{email:string,password:string}} [o.credentials] login()으로 만들었을 때만. 갱신 실패 시 재로그인
   */
  constructor({ accessToken, refreshToken, credentials, mode = "test", baseUrl, timeoutMs = 10_000, fetch: f } = {}) {
    if (typeof accessToken !== "string" || !accessToken.trim() || /\s/.test(accessToken)) {
      throw new CariPayError("가맹점 청구 API accessToken이 필요합니다. 결제 서명 API_KEY와 다릅니다.");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CariPayError("timeoutMs는 양수여야 합니다.");
    this.baseUrl = billingBaseUrl(mode, baseUrl);
    this.accessToken = accessToken;
    this.refreshToken = typeof refreshToken === "string" && refreshToken.trim() ? refreshToken : undefined;
    this.credentials = credentials;
    this.timeoutMs = timeoutMs;
    this.fetch = f || globalThis.fetch;
  }

  static fromEnv(env = process.env) {
    return new CariPayBilling({ accessToken: env.CARIPAY_BILLING_ACCESS_TOKEN, refreshToken: env.CARIPAY_BILLING_REFRESH_TOKEN,
      mode: env.CARIPAY_MODE || "test", baseUrl: env.CARIPAY_BILLING_BASE_URL });
  }

  /**
   * 가맹점 계정(이메일·비밀번호)으로 로그인해 클라이언트를 만든다. 접근 토큰은 1시간, 리프레시 토큰은 30일이며
   * 만료되면 자동으로 갱신하고, 갱신도 실패하면 같은 계정으로 다시 로그인한다.
   * 비밀번호는 서버 시크릿에만 두고, 연동 전용 계정을 쓴다.
   */
  static async login({ email, password, mode = "test", baseUrl, timeoutMs = 10_000, fetch: f } = {}) {
    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
      throw new CariPayError("가맹점 계정 email/password 가 필요합니다.");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CariPayError("timeoutMs는 양수여야 합니다.");
    const credentials = { email: email.trim(), password };
    const ctx = { baseUrl: billingBaseUrl(mode, baseUrl), timeoutMs, fetch: f || globalThis.fetch };
    const tokens = await billingAuth(ctx, "/app/v1/auth/login", { ...credentials, loginType: "EMAIL" });
    return new CariPayBilling({ ...tokens, credentials, mode, baseUrl, timeoutMs, fetch: f });
  }

  /** 접근 토큰 갱신 → 실패 시 재로그인. 둘 다 불가능하면 false */
  async #renew() {
    if (this.refreshToken) {
      try {
        const t = await billingAuth(this, "/app/v1/auth/refresh", { refreshToken: this.refreshToken });
        this.accessToken = t.accessToken;
        if (t.refreshToken) this.refreshToken = t.refreshToken;
        return true;
      } catch { /* 리프레시 토큰도 만료 — 아래에서 재로그인 */ }
    }
    if (this.credentials) {
      const t = await billingAuth(this, "/app/v1/auth/login", { ...this.credentials, loginType: "EMAIL" });
      this.accessToken = t.accessToken;
      this.refreshToken = t.refreshToken;
      return true;
    }
    return false;
  }

  async #call(path, body, retried = false) {
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-access-token": this.accessToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Do not retry: the server may already have accepted a paid notification request.
      throw new CariPayError("청구 API 응답을 받지 못했습니다. 발송 요청은 같은 requestId와 내용으로만 재시도하세요.");
    }
    let json;
    try { json = await res.json(); } catch { throw new CariPayError(`청구 API 응답 형식 오류 (HTTP ${res.status})`); }
    if (!res.ok || ![0, "0"].includes(json?.result_code)) {
      // 토큰 없음/만료는 서버가 요청을 처리하기 전에 거절한 것이라 중복 접수 위험 없이 한 번 갱신 후 재시도한다.
      if (!retried && TOKEN_ERROR_CODES.has(json?.result_code) && (await this.#renew())) return this.#call(path, body, true);
      // Server error text can contain customer data. Return only the machine code/status.
      throw new CariPayError(`청구 API 요청 실패 (HTTP ${res.status})`, { code: json?.result_code });
    }
    return json.result_data;
  }

  /** 성공은 발송 접수이며 고객 도착/결제 완료가 아니다. requestId는 주문별로 저장해서 재사용한다. */
  async sendInvoice({ requestId, amount, recipient, reason, message = "", channel = "ALIMTALK", webhookUrl, webhookSecret } = {}) {
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      throw new CariPayError("requestId는 영숫자/_/- 8~64자여야 합니다.");
    }
    if (!SEND_CHANNELS.includes(channel)) throw new CariPayError(`channel은 ${SEND_CHANNELS.join(" | ")} 중 하나여야 합니다: ${channel}`);
    // 결제 완료·취소 웹훅. HTTPS 만. webhookSecret 을 주면 전송마다 X-CariPay-Signature 가 붙는다(verifyWebhookSignature 로 검증).
    if (webhookUrl !== undefined && webhookUrl !== null) {
      let u;
      try { u = new URL(String(webhookUrl)); } catch { throw new CariPayError("webhookUrl은 유효한 URL이어야 합니다."); }
      if (u.protocol !== "https:" || /\s/.test(String(webhookUrl)) || String(webhookUrl).length > 500) throw new CariPayError("webhookUrl은 500자 이하의 https:// 주소여야 합니다.");
    }
    if (webhookSecret !== undefined && webhookSecret !== null) {
      if (!webhookUrl) throw new CariPayError("webhookSecret은 webhookUrl과 함께 써야 합니다.");
      if (typeof webhookSecret !== "string" || !WEBHOOK_SECRET_RE.test(webhookSecret)) throw new CariPayError("webhookSecret은 공백 없는 ASCII 16~128자여야 합니다.");
    }
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 2147483647) {
      throw new CariPayError("청구 금액은 100~2147483647원 사이의 정수여야 합니다.");
    }
    const text = (value, max, name, optional = false) => {
      if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max || /[\r\n]/.test(value)) {
        throw new CariPayError(`${name} 형식이 올바르지 않습니다 (한 줄, 최대 ${max}자).`);
      }
      return value.trim();
    };
    const name = text(recipient?.name, 30, "수신자 이름");
    const phone = typeof recipient?.phone === "string" ? recipient.phone.replace(/[ -]/g, "") : "";
    if (!/^\d{10,11}$/.test(phone)) throw new CariPayError("수신자 전화번호는 숫자 10~11자리여야 합니다.");
    const body = { templateType: "SAME", billTemplateId: null, requestId, amount, sendChannel: channel,
      ...(webhookUrl ? { webhookUrl: String(webhookUrl) } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      reason: text(reason, 60, "청구 사유"), description: text(message, 200, "안내문", true),
      members: [{ studentName: name, studentPhone: phone, guardianPhone: null, studentBirthDate: null, classroomId: null }],
      items: null, relatedSubject: null, etc: null };
    await this.#call("/app/v1/sales/bill", body);
    return { accepted: true, requestId };
  }

  async listInvoices({ page = 1, size = 10, month } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 100) {
      throw new CariPayError("page는 1 이상, size는 1~100 사이의 정수여야 합니다.");
    }
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new CariPayError("month는 yyyy-MM 형식이어야 합니다.");
    const query = new URLSearchParams({ page: String(page), size: String(size), ...(month === undefined ? {} : { month }) });
    return this.#call(`/app/v1/sales/bill?${query}`);
  }

  async getInvoice(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new CariPayError("유효한 청구서 ID가 필요합니다.");
    return this.#call(`/app/v1/sales/bill/${encodeURIComponent(id)}`);
  }
}

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

function checkCallbackUrl(confirmUrl) {
  const value = String(req(confirmUrl, "confirmUrl"));
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CariPayError("confirmUrl은 유효한 URL이어야 합니다.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CariPayError("confirmUrl은 HTTPS여야 합니다. 로컬 개발에서는 localhost HTTP만 허용됩니다.");
  }
  return value;
}

function checkReturnUrl(returnUrl) {
  const value = String(returnUrl);
  let url;
  try { url = new URL(value); } catch { throw new CariPayError("returnUrl은 유효한 URL이어야 합니다."); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new CariPayError("returnUrl은 HTTPS여야 합니다.");
  if (value.length > 100) throw new CariPayError("returnUrl은 100자 이하여야 합니다. 주문 식별은 tempValue를 쓰세요.");
  return value;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
    returnUrl,
    tempValue,
    userId,
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
      CONFIRM_URL: checkCallbackUrl(confirmUrl),
      orderType,
      // 결제 완료 후 결제 페이지가 고객 브라우저를 돌려보낼 곳(≤100자). 승인 판정은 여기가 아니라 조회 API로 한다.
      ...(returnUrl ? { RETURN_DISPLAY_YN: "Y", RETURN_URL: checkReturnUrl(returnUrl) } : {}),
      // 콜백·리턴에 그대로 돌아오는 임의값(주문 ID 등)
      ...(tempValue !== undefined && tempValue !== null ? { TEMP_VALUE: String(tempValue) } : {}),
      ...(userId !== undefined && userId !== null ? { USER_ID: String(userId) } : {}),
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
      amount: numberOrNull(d.APPROVAL_AMOUNT),
      cancelAmount: numberOrNull(d.CANCEL_AMOUNT),
      approvedAt: d.APPROVAL_DATETIME ?? null,
      approvalNumber: d.APPROVAL_NUMBER ?? null,
      methodName: d.METHOD_NAME ?? null,
      issuerName: d.ISSUER_NAME ?? null,
      cancelReason: d.CANCEL_REASON ?? null,
      raw: d,
    };
  }

  /**
   * 결제 취소(환불). 게이트웨이는 **승인금액 전액 취소만** 받는다 — amount 를 넘기면 승인금액과 같아야 하고,
   * 생략하면 조회로 승인금액을 채운다. 부분 환불은 전액 취소 후 새 결제로 처리한다.
   */
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
    return { transSeqno: seq, canceledAmount: numberOrNull(d.APPROVAL_AMOUNT), raw: d };
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
