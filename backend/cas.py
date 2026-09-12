"""SUSTech CAS 登录（纯 requests 三步流程，禁止浏览器自动化）。

流程：
1. GET  https://cas.sustech.edu.cn/cas/login?service=<编码后的 SERVICE_URL>
     → 正则提取隐藏字段 execution
2. POST 同一 URL（allow_redirects=False）表单：
     username / password / execution / _eventId=submit / submit=提交
     → 期望 302/303；Location 含 cas 且无 ticket ⇒ 账号密码错误
3. GET  Location（跟随重定向）→ 收集 cookie jar

requests 网络异常（连接失败/超时）自动重试，默认最多尝试 2 次。
"""
from __future__ import annotations

import re
from urllib.parse import quote

import requests

CAS_BASE = "https://cas.sustech.edu.cn/cas/login"
BB_SERVICE_URL = "https://bb.sustech.edu.cn/webapps/bb-sso-BBLEARN/index.jsp"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
TIMEOUT = 30
_EXECUTION_RE = re.compile(r'name="execution"[^>]*value="([^"]+)"')


class InvalidCredentials(Exception):
    """账号或密码错误。"""


class NetworkError(Exception):
    """网络不可达（含校外 / 断网 / 服务异常）。"""


def login(sid: str, password: str, session=None, timeout: int = TIMEOUT,
          attempts: int = 2) -> dict:
    """执行 CAS 登录（requests 网络异常最多尝试 attempts 次），成功返回 cookie 字典。"""
    last_error: Exception | None = None
    for _ in range(max(1, attempts)):
        try:
            return _login_once(sid, password, session=session, timeout=timeout)
        except requests.RequestException as e:
            last_error = e
    raise NetworkError(f"网络请求失败（已重试）：{last_error}") from last_error


def _login_once(sid: str, password: str, session=None, timeout: int = TIMEOUT) -> dict:
    sess = session if session is not None else requests.Session()
    cas_url = f"{CAS_BASE}?service={quote(BB_SERVICE_URL, safe='')}"
    headers = {"User-Agent": UA}

    r = sess.get(cas_url, headers=headers, timeout=timeout)
    m = _EXECUTION_RE.search(r.text)
    if not m:
        raise NetworkError("CAS 登录页异常：未找到 execution 令牌")
    r2 = sess.post(
        cas_url,
        data={
            "username": sid,
            "password": password,
            "execution": m.group(1),
            "_eventId": "submit",
            "submit": "提交",
        },
        headers=headers,
        timeout=timeout,
        allow_redirects=False,
    )

    if r2.status_code not in (302, 303):
        raise NetworkError(f"CAS 响应异常：HTTP {r2.status_code}")

    loc = r2.headers.get("Location", "")
    if not loc:
        raise NetworkError("CAS 响应缺少 Location 头")
    if "cas.sustech.edu.cn" in loc and "ticket" not in loc:
        raise InvalidCredentials("CAS 拒绝了凭据：账号或密码错误")

    sess.get(loc, headers=headers, timeout=timeout, allow_redirects=True)
    return {c.name: c.value for c in sess.cookies if c.value}
