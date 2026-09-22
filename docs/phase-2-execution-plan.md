# 阶段 2 执行计划：确定性模拟内核

## 1. 文档目的

本文把 `docs/implementation-roadmap.md` 中的阶段 2 拆成可以直接实施和验收的工程任务。

阶段 2 的核心不是增加更多规则表达式，而是把阶段 1 已经能够生成的 `StateChangeRequest` 与
`ProcessChangeRequest` 接到拥有权威运行状态的 Service 上，并由统一的 Tick 调度形成可保存、可恢复、
可追踪的确定性模拟闭环。

本文是执行计划，不代表这些能力已经实现。阶段完成情况、验收证据和实际偏差应记录在后续的
`docs/phase-2-report.md` 中。

## 2. 依据与术语

### 2.1 设计依据优先级

实现过程中遇到描述冲突时，按以下优先级处理：

1. `docs/core-naming-guide.md`
2. `docs/core-deterministic-evaluation-guide.md`
3. `docs/phase-1-report.md` 的阶段 2 硬约束及阶段 1 偏差
4. `docs/world-system.md`、`docs/body-system.md`、`docs/character-system.md`
5. `docs/time-orchestration-system.md`
6. `docs/implementation-roadmap.md`

较早设计中的 `bodyTemplate`、硬编码身体指标词汇以及旧 Core 命名，不得覆盖阶段 1 已经完成的重构结果。

### 2.2 当前公共语言

阶段 2 的代码、配置、测试和文档统一使用以下名称：

- `SystemSpec`、`SystemId`、`ConfigItem`
- `StateInput`、`StateRef`
- `RuntimeConfig`、`RuleRequest`、`RuleResult`、`RunTrace`
- `StateChangeRequest`、`ProcessChangeRequest`
- `configId`、`runId`、`stateVersion`
- `WorldService`、`CharacterService`、`BodyService`
- `SimulationRunner`

不得重新引入 `DomainExtension`、`CandidateEffect`、`Target`、`EvaluationResult`、`consumeEffect` 等旧公共名称。

### 2.3 SystemSpec 与 Service

`SystemSpec` 是一个 System 提交给 Core 的静态说明书，负责声明：

- 内容包允许定义哪些 `ConfigItem`；
- 规则允许读取哪些 `StateRef`；
- 规则允许请求修改哪些状态或过程；
- 支持哪些 Trigger；
- 配置加载期需要执行哪些结构、引用和系统语义检查。

Service 是 System 的运行时权威实现，负责：

- 保存当前状态和状态版本；
- 投影一次规则运行所需的最小 `StateInput`；
- 接收并验证 Core 返回的变化请求；
- 维护运行时不变量；
- 提交新状态并生成运行结果或客观事件。

Core 负责确定性计算“请求什么变化”，Service 负责判断请求在当前版本上能否成为事实。规则结果不能绕过
Service 直接修改权威状态。

## 3. 阶段目标

阶段 2 完成后，应能在无 LLM、无 TUI 的条件下：

1. 从同一个 `RuntimeConfig` 初始化 World、Character、Body 和降级行为树运行状态。
2. 使用固定 Tick 推进世界过程、身体过程、已有动作和动态实体。
3. 执行说话、移动、手势、拿取、放置和简单物品操作。
4. 处理动作资源并行、排队、替换、失败和中断。
5. 由行为树为降级实体形成普通 `ActionPlan`。
6. 通过 Core 规则、System 验证和 Service 提交完成确定性传播。
7. 记录完整十二阶段 Tick 追踪，其中第 8–11 阶段暂为空实现。
8. 在明确边界执行显式保存，并从存档状态继续运行。
9. 对相同配置、初始状态、计划输入和 Tick 数产生相同最终状态、事件、动作结果与摘要哈希。

## 4. 明确不在阶段 2 实现的内容

- 感知、认知、记忆的实际业务状态和算法。
- AI Agent、用户自然语言解释或其他 LLM 调用。
- Fast Forward、离屏认知、延后模型任务和相关优化。
- 可玩 TUI、管理命令和自然语言交互。
- 容器容量、多层容纳、复杂空间寻路、随机裁定和概率动作。
- 自动逐 Tick 历史快照、完整事件溯源和上线级灾备。
- 未显式保存情况下的进程崩溃恢复。
- 新的崩溃注入测试；阶段 0/1 已有验证保持原状。

