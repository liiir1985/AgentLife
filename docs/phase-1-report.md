# 阶段 1 报告：内容、配置与规则基础

- 日期：2026-09-21
- 范围：`docs/implementation-roadmap.md` §8.2（内容包规范与最小演示内容、七阶段验证、编译与触发索引、阈值/分段常量/分段线性映射与五种组合、SQLite 初始迁移与存档接口）
- 结论摘要：阶段 1 的任务全部实现，退出条件「演示内容能够生成唯一配置身份；相同配置、输入快照和模拟时间产生相同规则结果与追踪」由自动测试与 `pnpm config:demo` 逐条证明。`pnpm phase1:verify`（`tsc --noEmit && prettier --check . && vitest run`）全绿：11 个测试文件、**159 passed | 1 skipped**（1 skipped 为阶段 0 遗留的 Windows 符号链接权限用例）。本阶段**未**实现世界/身体/感知/认知/记忆的运行时状态、动作生命周期、过程推进、Tick 阶段与领域提交——这些仍属阶段 2 及以后。
- 与设计的关系：产品语义以 `docs/configuration-rule-infrastructure.md` 为准。本阶段对设计做了一处结构性收敛——**领域词汇不再由扩展硬编码为具名视图/目标，而由内容定义展开为「值族」成员**——依据与影响见 §15。

## 1. 交付物

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 内核 | `src/config/identifiers.ts` | 命名空间/稳定标识/显式版本/版本区间 |
| 内核 | `src/config/diagnostics.ts` | 七阶段、诊断码、结果语义（§19）与状态优先级 |
| 内核 | `src/config/canonical.ts` | 规范化 JSON、SHA-256 身份、深冻结 |
| 内核 | `src/config/numeric.ts` | 数值策略（单位/舍入/边界/溢出）、三种映射形式、可选策略块解析 |
| 内核 | `src/config/values.ts` | 受限取值来源（字面量/读取/派生/映射/组合/比较/选择）与比较原语 |
| 内核 | `src/config/conditions.ts` | 受限条件词汇（比较/区间/布尔/显式模拟时间） |
| 内核 | `src/config/extension.ts` | 领域扩展声明与注册（身份、能力、值族、兼容性） |
| 内核 | `src/config/value-shapes.ts` | 值/通道形状（内核提供形状，领域声明拥有权） |
| 内核 | `src/config/vocabulary.ts` | 运行配置词汇：静态视图/目标 + 由定义展开的值族成员 |
| 内核 | `src/config/capabilities.ts` | 扩展能力的只读索引（按身份查找） |
| 内核 | `src/config/packs.ts` | root + 依赖包集合、跨命名空间可见性 |
| 内核 | `src/config/source.ts` | 内容包解析（结构阶段）、Markdown 引用展开 |
| 内核 | `src/config/resolve.ts` | 默认值 → 模板组合 → 显式覆盖，来源追踪 |
| 内核 | `src/config/validate.ts` | 阶段 2–7：引用、依赖、组合、权限、领域、兼容性 |
| 内核 | `src/config/compile.ts` | 不可变运行配置、触发索引、稳定顺序、组合计划、身份 |
| 内核 | `src/config/evaluate.ts` | 确定性求值、候选结果与完整追踪 |
| 内核 | `src/config/registry.ts` | 原子配置更新、当前版本、恢复核对、求值入口 |
| 内核 | `src/config/demo-runner.ts` | 演示运行器：打印配置身份、索引、逐目标组合值与追踪摘要 |
| 领域 | `src/domains/world-extension.ts`、`body-extension.ts`、`character-extension.ts`、`index.ts` | 世界/身体/人物的配置类型、值族、视图、触发器、输出目标与领域验证 |
| 存储 | `src/storage/migrations.ts` | 版本化迁移（`PRAGMA user_version`） |
| 存储 | `src/storage/runtime-store.ts` | 当前运行配置、版本历史、求值追踪、效果消费身份、恢复前置检查 |
| 存储 | `src/storage/config-crash-worker.ts` | 配置提交崩溃注入（退出码 0/1/3） |
| 内容 | `content/demo/**` | 最小演示内容包（3 地点、2 物品、6 环境事实、6 身体值、1 通道、4 角色、13 规则 + 1 派生量、3 篇长文本） |
| 测试 | `tests/rule-kernel.test.ts` | 数值策略、映射、取值来源、条件、扩展注册与值族声明 |
| 测试 | `tests/configuration-validation.test.ts` | 35 项拒绝用例 + 4 项合成扩展的解析与组合用例 |
| 测试 | `tests/configuration-registry.test.ts` | 身份、来源、值族展开、跨命名空间、原子更新、恢复 |
| 测试 | `tests/configuration-evaluation.test.ts` | 确定性、索引选择性、组合、冲突、契约值、过期请求 |
| 测试 | `tests/runtime-store.test.ts` | 迁移、版本化载荷、崩溃恢复、幂等消费 |

