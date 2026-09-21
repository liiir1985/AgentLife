# 阶段 0 Spike 报告

- 日期：2026-09-21
- 范围：只验证工程可行性（Pi Agent / Pi TUI / 内容包 / SQLite / Mistreevous），不实现玩法或领域系统
- 结论摘要：五组 Spike 退出条件全部满足，**阶段 0 完成**；Mistreevous 判定为**受限接受**；TUI 决定**保留 Pi TUI，不启用 Web 回退**；Windows Terminal 人工验收清单已逐条执行并全部通过（§6.3）

## 1. 环境与依赖

| 项 | 值 |
| --- | --- |
| OS | Windows 11 Pro（win32 10.0.26200） |
| Node | v24.14.1（`node:sqlite` 自带，启动时打印 ExperimentalWarning） |
| 包管理器 | pnpm 11.19.0（`packageManager` 固定，提交 `pnpm-lock.yaml`） |
| 模块体系 | ESM（`"type": "module"`）、`moduleResolution: NodeNext` |
| TS | typescript 7.0.2，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noUnusedLocals/Parameters` |

直接依赖（全部 `--save-exact`）：

```
@earendil-works/pi-ai          0.86.1
@earendil-works/pi-agent-core  0.86.1
@earendil-works/pi-tui         0.86.1
drizzle-orm                    1.0.0-rc.4   (RC 线，见 §5)
mistreevous                    4.3.1
typebox                        1.3.34
yaml                           2.9.1
vitest                         5.0.1
tsx                            4.23.15
prettier                       3.9.8
@types/node                    26.6.2
```

`pnpm-workspace.yaml` 显式声明 `allowBuilds`（esbuild 允许，`@google/genai`/`protobufjs` 禁止），无该声明时 pnpm 11 会以 `ERR_PNPM_IGNORED_BUILDS` 拒绝执行任何脚本。

统一入口：`pnpm test` / `pnpm typecheck` / `pnpm check:format` / `pnpm spike:{agent,tui,content,storage,behavior}` / `pnpm tui:manual` / `pnpm phase0:verify`。

## 2. 交付的接口

| 接口 | 文件 |
| --- | --- |
| `AgentRuntimeProbe`（启动/超时/取消/事件订阅/按身份接纳） | `src/agent/agent-runtime-probe.ts` |
| `ContentPackLoader` / `ContentPackSnapshot` | `src/content/content-pack-loader.ts` |
| `RuntimeStoreProbe` / `SnapshotEnvelope` / `VersionedPayload` / `parseStoredPayload` | `src/storage/runtime-store-probe.ts` |
| `BehaviorTreeAdapterProbe` / `BehaviorRuntimeState` | `src/behavior/behavior-tree-adapter.ts` |
| `SpikeViewModel` / `SpikeModel` | `src/tui/spike-view-model.ts` |
| TUI 组装、输入（含多行粘贴 chip）与 Overlay | `src/tui/spike-app.ts` |
| 终端替身（测试用屏幕缓冲） | `src/tui/virtual-terminal.ts` |
| 人工验收入口 | `src/tui/manual-spike.ts` |

## 3. 逐项实验

### 3.1 Pi Agent

命令：`pnpm spike:agent` → `tests/agent-runtime-probe.test.ts`，6 passed。

证据与结论：

1. **工具面收敛**：Agent 只注册一个 `submit_probe` 工具（`probe.toolNames`），无文件/Shell/数据库/世界写入工具。脚本中让模型调用 `read_world_file` 时，Pi 预检直接以 `isError: true`（"Tool read_world_file not found"）拒绝，`execute` 从不执行，`submissions` 为空。
2. **TypeBox 参数校验必须自己做**：Pi 的预校验会做**原语强制转换**——`{value: 42}` 传给 `Type.String()` 参数后，`execute` 收到的是 `"42"`（实测输出 `recv string {"value":"42"} true`）。因此适配层在 `beforeToolCall` 中用**原始** `context.toolCall.arguments` 做 `Value.Check`，不通过则 `{block:true}`；此时产生 `isError: true` 的工具结果，且未写入模拟状态。测试断言 `rejections = [{value: '{"value":42}', reason: "invalid-arguments"}]`。
3. **流式事件顺序**（折叠连续同类事件后的实测序列）：

```
agent_start, turn_start, message_start:user, message_end:user,
message_start:assistant, update:toolcall_start, update:toolcall_delta, update:toolcall_end, message_end:assistant,
tool_execution_start, tool_execution_end, message_start:toolResult, message_end:toolResult, turn_end,
turn_start, message_start:assistant, update:text_start, update:text_delta, update:text_end, message_end:assistant,
turn_end, agent_end
```

4. **身份门控**：每次运行分配 `{timelineId, roundId, requestId}`（`requestId` 为 UUID）；`submit()` 只接受当前活动身份，其余进入 `rejections`。
5. **取消**：慢速流（faux `tokensPerSecond: 25`）中调用 `cancel()` → `status = "cancelled"`，无提交；随后用旧身份提交返回 `"stale"` 并记录诊断。
6. **超时**：包装层 `AbortController` + `setTimeout`（`timeoutMs`），模拟状态不依赖真实时间 → `status = "timed-out"`，迟到结果被拒。
7. **取消后恢复**：同一 `timelineId/roundId` 换新 `requestId` 重新运行 → `completed` 且提交被接纳，旧身份仍被拒。

### 3.2 Pi TUI

命令：`pnpm spike:tui` → `tests/tui-spike.test.ts`，19 passed。

测试通过自建 `VirtualTerminal`（实现 pi-tui `Terminal` 接口：屏幕缓冲 + `sendInput` + `resize`）读取"用户看到的画面"：

1. 120×30：首行顶栏（时间线/轮次/Tick/阶段）、地点与实体分栏同排、末行固定输入栏，且所有行 `visibleWidth <= 120`。
2. 80×24：分栏退化为标签页 `[地点] 实体`，实体内容不可见；`Tab` 切换为 `[实体]` 后实体可见，再切换回原状。
3. 动态缩放：140→80→120 列时布局在 wide/narrow 间切换，窄屏所有行宽 ≤ 80。
4. 日志跟随/回看：120 行日志时 `isFollowingOutput = true` 且末行可见；`PageUp` 后 `viewportTop` 下降、首个可见行号等于 `viewportTop`、末行不可见；回看期间追加新行不改变 `viewportTop`、新行不可见；连续 `PageDown` 恢复跟随。滚轮事件（SGR `\x1b[<64;20;12M`，`mouse: true`）同样可回看。
5. Overlay 焦点：`F2` 打开监视 Overlay（显示时间线/轮次/Tick/阶段/布局/日志行/流式字符/实体数/输入），此时输入不落到输入框（`getValue() === ""`）；Overlay 打开期间缩放，监视面板即时显示 `narrow`；再按 `F2` 关闭后焦点回到输入框，输入立即生效。
6. 中文宽字符：窄屏下写入中文地点/日志，整行宽度不超 80 列且文本完整（换行由 pi-tui 计算，spike 不做手工切分）。
7. 流式合并刷新：连续追加 200 个 token 期间帧数为 0（每个 token 不整屏刷新），一次 `renderNow(true)` 后帧数 +1 且累积文本完整；`finishStream()` 后流式缓冲清空并落入日志。
8. 多行/超长粘贴（chip）：`\x1b[200~第一行\n第二行\n第三行\x1b[201~` 后输入行只有 `[粘贴 #1]`，视图模型 `pastes = [{n:1, label:"[粘贴 #1]", lines:3, chars:11, preview:"第一行"}]`，输入栏上方出现卡片行 `#1 粘贴 · 3 行 · 11 字 · 第一行`；`Enter` 后日志写入完整三行（换行保留）、输入清空、卡片消失。
9. 跨读切分的粘贴：`\x1b[200~第一行\n第二` 与 `行\x1b[201~` 两次投递合并为同一个 chip（`lines = 2`），期间输入行保持为空；连续 `Backspace` 删掉 token 后卡片消失，`Enter` 提交不写入任何粘贴内容（token 脱落语义）。
10. 单行短粘贴仍内联（`\x1b[200~单行文本\x1b[201~` → `单行文本`，`pastes` 为空）；默认构造的 `SpikeApp` 写出的字节里**不含** `\x1b[?1006h`（不捕获鼠标），`mouse: true` 时含（见 §5.1 第 11 条）。
11. 右键粘贴（Windows）：`mouse: true` + `\x1b[<2;20;12M` 读剪贴板 `"一\r\n二\t三\n"` → chip `[粘贴 #1]`、卡片显示 `3 行`；`Enter` 后日志出现 `> 一` 与 `二    三`（tab→4 空格）。
12. 粘贴内容规范化：粘贴含 `\x1b[31m…\x1b[0m`（ANSI 颜色）、`\t`、`\x07` 的两行块 → chip 记录 `lines: 2, chars: 18, preview: "[31m红[0m"`（ESC 与 BEL 被剔除、换行保留），提交后日志为 `> [31m红[0m\n第二行    制表`。即**粘贴里的控制字节不会进入渲染管线**（否则会破坏画面）。
13. 超长粘贴：200001 字符的单行粘贴变成 chip（`chars > 200000` 含截断标注），提交后画面末行可见 `…（粘贴内容超过 200000 字，已截断）`。
14. 备用屏幕里的滚轮（WT 的 Alternate Scroll 把滚轮转成 `\x1b[A`/`\x1bOB` 之类的方向键）：裸 `Up`/`Down` 每次滚动日志一行并停止跟随（`viewportTop` 逐次 -1 / +1），且不会落进输入行、不影响后续打字；`ctrl+up`/`ctrl+down` 仍是语义提示跳转（`tui.altScreen.previousPrompt/nextPrompt`）。

人工验收（§6）另在 pty 中实跑：启动、渲染、`F2` 监视、流式输出、`Ctrl+C` 退出（exit 0）。

### 3.3 内容包

命令：`pnpm spike:content` → `tests/content-pack-loader.test.ts`，11 passed / 1 skipped。

1. 合法包：读取 `manifest.yaml`、解析 YAML、解析受控 Markdown 引用，返回冻结快照（`snapshot`、`files`、`references`、每个 `file` 均 `Object.isFrozen`）。
2. 身份：SHA-256，文件按规范化相对路径排序，按"路径长度(8B BE) + 路径 + 内容长度(8B BE) + 原始字节"串联；`sha256:` 前缀 + 64 位十六进制。
3. 顺序无关：同一组文件以正序/逆序写入两个临时目录，身份相同且文件清单相同。
4. 内容敏感：修改任一参与文件身份必变；改回原内容身份复原。
5. 无歧义串联：把同样的字节在 `a.md`/`b.md` 之间搬移（`"ab","c"` 对 `"a","bc"`）身份不同。
6. 拒绝样例（全部抛出 `ContentPackError`）：绝对路径、盘符路径、`../`、`..\`、`nested/../../`、Markdown 中的 `](../outside.md)`、缺失被引用文件、不支持的扩展名（`notes.txt`）、缺失/非映射的 manifest。
7. **目录联接逃逸**：在包内创建指向包外目录的 junction，报错为 `Symbolic links are not allowed: linked`——即遍历在**读到链接本身时**就拒绝（若跟随进入，错误会是包外不支持的 `secret.bin`），包外内容不会被读入快照。
8. **文件符号链接**：本机创建文件符号链接需要特权（`EPERM`），该用例被跳过（`context.skip()`），代码路径与 junction 相同（`lstat().isSymbolicLink()`），但**未在本机实测**。

### 3.4 SQLite

命令：`pnpm spike:storage` → `tests/runtime-store-probe.test.ts`，9 passed。

1. 驱动：`node:sqlite` + `drizzle-orm/node-sqlite`（RC）建表、写事务、读查询；`PRAGMA foreign_keys=ON`、`journal_mode=wal`、`busy_timeout=1000` 实测生效（断言 `journal_mode=wal`、`foreign_keys=1`、`busy_timeout=1000`）。
2. 最小表：`timelines`（自引用父时间线）、`payloads`、`snapshots`、`idempotency_commits`、`phase_records`，均 `STRICT`，JSON 列带 `CHECK(json_valid(...))`。Drizzle 表定义与 `PRAGMA table_info` 列名逐个表比对一致（防定义漂移）。
3. `VersionedPayload` 写入与读取都过 TypeBox：未知版本、结构不符、损坏 JSON 都显式失败；`snapshots` 的 CHECK 使非法 JSON 无法落库（原始 SQL 直插被拒）。
4. 同一事务提交快照 + 阶段记录 + 幂等身份；重复幂等键返回 `duplicate` 且不产生新行。
5. **故障注入**（子进程 `src/storage/crash-worker.ts`，硬退出不复位）：
   - `before-transaction`（exit 1）：四张表行数均为 0；
   - `inside-transaction`（exit 1，事务未提交即被杀）：四张表行数均为 0，无半快照；
   - `after-commit`（exit 3，已提交但未确认）：四张表各 1 行，`latestSnapshot` 等于完整新状态。
6. 恢复：`restoreAsNewTimeline()` 生成新时间线（记录 `parent_timeline_id`）并复制快照；用原幂等键重复续做返回 `duplicate`，快照行数不增长；用新键续做正常追加。

### 3.5 Mistreevous

命令：`pnpm spike:behavior` → `tests/behavior-tree-adapter.test.ts`，10 passed。

**先验证公共 API 能否导出/恢复运行节点状态：不能。** `BehaviourTree` 只暴露 `step/reset/getState/isRunning/getTreeNodeDetails`，没有状态导入；节点 id 由 `createUid()`（`Math.random()`）生成，同一份定义在两棵树上 id 不同（实测 `4b1941c0-…` vs `e69c7012-…`）。因此采用**受限适配方案**：

1. 只接受 JSON 定义（MDSL 字符串直接拒绝："Behaviour trees must be supplied as a JSON object, not MDSL text"）。
2. 构造前递归校验：节点类型白名单、函数名必须在固定注册表内、参数必须是 JSON 且禁止 `{$: ...}` 引用、`repeat/retry` 必须是正整数（数组区间视为随机，拒绝）。
3. 白名单：`root sequence selector parallel race all repeat retry flip succeed fail action condition`。
4. 排除项及理由（错误信息内含理由）：`wait`（跨 step 累积时长，无法导出）、`lotto`（消耗随机）、`branch`（运行时从全局注册表解析子树）。
5. 注册表分为 `functions`（action 与 entry/step/exit 回调，返回 `succeeded|failed`）与 `predicates`（condition 节点与 while/until 守卫，**必须返回真正的布尔值**）。实测证据：守卫返回字符串会抛 `expected guard condition function 'guard' to return a boolean`；condition 节点同理；action 返回 `void` 会让节点停在 `RUNNING`，所以适配层把每个函数结果强制映射为 `SUCCEEDED/FAILED`。
6. 函数可见面只有 `read/write/emit`（有界 JSON 黑板 + 计划记录），拿不到世界、私有状态、I/O、LLM、时钟；`getDeltaTime` 只返回显式配置的 `tickSeconds`；`random` 被替换为抛错（白名单已排除随机节点，这是第二道闸）。
7. **单 step 内结束**：`decide()` 内部循环 step 到树不再 `RUNNING`，步数上限 `maxStepsPerDecision`（默认 256），超限抛错并把适配器标记为不可用；失败时黑板不提交（决策原子）。`repeat(3)` 在一次决策内产出 `["tick","tick","tick"]`（实测 mistreevous 需要 N+1 次 step 才收敛）。
8. **轨迹可复现的关键修正**：mistreevous 在 `step()` 内部才惰性重置已解决节点，导致"刚跑完上一 tick 的实例"会多出一批 `ready` 变化，而新实例不会。适配器在每次决策开始时显式 `tree.reset()` 并**丢弃**这批噪声，再清空 trace，因此保存/恢复后的轨迹与新实例逐条一致（trace 用结构化路径 `root#0/sequence#0/condition:hasEnergy`，与随机 id 无关）。
9. 确定性验收：正常连跑 tick 1..3，与"跑到 tick 2 导出状态、恢复后跑 tick 3"的决策（计划、黑板、trace、状态导出）逐字段相等。
10. 幂等：重复 `key` 返回 `already-applied` 且黑板不变；tick 必须严格递增，否则报错。

**结论：受限接受**（restricted accept）。前提是后续阶段必须遵守：只用白名单节点、只用注册表函数、决策原子化、黑板与幂等身份由适配层持久化、不读取或修改 mistreevous 私有字段（本阶段未触碰 `_rootNode` 等内部字段）。

## 4. 五组 Spike 退出条件

| 组 | 退出条件 | 结果 |
| --- | --- | --- |
| Pi Agent | 工具调用与流式顺序正确；取消/超时后不再提交；旧身份迟到结果只进诊断 | 通过（6 项测试） |
| Pi TUI | 宽窄布局、缩放、日志滚动、Overlay、焦点自动测试通过 | **通过**（自动：TUI 19 项 + 演示脚本 5 项；人工：`src/tui/manual-spike.ts` 清单在 Windows Terminal 逐条通过，见 §6.3） |
| 内容包 | 合法包身份稳定；目录逃逸全部被拒且未读取包外内容 | 通过（11 项测试，1 项因 Windows 权限跳过） |
| SQLite | 故障注入后无半快照；恢复与重复续做不产生重复效果 | 通过（9 项测试） |
| Mistreevous | 不读机器时间/随机；保存恢复轨迹一致；未授权节点与函数在加载阶段被拒 | 通过（10 项测试，受限适配） |

`pnpm phase0:verify` = `typecheck && check:format && test`：全部通过，无网络、无凭据（Agent 只用官方 faux provider，其余全为本地文件/SQLite/内存）。

```
pnpm typecheck      ok
pnpm check:format   ok
pnpm test           6 files, 60 passed | 1 skipped（含 TUI 19 项与演示脚本 5 项）
```

**结论：五组 Spike 全部满足退出条件，人工验收清单（§6.3）全部通过，阶段 0 判定完成。** 未通过项为零，因此不触发组件替换或 Web 回退；已知限制见 §6.4，后续阶段的硬约束见 §7。

## 5. 决策记录

- **TUI vs Web**：保留 Pi TUI，**不追加 Fastify/WebSocket/React 原型**。依据：分栏/标签、焦点、滚动、Overlay、宽字符、渲染节流都能在 Pi TUI 上通过自动测试；唯一发现的阻断性输入问题（合并投递的控制字符块被丢弃）已通过输入处理规避（见 §5.1），不需要换技术栈。若后续阶段出现无法通过输入处理/焦点恢复/渲染节流规避的阻断问题，再按预案追加最小 Web 原型并复用 `SpikeViewModel`。
- **Drizzle node-sqlite（RC 线）**：**接受**，锁定 `1.0.0-rc.4`。依据不是文档而是实测：实际类型检查通过、`db.transaction()` 与查询构建器在事务/并发配置下工作正常、崩溃恢复语义符合预期。注意该驱动的 `resultKind` 是 `'sync'`（`db.run/get/all` 与 `transaction` 回调都是同步的，回调写 `async` 会被类型拒绝）。升级到正式版时必须重跑 `spike:storage`。
- **Mistreevous**：受限接受（§3.5）。

### 5.1 实测发现的库行为（后续阶段约束）

1. **Pi 工具参数会强制转换原语**（`42` → `"42"`）。任何工具的严格校验都必须放在 `beforeToolCall` 并对**原始** `toolCall.arguments` 做 TypeBox `Value.Check`；只在 `execute` 内校验是无效的。
2. **Pi 预检只拒绝未声明的工具**；未声明工具不会进入 `beforeToolCall`，错误由框架直接给出（"Tool X not found"）。
3. **pi-tui `Text` 默认 `paddingX=1, paddingY=1`**；做单行固定栏时必须传 `new Text(undefined, 0, 0)`，否则 `basis: 1` 的分栏会被裁成空白行。
4. **pi-tui `Input` 会整块丢弃含 C0 控制字符的输入**（`data.includes("\r")` 且无括号粘贴标记时，整块被丢）。已在 `SpikeApp` 中做分片重放：不含 `ESC` 的块按"可打印段 + 单个控制字符"拆开依次投递给当前焦点组件；含 `ESC` 的块原样放行以免破坏终端协议。括号粘贴 `\x1b[200~…\x1b[201~` 与逐字符（IME 风格）投递均正常。
5. **固定栏必须声明 `minSize`/`shrink: 0`，日志栏必须 `basis: 0`**：VStack 先按 `basis`（缺省取内在高度）分配，超出可用行数时进入 shrink 遍，按 `shrink × 当前高度` 加权回收——`ScrollView` 的内在高度等于内容高度（几百行），权重压倒性地大于高度为 1 的顶栏/输入栏，于是**顶栏与输入栏被压到 0 行**：画面上看不到输入栏，打字无任何可见反馈（实测：日志 ≥ 30 行即触发；`renderLayoutFrame` 的 rect 高度实测为 `[0,3,27,0]`）。修法：顶栏/输入栏 `basis: 1, minSize: 1, shrink: 0`，日志 `basis: 0, grow: 6, minSize: 5`，左右分栏 `maxSize: 12`。回归测试：`keeps the header and the input bar visible under a long log`。
6. **`ESC [ [ C` 不是噪声，是 pi-tui 的 F3 legacy 序列**（`keys.js` 的 `LEGACY_KEY_SEQUENCES`）。在本项目 pty/ConPTY 冒烟里，终端会在启动时注入一次该序列；若被拆分投递，尾字节会作为普通文本落进输入框。曾据此误加"丢弃畸形 CSI"的过滤器，随后查证它是合法按键、且无法在真实终端里与人为按 F3 区分，已回退；该现象改记入人工清单（启动后先确认输入栏为空）。
7. **`node:sqlite` 仍是实验特性**（进程启动打印 ExperimentalWarning）；数据库文件与 WAL 文件均不提交（`.gitignore`）。
8. **滚动回看时视图不会切走固定栏**（早前误判为"文档模式"——见 §5.1 第 5 条的真实原因）：回看时顶栏与输入栏保持可见，`PageUp` 只是移动日志视口；单次 `PageDown` 不保证回到末尾（内容比视口长时会被 clamp），需连续翻页。
9. **`Home`/`End` 被全屏视口抢走**：默认键位里 `tui.altScreen.top = home`、`tui.altScreen.bottom = end`，而 `TuiAltScreen` 在构造时就把视口处理器注册为输入监听（**先于**应用自己的监听），因此输入栏永远收不到 Home/End，光标无法移行首/行尾。修法：用 `setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {...}))` 把 `tui.altScreen.top/bottom` 改绑到 `ctrl+home`/`ctrl+end`，把 `home`/`end` 让给 `tui.editor.cursorLineStart/End`（`ctrl+a`/`ctrl+e` 仍然可用）。注意：`setKeybindings` 接收的是 manager 实例而不是配置对象，`getKeybindings()` 之后直接调用 `.matches()`。
10. **粘贴会丢换行**：`Input.handlePaste` 直接 `replace(/\r\n|\r|\n/g, "")`，多行文本被静默拼成一行（"第一行\n第二行" → "第一行第二行"）。**修法（参照 OMP 的 chip 结构）**：多行或超长粘贴不再挤进单行输入，而是**留成 token**——输入行只出现 `[粘贴 #N]`，粘贴全文按 `{n, label, lines, chars, preview}` 登记在 `SpikeModel`，输入栏上方用 `basis: "auto"` 的条目渲染卡片行（`#N 粘贴 · M 行 · K 字 · 预览`），提交时 `expandPastes()` 把 token 换成全文再写日志；token 从输入行消失（删字或清空）则卡片随之消失且不提交，计数器只增不减以免删掉的 token 被后一次粘贴复用。阈值：`> 1 行 或 > 1000 字` 走 chip，单行短粘贴仍内联（换行压成空格）。跨读切分的括号粘贴（`\x1b[200~` 与 `\x1b[201~` 落在不同读）由应用缓冲成**一个** chip。粘贴内容先规范化（CRLF/CR→LF、tab→4 空格、剔除除 LF 外的所有 C0 控制字符，含 ESC），上限 200000 字符并显式标注截断。
    参照对象是 OMP 18.2.5 的实际实现（`packages/tui/src/components/editor.ts`、`packages/coding-agent/src/modes/controllers/input-controller.ts`、`config/settings-schema.ts`）：编辑器用 `> 10 行 或 > 1000 字` 判定 marker-sized，`insertTextAttachment()` 递增计数、把 `[Paste #N]` 作为不可分原子 token 插入缓冲并登记 `pendingTexts`，编辑器上方渲染带预览的卡片；`paste.largeMenuThreshold`（默认 100 行）以上再弹菜单（包成 `<attachment>` 块 / 写成 `local://paste-N.md` / 内联）；`composerChips()` 用 `text.includes(label)` 过滤，因此删掉 token 就等于丢弃附件。我们把阈值收紧到"多行或 >1000 字"，原因是本 spike 的输入是单行 `Input`，换行根本无法表示。
11. **鼠标默认不捕获（框选/右键交给终端），滚轮靠终端的 Alternate Scroll 补上**：OMP 的 `tui.mouse` 默认 `false`，主会话不发送鼠标跟踪序列（`config/settings-schema.ts` 的 `tui.mouse`；fork `tui.ts` 的 `wantMouse` 只在全屏 Overlay opt-in 或该设置打开时才把 `\x1b[?1000h\x1b[?1003h\x1b[?1006h` 写出去，`MOUSE_TRACKING_ON` 上方注释就是"Selection-first surfaces leave these modes disabled so the terminal retains native text selection"）。OMP 这样做的前提是**主会话不使用备用屏幕**（只在外层 Overlay 里借 `?1049h`），所以它的滚动条/框选/右键全是终端自己的行为；本机的 `~/.omp/agent/config.yml` 没有 `tui.mouse` 键 → 默认关闭，因此在默认配置下 OMP 的文本框**不会收到任何鼠标事件**（点击落点/悬停都不可用），你在 OMP 里看到的点击、滚动、框选、右键都是 Windows Terminal 在处理同一块普通缓冲区。
    我们的是**固定分栏的备用屏幕**，必须自己决定：
    - `mouse: false`（默认）= 终端保留原生框选与右键；此时 WT ≥1.20 的 **Alternate Scroll Mode**（默认开启，PR #16535 / issue #13187，模式为 `\x1b[?1007h`）会在应用未捕获鼠标时把滚轮转成方向键发给应用。**修法**：把 `tui.altScreen.lineUp/lineDown` 改绑到裸 `up`/`down`（`SpikeApp` 的 `setKeybindings`），于是默认模式下滚轮照样滚动日志（一格≈一行），而框选/右键/清除选择仍是 WT 的。单行输入本来就用不到裸上下键，所以这不算牺牲；阶段 1 若要做命令历史，必须先给历史让位（见 §7）。
    - `mouse: true`（`pnpm tui:manual -- --mouse`）= 应用收到点击/滚轮/移动，日志按 `wheelScrollLines` 滚动、滚动条可拖；代价是原生框选退化为 Shift+拖拽、`copyOnSelect` 默认 `true`（松手即复制并闪 "Copied"）、自绘高亮只能靠左击清除（pi-tui 没有公开的 `clearTextSelection`），右键粘贴回调 `onRightClickPaste`（仅 Windows）也才有事件。已实测两种模式下 `Enter` 提交、`PageUp/PageDown`、`Ctrl+Home/End` 与粘贴 chip 都不受影响。

## 6. 人工验收工具与记录

### 6.1 演示脚本（`src/tui/demo-script.ts`）

人工验收需要一个"自己在动、但不影响人工操作"的界面，因此把脚本化演示从 `manual-spike.ts` 中抽成 `DemoScript`：每轮一个流、流结束（或取消）后才安排下一轮，任一时刻只有一个定时器，`roundCount` 轮后进入静止状态；`Ctrl+R` 重播，`Esc` 取消当前流并停止演示，`Ctrl+C` 退出。

**这段抽离来自一次真实缺陷**：最初版本用 `setInterval` 每 2 秒开一轮，而流需要 2.5 秒（62 字 × 40ms），于是每轮都会新起一个 `setInterval` 且旧句柄不再被清理——5 轮后同时有 5 条流在写日志，屏幕被 `轮次 6 结束` 刷屏（实测 20 秒写入约 500KB），输入仍能进字段但画面完全被日志占据，人工操作无法进行。修复后同一场景 25 秒写入 45KB，5 轮严格串行并以"自动演示结束"收尾。回归测试：`tests/demo-script.test.ts`（5 项，含"任一时刻定时器 ≤ 1""结束后无残留定时器""Esc 后不再排轮"）。

### 6.2 pty 冒烟（已执行）

`hub start node node_modules/tsx/dist/cli.mjs src/tui/manual-spike.ts`，随后投递真实按键序列：

| 项 | 结果 |
| --- | --- |
| 启动并渲染顶栏/分栏/输入栏 | 通过 |
| 5 轮串行执行，结束语出现，无刷屏 | 通过（25s / 45KB） |
| 流式增量输出可见（逐字符追加） | 通过 |
| 输入 + `Enter` 提交，日志出现 `> …` | 通过（合并投递的"文本+回车"也正确拆分提交） |
| 提示行列出鼠标模式（`鼠标：终端原生（框选/右键由 Windows Terminal 处理）`） | 通过（改默认后复跑） |
| 真实终端里 `Enter` 提交普通输入（`expandPastes` 路径） | 通过（改默认后复跑：日志出现 `> …走向钟楼`） |
| 真实方向键（WT 的 Alternate Scroll 就是发这个）不落进输入、之后打字与提交正常 | 通过（改绑后复跑：连发 3 次 `UP` 后输入 `滚轮键测试` + `Enter`，日志为 `> C滚轮键测试`，`C` 是启动注入的 F3 遗留；视口位移本身由自动测试断言） |
| `Ctrl+R` 重播演示 | 通过（日志再次出现"第 1 轮开始"） |
| `Esc` 取消流式 | 通过（日志出现"流式输出已取消（Ctrl+R 重新演示）"） |
| `F2` 打开监视 Overlay（显示 timeline/round/tick/阶段/布局/日志行/流式字符/实体数/粘贴/输入） | 通过 |
| `Ctrl+C` 退出，退出码 0，终端恢复 | 通过 |
| 右键粘贴（真实剪贴板，两行文本） | **已作废**：旧构建实测为"压成一行"，现已改为 chip（见 §5.1 第 10 条）。该路径改由 Windows 专用自动测试覆盖（`mouse: true` + `\x1b[<2;20;12M` → `[粘贴 #1]` + 卡片 + 提交展开），真实右键已在 §6.3 人工验收通过 |

**pty 冒烟无法覆盖括号粘贴**：`hub send` 转发输入时会把 ESC（以及 `\uXXXX`）转义成字面量字符，本机 pty 无法注入 `\x1b[200~…\x1b[201~`。因此该路径由 `VirtualTerminal`（实现 pi-tui `Terminal` 接口，`sendInput` 走的就是真实输入管线）的自动测试覆盖，WT 里的真实粘贴行为由 §6.3 的人工验收确认。

### 6.3 人工验收记录（Windows Terminal，已通过）

`src/tui/manual-spike.ts` 顶部清单在 Windows Terminal（微软拼音、真实鼠标/剪贴板）中逐条执行，**全部通过**（执行人确认；本节只记结论，逐条细节未逐字留档）。若后续复跑出现未通过项，必须在此逐条列出并触发 §5 的组件替换/Web 回退决策。

| 项 | 结果 |
| --- | --- |
| 微软拼音组合输入：候选窗口跟随输入栏光标；启动后输入栏为空（无 F3 legacy 残留） | 通过 |
| 中文输入后 `Enter` 提交，日志出现 `> 中文` | 通过 |
| `Ctrl+V` 与右键粘贴单行文本 → 内联；多行块 → `[粘贴 #N]` + 卡片，`Enter` 后换行完整写入日志 | 通过 |
| 删掉 `[粘贴 #N]` token 后卡片消失且提交不含粘贴内容 | 通过 |
| 默认（终端原生）模式：框选、右键菜单、清除选择由 Windows Terminal 处理 | 通过 |
| `--mouse` 模式：滚轮滚动日志、原生框选需 Shift+拖拽、左击清除应用高亮 | 通过 |
| 默认模式滚轮（WT 把滚轮转成方向键 → 本 spike 映射为单行滚动）：**人工验收之后才接线**，自动测试已覆盖方向键路径（§3.2 第 14 条），WT 中待复核 | 待复核（不阻断：键盘翻页与 `--mouse` 两条路径均已验证） |
| 拖拽/缩放窗口跨 120 列即时切换，画面稳定 | 通过 |
| `F2` 监视 Overlay 开关与焦点恢复；`Esc` 取消流式；`Ctrl+R` 重播；`Ctrl+C` 退出后终端恢复 | 通过 |

人工步骤见 `src/tui/manual-spike.ts` 顶部清单；复跑时把差异补写进本节。

### 6.4 已知限制（非阻断）

- **鼠标默认交由终端（这是选择，不是缺陷）**：`SpikeApp`/`pnpm tui:manual` 默认 `mouse: false`，框选、右键、清除选择都是 Windows Terminal 自己的行为（与 OMP 的 `tui.mouse` 默认值一致，OMP 之所以能这样是因为它的主会话在普通缓冲区、滚动条由终端持有）。默认模式的滚轮走终端的 Alternate Scroll（WT ≥1.20 默认开启）：终端把滚轮转成 `up`/`down`，本 spike 把裸上下键接到日志单行滚动，因此**滚轮、框选、右键三者可以同时成立**；代价是应用完全收不到鼠标事件（没有 hover、也不能点击定位插入点——本 spike 的输入栏始终持有焦点，所以不需要）。`--mouse` 打开应用接管：滚轮走 SGR、日志按 `wheelScrollLines` 滚动、滚动条可拖，但原生框选退化为 Shift+拖拽、松手即复制（`copyOnSelect` 默认 `true`）、高亮只能靠左击清除（pi-tui 无公开 clear API），且右键粘贴回调只在捕获鼠标时才有事件（仅 Windows）。
- **单行输入 + chip**：多行或 >1000 字的粘贴不进入输入行，而是 `[粘贴 #N]` token + 卡片（`#N 粘贴 · M 行 · K 字 · 预览`），提交时展开为全文；单行短粘贴仍内联（换行压成一个空格）。`[粘贴 #N]` 不是不可分原子（pi-tui `Input` 没有 token 概念），删掉其中任一字符即视为附件脱落；粘贴内容上限 200000 字符，超出会截断并在正文里标注。
- **非括号粘贴**：终端若不使用 `\x1b[200~…\x1b[201~`（pi-tui 已在启动时写 `\x1b[?2004h` 请求该模式），多行内容里的裸 `\r`/`\n` 仍会被当作提交键处理——该路径未做特殊兼容。

## 7. 后续阶段约束汇总

- 依赖：所有直接依赖固定精确版本并提交 lockfile；Pi 三包同线；升级 Mistreevous/Drizzle/pi-tui 必须重跑对应 spike。
- Agent：工具面按用途收敛；参数严格校验在 `beforeToolCall`；结果提交必须带 `{timelineId, roundId, requestId}`；超时由包装层 `AbortController` 控制，不用真实时间驱动模拟状态。
- 内容：包白名单 `.yaml/.yml/.md`；YAML 中任何以这些扩展名结尾的字符串一律视为引用（必须存在且在包内），否则加载失败；包内出现不支持扩展名的文件即拒绝；禁止符号链接/目录联接。
- 存储：正式迁移体系、世界 Tick 与配置编译不在阶段 0 范围；阶段 1 需要在此之上建版本化迁移，并保持"快照 + 阶段记录 + 幂等身份"同事务。
- 行为树：只用白名单节点与注册表函数；决策原子化（一次决策内收敛，失败即不可用）；黑板有界、幂等键显式持久化；不触碰 Mistreevous 私有字段。
- TUI 输入层的既有约定（阶段 1 必须保持）：Home/End 归输入行（`tui.altScreen.top/bottom` 改绑 `ctrl+home`/`ctrl+end`）；**`tui.altScreen.lineUp/lineDown` 绑在裸 `up`/`down` 上**——备用屏幕里终端的 Alternate Scroll 把滚轮转成上下键，这就是默认（不捕获鼠标）模式下的滚轮；单行输入不需要裸上下键，但**阶段 1 引入命令历史时必须重排**（历史优先，滚动改绑 `ctrl+shift+up/down` 或加修饰键），否则历史会被滚动吃掉；**多行/超长粘贴走 chip（token + 卡片 + 提交展开），单行短粘贴内联且换行压成空格，粘贴内容先规范化（CRLF→LF、tab→4 空格、剔除除 LF 外的所有 C0 控制字符）**；右键粘贴走 `onRightClickPaste` + `getNativeClipboard()`（仅在捕获鼠标时有事件）；**默认不捕获鼠标**，框选/右键/悬停交给终端，需要应用内滚轮拖动、悬停高亮或点击定位时才开 `mouse`；不得让新监听抢在输入栏之前消费这些按键。
- TUI：新增输入能力必须同时覆盖"合并投递的控制字符块"路径；每帧渲染走 `requestRender` 节流，流式追加不得逐 token 重绘；固定栏条目必须带 `minSize`/`shrink: 0`、scroll 类条目必须 `basis: 0`，否则长内容会把固定栏压成 0 行（chip 卡片用 `basis: "auto"` + `minSize: 0` + `shrink: 0` + `visible` 谓词，无粘贴时不占行）；自驱动/演示循环必须保证任一时刻只有一个定时器，且流时长不得长于轮间隔（见 §6.1）。
