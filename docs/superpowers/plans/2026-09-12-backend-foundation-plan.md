# 作业日程小组件 — 后端基础层实施计划（阶段 1/4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现后端数据与网络基础层：配置路径、DPAPI 凭据加密、CAS 登录、Blackboard 客户端、SQLite 数据层 —— 全部离线单测通过。

**Architecture:** `backend/` 包内 5 个低耦合模块。所有网络调用通过「可注入的 session / 登录函数」实现，测试全程使用 FakeSession，不触网。数据层用标准库 sqlite3，单连接 + 线程锁。

**Tech Stack:** Python 3.11（`py -3.11`）、requests、pytest、ctypes（DPAPI）；Flask 本阶段仅安装（服务层用）。

**参考文档:** `docs/superpowers/specs/2026-09-12-作业日程小组件-design.md`

---

## 0. 执行环境与约定

- 仓库根目录：`E:\Desktop\作业日程`（所有命令在此执行）
- Python：本机存在 3.13 / 3.11 / 3.9，**统一用 `py -3.11`** 创建 venv。
  - 若 `py -3.11` 不可用，用完整路径：`C:\Users\wozai\AppData\Local\Programs\Python\Python311\python.exe`
- venv 建立后，所有 Python 命令一律使用 `.\.venv\Scripts\python`
- 测试命令：`.\.venv\Scripts\python -m pytest`（pytest.ini 已配置 testpaths）
- ⚠️ 所有测试必须**离线**运行，任何用例不得访问真实网络
- ⚠️ 不得修改设计决策。本计划中的代码为参考实现，允许为通过测试做等价微调，但**函数名、模块名、字段名必须保持一致**（后续阶段依赖这些接口）
- 提交粒度：每个 Task 一个 commit（若用户未授权提交，则跳过 commit 步骤）

## 0.1 计划路线图（共 4 阶段）

1. **本计划 → 后端基础层**：config / dpapi / cas / bb / db
2. 后端服务层：reminder 调度 / SSE 推送 / Flask API / 启动编排
3. 前端：日历 UI / SSE 客户端 / 提醒气泡 / 设置面板
4. Electron 外壳与打包

## 0.2 文件结构（本阶段完成后）

```
backend/
├── __init__.py            # 包标记（空）
├── config.py              # 路径与配置读写（%APPDATA%\作业日程）
├── dpapi.py               # Windows DPAPI 加解密（ctypes，无 pywin32 依赖）
├── cas.py                 # SUSTech CAS 三步登录
├── bb.py                  # Blackboard 会话 + REST 客户端 + 作业拉取
├── db.py                  # SQLite 数据层（日程/作业/设置/提醒日志）
└── tests/
    ├── __init__.py
    ├── fakes.py           # FakeSession / FakeResponse 测试替身
    ├── test_config.py
    ├── test_dpapi.py
    ├── test_cas.py
    ├── test_bb.py
    └── test_db.py
requirements.txt
pytest.ini
.gitignore
```

---

### Task 1: 项目骨架与依赖

**Files:**
- Create: `requirements.txt`
- Create: `pytest.ini`
- Create: `.gitignore`
- Create: `backend/__init__.py`（空）
- Create: `backend/tests/__init__.py`（空）

- [ ] **Step 1: 创建虚拟环境**

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python --version
```

Expected: `Python 3.11.x`（venv 创建无输出即成功）

- [ ] **Step 2: 写 requirements.txt**

```text
requests>=2.31
flask>=3.0
pytest>=7.4
```

- [ ] **Step 3: 安装依赖**

```powershell
.\.venv\Scripts\python -m pip install -U pip
.\.venv\Scripts\python -m pip install -r requirements.txt
```

Expected: `Successfully installed ... flask ... requests ... pytest ...`

- [ ] **Step 4: 写 pytest.ini**

```ini
[pytest]
testpaths = backend/tests
addopts = -q
```

- [ ] **Step 5: 写 .gitignore**

```text
.venv/
__pycache__/
*.pyc
.pytest_cache/
node_modules/
```

- [ ] **Step 6: 创建空包文件**

创建 `backend/__init__.py` 与 `backend/tests/__init__.py`（内容为空）。

- [ ] **Step 7: 提交**

```powershell
git add .gitignore requirements.txt pytest.ini backend
git commit -m "chore: 项目骨架与 Python 依赖"
```

---

### Task 2: config.py — 路径与配置

**Files:**
- Create: `backend/config.py`
- Test: `backend/tests/test_config.py`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_config.py`：