## 5. 运行状态模型

### 5.1 SimulationState

`SimulationState` 是当前进程中唯一的权威模拟状态。它至少包含：

- `timelineId`、当前 Tick、显式模拟时间和当前阶段；
- `configId`；
- World、Character、Body 和行为树状态及各自版本；
- 活动索引和目标 Tick 索引；
- 活动、排队及等待世界裁定的动作；
- 已建立的世界过程和身体过程；
- 当前规则屏障或失败信息；
- 普通重试与显式加载所需的变化防重身份。

一个 Tick 完成后只替换当前 `SimulationState`，不为该 Tick 自动追加历史 Snapshot。

### 5.2 TickFrame

`TickFrame` 是一次 Tick 或阶段开始时固定的临时只读视图。它包含：

- Tick 身份和模拟时间；
- 本 Tick 固定的 `configId`；
- 起始 System 版本集合及由此形成的 `stateVersion`；
- 本 Tick 的活动入口、到期项和已接纳计划；
- 当前阶段获准读取的状态投影。

`TickFrame` 只用于保证同一阶段中的读取一致，不持久化，不进入存档历史，用完即可丢弃。

### 5.3 SaveSnapshot

`SaveSnapshot` 专指用户或管理流程显式创建的存档，必须保存从该边界继续模拟所需的完整状态，而不是展示摘要。

允许保存的边界：

- 完整稳定 Tick 结束；
- 已建立的规则屏障；
- 调度器声明可恢复的明确阶段边界。

加载时需要核对 `configId`、载荷版本、System 版本及跨 System 引用。加载旧存档建立新的 `timelineId`，旧时间线
后续请求不能进入新运行实例。

阶段 2 不保证未显式保存的进度在进程异常退出后仍然存在。

## 6. P2.0：配置模型

### 6.1 World 基础 ConfigItem

`agentlife.world/location` 保留以下基础字段：

- 名称；
- 描述；
- 出口引用；
- 标签。

`agentlife.world/item` 收缩为以下基础字段：

- 名称；
- 描述；
- 标签。

从 Item 基础结构中删除：

- 固定 `roles` 枚举；
- `containerCapacity`；
- carryable、surface、container、operable 等硬编码业务分类。

Item 表示一个可以持续存在并参与世界关系的物品，不预先决定它能够参与哪些交互。

### 6.2 内容定义的实体属性

WorldSpec 增加内容定义的实体属性族，实体（地点、物品）在自身配置里声明自己拥有的属性值。

属性定义至少声明：

- 属性 ID 和展示名称；
- 值类型；
- 可选单位；
- 默认值；
- 数值策略或字符串词表。

实体用自己的 `attributes` 映射声明属性值（`agentlife.demo/portable: true`）：键是属性定义的引用，值必须符合该属性声明的类型、范围与取值。运行时以实体作用域投影，规则通过完整 `StateRef` 读取。

演示内容定义：

- `portable`：用于规则判断物品是否允许被拿取；
- `support`：用于规则判断目标是否允许接受放置；
- `operable`：用于规则判断物品是否允许简单操作。

这些名称属于演示内容，不属于 WorldService 词汇。新增其他属性不应要求修改 WorldService。

### 6.3 Body 配置

BodySpec 在现有值和通道容器基础上增加：

- 能力定义；
- 资源定义；
- 动作定义及动作阶段；
- 物理模式定义；
- 身体过程定义。

首批能力覆盖说话、移动、手势、拿取、放置和简单操作。动作持续时间、阶段资源、是否允许中断、消耗、恢复和
速度修正由内容定义。

BodyService 不得根据 `stamina`、`wakefulness` 等属性名称推断业务含义。

### 6.4 Character 配置

CharacterSpec 增加：

- 降级实体的行为树引用；
- 行为树允许读取的局部执行视图引用；
- 创建身体实例所需的配置引用。

继续验证：

- dynamic 实体没有自主决策入口；
- degraded 实体只使用行为树且不能是主要实体；
- normal 实体只使用 cognition 或 user 入口；
- normal 实体不能同时加载行为树；
- 控制来源、能力层级和主要标记不进入普通世界视图。

