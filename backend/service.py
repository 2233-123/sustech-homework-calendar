"""服务层：认证状态机、凭据管理、同步编排。"""
from __future__ import annotations

import threading
from datetime import datetime

from backend import bb, config, dpapi
from backend.cas import InvalidCredentials, NetworkError

LOGIN_OK = "ok"
LOGIN_NEED = "need_login"
LOGIN_FAILED = "failed"


class NotAuthenticated(Exception):
    """尚未登录。"""


class SyncInProgress(Exception):
    """已有同步在进行。"""


class Service:
    """应用服务：线程安全地管理认证会话与同步。"""

    def __init__(self, db, bus, *, session_factory=None, fetch_fn=None, creds_path=None):
        self.db = db
        self.bus = bus
        self._session_factory = session_factory or bb.BBSession
        self._fetch_fn = fetch_fn or bb.fetch_assignments
        self._creds_path = creds_path or config.credentials_path()
        self._session = None
        self._session_lock = threading.Lock()
        self._sync_lock = threading.Lock()
        self._login_state = LOGIN_NEED
        self._last_sync = None
        self._offline = False

    # ---------- 凭据 ----------
    def load_credentials(self):
        p = self._creds_path
        if not p.exists():
            return None
        try:
            raw = dpapi.unprotect(p.read_bytes()).decode("utf-8")
        except (OSError, UnicodeDecodeError):
            return None
        if ":" not in raw:
            return None
        sid, _, password = raw.partition(":")
        return sid, password

    def save_credentials(self, sid: str, password: str) -> None:
        blob = dpapi.protect(f"{sid}:{password}".encode("utf-8"))
        self._creds_path.write_bytes(blob)

    def clear_credentials(self) -> None:
        try:
            self._creds_path.unlink(missing_ok=True)
        except OSError:
            pass

    # ---------- 认证 ----------
    @property
    def login_state(self) -> str:
        return self._login_state

    def is_authenticated(self) -> bool:
        return self._session is not None and self._login_state == LOGIN_OK

    def login(self, sid: str, password: str, remember: bool = True) -> bool:
        ok = self._login_with(sid, password)
        if ok and remember:
            self.save_credentials(sid, password)
        return ok

    def try_silent_login(self) -> bool:
        creds = self.load_credentials()
        if creds is None:
            self._set_login_state(LOGIN_NEED)
            return False
        try:
            return self._login_with(*creds)
        except NetworkError:
            self.bus.publish("error", {"code": "offline", "message": "网络不可达，无法静默登录"})
            return False

    def logout(self, clear_saved: bool = False) -> None:
        with self._session_lock:
            self._session = None
        if clear_saved:
            self.clear_credentials()
        self._set_login_state(LOGIN_NEED)

    def _login_with(self, sid: str, password: str) -> bool:
        session = self._session_factory(sid, password)
        try:
            bb.get_uid(session)
        except InvalidCredentials:
            self._set_login_state(LOGIN_FAILED)
            return False
        with self._session_lock:
            self._session = session
        self._set_login_state(LOGIN_OK)
        return True

    def _set_login_state(self, state: str) -> None:
        self._login_state = state
        self.bus.publish("login_changed", {"state": state})

    def _require_session(self):
        with self._session_lock:
            session = self._session
        if session is None:
            raise NotAuthenticated("尚未登录")
        return session

    # ---------- 同步 ----------
    def sync_now(self) -> dict:
        """执行一次全量同步；返回 {added, updated, removed, at}。"""
        if not self._sync_lock.acquire(blocking=False):
            raise SyncInProgress("同步进行中")
        try:
            session = self._require_session()
            started = datetime.now().isoformat(timespec="seconds")
            records = self._fetch_fn(session)
            added, updated = self.db.upsert_assignments(records)
            # 顺序不可颠倒：先 upsert 再 purge——同一秒内新写入的行（synced_at >= started）不会被误删，
            # 早于本次同步的行（BB 上已删除的作业）被清理。
            removed = self.db.purge_assignments_synced_before(started)
            at = datetime.now().isoformat(timespec="seconds")
            self._last_sync = at
            self._offline = False
            result = {"added": added, "updated": updated, "removed": removed, "at": at}
            self.bus.publish("sync_done", result)
            return result
        except NetworkError:
            self._offline = True
            self.bus.publish("error", {"code": "offline", "message": "网络不可达"})
            raise
        except bb.SessionExpired:
            self._set_login_state(LOGIN_NEED)
            raise
        except InvalidCredentials:
            self._set_login_state(LOGIN_FAILED)
            raise
        finally:
            self._sync_lock.release()

    def state(self) -> dict:
        return {
            "login": self._login_state,
            "syncing": self._sync_lock.locked(),
            "last_sync": self._last_sync,
            "offline": self._offline,
        }
