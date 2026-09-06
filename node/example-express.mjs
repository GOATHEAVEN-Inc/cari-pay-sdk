// 붙여넣기용 최소 연동 서버 — 생성 → 콜백 → 조회 전 구간
// 실행: CARIPAY_PLATFORM_CODE=... CARIPAY_STORE_CODE=... CARIPAY_API_KEY=... node example-express.mjs
import express from "express";
import { CariPay, newTransSeqno } from "@caripay/sdk";

const pay = CariPay.fromEnv();          // CARIPAY_MODE=live 로 운영 전환
const app = express();
app.use(express.json());

const orders = new Map();               // 실제로는 DB
const PRICES = { "math-pass": 12000 };  // 금액은 서버 카탈로그에서만 결정

app.post("/checkout", async (req, res) => {
  const amount = PRICES[req.body.sku];                       // 클라 금액 신뢰 금지
  if (!amount) return res.status(400).json({ error: "unknown sku" });

  const transSeqno = newTransSeqno("svc");
  const { redirectUrl } = await pay.createPayment({
    transSeqno,
    amount,
    mobileNo: req.body.phone,
    payerName: req.body.name,
    reason: "수학 학습권",
    confirmUrl: `https://api.example.com/caripay/callback/${transSeqno}`,
  });

  orders.set(transSeqno, { status: "PENDING", amount, sku: req.body.sku });
  res.json({ transSeqno, redirectUrl });   // 바로 이동시키거나 문자로 발송
});

// CONFIRM_URL — 중복·지연 도달 전제. 본문 대신 조회 결과만 신뢰.
app.post("/caripay/callback/:transSeqno", async (req, res) => {
  res.sendStatus(200);                                   // 먼저 200, 재전송 폭주 방지
  await settle(req.params.transSeqno).catch(console.error);
});

// 콜백 누락 대비 폴링 경로 (프런트 대기 화면에서 3초 간격 호출)
app.get("/orders/:transSeqno", async (req, res) => {
  await settle(req.params.transSeqno).catch(() => {});
  res.json(orders.get(req.params.transSeqno) ?? { status: "UNKNOWN" });
});

// 상태 전이는 한 곳에서만 — 콜백/폴링 어느 쪽이 먼저 와도 서비스 제공은 1회
async function settle(transSeqno) {
  const order = orders.get(transSeqno);
  if (!order || order.status !== "PENDING") return;      // 멱등

  const p = await pay.confirmCallback(transSeqno);
  if (p.paid) {
    if (p.amount !== order.amount) {                     // 금액 대사
      order.status = "AMOUNT_MISMATCH";
      return;
    }
    order.status = "PAID";
    order.approvalNumber = p.approvalNumber;
    // 여기서 이용권 해금 / 주문 확정
  } else if (p.canceled) {
    order.status = "CANCELED";
  }
}

app.listen(3000, () => console.log("http://localhost:3000"));
