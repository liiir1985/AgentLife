# 阶段 2 报告：确定性模拟内核

- 日期：2026-09-22
- 范围：`docs/phase-2-execution-plan.md` 的 P2.0–P2.7（配置模型、WorldService、CharacterService、BodyService、确定性行为树、SimulationOrchestrator、显式保存与加载、演示内容与运行器）
- 结论摘要：阶段 2 的执行计划已经实现。`StateChangeRequest` / `ProcessChangeRequest` 现在由拥有权威运行状态的 Service 验证并提交，十二阶段 Tick 形成可保存、可恢复、可追踪的确定性闭环。完整套件 **213 passed | 1 skipped**（18 个文件，其中阶段 2 新增 7 个文件 49 项）；`pnpm phase1:verify` 与 `pnpm phase2:verify` 通过；`pnpm phase2:demo` 连续两次输出的最终摘要哈希相同（`5ec5abcd55189f17`），且「继续原时间线」与「加载存档后继续」的摘要哈希也相同（`72cd092710fe7fb5`）。全部 Tick 路径中没有 LLM 调用、随机源或机器时间。验收过程中发现并修复了六处实现缺陷（§11），其中三处会让内容静默失效或让加载后的时间线分叉。
- 与设计的关系：实现严格按 `docs/phase-2-execution-plan.md` §2.1 的依据优先级取材，没有重新引入 `DomainExtension`、`CandidateEffect`、`Target`、`EvaluationResult`、`consumeEffect` 等旧公共名称。与计划的实际偏差见 §13。

## 1. 交付物

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 系统 | `src/systems/world-spec.ts` | 实体属性族（`agentlife.world/attribute`）、实体自带的属性值映射、局部视图、影响种类、放置、位置关系输出 |
| 系统 | `src/systems/body-spec.ts` | 能力、资源、动作与动作阶段、物理模式、身体过程、值/通道容器的拥有权声明 |
| 系统 | `src/systems/character-spec.ts` | 角色模板组合、能力层级、生命周期、控制来源、行为树引用与本地视图授权 |
| 运行状态 | `src/simulation/types.ts` | `SimulationState`、`WorldState`、`BodyState`、`CharacterState`、`ActionInstance`、`TickSummary`、十二阶段常量 |
| 运行状态 | `src/simulation/config-view.ts` | 由 `RuntimeConfig` 读取的内容词汇（动作/能力/资源/模式/行为树/局部视图成员） |
| 运行状态 | `src/simulation/projection.ts` | 由权威状态构造最小 `StateInput`（共享切片、实体切片、`stateVersion`） |
| 服务 | `src/simulation/world-service.ts` | 世界状态、通用关系不变量、版本、出口校验、影响裁定、过程推进、事件 |
| 服务 | `src/simulation/character-service.ts` | 角色实例、能力层级、生命周期（创建/运行/暂停/恢复）、控制来源、主要实体标记、管理视图 |
| 服务 | `src/simulation/body-service.ts` | 计划接纳、`eligibleTick`、资源冲突（parallel/queue/replace）、动作阶段推进、身体过程、世界影响请求与结果吸收 |
| 适配 | `src/behavior/behavior-tree-adapter.ts`、`src/behavior/behavior-functions.ts` | Mistreevous 受限模式的生产适配（纯 JSON 树、函数白名单、有限黑板、模拟 Tick、稳定路径追踪、决定防重） |
| 调度 | `src/simulation/orchestrator.ts` | 十二阶段 Tick、传播与稳定检查、规则屏障、失败语义、`runTick()` / `state()` / `load()` |
| 存档 | `src/simulation/save.ts` | `SaveSnapshot`、版本化载荷、`encodeSnapshot` / `decodeSnapshot` / `checkSnapshot` |
| 存档 | `src/storage/migrations.ts`、`src/storage/runtime-store.ts` | 迁移 v3（`simulation_saves`）与 `saveSimulation` / `loadSimulation` / `listSaves` |
| 演示 | `src/simulation/demo.ts`、`src/simulation/phase2-demo.ts` | 演示场景与两次运行的一致性验收运行器 |
| 内容 | `content/demo/**` | 演示内容包 v1.1.0：属性、赋值、影响种类、局部视图、放置、能力、资源、模式、身体、动作、行为树 |
| 测试 | `tests/phase2-config.test.ts` | P2.0 配置验收（§15.1） |
| 测试 | `tests/phase2-world.test.ts`、`tests/phase2-character.test.ts`、`tests/phase2-body.test.ts` | P2.1–P2.3 服务验收（§15.2–§15.4） |
| 测试 | `tests/phase2-behaviour.test.ts`、`tests/phase2-orchestrator.test.ts`、`tests/phase2-save.test.ts` | P2.4–P2.6 验收（§15.5–§15.7） |
| 测试 | `tests/helpers/phase2.ts` | 阶段 2 测试夹具：发布演示内容、构造编排器、只读状态断言 |

