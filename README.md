# 作业日程 — SUSTech 作业日程桌面小组件

无边框桌面日历小组件：本地登录 SUSTech CAS，自动拉取 Blackboard 作业，支持自建日程与预警弹窗。

## 功能

- **本地 CAS 登录**：Windows DPAPI 加密存储凭据（仅本机当前用户可解密），启动静默自动登录
- **Blackboard 作业自动拉取**：只读同步（评分列 = 作业，含截止时间/提交状态），定时刷新 + 手动刷新
- **月视图日历**：有事项日期标点；点日期展开当日列表（BB 作业带 `[BB]` 标记）
- **自建日程**：标题/时间/全天/颜色/备注/提前提醒（5 分钟 — 1 天）
- **预警弹窗**：应用内气泡（可稍后/知道了）+ 可选系统通知
- **无边框小组件**：透明圆角置顶、隐藏任务栏；拖动标题栏移动；位置记忆
- **系统托盘**：显示/隐藏、立即同步、退出

## 技术架构

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML/CSS/JS（零构建、ES Modules），由后端静态托管 |
| 后端 | Python 3.11 + Flask（REST + SSE），仅监听 `127.0.0.1` 随机端口 |
| 外壳 | Electron（无边框窗口，spawn 后端并解析 stdout `PORT=`） |
| 数据 | `%APPDATA%\作业日程\`：`config.json` / `data.db`(SQLite) / `credentials.bin`(DPAPI) |

设计文档与实施计划见 `docs/superpowers/`（设计案 + 四份分阶段计划）。

## 使用（打包版）

1. 运行 `作业日程 Setup 0.1.0.exe` 安装（未签名，SmartScreen 提示时选「更多信息 → 仍要运行」）；或直接使用便携版 `作业日程 0.1.0.exe`
2. 首次启动输入学号与密码登录（可选记住账号）
3. **X / Alt+F4 = 隐藏到托盘**；完全退出请用托盘菜单「退出」
4. ⚠️ 需校园网或 VPN；离线时显示提示并保留上次缓存

## 开发

```powershell
# 后端（Python 3.11）
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m backend.main        # 打印 PORT= 后浏览器打开即前端

# 测试
.\.venv\Scripts\python -m pytest                              # 118 用例
node --test "frontend/tests/**/*.test.js"                     # 21 用例

# 外壳（开发态自动拉起后端）
cd electron; npm i; npm start

# 打包（先关闭正在运行的应用）
packaging\build.ps1
```

## 已知限制

- 后端崩溃仅系统通知提示，**无自动重启**（托盘退出后重新启动即可）
- 透明窗口为半透明效果（Chromium 无法对桌面做磨砂模糊）
- 便携版不支持开机自启（自启依赖安装版路径）
- 强杀外壳进程可能遗留后端进程（正常退出会自动清理）
- 慢网络下启动可能等待数十秒（上限 120s）

## 致谢

接口参考 [sustech_survival](https://github.com/dumixthestpd/sustech_survival)（PolyForm Noncommercial 1.0.0）。本仓库仅限个人非商业使用。