```python
import pytest

from backend import config


@pytest.fixture
def tmp_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    return tmp_path


def test_app_dir_created(tmp_appdata):
    d = config.app_dir()
    assert d.exists()
    assert d.name == "作业日程"
    assert str(tmp_appdata) in str(d)


def test_paths_under_app_dir(tmp_appdata):
    assert config.db_path().parent == config.app_dir()
    assert config.credentials_path().parent == config.app_dir()
    assert config.config_path().parent == config.app_dir()


def test_load_config_defaults_when_missing(tmp_appdata):
    cfg = config.load_config()
    assert cfg["refresh_interval_min"] == 30
    assert cfg["bb_remind_defaults"] == [1440, 120]
    assert cfg["bb_remind_enabled"] is True


def test_save_and_load_roundtrip(tmp_appdata):
    config.save_config({"refresh_interval_min": 5})
    cfg = config.load_config()
    assert cfg["refresh_interval_min"] == 5
    assert cfg["bb_remind_defaults"] == [1440, 120]


def test_save_config_ignores_unknown_keys(tmp_appdata):
    config.save_config({"hacker": True})
    assert "hacker" not in config.load_config()
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_config.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.config'`

- [ ] **Step 3: 写实现**

`backend/config.py`：

```python
"""应用配置与路径管理。

数据目录：%APPDATA%\\作业日程\\
"""
from __future__ import annotations

import json
import os
from pathlib import Path

APP_DIR_NAME = "作业日程"

DEFAULT_CONFIG = {
    "refresh_interval_min": 30,
    "bb_remind_defaults": [1440, 120],
    "bb_remind_enabled": True,
    "remind_popup": "inapp",
    "always_on_top": True,
    "opacity": 0.95,
    "autostart": False,
    "window_pos": None,
    "port": 0,
    "term_id": None,
}


def app_dir() -> Path:
    """数据目录：%APPDATA%/作业日程（不存在则创建）。"""
    base = os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / APP_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return app_dir() / "data.db"


def credentials_path() -> Path:
    return app_dir() / "credentials.bin"


def config_path() -> Path:
    return app_dir() / "config.json"


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    p = config_path()
    if p.exists():
        try:
            cfg.update(json.loads(p.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            pass
    return cfg


def save_config(cfg: dict) -> None:
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    config_path().write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )
```

- [ ] **Step 4: 运行确认通过**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_config.py
```

Expected: `5 passed`

- [ ] **Step 5: 提交**

```powershell
git add backend/config.py backend/tests/test_config.py
git commit -m "feat: 配置与路径模块"
```

---

### Task 3: dpapi.py — Windows DPAPI 加解密

**Files:**
- Create: `backend/dpapi.py`
- Test: `backend/tests/test_dpapi.py`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_dpapi.py`：

```python
import sys

import pytest

from backend import dpapi

requires_windows = pytest.mark.skipif(sys.platform != "win32", reason="仅 Windows")


@requires_windows
def test_roundtrip():
    data = "20231234:my-password".encode("utf-8")
    blob = dpapi.protect(data)
    assert blob != data
    assert dpapi.unprotect(blob) == data


@requires_windows
def test_tampered_blob_raises():
    blob = bytearray(dpapi.protect(b"secret"))
    blob[10] ^= 0xFF
    with pytest.raises(OSError):
        dpapi.unprotect(bytes(blob))
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_dpapi.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.dpapi'`

- [ ] **Step 3: 写实现**

`backend/dpapi.py`：