## 2. P2.0：配置模型

| 计划要求 | 实现 |
| --- | --- |
| `agentlife.world/item` 收缩为名称/描述/标签 | Item 配置类型只声明 `name`、`description`、`tags`；`roles`、`containerCapacity` 及硬编码业务分类全部删除，声明这些字段的内容包在发布期被拒绝 |
| 内容定义的实体属性 | `agentlife.world/attribute` 声明 id、类型、单位、默认值、数值策略或字符串取值；实体（地点、物品）在自己的配置项里用 `attributes` 映射声明各自的值，键是属性定义的引用。内核按引用解析这些键，并按该定义声明的值类型、范围与取值校验成员值；运行时按实体作用域投影，规则通过完整 `StateRef`（`agentlife.world/attribute.<id>`）读取 |
| 演示属性 | `portable`（麻绳）、`support`（石凳）、`operable`（灯具）——均为演示内容，WorldService 不识别这些名字 |
| Body 配置 | `ability`、`resource`、`action`（含阶段与持续时间）、`mode`、`body`、身体过程定义；`stamina`、`wakefulness` 等名称只作为演示内容出现 |
| Character 配置 | 模板组合 + 覆盖、`capabilityTier`、生命周期、`controlSource`、`mainEntity`、行为树引用、局部执行视图引用、身体配置引用 |
| `SystemSpec` 更新产生新 `configId` | 系统版本/`specHash` 进入 `configId` 计算链；同一内容包在系统集合不变时得到相同 `configId` |

## 3. P2.1：WorldService

- **权威状态**：`WorldState` 保存实体（地点/物品/角色及其类型）、各实体的位置关系（`located-at` / `held-by` / `placed-on`）、环境值、已建立的世界过程、事件序号与状态版本。
- **通用不变量**（`invariantProblems`，规则无法绕过）：
  - 一个实体最多保留一个位置关系；
  - 非地点实体必须有位置关系，地点不得被持有/携带/放置；
  - 只有物品可以被持有或放置；
  - 关系两端必须存在，且引用类型匹配（持有者必须是角色、所在地必须是地点、放置目标必须是物品）；
  - 实体不能持有或支撑自身；
  - `placed-on` 不能成环；
  - 移动目标必须是当前地点声明的出口（读内容 `exits`）。
- **版本与拒绝**：请求携带 `baseVersion`，与当前提交基线（世界影响与过程推进为世界版本，规则传播为本帧投影版本）不一致时整批拒绝；任一状态变化被前提或引用校验拒绝时，该批状态变化整批不提交，且被拒变化绝不部分写入世界状态（过程请求独立处理）。
- **裁定流程**：动作影响请求 → WorldService 构造最小 `StateInput` → `CoreRuntime.runRules()` → 校验变化请求与关系不变量 → 原子提交 → 生成 `WorldEvent`（`relation-changed`、`environment-changed`、`process-established`、`process-advanced`）。
- **视图隔离**：Core 规则用声明式状态投影，BodyService 用动作执行视图，行为树用白名单局部执行视图，管理/测试用完整诊断视图；管理视图不进入规则或行为树输入（见 `tests/phase2-character.test.ts`）。
- **活动索引**：实体、目标 Tick 检查与世界过程登记在活动索引中，Tick 只唤醒相关入口。

## 4. P2.2：CharacterService

- 维护稳定角色实例 ID、Identity 版本、生命周期状态（`created` / `running` / `paused`）、能力层级（`dynamic` / `degraded` / `normal`）、控制来源、主要实体标记、World/Body/行为树关联。
- 暂停只停止新计划与自主决策入口，不停既有动作、身体过程、世界过程与外部世界影响（`tests/phase2-character.test.ts`）。
- 能力层级在发布期交叉校验：degraded 不能是主要实体，不能引用认知；normal 不能同时运行行为树；阶段 2 不为 normal 创建伪感知/伪认知/伪记忆状态。
- 控制来源与主要标记只在管理视图出现，不进入公开或行为树视图。