## 2. 内容包规范（阶段 1 定稿部分）

目录结构沿用 `docs/implementation-roadmap.md` §5.1，`manifest.yaml` 声明目录到配置类型的映射：

```yaml
pack: agentlife.demo            # 命名空间（点分小写）
version: "1.0.0"                # 内容包版本（诊断与身份用）
kernel: ">=1.0.0 <2.0.0"        # 对共享内核的兼容要求
dependencies: []                # 允许引用的其他命名空间
extensions:                     # 需要参与的领域扩展及版本
  - agentlife.world/extension@1.0.0
sections:                       # 目录 → 配置类型；文件内的 type 必须与之相等
  world: agentlife.world/world
  locations: agentlife.world/location
  items: agentlife.world/item
  environment: agentlife.world/fact
  values: agentlife.body/value
  channels: agentlife.body/channel
  characters: agentlife.character/character
```

| 规则 | 说明 |
| --- | --- |
| 结构化文档 | 只允许 `manifest.yaml`、已声明 section 目录下的 `.yaml`、`rules/` 下的 `.yaml`，以及 `behaviors/`、`prompts/`、`texts/`（本阶段原样携带、不解释）。其他位置的 `.yaml` 一律拒绝。 |
| 定义文档 | `{ id, type, public?, templates?, fields? }`；`ref = <包命名空间>/<id>`，规则与派生量与定义共用同一命名空间，重名即拒绝。值/通道定义的文档 `id` 同时是该值成员的寻址名（必须是 `[a-z][a-z0-9-]*`）。 |
| 规则文档 | `{ kind: rule, id, domain, triggers, reads|?, condition, effects, dependsOn|? }`；`reads` 每项为 `{alias, view, field}`，条件与效果只能通过 alias 取值。 |
| 派生量文档 | `{ kind: derivation, id, domain, reads|?, outputUnit, value }`；输出单位必须与其取值来源的单位一致。 |
| 长文本 | 任何 `.md` 字符串都被解析为受控引用并替换为文件正文（阶段 0 已保证引用存在且在包内）；引用参与内容包完整性身份。 |
| 未知字段 | 任何未在扩展声明中出现的字段都是结构错误（不静默忽略）。 |
| 数值字面量 | 可声明 `unit`，省略即无量纲；非数字字面量不得声明单位。 |
| 数值策略 | 值/通道定义里的 `policy` 块每一部分都可省，省去的部分**不加任何约束**（无量纲、不舍入、无上下界、越界饱和）；**映射（mapping）的 `policy` 仍然必须声明舍入、范围与区间外行为**。 |

## 3. 领域扩展注册（§6、§18.1）

每个扩展声明：`namespace/name/version/kernel constraint/requires`、配置类型（字段 Schema、默认值、可覆盖字段、字段合并策略、字段引用、**值族（可选）**）、只读视图（字段 Schema + 每个数值字段的单位 + `exposedTo`）、触发器词汇、输出目标（值类型、可选数值策略、可选字符串词表、`exposedTo`）、过程（允许的操作 + 参数 Schema）、领域验证入口。

注册结果区分 `registered` / `identity-conflict` / `semantic-incompatible` / `unsupported-semantics` / `unauthorized-capability`：

- **不受支持语义**：Schema 出现白名单外构造（如 `Type.Any()`）、默认值与字段类型不符、对非数组字段声明 `append`、对非对象字段声明 `merge`、值族成员声明了不存在的字段或类型无法容纳该成员、字符串目标声明词表以外的值类型、同一命名空间内跨类别重名（**视图与输出目标同名除外**：那是同一契约值的读侧与写侧）。
- **越权能力**：视图或输出目标声明 `exposedTo: ["*"]`（内核从不授予通配可见性）、声明不支持的输出值类型。
- **身份冲突**：同一「命名空间 + 扩展名」注册了不同内容；相同内容重复注册是幂等的。
- **语义不兼容**：内核版本区间不满足，或 `requires` 的同伴扩展缺失/版本不符（`finalize()` 统一检查，**与注册顺序无关**）。