```python
"""Windows DPAPI 加解密（ctypes 实现，无需 pywin32）。

加密数据绑定当前 Windows 用户，仅本机同一用户可解密。
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes

_CRYPTPROTECT_UI_FORBIDDEN = 0x1
_crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _make_blob(data: bytes):
    """返回 (buffer, blob)。调用方必须持有 buffer 引用直到 API 调用结束。"""
    buf = (
        ctypes.create_string_buffer(data, len(data))
        if data
        else ctypes.create_string_buffer(1)
    )
    blob = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return buf, blob


def _take_blob(blob: _DataBlob) -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        _kernel32.LocalFree(ctypes.cast(blob.pbData, ctypes.c_void_p))


def protect(data: bytes) -> bytes:
    """用当前 Windows 用户凭据加密（DPAPI）。"""
    _buf, in_blob = _make_blob(data)
    out = _DataBlob()
    ok = _crypt32.CryptProtectData(
        ctypes.byref(in_blob), None, None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out),
    )
    if not ok:
        raise OSError(f"CryptProtectData 失败，错误码 {ctypes.get_last_error()}")
    return _take_blob(out)


def unprotect(data: bytes) -> bytes:
    """DPAPI 解密。"""
    _buf, in_blob = _make_blob(data)
    out = _DataBlob()
    ok = _crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out),
    )
    if not ok:
        raise OSError(f"CryptUnprotectData 失败，错误码 {ctypes.get_last_error()}")
    return _take_blob(out)
```

- [ ] **Step 4: 运行确认通过**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_dpapi.py
```

Expected: `2 passed`

- [ ] **Step 5: 提交**

```powershell
git add backend/dpapi.py backend/tests/test_dpapi.py
git commit -m "feat: Windows DPAPI 加解密模块"
```

---

### Task 4: cas.py — SUSTech CAS 登录

**Files:**
- Create: `backend/tests/fakes.py`
- Create: `backend/cas.py`
- Test: `backend/tests/test_cas.py`

- [ ] **Step 1: 写测试替身 fakes.py**

`backend/tests/fakes.py`：

```python
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
```

- [ ] **Step 2: 写失败测试**

`backend/tests/test_cas.py`：

```python
import pytest

from backend import cas
from backend.tests.fakes import FakeResponse, FakeSession

LOGIN_PAGE = '<html><input name="execution" value="e1s1" /></html>'


def test_login_success_extracts_execution_and_returns_cookies():
    sess = FakeSession(
        responses=[
            FakeResponse(200, text=LOGIN_PAGE),
            FakeResponse(302, headers={"Location": "https://cas.sustech.edu.cn/cas/login?ticket=ST-123"}),
            FakeResponse(200, text="ok"),
        ],
        cookies={"JSESSIONID": "abc", "BbRouter": "x"},
    )
    cookies = cas.login("12345", "pwd", session=sess)
    assert cookies == {"JSESSIONID": "abc", "BbRouter": "x"}
    method, url, kwargs = sess.calls[1]
    assert method == "POST"
    assert kwargs["allow_redirects"] is False
    assert kwargs["data"]["username"] == "12345"
    assert kwargs["data"]["password"] == "pwd"
    assert kwargs["data"]["execution"] == "e1s1"
    assert kwargs["data"]["_eventId"] == "submit"


def test_wrong_password_raises_invalid_credentials():
    sess = FakeSession(responses=[
        FakeResponse(200, text=LOGIN_PAGE),
        FakeResponse(302, headers={"Location": "https://cas.sustech.edu.cn/cas/login?error=1"}),
    ])
    with pytest.raises(cas.InvalidCredentials):
        cas.login("12345", "bad", session=sess)


def test_missing_execution_raises_network_error():
    sess = FakeSession(responses=[FakeResponse(200, text="<html>维护中</html>")])
    with pytest.raises(cas.NetworkError):
        cas.login("12345", "pwd", session=sess)


def test_non_redirect_response_raises_network_error():
    sess = FakeSession(responses=[
        FakeResponse(200, text=LOGIN_PAGE),
        FakeResponse(200, text="<html>验证码错误</html>"),
    ])
    with pytest.raises(cas.NetworkError):
        cas.login("12345", "pwd", session=sess)


def test_service_url_encoded_in_login_url():
    sess = FakeSession(responses=[
        FakeResponse(200, text=LOGIN_PAGE),
        FakeResponse(302, headers={"Location": "https://cas.sustech.edu.cn/cas/login?ticket=ST-1"}),
        FakeResponse(200, text="ok"),
    ])
    cas.login("12345", "pwd", session=sess)
    first_url = sess.calls[0][1]
    assert "service=https%3A%2F%2Fbb.sustech.edu.cn%2Fwebapps%2Fbb-sso-BBLEARN%2Findex.jsp" in first_url
```

- [ ] **Step 3: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_cas.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.cas'`

- [ ] **Step 4: 写实现**

`backend/cas.py`：

