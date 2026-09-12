"""Blackboard Learn 客户端：会话管理（TTL / 401 自动重登）+ REST 接口 + 作业拉取。"""
from __future__ import annotations

import time

import requests

from backend import cas
from backend.cas import NetworkError

BB_BASE = "https://bb.sustech.edu.cn"
SESSION_TTL = 25 * 60
_TIMEOUT = 30


class SessionExpired(Exception):
    """会话失效且自动重登失败。"""


class BBSession:
    """内存会话：HTTP 层与登录函数可注入（测试用 FakeSession）。

    TODO(服务层): 跨线程共享前需加 threading.Lock——调度线程与 Flask 请求线程并发时，
    _cookies/_obtained_at 与共享的 requests.Session 均非线程安全。
    """

    def __init__(self, sid: str, password: str, *, http=None, login_fn=None,
                 clock=time.monotonic):
        self._sid = sid
        self._password = password
        self._http = http if http is not None else requests.Session()
        self._login_fn = login_fn or cas.login
        self._clock = clock
        self._cookies: dict = {}
        self._obtained_at = None

    def _login(self) -> None:
        sess = requests.Session()
        self._cookies = self._login_fn(self._sid, self._password, session=sess)
        if not self._cookies:
            raise NetworkError("CAS 登录未返回有效 Cookie")
        self._obtained_at = self._clock()

    def _expired(self) -> bool:
        return self._obtained_at is None or (self._clock() - self._obtained_at) > SESSION_TTL

    def _ensure(self) -> None:
        if not self._cookies or self._expired():
            self._login()

    def get(self, path: str, params: dict | None = None):
        self._ensure()
        url = path if path.startswith("http") else BB_BASE + path
        r = None
        for _ in range(2):
            r = self._http.get(
                url,
                params=params,
                headers={"User-Agent": cas.UA},
                cookies=dict(self._cookies),
                timeout=_TIMEOUT,
            )
            if r.status_code != 401:
                return r
            self._login()  # 401 → 强制重登后再试一次
        return r

    def get_json(self, path: str, params: dict | None = None):
        r = self.get(path, params)
        if r.status_code == 401:
            raise SessionExpired(f"会话失效且重登失败：{path}")
        if r.status_code != 200:
            raise NetworkError(f"Blackboard 接口错误 HTTP {r.status_code}: {path}")
        try:
            return r.json()
        except ValueError as e:
            raise NetworkError(f"Blackboard 返回非 JSON 响应：{path}") from e