暴露名单可以写尚未注册的扩展：`finalize()` 对这类授权给出警告而不是拒绝，注册后自然生效。

扩展指纹（声明的规范化 JSON 的 SHA-256）进入运行配置身份：扩展语义变化必然产生新的运行配置版本。

## 4. 解析顺序与来源追踪（§5.3、§14.1）

固定顺序：**类型默认值 → 按声明顺序组合模板 → 当前包的显式覆盖**。

- 合并策略按字段声明：`replace` / `append`（数组，按顺序拼接）/ `merge`（对象，浅合并）/ `reject`（出现第二个来源即拒绝）；**未声明策略的字段出现第二个来源即 `ambiguous-merge`**，绝不采用「后加载者获胜」。
- 显式覆盖只能作用于配置类型 `overridable` 列出的字段，否则 `field-not-overridable`。
- 每个字段保留 `contributions: [{layer, source, value}]`，因此「一个有效值来自默认值、模板还是覆盖」可逐字段追查，被覆盖内容同样留在解析结果中供授权诊断查看。
- 模板必须类型相同、存在且对引用方可见，模板环在解析阶段即报 `cyclic-dependency`。

演示证据：`agentlife.demo/companion` 的 `modules` 来源链实测为 `default(agentlife.character/character) → template(agentlife.demo/normal-entity)`，`identity` 为 `template → override` 且覆盖值是 Markdown 长文本引用；`agentlife.demo/player` 的 `control.kind` 由模板提供 `cognition`、被覆盖为 `user`。

## 5. 七阶段验证（§9.1）

| 阶段 | 实现位置 | 覆盖内容 |
| --- | --- | --- |
| 1 结构 | `source.ts`、`resolve.ts`、`extension.ts` 注册、`vocabulary.ts` | 必需组成、类型、枚举、未知字段、默认值/合并策略合法性、值族成员与定义字段/类型的一致性、定义 id 可寻址 |
| 2 引用 | `resolve.ts`、`validate.ts#bindReads/checkDefinitionReferences` | 模板与字段引用存在性、类型匹配、跨命名空间可见性、规则/派生量存在性、视图字段与值成员存在性 |
| 3 依赖 | `validate.ts#dependencyOrder` | 规则与派生量的拓扑顺序，环即拒绝，同级按稳定身份排序 |
| 4 组合 | `validate.ts#checkCompositionPlan/checkValueCompatibility/checkValueUnits` | 同一目标组合方式一致、**契约值恰好一个写方**、优先级声明、单位与值类型兼容、映射策略完整性、组合/比较/选择内部一致性 |
| 5 权限 | `validate.ts#bindReads/bindEffects` | 视图读取授权、输出目标写入授权、过程操作仅限拥有者、触发器存在性 |
| 6 领域 | `validate.ts#runDomainValidation` + 各扩展 `validate` | 领域词汇与不变量（见 §7） |
| 7 兼容性 | `validate.ts#checkCompatibility` + `ExtensionRegistry.finalize` | 包与扩展的内核版本、扩展版本固定、同伴扩展要求 |

任一阶段出现 error 即整体拒绝，**当前有效配置完全不变**（`apply` 返回 `rejected` + 诊断，`registry.current()` 仍指向旧版本，测试以对象同一性断言）。

诊断携带 `severity/stage/code/message/subject/source{pack,file,path}`；作用域覆盖 §20 验收场景 3、4、6、8、9、31、32 所需的全部拒绝路径。

## 6. 编译产物与配置身份（§9.3、§5.2）

`compileConfiguration` 产出深冻结的运行配置：固定的引用与类型、`triggerIndex`（触发器 → 候选规则，稳定顺序）、规则与派生量的稳定求值顺序、读取集合与输出集合、每个输出目标的组合计划（含值类型、可选数值策略、可选字符串词表）、包/扩展身份元数据，以及可重建的源文档（`sourceDocument`）。

运行配置身份 = 规范化 JSON 的 SHA-256，输入包含：

```
kernelVersion + 扩展[{ref, version, fingerprint}] + 包[{namespace, version, kernel, contentIdentity}]
+ 定义[{ref, type, isPublic, values, fields{merge, contributions}}]
+ 规则[{ref, domain, triggers, reads, usedReads, condition, effects, dependsOn, order}]
+ 派生量[{ref, domain, reads, usedReads, outputUnit, value, order}]
+ triggerIndex + compositionPlans
```

