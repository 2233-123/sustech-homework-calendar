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
