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

def iso_utc(days_from_now: int) -> str:
    """相对现在 ±N 天的 BB UTC 时间串（避免硬编码日期随窗口过期）。"""
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) + timedelta(days=days_from_now)).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )


def utc_for_local_date(d) -> str:
    """本地日期 d 的当天正午 → BB UTC 时间串（用于精确控制本地日期部分）。"""
    from datetime import datetime, timezone

    return (
        datetime(d.year, d.month, d.day, 12, 0, 0).astimezone(timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%S.000Z")
    )


def columns(due=None, content_id="_610795_1", col_id="col1", name="实验报告"):
    """单列作业型评分列（默认 due 在窗口内）。"""
    return {
        "results": [
            {
                "id": col_id,
                "name": name,
                "contentId": content_id,
                "score": {"possible": 100},
                "grading": {"type": "Attempts", "due": iso_utc(3) if due is None else due},
            }
        ]
    }


def fetch_queue(*, columns_data=None, attempts_data=None, content_status=200):
    """一次成功抓取的完整请求队列：users/me → enrollments → 课程详情 → columns → content → attempts。"""
    return [
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=columns_data if columns_data is not None else columns()),
        FakeResponse(content_status),
        FakeResponse(
            200,
            json_data=attempts_data
            if attempts_data is not None
            else {"results": [{"status": "Completed", "score": 95}]},
        ),
    ]


def urls_of(http):
    return [u for _, u, _ in http.calls]


# ---------- 自然月减法 / 窗口 ----------

def test_subtract_months_month_end_clamp():
    from datetime import date

    assert bb.subtract_months(date(2026, 3, 31), 1) == date(2026, 2, 28)
    assert bb.subtract_months(date(2024, 3, 31), 1) == date(2024, 2, 29)  # 闰年
    assert bb.subtract_months(date(2026, 3, 30), 1) == date(2026, 2, 28)
    assert bb.subtract_months(date(2026, 1, 31), 1) == date(2025, 12, 31)  # 跨年
    assert bb.subtract_months(date(2026, 5, 15), 3) == date(2026, 2, 15)
    assert bb.subtract_months(date(2026, 1, 15), 6) == date(2025, 7, 15)


def test_pull_cutoff_values():
    from datetime import date

    today = date(2026, 9, 14)
    assert bb.pull_cutoff(1, today) == "2026-08-14"
    assert bb.pull_cutoff(2, today) == "2026-07-14"
    assert bb.pull_cutoff(3, today) == "2026-06-14"
    assert bb.pull_cutoff(6, today) == "2026-03-14"
    assert bb.pull_cutoff(0, today) is None  # 0 = 不限
    assert bb.pull_cutoff(-1, today) is None
    assert bb.pull_cutoff("bad", today) == "2026-08-14"  # 非法值回退 1 个月
    assert bb.pull_cutoff(1, date(2026, 3, 31)) == "2026-02-28"  # 月末钳制
    assert bb.pull_cutoff(1, date(2024, 3, 31)) == "2024-02-29"


def test_pull_cutoff_clamps_huge_values():
    """超大 months 钳制到 1200（≈100 年）——不得因 date 越界抛错。"""
    from datetime import date

    expected = bb.subtract_months(date.today(), 1200).isoformat()
    assert bb.pull_cutoff(10**6) == expected
    assert bb.pull_cutoff("1000000") == expected


def test_pull_cutoff_never_raises_on_weird_inputs():
    """非法/边界输入一律不抛：0/-1 → None（不限）；其余回退 1 个月。"""
    from datetime import date

    one_month = bb.subtract_months(date.today(), 1).isoformat()
    for bad in (None, "abc", {}, [], object(), float("nan"), float("inf")):
        assert bb.pull_cutoff(bad) == one_month, f"非法输入 {bad!r} 应回退 1 个月"
    assert bb.pull_cutoff(0) is None
    assert bb.pull_cutoff(-1) is None
    assert bb.pull_cutoff(-(10**6)) is None


def test_network_error_carries_status():
    http = FakeSession(responses=[FakeResponse(500)])
    s = make_bb(http=http)
    with pytest.raises(cas.NetworkError) as ei:
        s.get_json("/x")
    assert ei.value.status == 500
    assert "HTTP 500" in str(ei.value)  # 旧 message 格式保持


# ---------- 拉取主流程 ----------

def test_fetch_assignments_parses_and_filters():
    http = FakeSession(responses=fetch_queue())
    s = make_bb(http=http)
    records = bb.fetch_assignments(s, 1)
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
    # 内容可见性检查确实发起（带 contentId 的列）
    assert any("/courses/_8343_1/contents/_610795_1" in u for u in urls_of(http))