同一内容重复 `apply` 得到相同身份；改一个地点名、改一条规则或改扩展声明都会得到新身份（测试覆盖前两者，扩展指纹在注册测试中覆盖）。改一个**未参与求值**的字段同样改变身份——身份标识的是完整内容，而非抽样语义。

## 7. 领域验证（本阶段实际的领域不变量）

| 领域 | 不变量 |
| --- | --- |
| world | 根命名空间必须恰好声明一个世界设置定义；`exits` 引用必须存在且为 location（由内核引用阶段执行，`location.references` 声明）；物品声明 `container` 角色必须有容量 |
| body | 无领域级附加严格性：值/通道成员的类型、初值、单位、策略与字符串词表由定义自身声明，内核负责展开与一致性校验；器官、能力、资源、模式、身体过程与说话能力留待身体运行时（阶段 2 起） |
| character | 能力层级 ↔ 控制方式 ↔ 子系统模块矩阵：普通动态实体不得有自主决策入口或子系统模块；降级实体只能用行为树、不得为主要实体、不得引用感知/认知/记忆；正常实体不得同时运行行为树与完整认知；认知入口必须有认知模块；用户入口不得只保留认知状态而无主观记忆；`identity` 是自由文本，只要求初始版本非空（§20 验收 31、32） |

行为树引用、Fast Forward 零 LLM 与 Tick 阶段顺序属阶段 2/6，本阶段未注册对应字段（避免声明无法验证的词汇）。

## 8. 确定性求值（§8、§10）

`evaluate(config, request)` 的输入只有三样：固定的运行配置、输入快照（`stateVersion` + 只读视图投影）、显式模拟时间（`{tick, seconds}`）。求值器不接受任何其他输入：没有时钟、随机源、文件/网络/数据库访问，读数只能通过编译期声明过的 `alias` 从快照取值；派生量按依赖顺序求值并做进程内记忆化。

一次求值：

1. 请求携带的 `dependsOnStateVersion` 与快照 `stateVersion` 不一致 → `state-version-stale`，一条规则都不执行（§15.3）。
2. 触发器索引命中候选规则（无命中 → `no-match`）；未命中规则在追踪里列入 `notIndexed`，以区分「没有被触发」。
3. 逐条规则：声明过的读取全部存在才继续（否则 `input-missing`）；条件求值（失败 → `input-invalid`/`input-missing`；false → `condition-false`）；取效果值。
4. 按目标分组组合，产生候选结果与组合追踪；过程操作单独作为候选返回。
5. 结果状态按固定优先级汇总（见下）。

| 结果状态 | 含义 |
| --- | --- |
| `state-version-stale` | 请求依赖的状态版本已变化，未执行任何规则 |
| `config-unavailable` | 尚未发布任何运行配置版本 |
| `input-invalid` | 存在缺失/类型不符/单位不符的输入（候选可能只是部分结果） |
| `inexpressible` | 组合结果超出目标声明的表示范围（`overflow: reject`）或落在字符串词表之外 |
| `conflict` | 相同最高优先级给出不同值，不静默择一 |
| `candidates` | 得到完整、无歧义的候选集合 |
| `condition-false` | 命中规则均不满足条件 |
| `no-match` | 触发索引没有任何规则 |

**优先级理由**：不完整求值（`input-invalid`）优先于 `candidates`，避免调用方把部分结果当成完整结果；`inexpressible`/`conflict` 优先于 `candidates`，两者都不能直接提交。追踪仍逐条保留原因，因此优先级只影响汇总状态，不丢信息。

受限取值来源（§9.3 的「组合计划」在取值层的最小对应）：

| 形式 | 语义 |
| --- | --- |
| `literal` | 字面量（数字可带单位，省略即无量纲） |
| `read` | 声明过的 alias 取值，缺失即失败，绝不默认 |
| `derived` | 引用一条命名派生量（按依赖顺序求值并记忆化） |
| `map` | 应用声明过的映射（阈值/分段常量/分段线性），输入单位必须与 `inputUnit` 相同 |
| `combine` | 对多个取值来源按 `min`/`max`/`add`/`multiply` 求一个值；`min`/`max`/`add` 要求各操作数单位一致，`multiply` 要求各操作数无量纲 |
| `compare` | 比较两个取值来源，产生布尔值（单位或类型不一致即失败） |
| `select` | 先比较、再在两个取值来源之间选一个，用于「一个规则写出多态值」（如三态许可、通道可用性） |

