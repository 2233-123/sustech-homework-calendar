# frontend/ — 原生前端

职责：零构建的原生 HTML/CSS/JS（ES Modules）界面，由后端静态托管；负责日历渲染、
日列表分页、设置面板、事务概览与提醒气泡。

## 主要文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页面骨架（标题栏/状态栏/日历/日面板/各弹层） |
| `style.css` | 全部样式（含日期格方形与圆点缩放、溢出滚动兜底） |
| `app.js` | 入口：状态、渲染、事件装配、fit-height 上报 |
| `lib/` | 纯逻辑模块（可独立单测）：`api` / `cal` / `colors` / `fmt` / `page` / `sse` |
| `tests/` | `node:test` 单测 |
| `package.json` | 仅声明测试脚本，无依赖、无构建 |

## 约定

- 与后端通信统一经 `lib/api.js`（返回 Promise，非 2xx 抛 `Error` 并带 `code`）。
- 事件流经 `lib/sse.js`（`createSSE(url, handlers)`，事件形状见该文件注释）。
- 纯函数（日期/分页/格式化）放 `lib/`，便于 `node --test` 覆盖。
- 涉及外部字符串一律用 `textContent`，不用 `innerHTML` 拼接。

## 运行 / 测试

```powershell
# 开发：先起后端，再浏览器访问其打印的地址
.\.venv\Scripts\python -m backend.main
node --test "frontend/tests/**/*.test.js"   # 37 用例
```

## 修改注意点

- 布局不依赖固定 `100vh`：窗口高度由内容经 `fit-height` 驱动，改样式勿重新引入视口耦合。
- 课程标签颜色由 `lib/colors.js` 分配、持久化在 `localStorage["hw.courseHues.v1"]`；已分配课程不得改色（新课程走 `assignHues` 增量补齐）。
- `body.overflowing` 为溢出兜底（工作区放不下时才出现滚动条），不要常态启用。
- 分页数学集中在 `lib/page.js`，改动分页请同步单测。