## 5. P2.3：BodyService

- **公共模型**：`ActionPlan`、`ActionInstance`、`ActionStatus`（`queued` / `running` / `waiting-world` / `completed` / `failed` / `interrupted` / `cancelled`）、`ActionPolicy`（`parallel` / `queue` / `replace`）、`ActionOutcome`。
- **接纳验证**：角色存在且接受新计划、能力与动作定义存在、`formedVersion` 仍有效、步骤引用有效、当前能力/模式/资源允许、世界执行前提成立。失败的计划不占用资源、不产生效果。
- **`eligibleTick = acceptedTick + 1`**：无论在哪个来源形成计划，都不能在形成它的同一 Tick 积累进度。
- **资源冲突**：演示内容中说话用 `speech`、移动用 `locomotion`（互相兼容），手势/拿取/放置争用 `hands`（独占）。`parallel` 冲突即拒绝、`queue` 进入等待并在启动前重新验证 Body 与 World 前提、`replace` 仅当旧动作均允许中断且新动作可完整接纳时原子替换。
- **世界裁定**：在动作影响点构造结构化世界影响请求，动作进入 `waiting-world`；`absorb()` 按裁定结果重新验证并继续/完成/失败/中断动作；已合法提交的独立结果不因后续步骤失败而回滚。
- **身体值与过程**：消耗、恢复、能力与模式变化只能来自内容规则的变化请求、已建立身体过程或已裁定世界影响；恢复不再按 Tick 无条件生效，而是由 `recovery-request` 规则建立 `agentlife.body/recovery` 过程、`recovery-effect` 规则在过程推进时改写 `stamina`。

## 6. P2.4：确定性行为树

- 阶段 0 的 `BehaviorTreeAdapterProbe` 收敛为生产 `BehaviorTreeAdapter`，继续使用经阶段 0 验证的 Mistreevous 受限模式：纯 JSON 树定义、固定函数与谓词注册表、有限 JSON 黑板、显式模拟 Tick、稳定节点路径追踪、决定身份防重。
- 白名单函数（`src/behavior/behavior-functions.ts`）：`view-equals`、`view-below`（局部视图读取）、`plan`（提交普通 `ActionPlan`）、`idle` 等；随机 `lotto`、动态 `branch` 与依赖第三方时间的 `wait` 被拒绝。
- 等待与冷却只使用显式模拟 Tick（`wakeTick`、`cooldownUntilTick`、目标 Tick 索引），不接触机器时钟。
- 存档保存黑板、等待与冷却目标 Tick、最近输入版本、活动计划关联与已提交决定身份；加载后不重复选择或提交同一计划。
- 越权读取（访问未授权的视图成员、完整状态、其他角色私有状态、控制来源或主要标记）在发布期被拒绝。

## 7. P2.5：SimulationOrchestrator

- **十二阶段**（`TICK_STAGES`）：固定 → 时钟 → 推进 → 决策 → 世界裁定 → 传播 → 稳定检查 → 感知 → 认知需求 → 认知屏障 → 记忆 → 发布。第 8–11 阶段在阶段 2 记录为显式 no-op（`NO_OP_STAGES`），但仍逐项出现在 Tick 追踪中。
- **确定性传播**：只通过 `triggerIndex` 选择规则；每一轮基于上一轮已提交状态构造最小 `StateInput`；变化按 System、实体 ID、StateRef、`changeId` 稳定排序；同一 `changeId` 在同一时间线只应用一次；超过配置化传播上限即进入 `failed` 且不发布半稳定 Tick；触发到没有规则的目标时建立内存中的规则屏障，不调用 LLM。
- **失败语义**：阶段失败不发布稳定 Tick，调度器记录失败阶段与原因；Service 已合法提交的独立结果保留。
- **入口**：`SimulationOrchestrator.create(core, options)`、`runTick(input)`、`state()`、`load(state)`；`TickResult` 区分 `completed` / `barrier` / `failed` 并携带 `TickSummary`。

## 8. P2.6：显式保存与加载