组合语义（§11.2）：

| 方式 | 语义 | 附加约束 |
| --- | --- | --- |
| `priority` | 取唯一最高优先级来源；最高优先级并列且值不同 → 结构化冲突 | 每条规则必须声明优先级 |
| `min` / `max` | 对数值取最小/最大 | 目标必须为数值类型 |
| `add` | 求和 | 各来源单位必须等于目标单位，最终按目标策略舍入/裁剪 |
| `multiply` | 求积 | 目标单位必须是 `ratio`，各来源单位也必须是 `ratio` |

同一目标的组合方式必须一致：混用不同方法在加载期即被拒绝（`missing-composition`），运行期才出现的并列冲突返回结构化冲突而不会择一。**组合方式由规则声明，扩展不再声明「允许哪几种组合」**；对标记为契约值的成员，加载期额外要求**恰好一个写方**（`multiple-writers`），因为核心值不允许出现「谁写了它」的歧义。

## 9. 演示内容的实测结果

输入快照（`stateVersion: state-1`，模拟时间 tick 3）：

```yaml
agentlife.world/environment: { light-level: 40, fog-density: 0.9, sun-angle: 130, slope: 0.3, lamp-state: 1 }
agentlife.body/values:       { stamina: 25, integrity: 1, wakefulness: 40, load: 12 }
agentlife.body/channels:     { vision.available: true, vision.efficiency: 0.8 }
```

| 触发器 | 命中规则 | 组合 | 候选结果 |
| --- | --- | --- | --- |
| `agentlife.body/value-changed` | base-move-cost、cognitive-participation、exertion-cost、exhaustion-move-cost-factor、load-move-cost-factor、terrain-move-cost-factor | add / multiply / priority | `move-cost=5.7`、`move-cost-factor=2.52`（1.4×1.2×1.5）、`stamina=0`（−2.7 经值自身范围饱和到 0）、`cognitive-participation=restricted`（40 落在 20–60） |
| `agentlife.body/tick-elapsed` | daylight-wakefulness、lamp-stimulus、rest-recovery | priority / add | `wakefulness=80`（优先级 10 胜出 20）、`stamina=5`（阈值 30 的 lower 侧） |
| `agentlife.world/environment-changed` | darkness-visibility、fog-visibility、vision-availability、vision-efficiency | min / priority | `visibility=0.15`（min(0.24, 0.15)）、`vision.efficiency=0.2`（min(0.28, 0.2)）、`vision.available=true`（雾 0.9 ≤ 0.9） |

`pnpm config:demo` 打印同一组值（逐目标组合值与来源），并连续运行两次比对摘要：两次身份、候选与追踪完全一致。

演示内容覆盖：硬阈值、分段常量、分段线性三种映射；优先级/最小/加法/乘法四种组合，最大值另有合成目标用例（见 §11）；取值来源的 `combine`（通道效率取最小）、`compare`/`select`（通道可用性与三态许可）；派生量被规则引用并参与节点顺序；契约值的单写方约束；显式模拟时间条件；单位不一致、组合方式冲突等拒绝路径。

## 10. 原子配置更新与持久化（§12、§15）

`ConfigurationRegistry.apply` 的顺序：解析 → 打包集合 → 7 阶段验证 → 编译 → **持久化提交** → 切换内存中的当前版本。失败路径：

- 验证/编译失败：返回 `rejected` + 诊断，当前版本不变（不需要领域回滚）。
- 持久化在提交前失败：返回 `config-unavailable`，当前版本不变。
- 持久化在提交后失败（崩溃/未确认）：重新读取持久层的当前版本；若已是新版本则采纳（`valid`），否则 `config-unavailable`——**持久层是唯一裁决者**。

SQLite 迁移（`PRAGMA user_version`，每个迁移独立事务）：

| 版本 | 内容 |
| --- | --- |
| 1 | 阶段 0 的建表（timelines、payloads、snapshots、idempotency_commits、phase_records）原样收编为迁移，阶段 0 报告与测试不受影响 |
| 2 | `config_versions`（identity PK、namespace、pack_version、document_json）、`current_config`（单槽位外键）、`evaluation_traces`（幂等键唯一）、`consumed_effects`（effect_id 主键 + timeline + config identity） |

