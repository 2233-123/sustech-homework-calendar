// SSE 封装：命名事件分发 + 原生自动重连（EventSourceImpl 可注入以便测试）
//
// 事件形状（与后端 backend/events.py 的 publish 对应）：
//   remind        → { kind: "schedule"|"assignment", id, title, at }
//   sync_done     → { added, updated, removed, at }
//   login_changed → { state: "ok"|"need_login"|"failed" }
//   error         → { code, message }
const NAMED_EVENTS = ["remind", "sync_done", "login_changed", "error"];

/**
 * 建立 SSE 连接并按事件名分发。
 * @param {string} url
 * @param {Object} [handlers] 键为事件名（含 "disconnected"）的回调；回调收到解析后的 JSON，解析失败为 null
 * @param {typeof EventSource} [EventSourceImpl] 可注入实现（测试替身）
 * @returns {{close: () => void, source: EventSource}}
 */
export function createSSE(url, handlers = {}, EventSourceImpl = globalThis.EventSource) {
  const es = new EventSourceImpl(url);
  for (const name of NAMED_EVENTS) {
    es.addEventListener(name, (ev) => {
      if (name === "error" && typeof ev.data !== "string") {
        return; // 原生传输错误：交给 onerror，不作为服务端事件分发
      }
      let data = null;
      try {
        data = JSON.parse(ev.data);
      } catch {
        data = null;
      }
      const fn = handlers[name];
      if (typeof fn === "function") fn(data);
    });
  }
  es.onerror = () => {
    if (typeof handlers.disconnected === "function") handlers.disconnected();
  };
  return { close: () => es.close(), source: es };
}
