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
import urllib.parse
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

# 청구 API는 현재 단일 환경이다(실제 발송·과금). test/live 모두 같은 주소를 가리킨다.
BILLING_BASE_URLS = {"test": "https://api.dev.caripay.co.kr", "live": "https://api.dev.caripay.co.kr"}
# 청구서 발송 수단. ALIMTALK=카카오 알림톡, SMS=문자, ALIMTALK_THEN_SMS=알림톡 실패 시 문자
SEND_CHANNELS = ("ALIMTALK", "SMS", "ALIMTALK_THEN_SMS")
_TOKEN_ERROR_CODES = (-1, -2, "-1", "-2")  # 토큰 없음 / 토큰 만료


def _billing_base_url(mode: str, base_url: Optional[str]) -> str:
    value = base_url or BILLING_BASE_URLS.get(mode, "")
    try:
        url = urllib.parse.urlsplit(value)
        local = url.hostname in ("localhost", "127.0.0.1", "::1")
        valid = url.hostname and (url.scheme == "https" or (local and url.scheme == "http"))
        valid = valid and not (url.username or url.password or url.query or url.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise CariPayError("올바른 HTTPS 청구 API 주소가 필요합니다.")
    return value.rstrip("/")


class _NoBillingRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a merchant token to a redirected host.


class CariPayBilling:
    """가맹점 청구 API: 청구서 생성과 카리 알림톡 발송. 결제 API_KEY가 아닌 가맹점 토큰 사용."""

    def __init__(self, *, access_token: str, mode: str = "test", base_url: Optional[str] = None,
                 timeout: float = 10, refresh_token: Optional[str] = None,
                 credentials: Optional[Dict[str, str]] = None):
        if not isinstance(access_token, str) or not access_token or re.search(r"\s", access_token):
            raise CariPayError("가맹점 청구 API access_token이 필요합니다. 결제 API_KEY와 다릅니다.")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout < float("inf"):
            raise CariPayError("timeout은 양수여야 합니다.")
        self.base_url = _billing_base_url(mode, base_url)
        self.access_token = access_token
        # 접근 토큰(1시간) 만료 시 갱신용. login()으로 만들면 credentials 로 재로그인까지 한다.
        self.refresh_token = refresh_token if isinstance(refresh_token, str) and refresh_token.strip() else None
        self.credentials = credentials
        self.timeout = timeout
        self._opener = urllib.request.build_opener(_NoBillingRedirect())

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        return cls(access_token=env.get("CARIPAY_BILLING_ACCESS_TOKEN"), refresh_token=env.get("CARIPAY_BILLING_REFRESH_TOKEN"),
                   mode=env.get("CARIPAY_MODE", "test"), base_url=env.get("CARIPAY_BILLING_BASE_URL"))

    @classmethod
    def login(cls, *, email: str, password: str, mode: str = "test", base_url: Optional[str] = None,
              timeout: float = 10, opener=None):
        """가맹점 계정으로 로그인해 클라이언트를 만든다. 토큰 만료 시 자동 갱신·재로그인. 연동 전용 계정을 쓰세요."""
        if not isinstance(email, str) or not email.strip() or not isinstance(password, str) or not password:
            raise CariPayError("가맹점 계정 email/password 가 필요합니다.")
        credentials = {"email": email.strip(), "password": password}
        client = cls(access_token="pending", mode=mode, base_url=base_url, timeout=timeout, credentials=credentials)
        if opener is not None:
            client._opener = opener
        tokens = client._auth("/app/v1/auth/login", {**credentials, "loginType": "EMAIL"})
        client.access_token, client.refresh_token = tokens
        return client

    def _auth(self, path: str, body: Dict[str, Any]):
        request = urllib.request.Request(self.base_url + path, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                         headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                data = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise CariPayError(f"청구 API 로그인 실패 (HTTP {error.code})", code=str(error.code)) from None
        except (urllib.error.URLError, OSError):
            raise CariPayError("청구 API 인증 서버에 연결하지 못했습니다.") from None
        except (ValueError, UnicodeError):
            raise CariPayError("청구 API 인증 응답 형식 오류") from None
        result = data.get("result_data") if isinstance(data, dict) else None
        if not isinstance(data, dict) or data.get("result_code") not in (0, "0") or not isinstance(result, dict) \
                or not isinstance(result.get("accessToken"), str) or not result["accessToken"]:
            raise CariPayError("청구 API 로그인 실패", code=str(data.get("result_code")) if isinstance(data, dict) else None)
        refresh = result.get("refreshToken")
        return result["accessToken"], (refresh if isinstance(refresh, str) and refresh else None)

    def _renew(self) -> bool:
        """접근 토큰 갱신 → 실패 시 재로그인. 둘 다 불가능하면 False."""
        if self.refresh_token:
            try:
                self.access_token, refresh = self._auth("/app/v1/auth/refresh", {"refreshToken": self.refresh_token})
                if refresh:
                    self.refresh_token = refresh
                return True
            except CariPayError:
                pass  # 리프레시 토큰도 만료 — 아래에서 재로그인
        if self.credentials:
            self.access_token, self.refresh_token = self._auth("/app/v1/auth/login", {**self.credentials, "loginType": "EMAIL"})
            return True
        return False

    def _call(self, path, body=None, _retried=False):
        request = urllib.request.Request(self.base_url + path,
            data=None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-access-token": self.access_token},
            method="GET" if body is None else "POST")
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raise CariPayError(f"청구 API 요청 실패 (HTTP {error.code})", code=str(error.code)) from None
        except (urllib.error.URLError, OSError):
            raise CariPayError("청구 API 응답을 받지 못했습니다. 같은 request_id와 내용으로만 재시도하세요.") from None
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError):
            raise CariPayError("청구 API 응답 형식 오류") from None
        if not isinstance(data, dict) or type(data.get("result_code")) not in (int, str) or data.get("result_code") not in (0, "0"):
            code = data.get("result_code") if isinstance(data, dict) else None
            # 토큰 없음/만료는 서버가 처리 전에 거절한 것이라 중복 접수 없이 한 번 갱신 후 재시도한다.
            if not _retried and code in _TOKEN_ERROR_CODES and self._renew():
                return self._call(path, body, _retried=True)
            raise CariPayError("청구 API 요청 실패", code=str(code) if code is not None else None)
        return data.get("result_data")

    def send_invoice(self, *, request_id: str, amount: int, recipient: dict, reason: str, message: str = "",
                     channel: str = "ALIMTALK"):
        """성공은 접수만 의미. 주문별 request_id를 저장하고 같은 요청 재시도 시 재사용하세요."""
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", request_id):
            raise CariPayError("request_id는 영숫자/_/- 8~64자여야 합니다.")
        if channel not in SEND_CHANNELS:
            raise CariPayError(f"channel은 {' | '.join(SEND_CHANNELS)} 중 하나여야 합니다: {channel}")
        if type(amount) is not int or not 100 <= amount <= 2147483647:
            raise CariPayError("청구 금액은 100~2147483647원 사이의 정수여야 합니다.")

        def text(value, maximum, label, optional=False):
            if not isinstance(value, str) or (not optional and not value.strip()) or len(value) > maximum or re.search(r"[\r\n]", value):
                raise CariPayError(f"{label} 형식이 올바르지 않습니다 (한 줄, 최대 {maximum}자).")
            return value.strip()

        if not isinstance(recipient, dict):
            raise CariPayError("수신자 정보가 필요합니다.")
        name = text(recipient.get("name"), 30, "수신자 이름")
        phone = recipient.get("phone")
        phone = re.sub(r"[ -]", "", phone) if isinstance(phone, str) else ""
        if not re.fullmatch(r"[0-9]{10,11}", phone):
            raise CariPayError("수신자 전화번호는 숫자 10~11자리여야 합니다.")
        self._call("/app/v1/sales/bill", {
            "templateType": "SAME", "billTemplateId": None, "requestId": request_id, "amount": amount,
            "sendChannel": channel,
            "reason": text(reason, 60, "청구 사유"), "description": text(message, 200, "안내문", True),
            "members": [{"studentName": name, "studentPhone": phone, "guardianPhone": None,
                         "studentBirthDate": None, "classroomId": None}],
            "items": None, "relatedSubject": None, "etc": None,
        })
        return {"accepted": True, "request_id": request_id}

    def list_invoices(self, *, page: int = 1, size: int = 10, month: Optional[str] = None):
        if type(page) is not int or page < 1 or type(size) is not int or not 1 <= size <= 100:
            raise CariPayError("page는 1 이상, size는 1~100 사이의 정수여야 합니다.")
        if month is not None and (not isinstance(month, str) or not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", month)):
            raise CariPayError("month는 yyyy-MM 형식이어야 합니다.")
        query = {"page": page, "size": size}
        if month is not None:
            query["month"] = month
        return self._call("/app/v1/sales/bill?" + urllib.parse.urlencode(query))

    def get_invoice(self, invoice_id: str):
        if not isinstance(invoice_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", invoice_id):
            raise CariPayError("유효한 청구서 ID가 필요합니다.")
        return self._call("/app/v1/sales/bill/" + urllib.parse.quote(invoice_id, safe=""))


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


def _check_callback_url(confirm_url: Any) -> str:
    value = str(_required(confirm_url, "confirm_url"))
    parsed = urllib.parse.urlparse(value)
    local = parsed.hostname in ("localhost", "127.0.0.1")
    if not parsed.hostname or (parsed.scheme != "https" and not (local and parsed.scheme == "http")):
        raise CariPayError("confirm_url은 HTTPS여야 합니다. 로컬 개발에서는 localhost HTTP만 허용됩니다.")
    return value


def _check_return_url(return_url: Any) -> str:
    value = str(return_url)
    parsed = urllib.parse.urlparse(value)
    local = parsed.hostname in ("localhost", "127.0.0.1")
    if not parsed.hostname or (parsed.scheme != "https" and not (local and parsed.scheme == "http")):
        raise CariPayError("return_url은 HTTPS여야 합니다.")
    if len(value) > 100:
        raise CariPayError("return_url은 100자 이하여야 합니다. 주문 식별은 temp_value를 쓰세요.")
    return value


def _number_or_none(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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
                       items: Optional[Sequence[Dict[str, Any]]] = None,
                       return_url: Optional[str] = None, temp_value: Any = None,
                       user_id: Any = None) -> Dict[str, Any]:
        """결제 생성 → 고객에게 보낼 결제 페이지 링크 발급.

        금액은 반드시 서버 카탈로그 기준으로 결정해 넘길 것.
        return_url: 결제 완료 후 결제 페이지가 고객 브라우저를 돌려보낼 곳(HTTPS, 100자 이하).
                    승인 판정은 여기가 아니라 조회 API로 한다.
        temp_value: 콜백·리턴에 그대로 돌아오는 임의값(주문 ID 등).
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
            "CONFIRM_URL": _check_callback_url(confirm_url),
            "orderType": order_type,
        }
        if return_url:
            extra["RETURN_DISPLAY_YN"] = "Y"
            extra["RETURN_URL"] = _check_return_url(return_url)
        if temp_value is not None:
            extra["TEMP_VALUE"] = str(temp_value)
        if user_id is not None:
            extra["USER_ID"] = str(user_id)
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
            "amount": _number_or_none(data.get("APPROVAL_AMOUNT")),
            "cancel_amount": _number_or_none(data.get("CANCEL_AMOUNT")),
            "approved_at": data.get("APPROVAL_DATETIME"),
            "approval_number": data.get("APPROVAL_NUMBER"),
            "method_name": data.get("METHOD_NAME"),
            "issuer_name": data.get("ISSUER_NAME"),
            "cancel_reason": data.get("CANCEL_REASON"),
            "raw": data,
        }

    def cancel_payment(self, trans_seqno: str, amount: Any = None,
                       mobile_no: Optional[str] = None) -> Dict[str, Any]:
        """결제 취소(환불). 게이트웨이는 승인금액 **전액 취소만** 받는다.

        amount 를 넘기면 승인금액과 같아야 하고, 생략하면 조회로 승인금액을 채운다.
        부분 환불은 전액 취소 후 새 결제로 처리한다.
        """
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
        return {"trans_seqno": seqno, "canceled_amount": _number_or_none(data.get("APPROVAL_AMOUNT")), "raw": data}

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
