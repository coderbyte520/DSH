# @vreal/dsh-verifiable-reward

[English](README.md) | 中文

对 shell 工具结果做机械奖励打分，每次匹配到的调用记录为一个可忽略的 `reward/check` 会话事件。打分是确定性的——只用命令匹配、退出码、测试计数提取与罚分模式——不涉及任何模型。这些记录构成训练奖励的可验证一侧，由采样或导出插件折叠进数据集。

## 插件（namespace：`verifiable-reward`）

在工具注册表与 shell 工具旁挂载一行：

```yaml
- id: verifiable-reward
  name: '@vreal/dsh-verifiable-reward'
```

观察者监听 `tools/result`，即工具流水线的只观察阶段：此处的结果已经定型，注册表会把抛错的观察者隔离为一条警告。因此打分不可能改变模型可见的结果、持久化工具日志，或一次调用是否报告成功。

只有同时满足以下条件才会记录：工具名被观察、参数携带非空 `command` 字符串、该命令匹配某个已配置检查，且结果要么是错误结果、要么是前台 shell 值。后台启动（`kind: 'background'`）、其他工具，以及没有归属 agent 的调用都不追加任何记录。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否对 shell 结果打分。 |
| `tools` | `['bash', 'pwsh']` | 被观察的工具名。 |
| `checks` | 内置列表 | 有序的首次匹配即生效的命令规则。 |
| `forbiddenPatterns` | 内置列表 | 在被打分调用上扫描的罚分模式。 |

`Config` schema 在加载时校验部署配置的类型、种类与取值范围。此外还会检查模式源非空且可编译；这条检查是打分编译器唯一新增的失败。

| 检查字段 | 含义 |
|---|---|
| `name` | 记录在审计事件中的唯一标签。 |
| `kind` | `build`、`test` 或 `run`；只有 `test` 解析计数。 |
| `commandPattern` | 针对命令字符串测试的 RegExp 源。 |
| `passedPattern`、`failedPattern` | 从 stdout 提取计数的可选全局 RegExp 源；为空则保留默认提取。 |
| `weight` | 轮次聚合中的相对权重（默认 `1`）。 |

罚分模式包含 `name`、RegExp `pattern`、命中时扣减的 `penalty`（默认 `1`），以及测试位置 `scope`——`command`、`stdout`、`stderr` 或 `any`（默认 `any`）。

内置检查把测试运行器排在构建命令之前，因此 `make test` 永远不会被算作构建。内置罚分模式覆盖对根目录或 home 的破坏性递归删除、强制推送，以及把远端内容直接管道进 shell。

## 打分规则

一次被打分调用在前台进程以 0 退出且未被沙箱拒绝时以 `1` 起步，否则起步为 `0`。`test` 检查在 stdout 既未截断也未落盘时，用 `passed / (passed + failed)` 替换该基线；默认提取读取 `N passed` 与 `N failed` 摘要，在未配置计数模式时回退到 Go 的 `ok`/`FAIL` 包标记，其他种类一律跳过解析。每个命中的罚分模式扣减其罚分，结果被夹到 `[0, 1]`。

错误结果因为没有输出可读，得分为 `0` 且无计数：此时只有命令作用域的罚分模式可能命中。

## 审计事件与聚合

每条记录都是 `reward/check` 会话事件：调用标识、工具、命令、匹配到的检查、退出码、解析出的计数、罚分命中、得分，以及 stdout 与 stderr 的可用性标记。输出文本不会进入事件；截断或落盘的流改为记录 `{ truncated, spillPath? }`。该事件以 `ignorable: true` 追加，因为没有任何 fold 消费它——丢失它不可能改变会话重建。

`computeRoundScore`、`computeFinalScore` 与 `combineScores(verifiable, model, alpha)` 为消费方聚合这些记录：前两者求加权平均与普通平均，`combineScores` 实现 `alpha * verifiable + (1 - alpha) * model`，只有一侧存在时返回存在的那一侧。

## Model Experience

无：观察者不注册任何 prompt、工具或上下文，只追加一条可忽略的审计记录。

#### KV Cache effect

无；观察者不向请求前缀添加任何内容。

## Known Limitations and Deferred Work

- **只用 RegExp 匹配** —— 检查把命令字符串当文本测试；通过脚本、别名或门禁包装器运行测试而不匹配任何已配置模式的调用不会被打分。
- **计数来自打印的摘要** —— stdout 被截断或落盘时跳过测试解析，摘要格式不同的运行器需要配置 `passedPattern`/`failedPattern`；Go 包标记只在未配置计数模式时生效。
- **尚无消费方** —— 目前没有任何东西把这些记录折叠进数据集或训练奖励；聚合辅助函数是为将到来的采样与导出插件准备的。
