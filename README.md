# CARI PAY SDK

카리페이 결제를 **10줄로** 붙이기 위한 공식 SDK와 API 규격입니다.
외부 업체·개인 개발자가 자기 서비스에 그대로 가져다 쓰는 것을 전제로 만들었습니다.

```
cari-pay-sdk/
├── openapi.yaml            # API 정식 규격 (Swagger UI·클라이언트 생성기용)
├── billing-openapi.yaml    # 청구서 생성·알림톡 발송 규격 (가맹점 토큰)
├── node/                   # JavaScript / TypeScript SDK  (의존성 0개, Node 18+)
└── python/                 # Python SDK                    (표준 라이브러리만, 3.9+)
```

지원 언어에 없다면 `openapi.yaml`로 클라이언트를 생성하거나(아래 참고), 아래 curl 규격 그대로 직접 호출하면 됩니다.

> 전체 가이드·API 레퍼런스는 개발자 문서 사이트에 있습니다: **https://caripay.co.kr/docs**

## 카리 플친으로 청구서 보내기 (v1.3)

온라인 주문, 예약금, 방문 서비스, 매장 외상 등 **아직 납부하지 않은 금액**을 안내할 때 사용합니다.
상품별 알리고 템플릿 등록 없이, 카리(CARI) 채널의 승인된 범용 청구서 `UK_8980`에 고객명·청구 사유·금액을 넣습니다.
알리고 계정·발신 프로필·템플릿 코드는 연동 업체가 직접 전달하지 않습니다.

| 필요한 기능 | 호출 | 인증 |
|---|---|---|
| 결제 링크만 만들기 | `CariPay.createPayment()` | 결제 플랫폼·매장 코드와 서명키 |
| 청구서를 만들고 카리 알림톡으로 보내기 | `CariPayBilling.sendInvoice()` | 해당 가맹점의 청구 API 접근 토큰 |
| 접수 후 발송/납부 내역 확인 | `listInvoices()` → `getInvoice(id)` | 같은 가맹점 토큰 |

**두 생성 함수를 같은 주문에 모두 호출하지 마세요.** 청구서 API가 결제 링크도 생성합니다.
`createPayment()`의 기존 동작은 그대로이며, 이를 호출한다고 메시지가 자동 발송되지는 않습니다.
단말기에서 이미 결제된 거래에는 이 청구 API를 호출하지 않습니다. 이 양식은 결제 완료 영수증이 아닙니다.

### 업체별 준비

1. 카리페이에 가맹점·결제 가맹 코드 등록과 청구 기능 승인을 완료합니다.
2. 연동 전용 가맹점 계정(이메일·비밀번호)을 만들고 서버 시크릿에만 둡니다. `CariPayBilling.login()`이 로그인하고
   접근 토큰(1시간)이 만료되면 자동으로 갱신·재로그인합니다. 기존 `API_KEY`를 대신 넣으면 안 됩니다.
3. 발송 포인트 잔액과 수신자 연락처를 확인합니다. 다른 업체의 토큰을 공유해서 사용하지 않습니다.
4. 발송 수단을 정합니다 — `ALIMTALK`(카카오 알림톡, 기본) · `SMS`(문자) · `ALIMTALK_THEN_SMS`(알림톡 실패·수신 불가 시 문자).

청구 API는 현재 **단일 환경**(`https://api.dev.caripay.co.kr`)입니다. `CARIPAY_MODE`와 관계없이 호출하면 실제 결제 링크가
만들어지고 실제 알림톡·문자가 나가며 포인트가 차감됩니다. 발송 없는 검증은 `npm test`의 모의 테스트를 사용하고,
실제 호출 검증에는 동의한 테스트 수신자(본인 번호)만 사용하세요.