- `RuntimeStore.saveSimulation(snapshot)` / `loadSimulation(saveId)` / `listSaves()`；迁移 v3 新增 `simulation_saves` 表，`config_identity` 外键指向 `config_versions`。
- `SaveSnapshot` 保存时间线、Tick、模拟时间、当前阶段、`configId`、System 版本集合、运行设置、World/Character/Body/行为树权威状态、活动索引与目标 Tick 索引、排队与等待世界裁定的动作、世界与身体过程、规则屏障或失败信息、变化防重身份。
- 载荷经 `savePayloadSchema` 版本化校验；`checkSnapshot` 核对 `configId`、System 版本与跨系统引用；加载旧存档建立新 `timelineId`。
- 保存只用普通 SQLite 事务保证单次存档自洽；不为每个 Tick 自动建存档，不维护逐 Tick 历史，也不测试未保存进度在进程崩溃后的恢复。

## 9. P2.7：演示内容与运行器

演示内容（`content/demo`，包版本 1.1.0）覆盖计划 §13.1 的全部要求：

| 要求 | 内容 |
| --- | --- |
| 麻绳可携带 | `items/rope.yaml` 里的 `attributes: {agentlife.demo/portable: true}`（定义在 `attributes/portable.yaml`） |
| 石凳可支撑 | `items/bench.yaml` 里的 `attributes: {agentlife.demo/support: true}`（定义在 `attributes/support.yaml`） |
| 新增可操作灯具 | `items/lamp.yaml` 里的 `attributes: {agentlife.demo/operable: true}`（定义在 `attributes/operable.yaml`） |
| 简单操作改变灯火环境值 | `rules/lamp-glow-start.yaml`、`rules/lamp-glow-advance.yaml`（灯具 → `lamp-state` → 世界过程 `agentlife.world/lamp-glow` → `light-level`） |
| 护卫关联行为树与白名单视图 | `behaviourTrees/warden-patrol.yaml`、`localViews/warden-view.yaml` |
| 保留玩家/阿禾/护卫与三个地点 | `characters/player.yaml`、`companion.yaml`、`gate-warden.yaml`；`locations/lantern-square.yaml`、`kiln.yaml`、`orchard.yaml` |
| 恢复不再按 Tick 无条件生效 | `rules/recovery-request.yaml` 建立身体过程，`rules/recovery-effect.yaml` 在过程推进时生效 |
| 六种基础动作 | `actions/`（say、walk、wave、grasp、lay-down、use）+ `abilities/` + `resources/`（speech、locomotion、hands） |

`pnpm phase2:demo` 在一次运行内执行两次完整场景（30 Tick，含显式保存与加载续跑），并额外对照「继续原时间线」与「加载存档后继续」两条路径的摘要哈希。

## 10. 验收证据

| 计划 §16 退出条件 | 证据 |
| --- | --- |
| 1. 阶段 1 回归测试通过 | `pnpm phase1:verify` 通过：11 个阶段 1 文件、164 passed | 1 skipped。此前 `tests/runtime-store.test.ts` 的 `after-commit` 崩溃恢复用例失败，根因是崩溃注入器仍写阶段 1 早期的运行配置信封，`saveConfig` 抛错被吞掉后以退出码 3 假报「已提交」；修正注入器载荷后恢复通过（见 §11） |
| 2. 阶段 2 配置、Service、行为树、Orchestrator 和存档测试通过 | 7 个阶段 2 文件、49 项全部通过（§11） |
| 3. 六种基础动作拥有可追踪的主要成功路径 | `pnpm phase2:demo` 的 30 Tick 中 say、walk、wave、grasp、lay-down、use 均产生动作结果；世界事件包含移动、持有、放置、环境变化与过程建立 |
| 4. 资源冲突、失败、中断和跨 Tick 推进可重复验证 | `tests/phase2-body.test.ts` 的 11 项覆盖 `eligibleTick`、并行兼容、并行冲突、`queue`、`replace`、排队重新验证、替换被拒、世界裁定成功/失败/过期与「失败不回滚已提交结果」 |
| 5. WorldService 的通用关系不变量不会被规则绕过 | `tests/phase2-world.test.ts` 的 13 项覆盖双重持有、重复位置、自引用、关系环、未知引用、非出口移动与过期版本，且被拒请求不产生任何部分状态 |
| 6. 显式保存和加载能够继续相同模拟结果 | `tests/phase2-save.test.ts` 在两个保存边界（决策后与被恢复实体尚未再次决策）各续跑 8 个 Tick，摘要与继续原时间线一致；`pnpm phase2:demo` 的 `continued` 与 `loaded+continued` 同为 `72cd092710fe7fb5` |
| 7. 无 LLM 调用、随机源或机器时间进入确定性 Tick | `src/simulation/**`、`src/behavior/**` 无 `Date.now`、`new Date`、`Math.random`、`randomUUID`、网络或 LLM 依赖 |
| 8. 本报告记录实现证据、已知限制和实际偏差 | 本文件（§11 缺陷、§12 限制、§13 偏差） |

