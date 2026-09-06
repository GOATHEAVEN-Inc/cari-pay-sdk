"""CARI PAY 결제 게이트웨이 SDK — 표준 라이브러리만 사용 (Python 3.9+).

    from caripay import CariPay
    pay = CariPay.from_env()
    r = pay.create_payment(amount=12000, mobile_no="01012345678",
                           payer_name="홍길동", reason="8월 수강료",
                           confirm_url="https://api.example.com/cb")
    print(r["redirect_url"])
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Sequence

BASE_URLS = {
    "test": "https://dev-api.chewingpay.com",
    "live": "https://api.chewingpay.com",
}
_PATHS = {
    "create": "/api/requestPayment",
    "search": "/api/searchPayment",
    "cancel": "/api/requestPaymentCancel",
}

APPROVED = "APPROVE_COMPLETE"
_CANCELED = {"CANCEL_COMPLETE", "STORE_DELETE"}
_KST = timezone(timedelta(hours=9))


class CariPayError(Exception):
    def __init__(self, message: str, code: Optional[str] = None,
                 trans_seqno: Optional[str] = None, response: Any = None):
        super().__init__(message)
        self.code = code
        self.trans_seqno = trans_seqno
        self.response = response


def now_kst14(when: Optional[datetime] = None) -> str:
    """TRANS_AT: KST 기준 yyyyMMddHHmmss."""
    return (when or datetime.now(_KST)).astimezone(_KST).strftime("%Y%m%d%H%M%S")


def new_trans_seqno(prefix: str = "cp") -> str:
    """거래번호 채번: 접두어 + KST14 + 난수 4자리. 전 시스템에서 유일해야 한다."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,16}", prefix):
        raise CariPayError("prefix는 영숫자/_/- 1~16자여야 합니다.")
    return f"{prefix}{now_kst14()}{random.randrange(10000):04d}"


def sign(trans_seqno: str, platform_code: str, store_code: str,
         trans_at: str, api_key: str) -> str:
    """API_SIGN = sha256(TRANS_SEQNO + PLATFORM_CODE + STORE_CODE + TRANS_AT + API_KEY)."""
    raw = f"{trans_seqno}{platform_code}{store_code}{trans_at}{api_key}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _required(value: Any, name: str) -> Any:
    if value is None or value == "":
        raise CariPayError(f"{name}은(는) 필수입니다.")
    return value


def _check_amount(amount: Any) -> str:
    text = str(_required(amount, "amount"))
    if not re.fullmatch(r"\d{1,12}", text) or text == "0":
        raise CariPayError(f"amount는 1~12자리 양의 정수여야 합니다: {amount}")
    return text


def _check_mobile(mobile_no: Any) -> str:
    digits = re.sub(r"\D", "", str(_required(mobile_no, "mobile_no")))
    if not re.fullmatch(r"\d{10,11}", digits):
        raise CariPayError(f"mobile_no는 숫자 10~11자리여야 합니다: {mobile_no}")
    return digits


def _check_seqno(trans_seqno: Any) -> str:
    text = str(_required(trans_seqno, "trans_seqno"))
    if len(text) > 64:
        raise CariPayError("trans_seqno는 64자 이하여야 합니다.")
    return text