```js
import { CariPayBilling } from "@caripay/sdk";

// 연동 전용 가맹점 계정으로 로그인. 토큰 만료 시 자동 갱신·재로그인.
// (토큰을 직접 관리하려면 CARIPAY_BILLING_ACCESS_TOKEN 을 두고 CariPayBilling.fromEnv())
const billing = await CariPayBilling.login({
  email: process.env.CARIPAY_BILLING_EMAIL,
  password: process.env.CARIPAY_BILLING_PASSWORD,
});
const result = await billing.sendInvoice({
  requestId: "order_20260908_001", // 주문 DB에 저장. 같은 요청 재시도는 같은 ID 사용
  amount: 128000,
  recipient: { name: "고객명", phone: process.env.CUSTOMER_PHONE },
  reason: "방문 수리비",
  message: "청구 내역을 확인해 주세요.",
  channel: "ALIMTALK_THEN_SMS",     // ALIMTALK | SMS | ALIMTALK_THEN_SMS
  webhookUrl: "https://api.example.com/caripay/invoice-hook", // 선택: 결제 완료·취소 알림(POST). 수신 후 getInvoice 로 확인
  webhookSecret: process.env.CARIPAY_WEBHOOK_SECRET,          // 선택: 있으면 X-CariPay-Signature 로 서명 (ASCII 16~128자)
});
// { accepted: true, requestId: "order_20260908_001" } = 접수. 도착/결제 완료 아님.
const list = await billing.listInvoices({ month: "2026-09", page: 1, size: 10 });
// 목록에서 얻은 청구서 id로 billing.getInvoice(id): 발송 이력과 납부 상태 확인
```

```python
import os
from caripay import CariPayBilling

billing = CariPayBilling.login(email=os.environ["CARIPAY_BILLING_EMAIL"], password=os.environ["CARIPAY_BILLING_PASSWORD"])
result = billing.send_invoice(
    request_id="order_20260908_001",
    amount=128000,
    recipient={"name": "고객명", "phone": os.environ["CUSTOMER_PHONE"]},
    reason="예약금",
    message="예약 내용을 확인해 주세요.",
    channel="ALIMTALK_THEN_SMS",   # ALIMTALK | SMS | ALIMTALK_THEN_SMS
    webhook_url="https://api.example.com/caripay/invoice-hook",  # 선택: 결제 완료·취소 알림(POST)
    webhook_secret=os.environ.get("CARIPAY_WEBHOOK_SECRET"),      # 선택: 있으면 X-CariPay-Signature 로 서명
)
```

웹훅 수신 서버에서는 **파싱 전 본문 원문**과 `X-CariPay-Signature` 헤더로 서명을 검증합니다(허용 오차 5분).

```js
import { verifyWebhookSignature } from "@caripay/sdk";
app.post("/caripay/invoice-hook", express.raw({ type: "application/json" }), (req, res) => {
  if (!verifyWebhookSignature({ secret: process.env.CARIPAY_WEBHOOK_SECRET, signature: req.get("X-CariPay-Signature"), body: req.body })) {
    return res.sendStatus(400);
  }
  res.sendStatus(200);
  // 이후 getInvoice(billId) 로 상태를 확정
});
```

```python
from caripay import verify_webhook_signature
ok = verify_webhook_signature(os.environ["CARIPAY_WEBHOOK_SECRET"], request.headers.get("X-CariPay-Signature"), request.get_data())
```

`requestId`/`request_id`는 가맹점·주문별로 보관하세요. 같은 ID와 같은 요청은 서버가 중복 처리를 막고,
같은 ID에 다른 내용을 보내면 거부합니다. 통신 오류가 나도 새로운 ID로 다시 보내지 마세요.
SDK는 발송 요청을 자동 재시도하지 않습니다. 접수 후 결과는 청구 내역에서 확인합니다.

수신자 이름은 30자, 청구 사유는 60자, 안내문은 200자 이내의 한 줄입니다. 광고·판촉 문구는 넣지 않습니다.
청구 금액은 정수 100원 이상입니다. 사업자명은 입력값이 아닌 등록된 가맹점 정보에서 가져옵니다.
범용 템플릿을 사용할 수 없는 경우 운영 서버의 기존 대체 발송 정책이 적용될 수 있습니다.

