// SSE 封装：命名事件分发 + 原生自动重连（EventSourceImpl 可注入以便测试）
const NAMED_EVENTS = ["remind", "sync_done", "login_changed", "error"];

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
