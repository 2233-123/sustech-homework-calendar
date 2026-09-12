import pytest

from backend.bb import SessionExpired
from backend.cas import InvalidCredentials, NetworkError
from backend.service import (
    LOGIN_FAILED,
    LOGIN_NEED,
    LOGIN_OK,
    NotAuthenticated,
    Service,
    SyncInProgress,
)
from backend.tests.service_fakes import (
    FakeBBSession,
    failing_session_factory,
    make_service,
)


def test_login_success_saves_credentials(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    assert svc.login("20231234", "pw", remember=True) is True
    assert svc.login_state == LOGIN_OK
    assert svc.load_credentials() == ("20231234", "pw")


def test_login_invalid_credentials_sets_failed(tmp_path, monkeypatch):
    svc, db, bus = make_service(
        tmp_path, monkeypatch,
        session_factory=failing_session_factory(InvalidCredentials("bad")),
    )
    q = bus.subscribe()
    assert svc.login("u", "wrong", remember=False) is False
    assert svc.login_state == LOGIN_FAILED
    assert svc.load_credentials() is None
    assert "login_changed" in q.get_nowait()


def test_silent_login_uses_saved_credentials(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    svc.save_credentials("u", "p")
    svc2 = Service(db, bus, session_factory=FakeBBSession, fetch_fn=lambda s: [])
    assert svc2.try_silent_login() is True
    assert svc2.login_state == LOGIN_OK


def test_silent_login_without_credentials(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    assert svc.try_silent_login() is False
    assert svc.login_state == LOGIN_NEED


def test_sync_now_upserts_publishes_and_returns_counts(tmp_path, monkeypatch):
    records = [{
        "course_id": "1", "course_name": "OS", "content_id": "2", "title": "实验1",
        "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }]
    svc, db, bus = make_service(tmp_path, monkeypatch, fetch_fn=lambda session: records)
    svc.login("u", "p", remember=False)
    q = bus.subscribe()
    result = svc.sync_now()
    assert (result["added"], result["updated"]) == (1, 0)
    assert result["at"] is not None
    assert db.list_assignments("2026-09-01T00:00:00", "2026-10-01T00:00:00")[0]["title"] == "实验1"
    second = svc.sync_now()
    assert (second["added"], second["updated"]) == (0, 1)
    msgs = []
    while not q.empty():
        msgs.append(q.get_nowait())
    assert any("sync_done" in m for m in msgs)


def test_sync_now_offline_sets_flag_and_event(tmp_path, monkeypatch):
    def boom(session):
        raise NetworkError("down")

    svc, db, bus = make_service(tmp_path, monkeypatch, fetch_fn=boom)
    svc.login("u", "p", remember=False)
    q = bus.subscribe()
    with pytest.raises(NetworkError):
        svc.sync_now()
    assert svc.state()["offline"] is True
    assert "offline" in q.get_nowait()


def test_sync_now_requires_login(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    with pytest.raises(NotAuthenticated):
        svc.sync_now()


def test_sync_now_rejects_concurrent_sync(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    svc.login("u", "p", remember=False)
    svc._sync_lock.acquire()
    try:
        with pytest.raises(SyncInProgress):
            svc.sync_now()
    finally:
        svc._sync_lock.release()


def test_logout_clears_session_and_optional_credentials(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    svc.login("u", "p", remember=True)
    svc.logout(clear_saved=True)
    assert svc.login_state == LOGIN_NEED
    assert svc.load_credentials() is None
    with pytest.raises(NotAuthenticated):
        svc.sync_now()


def test_login_network_error_propagates(tmp_path, monkeypatch):
    svc, db, bus = make_service(
        tmp_path, monkeypatch,
        session_factory=failing_session_factory(NetworkError("down")),
    )
    with pytest.raises(NetworkError):
        svc.login("u", "p", remember=False)


def test_silent_login_network_error_sets_offline_and_event(tmp_path, monkeypatch):
    svc, db, bus = make_service(
        tmp_path, monkeypatch,
        session_factory=failing_session_factory(NetworkError("down")),
    )
    svc.save_credentials("u", "p")
    q = bus.subscribe()
    assert svc.try_silent_login() is False
    assert svc.state()["offline"] is True
    assert "offline" in q.get_nowait()


def test_silent_login_session_expired_resets_to_need_login(tmp_path, monkeypatch):
    svc, db, bus = make_service(
        tmp_path, monkeypatch,
        session_factory=failing_session_factory(SessionExpired("dead")),
    )
    svc.save_credentials("u", "p")
    assert svc.try_silent_login() is False
    assert svc.login_state == LOGIN_NEED


def test_sync_session_expired_requires_relogin(tmp_path, monkeypatch):
    def boom(session):
        raise SessionExpired("dead")

    svc, db, bus = make_service(tmp_path, monkeypatch, fetch_fn=boom)
    svc.login("u", "p", remember=False)
    with pytest.raises(SessionExpired):
        svc.sync_now()
    assert svc.login_state == LOGIN_NEED
    with pytest.raises(NotAuthenticated):
        svc.sync_now()


def test_sync_invalid_credentials_marks_failed(tmp_path, monkeypatch):
    def boom(session):
        raise InvalidCredentials("bad")

    svc, db, bus = make_service(tmp_path, monkeypatch, fetch_fn=boom)
    svc.login("u", "p", remember=False)
    with pytest.raises(InvalidCredentials):
        svc.sync_now()
    assert svc.login_state == LOGIN_FAILED


def test_sync_now_empty_fetch_keeps_cache(tmp_path, monkeypatch):
    records = [{
        "course_id": "1", "course_name": "OS", "content_id": "2", "title": "实验1",
        "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }]
    calls = {"n": 0}

    def fetch(session):
        calls["n"] += 1
        return records if calls["n"] == 1 else []

    svc, db, bus = make_service(tmp_path, monkeypatch, fetch_fn=fetch)
    svc.login("u", "p", remember=False)
    svc.sync_now()
    result = svc.sync_now()
    assert result["removed"] == 0
    assert len(db.list_assignments("2026-09-01T00:00:00", "2026-10-01T00:00:00")) == 1


def test_failed_relogin_clears_previous_session(tmp_path, monkeypatch):
    calls = {"n": 0}

    class FlakyFactory(FakeBBSession):
        def get_json(self, path, params=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return {"id": "_1_1"}
            raise InvalidCredentials("bad")

    svc, db, bus = make_service(tmp_path, monkeypatch, session_factory=FlakyFactory)
    svc.login("u", "p", remember=False)
    assert svc.login("u", "wrong", remember=False) is False
    assert svc.login_state == LOGIN_FAILED
    with pytest.raises(NotAuthenticated):
        svc.sync_now()
