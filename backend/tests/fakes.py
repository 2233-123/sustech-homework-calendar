"""测试替身：模拟 requests.Session 的响应队列。"""
from __future__ import annotations


class FakeResponse:
    def __init__(self, status_code=200, text="", headers=None, json_data=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}
        self._json = json_data

    def json(self):
        if self._json is None:
            raise ValueError("该 FakeResponse 未提供 json_data")
        return self._json


class FakeCookie:
    def __init__(self, name, value):
        self.name = name
        self.value = value


class FakeSession:
    """按顺序返回预置响应，并记录所有请求。"""

    def __init__(self, responses=None, cookies=None):
        self._responses = list(responses or [])
        self.calls = []  # [(method, url, kwargs)]
        self.cookies = [FakeCookie(k, v) for k, v in (cookies or {}).items()]

    def _next(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if not self._responses:
            raise AssertionError(f"FakeSession 无更多预置响应：{method} {url}")
        return self._responses.pop(0)

    def get(self, url, **kwargs):
        return self._next("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self._next("POST", url, **kwargs)
