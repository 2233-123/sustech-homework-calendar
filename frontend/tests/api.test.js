import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../lib/api.js";

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) throw new Error(`no queued response for ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new SyntaxError("not json");
        return r.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test("getState 返回解析后的 JSON", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { login: "need_login" } }]);
  const api = createApi(fetchImpl);
  assert.deepEqual(await api.getState(), { login: "need_login" });
  assert.equal(fetchImpl.calls[0].url, "/api/state");
  assert.equal(fetchImpl.calls[0].opts.method, "GET");
});

test("login 发送 POST JSON 体", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const api = createApi(fetchImpl);
  await api.login("20231234", "pw", true);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, "/api/auth/login");
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(opts.body), { sid: "20231234", password: "pw", remember: true });
});

test("错误响应抛出带 code 的 Error", async () => {
  const fetchImpl = fakeFetch([{ status: 401, body: { error: "invalid_credentials", message: "账号或密码错误" } }]);
  const api = createApi(fetchImpl);
  await assert.rejects(
    () => api.login("u", "bad", false),
    (err) => {
      assert.equal(err.code, "invalid_credentials");
      assert.equal(err.status, 401);
      assert.equal(err.message, "账号或密码错误");
      return true;
    }
  );
});

test("非 JSON 错误响应回退到 HTTP 文案", async () => {
  const fetchImpl = fakeFetch([{ status: 500 }]);
  const api = createApi(fetchImpl);
  await assert.rejects(() => api.getSettings(), (err) => err.code === "http_error" && err.status === 500);
});

test("各端点 URL 与方法组装正确", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { schedules: [], assignments: [] } },
    { status: 200, body: { schedules: [], assignments: [] } },
    { status: 201, body: { ok: true, id: 3 } },
    { status: 200, body: { ok: true } },
    { status: 200, body: { ok: true } },
  ]);
  const api = createApi(fetchImpl);
  await api.getCalendar(2026, 9);
  await api.getDay("2026-09-12");
  await api.createSchedule({ title: "x", start_at: "2026-09-12T10:00:00" });
  await api.updateSchedule(3, { title: "y" });
  await api.deleteSchedule(3);
  assert.equal(fetchImpl.calls[0].url, "/api/calendar?year=2026&month=9");
  assert.equal(fetchImpl.calls[1].url, "/api/day?date=2026-09-12");
  assert.equal(fetchImpl.calls[2].url, "/api/schedule");
  assert.equal(fetchImpl.calls[3].url, "/api/schedule/3");
  assert.equal(fetchImpl.calls[3].opts.method, "PUT");
  assert.equal(fetchImpl.calls[4].opts.method, "DELETE");
});
