# dsh-mail-command

用邮件指挥 DeepSeek Harness：回复一封通知邮件，就能让正在跑的任务**继续**或**停止**，正文可以写具体要求。

它是 [dsh-qq-mail-notify](https://github.com/yashua233/dsh-qq-mail-notify) 的附属插件——那个负责发信，这个负责收信。**必须两个都装**；原因和两者的实际关系只在下面的「前置要求」里说一次，别处不再复述。

## 前置要求

**本插件必须搭配 [dsh-qq-mail-notify](https://github.com/yashua233/dsh-qq-mail-notify) 一起使用，单独装它没有任何效果。**

原因很直接：它自己不发送任何邮件。一次性口令是随**通知邮件**一起发出去的，你回复的也是那封邮件。没有发信侧，你的收件箱里就不会出现带口令的邮件，也就没有东西可以回复，整个功能等于不存在。

依赖是**一边倒**的：通知插件可以单独用（纯提醒，不装本插件也完整）；本插件单独装则完全空转。代码上两者互不 `import`、走 cordis 服务协作，所以升级其中一个不必同步另一个——但功能上本插件离不开通知插件。

正确用法是两个都装：

```bash
dsh plugin --profile desktop add github:yashua233/dsh-qq-mail-notify
dsh plugin --profile desktop add github:yashua233/dsh-mail-command
```

装好后在通知插件的设置里填好发件邮箱与 SMTP 授权码（本插件复用同一份凭据），发一封测试邮件确认能收到，再回复它试试。
## 它解决什么问题

任务跑到一半因为额度不足停住，你充完钱还得回到电脑前重新说一遍；或者一个任务明显跑偏了，你只能等它结束。装上这个插件之后：

- 通知邮件里带上一次性口令；
- 你直接在手机上回复那封邮件，写「继续」，任务接着跑；
- 写「停止」，当前这一轮立刻中断；
- 写「继续，但把测试也跑一遍」，这句话原样成为给 agent 的新输入。

## 安装

```bash
# 从 GitHub
dsh plugin --profile desktop add github:yashua233/dsh-mail-command

# 本地目录
dsh plugin --profile desktop add link:/path/to/dsh-mail-command
```

`desktop` 是桌面端默认的 profile 名，用你自己的那个（`~/.dsh/profiles/` 下能看到的目录名）。装完重启一次生效。

**建议与通知插件一起装**：

```bash
dsh plugin --profile desktop add github:yashua233/dsh-qq-mail-notify
```

## 怎么用

1. 装好并重启，确认 `dsh-qq-mail-notify` 已经配好发件邮箱和 SMTP 授权码（同一套凭据本插件复用）；
2. 之后每次通知邮件末尾都会附上：

   ```
   可用指令（直接回复本邮件，保留主题里的 [CONT:AB12CD34]）：
     · 继续 —— 正文写要继续做的事；只写「继续」就按原计划接着干
     · 停止 —— 正文写「停止」或 stop，立刻中断当前这一轮
   ```

3. 回复那封邮件即可。**主题里的口令要保留**（邮件客户端默认会保留），正文写你要它做什么。

## 指令怎么判定

| 你回的正文 | 结果 |
| --- | --- |
| 空 | 按原计划继续 |
| `继续` | 继续 |
| `停止` / `stop` / `取消` | 停止当前轮 |
| `停止，剩下的别改了` | 停止（后半句记进日志） |
| `继续，但把测试也跑一遍` | 继续，要求 = 整句原文 |
| `把 README 补完再提交` | 继续，要求 = 这句 |

引用区（`>` 开头的行、`-----原始邮件-----` 之后的内容）会自动剥掉，不会被当成指令的一部分。

### 收件节奏（三段自适应）

刚发出通知时你最可能就在手机旁边，所以前 10 分钟查得勤；越往后越稀疏；超过 30 分钟基本不会回了，干脆停下，等下一封邮件发出时再被唤醒。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `fastWindowMs` | `600000` | 快速窗口长度（10 分钟） |
| `fastIntervalMs` | `5000` | 快速窗口内每隔多久查一次（5 秒） |
| `slowIntervalMs` | `600000` | 超过快速窗口后每隔多久查一次（10 分钟） |
| `stopAfterMs` | `1800000` | 超过这个时间就暂停检测（30 分钟），新邮件发出时自动唤醒 |

想更快可以调小 `fastIntervalMs`（比如 2000），但 QQ 邮箱有 IMAP 频率限制，设太小会被重连。`mail_command action=status` 会告诉你当前处于哪一档。

## 安全设计

**为什么必须带口令**：SMTP 的发件人地址是可以伪造的。如果只按 `From` 判断，任何知道你邮箱的人伪造一封「继续」就能让 agent 跑起来——而 agent 有完全的文件权限。所以：

- 口令随邮件主题发出，长度 8 位、一次性、命中即作废；
- **同一个对话共用一个口令**：只要那串还没被回复过，后续通知继续复用它，所以同一会话的邮件里带的是同一个口令；
- 口令存活 **30 分钟**（`tokenTtlMs`），并且**每发一封通知就重新计时**——回复最近收到的那封一定来得及；
- 校验顺序是「发件人必须在允许列表内」**且**「口令存在、未被用过、未过期」，三条同时成立才动作；
- 口令落盘（`$DSH_HOME/mail-command-tokens.json`），DSH 重启后仍可用，不必重新发信。

## 配置

复用发件插件的凭据，不需要重复填。自己的可选项写在 `$DSH_HOME/mail-command.json`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后不再轮询收件 |
| `intervalMs` | — | **已废弃，改它没有任何效果**：留着只为兼容旧配置文件。实际节奏看下面的 `fastIntervalMs` / `slowIntervalMs` / `stopAfterMs`，默认 30 秒的快速档 |
| `host` / `port` | `imap.qq.com` / `993` | IMAP 服务器，端口即隐式 TLS。不填时按 `user` 的域名自动推断服务商（QQ / 腾讯企业邮 / 163 / 126 / yeah / Gmail / Outlook），认不出的域名保持 QQ 默认 |
| `tokenTtlMs` | `1800000` | 口令存活期（30 分钟）。每发一封通知都会把计时重置，所以「回复最近那封」总是有效 |
| `user` / `authCode` | 取自通知插件 | 想用另一个邮箱收信时才需要填 |

邮箱凭据默认从 `$DSH_HOME/qq-mail-notify.json` 读；单独配了 `user` / `authCode` 就以自己的为准。服务商同上：主机没配过时按邮箱域名推断，QQ 是默认，认不出的域名不猜。

## 它是怎么让任务继续的

DSH 的 agent 有一个待处理队列：`next-turn` 是「等下一轮处理」的输入，`next-step` 是「等下一个步骤」的输入。往 `next-turn` 追加一条消息再唤醒驱动，效果等同于用户在界面里发了这条消息。

停止走的是 `agent.cancel()`：清空待处理队列 + 中止当前 turn 的 AbortController，和你在界面上点停止是同一条路径。

这两处用的是 DSH 内部结构（不是公开 API），所以我把它单独做成插件——将来宿主换了实现，只需要更新这一个插件，不影响通知那一半。

## 和通知插件的关系

```
dsh-qq-mail-notify  ──发信──▶  你的邮箱
       │                        │
       │ issueToken(sessionId)  │ 你回复
       ▼                        ▼
dsh-mail-command    ◀────── 收信、校验口令、注入指令
```

通知插件通过 cordis 服务 `mailCommand` 拿到口令；取不到服务时它照常发信，只是邮件里没有口令，回复也就不触发任何动作。两个插件谁都不 import 对方。

## 兼容性

- **只声明实测过的那个版本：`0.2.1-rc.5`**。`package.json` 里 `dshTarget` 和 `dsh.compatibility.dsh` 都是它，没有范围。
- 为什么不写成 `>=x <y`：DSH 还在开发者预览，官方明确说会有破坏性变更，**跨一个小版本（0.2.1 → 0.2.2）就可能装不上或行为不对**。写范围等于替你赌那些版本，我不赌。
- 想装在别的版本上：把 `dsh.compatibility.dsh` 改成你手上的版本再试。能跑是运气，跑不动是常态——反馈时请带上版本号。

## 遇到问题

按这个顺序自查，基本能自己定位：

```powershell
# 1. 看收件状态：开关、IMAP 地址、待用口令数、最近一次错误
mail_command action=status

# 2. 不想等轮询，立刻拉一次收件箱
mail_command action=check

# 3. 纯逻辑自检（口令、指令解析、引用剥离、服务商推断），不联网
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  scripts\selfcheck.mjs
```

`status` 里的 `lastError` 非空就是它，直接看那一行；`待用口令` 一直是 0，说明发信侧没取到 `mailCommand` 服务——先确认通知插件也装了、且版本没落后。

还是不行就提 issue：<https://github.com/yashua233/dsh-mail-command/issues>。走 issue 而不是私信，后面遇到同样问题的人能搜到。

带上这几样，能省好几轮来回：

- DSH 版本；本插件版本（`package.json` 的 `version`）；
- `mail_command action=status` 的完整输出（口令是打码的，可以贴）；
- 你回复的那封邮件主题里 `[CONT:xxxxxxxx]` 那一段（口令本身不用给）；
- 报错原文或截图，以及「你做了什么、期望什么、实际是什么」。

**授权码、完整邮箱地址、token 请先打码**。

## 审批回信（配合通知插件，默认关闭）

除了「继续 / 停止」，它还能回答「工具在等你授权」：

- 通知插件里打开 `approvalMailEnabled` 后，审批请求会发一封**带独立口令**的邮件；
- 回信只认同向表态：`允许` / `同意` / `ok` / `1` → 这次放行；`拒绝` / `no` / `2` → 这次拒绝；
- **认不出来按「没回」处理**——继续等，超时后把决定权交回界面。这里刻意不猜：审批放行的是有副作用的操作，猜错代价太大；
- 审批口令和「继续」口令存在两张独立的表里，同一个会话可以各有一个，不会串味（不会出现「回一封同意被当成继续干活」）；
- 等待上限不超过口令存活期（30 分钟）。

超时、请求被中止、回信看不懂时，本插件不替任何人做决定，一律交回界面。

## 相关插件

- [dsh-qq-mail-notify](https://github.com/yashua233/dsh-qq-mail-notify) — **必需**。它负责发信并把口令挂在邮件里，本插件才有东西可以回复。单独装本插件等于空转。
- [dsh-restart-yashua](https://github.com/yashua233/dsh-restart-yashua) — 可选。侧栏一个「重启 Harness」按钮，改完配置点一下生效。口令是落盘的，重启后旧口令仍然有效，不必重新发信。

三个插件互不 `import`，都靠 cordis 服务协作，可以任意组合安装；唯一的功能依赖是「本插件需要通知插件在场」。

## 隐私

不联网（除了连你自己的 IMAP 服务器），不收集任何数据。邮件原文不落盘，解析完即丢；口令与它对应的会话 id 记在 `$DSH_HOME/mail-command-tokens.json`（明文、仅本机、30 分钟后自动作废），除此之外不保留任何邮件内容。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
