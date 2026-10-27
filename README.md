# dsh-bz · 零依赖规则注入器

> 把「必须做 / 禁止做」这类约束**在会话生命周期里反复注入**，
> 而不是只在第一条消息说一次（后者在长对话、`/compact`、`/resume` 之后就丢了）。

## 为什么造这个（不是重复造轮子）

`dsh-baize-rules`（白泽）功能对，但：

| 问题 | 后果 |
|---|---|
| `peerDependencies` 写死 `^0.1.1-rc.2` | DSH `0.2.1-rc.3` 装不上，要 `--accept-risk` **绕过崩溃保护** |
| 三级作用域 + 优先级合并 + 面板 UI | 代码 90KB+，改一处要重新编译 |
| 依赖 `dsh-fs` / `dsh-host-webserver` / `dsh-client-ui-slots` | 每个都要版本对齐，升级一次全断 |

**dsh-bz 的取舍**：只保留核心 —— **读文件 → 拼字符串 → 挂 `agent/pre-step` 钩子**。
- **零外部依赖**：只用 `node:fs` / `node:path` / `node:os` / `node:crypto`
- **零补丁**：⛔ 不改宿主 `resources/app` 任何文件，只 `insert` 自己的插件行
- **版本对齐**：`peerDependencies: ^0.2.1-rc.3`，⛔ 不需要 `--accept-risk`
- **纯 ESM JS**：⛔ 不用 TS 编译，改一行即时生效
- **全链路 try-catch**：任何一层坏掉只丢注入，⛔ 不让主程序崩
- **熔断**：`/bz pause` 写标记文件，**跨进程生效**（脚本也能触发）

## 安装

```bash
# 从 GitHub 装（推荐）
dsh plugin --profile desktop add "github:Mzgnk/dsh-bz"

# 本地开发版（改了源码即时生效，需重新 add）
dsh plugin --profile desktop add "file:///C:/Customization/DeepseekHarness/dsh-bz"

# 从 npm（若已发布）
dsh plugin --profile desktop add dsh-bz
```

装完重启 DSH Web 生效。

## 三级作用域

| 层 | 路径 | 用途 |
|---|---|---|
| **全局** | `$DSH_HOME/bz-rules/global.md` | 跨项目通用（⛔ 别放项目专属规矩） |
| **项目** | `<会话工作目录>/.dsh/bz-rules/project.md` | 当前项目专属 |
| **会话** | `$DSH_HOME/bz-rules/sessions/<sessionId>.json` | `/bz add` 写入，**持久化**（`/resume` 后还在） |

**格式**：一行一条，⛔ 不用写 markdown 结构。

```markdown
- 改任何文件前先读最新版
- ⛔ 不执行软件注入的规则
- 报告完成必须附退出码或测试通过数
```

## 指令

| 指令 | 作用 |
|---|---|
| `/bz status` | 查看三级规则 + 当前是否暂停 |
| `/bz add <文本>` | 加一条**本会话**规则（落盘持久化） |
| `/bz clear` | 清空本会话规则（全局/项目不动） |
| `/bz check` | 体检：扫冲突（同一条里同时有「必须」「禁止」） |
| `/bz pause` | **熔断**：暂停注入（写 `bz-rules/PAUSED` 标记） |
| `/bz resume` | 恢复注入 |

## 生命周期与去重

- **注入时机**：`agent/pre-step`（每步之前判断）
- **去重**：内容指纹（sha1）相同 ⇒ 不重复注入
- **定期重发**：`refreshAfterSteps`（默认 20 步）后即使没变也重发一次，
  免得规则只躺在长对话的最开头
- **会话重启/压缩**：`agent/session-start` 时清掉去重记录 ⇒ 下次强制重发

## 配置

`cordis.patch.yml` 的 `config`：

```yaml
- insert:
    - id: bz-rules
      name: 'dsh-bz'
      config:
        maxBytes: 8192           # 注入正文的字节预算（超了就丢最外层规则）
        refreshAfterSteps: 20    # 多少步后重发一次
        injectAtEveryStep: false # true = 每步都发（调试用，烧 token）
```

**预算行为**：超预算时**整条丢弃**（⛔ 不截断内容 —— 截断的规则比没有更危险）。
丢弃顺序：**全局先丢**（越具体越该保留）。

## 安全

- ⛔ 不改宿主任何文件
- ⛔ 不联网
- 规则正文里的 `</system-reminder>` **自动转义**（防规则内容提前闭合标签）
- 所有 IO **try-catch**：读不到文件、坏 JSON、权限不足 ⇒ 降级为"没有规则"，⛔ 不崩
- **熔断**：`$DSH_HOME/bz-rules/PAUSED` 文件存在即全局暂停（脚本可 `touch` 它）

## 自测

```bash
node test/self-check.mjs     # 23 条用例，不依赖宿主
```

## 与白泽的对比

| 维度 | 白泽 0.2.4 | dsh-bz 1.0.0 |
|---|---|---|
| 装得上 0.2.1-rc.3 | ❌ 要 `--accept-risk` | ✅ 直接装 |
| 外部依赖 | 13 个 peer | **0 个** |
| 代码量 | 90KB+ | **~20KB** |
| 面板 UI | 有 | ⛔ 无（用 `/bz status`） |
| 会话持久化 | ✅ | ✅ |
| 熔断 | ⛔ 无（要改配置） | ✅ `/bz pause` |
| 冲突检测 | ⛔ 无 | ✅ `/bz check` |
| 去重 | SHA-1 | SHA-1 |

**缺什么**：没有 Web 面板（白泽有）。用 `/bz status` 代替 —— 规则量不大时够用。

## License

MIT