def test_fetch_assignments_skips_failing_course():
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_A_1"}, {"courseId": "_B_1"}]}),
        FakeResponse(200, json_data={"name": "课程A"}),
        FakeResponse(200, json_data={"name": "课程B"}),
        FakeResponse(500),                                    # A 的 columns 失败
        FakeResponse(200, json_data=columns(name="B 作业")),  # B 的 columns
        FakeResponse(200),                                    # B 的内容可见性
        FakeResponse(200, json_data={"results": []}),         # B 的 attempts
    ])
    s = make_bb(http=http)
    records = bb.fetch_assignments(s, 1)
    assert [r["course_name"] for r in records] == ["课程B"]
    assert records[0]["submitted"] == 0


def test_fetch_assignments_drops_missing_due_date():
    """无截止时间 → 丢弃，且不发 content/attempts 请求。"""
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=columns(due="", content_id="_111_1")),
    ])
    s = make_bb(http=http)
    assert bb.fetch_assignments(s, 0) == []  # 不限窗口也丢弃
    assert not any("/contents/" in u or u.endswith("/attempts") for u in urls_of(http))


def test_fetch_assignments_drops_unparseable_due():
    """due 不可解析（如 "not-a-date"）→ 与无期同路径丢弃，零后续请求。"""
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=columns(due="not-a-date", content_id="_111_1")),
    ])
    s = make_bb(http=http)
    assert bb.fetch_assignments(s, 1) == []
    assert not any("/contents/" in u or u.endswith("/attempts") for u in urls_of(http))


def test_fetch_assignments_drops_out_of_window():
    """早于窗口 → 丢弃，且不发 content/attempts 请求；放宽窗口后同一数据保留。"""
    old = columns(due=iso_utc(-100), content_id="_222_1")
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=old),
    ])
    s = make_bb(http=http)
    assert bb.fetch_assignments(s, 1) == []
    assert not any("/contents/" in u or u.endswith("/attempts") for u in urls_of(http))

    http2 = FakeSession(responses=fetch_queue(columns_data=old, content_status=200))
    s2 = make_bb(http=http2)
    assert len(bb.fetch_assignments(s2, 6)) == 1  # 6 个月窗口内 → 保留


@pytest.mark.parametrize("months,days_ago,kept", [
    (1, 3, True),        # 窗口内
    (1, 45, False),      # 1 个自然月最长 31 天 → 45 天前必丢
    (2, 45, True),       # 2 个自然月最短 59 天 → 45 天前必留
    (2, 75, False),      # 75 > 62（2 月上限）
    (3, 75, True),       # 3 个自然月最短 89 天
    (3, 150, False),     # 150 > 92（3 月上限）
    (6, 150, True),      # 6 个自然月最短 181 天
    (0, 3000, True),     # 不限
])
def test_fetch_assignments_window_values(months, days_ago, kept):
    http = FakeSession(responses=fetch_queue(columns_data=columns(due=iso_utc(-days_ago))))
    s = make_bb(http=http)
    records = bb.fetch_assignments(s, months)
    assert (len(records) == 1) is kept


def test_fetch_assignments_window_boundary_inclusive():
    """due 恰为窗口下界当天 → 保留（≥）；早一天 → 丢弃。"""
    from datetime import date, timedelta

    cutoff_day = bb.subtract_months(date.today(), 1)
    http = FakeSession(responses=fetch_queue(columns_data=columns(due=utc_for_local_date(cutoff_day))))
    assert len(bb.fetch_assignments(make_bb(http=http), 1)) == 1

    http2 = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=columns(due=utc_for_local_date(cutoff_day - timedelta(days=1)))),
    ])
    assert bb.fetch_assignments(make_bb(http=http2), 1) == []


def test_fetch_assignments_drops_invisible_content():
    """403/404 → 丢弃（不发 attempts）；5xx → fail-open 保留。"""
    for status in (403, 404):
        http = FakeSession(responses=fetch_queue(content_status=status))
        s = make_bb(http=http)
        assert bb.fetch_assignments(s, 1) == [], f"HTTP {status} 应丢弃"
        assert not any(u.endswith("/attempts") for u in urls_of(http))

    http5 = FakeSession(responses=fetch_queue(content_status=500))
    s5 = make_bb(http=http5)
    assert len(bb.fetch_assignments(s5, 1)) == 1, "5xx 应 fail-open 保留"


def test_fetch_assignments_keeps_on_content_network_error():
    class ContentRaisingHttp(FakeSession):
        def get(self, url, **kwargs):
            if "/contents/" in url:
                raise requests.exceptions.ConnectionError("boom")
            return super().get(url, **kwargs)

    # content 请求在假 HTTP 层直接抛异常（不消耗响应队列），故 attempts 响应紧随 columns
    http = ContentRaisingHttp(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=columns()),
        FakeResponse(200, json_data={"results": []}),
    ])
    s = make_bb(http=http)
    assert len(bb.fetch_assignments(s, 1)) == 1  # 网络故障不误删


