"""No network: exercise the actual request builder with a fake opener."""
import io
import json
import urllib.error
from caripay import CariPayBilling, CariPayError, _NoBillingRedirect

class Opener:
    def __init__(self, response=None, error=None):
        self.calls = []
        self.response = response if response is not None else {"result_code": 0, "result_data": None}
        self.error = error

    def open(self, request, timeout):
        self.calls.append(request)
        if self.error:
            raise self.error
        return io.BytesIO(json.dumps(self.response).encode())

invoice = dict(request_id="order_20260908_001", amount=128000,
               recipient={"name": "테스트 고객", "phone": "010-0000-0000"}, reason="수리비", message="내역 확인")
billing = CariPayBilling(access_token="mock-merchant-token", mode="live")
billing._opener = Opener()
assert billing.send_invoice(**invoice) == {"accepted": True, "request_id": invoice["request_id"]}
req = billing._opener.calls[0]
assert req.full_url == "https://api.dev.caripay.co.kr/app/v1/sales/bill"
assert req.get_header("X-access-token") == "mock-merchant-token"
body = json.loads(req.data)
assert body["members"][0]["studentPhone"] == "01000000000"
assert body["members"][0]["studentName"] == "테스트 고객"
assert body["requestId"] == invoice["request_id"] and body["amount"] == 128000
assert body["sendChannel"] == "ALIMTALK"
billing.send_invoice(**invoice)
assert billing._opener.calls[0].data == billing._opener.calls[1].data
billing.list_invoices(page=2, size=20, month="2026-09")
assert billing._opener.calls[2].method == "GET"
assert billing._opener.calls[2].full_url.endswith("page=2&size=20&month=2026-09")
billing.get_invoice("invoice-uuid")
assert billing._opener.calls[3].full_url.endswith("/bill/invoice-uuid")
assert _NoBillingRedirect().redirect_request(None, None, 302, "", {}, "https://other.example") is None

def fails(call):
    try:
        call()
    except CariPayError as error:
        assert "PRIVATE-CUSTOMER-DATA" not in str(error)
        return
    raise AssertionError("Expected CariPayError")

count = len(billing._opener.calls)
for change in ({"amount": 99}, {"amount": 2147483648}, {"amount": 100.5}, {"amount": True},
               {"request_id": "short"}, {"reason": ""}, {"reason": "x" * 61}, {"message": "\n"},
               {"recipient": {"name": "고객", "phone": "abc01000000000"}}):
    fails(lambda: billing.send_invoice(**{**invoice, **change}))
fails(lambda: billing.list_invoices(size=101))
fails(lambda: billing.get_invoice("../admin"))
assert len(billing._opener.calls) == count
fails(lambda: CariPayBilling(access_token=""))
fails(lambda: CariPayBilling(access_token="mock", base_url="http://remote.example"))
fails(lambda: CariPayBilling(access_token="mock", base_url="https://user:pass@example.com"))
fails(lambda: CariPayBilling(access_token="mock", timeout=0))
assert CariPayBilling.from_env({"CARIPAY_BILLING_ACCESS_TOKEN": "mock"}).base_url == "https://api.dev.caripay.co.kr"
for code in (-1, None, False):
    billing._opener = Opener({"result_code": code, "result_msg": "PRIVATE-CUSTOMER-DATA"})
    fails(lambda: billing.send_invoice(**invoice))
billing._opener = Opener(error=urllib.error.URLError("PRIVATE-CUSTOMER-DATA"))
fails(lambda: billing.send_invoice(**invoice))
assert len(billing._opener.calls) == 1

# 발송 수단: 지정값 그대로, 모르는 값은 호출 전에 거절
billing._opener = Opener()
billing.send_invoice(**{**invoice, "channel": "SMS"})
assert json.loads(billing._opener.calls[-1].data)["sendChannel"] == "SMS"
fails(lambda: billing.send_invoice(**{**invoice, "channel": "EMAIL"}))
billing._opener = Opener()
billing.send_invoice(**{**invoice, "webhook_url": "https://partner.example/caripay/hook"})
assert json.loads(billing._opener.calls[-1].data)["webhookUrl"] == "https://partner.example/caripay/hook"
billing.send_invoice(**invoice)
assert "webhookUrl" not in json.loads(billing._opener.calls[-1].data)
fails(lambda: billing.send_invoice(**{**invoice, "webhook_url": "http://partner.example/hook"}))


class RoutingOpener:
    """로그인 → 만료(-2) → 갱신 → 재시도 → 갱신 실패 → 재로그인 시나리오."""
    def __init__(self):
        self.calls = []
        self.n = 0
        self.refresh_ok = True

    def open(self, request, timeout):
        path = request.full_url.split(".co.kr", 1)[1]
        self.calls.append((path, request.get_header("X-access-token")))
        if path == "/app/v1/auth/login":
            self.n += 1
            return io.BytesIO(json.dumps({"result_code": 0, "result_data": {"accessToken": f"A{self.n}", "refreshToken": f"R{self.n}"}}).encode())
        if path == "/app/v1/auth/refresh":
            if not self.refresh_ok:
                return io.BytesIO(json.dumps({"result_code": -10}).encode())
            self.n += 1
            return io.BytesIO(json.dumps({"result_code": 0, "result_data": {"accessToken": f"A{self.n}", "refreshToken": f"R{self.n}"}}).encode())
        expired = len([c for c in self.calls if c[0] == "/app/v1/sales/bill"]) % 2 == 1  # 첫 호출 만료, 재시도 성공
        return io.BytesIO(json.dumps({"result_code": -2} if expired else {"result_code": 0}).encode())


router = RoutingOpener()
client = CariPayBilling.login(email=" owner@example.com ", password="pw", mode="live", opener=router)
assert client.access_token == "A1" and client.refresh_token == "R1"
client.send_invoice(**invoice)
assert [c[0] for c in router.calls] == ["/app/v1/auth/login", "/app/v1/sales/bill", "/app/v1/auth/refresh", "/app/v1/sales/bill"]
assert router.calls[-1][1] == "A2"
router.refresh_ok = False
client.send_invoice(**invoice)
assert [c[0] for c in router.calls[4:]] == ["/app/v1/sales/bill", "/app/v1/auth/refresh", "/app/v1/auth/login", "/app/v1/sales/bill"]
assert router.calls[-1][1] == "A3"
fails(lambda: CariPayBilling.login(email="", password="pw"))
# 갱신 수단이 없으면 -2 를 그대로 오류로 올린다(무한 재시도 없음)
bare = CariPayBilling(access_token="stale")
bare._opener = Opener({"result_code": -2})
fails(lambda: bare.send_invoice(**invoice))
assert len(bare._opener.calls) == 1
print("Billing Python checks passed (mock only; no customer messages)")
