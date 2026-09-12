"""Flask 应用：REST API + SSE + 静态托管（设计文档 §6.5）。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, request, stream_with_context

from backend import config
from backend.bb import SessionExpired
from backend.cas import InvalidCredentials, NetworkError
from backend.service import NotAuthenticated, SyncInProgress


def create_app(service, bus, *, frontend_dir=None) -> Flask:
    frontend = Path(frontend_dir) if frontend_dir else Path(__file__).resolve().parent.parent / "frontend"
    app = Flask(__name__, static_folder=str(frontend), static_url_path="")
    app.json.ensure_ascii = False
    app.config["FRONTEND_DIR"] = str(frontend)

    def _error(code: str, message: str, status: int):
        return jsonify({"error": code, "message": message}), status

    @app.get("/api/state")
    def api_state():
        return jsonify(service.state())

    @app.post("/api/auth/login")
    def api_login():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return _error("bad_request", "请求体应为 JSON 对象", 400)
        sid = str(body.get("sid") or "").strip()
        password = str(body.get("password") or "")
        remember = bool(body.get("remember", False))
        if not sid or not password:
            return _error("bad_request", "缺少 sid 或 password", 400)
        try:
            ok = service.login(sid, password, remember=remember)
        except NetworkError as e:
            return _error("offline", str(e), 502)
        except SessionExpired:
            return _error("session_expired", "会话失效，请重新登录", 401)
        if not ok:
            return _error("invalid_credentials", "账号或密码错误", 401)
        return jsonify({"ok": True, "state": service.state()})

    @app.post("/api/auth/logout")
    def api_logout():
        body = request.get_json(silent=True)
        if body is not None and not isinstance(body, dict):
            return _error("bad_request", "请求体应为 JSON 对象", 400)
        service.logout(clear_saved=bool((body or {}).get("clear_credentials", False)))
        return jsonify({"ok": True, "state": service.state()})

    @app.post("/api/sync")
    def api_sync():
        try:
            result = service.sync_now()
        except NotAuthenticated:
            return _error("not_authenticated", "尚未登录", 401)
        except SessionExpired:
            return _error("session_expired", "会话失效，请重新登录", 401)
        except InvalidCredentials:
            return _error("invalid_credentials", "凭据已失效", 401)
        except SyncInProgress:
            return _error("busy", "同步进行中", 409)
        except NetworkError as e:
            return _error("offline", str(e), 502)
        return jsonify({"ok": True, **result})

    @app.get("/api/calendar")
    def api_calendar():
        today = date.today()
        try:
            year = int(request.args.get("year", today.year))
            month = int(request.args.get("month", today.month))
            start = date(year, month, 1)
            end = date(year + (month == 12), month % 12 + 1, 1)
        except (ValueError, OverflowError):
            return _error("bad_request", "year/month 非法", 400)
        start_s = f"{start.isoformat()}T00:00:00"
        end_s = f"{end.isoformat()}T00:00:00"
        # 注意：无截止时间的作业（due_at IS NULL）不会出现在日历上——有意设计（日历按日期键控）
        return jsonify({
            "schedules": service.db.list_schedules(start_s, end_s),
            "assignments": service.db.list_assignments(start_s, end_s),
        })

    @app.get("/api/day")
    def api_day():
        raw = request.args.get("date") or date.today().isoformat()
        try:
            day = date.fromisoformat(raw)
            nxt = day + timedelta(days=1)
        except (ValueError, OverflowError):
            return _error("bad_request", "date 格式应为 YYYY-MM-DD", 400)
        start_s = f"{day.isoformat()}T00:00:00"
        end_s = f"{nxt.isoformat()}T00:00:00"
        return jsonify({
            "schedules": service.db.list_schedules(start_s, end_s),
            "assignments": service.db.list_assignments(start_s, end_s),
        })

    @app.post("/api/schedule")
    def api_schedule_create():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return _error("bad_request", "请求体应为 JSON 对象", 400)
        title = str(body.get("title") or "").strip()
        start_at = str(body.get("start_at") or "")
        if not title or not start_at:
            return _error("bad_request", "缺少 title 或 start_at", 400)
        try:
            datetime.strptime(start_at, "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return _error("bad_request", "start_at 格式应为 YYYY-MM-DDTHH:MM:SS", 400)
        remind_before = body.get("remind_before")
        if remind_before is not None:
            try:
                remind_before = int(remind_before)
            except (TypeError, ValueError):
                return _error("bad_request", "remind_before 应为整数秒", 400)
        for field in ("end_at", "note", "color"):
            value = body.get(field)
            if value is not None and not isinstance(value, str):
                return _error("bad_request", f"{field} 应为字符串", 400)
        try:
            all_day = int(body.get("all_day") or 0)
        except (TypeError, ValueError):
            return _error("bad_request", "all_day 应为 0/1", 400)
        sid = service.db.add_schedule(
            title=title,
            start_at=start_at,
            end_at=body.get("end_at"),
            all_day=all_day,
            remind_before=remind_before,
            note=body.get("note"),
            color=body.get("color"),
        )
        return jsonify({"ok": True, "id": sid}), 201

    @app.put("/api/schedule/<int:sid>")
    def api_schedule_update(sid):
        if service.db.get_schedule(sid) is None:
            return _error("not_found", "日程不存在", 404)
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return _error("bad_request", "请求体应为 JSON 对象", 400)
        if "title" in body:
            title = str(body["title"] or "").strip()
            if not title:
                return _error("bad_request", "title 不能为空", 400)
            body["title"] = title
        if "start_at" in body:
            try:
                datetime.strptime(str(body["start_at"]), "%Y-%m-%dT%H:%M:%S")
            except ValueError:
                return _error("bad_request", "start_at 格式应为 YYYY-MM-DDTHH:MM:SS", 400)
        for field in ("end_at", "note", "color"):
            if field in body and body[field] is not None and not isinstance(body[field], str):
                return _error("bad_request", f"{field} 应为字符串", 400)
        if "all_day" in body:
            try:
                body["all_day"] = int(body["all_day"] or 0)
            except (TypeError, ValueError):
                return _error("bad_request", "all_day 应为 0/1", 400)
        if "remind_before" in body and body["remind_before"] is not None:
            try:
                body["remind_before"] = int(body["remind_before"])
            except (TypeError, ValueError):
                return _error("bad_request", "remind_before 应为整数秒", 400)
        service.db.update_schedule(sid, **body)
        return jsonify({"ok": True})

    @app.delete("/api/schedule/<int:sid>")
    def api_schedule_delete(sid):
        if service.db.get_schedule(sid) is None:
            return _error("not_found", "日程不存在", 404)
        service.db.delete_schedule(sid)
        return jsonify({"ok": True})

    @app.get("/api/settings")
    def api_settings_get():
        return jsonify(config.load_config())

    @app.put("/api/settings")
    def api_settings_put():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return _error("bad_request", "请求体应为 JSON 对象", 400)
        cfg = config.load_config()
        cfg.update(body)
        config.save_config(cfg)
        return jsonify(config.load_config())

    @app.get("/api/events")
    def api_events():
        return Response(
            stream_with_context(bus.stream()),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/")
    def index():
        candidate = Path(app.config["FRONTEND_DIR"]) / "index.html"
        if candidate.exists():
            return app.send_static_file("index.html")
        return "作业日程后端运行中", 200, {"Content-Type": "text/plain; charset=utf-8"}

    return app
