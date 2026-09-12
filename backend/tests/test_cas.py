import pytest
import requests

from backend import cas
from backend.tests.fakes import FakeResponse, FakeSession

LOGIN_PAGE = '<html><input name="execution" value="e1s1" /></html>'


class RaisingSession(FakeSession):
    """所有请求都抛超时的会话替身。"""

    def get(self, url, **kwargs):
        raise requests.exceptions.Timeout("timeout")

    def post(self, url, **kwargs):
        raise requests.exceptions.Timeout("timeout")


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


def test_request_exception_maps_to_network_error():
    with pytest.raises(cas.NetworkError):
        cas.login("12345", "pwd", session=RaisingSession())


def test_missing_location_raises_network_error():
    sess = FakeSession(responses=[
        FakeResponse(200, text=LOGIN_PAGE),
        FakeResponse(302, headers={}),
    ])
    with pytest.raises(cas.NetworkError):
        cas.login("12345", "pwd", session=sess)


@pytest.mark.parametrize("status", [302, 303])
def test_redirect_statuses_accepted(status):
    sess = FakeSession(
        responses=[
            FakeResponse(200, text=LOGIN_PAGE),
            FakeResponse(status, headers={"Location": "https://cas.sustech.edu.cn/cas/login?ticket=ST-9"}),
            FakeResponse(200, text="ok"),
        ],
        cookies={"JSESSIONID": "abc"},
    )
    assert cas.login("12345", "pwd", session=sess) == {"JSESSIONID": "abc"}


def test_empty_cookie_values_filtered():
    sess = FakeSession(
        responses=[
            FakeResponse(200, text=LOGIN_PAGE),
            FakeResponse(302, headers={"Location": "https://cas.sustech.edu.cn/cas/login?ticket=ST-9"}),
            FakeResponse(200, text="ok"),
        ],
        cookies={"A": "", "B": "1"},
    )
    assert cas.login("12345", "pwd", session=sess) == {"B": "1"}


def test_login_retries_once_on_network_error():
    calls = []

    class FlakySession(FakeSession):
        def get(self, url, **kwargs):
            calls.append("get")
            if len(calls) == 1:
                raise requests.exceptions.Timeout("boom")
            return super().get(url, **kwargs)

    sess = FlakySession(
        responses=[
            FakeResponse(200, text=LOGIN_PAGE),
            FakeResponse(302, headers={"Location": "https://cas.sustech.edu.cn/cas/login?ticket=ST-9"}),
            FakeResponse(200, text="ok"),
        ],
        cookies={"JSESSIONID": "abc"},
    )
    cookies = cas.login("12345", "pwd", session=sess)
    assert cookies == {"JSESSIONID": "abc"}
    assert len(calls) == 3  # 第 1 次超时 + 重试后的 2 次 GET（登录页 + ticket 交换）