## 11. 测试

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `tests/phase2-config.test.ts` | 5 | §15.1：Item 基础字段收缩、属性类型/默认值/赋值引用、新增属性不需改内核、非法行为树/资源/动作引用、SystemSpec 变更产生新 `configId` |
| `tests/phase2-world.test.ts` | 13 | §15.2：`portable` / `support` / `operable`、双重持有、无携带者放置、批次原子拒绝、未知引用、自引用、关系环、出口移动、过期版本 |
| `tests/phase2-character.test.ts` | 7 | §15.3：三种能力层级、生命周期、degraded 主要实体被拒、normal + 行为树被拒、暂停语义、视图隔离（含行为树本地视图） |
| `tests/phase2-body.test.ts` | 11 | §15.4：`eligibleTick`、说话与移动并行、手势/拿取冲突、`parallel`/`queue`/`replace`、排队重新验证、替换被拒不破坏旧动作、世界裁定三种结果、失败不回滚 |
| `tests/phase2-behaviour.test.ts` | 5 | §15.5：节点顺序与计划交接、越权视图被拒、白名单外函数被拒、实体顺序无关、行为树计划下一 Tick 生效 |
| `tests/phase2-orchestrator.test.ts` | 5 | §15.6：十二阶段顺序与 no-op、触发索引选择、传播超限失败且不发布、缺失规则屏障、完整 Tick 追踪 |
| `tests/phase2-save.test.ts` | 3 | §15.7：快照逐字段往返、两个保存边界的续跑一致性、不兼容存档被拒且不改变运行状态 |

阶段 1 的 11 个测试文件保持通过（1 项跳过为既有的 TUI/宿主相关用例）。

### 11.1 验收过程中发现并修复的实现缺陷

| 编号 | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 传播阶段产生的世界状态变化全部被拒，内容静默失效：`darkness-visibility` 算出 `visibility = 0.72` 却从未生效 | 传播帧的 `baseVersion` 是整状态版本（`world-2/characters-1/body-3`），而 `WorldService.commit` 用世界版本（`world-2`）比较 | `TickContext` 增加帧版本，`commit` 以帧版本为基线；编排器把 `runRulesFor` 的帧版本交给世界提交。世界影响与过程推进路径沿用世界版本，行为不变 |
| 2 | 被拒的变化（前提不成立或决定重复）仍被写进发布的世界状态：文本显示「已拒绝」，但物品已易手 | `commit` 先把变化写入候选状态，再判断前提/重复；拒绝路径不回滚候选 | `stageChange` 改为纯函数 `changeEffect`（只计算补丁），只有被接受的变化才写入候选；批次内任一变化被拒则整批不提交（§7.3「不提交部分状态」） |
| 3 | 加载存档后，被恢复实体若在第一个续跑 Tick 不决策，其黑板/冷却/决定身份丢失，导致续跑结果与原时间线分叉 | `publish` 用「当前存活的适配器」重建 `behaviours`，而 `load()` 只清空适配器、未物化记录 | `behaviourStates()` 以已保存记录为底、用存活适配器覆盖，未物化的恢复记录原样发布 |
| 4 | `use` 操作不检查 `operable`：绳索也能被操作 | `influence-consent` 规则把影响种类与能力 id `agentlife.demo/operate` 比较，实际种类是 `agentlife.demo/operate-item` | 修正演示规则的字面量为影响种类；`tests/phase2-world.test.ts` 的该用例改为直接跑真实演示内容 |
| 5 | 排队中的动作启动前不重新验证身体前提，模式改变后仍会启动 | 就绪路径只检查资源冲突与传入的 `PrerequisiteCheck` | 抽出 `stepPremises` / `startPremises`，接纳与启动共用同一套前提校验（能力、资源、当前物理模式） |
| 6 | 声明的初始值可以超出它自己声明的数值范围 | `RuleCatalog.expand` 只做数值策略自洽检查，从不比较初始值与 `policy.range`（字符串词表却会拒绝） | 数值初始值也按同一路径校验，越界即拒绝（`invalid-value`） |