### 6.5 版本变化

修改过的 SystemSpec 版本提升至 `1.1.0`，演示包同步更新依赖版本。新的 `specHash` 必须进入新的 `configId`，
不得在原配置身份下静默改变能力语义。

### 6.6 退出条件

- 演示包能够生成稳定且唯一的新 `configId`。
- Item 基础 Schema 不再包含交互角色或容量字段。
- 新增实体属性不需要修改 WorldService。
- 无效属性类型、错误实体引用、错误行为树引用和无效动作资源在配置发布时被拒绝。

## 7. P2.1：WorldService

### 7.1 权威状态

WorldService 权威维护：

- 角色和物品的当前位置；
- 物品持有关系；
- 物品放置关系；
- 环境值；
- 活动世界过程；
- 世界状态版本；
- 当前运行所需的客观事件记录。

### 7.2 通用关系

阶段 2 支持以下通用关系：

- `located-at`：实体或物品直接位于地点；
- `held-by`：物品被角色持有；
- `placed-on`：物品被放置在另一个实体上。

这些关系只描述客观位置与归属，不声明某个目标为什么允许建立关系。`portable`、`support`、`operable` 等条件由
规则读取内容属性后决定。

### 7.3 WorldService 不变量

WorldService 必须验证：

- 一个物品恰好具有一个当前位置关系；
- 同一物品不能同时被多个实体持有；
- 同一物品不能同时直接位于地点、被持有和被放置；
- 关系两端引用必须存在；
- 实体不能持有或放置自身；
- `placed-on` 关系不能形成环；
- 移动目标必须是当前地点的有效出口；
- 请求的 `baseVersion` 必须与当前提交基线一致。

规则即使产生了不合法请求，WorldService 也必须拒绝，而不是提交部分状态。

### 7.4 规则与提交流程

一次世界交互采用以下流程：

```text
动作影响请求
→ WorldService 构造最小 StateInput
→ CoreRuntime.runRules()
→ RuleResult
→ WorldService 验证变化请求及关系不变量
→ 原子形成下一世界状态
→ 生成 WorldEvent
```

规则负责判断具体内容属性及交互条件。WorldService 负责版本、引用和关系一致性。

### 7.5 视图隔离

WorldService 分别提供：

- Core 规则使用的声明式状态投影；
- BodyService 使用的动作执行视图；
- 行为树使用的白名单局部执行视图；
- 管理和测试使用的完整诊断视图。

管理视图不得直接作为规则或行为树输入。

### 7.6 活动索引

动态实体、世界过程和目标 Tick 检查必须登记活动索引。Tick 只唤醒相关入口，不扫描所有实体、过程和规则。

## 8. P2.2：CharacterService

### 8.1 权威状态

CharacterService 维护：

- 稳定角色实例 ID；
- 当前 Identity 及版本；
- 生命周期状态；
- 能力层级；
- 控制来源；
- 主要实体标记；
- World、Body 和行为树关联；
- 未结束事项的连续性清单。

### 8.2 生命周期

阶段 2 支持创建、运行、暂停和恢复。

暂停只停止新计划和自主决策入口，不停止：

- 已经开始的身体动作；
- 身体过程；
- 世界过程；
- 外部世界影响。

### 8.3 递进能力层级

- dynamic：只拥有世界存在和确定性更新，没有自主计划来源。
- degraded：在 dynamic 基础上增加 Body、行为树和有限黑板。
- normal：拥有共同的 World、Body 和生命周期基础，但决策扩展位留给后续感知、认知和记忆阶段。

阶段 2 不为 normal 实体创建伪感知、伪认知或伪记忆状态。测试或演示需要正常实体动作时，通过明确的诊断计划入口提交普通
`ActionPlan`。

## 9. P2.3：BodyService

### 9.1 公共模型

引入以下类型：

- `ActionPlan`：计划 ID、角色、来源、形成版本、接纳 Tick、冲突策略及步骤。
- `ActionInstance`：动作实例 ID、当前步骤、阶段、进度、资源、世界请求和结果。
- `ActionStatus`：动作生命周期状态。
- `ActionPolicy`：新计划面对资源冲突时的策略。
- `ActionOutcome`：动作结束后的结构化结果。

