# 作业日程 — BB 拉取过滤设计（rev9-BB）

> 需求已与用户确认：① **拉取窗口**——不拉取"早于（今天 − N 个自然月）"的条目，默认 1 个月、设置项可调（1/2/3/6 个月/不限）；② **可用性甄别**——对通过窗口且带 `contentId` 的列实际访问内容页，403/404 → 丢弃，其余错误 fail-open 保留；**明确不做班级/分组启发式**（"不以班级为依据，只以内容可见性为依据"）；③ **无截止时间条目 → 丢弃**；④ 已有旧数据由既有 purge（sync 后清理未再出现者）自动清除。

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-14 |
| 分支 | `feature/bb-pull-rev9`（基于 master @ `e8f4e38`，不合并、不推送） |
| 基线 | rev8 完成（色表后端持久化）；后端 133 / 前端 39 全绿 |
| 真实数据现状 | 本机库 243 条 assignment（另 343 条非 Attempts 列从未入库）；无期 117 条、早于窗口 117 条、未发布/他班 4 条 |

---

## 1. 需求拆解

| # | 要求 | 目标定义 |
|---|---|---|
| R1 | 拉取窗口 | 只保留 `due_at[:10] >= 今天 − N 个自然月`（≥ 保留）；默认 1 个月；0 = 不限；设置项可调（1/2/3/6/不限） |
| R2 | 内容可见性甄别 | 带 `contentId` 的列访问 `/courses/{cid}/contents/{contentId}`：**403/404 → 丢弃**；网络/5xx/401/非 JSON → **fail-open 保留** |
| R3 | 无截止时间丢弃 | `due` 缺失/不可解析 → 丢弃（上游补 due 后下次同步自动重新拉取） |
| R4 | 零误伤与请求数 | 三层过滤全部在取 attempts **之前**完成；被丢弃的列不发 attempts/content 请求；单课程失败不影响其它课程（既有行为） |
| R5 | 配置与 UI | `bb_pull_months` 入 `DEFAULT_CONFIG`；设置面板 BB 分组新增"拉取范围"下拉，读写走既有 settings 通道 |

## 2. 现状与约束

- 现状：`fetch_assignments` 对每门课的全部 Attempts 列无条件取 attempts 并入库（无窗口、无可见性判断），导致旧学期/无期/他班/未发布列全部进库（本机 243 条）。
- 既有机制：sync = `fetch → upsert → purge(synced_at < started)`；**空 records 时跳过 purge**（护栏：区分"确实没有作业"与"全部抓取失败"）——过滤后若保留集为空，旧数据不会被清（既有边界，见 §6）。
- 既有测试缝：`Service(fetch_fn=...)` 注入；签名同步更新（含 tests 中的 fake）。
- 约束：不改 electron/、不改 rev8 展示逻辑；不做班级/分组过滤。

## 3. 方案设计

### 3.1 三层过滤（顺序即请求数优化）

`fetch_assignments(bb, pull_months=1)` 对每门课的每个评分列：

```
① get_assignment_columns 已滤：grading.type == "Attempts"（既有）
② due_at 缺失 → 丢弃                （不发任何后续请求）
③ due_at[:10] < cutoff → 丢弃       （不发任何后续请求）
④ 带 contentId 且内容 403/404 → 丢弃（只发 1 次 content 检查；不发 attempts）
⑤ 其余 → get_attempts → 归一化入库
```

被丢弃的列零 content/attempts 请求——本机真实数据下每轮省去 238 次 attempts（+ 238 次 content 检查中仅 5 次必要）。

### 3.2 自然月减法与窗口比较

- `subtract_months(d, months)`：自然月减法 + **月末钳制**（`calendar.monthrange`）：`2026-03-31 − 1 → 2026-02-28`；闰年 `2024-03-31 − 1 → 2024-02-29`。
- `pull_cutoff(months, today=None)`：`months<=0 → None`（不限）；非法值（非数字）回退 1 个月。
- 比较用**本地日期部分**（`due_at[:10] >= cutoff`，字符串字典序即日期序），≥ 保留（边界当天保留）。

### 3.3 内容可见性甄别（fail-open）

- `content_visible(bb, course_id, content_id)`：`get_json("/courses/{cid}/contents/{contentId}")`；
  - `NetworkError` → 按 `e.status` 判定：**403/404 → 不可见**；其余（None/5xx/非 JSON）→ **可见（保留）**；
  - `SessionExpired`（401 重登后仍 401）→ 保留（会话问题不属于"内容不可见"）。
