# frontend/lib/ — 前端纯逻辑模块

职责：不触 DOM 的可测试逻辑（请求封装、日历网格、课程配色、格式化、分页、SSE），供
`app.js` 与单测复用。

## 主要文件

| 文件 | 作用 |
|---|---|
| `api.js` | REST 客户端 `createApi(fetchImpl?)`：封装 `/api/*` 调用与错误码 |
| `cal.js` | 日历网格计算：`monthGrid(year, month, today)`、`addMonths` |
| `colors.js` | 课程标签配色：`hueForName`（最大空隙中点）/ `assignHues`（增量分配）/ `hslColor` / `contrastText`（WCAG 相对亮度） |
| `fmt.js` | 时间格式化：`pad2` / `toDateStr` / `parseLocal` / `formatTime` / `formatDateLabel` / `formatDateTime` / `formatLead` |
| `page.js` | 分页数学：`pageCount(total,size)` / `clampPage(page,total,size)` |
| `sse.js` | SSE 连接 `createSSE(url, handlers)`，按 `event` 名分发 |

## 约定

- 全部为具名导出；无副作用、无全局状态，便于直接单测。
- `parseLocal` 按本地时间解析 `YYYY-MM-DD[THH:MM:SS]`，不经 UTC。
- `api.js` 接受注入的 `fetchImpl`（默认 `globalThis.fetch`）以便测试替身。

## 测试

```powershell
node --test "frontend/tests/**/*.test.js"
```

## 修改注意点

- 修改导出签名需同步 `frontend/tests/*.test.js`。
- `sse.js` 的事件名与后端 `events.py` 保持一一对应，改名需两端同步。
- `colors.js` 的分配必须保持确定性（同输入同输出、已分配不改色）；色相持久化由 `app.js` 负责（后端配置 `course_hues`），模块本身无副作用。
