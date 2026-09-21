export declare const BASE_URLS: { test: string; live: string };
export declare const BILLING_BASE_URLS: { test: string; live: string };
/** 청구서 발송 수단. ALIMTALK=카카오 알림톡, SMS=문자, ALIMTALK_THEN_SMS=알림톡 실패 시 문자 */
export declare const SEND_CHANNELS: readonly ["ALIMTALK", "SMS", "ALIMTALK_THEN_SMS"];
export type SendChannel = (typeof SEND_CHANNELS)[number];
export interface SendInvoiceInput {
  /** 주문별로 저장. 응답이 유실되어도 같은 내용에는 같은 ID를 사용. */
  requestId: string;
  amount: number;
  recipient: { name: string; phone: string };
  reason: string;
  message?: string;
  /** 기본 ALIMTALK */
  channel?: SendChannel;
  /** 결제 완료·취소 시 POST 받을 https 주소(≤500자). 수신 후 getInvoice 로 확정. */
  webhookUrl?: string;
  /** 웹훅 서명 비밀(공백 없는 ASCII 16~128자). 있으면 X-CariPay-Signature 헤더가 붙는다. verifyWebhookSignature 로 검증 */
  webhookSecret?: string;
}

/** X-CariPay-Signature("t=<unix초>,v1=<hex>") 검증. body 는 파싱 전 본문 원문. 기본 허용 오차 300초 */
export declare function verifyWebhookSignature(o: {
  secret: string;
  signature: string | undefined | null;
  body: string | Uint8Array;
  toleranceSec?: number;
  /** 테스트용 현재 시각(unix초) */
  now?: number;
}): boolean;

/** webhookUrl 로 POST 되는 본문. 헤더 X-CariPay-Event: bill.paid | bill.canceled, X-CariPay-Delivery, (webhookSecret 지정 시) X-CariPay-Signature */
export interface InvoiceWebhookPayload {
  event: "bill.paid" | "bill.canceled";
  billId: string;
  requestId: string | null;
  transSeqNo: string | null;
  status: "PENDING" | "DONE" | "CANCELED" | null;
  amount: number;
  reason: string | null;
  paidAt: string | null;
  canceledAt: string | null;
  occurredAt: string;
}
export declare class CariPayBilling {
  constructor(o: {
    accessToken: string;
    /** 있으면 접근 토큰 만료 시 자동 갱신 */
    refreshToken?: string;
    /** login()이 채움. 갱신 실패 시 재로그인에 사용 */
    credentials?: { email: string; password: string };
    mode?: "test" | "live"; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch;
  });
  static fromEnv(env?: Record<string, string | undefined>): CariPayBilling;
  /** 가맹점 계정으로 로그인. 접근 토큰(1시간) 만료 시 자동 갱신·재로그인. */
  static login(o: { email: string; password: string; mode?: "test" | "live"; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch }): Promise<CariPayBilling>;
  accessToken: string;
  refreshToken?: string;
  /** 접수 결과. 고객 도착 또는 결제 성공을 의미하지 않습니다. */
  sendInvoice(input: SendInvoiceInput): Promise<{ accepted: true; requestId: string }>;
  listInvoices(options?: { page?: number; size?: number; month?: string }): Promise<Record<string, unknown>>;
  getInvoice(id: string): Promise<Record<string, unknown>>;
}
export declare const APPROVED: "APPROVE_COMPLETE";

export type ApproveStatus =
  | "STORE_REQUEST" | "APPROVE_COMPLETE" | "APPROVE_FAIL"
  | "CANCEL_COMPLETE" | "CANCEL_FAIL" | "STORE_DELETE";

export declare class CariPayError extends Error {
  code?: string;
  transSeqno?: string;
  response?: unknown;
}

export declare function nowKst14(date?: Date): string;
export declare function newTransSeqno(prefix?: string): string;
export declare function sign(o: {
  transSeqno: string; platformCode: string; storeCode: string; transAt: string; apiKey: string;
}): string;

export interface PaymentItem {
  name: string;
  unitPrice: number;
  qty?: number;
  discountAmount?: number;
  taxType?: string;
  publisher?: string;
  imageUrl?: string;
}

export interface CreatePaymentInput {
  /** 미지정 시 자동 채번 */
  transSeqno?: string;
  amount: number | string;
  mobileNo: string;
  payerName: string;
  reason: string;
  confirmUrl: string;
  infoMessage?: string;
  orderType?: "BILL" | "SHOP";
  items?: PaymentItem[];
  /** 결제 완료 후 고객 브라우저를 돌려보낼 곳(HTTPS, ≤100자). 승인 판정은 조회 API로. */
  returnUrl?: string;
  /** 콜백·리턴에 그대로 돌아오는 임의값(주문 ID 등) */
  tempValue?: string | number;
  userId?: string | number;
}

export interface Payment {
  transSeqno: string;
  status: ApproveStatus | null;
  paid: boolean;
  canceled: boolean;
  amount: number | null;
  cancelAmount: number | null;
  approvedAt: string | null;
  approvalNumber: string | null;
  methodName: string | null;
  issuerName: string | null;
  cancelReason: string | null;
  raw: Record<string, unknown>;
}

export declare class CariPay {
  constructor(o: {
    platformCode: string;
    storeCode: string;
    apiKey: string;
    mode?: "test" | "live";
    baseUrl?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
  });
  static fromEnv(env?: Record<string, string | undefined>): CariPay;
  createPayment(input: CreatePaymentInput): Promise<{ transSeqno: string; redirectUrl: string; raw: Record<string, unknown> }>;
  getPayment(transSeqno: string): Promise<Payment>;
  /** 승인금액 전액 취소만 가능. amount 를 넘기면 승인금액과 같아야 한다. */
  cancelPayment(o: { transSeqno: string; amount?: number | string; mobileNo?: string }): Promise<{ transSeqno: string; canceledAmount: number | null; raw: Record<string, unknown> }>;
  deleteBill(o: { transSeqno: string; amount: number | string; mobileNo: string }): Promise<{ transSeqno: string; raw: Record<string, unknown> }>;
  confirmCallback(input: string | { TRANS_SEQNO?: string; transSeqno?: string }): Promise<Payment>;
  waitForPayment(transSeqno: string, o?: { intervalMs?: number; timeoutMs?: number }): Promise<Payment>;
}

export default CariPay;
