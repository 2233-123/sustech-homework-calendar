import test from "node:test";
import assert from "node:assert/strict";

import { createSSE } from "../lib/sse.js";

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, fn) {
    (this.listeners[name] ||= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(name, ev) {
    for (const fn of this.listeners[name] || []) fn(ev);
  }
}

test("命名事件被解析并分发给处理器", () => {
  FakeEventSource.instances = [];
  const seen = [];
  const sse = createSSE("/api/events", { remind: (d) => seen.push(d) }, FakeEventSource);
  FakeEventSource.instances[0].emit("remind", { data: JSON.stringify({ id: 1, title: "小组会议" }) });
  assert.deepEqual(seen, [{ id: 1, title: "小组会议" }]);
  assert.equal(FakeEventSource.instances[0].url, "/api/events");
  sse.close();
  assert.equal(FakeEventSource.instances[0].closed, true);
});

test("原生传输错误不误触 error 处理器，但触发 disconnected", () => {
  FakeEventSource.instances = [];
  const calls = [];
  createSSE("/api/events", {
    error: () => calls.push("error"),
    disconnected: () => calls.push("disconnected"),
  }, FakeEventSource);
  const es = FakeEventSource.instances[0];
  es.onerror({}); // 原生 error：无 data；同时会走 addEventListener("error") 无数据分支
  es.emit("error", {});
  assert.deepEqual(calls, ["disconnected"]);
});

test("服务端 error 事件（带 data）正常分发", () => {
  FakeEventSource.instances = [];
  const seen = [];
  createSSE("/api/events", { error: (d) => seen.push(d) }, FakeEventSource);
  FakeEventSource.instances[0].emit("error", { data: JSON.stringify({ code: "offline" }) });
  assert.deepEqual(seen, [{ code: "offline" }]);
});

test("坏 JSON 载荷不抛异常（分发 null）", () => {
  FakeEventSource.instances = [];
  const seen = [];
  createSSE("/api/events", { sync_done: (d) => seen.push(d) }, FakeEventSource);
  FakeEventSource.instances[0].emit("sync_done", { data: "{oops" });
  assert.deepEqual(seen, [null]);
});