```python
"""SUSTech CAS 登录（纯 requests 三步流程，禁止浏览器自动化）。

流程：
1. GET  https://cas.sustech.edu.cn/cas/login?service=<编码后的 SERVICE_URL>
     → 正则提取隐藏字段 execution
2. POST 同一 URL（allow_redirects=False）表单：
     username / password / execution / _eventId=submit / submit=提交
     → 期望 302/303；Location 含 cas 且无 ticket ⇒ 账号密码错误
3. GET  Location（跟随重定向）→ 收集 cookie jar
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


def login(sid: str, password: str, session=None, timeout: int = TIMEOUT) -> dict:
    """执行 CAS 登录，成功返回 cookie 字典。"""
    sess = session if session is not None else requests.Session()
    cas_url = f"{CAS_BASE}?service={quote(BB_SERVICE_URL, safe='')}"
    headers = {"User-Agent": UA}

    try:
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
    except requests.RequestException as e:
        raise NetworkError(f"网络请求失败：{e}") from e

    if r2.status_code not in (302, 303):
        raise NetworkError(f"CAS 响应异常：HTTP {r2.status_code}")

    loc = r2.headers.get("Location", "")
    if not loc:
        raise NetworkError("CAS 响应缺少 Location 头")
    if "cas.sustech.edu.cn" in loc and "ticket" not in loc:
        raise InvalidCredentials("CAS 拒绝了凭据：账号或密码错误")

    try:
        sess.get(loc, headers=headers, timeout=timeout, allow_redirects=True)
    except requests.RequestException as e:
        raise NetworkError(f"ticket 交换失败：{e}") from e

    return {c.name: c.value for c in sess.cookies if c.value}
```

- [ ] **Step 5: 运行确认通过**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_cas.py
```

Expected: `5 passed`

- [ ] **Step 6: 提交**

```powershell
git add backend/cas.py backend/tests/fakes.py backend/tests/test_cas.py
git commit -m "feat: CAS 登录模块与测试替身"
```

---

### Task 5: bb.py — 会话层（TTL + 401 自动重登）

**Files:**
- Create: `backend/bb.py`
- Test: `backend/tests/test_bb.py`

- [ ] **Step 1: 写失败测试（会话部分）**

`backend/tests/test_bb.py`：

```python
import pytest

from backend import bb, cas
from backend.tests.fakes import FakeResponse, FakeSession


def fake_login(sid, pwd, session=None):
    return {"JSESSIONID": "j1"}


def make_bb(http, **kwargs):
    return bb.BBSession("12345", "pwd", http=http, login_fn=fake_login, **kwargs)


def test_first_get_logs_in_and_sends_cookies():
    http = FakeSession(responses=[FakeResponse(200)])
    s = make_bb(http=http)
    r = s.get("/learn/api/public/v1/users/me")
    assert r.status_code == 200
    _, url, kwargs = http.calls[0]
    assert url == "https://bb.sustech.edu.cn/learn/api/public/v1/users/me"
    assert kwargs["cookies"] == {"JSESSIONID": "j1"}
    assert kwargs["headers"]["User-Agent"] == cas.UA


def test_ttl_expiry_relogins():
    now = [1000.0]
    http = FakeSession(responses=[FakeResponse(200), FakeResponse(200)])
    logins = []

    def counting_login(sid, pwd, session=None):
        logins.append(1)
        return {"J": str(len(logins))}

    s = bb.BBSession("a", "b", http=http, login_fn=counting_login, clock=lambda: now[0])
    s.get("/x")
    assert len(logins) == 1
    now[0] += bb.SESSION_TTL + 1
    s.get("/x")
    assert len(logins) == 2


def test_401_relogins_and_retries_once():
    now = [1000.0]
    http = FakeSession(responses=[FakeResponse(401), FakeResponse(200)])
    logins = []

    def counting_login(sid, pwd, session=None):
        logins.append(1)
        return {"J": str(len(logins))}

    s = bb.BBSession("a", "b", http=http, login_fn=counting_login, clock=lambda: now[0])
    r = s.get("/x")
    assert r.status_code == 200
    assert len(logins) == 2  # 首次 ensure 1 次 + 401 重登 1 次
    assert len(http.calls) == 2


