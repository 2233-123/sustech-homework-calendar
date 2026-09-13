// REST 客户端：fetch 可注入以便零依赖单测
//
// 约定：所有方法返回解析后的 JSON；HTTP 非 2xx 时抛 Error，附带
//   err.code   —— 后端返回的 {error} 字段（无则 "http_error"）
//   err.status —— HTTP 状态码
/**
 * @param {typeof fetch} [fetchImpl=globalThis.fetch] 可注入的 fetch（测试替身）
 * @returns {Object} 与后端 /api/* 一一对应的方法集合
 */
export function createApi(fetchImpl = globalThis.fetch) {
  async function request(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetchImpl(url, opts);
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (!resp.ok) {
      const err = new Error((data && data.message) || `HTTP ${resp.status}`);
      err.code = (data && data.error) || "http_error";
      err.status = resp.status;
      throw err;
    }
    return data;
  }
  return {
    getState: () => request("GET", "/api/state"),
    login: (sid, password, remember) => request("POST", "/api/auth/login", { sid, password, remember }),
    logout: (clear) => request("POST", "/api/auth/logout", { clear_credentials: !!clear }),
    sync: () => request("POST", "/api/sync"),
    getCalendar: (year, month) => request("GET", `/api/calendar?year=${year}&month=${month}`),
    getDay: (date) => request("GET", `/api/day?date=${date}`),
    createSchedule: (payload) => request("POST", "/api/schedule", payload),
    updateSchedule: (id, payload) => request("PUT", `/api/schedule/${id}`, payload),
    deleteSchedule: (id) => request("DELETE", `/api/schedule/${id}`),
    getSettings: () => request("GET", "/api/settings"),
    putSettings: (payload) => request("PUT", "/api/settings", payload),
  };
}