- 运行配置文档以版本化 JSON 载荷（`schemaVersion 1` / `type runtime-config`）保存，写入与读取都按信封 Schema 校验；同一 identity 写入不同内容直接抛错（§5.2 「相同版本标识对应不同完整内容视为完整性错误」）。
- 崩溃注入（`config-crash-worker.ts`）：`before-transaction` / `inside-transaction` 后当前配置仍为旧版本；`after-commit`（退出码 3）后为完整新版本，版本历史只多一条，不存在半生效状态。
- 恢复核对：`checkRestore(identity)` 在配置版本缺失时阻止继续；`ConfigurationRegistry.restore(identity)` 用存储的文档重建运行配置并要求**重建结果的身份与保存的身份完全一致**，否则 `config-unavailable`——不会静默替换成另一份配置（§15.2）。
- 幂等：`evaluation_traces` 按幂等键去重；`consumeEffect` 第二次返回 `duplicate`，保证已提交效果不会被重复执行（§15.2）。

## 11. 验证

```text
pnpm phase1:verify       # tsc --noEmit && prettier --check . && vitest run
  tsc --noEmit           ok（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noUnusedLocals/Parameters）
  prettier --check .     ok
  vitest run             11 files, 159 passed | 1 skipped
pnpm config:demo         ok（两次运行摘要一致，退出码 0）
```

| 测试文件 | 用例 | 保护的不变量 |
| --- | --- | --- |
| `tests/rule-kernel.test.ts` | 26 | 舍入/边界/溢出、策略块缺省语义、三种映射与区间外行为、取值来源（读/映射/组合/比较/选择）、条件语义、扩展注册与值族声明拒绝路径 |
| `tests/configuration-validation.test.ts` | 39 | 引用、依赖、组合、权限、领域、兼容性六类拒绝路径（含值族成员、契约值单写方、组合/选择内部一致性、进程参数）；默认值/模板/覆盖的解析与来源 |
| `tests/configuration-registry.test.ts` | 12 | 内容身份稳定性、来源可追查、值族展开（成员、通道双成员、组合计划集合）、Markdown 长文本、原子更新三条失败路径、恢复身份一致性、跨命名空间可见性 |
| `tests/configuration-evaluation.test.ts` | 11 | 同输入同结果与同追踪、触发索引选择性、四种组合、优先级冲突、契约值三态、超范围不可表示、缺失输入、过期请求、过程候选、已开始求值使用启动时的版本 |
| `tests/runtime-store.test.ts` | 11 | 迁移层级、信封校验、版本历史与完整性、崩溃注入、追踪幂等、效果一次性消费、恢复前置检查 |
| 阶段 0 六个文件 | 61 passed（另有 1 项跳过） | 未回归（Agent 6 / TUI 19 / 演示脚本 5 / 内容包 11 / 存储探针 9 / Mistreevous 10） |

端到端路径（`tests/configuration-registry.test.ts`、`tests/configuration-evaluation.test.ts`、`src/config/demo-runner.ts`）用的都是仓库内的真实演示内容包 `content/demo`：加载 → 解析 → 验证 → 编译 → 求值。负例用「复制演示包并覆盖单个文件」的方式构造，保证拒绝路径面对的是真实内容而不是手写的残缺文档；未随包发布的词汇（进程）用合成扩展 `test.process` 覆盖。

## 12. 与 `configuration-rule-infrastructure.md` §20 验收场景的对照

