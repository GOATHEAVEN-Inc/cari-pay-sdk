"""셀프체크: python3 test_caripay.py (네트워크 없이 _post를 가짜로 바꿔 전 구간 검증)"""
import hashlib
import json
from datetime import datetime, timezone

from caripay import CariPay, CariPayError, new_trans_seqno, now_kst14, sign

KEY = "secret-key"
CFG = dict(platform_code="PC0001", store_code="SD0001", api_key=KEY, mode="test")


def stub(pay, responder):
    """_post를 가짜로 교체하고 실제로 나간 요청을 기록한다."""
    sent = []

    def _post(url, body):
        sent.append({"url": url, "body": body})
        return json.dumps(responder(url, body))

    pay._post = _post
    return sent


# 1. 서명 = 5개 값 무구분자 연결 후 sha256 소문자 hex
assert sign("T1", "PC0001", "SD0001", "20260819120000", KEY) == hashlib.sha256(
    ("T1PC0001SD000120260819120000" + KEY).encode()).hexdigest()

# 2. TRANS_AT은 KST 14자리
assert now_kst14(datetime(2026, 8, 19, tzinfo=timezone.utc)) == "20260819090000"
assert len(new_trans_seqno("svc")) == 21 and new_trans_seqno("svc").startswith("svc")
try:
    new_trans_seqno("bad prefix!")
    raise AssertionError("prefix 검증 실패")
except CariPayError:
    pass

# 3. 결제 생성: 바디 필드·서명이 규격대로 실리는가
pay = CariPay(**CFG)
sent = stub(pay, lambda url, body: {
    "result_code": 0, "result_data": {"RESULT_CODE": "0000", "REDIRECT_URL": "https://pay/x"}})
result = pay.create_payment(trans_seqno="svc001", amount=12000, mobile_no="010-1234-5678",
                            payer_name="홍길동", reason="8월 수강료", confirm_url="https://me/cb")
body = sent[-1]["body"]
assert result["redirect_url"] == "https://pay/x"
assert sent[-1]["url"] == "https://dev-api.chewingpay.com/api/requestPayment"
assert body["APPROVAL_AMOUNT"] == "12000"       # 문자열 금액
assert body["MOBILE_NO"] == "01012345678"       # 하이픈 제거
assert body["orderType"] == "BILL"
assert len(body["TRANS_AT"]) == 14
assert body["API_SIGN"] == sign("svc001", "PC0001", "SD0001", body["TRANS_AT"], KEY)
assert "RETURN_URL" not in body and "TEMP_VALUE" not in body

# 3-1. 결제 후 복귀 주소·임의값: 주면 실리고, HTTP·100자 초과는 호출 전에 거절
pay.create_payment(trans_seqno="svc002", amount=12000, mobile_no="01012345678", payer_name="홍",
                   reason="r", confirm_url="https://me/cb", return_url="https://me/done", temp_value=8812)
body = sent[-1]["body"]
assert body["RETURN_DISPLAY_YN"] == "Y" and body["RETURN_URL"] == "https://me/done" and body["TEMP_VALUE"] == "8812"
for bad in ("http://example.com/done", "https://example.com/" + "x" * 100):
    try:
        pay.create_payment(trans_seqno="svc003", amount=12000, mobile_no="01012345678", payer_name="홍",
                           reason="r", confirm_url="https://me/cb", return_url=bad)
        raise AssertionError("return_url 검증 실패")
    except CariPayError:
        pass

# 4. 입력 검증 — 잘못된 값은 호출 전에 막는다
pay = CariPay(**CFG)
stub(pay, lambda url, body: (_ for _ in ()).throw(AssertionError("호출되면 안 됨")))
base = dict(mobile_no="01012345678", payer_name="홍", reason="r", confirm_url="https://c")
for bad in (dict(base, amount=0), dict(base, amount=-1), dict(base, amount=10**13),
            dict(base, amount=1000, mobile_no="123"), dict(base, amount=1000, confirm_url=""),
            dict(base, amount=1000, confirm_url="http://example.com/callback"),
            dict(base, amount=1000, order_type="X")):
    try:
        pay.create_payment(**bad)
        raise AssertionError(f"검증 통과되면 안 됨: {bad}")
    except CariPayError:
        pass

# 5. 실패 응답은 RESULT_CODE 기준으로 던진다
pay = CariPay(**CFG)
stub(pay, lambda url, body: {"result_code": "0",
                             "result_data": {"RESULT_CODE": "5001", "RESULT_MSG": "청구서 없음"}})
try:
    pay.get_payment("svc001")
    raise AssertionError("에러가 나야 함")
except CariPayError as exc:
    assert exc.code == "5001"

# 6. 조회 정규화 + 콜백 이중확인 (본문/문자열 모두 동일 결과 = 멱등)
pay = CariPay(**CFG)
stub(pay, lambda url, body: {"result_data": {
    "RESULT_CODE": "0000", "TRANS_SEQNO": "svc001", "APPROVE_STATUS": "APPROVE_COMPLETE",
    "APPROVAL_AMOUNT": "12000", "APPROVAL_NUMBER": "30001234", "METHOD_NAME": "신용카드"}})
found = pay.get_payment("svc001")
assert found["paid"] is True and found["canceled"] is False and found["amount"] == 12000
assert pay.confirm_callback({"TRANS_SEQNO": "svc001"}) == found
assert pay.confirm_callback("svc001") == found

# 7. 취소: 금액/번호 생략 시 조회로 채워 전액 취소
pay = CariPay(**CFG)
sent = stub(pay, lambda url, body: {"result_data": (
    {"RESULT_CODE": "0000", "APPROVE_STATUS": "APPROVE_COMPLETE",
     "APPROVAL_AMOUNT": 12000, "MOBILE_NO": "01012345678"}
    if url.endswith("searchPayment") else
    {"RESULT_CODE": "0000", "APPROVAL_AMOUNT": 12000})})
canceled = pay.cancel_payment("svc001")
assert canceled["canceled_amount"] == 12000
assert sent[-1]["url"].endswith("/api/requestPaymentCancel")
assert sent[-1]["body"]["REQUEST_TYPE"] == "CANCEL"
assert sent[-1]["body"]["APPROVAL_AMOUNT"] == "12000"

# 8. 폴링: 승인되면 즉시 반환
pay = CariPay(**CFG)
state = {"n": 0}


def polling(url, body):
    state["n"] += 1
    return {"result_data": {"RESULT_CODE": "0000",
                            "APPROVE_STATUS": "STORE_REQUEST" if state["n"] < 3 else "APPROVE_COMPLETE"}}


stub(pay, polling)
assert pay.wait_for_payment("svc001", interval=0.001, timeout=5)["paid"] is True
assert state["n"] == 3

# 9. 모드/필수값
assert CariPay(**dict(CFG, mode="live")).base_url == "https://api.chewingpay.com"
for bad_init in (dict(CFG, mode="prod"), dict(platform_code="PC", store_code="SD", api_key="")):
    try:
        CariPay(**bad_init)
        raise AssertionError("생성되면 안 됨")
    except CariPayError:
        pass

print("✅ 전부 통과")