직접 HTTP 연동: [청구 API 규격](billing-openapi.yaml). 결제 서명 API 규격과 인증 방식이 다릅니다.
이 API는 비동기 발송이며 응답에는 결제 링크나 청구서 ID가 포함되지 않습니다. 결과를 결제 성공으로 처리하지 마세요.

---

## 0. 먼저 받을 것 4가지

카리페이 도입 신청( https://caripay.co.kr/start ) 후 발급받습니다. **테스트/운영 키가 다릅니다.**

| 항목 | 설명 |
|---|---|
| `BASE_URL` | 테스트 `https://dev-api.chewingpay.com` · 운영 `https://api.chewingpay.com` |
| `PLATFORM_CODE` | 서비스 식별 코드 |
| `STORE_CODE` | 정산 가맹점 코드 |
| `API_KEY` | **서명 시크릿.** 서버 환경변수·시크릿매니저에만. 클라이언트 배포·로그 출력 금지 |

```bash
export CARIPAY_MODE=test           # 운영 전환 시 live
export CARIPAY_PLATFORM_CODE=PC...
export CARIPAY_STORE_CODE=SD...
export CARIPAY_API_KEY=...
```

---

## 1. Node.js / TypeScript

```bash
npm install github:GOATHEAVEN-Inc/cari-pay-sdk
```

공개 npm 레지스트리 배포 전에도 GitHub에서 같은 버전을 설치할 수 있습니다.

```js
import { CariPay } from "@caripay/sdk";

const pay = CariPay.fromEnv();

// ① 결제 생성 → 링크 발급 (금액은 반드시 서버에서 결정)
const { transSeqno, redirectUrl } = await pay.createPayment({
  amount: 128000,
  mobileNo: "01012345678",
  payerName: "홍길동",
  reason: "8월 수강료",
  confirmUrl: "https://api.example.com/caripay/callback",
  returnUrl: "https://example.com/orders/done", // 선택: 결제 후 고객 브라우저 복귀(≤100자). 승인 판정은 조회로
  tempValue: "order-8812",                       // 선택: 콜백·복귀 URL 에 그대로 돌아오는 값
});
// redirectUrl → 바로 리다이렉트하거나 문자/알림톡으로 발송

// ② 콜백/폴링에서 승인 확인 (몇 번 불러도 같은 결과)
const p = await pay.confirmCallback(transSeqno);
if (p.paid && p.amount === 128000) { /* 이용권 해금 */ }

// ③ 취소 — 승인금액 전액만 가능 (부분 취소 불가). 금액 생략 시 조회해서 전액 취소
await pay.cancelPayment({ transSeqno });
```

- 타입 정의 포함(`index.d.ts`) — TypeScript에서 바로 자동완성됩니다.
- 전체 서버 예제: [`node/example-express.mjs`](node/example-express.mjs) — 생성·콜백·폴링·멱등 처리까지 붙여넣기용.
- 셀프체크: `cd node && npm test`

## 2. Python

```bash
pip install "git+https://github.com/GOATHEAVEN-Inc/cari-pay-sdk.git#subdirectory=python"
```

```python
from caripay import CariPay

pay = CariPay.from_env()

created = pay.create_payment(
    amount=128000,
    mobile_no="01012345678",
    payer_name="홍길동",
    reason="8월 수강료",
    confirm_url="https://api.example.com/caripay/callback",
)
print(created["redirect_url"])

found = pay.confirm_callback(created["trans_seqno"])
if found["paid"] and found["amount"] == 128000:
    ...  # 이용권 해금

pay.cancel_payment(created["trans_seqno"])
```

셀프체크: `cd python && python3 test_caripay.py`

## 3. 그 외 언어 (직접 호출 / 클라이언트 생성)

```bash
# 원하는 언어 클라이언트 생성
npx @openapitools/openapi-generator-cli generate -i openapi.yaml -g java -o ./client
# 브라우저로 규격 열람
npx @redocly/cli preview-docs openapi.yaml
```

서명만 맞추면 어떤 언어든 됩니다.

```
API_SIGN = sha256(TRANS_SEQNO + PLATFORM_CODE + STORE_CODE + TRANS_AT + API_KEY)   # 소문자 hex
TRANS_AT = KST 기준 yyyyMMddHHmmss (14자리)
```

```bash
SIGN=$(printf '%s' "svc001${PC}${SD}20260819120000${KEY}" | shasum -a 256 | cut -d' ' -f1)
curl -X POST https://dev-api.chewingpay.com/api/requestPayment \
  -H 'Content-Type: application/json' \
  -d "{\"TRANS_SEQNO\":\"svc001\",\"PLATFORM_CODE\":\"$PC\",\"STORE_CODE\":\"$SD\",
       \"TRANS_AT\":\"20260819120000\",\"APPROVAL_AMOUNT\":\"128000\",\"MOBILE_NO\":\"01012345678\",
       \"PAY_USER_NAME\":\"홍길동\",\"REQUEST_REASON\":\"8월 수강료\",
       \"CONFIRM_URL\":\"https://api.example.com/caripay/callback\",\"orderType\":\"BILL\",\"API_SIGN\":\"$SIGN\"}"
```

---

## API 4개

| 하는 일 | 엔드포인트 | Node | Python |
|---|---|---|---|
| 결제 생성 → 링크 발급 | `POST /api/requestPayment` | `createPayment()` | `create_payment()` |
| 상태 조회 (승인 확인) | `POST /api/searchPayment` | `getPayment()` | `get_payment()` |
| 취소(전액)/환불 · 청구서 삭제 | `POST /api/requestPaymentCancel` | `cancelPayment()` / `deleteBill()` | `cancel_payment()` / `delete_bill()` |
| 완료 콜백 (파트너가 구현) | `POST {CONFIRM_URL}` | `confirmCallback()` | `confirm_callback()` |

상태값: `STORE_REQUEST`(대기) → `APPROVE_COMPLETE`(**승인 완료**) / `APPROVE_FAIL` / `CANCEL_COMPLETE` / `CANCEL_FAIL` / `STORE_DELETE`

## 안 지키면 사고 나는 것 5가지

1. **금액은 서버에서 결정** — 클라이언트가 보낸 금액을 그대로 청구하지 않습니다.
2. **콜백 본문을 믿지 않습니다** — 수신 즉시 조회로 `APPROVE_COMPLETE`를 이중확인 (`confirmCallback`이 이것만 합니다).
3. **콜백은 중복·지연 도달합니다** — 이미 처리한 주문이면 200만 응답하고 무시(멱등). 해금·배송은 딱 1회.
4. **폴링 병행** — 콜백이 유실될 수 있으니 프런트 대기 화면이나 배치에서 상태를 확인합니다(`waitForPayment`).
5. **`API_KEY`는 서버에만** — 유출 의심 시 즉시 재발급 요청.

## 오픈 전 체크

- [ ] 거래번호(`TRANS_SEQNO`)가 전 시스템에서 유일한 구조인가 (`newTransSeqno()` 사용 권장)
- [ ] 테스트 게이트웨이에서 결제 → 콜백 → 조회 → 취소 전 구간 1회 이상 통과
- [ ] 승인금액과 주문금액 대사 로직 존재
- [ ] 운영 키로 환경변수 교체 (`CARIPAY_MODE=live`)
- [ ] `API_KEY`가 코드·로그·클라이언트 번들에 없음

전체 도입 절차·서류·정산은 [CARI PAY 연동가이드](https://caripay.co.kr/downloads/CARI-PAY_partner-guide_v1.1_2026-08-17.pdf), 문의는 https://caripay.co.kr/contact
