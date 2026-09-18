# OpenCode 多模型会诊模式

OpenCode 插件级实现：召集多位大模型对卡点问题进行结构化会诊（多轮发言、点名分歧、红队攻击、收敛判定），配套《大模型能力评分标准 V3.2.2》给候选模型打能力分，生成可复用的选择名单。

## 目录结构

```
opencode-consult-release/
├── plugins/consult.ts          核心插件（会诊 12 工具，含能力打分/连通性探测）
├── command/                    命令：/consult /invite /end-debate /team_dev
├── agents/                     会诊席卡模板（17 个：三角色 + 14 成员）
├── 大模型能力评分标准_V3.2.2.md   能力打分标准（唯一权威版本）
└── 云端模型数据政策核查流程.md     转发云端成员前的数据政策核查用法
```

运行后插件会自动在你的 `.opencode/groupchat/` 生成运行数据（`probe_results.json` 测通名单、`capability_scores.json` 能力分、`shared_draft.json` 会诊状态、`raw_messages.json` 发言记录）。

## 注册 OpenCode Go（云端模型网关）

本插件的云端模型名单来自 OpenCode Go 网关（README 中 provider 显示为 `opencode` / `opencode-go` 即用它接入）。**若你尚未注册**，可通过以下推荐链接注册，推荐人与你均可获得 OpenCode Go 推广奖励：

**https://opencode.ai/go?ref=PYYB0111VM**

安装后 `consult_invite` 会自动拉取你 OpenCode Go 上的可用模型名单。

## 安装（三分钟上手）

1. 把 `plugins/consult.ts` 放入你的 `.opencode/plugins/`
2. 把 `command/` 下命令放入你的 `.opencode/command/`
3. （可选）把 `agents/` 席卡放入你的 `.opencode/agents/`
4. 重启 opencode 使插件生效

## 会诊模式主流程

1. **/consult** → 第一步选保密档位（0~5，一次会诊锁定）
2. 第二步 `consult_invite` 实时拉取**你自己 opencode 的可用模型名单**（与切模型器同源，非死名单）；`only_ok=true` 只列已测通模型
3. `consult_start(question)` 开问 → 循环 `consult_next`/`consult_speak` → 收敛到 `done` → `consult_summary`

## 连通性探测与测通名单

- **先测通再打分**：`consult_probe` 对候选模型发最小请求验证连通性，结果落盘 `probe_results.json`（测通名单）；不可用模型不打分
- **增量探测**：默认只测未测过的模型；`force=true` 全量重测
- **8 秒超时**：单模型请求超时即判失败，不阻塞后续
- **并发 + 厂商取样**：默认并发 4、每厂商最多 2 个代表
- **跳过名单**：`group_config.json` 的 `probe.skip` 可配置直接跳过的模型
- `consult_invite(only_ok=true)` 直接拉测通名单开会，无需每次重测

## 能力打分（V3.2.2）

- `consult_score` 按《大模型能力评分标准 V3.2.2》对**测通**的模型打分，落盘 `capability_scores.json`（未测/不通自动跳过；自动记录打分时间）
- `consult_invite` 展示名单时自动合并各模型能力分 + 探测状态（✓可用/✗不通）+ 推荐说明

## 样例席卡说明

`agents/` 下的席卡 `model:` 字段是**开发机器的真实模型 ID 样例**（如 `opencode-go/glm-5.3`、`ollama/qwen2.5:7b`）。使用时请**替换成你 opencode 中实际可用的模型 ID**——真实名单由 `consult_invite` 实时拉取，席卡只是本地注解与权限壳。

## 保密档位（六档）

0 完全开放 / 1 项目全局只读 / 2 只读屏蔽敏感 / 3 沙盒文件夹 / 4 片段沙盒 / 5 纯文字问答

## 云端数据政策（每次会诊实时核查）

不同用户的模型群体不同，项目不内置任何厂商结论表。会诊转发云端成员前，主持人按 `云端模型数据政策核查流程.md` **现场查官方原文**（训练/留存/ZDR/渠道），结论回填 `group_config.json` 的 `privacy` 字段，供 `consult_invite` 展示。

## 铁律

- 一票否决权只在用户；AI（含主持人）无权终裁、无权停止
- 成员 agent 一律禁写盘（席卡权限已硬锁）；落盘权独在主持人
- 与会审内容须按档位脱敏后再转发云端成员

## 安全边界声明（重要，务必读完）

1. **六档保密等级只是主持人（主舱模型）的提示词软约束，没有插件代码级的文件读写拦截。** 模型是否遵守，取决于主持人是否自觉执行该等级规则。
2. 系统唯一真正的代码级硬隔离来自 OpenCode 原生席卡的 `permission` 配置（由 OpenCode 内核执行），与六档无关、写死在席卡里。
3. 沙盒模式仅是流程上的人工目录管理，插件**不会**阻止读取沙盒以外的文件。涉及高度机密代码，不能仅依靠本插件做安全防护。
4. 会诊状态持久化：保密等级、会诊状态、发言记录落在 `.opencode/groupchat/`。会话异常崩溃后，若再次加载发现 sessionId 不匹配或超过 30 分钟未结束，会自动作废上次会诊状态（`loadDraftValidated` 校验），不留权限残留。
5. 逃生开关：`consult_reset`（含 `/reset-consult`）一键清空当前会诊状态与保密等级锁定。