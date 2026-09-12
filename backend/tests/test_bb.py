import pytest
import requests

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


def test_login_without_cookies_raises_network_error():
    http = FakeSession(responses=[FakeResponse(200)])
    s = bb.BBSession("a", "b", http=http, login_fn=lambda sid, pwd, session=None: {})
    with pytest.raises(cas.NetworkError):
        s.get("/x")


def test_get_json_non_json_body_raises_network_error():
    http = FakeSession(responses=[FakeResponse(200, text="<html>maintenance</html>")])
    s = make_bb(http=http)
    with pytest.raises(cas.NetworkError):
        s.get_json("/x")


def test_params_passed_through():
    http = FakeSession(responses=[FakeResponse(200, json_data={"ok": True})])
    s = make_bb(http=http)
    s.get("/x", params={"offset": 100})
    assert http.calls[0][2]["params"] == {"offset": 100}


def test_get_json_returns_parsed_body():
    http = FakeSession(responses=[FakeResponse(200, json_data={"id": "_1_1"})])
    s = make_bb(http=http)
    assert s.get_json("/learn/api/public/v1/users/me") == {"id": "_1_1"}


def test_absolute_url_not_prefixed():
    http = FakeSession(responses=[FakeResponse(200)])
    s = make_bb(http=http)
    s.get("https://other.example/thing")
    assert http.calls[0][1] == "https://other.example/thing"


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


def test_http_request_exception_maps_to_network_error():
    class RaisingHttp(FakeSession):
        def get(self, url, **kwargs):
            raise requests.exceptions.Timeout("timeout")

    s = make_bb(http=RaisingHttp())
    with pytest.raises(cas.NetworkError):
        s.get("/x")


def test_fetch_assignments_tolerates_bad_due_date():
    bad_columns = {
        "results": [
            {
                "id": "col1",
                "name": "实验报告",
                "contentId": "_610795_1",
                "score": {"possible": 100},
                "grading": {"type": "Attempts", "due": "not-a-date"},
            },
        ]
    }
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=bad_columns),
        FakeResponse(200, json_data={"results": []}),
    ])
    s = make_bb(http=http)
    records = bb.fetch_assignments(s)
    assert records[0]["due_at"] is None


def test_fetch_assignments_tolerates_string_score():
    weird_columns = {
        "results": [
            {
                "id": "col1",
                "name": "实验报告",
                "contentId": "_610795_1",
                "score": "100",
                "grading": {"type": "Attempts", "due": "2026-03-25T15:59:00.000Z"},
            },
        ]
    }
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=weird_columns),
        FakeResponse(200, json_data={"results": []}),
    ])
    s = make_bb(http=http)
    records = bb.fetch_assignments(s)
    assert records[0]["possible"] is None


def test_fetch_assignments_skips_course_on_malformed_attempts():
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=COLUMNS),
        FakeResponse(200, json_data={"results": ["not-a-dict"]}),
    ])
    s = make_bb(http=http)
    assert bb.fetch_assignments(s) == []


def test_fetch_assignments_picks_latest_attempt():
    out_of_order = {
        "results": [
            {"status": "NeedsGrading", "score": 95, "created": "2026-03-22T10:00:00.000Z"},
            {"status": "Completed", "score": 88, "created": "2026-03-20T10:00:00.000Z"},
        ]
    }
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=COLUMNS),
        FakeResponse(200, json_data=out_of_order),
    ])
    s = make_bb(http=http)
    records = bb.fetch_assignments(s)
    assert records[0]["status"] == "NeedsGrading"
    assert records[0]["score"] == 95