def test_get_json_raises_session_expired_when_still_401():
    http = FakeSession(responses=[FakeResponse(401), FakeResponse(401)])
    s = make_bb(http=http)
    with pytest.raises(bb.SessionExpired):
        s.get_json("/x")


def test_get_json_raises_network_error_on_500():
    http = FakeSession(responses=[FakeResponse(500)])
    s = make_bb(http=http)
    with pytest.raises(cas.NetworkError):
        s.get_json("/x")
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_bb.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.bb'`

- [ ] **Step 3: 写实现（会话部分）**

`backend/bb.py`：

```python
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
    """内存会话：HTTP 层与登录函数可注入（测试用 FakeSession）。"""

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
        return r.json()
```

- [ ] **Step 4: 运行确认通过**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_bb.py
```

Expected: `5 passed`

- [ ] **Step 5: 提交**

```powershell
git add backend/bb.py backend/tests/test_bb.py
git commit -m "feat: Blackboard 会话层（TTL/401 重登）"
```

---

### Task 6: bb.py — 接口客户端与作业拉取

**Files:**
- Modify: `backend/bb.py`（追加函数）
- Modify: `backend/tests/test_bb.py`（追加测试）

- [ ] **Step 1: 追加失败测试**

在 `backend/tests/test_bb.py` **末尾追加**：

```python
# ---------- 工具函数 ----------

def test_normalize_bb_id():
    assert bb.normalize_bb_id("_8343_1") == "8343"
    assert bb.normalize_bb_id("_610795_1") == "610795"
    assert bb.normalize_bb_id("8343") == "8343"


def test_utc_iso_to_local_iso_preserves_instant():
    from datetime import datetime, timezone

    out = bb.utc_iso_to_local_iso("2026-03-25T15:59:00.000Z")
    dt_local = datetime.fromisoformat(out)
    dt_utc = datetime(2026, 3, 25, 15, 59, tzinfo=timezone.utc)
    assert dt_local.astimezone() == dt_utc


def test_utc_iso_to_local_iso_empty():
    assert bb.utc_iso_to_local_iso("") is None
    assert bb.utc_iso_to_local_iso(None) is None


# ---------- 作业拉取 ----------

COLUMNS = {
    "results": [
        {
            "id": "col1",
            "name": "实验报告",
            "contentId": "_610795_1",
            "score": {"possible": 100},
            "grading": {"type": "Attempts", "due": "2026-03-25T15:59:00.000Z"},
        },
        {"id": "col2", "name": "期中考试", "grading": {"type": "Numeric"}},
    ]
}


def test_fetch_assignments_parses_and_filters():
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),                                     # users/me
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),             # enrollments
        FakeResponse(200, json_data={"name": "操作系统"}),                                # course detail
        FakeResponse(200, json_data=COLUMNS),                                             # columns
        FakeResponse(200, json_data={"results": [{"status": "Completed", "score": 95}]}), # attempts
    ])
    s = make_bb(http=http)
    records = bb.fetch_assignments(s)
    assert len(records) == 1
    rec = records[0]
    assert rec["course_id"] == "8343"
    assert rec["course_name"] == "操作系统"
    assert rec["content_id"] == "610795"
    assert rec["title"] == "实验报告"
    assert rec["submitted"] == 1
    assert rec["status"] == "Completed"
    assert rec["score"] == 95
    assert rec["possible"] == 100
    assert rec["due_at"] is not None


def test_fetch_assignments_skips_failing_course():
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),                                     # users/me
        FakeResponse(200, json_data={"results": [{"courseId": "_A_1"}, {"courseId": "_B_1"}]}),
        FakeResponse(200, json_data={"name": "课程A"}),                                   # A detail
        FakeResponse(200, json_data={"name": "课程B"}),                                   # B detail
        FakeResponse(500),                                                                # A 的 columns 失败
        FakeResponse(200, json_data=COLUMNS),                                             # B 的 columns
        FakeResponse(200, json_data={"results": []}),                                     # B 的 attempts
    ])
    s = make_bb(http=http)
    records = bb.fetch_assignments(s)
    assert [r["course_name"] for r in records] == ["课程B"]
    assert records[0]["submitted"] == 0
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_bb.py
```

Expected: FAIL —— `AttributeError: type object 'BBSession' has no attribute 'normalize_bb_id'`（或同类）

- [ ] **Step 3: 在 bb.py 末尾追加实现**

```python
def normalize_bb_id(bb_id: str) -> str:
    """BB 资源 ID 规范化：'_8343_1' → '8343'。"""
    return bb_id.strip().lstrip("_").removesuffix("_1")