动作状态固定为：

```text
queued | running | waiting-world | completed | failed | interrupted | cancelled
```

冲突策略固定为：

```text
parallel | queue | replace
```

### 9.2 计划接纳

接纳计划时验证：

- 计划归属角色存在且允许接受新计划；
- 能力和动作定义存在；
- 计划形成时依赖的版本仍有效；
- 步骤依赖无环且引用有效；
- 当前能力、模式和资源允许接纳；
- 所需世界执行前提仍然成立。

验证失败的计划不占用资源，也不产生动作效果。

所有本 Tick 接纳的计划记录 `eligibleTick = acceptedTick + 1`。无论计划来自诊断入口、行为树还是未来认知阶段，
都不能在形成计划的同一 Tick 积累进度。

### 9.3 资源冲突

- `parallel`：资源兼容时立即接纳；冲突时直接拒绝，不隐式排队。
- `queue`：资源冲突时进入等待；真正启动前重新验证 Body 和 World 前提。
- `replace`：只有冲突动作均允许中断且新动作可完整接纳时，才原子中断旧动作并接纳新动作。

演示配置中说话与移动使用兼容资源；手势、拿取和放置争用独占手部资源。

### 9.4 世界裁定

移动、拿取、放置和简单操作在动作阶段到达世界影响点时：

1. BodyService 形成结构化世界影响请求；
2. 动作进入 `waiting-world`；
3. WorldService 通过规则和不变量完成裁定；
4. BodyService 根据世界结果重新验证动作；
5. 动作继续、完成、失败或中断。

已合法提交的独立结果不因后续步骤失败而回滚。

### 9.5 身体值与过程

动作消耗、恢复、能力变化和模式变化只能来自：

- 内容规则产生的 `StateChangeRequest`；
- 已建立身体过程产生的 `ProcessChangeRequest`；
- 已裁定世界影响。

BodyService 不根据属性名称增加隐藏默认规律。

## 10. P2.4：确定性行为树

### 10.1 适配器收敛

把现有 `BehaviorTreeAdapterProbe` 收敛为生产 `BehaviorTreeAdapter`，继续使用经过阶段 0 验证的 Mistreevous 受限模式。

保留：

- 纯 JSON 树定义；
- 固定函数和谓词注册表；
- 有限 JSON 黑板；
- 显式模拟 Tick；
- 稳定节点路径追踪；
- 决定身份防重。

### 10.2 权限边界

行为树只能读取：

- 配置授权的局部 World 执行视图；
- 自身 Body 执行视图；
- 自身有限黑板。

行为树不得访问：

- 完整 Ground Truth；
- 远处实体和隐藏关系；
- 控制来源和主要标记；
- 其他角色私有状态；
- 文件、网络、数据库、机器时钟或 LLM。

### 10.3 输出和时间

行为树只能输出普通 `ActionPlan`，不能直接修改 World 或 Body。

继续禁用随机 `lotto`、运行时动态 `branch` 及依赖第三方隐藏时间状态的 `wait`。等待和冷却由 AgentLife 保存明确的
`wakeTick`、`cooldownUntilTick` 和目标 Tick 索引。

### 10.4 保存状态

行为树存档状态至少包括：

- 有限黑板；
- 等待和冷却目标 Tick；
- 最近输入版本；
- 当前活动计划关联；
- 已提交决定身份。

加载后不得重复选择或重复提交同一计划。

## 11. P2.5：SimulationRunner

### 11.1 十二阶段顺序

一个完整 Tick 固定执行：

1. 固定 Tick、运行模式、`configId`、起始版本、活动集合和计划输入。
2. 推进模拟时钟一个固定步长，唤醒活动索引和目标 Tick 索引。
3. 推进既有动作、身体过程、动态实体和世界过程，形成待裁定影响。
4. 执行到达决策点的降级实体行为树并接纳新计划。
5. WorldService 裁定影响，BodyService 吸收结果并重新计算派生状态。
6. 根据已提交变化触发 Core 规则，并传播到客观稳定状态。
7. 检查缺失规则和传播上限；必要时建立规则屏障或失败状态。
8. 感知扩展点；阶段 2 记录 no-op。
9. 认知需求汇总扩展点；阶段 2 记录 no-op。
10. 认知屏障和计划交接扩展点；阶段 2 记录 no-op。
11. 记忆维护扩展点；阶段 2 记录 no-op。
12. 发布新的稳定 `SimulationState`、Tick 摘要和停止原因。