- `cas.NetworkError` 增加 `.status` 属性（构造参数，默认 None）：`get_json` 非 200 时带上状态码；**message 格式不变**（旧调用方/测试按文案匹配仍兼容）。
- 依据（真实账号探测，见 §7.2）：未发布内容与他班内容均表现为 **403**（发布/选课后自动 200 → 下次同步自动出现），因此以 HTTP 状态为唯一依据即可，无需班级启发式。

### 3.4 配置与前端

- `backend/config.py`：`DEFAULT_CONFIG["bb_pull_months"] = 1`（0 = 不限）；经 `save_config` 键过滤放行。
- `backend/service.py`：`sync_now` 内 `months = config.load_config().get("bb_pull_months", 1)` → `self._fetch_fn(session, months)`（沿用既有 config 读取方式；保留可注入测试缝）。
- 前端：`index.html` BB 分组新增 `<select id="s-pull-months">`（1/2/3/6/0 → 1 个月…不限）；`openSettings` 回显（非法值回退 1）、`saveSettings` 随既有 payload 提交。

### 3.5 旧数据清理（既有机制）

sync 的 `purge(synced_at < started)` 自动清理"本次未再出现"的旧行 → 无需迁移脚本；仅当保留集为空时不 purge（护栏，见 §6）。

## 4. 实施计划

| 任务 | 内容 | 涉及文件 |
|---|---|---|
| **T1 后端** | 窗口工具 + 可见性检查 + `fetch_assignments` 过滤；`NetworkError.status`；service 读配置传参 | `backend/bb.py`、`backend/cas.py`、`backend/service.py`、`backend/config.py` |
| **T2 测试** | 窗口各值/月末钳制/无期/403/404/网络保留/请求计数；fake 签名同步 | `backend/tests/test_bb.py`、`test_service.py`、`test_app.py`、`service_fakes.py` |
| **T3 前端** | 设置项"拉取范围"下拉 | `frontend/index.html`、`frontend/app.js` |
| **T4 真机验证** | 真实账号只读干跑 + purge 临时副本演练 + 设置项冒烟（隔离实例 + 截图读图） | `%TEMP%\opencode\pwtest\bbrev9\` |
| **T5 文档** | 本设计案 + README/计数同步 | 本文档、`README.md` |

## 5. 验收标准

1. 回归：pytest 全绿（133 → **149**）；`node --test` 全绿（**39**）。
2. **R1**：窗口 0/1/2/3/6 与月末钳制（含闰年）单测通过；边界当天保留。
3. **R2**：403/404 丢弃；5xx/网络错误/无 `contentId` 保留。
4. **R3**：无期丢弃（`pull_months=0` 也不入库）。
5. **R4**：被丢弃列不发 content/attempts 请求（请求队列长度 + URL 断言）。
6. **R5**：隔离实例设置项保存后 `config.json.bb_pull_months=3`、重载回显 3、改回 1 生效。
7. 真实账号干跑：保留 5 条（CS lab1/CS Declaration/EAP 1-7×2/Compilers A1），与 walk 结果一致。
8. purge 演练（临时副本）：243 → 5（removed=238）；真实库 mtime/行数前后不变。
9. 进程零残留；真实 `%APPDATA%` 未写入。

## 6. 风险与边界

- **fail-open 取舍**：瞬时 5xx/网络故障不删数据（宁可多留），代价是故障期间的"他班/未发布"列可能短暂入库，下次成功同步即被 purge。
- **空保留集不 purge**（既有护栏）：若某轮过滤后 records 为空（如全部课程抓取失败或窗口内确无作业），旧行保留不清；本机常态保留 5 条，不受影响。
- **无 contentId 的列不做可见性判断**（无从探测），仅受窗口/无期约束。
- **未发布内容发布后**：下次同步内容变 200 → 自动重新入库（无需手动干预）；反之已发布内容若被撤下（403），下次同步被 purge。
- **不做班级/分组启发式**（用户明确否决）；也不解析内容页 HTML/分组信息。
- 窗口以 `due_at` 的**本地日期**为准（与展示/提醒口径一致），跨时区边界日可能有 1 天差异。

---

## 7. 实测记录（2026-09-14）

### 7.1 单测（原始结果）

```
$ .\.venv\Scripts\python -m pytest
149 passed in 2.68s        （133 → 149，+16：窗口 8 组参数化 / 月末钳制 / cutoff 值 / 无期丢弃 /
                            403·404·5xx 可见性 / 网络错误保留 / 无 contentId 跳过 / 丢弃列零请求 /
                            NetworkError.status / 边界当天保留 等）