def utc_iso_to_local_iso(due_utc: str | None) -> str | None:
    """BB 的 UTC ISO 时间 → 本地 'YYYY-MM-DDTHH:MM:SS'；空值返回 None。"""
    if not due_utc:
        return None
    dt = datetime.fromisoformat(due_utc.replace("Z", "+00:00"))
    return dt.astimezone().strftime("%Y-%m-%dT%H:%M:%S")


def get_uid(bb: "BBSession") -> str:
    return bb.get_json("/learn/api/public/v1/users/me")["id"]


def get_courses(bb: "BBSession") -> list:
    """在修课程列表 → [{'id': 原始ID, 'name': 课程名}]。"""
    uid = get_uid(bb)
    data = bb.get_json(f"/learn/api/public/v1/users/{uid}/courses")
    courses = []
    for entry in data.get("results", []):
        cid = entry.get("courseId") or ""
        if not cid:
            continue
        try:
            detail = bb.get_json(f"/learn/api/public/v1/courses/{cid}")
            name = detail.get("name") or cid
        except NetworkError:
            name = cid
        courses.append({"id": cid, "name": name})
    return courses


def get_assignment_columns(bb: "BBSession", course_id: str) -> list:
    """课程的作业型评分列（grading.type == 'Attempts'，带截止时间）。"""
    data = bb.get_json(
        f"/learn/api/public/v1/courses/{course_id}/gradebook/columns",
        params={"_fields": "id,name,contentId,score,grading"},
    )
    out = []
    for col in data.get("results", []):
        grading = col.get("grading") or {}
        if grading.get("type") != "Attempts":
            continue
        out.append({
            "column_id": col.get("id", ""),
            "title": col.get("name", ""),
            "content_id": col.get("contentId") or "",
            "due_utc": grading.get("due") or "",
            "possible": (col.get("score") or {}).get("possible"),
        })
    return out


def get_attempts(bb: "BBSession", course_id: str, column_id: str) -> list:
    data = bb.get_json(
        f"/learn/api/public/v1/courses/{course_id}/gradebook/columns/{column_id}/attempts"
    )
    return data.get("results", [])


def fetch_assignments(bb: "BBSession") -> list:
    """拉取所有课程作业并归一化；单课程失败不影响其它课程。"""
    records = []
    for course in get_courses(bb):
        try:
            for col in get_assignment_columns(bb, course["id"]):
                attempts = get_attempts(bb, course["id"], col["column_id"])
                latest = attempts[-1] if attempts else None
                records.append({
                    "course_id": normalize_bb_id(course["id"]),
                    "course_name": course["name"],
                    "content_id": normalize_bb_id(col["content_id"] or col["column_id"]),
                    "title": col["title"],
                    "due_at": utc_iso_to_local_iso(col["due_utc"]),
                    "submitted": 1 if attempts else 0,
                    "status": (latest or {}).get("status"),
                    "score": (latest or {}).get("score"),
                    "possible": col["possible"],
                })
        except (SessionExpired, NetworkError) as e:
            print(f"[sync] 跳过课程 {course['id']}: {e}")
            continue
    return records
```

同时确认 `bb.py` 顶部已 `from datetime import datetime`（Task 5 未引入，需在 import 区加入）：

```python
from datetime import datetime
```

- [ ] **Step 4: 运行确认通过**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_bb.py
```

Expected: `10 passed`

- [ ] **Step 5: 提交**

```powershell
git add backend/bb.py backend/tests/test_bb.py
git commit -m "feat: Blackboard 作业拉取客户端"
```

---

### Task 7: db.py — SQLite 数据层

**Files:**
- Create: `backend/db.py`
- Test: `backend/tests/test_db.py`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_db.py`：

```python
from backend import db


def make_db(tmp_path):
    return db.Database(tmp_path / "test.db")