class CariPay:
    def __init__(self, platform_code: str, store_code: str, api_key: str,
                 mode: str = "test", base_url: Optional[str] = None,
                 timeout: float = 10.0):
        self.platform_code = _required(platform_code, "platform_code")
        self.store_code = _required(store_code, "store_code")
        self.api_key = _required(api_key, "api_key")          # 서버에만 보관
        self.base_url = (base_url or BASE_URLS.get(mode, "")).rstrip("/")
        if not self.base_url:
            raise CariPayError(f"알 수 없는 mode: {mode} (test | live)")
        self.timeout = timeout

    @classmethod
    def from_env(cls, env: Optional[Dict[str, str]] = None) -> "CariPay":
        env = env if env is not None else dict(os.environ)
        return cls(
            platform_code=env.get("CARIPAY_PLATFORM_CODE", ""),
            store_code=env.get("CARIPAY_STORE_CODE", ""),
            api_key=env.get("CARIPAY_API_KEY", ""),
            mode=env.get("CARIPAY_MODE", "test"),
            base_url=env.get("CARIPAY_BASE_URL"),
        )

    # 테스트에서 갈아끼우는 지점. 실제 HTTP는 여기서만 일어난다.
    def _post(self, url: str, body: Dict[str, Any]) -> str:
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return response.read().decode("utf-8")

    def _call(self, path: str, trans_seqno: str,
              extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        trans_at = now_kst14()
        body: Dict[str, Any] = {
            "TRANS_SEQNO": trans_seqno,
            "PLATFORM_CODE": self.platform_code,
            "STORE_CODE": self.store_code,
            "TRANS_AT": trans_at,
        }
        body.update(extra or {})
        body["API_SIGN"] = sign(trans_seqno, self.platform_code,
                                self.store_code, trans_at, self.api_key)

        try:
            text = self._post(self.base_url + path, body)
        except (urllib.error.URLError, OSError) as exc:
            raise CariPayError(f"게이트웨이 호출 실패: {exc}", trans_seqno=trans_seqno) from exc

        try:
            payload = json.loads(text)
        except ValueError as exc:
            raise CariPayError(f"응답 파싱 실패: {text[:200]}", trans_seqno=trans_seqno) from exc

        # 성공 판정은 result_data.RESULT_CODE == "0000" 하나로만 한다.
        # (최상위 result_code는 게이트웨이 버전에 따라 0 / "0" 으로 흔들림)
        data = payload.get("result_data")
        if not data:
            raise CariPayError(f"result_data 없음: {payload.get('result_msg', text[:200])}",
                               trans_seqno=trans_seqno, response=payload)
        if data.get("RESULT_CODE") != "0000":
            raise CariPayError(f"{data.get('RESULT_MSG') or '요청 실패'} ({data.get('RESULT_CODE')})",
                               code=data.get("RESULT_CODE"), trans_seqno=trans_seqno, response=payload)
        return data

    def create_payment(self, *, amount: Any, mobile_no: str, payer_name: str,
                       reason: str, confirm_url: str,
                       trans_seqno: Optional[str] = None, info_message: str = "",
                       order_type: str = "BILL",
                       items: Optional[Sequence[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """결제 생성 → 고객에게 보낼 결제 페이지 링크 발급.

        금액은 반드시 서버 카탈로그 기준으로 결정해 넘길 것.
        """
        seqno = _check_seqno(trans_seqno or new_trans_seqno())
        if order_type not in ("BILL", "SHOP"):
            raise CariPayError(f"order_type은 BILL | SHOP 이어야 합니다: {order_type}")

        extra: Dict[str, Any] = {
            "APPROVAL_AMOUNT": _check_amount(amount),
            "MOBILE_NO": _check_mobile(mobile_no),
            "PAY_USER_NAME": _required(payer_name, "payer_name"),
            "REQUEST_REASON": _required(reason, "reason"),
            "INFO_MESSAGE": info_message,
            "CONFIRM_URL": _required(confirm_url, "confirm_url"),
            "orderType": order_type,
        }
        if items:
            extra["ITEMS"] = list(items)

        data = self._call(_PATHS["create"], seqno, extra)
        if not data.get("REDIRECT_URL"):
            raise CariPayError("REDIRECT_URL이 없습니다.", trans_seqno=seqno, response=data)
        return {"trans_seqno": seqno, "redirect_url": data["REDIRECT_URL"], "raw": data}

    def get_payment(self, trans_seqno: str) -> Dict[str, Any]:
        """결제 상태 조회. 승인 확인의 유일한 근거."""
        data = self._call(_PATHS["search"], _check_seqno(trans_seqno))
        status = data.get("APPROVE_STATUS")
        return {
            "trans_seqno": data.get("TRANS_SEQNO") or trans_seqno,
            "status": status,
            "paid": status == APPROVED,
            "canceled": status in _CANCELED,
            "amount": data.get("APPROVAL_AMOUNT"),
            "cancel_amount": data.get("CANCEL_AMOUNT"),
            "approved_at": data.get("APPROVAL_DATETIME"),
            "approval_number": data.get("APPROVAL_NUMBER"),
            "method_name": data.get("METHOD_NAME"),
            "issuer_name": data.get("ISSUER_NAME"),
            "cancel_reason": data.get("CANCEL_REASON"),
            "raw": data,
        }

    def cancel_payment(self, trans_seqno: str, amount: Any = None,
                       mobile_no: Optional[str] = None) -> Dict[str, Any]:
        """결제 취소(환불). amount 미지정 시 승인금액 전액."""
        seqno = _check_seqno(trans_seqno)
        if amount is None or mobile_no is None:
            found = self.get_payment(seqno)
            amount = amount if amount is not None else found["amount"]
            mobile_no = mobile_no or found["raw"].get("MOBILE_NO")

        data = self._call(_PATHS["cancel"], seqno, {
            "REQUEST_TYPE": "CANCEL",
            "APPROVAL_AMOUNT": _check_amount(amount),
            "MOBILE_NO": _check_mobile(mobile_no),
        })
        return {"trans_seqno": seqno, "canceled_amount": data.get("APPROVAL_AMOUNT"), "raw": data}

    def delete_bill(self, trans_seqno: str, amount: Any, mobile_no: str) -> Dict[str, Any]:
        """미결제 청구서 삭제. 승인건 환불은 cancel_payment."""
        seqno = _check_seqno(trans_seqno)
        data = self._call(_PATHS["cancel"], seqno, {
            "REQUEST_TYPE": "DELETE",
            "APPROVAL_AMOUNT": _check_amount(amount),
            "MOBILE_NO": _check_mobile(mobile_no),
        })
        return {"trans_seqno": seqno, "raw": data}

    def confirm_callback(self, payload: Any) -> Dict[str, Any]:
        """CONFIRM_URL 콜백 처리용. 본문을 믿지 말고 조회로 이중확인한다.

        중복 콜백이 와도 결과가 같으므로 멱등 처리에 그대로 쓸 수 있다.
        """
        if isinstance(payload, dict):
            seqno = payload.get("TRANS_SEQNO") or payload.get("trans_seqno")
        else:
            seqno = payload
        return self.get_payment(_check_seqno(seqno))

    def wait_for_payment(self, trans_seqno: str, interval: float = 3.0,
                         timeout: float = 600.0) -> Dict[str, Any]:
        """완료 대기 폴링 (결제 링크 문자 발송 후 대기 화면 패턴)."""
        deadline = time.monotonic() + timeout
        while True:
            found = self.get_payment(trans_seqno)
            if found["paid"] or found["canceled"]:
                return found
            if time.monotonic() + interval >= deadline:
                return found
            time.sleep(interval)