| 场景 | 状态 |
| --- | --- |
| 1 统一命名空间/版本/引用/诊断 | 已覆盖（演示包 + 合成包均通过同一注册表与管道） |
| 2 参考角色模板组合与覆盖，来源可追查 | 已覆盖（角色模板组合 + 覆盖 + `contributions` 逐字段来源；载体是角色模板，不是身体模板） |
| 3 缺失引用、跨命名空间越权、包依赖环、不兼容扩展语义生效前拒绝 | 已覆盖（跨命名空间两例、模板环、内核版本、扩展版本） |
| 4 扩展可增加词汇但不能越权读写 | 已覆盖（未授权读取/写入/过程操作、通配可见性拒绝） |
| 5 相同版本 + 输入 + 模拟时间得到相同结果与顺序 | 已覆盖（逐字节比较两次求值结果 + `config:demo` 两次运行摘要一致） |
| 6 规则不能读机器时间、随机数、I/O、LLM、未声明字段 | 结构性满足（求值器只接触显式快照与显式模拟时间，取数只能经声明过的 alias）+ 未声明字段在加载期拒绝 |
| 7 Tick 只执行已编译规则、不扫描全部规则 | 触发索引选择性已覆盖；Tick 阶段本身属阶段 2 |
| 8 无组合方式、优先级并列、无法稳定排序时不可生效 | 已覆盖（`missing-composition` + 运行期结构化冲突 + 契约值 `multiple-writers`） |
| 9 映射未声明边界/舍入/区间外行为不可通过 | 已覆盖（映射策略校验用例）；值/通道定义里的策略块可以部分声明，未声明部分确实不加约束 |
| 10–11 世界/身体只能产生候选、领域提交权威 | 候选结果与「领域拥有输出目标」已覆盖；领域提交属阶段 2 |
| 12 新规则输入→验证→编译→生效为原子操作 | 已覆盖（三条失败路径保持当前版本不变） |
| 13 更新期间崩溃只有完整旧/新配置 | 已覆盖（三个崩溃点 × 配置提交） |
| 14 已开始求值使用原快照，更新后的新求值用新配置 | 已覆盖（对旧版本求值仍得旧结果，注册表求值用新版本） |
| 15 已有过程保留已提交参数 | 阶段 2/6（本阶段只产生建立/推进/暂停/结束/取消候选） |
| 16 延迟候选依赖状态变化时不能覆盖新状态 | 已覆盖（`state-version-stale` 优先于一切） |
| 17–19 感知/认知/记忆规则只能产生候选 | 阶段 4/5 |
| 20 时间条件只能使用显式模拟时间 | 已覆盖（`simulation-time` 条件、求值上下文只接受显式时间） |
| 21 Skill 输出不能绕过验证与原子更新 | 阶段 7（入口已固定：任何候选都必须经 `apply`） |
| 22 追踪可供授权诊断但不进入角色主观状态 | 追踪结构已就位；与感知/记忆的隔离属阶段 4/5 |
| 23–30 记忆/意图/等待期限的确定性求值 | 阶段 4/5（内核映射、组合、比较、选择与追踪能力已就绪） |
| 31 主要标记与能力层级可独立配置 | 已覆盖（领域验证：非正常实体不得为主要实体） |
| 32 普通动态/降级/正常实体的决策入口互斥 | 已覆盖（矩阵拒绝用例） |
| 33 行为树局部视图不得读 Ground Truth 等 | 阶段 2（视图白名单机制已就位：视图 `exposedTo` 与未授权读取拒绝） |
| 34 Fast Forward 不得启用任何 LLM | 阶段 6 |
| 35 固定 Tick 与快进策略使用单一运行配置版本 | 阶段 6（单一版本机制已就位） |

## 13. 阶段 2 硬约束

1. **一切候选效果经内核产生、由领域提交**：阶段 2 的 WorldService/BodyService 只能消费 `CandidateEffect`（含 `dependsOnStateVersion`），提交后把领域状态版本回填给下一次求值。
2. **效果身份用于防重**：提交前用 `consumeEffect(effectId, timelineId, configIdentity)` 领取；返回 `duplicate` 必须跳过，这是崩溃恢复不重复应用的唯一依据。
3. **Tick 只查索引**：用 `triggerIndex` 选择候选规则，禁止遍历全部规则；触发器词汇必须先在领域扩展中声明。
4. **读数必须声明**：领域每次求值只投影已声明视图（`views[viewRef]`），未声明的字段读不到。值族视图的字段名是**定义 id**（通道是 `<id>.available` / `<id>.efficiency`）。
5. **契约值单写方**：标为契约的值族成员与静态目标必须恰好一个写方；需要多来源的值不得标为契约。
6. **动作/过程参数属于领域状态**：过程建立时计算的参数由领域保存，配置更新不得倒改；下一 Tick 的判断使用当前有效配置。
7. **身体/世界不变量写在领域 `validate`**：内核不做领域语义判断，只保证引用、依赖、组合、权限、兼容性。
8. **新增词汇必须提升运行配置版本**：扩展声明变化会改变指纹 → 身份；不要在同一版本内改变既有词汇语义。
9. **值族与实体投影**：当前视图按 `viewRef` 单实例投影（一个演示角色一份身体）。阶段 2 引入实体后，视图必须按实体键投影（如在 `views` 中增加实体维度），**不得**通过「一个视图塞多实体」隐式绕过。
10. **恢复流程**：`restore(identity)` 只做「重建 + 身份比对」，采纳必须走 `apply` 或显式迁移，不得静默替换。
11. **演示内容不得硬编码进领域模块**：地点、物品、环境事实、值、通道、角色、规则全部来自 `content/demo`；领域模块只注册词汇与不变量。