def test_schedule_crud(tmp_path):
    d = make_db(tmp_path)
    sid = d.add_schedule(title="小组会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    assert sid == 1
    row = d.get_schedule(sid)
    assert row["title"] == "小组会议"
    assert row["remind_before"] == 1800
    d.update_schedule(sid, title="组会", start_at="2026-09-12T15:00:00")
    assert d.get_schedule(sid)["title"] == "组会"
    d.delete_schedule(sid)
    assert d.get_schedule(sid) is None


def test_list_schedules_range(tmp_path):
    d = make_db(tmp_path)
    d.add_schedule(title="a", start_at="2026-09-10T10:00:00")
    d.add_schedule(title="b", start_at="2026-09-12T10:00:00")
    rows = d.list_schedules("2026-09-11T00:00:00", "2026-09-13T00:00:00")
    assert [r["title"] for r in rows] == ["b"]


def test_upsert_assignments_dedup(tmp_path):
    d = make_db(tmp_path)
    rec = {
        "course_id": "8343", "course_name": "OS", "content_id": "610795",
        "title": "实验1", "due_at": "2026-09-20T23:59:00",
        "submitted": 0, "status": None, "score": None, "possible": 100,
    }
    d.upsert_assignments([rec])
    rec2 = dict(rec, title="实验1(改)", submitted=1, status="Completed", score=95.0)
    d.upsert_assignments([rec2])
    rows = d.list_assignments("2026-09-01T00:00:00", "2026-10-01T00:00:00")
    assert len(rows) == 1
    assert rows[0]["title"] == "实验1(改)"
    assert rows[0]["submitted"] == 1
    assert rows[0]["score"] == 95.0


def test_list_assignments_excludes_null_due(tmp_path):
    d = make_db(tmp_path)
    d.upsert_assignments([{
        "course_id": "1", "course_name": "X", "content_id": "2", "title": "无截止",
        "due_at": None, "submitted": 0, "status": None, "score": None, "possible": None,
    }])
    assert d.list_assignments("2026-01-01T00:00:00", "2027-01-01T00:00:00") == []


def test_settings(tmp_path):
    d = make_db(tmp_path)
    assert d.get_setting("missing", "def") == "def"
    d.set_setting("a", 1)
    assert d.get_setting("a") == 1
    d.set_setting("b", {"x": [1, 2]})
    assert d.get_setting("b") == {"x": [1, 2]}


def test_reminder_log(tmp_path):
    d = make_db(tmp_path)
    assert not d.was_fired("schedule", 1, 1800)
    d.mark_fired("schedule", 1, 1800)
    assert d.was_fired("schedule", 1, 1800)
    d.mark_fired("schedule", 1, 1800)  # 重复写入应幂等
    assert d.was_fired("schedule", 1, 1800)
    assert not d.was_fired("schedule", 1, 60)
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_db.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.db'`

- [ ] **Step 3: 写实现**

`backend/db.py`：

```python
"""SQLite 数据层：日程 / 作业缓存 / 设置 / 提醒日志。

时间统一存本地 ISO 字符串 'YYYY-MM-DDTHH:MM:SS'（字典序即时间序）。
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  note          TEXT,
  start_at      TEXT    NOT NULL,
  end_at        TEXT,
  all_day       INTEGER NOT NULL DEFAULT 0,
  remind_before INTEGER,
  color         TEXT,
  created_at    TEXT,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS assignment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   TEXT NOT NULL,
  course_name TEXT,
  content_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  due_at      TEXT,
  submitted   INTEGER,
  status      TEXT,
  score       REAL,
  possible    REAL,
  synced_at   TEXT,
  UNIQUE(course_id, content_id)
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS reminder_log (
  kind       TEXT    NOT NULL,
  ref_id     INTEGER NOT NULL,
  offset_sec INTEGER NOT NULL,
  fired_at   TEXT    NOT NULL,
  UNIQUE(kind, ref_id, offset_sec)
);

CREATE INDEX IF NOT EXISTS idx_schedule_start ON schedule(start_at);
CREATE INDEX IF NOT EXISTS idx_assignment_due ON assignment(due_at);
"""

_SCHEDULE_FIELDS = ("title", "note", "start_at", "end_at", "all_day", "remind_before", "color")


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class Database:
    def __init__(self, path):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ---------- 日程 ----------
    def add_schedule(self, *, title, start_at, end_at=None, all_day=0,
                     remind_before=None, note=None, color=None) -> int:
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO schedule"
                " (title, note, start_at, end_at, all_day, remind_before, color, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (title, note, start_at, end_at, all_day, remind_before, color, _now(), _now()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def update_schedule(self, sid: int, **fields) -> None:
        updates = {k: v for k, v in fields.items() if k in _SCHEDULE_FIELDS}
        if not updates:
            return
        updates["updated_at"] = _now()
        sets = ", ".join(f"{k}=?" for k in updates)
        with self._lock:
            self._conn.execute(f"UPDATE schedule SET {sets} WHERE id=?", (*updates.values(), sid))
            self._conn.commit()

    def delete_schedule(self, sid: int) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM schedule WHERE id=?", (sid,))
            self._conn.commit()

    def get_schedule(self, sid: int):
        with self._lock:
            row = self._conn.execute("SELECT * FROM schedule WHERE id=?", (sid,)).fetchone()
        return dict(row) if row else None

    def list_schedules(self, start: str, end: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM schedule WHERE start_at >= ? AND start_at < ? ORDER BY start_at",
                (start, end),
            ).fetchall()
        return [dict(r) for r in rows]

    # ---------- 作业 ----------
    def upsert_assignments(self, records: list) -> int:
        ts = _now()
        with self._lock:
            for rec in records:
                self._conn.execute(
                    "INSERT INTO assignment"
                    " (course_id, course_name, content_id, title, due_at, submitted, status, score, possible, synced_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(course_id, content_id) DO UPDATE SET"
                    "   course_name=excluded.course_name, title=excluded.title, due_at=excluded.due_at,"
                    "   submitted=excluded.submitted, status=excluded.status, score=excluded.score,"
                    "   possible=excluded.possible, synced_at=excluded.synced_at",
                    (
                        rec["course_id"], rec.get("course_name"), rec["content_id"], rec["title"],
                        rec.get("due_at"), rec.get("submitted"), rec.get("status"),
                        rec.get("score"), rec.get("possible"), ts,
                    ),
                )
            self._conn.commit()
        return len(records)

    def list_assignments(self, start: str, end: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM assignment WHERE due_at IS NOT NULL"
                " AND due_at >= ? AND due_at < ? ORDER BY due_at",
                (start, end),
            ).fetchall()
        return [dict(r) for r in rows]

    # ---------- 设置 ----------
    def get_setting(self, key: str, default=None):
        with self._lock:
            row = self._conn.execute("SELECT value FROM setting WHERE key=?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            return row["value"]

    def set_setting(self, key: str, value) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO setting (key, value) VALUES (?,?)"
                " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value, ensure_ascii=False)),
            )
            self._conn.commit()

    # ---------- 提醒日志 ----------
    def was_fired(self, kind: str, ref_id: int, offset_sec: int) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM reminder_log WHERE kind=? AND ref_id=? AND offset_sec=?",
                (kind, ref_id, offset_sec),
            ).fetchone()
        return row is not None

    def mark_fired(self, kind: str, ref_id: int, offset_sec: int, fired_at: str | None = None) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO reminder_log (kind, ref_id, offset_sec, fired_at) VALUES (?,?,?,?)",
                (kind, ref_id, offset_sec, fired_at or _now()),
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
```

- [ ] **Step 4: 运行确认通过**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_db.py
```

Expected: `6 passed`

- [ ] **Step 5: 全量回归**

```powershell
.\.venv\Scripts\python -m pytest
```

Expected: 全部通过（约 28 个用例）

- [ ] **Step 6: 提交**

```powershell
git add backend/db.py backend/tests/test_db.py
git commit -m "feat: SQLite 数据层"
```

---

## 验收标准（阶段 1 完成标志）

1. `.\.venv\Scripts\python -m pytest` 全绿，且**全程无网络访问**
2. 模块接口与设计文档一致：`config` / `dpapi` / `cas` / `bb` / `db` 的公开函数与字段名不得偏离本计划
3. `git log` 可见对应提交（如获提交授权）

## 附：阶段 2 预告（后端服务层）

- `backend/reminder.py`：候选提醒计算（日程 `start_at - remind_before`；作业 `due_at - offset`）+ `reminder_log` 去重 + 24h 补发
- `backend/events.py`：SSE 事件总线（订阅者队列 + 心跳）
- `backend/app.py`：Flask 路由（见设计文档 §6.5）+ 静态托管
- `backend/main.py`：启动编排（读凭据 → 静默登录 → 首次同步 → 调度线程）
