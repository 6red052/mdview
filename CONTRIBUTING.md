# 参与开发

请先阅读 [README](README.md) 的「要求与边界」。本项目的定位是：**在 Windows 上只读地查看 Markdown**。
未实现的功能属于刻意的设计取舍，提交 PR 前请确认方向与该定位一致。

## 本地运行

无需执行 `npm install`：零依赖是硬性要求，`package.json` 中没有运行时依赖。

```powershell
node server.mjs examples\test-fixture.md     # 打开示例文档
npm test                                     # 启动临时服务 → 运行全部回归 → 自动关闭
```

## 提交前检查

1. `npm test` 全部通过（31 项渲染 + 11 项最近打开 + 10 项隐形字符 + 10 项 BOM 链路 + 28 项 XSS fuzz + 30 项安全断言）。
2. 任何行为变化都应附带一条回归用例；修复缺陷时先编写用例，再修改代码。
3. 不要提交 `dist/`、`.build/`、`node_modules/`，也不要提交 `%LOCALAPPDATA%\mdview` 下的运行时文件。
4. `server.mjs` 为单文件，提交前执行 `node --check server.mjs`。

## 代码约定

- **零依赖**：新增运行时依赖的 PR 不予接受，除非有充分理由。
- **单文件**：服务端逻辑保留在 `server.mjs`；前端代码是该文件内的 `String.raw` 字符串。这是「单文件可审计」的代价，不拆分打包。
- **注释说明原因**：`// 这里必须 X` 的价值低于 `// 不 X 会在 Y 情况下导致 Z`。代码中已有较多此类注释，新增代码请保持同等密度。
- **Windows 优先**：路径分隔符、大小写、编码（BOM、GBK、PowerShell 5.1 代码页）都是常见问题来源，修改前请先阅读 [KNOWN-ISSUES.md](KNOWN-ISSUES.md) 的「行为边界」。

## 提交与 PR

- 一个 PR 只做一件事；提交信息使用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀，描述可用中文。
- PR 描述需写明：修改内容、修改原因、验证方式。
- 涉及安全边界的改动（白名单、Host 校验、`/api/*`），请在描述中说明威胁模型。

## 报告问题

功能问题请提交 issue；安全问题请参阅 [SECURITY.md](SECURITY.md)。
