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