另外清理了两处遗留：崩溃注入器的运行配置信封（见 §10 条件 1）与行为树笔记里的 `DEBUG` 调试串。

## 12. 已知限制与暂缓

- **第 8–11 阶段仍是 no-op**：感知、认知需求、认知屏障与记忆只记录阶段，不产生业务状态；normal 角色没有伪感知/伪认知/伪记忆。
- **未保存进度不保证恢复**：进程异常退出后只能从显式存档继续；没有逐 Tick 历史、事件溯源或灾备。
- **单步运行控制**：阶段 2 只提供 Tick 级单步；Fast Forward、离屏认知与延后模型任务留到阶段 6。
- **裁定是纯确定性的**：没有随机裁定、概率动作、容器容量、多层容纳与寻路。
- **行为树输入是白名单局部视图**：需要新的可读事实时必须先扩展内容授权的局部视图。
- **属性值目前只由地点和物品声明**：角色要带属性时，需要 character 系统在自己的配置类型上声明同样的映射（内核已按引用解析成员键，无需新的内核能力）。
- **`ActionPlan.formedVersion` 只作追踪**：接纳时不与当前帧版本做等式比较（§9.2 的版本条款由接纳与启动时的前提重新校验承担，见 §13）。
- **演示内容即验收边界**：7 个阶段 2 测试文件覆盖计划 §15 列出的主业务路径，不扩展到上线级异常与灾备场景（符合 `AGENT.md`）。

## 13. 与计划的偏差

| 偏差 | 原因 | 影响 |
| --- | --- | --- |
| `TickFrame` 未作为独立类型实现 | 编排器在阶段边界固定 `TickInput`、`stateVersion` 与投影，等价保证同一阶段的读取一致 | 语义不变，少一个只用于一次 Tick 的临时类型 |
| 世界中的发光过程由内容规则建立并推进（`lamp-glow-start` / `lamp-glow-advance`） | 阶段 2 的 WorldService 只维护通用过程生命周期，具体业务过程应由内容表达 | 规则负责建立与推进，Service 只做版本、引用与关系一致性 |
| `RuntimeStore.saveSimulation` 载荷直接复用 `SaveSnapshot` 编码 | 阶段 2 的存档只服务显式保存，无需第二种存储表示 | 存储层不知道模拟状态内部结构，由模拟层解码 |
| 世界状态变化按整批提交：任一条被拒则整批不提交 | §7.3 要求「不提交部分状态」；先前的实现把被拒变化写进了候选状态，既不是整批也不是逐条 | 行为可预期：被拒即整批保持原状并逐条报告原因 |
| `ActionPlan.formedVersion` 不做版本等式校验 | 外部（诊断入口）提交的计划是在 Tick 之前形成的，与当 Tick 帧版本相等不成立；计划的有效性由接纳与启动时的前提重新校验保证 | §9.2 的「版本仍有效」改为按前提成立与否判断，字段保留用于追踪 |
| 实体属性值由实体自己声明，独立配置类型 `agentlife.world/attribute-assignment` 删除 | 原设计把「某实体拥有某属性值」拆成另一个配置项，读物品时要再看一个文件才知道它能被拿/被放/被操作；属性定义的共享价值不变 | 内核新增 `memberReferences`：成员键按引用解析（存在、可见、引用类型），成员值按该定义声明的值类型、范围与取值校验；新增支持 `Record` 字段形状。语义与原来等价（`pnpm phase2:demo` 摘要不变） |
| 崩溃注入器载荷更新为阶段 1 收敛后的运行配置信封 | 注入器仍写 `extensions`/`definitions` 旧结构，`after-commit` 分支实际从未提交成功，导致阶段 1 回归用例假失败 | 阶段 1 回归恢复通过；不新增崩溃注入测试（计划 §4 要求既有验证保持原状） |

## 14. 阶段 3 输入

- **感知阶段**接入第 8 阶段：消费局部视图与权威状态，产出可追踪的感知结果，不得绕过 Service。
- **认知阶段**接入第 9–10 阶段：认知需求汇总与计划交接已经预留扩展点，行为树与诊断入口的 `ActionPlan` 接纳路径可直接复用。
- **记忆阶段**接入第 11 阶段：`SaveSnapshot` 已包含黑板、等待与冷却索引，记忆维护可以在同一存档边界扩展。
- **运行控制**：`runTick()` 已是可重入的单步入口，Fast Forward 可在其上做批量推进与离屏认知。