### 11.2 确定性传播

- 只通过 `triggerIndex` 选择规则，禁止遍历所有规则。
- 每一轮传播基于上一轮已提交状态构造新的最小 `StateInput`。
- 变化按 System、实体 ID、StateRef 稳定排序；过程请求按 System、实体 ID、ProcessRef 稳定排序。
- 目标值已经相同就不产生变化；过程已建立不重建、不存在不结束。重复请求因此自然被吸收，不需要额外身份。
- 达到配置化传播上限仍未稳定时进入 `failed`，不发布半稳定 Tick。
- 规则缺失时建立内存中的规则屏障，阶段 2 不调用规则生成 LLM。

### 11.3 失败语义

一个阶段失败时，本次 Tick 不发布为稳定完成。已经由 Service 合法提交的独立结果可以保留，但调度器必须记录失败阶段和原因，
不得假装整个 Tick 已完成。

阶段 2 只要求在进程仍运行或已显式保存该阶段状态时续做，不要求从未保存的异常进程退出中恢复。

## 12. P2.6：显式保存与加载

### 12.1 RuntimeStore 接口

扩展 `RuntimeStore`：

```text
saveSimulation(snapshot)
loadSimulation(saveId)
listSaves()
```

存档使用版本化 `SaveSnapshot` 载荷。

### 12.2 保存内容

`SaveSnapshot` 至少包含：

- 时间线、Tick、模拟时间、当前阶段和运行状态；
- `configId` 和 System 版本；
- World、Character、Body 权威状态及版本；
- 行为树黑板、等待、冷却和决定身份；
- 活动、排队和等待世界裁定的动作；
- 世界过程和身体过程；
- 活动索引和目标 Tick 索引；
- 当前规则屏障或失败信息；
- 继续运行所需的变化防重信息。

### 12.3 存储边界

- 保存操作使用普通 SQLite 事务，保证单次显式存档自身完整。
- 不为每个 Tick 自动创建存档。
- 不维护逐 Tick Snapshot 历史。
- 不增加崩溃注入和灾备测试。
- 未显式保存的运行进度允许在进程异常退出时丢失。

## 13. P2.7：演示内容和运行器

### 13.1 演示内容

- 麻绳配置 `portable = true`。
- 石凳配置 `support = true`。
- 新增灯具并配置 `operable = true`。
- 简单操作规则使灯具改变灯火环境值。
- 门口护卫关联确定性行为树和白名单局部视图。
- 保留玩家、阿禾、护卫及三个现有地点。

现有恢复规则需要改为依赖明确建立的身体过程，不再让所有实体仅因 Tick 经过就无条件恢复。

### 13.2 演示流程

无界面演示至少覆盖：

1. 初始化三个角色、三个地点及演示物品。
2. 提交移动与说话并行计划。
3. 提交手势与拿取资源冲突计划。
4. 拿取麻绳并移动到另一地点。
5. 把麻绳放到石凳上。
6. 操作灯具并通过规则改变灯火环境值。
7. 让护卫行为树形成并执行简单计划。
8. 显式保存，加载存档后继续若干 Tick。
9. 输出最终状态、事件、动作结果、行为树决定及摘要哈希。

连续执行两次必须产生相同摘要哈希。

### 13.3 命令和报告

新增：

- `pnpm phase2:demo`
- `pnpm phase2:verify`
- 阶段完成后的 `docs/phase-2-report.md`

## 14. 实施顺序和依赖

实施必须按以下顺序推进：

1. P2.0 配置模型和公共运行类型。
2. P2.1 WorldService。
3. P2.2 CharacterService。
4. P2.3 BodyService。
5. P2.4 行为树生产适配。
6. P2.5 SimulationRunner。
7. P2.6 显式保存与加载。
8. P2.7 演示内容、演示运行器和阶段报告。

每一步必须在自身单元测试通过且前一步回归测试保持通过后再进入下一步。不得先在 Orchestrator 中硬编码演示行为，再倒推
Service 或 ConfigItem 接口。

