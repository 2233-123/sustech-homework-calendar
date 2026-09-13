# backend/ — Flask 后端

职责：对前端提供本机 REST + SSE 服务，封装 SUSTech CAS 登录、Blackboard 作业同步、
SQLite 存储、配置读写与提醒判定；仅监听 `127.0.0.1` 随机端口。

## 主要文件

| 文件 | 作用 |
|---|---|
| `main.py` | 进程入口：加载配置、建 app、启动后打印 `PORT=<端口>` |
| `app.py` | 路由与请求体校验（`/api/*`），把请求转交 service/config |
| `service.py` | 业务编排：登录态、同步、缓存、提醒调度与状态快照 |
| `cas.py` | CAS 登录客户端（表单提交、重定向、cookie） |
| `bb.py` | Blackboard 会话与作业抓取（TTL / 401 重登） |
| `db.py` | SQLite 访问（日程、作业缓存） |
| `config.py` | 配置读写：默认值合并、键过滤、原子写 + RLock 串行化 |
| `dpapi.py` | 凭据加解密（Windows DPAPI，仅当前用户可解密） |
| `events.py` | SSE 事件总线（订阅/分发） |
| `reminder.py` | 提醒判定（提前量、去重） |
| `tests/` | pytest 用例与测试替身 |

## 约定

- 配置键以 `DEFAULT_CONFIG` 为准；未知键在 `save_config` 时被过滤。
- 并发写配置统一走 `config.update_config(patch)`（load→update→save 持锁）。
- 错误以 JSON `{error, message}` 形式返回，HTTP 状态码表达语义。

## 运行 / 测试

```powershell
.\.venv\Scripts\python -m backend.main     # 打印 PORT=，浏览器访问即前端
.\.venv\Scripts\python -m pytest           # 130 用例
```

## 修改注意点

- 新增配置键必须同时加入 `DEFAULT_CONFIG`，否则落盘时会被丢弃。
- `save_config` 为原子写（临时文件 + `os.replace`），不要改回直接覆写。
- 涉及凭据的代码不得记录明文密码/凭据内容到日志或磁盘。
