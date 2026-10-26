# mdview

[![test](https://github.com/6red052/mdview/actions/workflows/test.yml/badge.svg)](https://github.com/6red052/mdview/actions/workflows/test.yml)

零依赖的本地 Markdown 查看器：双击 `.md` 用浏览器打开，排版、代码高亮、目录树、图片全部正常。

> **English** — A zero-dependency, read-only Markdown viewer for Windows. Double-click a `.md`
> file and it renders in your system browser through a throwaway local server on `127.0.0.1`.
> No runtime dependencies, no outbound requests from the server, no writes to your documents.
> Windows 10/11 x64 only (the file association, silent launcher and single-file exe are all
> Windows-specific). MIT licensed.

- **零依赖** — 只用 Node.js 内置模块，`npm install` 什么都不用装，不走 CDN、不请求任何外部服务。
- **纯本机** — 服务只监听 `127.0.0.1`；文件访问走白名单，只允许读你打开过的文件/目录。
- **零常驻** — 所有文档共用**同一个**后台服务（开 100 个 md 也只有 1 个进程）；关掉浏览器标签页约 45 秒后它自己退出，兜底空闲 15 分钟退出。
- **可回滚** — 只改 `HKCU`（当前用户），不需要管理员；卸载脚本按备份还原 `ProgId` 与「打开方式」条目（`UserChoice` 由 Windows 哈希保护，脚本改不了）。

> 完整使用说明与故障排查：[`docs/使用说明与排障.md`](docs/使用说明与排障.md)
> 还知道哪些不足、哪些是故意不做的：[`KNOWN-ISSUES.md`](KNOWN-ISSUES.md)

## 与现有工具的区别

| 方案 | 缺口 |
|---|---|
| Typora / Obsidian | 为了读一个文件装一整套编辑器 |
| VS Code 预览 | 得先开 IDE，还绑着工作区 |
| glow / bat | 终端里读，表格、图片、锚点、目录都不好使 |
| 浏览器插件 | 依赖扩展，还要逐个文件授权 |

mdview 只负责读取，不修改文件。安装后双击 `.md` 即可查看。

## 平台支持

**目前只支持 Windows（64 位），且仅支持 Windows。**

原因是文件关联、无窗口启动器与单文件 exe 打包均为 Windows 专用实现。
Mac / Linux 上能跑起来的部分只有 `node server.mjs <文件>` 这个只读服务，**没有安装体验**。

欢迎提交 PR 补充其它平台支持；当前边界见上。

## 不修改文档

这是本项目的核心取舍：

- **服务端不存在写入用户文档的代码路径**。磁盘写入只发生在两处：`%LOCALAPPDATA%\mdview\`（`server.json` 记端口、`recent.json` 记最近打开、`server.log` 是服务日志）和安装目录（`launcher.log` 启动器日志、安装时的 `assoc-backup.json`）。
- 打开 `.md` 仅执行读取，不会修改、移动或删除。
- 验证方式：打开任意文档，用编辑器修改并保存，刷新页面后可见修改内容，说明读取的是磁盘上的实时内容，没有缓存副本。

## 快速开始

```text
# 安装（不需要管理员权限）
powershell -NoProfile -ExecutionPolicy Bypass -File windows\install.ps1

# 直接打开一个文件
node server.mjs "D:\notes\a.md"

# 浏览一个目录下所有 Markdown
node server.mjs "D:\notes"
```

安装后 Windows 会在「打开方式」里注册 mdview；把 `.md` 的默认程序指过去，双击即可查看。

## 命令行

```
mdview <文件.md>       打开文档（必要时自动起服务）
mdview <文件夹>        浏览该文件夹下所有 Markdown
mdview serve           前台运行服务（调试用）
mdview status          查看是否在运行、端口与 PID
mdview stop            停止后台服务
```

## 界面

**默认为专注模式**：不显示侧栏，双击文件即打开。按 `Ctrl+B` 切换到浏览模式后，左侧显示目录树。

切换文档可使用标题栏的 **「打开 ▾」**（`Ctrl+O`），其中包含**最近打开**列表，无需逐级浏览目录。

| 快捷键 | 作用 |
|---|---|
| `Ctrl+E` | 源码 / 预览切换 |
| `Ctrl+B` | 专注模式 / 浏览模式切换（侧栏） |
| `Ctrl+T` | 大纲（跟随滚动高亮） |
| `Ctrl+D` | 深色 / 浅色（默认跟随系统） |
| `Ctrl+F` | 聚焦侧栏筛选框 |
| `Ctrl+O` | 打开「最近打开 / 打开文件」下拉 |
| `Ctrl+P` | 打印 / 导出 PDF |

代码块右上角可一键复制；文档之间的相对链接可直接跳转；图片、锚点、GFM 表格与任务列表均支持。

## 安装参数

```text
-InstallDir 'D:\tools\mdview'   换安装位置（默认 %LOCALAPPDATA%\mdview）
-Default                        额外弹出「打开方式」让你设为默认
-AddPath                        把安装目录加入用户 Path，之后可直接敲 mdview
-Ext '.md','.markdown'          只接管指定扩展名
-Quiet                          静默
-Remove                         卸载（保留文件）
```

## 两种形态

| 形态 | Node 需求 | 适用场景 |
|---|---|---|
| **源码版** | 需要（Node 20+） | 自己用、想改代码、想看实现 |
| **单文件版** `mdview.exe` | **不需要** | 发给别人用；下载解压、跑一次安装脚本即可 |

### 打包单文件版

```text
# 1) 取一份支持 --build-sea 的官方 Node 作为构建基线（不覆盖你系统里的 Node）
npm install node@26 --no-save --prefix .build/nodebin

# 2) 打包
node tools/build-exe.mjs
```

产物在 `dist/`：`mdview.exe`（约 95 MB，内含运行时）、无窗口启动器、一键安装脚本，
以及可以直接发给别人的 `mdview-portable-<版本>.zip`（约 37 MB）。

接收方解压 zip 后，右键以 PowerShell 运行 `portable-install.ps1`，之后双击任意 `.md` 即可。
全程不需要 Node、不需要联网、不需要管理员权限。

> 打包需要 Node **25.5+**（官方 `--build-sea`）。运行 mdview 本身需要 Node 20+（Node 18 已 EOL，CI 只测 20/22/24）。

## 安装脚本到底改了什么（注册表）

文件关联依赖注册表。以下列出脚本写入的位置，可据此决定是否运行。

**只写 `HKCU`（当前用户），不碰 `HKLM`，不需要管理员权限。**

| 写在哪 | 干什么 | 怎么撤销 |
|---|---|---|
| `HKCU\Software\Classes\mdview.md` | 登记一个"程序 ID"，指向 `mdview.exe` 或它的无窗口启动器 | 删除该键 |
| `HKCU\...\FileExts\.md\OpenWithProgids` | 让 mdview 出现在右键「打开方式」里 | 删除其中的 `mdview.md` 值 |
| `HKCU\...\FileExts\.md` 的 `ProgId` | 把 `.md` 的默认程序设为 mdview，**只在原本没有默认程序时才写** | 删除该值 |
| 用户 `Path`（可选） | 仅在你主动加 `-AddPath` 时追加安装目录 | 从 Path 中移除 |

补充说明：

- 脚本不会取代其它程序的默认地位：写入 `ProgId` 前会同时检查「已有的 per-user ProgId」「UserChoice」「`HKCU\Software\Classes\<ext>` 默认值」，任一存在时只添加「打开方式」，不修改默认项。
- 修改前会把原关联状态备份到**安装目录**下的 `assoc-backup.json`（默认为 `%LOCALAPPDATA%\mdview`；使用 `-InstallDir` 更换位置时备份随之移动，卸载需传入同一路径）。
- `install.ps1 -Remove` 会按备份还原 `ProgId` 与「打开方式」条目，删除 mdview 自身的注册表键，并提示删除目录。
  **`UserChoice` 无法由脚本还原**：它是 Windows 以哈希保护的实际默认程序，只能在系统界面中修改。
- **不希望修改注册表：** 可以不运行安装脚本，直接执行 `node server.mjs 某文件.md`，或将文件拖到 `mdview.exe` 上。

## 安全设计

概括：**只读、只在本机、不主动请求外网。**

- 服务绑定 `127.0.0.1`，不监听外部接口；断网后功能不受影响，服务本身不依赖外网。
- 所有文件读取都检查白名单，未打开过的路径一律 `403`。白名单判断会先解开 junction / 符号链接再比一次，避免通过链接把读取范围扩大到白名单目录之外。
- **没有写入文档的接口**：不存在 `/api/save` 之类的端点，服务端无法修改文档。
- 磁盘写入分两处：**数据目录** `%LOCALAPPDATA%\mdview\`（`server.json` 记端口、`recent.json` 记最近打开、`server.log` 服务日志）和**安装目录**（`launcher.log` 启动器日志、安装时的 `assoc-backup.json` 备份）。使用 `-InstallDir` 更换安装位置时，数据目录仍位于 `%LOCALAPPDATA%\mdview\`。**均不影响文档内容**。
- 文档里指向本地文件的链接，只有图片 / 媒体 / PDF / 压缩包 / 文本这些类型会交给系统默认程序打开；`.exe`、`.lnk`、`.bat`、`.hta`，以及 SVG（本质是可执行的活动内容）一律拒绝。
- 图片等附件走 `/asset`，需要每个进程随机生成的令牌；只有图片、音视频和 PDF 会内联返回，其余类型强制下载（`application/octet-stream` + `attachment`），并且所有附件响应都带 `CSP: sandbox`，直接打开时不会执行脚本。
- 文档里的原始 HTML 按字面转义显示，不执行；`javascript:` / `data:` 链接被丢弃。

跨源网页访问的隔离措施，以及不在防护范围内的情形，见 [SECURITY.md](SECURITY.md)。

### 本地验证命令

```text
# 1. 断网后打开文档，功能应完全正常
# 2. 确认服务只在回环地址监听
netstat -ano | findstr ":7717"   # 端口被占时会顺延；实际端口见 %LOCALAPPDATA%\mdview\server.json
# 3. 确认没有写接口（应返回 404）
curl.exe -X POST http://127.0.0.1:7717/api/save
# 4. 伪造 Host 应被拒绝（应返回 403）
curl.exe -H "Host: evil.example" http://127.0.0.1:7717/health
# 5. 白名单外的路径应被拒绝（应返回 403）
curl.exe "http://127.0.0.1:7717/api/file?f=C:/Windows/win.ini"
```

## 目录结构

```
mdview/
├─ server.mjs                    单文件服务端 + CLI（零依赖）
├─ mdview-launch.cmd             终端启动脚本
├─ mdview-silent.vbs             文件关联调用的无窗口启动器
├─ windows/install.ps1           源码版安装 / 卸载（HKCU，无需管理员）
├─ windows/portable-install.ps1  单文件版安装 / 卸载（纯 ASCII，任何代码页可读）
├─ tools/build-exe.mjs           打包单文件 exe（--build-sea）
├─ tools/run-tests.mjs           一条命令运行全部回归
├─ tools/render-check.mjs        渲染回归（31 项断言，跑的是真实发出去的脚本）
├─ tools/bom-repro.mjs           隐形字符（BOM 等）回归
├─ tools/bom-e2e-check.mjs       带 BOM 文件走完整服务链路的回归（E16）
├─ tools/recents-check.mjs       专注模式 / 最近打开回归
├─ tools/xss-fuzz.mjs            25 组攻击性输入的 XSS 回归（28 项断言）
├─ tools/security-check.mjs      安全回归（Host / 类型白名单 / 状态端点 / /asset / junction / 仓库卫生）
├─ tools/tab-exit-check.mjs      关闭标签页后的自动退出（约 60 秒）
├─ tools/lib/template.mjs        从 server.mjs 抠内嵌脚本的公共实现
├─ tools/dev/                    排障用的一次性脚本（不参与 CI）
├─ docs/使用说明与排障.md         详细文档
├─ examples/                     示例文档（含一个带 BOM 的样本）
├─ CHANGELOG.md / CONTRIBUTING.md / SECURITY.md / KNOWN-ISSUES.md
└─ package.json
```

## 回归测试

```text
npm test          # 启动临时服务 → 渲染 / 最近打开 / 隐形字符 / XSS fuzz / 安全 → 自动关闭
npm run test:exit # 额外验证「关闭标签页约 45 秒后服务自动退出」（约一分钟）
```

也可单独运行其中一组：

```text
node server.mjs serve --port 7799 examples\test-fixture.md
node tools\render-check.mjs 7799
node tools\recents-check.mjs 7799
node tools\bom-repro.mjs
node tools\xss-fuzz.mjs
node tools\security-check.mjs 7799
```

CI 在 GitHub Actions 的 `windows-latest` 上跑 Node 20 / 22 / 24。

## 要求与边界

- **平台：仅 Windows 64 位**（见上文「平台支持」）。
- 需要 Node.js 20+（单文件版不需要）。
- 单个文本文件上限 8 MB；非 UTF-8 会尝试按 GBK 解码。
- **本地解析器**：Markdown 解析是手写的（约 500 行），覆盖常见语法，但不是完整 CommonMark。边缘语法（脚注、定义列表、复杂嵌套）可能不如成熟库稳定。
- **不提供编辑**：编辑功能不属于本项目定位。修改文档请使用编辑器；mdview 的价值在于
  「只读」这一安全约束，不会为实现编辑功能而放弃它。
- 未实现 Mermaid、LaTeX 公式、内嵌 iframe（保持零依赖的代价）。
- 服务**不提供认证**：假定能访问 `127.0.0.1` 的即本机用户。多用户机器与远程桌面场景下
  需自行评估（见 [SECURITY.md](SECURITY.md)）。
- 行为边界、设计取舍与尚未验证的内容，见 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
