export declare const BASE_URLS: { test: string; live: string };
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
  cancelPayment(o: { transSeqno: string; amount?: number | string; mobileNo?: string }): Promise<{ transSeqno: string; canceledAmount: number | null; raw: Record<string, unknown> }>;
  deleteBill(o: { transSeqno: string; amount: number | string; mobileNo: string }): Promise<{ transSeqno: string; raw: Record<string, unknown> }>;
  confirmCallback(input: string | { TRANS_SEQNO?: string; transSeqno?: string }): Promise<Payment>;
  waitForPayment(transSeqno: string, o?: { intervalMs?: number; timeoutMs?: number }): Promise<Payment>;
}

export default CariPay;
