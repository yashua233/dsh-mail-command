# 参与

这个插件由一个人维护。先说清楚欢迎什么、不欢迎什么，免得双方白费功夫。

## 欢迎

- **Bug 报告**：附 DSH 版本、插件版本、复现步骤、报错原文，开 issue。
- **文档纠错**：README 哪句说错了、过时了，直接开 issue 指出来，一句话就够。
- **小修补**：typo、明显的边界漏判，可以提 PR。

## 不欢迎

- **大功能改动或重构 PR**。不是不认可，是没精力长期 review 和维护——合并进来就是我要对它负责，而我可能并不认同那个方向。想做大的，自己 fork 一个，MIT 允许。
- **加运行期依赖**。这几个插件都是零依赖，这个约束不会放开。
- **纯格式化 / 重排导致的巨型 diff**。

## 报告安全问题

**不要开公开 issue**。走私密漏洞报告，见 [SECURITY.md](./SECURITY.md)。

## 提 issue 之前先自查

```powershell
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  scripts\selfcheck.mjs
```

13 项离线检查，覆盖口令生成/存活期/同会话复用、指令解析、引用剥离、HTML 清洗、服务商推断。不联网。

再加上这个，看运行时的真实状态：

```
mail_command action=status
```

`lastError` 非空就是它。

## 许可证

提交的代码按 [MIT](./LICENSE) 授权。