## 14. 已知限制与暂缓

- **没有领域状态**：本阶段没有世界/身体实例、动作生命周期、资源占用与并行冲突；候选结果只被计算与追踪，未被任何领域验证/提交（阶段 2）。
- **一个视图一个实例**：`views[viewRef]` 目前只有一个投影，实体级状态是阶段 2 的工作（见 §13.9）。
- **过程只是候选**：`establish/advance/pause/end/cancel` 由规则提出、内核校验词汇与参数，但推进与到期索引属阶段 2/6；**没有任何已发布领域声明过程**，该路径只由合成扩展 `test.process` 覆盖。
- **`multiply` 仅限无量纲目标**：目标单位必须为 `ratio`，各来源单位也必须是 `ratio`；带量纲的乘积语义留待真正需要时再定义（避免用名称推断语义）。
- **派生量只支持返回数值**：需要布尔/字符串中间值时用 `compare`/`select`，不引入未定义的求值语义。
- **恢复不重放解析历史**：恢复用存储的源文档重建并要求身份一致；文件路径级来源（`source{pack,file,path}`）保留在定义中，但恢复不重新读取内容包目录（设计 §12.4 明确不要求位级重放）。
- **TUI 仍停留在阶段 0 的 spike 界面**：本阶段没有用户可见界面变化，`F2` 监视面板与 TUI 约定保持阶段 0 状态（阶段 3 接上）。

## 15. 与本阶段计划的偏差

| 偏差 | 原因 | 影响 |
| --- | --- | --- |
| 领域词汇从「具名视图/目标」改为「值族」：内容定义展开为视图成员与可写目标（`agentlife.body/values.<id>`、`agentlife.body/channels.<id>.available|efficiency`、`agentlife.world/environment.<id>`） | 原方案的视图/目标字段由扩展硬编码（`stamina`/`wakefulness`/`lightLevel`…），内容无法自行增删值；设计 §18.1 要求共享基础设施不定义任何具体世界的指标 | 新增值只需内容定义，不改内核与领域代码；代价是目标名带 `<族>.<id>` 一段 |
| 身体扩展的器官/能力/资源/模式/身体过程与「说话」能力整体移除 | 这些词表只有在身体运行时能定义并验证其语义，否则是「声明了却验证不了」的词汇 | 阶段 1 的身体扩展只剩值容器 + 通道 + 参与许可契约 + 触发器；演示内容的相应设定值一同删除 |
| 世界扩展的 `ambientLight`/`fogDensity`/`slope`/`lampState`/`shelterIndex` 等设定值与 `presence` 视图移除 | 同上；环境量改为内容定义的事实（`agentlife.world/fact`） | `content/demo/environment/*.yaml` 保存这些数值；未使用的 `shelterIndex`/`ambient-light` 直接删除 |
| 数值策略的严格性按层区分：值/通道定义的 `policy` 块可以部分声明，映射的 `policy` 仍必须完整 | 「内核不定义指标」与「映射未声明边界/舍入/区间外行为不可通过」（§20 场景 9）需要同时成立 | 内容可以只声明它真正想要的约束（如仅单位或仅范围）；域不再被内核强迫提供数值策略 |
| 组合方式的权威从扩展移到规则，并新增契约值单写方检查 | 同一目标允许的方法集合是「内容想怎么写」的问题；核心值（身体/认知需要的值）不允许出现写方歧义 | 扩展不再声明 `allowedComposition`；同一目标的多条规则仍必须使用同一种方法；契约值多写方在加载期拒绝 |
| 取值来源新增 `combine`/`compare`/`select` | 单写方约束把「多个输入合成一个值」推进到规则内部；三态契约值（许可）与通道可用性无法用纯数值映射表达 | 取值层与条件层共享同一套比较原语；三者都是声明式、确定性的，不引入表达式语言 |
| 角色 `identity` 从结构化映射改为自由文本 | 内核与配置层不解释身世/人格/偏好，只有非空要求；结构化与否是认知层的事 | 演示角色的身段文本可直接书写或用 Markdown 引用承载；领域验证只剩「初始版本必须存在」 |
| 不再引用身体模板（`bodyTemplate`） | 身体模板原本用于「哪些指标/能力适用」，现在值族由内容直接定义 | §20 验收场景 2 的证据改由**角色模板组合 + 覆盖**承担（`normal-entity` → `player`/`companion`） |
