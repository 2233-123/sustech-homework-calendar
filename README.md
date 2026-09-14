# 作业日程 — SUSTech 作业日程桌面小组件

无边框桌面日历小组件：本地登录 SUSTech CAS，自动拉取 Blackboard 作业，支持自建日程与预警弹窗。

## 功能

- **本地 CAS 登录**：Windows DPAPI 加密存储凭据（仅本机当前用户可解密），启动静默自动登录
- **Blackboard 作业自动拉取**：只读同步（评分列 = 作业，含截止时间/提交状态），定时刷新 + 手动刷新；**拉取过滤**——只拉「今天 − N 个自然月」以内的条目（默认 1 个月，设置项可选 1/2/3/6 个月或不限）、丢弃无截止时间列、并按**内容可见性**甄别（403/404 丢弃：他班/未发布内容不进库；网络故障 fail-open 保留；注：「不限」只放开时间窗口，旧归档内容多已 403 仍会被过滤）
- **月视图日历**：圆角正方形日期格（事项圆点随格缩放）；点日期展开当日列表（BB 作业：彩色课程名圆角标签 + 双倍行高；颜色按课程区分、同课程恒定——色表存后端配置，跨重启不变）
- **日列表**：按条数动态高度、**窗口高度随内容自适应**（不留空白）；每页最多 3 条，超出用圆点页码 + 箭头翻页；BB 事务行为两行结构（课程标签 + 标题），高度为常规条目的 2 倍
- **事务概览**：点击任意事务查看标题/备注/时间/提醒；BB 事务含课程名、提交状态与「在 Blackboard 中打开」外链
- **自建日程**：标题/时间/全天/颜色/备注/提前提醒（5 分钟 — 1 天）
- **预警弹窗**：应用内气泡（可稍后/知道了）+ 可选系统通知
- **无边框小组件**：透明圆角置顶、隐藏任务栏；拖动标题栏移动；位置记忆
- **窗口个性化**：透明度滑块（拖动实时预览）、窗口缩放（40%–150%，**拖动中实时生效**、内容随缩放；低于 70% 时字号保底、窗口继续收窄——高度始终自适应内容，放不下时才滚动）、一键贴边收起（点击屏幕右缘小条唤出）
- **系统托盘**：显示/隐藏、立即同步、退出

## 技术架构

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML/CSS/JS（零构建、ES Modules），由后端静态托管 |
| 后端 | Python 3.11 + Flask（REST + SSE），仅监听 `127.0.0.1` 随机端口 |
| 外壳 | Electron（无边框窗口，spawn 后端并解析 stdout `PORT=`） |
| 数据 | `%APPDATA%\作业日程\`：`config.json` / `data.db`(SQLite) / `credentials.bin`(DPAPI) |

设计文档与实施计划见 `docs/superpowers/`（含 rev2–rev8 各版本改进设计案与实测记录）。

## 项目结构

```
作业日程/
├─ backend/                     # Flask 后端：REST + SSE，仅监听 127.0.0.1
│  ├─ app.py                    # 路由与请求体校验（/api/*）
│  ├─ service.py                # 业务编排：登录/同步/缓存/提醒调度
│  ├─ cas.py / bb.py            # SUSTech CAS 登录客户端 / Blackboard 会话与抓取
│  ├─ db.py / config.py         # SQLite 访问 / 配置读写（原子写 + RLock）
│  ├─ dpapi.py / reminder.py    # 凭据加解密（DPAPI）/ 提醒判定
│  ├─ events.py / main.py       # SSE 事件总线 / 进程入口（打印 PORT=）
│  └─ tests/                    # pytest 用例与测试替身
├─ frontend/                    # 原生 ES Module 前端（零构建，由后端静态托管）
│  ├─ app.js                    # 入口：状态、渲染、交互装配
│  ├─ lib/                      # 纯逻辑模块：api / cal / colors / fmt / page / sse
│  ├─ tests/                    # node:test 单测（页面逻辑与纯函数）
│  ├─ index.html / style.css    # 页面骨架与样式
│  └─ package.json              # 仅供 node --test 使用（无依赖、无构建）
├─ electron/                    # Electron 外壳（无边框窗口 + 托盘）
│  ├─ main.js / preload.js      # 主进程 / contextBridge 能力暴露
│  ├─ build/installer.nsh       # NSIS 自定义页（快捷方式选项）
│  ├─ resources/backend/        # 打包用 backend.exe（构建产物）
│  ├─ dist/                     # 安装包/便携版输出（构建产物）
│  └─ icon.png / tray.png / make-tray-icon.js / package.json
├─ packaging/                   # 打包脚本
│  ├─ backend_entry.py          # PyInstaller 入口
│  └─ build.ps1                 # PyInstaller + electron-builder 一键打包
├─ docs/superpowers/            # 设计与计划文档
│  ├─ specs/                    # 各 rev 设计案（含实测记录）
│  └─ plans/                    # 分阶段实施计划
└─ README.md / requirements.txt / pytest.ini / .gitignore
```

> 说明：`.venv/`、`backend/**/__pycache__/`、`electron/node_modules/`、`electron/dist/`、`electron/resources/`、`build/` 为本地生成物，不纳入版本库；`electron/tests/` 无独立测试目录，外壳行为由真机隔离实例（WMI + CDP）验证。

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
.\.venv\Scripts\python -m pytest                              # 149 用例
node --test "frontend/tests/**/*.test.js"                     # 39 用例

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