## 15. 测试计划

### 15.1 配置测试

- Item Schema 不包含 carryable、surface、container 或 capacity。
- 实体属性类型、默认值和实体自己声明的属性值正确验证。
- 新增物品属性不需要修改 WorldService。
- 无效行为树引用、动作资源和实体组合不能发布。
- SystemSpec 更新产生新的 `configId`。

### 15.2 WorldService 测试

- 无 `portable` 规则支持的物品不能被拿取。
- 无 `support` 规则支持的目标不能接受放置。
- 无 `operable` 规则支持的物品不能产生简单操作变化。
- 即使规则产生错误请求，也拒绝双重持有、重复位置、自引用和关系环。
- 移动只允许当前地点声明的出口。
- 过时 baseVersion 不修改世界状态。

### 15.3 CharacterService 测试

- 三种能力层级建立正确关联。
- degraded 实体不能成为主要实体。
- normal 实体不能同时使用行为树。
- 暂停阻止新计划，但不冻结已有动作和外部影响。
- 控制来源和主要标记不进入公开或行为树视图。

### 15.4 BodyService 测试

- 新计划从下一 Tick 才开始推进。
- 说话与移动可以并行。
- 手势、拿取和放置产生预期资源冲突。
- parallel、queue、replace 三种策略具有稳定结果。
- queue 启动前重新验证 Body 和 World 前提。
- replace 失败不会先破坏旧动作。
- 世界裁定成功、失败和版本过时能正确结束动作。
- 动作失败不回滚已经合法提交的独立结果。

### 15.5 行为树测试

- 同一输入和 Tick 产生相同计划与追踪。
- 越权读取被拒绝。
- 随机、动态分支和隐藏等待节点被拒绝。
- 冷却和等待只使用模拟 Tick。
- 加载后不重复选择或提交计划。

### 15.6 Orchestrator 测试

- 十二阶段顺序固定。
- 第 8–11 阶段产生明确 no-op 追踪。
- 多实体输入顺序不改变结果。
- Core 传播只使用 Trigger 索引。
- 传播超限明确失败且不发布稳定 Tick。
- 缺失规则建立屏障，不触发 LLM。
- 动作、世界裁定和后续规则传播形成完整追踪。

### 15.7 保存与加载测试

- 稳定 Tick 可以显式保存和加载。
- 规则屏障或明确阶段边界保存后可以继续。
- 存档缺少对应 RuntimeConfig 时加载失败。
- System 版本或关联不兼容时加载失败。
- 从同一存档分别继续相同 Tick 数得到相同结果。
- 不测试未保存进程崩溃后的恢复。

## 16. 验收命令与退出条件

验收命令：

```text
pnpm phase1:verify
pnpm phase2:verify
pnpm phase2:demo
pnpm phase2:demo
```

两次演示运行的最终摘要哈希必须相同。

阶段 2 完成需要同时满足：

1. 阶段 1 回归测试通过。
2. 阶段 2 配置、Service、行为树、Orchestrator 和存档测试通过。
3. 六种基础动作拥有可追踪的主要成功路径。
4. 资源冲突、失败、中断和跨 Tick 推进可重复验证。
5. WorldService 的通用关系不变量不会被规则绕过。
6. 显式保存和加载能够继续相同模拟结果。
7. 无任何 LLM 调用、随机源或机器时间进入确定性 Tick。
8. `docs/phase-2-report.md` 记录实现证据、已知限制和实际偏差。

## 17. 固定默认决策

- 当前运行状态只保留一份，不保存逐 Tick 历史 Snapshot。
- Snapshot 专指显式保存产生的 `SaveSnapshot`。
- 阶段位置只有在显式保存时才持久化。
- SQLite 只负责普通存档完整性，不承担阶段 2 灾备。
- 容器和容量推迟到出现真实演示需求之后。
- 物品交互能力由内容属性和规则表达，WorldService 只维护通用关系不变量。
- 单步是阶段 2 必须完成的运行控制；Fast Forward 留到阶段 6。
- `CoreRuntime` 本阶段保持现有门面，不提前拆分。
- 不新增运行时依赖。
- 测试只覆盖 PoC 的主要业务路径，不扩展到上线级异常和灾备场景。
