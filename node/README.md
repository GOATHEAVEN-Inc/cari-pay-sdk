# @caripay/sdk

CARI PAY 결제 게이트웨이 Node.js SDK. **의존성 0개**, Node 18+, TypeScript 타입 포함.

```bash
npm install github:GOATHEAVEN-Inc/cari-pay-sdk
```

```js
import { CariPay } from "@caripay/sdk";

const pay = CariPay.fromEnv();   // CARIPAY_PLATFORM_CODE / _STORE_CODE / _API_KEY / _MODE

const { transSeqno, redirectUrl } = await pay.createPayment({
  amount: 128000,                        // 금액은 반드시 서버에서 결정
  mobileNo: "01012345678",
  payerName: "홍길동",
  reason: "8월 수강료",
  confirmUrl: "https://api.example.com/caripay/callback",
});

const p = await pay.confirmCallback(transSeqno);   // 콜백/폴링 모두 이걸로 이중확인
if (p.paid) { /* 서비스 제공 — 멱등하게 1회만 */ }

await pay.cancelPayment({ transSeqno });           // 금액 생략 시 전액 취소
```

| 메서드 | 설명 |
|---|---|
| `createPayment(input)` | 결제 생성 → `redirectUrl` 발급 |
| `getPayment(transSeqno)` | 상태 조회 (`paid` / `canceled` / `amount` …) |
| `confirmCallback(bodyOrSeqno)` | 콜백 이중확인. 몇 번 불러도 같은 결과 |
| `waitForPayment(transSeqno, opts)` | 완료 대기 폴링 (기본 3초 간격) |
| `cancelPayment({transSeqno, amount?})` | 취소/환불 |
| `deleteBill({transSeqno, amount, mobileNo})` | 미결제 청구서 삭제 |
| `newTransSeqno(prefix)` | 유일 거래번호 채번 |

실패 시 `CariPayError`(`.code`에 게이트웨이 `RESULT_CODE`)를 던집니다.

전체 예제와 안전 수칙: [`../README.md`](../README.md) · 서버 예제 [`example-express.mjs`](example-express.mjs)
