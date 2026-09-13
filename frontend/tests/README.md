# frontend/tests/ — 前端单测

职责：用 Node 内置 `node:test` 覆盖 `frontend/lib/` 的纯逻辑，不依赖浏览器。

## 主要文件

| 文件 | 覆盖对象 |
|---|---|
| `api.test.js` | `lib/api.js`（请求方法/URL/错误处理） |
| `cal.test.js` | `lib/cal.js`（月网格与跨月/首日计算） |
| `fmt.test.js` | `lib/fmt.js`（补零、本地解析、中文标签、提前量格式化） |
| `page.test.js` | `lib/page.js`（页数、页码钳制） |
| `sse.test.js` | `lib/sse.js`（事件分发与错误处理） |

## 约定

- 仅使用 `node:test` + `node:assert/strict`，不引入第三方测试框架。
- 断言以行为为准（输入→输出），不依赖实现细节。

## 运行

```powershell
node --test "frontend/tests/**/*.test.js"   # 25 用例
```

## 修改注意点

- 代码零构建：测试直接 `import` ES Module，请勿引入需要打包的依赖。
- 新增 `lib/` 导出应补齐对应用例。