def test_fetch_assignments_keeps_on_content_session_expired():
    """内容探测 401×2（重登后仍 401 → SessionExpired）→ fail-open 保留。"""
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=columns()),
        FakeResponse(401),                             # content 首次
        FakeResponse(401),                             # 重登后仍 401 → SessionExpired
        FakeResponse(200, json_data={"results": []}),  # attempts 照常
    ])
    s = make_bb(http=http)
    assert len(bb.fetch_assignments(s, 1)) == 1  # 会话问题不误删


def test_fetch_assignments_keeps_on_content_non_json():
    """内容 200 但非 JSON → NetworkError(status=None) → fail-open 保留。"""
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=columns()),
        FakeResponse(200, text="<html>maintenance</html>"),
        FakeResponse(200, json_data={"results": []}),
    ])
    s = make_bb(http=http)
    assert len(bb.fetch_assignments(s, 1)) == 1


def test_fetch_assignments_skips_content_check_without_content_id():
    """无 contentId 的列保留，且不发 content 请求。"""
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=columns(content_id="")),
        FakeResponse(200, json_data={"results": []}),
    ])
    s = make_bb(http=http)
    records = bb.fetch_assignments(s, 1)
    assert len(records) == 1
    assert records[0]["content_id"] == "col1"  # 退回 column_id 归一化
    assert not any("/contents/" in u for u in urls_of(http))


def test_fetch_assignments_tolerates_string_score():
    http = FakeSession(responses=fetch_queue(columns_data={
        "results": [
            {
                "id": "col1",
                "name": "实验报告",
                "contentId": "_610795_1",
                "score": "100",
                "grading": {"type": "Attempts", "due": iso_utc(3)},
            },
        ]
    }))
    s = make_bb(http=http)
    records = bb.fetch_assignments(s, 1)
    assert records[0]["possible"] is None


def test_http_request_exception_maps_to_network_error():
    """直接单测 .get()：requests 传输异常 → NetworkError（status=None，文案保持）。"""

    class RaisingHttp(FakeSession):
        def get(self, url, **kwargs):
            raise requests.exceptions.Timeout("timeout")

    s = make_bb(http=RaisingHttp())
    with pytest.raises(cas.NetworkError) as ei:
        s.get("/x")
    assert ei.value.status is None  # 传输层异常无 HTTP 状态
    assert "Blackboard 请求失败" in str(ei.value)


def test_fetch_assignments_skips_course_on_malformed_attempts():
    http = FakeSession(responses=fetch_queue(attempts_data={"results": ["not-a-dict"]}))
    s = make_bb(http=http)
    assert bb.fetch_assignments(s, 1) == []


def test_fetch_assignments_picks_latest_attempt():
    out_of_order = {
        "results": [
            {"status": "NeedsGrading", "score": 95, "created": "2026-03-22T10:00:00.000Z"},
            {"status": "Completed", "score": 88, "created": "2026-03-20T10:00:00.000Z"},
        ]
    }
    http = FakeSession(responses=fetch_queue(attempts_data=out_of_order))
    s = make_bb(http=http)
    records = bb.fetch_assignments(s, 1)
    assert records[0]["status"] == "NeedsGrading"
    assert records[0]["score"] == 95


def test_fetch_assignments_dropped_columns_issue_no_requests():
    """混合列：仅保留列发起 content+attempts；被丢弃列零请求（请求队列长度即证明）。"""
    cols = {
        "results": [
            {"id": "c1", "name": "无期", "contentId": "_111_1",
             "grading": {"type": "Attempts", "due": ""}},
            {"id": "c2", "name": "旧", "contentId": "_222_1",
             "grading": {"type": "Attempts", "due": iso_utc(-100)}},
            {"id": "c3", "name": "新", "contentId": "_333_1",
             "grading": {"type": "Attempts", "due": iso_utc(3)}},
        ]
    }
    http = FakeSession(responses=[
        FakeResponse(200, json_data={"id": "_1_1"}),
        FakeResponse(200, json_data={"results": [{"courseId": "_8343_1"}]}),
        FakeResponse(200, json_data={"name": "操作系统"}),
        FakeResponse(200, json_data=cols),
        FakeResponse(200),                             # 仅 c3 的内容可见性
        FakeResponse(200, json_data={"results": []}),  # 仅 c3 的 attempts
    ])
    s = make_bb(http=http)
    records = bb.fetch_assignments(s, 1)
    assert [r["title"] for r in records] == ["新"]
    urls = urls_of(http)
    assert not any("_111_1" in u or "_222_1" in u for u in urls)
    assert any("/contents/_333_1" in u for u in urls)