$ node --test "frontend/tests/**/*.test.js"
tests 39 / pass 39 / fail 0
```

### 7.2 真实账号只读干跑（`dryrun.py`，DPAPI 凭据仅内存）

窗口 = 1 个月 → `cutoff=2026-08-14`。逐条清单（`dryrun-m1.txt`，219 行）：

| 结果 | 条目 | due | 说明 |
|---|---|---|---|
| 保留 | Computer Security Fall 2026 · lab1 | 2026-09-14 | content 200 |
| 保留 | Computer Security Fall 2026 · Undergraduate Students Declaration Form Submit | 2026-09-27 | content 200 |
| 保留 | EAP Fall 2026 · Literature retrieval (Group work)-Classes 1-7 | 2026-09-20 | content 200 |
| 保留 | EAP Fall 2026 · Quiz about library research-Classes 1-7 | 2026-09-20 | content 200 |
| 保留 | Compilers Fall 2026 · Assignment1 | 2026-09-27 | content 200 |
| 丢弃 ×4 | CS lab2 / EAP -Class 8 ×2 / AI（2026秋）Assignment0 | — | **内容 403**（未发布 + 他班，正是用户抱怨的"他班作业"） |
| 丢弃 ×117 | EAP/AI/… 各课程 | 无 | 无截止时间 |
| 丢弃 ×117 | CS lab3–12、EAP 各周作业、数理逻辑 2025 等 | 2025-09~2026-06 | 早于窗口 |

汇总：`{"非作业列": 343, "无截止时间": 117, "早于窗口": 117, "内容403": 4, "内容404": 0, "其他错误保留": 0}`；Attempts 列合计 5 + 238 = **243**（与库内行数一致）。交叉核对：`fetch_assignments(1)` 返回 **5 条**，与 walk 保留集合 `一致=True`。

> 探测证据与用户实证一致：EAP `-Classes 1-7` 200 / `-Class 8` 403；CS `lab1` 200、`lab2..lab12` 403（未发布）；AI `Assignment0` 403；Compilers `Assignment1` 200。

### 7.3 purge 演练（真实库临时副本，`purge_rehearsal.py`）

```
真实库（演练前）：mtime=1789352898 rows=243
副本：…\bbrev9\purge-rehearsal.db（复制后 243 行）
fetch_assignments(1) → 5 条
upsert: added=0 updated=5；purge: removed=238
副本行数：243 → upsert 后 243 → purge 后 5
保留清单：CS lab1 / CS Declaration / EAP 1-7 ×2 / Compilers A1
真实库（演练后）：mtime=1789352898 rows=243
真实库未变：mtime_same=True rows_same=True
```

### 7.4 设置项冒烟（隔离实例 `%TEMP%\hwqa-rev9`，CDP）

| 步骤 | 证据 |
|---|---|
| 打开设置（默认） | 下拉回显 `1`；截图 `settings-default-1m.png` |
| 选 3 个月 → 保存 | `select=3`、`GET /api/settings → 3`、提示"已保存"；**`config.json.bb_pull_months=3`**；截图 `settings-saved-3m.png` |
| 重载 → 打开设置 | 下拉回显 **`3`**（持久化生效）；截图 `settings-reload-shows-3m.png` |
| 改回 1 → 保存 | `select=1`、API=1、**`config.json.bb_pull_months=1`** |

**模型直接读图**（Read 工具，未用 vision.js）：三张截图均为设置弹层——「BB 日程设置」分组内、同步间隔下方即为「拉取范围（BB 作业）」下拉，`settings-saved-3m.png` 与 `settings-reload-shows-3m.png` 中下拉显示「3 个月」，与其余设置项（提醒/窗口）风格一致、无遮挡或截断 → 达标。

### 7.5 零残留证据

```
TASKKILL tree（隔离实例 electron 主进程 + 子进程，含后端 python 链）
RESIDUE electron=0 backend_main=0 port9258(listen)=0 port9258(all)=2（TIME_WAIT，复查后为 0）
```

真实 `%APPDATA%\作业日程\data.db`：演练前后 mtime/行数一致（见 7.3）；干跑与演练全程只读真实 BB、凭据仅内存（未打印/落盘/复制）。
