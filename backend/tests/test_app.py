from backend.app import create_app
from backend.bb import SessionExpired
from backend.cas import InvalidCredentials
from backend.tests.service_fakes import failing_session_factory, make_service


def make_client(tmp_path, monkeypatch, *, fetch_fn=None, session_factory=None):
    svc, db, bus = make_service(
        tmp_path, monkeypatch, fetch_fn=fetch_fn, session_factory=session_factory
    )
    app = create_app(svc, bus, frontend_dir=tmp_path / "no_frontend")
    app.testing = True
    return app.test_client(), svc, db, bus


def _text(item):
    return item.decode("utf-8") if isinstance(item, bytes) else item


def test_state_endpoint(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.get("/api/state")
    assert rv.status_code == 200
    data = rv.get_json()
    assert data["login"] == "need_login"
    assert data["offline"] is False


def test_login_endpoint_ok(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/auth/login", json={"sid": "u", "password": "p", "remember": False})
    assert rv.status_code == 200
    assert rv.get_json()["ok"] is True
    assert svc.login_state == "ok"


def test_login_endpoint_bad_request(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/auth/login", json={"sid": "u"})
    assert rv.status_code == 400
    assert rv.get_json()["error"] == "bad_request"


def test_login_endpoint_invalid_credentials(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(
        tmp_path, monkeypatch,
        session_factory=failing_session_factory(InvalidCredentials("bad")),
    )
    rv = client.post("/api/auth/login", json={"sid": "u", "password": "wrong"})
    assert rv.status_code == 401
    assert rv.get_json()["error"] == "invalid_credentials"


def test_schedule_crud_flow(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/schedule", json={
        "title": "小组会议", "start_at": "2026-09-12T14:00:00", "remind_before": 1800,
    })
    assert rv.status_code == 201
    sid = rv.get_json()["id"]
    rv = client.get("/api/day?date=2026-09-12")
    assert [s["title"] for s in rv.get_json()["schedules"]] == ["小组会议"]
    assert client.put(f"/api/schedule/{sid}", json={"title": "组会"}).status_code == 200
    rv = client.get("/api/day?date=2026-09-12")
    assert [s["title"] for s in rv.get_json()["schedules"]] == ["组会"]
    assert client.delete(f"/api/schedule/{sid}").status_code == 200
    assert client.delete(f"/api/schedule/{sid}").status_code == 404


def test_calendar_range(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    client.post("/api/schedule", json={"title": "本月", "start_at": "2026-09-12T10:00:00"})
    client.post("/api/schedule", json={"title": "下月", "start_at": "2026-10-03T10:00:00"})
    rv = client.get("/api/calendar?year=2026&month=9")
    assert [s["title"] for s in rv.get_json()["schedules"]] == ["本月"]


def test_settings_get_and_put(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.get("/api/settings")
    assert rv.get_json()["refresh_interval_min"] == 30
    rv = client.put("/api/settings", json={"refresh_interval_min": 5, "hacker": True})
    assert rv.status_code == 200
    data = rv.get_json()
    assert data["refresh_interval_min"] == 5
    assert "hacker" not in data


def test_sync_endpoint_auth_and_result(tmp_path, monkeypatch):
    records = [{
        "course_id": "1", "course_name": "OS", "content_id": "2", "title": "实验1",
        "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }]
    client, svc, db, bus = make_client(tmp_path, monkeypatch, fetch_fn=lambda s, months: records)
    rv = client.post("/api/sync")
    assert rv.status_code == 401
    assert rv.get_json()["error"] == "not_authenticated"
    client.post("/api/auth/login", json={"sid": "u", "password": "p", "remember": False})
    rv = client.post("/api/sync")
    assert rv.status_code == 200
    body = rv.get_json()
    assert body["ok"] is True and body["added"] == 1


def test_events_streams(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.get("/api/events")
    assert rv.status_code == 200
    assert rv.mimetype == "text/event-stream"
    it = iter(rv.response)
    assert _text(next(it)) == ": connected\n\n"
    bus.publish("sync_done", {"added": 1})
    assert "sync_done" in _text(next(it))
    it.close()


def test_root_placeholder(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.get("/")
    assert rv.status_code == 200
    assert "后端运行中" in rv.get_data(as_text=True)


def test_schedule_create_rejects_invalid_fields(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/schedule", json={"title": "x", "start_at": "not-a-date"})
    assert rv.status_code == 400
    assert rv.get_json()["error"] == "bad_request"
    rv = client.post("/api/schedule", json={
        "title": "x", "start_at": "2026-09-12T10:00:00", "remind_before": "abc",
    })
    assert rv.status_code == 400
    assert rv.get_json()["error"] == "bad_request"


def test_schedule_update_rejects_bad_start_at(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/schedule", json={"title": "x", "start_at": "2026-09-12T10:00:00"})
    sid = rv.get_json()["id"]
    rv = client.put(f"/api/schedule/{sid}", json={"start_at": "oops"})
    assert rv.status_code == 400
    assert rv.get_json()["error"] == "bad_request"


def test_schedule_create_rejects_bad_all_day(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/schedule", json={
        "title": "x", "start_at": "2026-09-12T10:00:00", "all_day": "abc",
    })
    assert rv.status_code == 400
    rv = client.post("/api/schedule", json={
        "title": "x", "start_at": "2026-09-12T10:00:00", "all_day": None,
    })
    assert rv.status_code == 201


def test_non_dict_body_returns_400(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    assert client.post("/api/schedule", json=[1, 2, 3]).status_code == 400
    assert client.post("/api/auth/login", json=42).status_code == 400
    assert client.put("/api/settings", json=["x"]).status_code == 400


def test_login_endpoint_session_expired(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(
        tmp_path, monkeypatch,
        session_factory=failing_session_factory(SessionExpired("dead")),
    )
    rv = client.post("/api/auth/login", json={"sid": "u", "password": "p"})
    assert rv.status_code == 401
    assert rv.get_json()["error"] == "session_expired"


def test_calendar_and_day_overflow_bounds(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    assert client.get("/api/calendar?year=9999&month=12").status_code == 400
    assert client.get("/api/day?date=9999-12-31").status_code == 400


def test_schedule_update_validates_and_coerces(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/schedule", json={"title": "x", "start_at": "2026-09-12T10:00:00"})
    sid = rv.get_json()["id"]
    assert client.put(f"/api/schedule/{sid}", json={"title": None}).status_code == 400
    assert client.put(f"/api/schedule/{sid}", json={"all_day": "abc"}).status_code == 400
    rv = client.put(f"/api/schedule/{sid}", json={"all_day": "1", "remind_before": "600"})
    assert rv.status_code == 200
    rows = client.get("/api/day?date=2026-09-12").get_json()["schedules"]
    row = [s for s in rows if s["id"] == sid][0]
    assert row["all_day"] == 1
    assert row["remind_before"] == 600


def test_schedule_fields_must_be_strings(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/schedule", json={
        "title": "x", "start_at": "2026-09-12T10:00:00", "note": {"a": 1},
    })
    assert rv.status_code == 400
    assert rv.get_json()["error"] == "bad_request"
    rv = client.post("/api/schedule", json={
        "title": "x", "start_at": "2026-09-12T10:00:00", "end_at": 123,
    })
    assert rv.status_code == 400
    rv = client.post("/api/schedule", json={
        "title": "x", "start_at": "2026-09-12T10:00:00", "note": "备注", "color": "#fff",
    })
    assert rv.status_code == 201
    sid = rv.get_json()["id"]
    assert client.put(f"/api/schedule/{sid}", json={"color": 5}).status_code == 400
