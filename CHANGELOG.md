# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [未发布]

### 安全

- `/api/open` 只允许打开图片 / 媒体 / PDF / 压缩包 / 文本，`.exe`、`.lnk`、`.bat`、`.hta`、`.svg`
  等一律拒绝。此前文档中的普通链接即可让系统默认程序执行这些文件。
- `/asset` 只有图片 / 音视频 / PDF 会内联返回，其余强制 `application/octet-stream` +
  `Content-Disposition: attachment`，并给所有附件响应加 `CSP: sandbox`。此前本地 `.html` /
  `.svg` 被直接导航时会在 `127.0.0.1` 这个源里执行，可再调 `/api/open` 扩大白名单。
- 白名单判断增加真实路径校验：junction / 符号链接解析后再比一次，不能再越界读白名单外的文件。
- 文档里指向目录的链接（`from=link`）不再扩大白名单，只有对话框 / CLI 主动打开目录才会。
- 缺少 `Host` 请求头的请求也拒绝（原先放行）。
- `/api/session`、`/api/keepalive`、`/api/bye` 都要求 `X-Mdview` 头（原先任意网页都能改标签页
  计数、影响自动退出的时机）。卸载时的通知改用 `fetch(..., {keepalive:true})` 发送，
  不再用 `sendBeacon`（beacon 加不了自定义头）。
- 只有带自定义头的请求才算"活动"，跨源页面无法靠轮询 `/health` 或 `/api/session` 拖住自动退出。
- `GET /api/file` 只在带自定义头（页面自己发起）时记录「最近打开」，跨源页面写不进历史。
- 删掉 `POST /api/recents`（客户端从未使用），减少一个可写状态的入口；现在只支持 `GET`。
- 高亮器的函数名规则加上界，修复 199k 字符代码块导致页面冻结约 69 秒的问题（现在约 160ms）。

### 修复

- 文档里的绝对路径链接（`[x](C:\a.pdf)`）以前生成 `file://`，而现代浏览器禁止从 http 页面
  跳转过去，点了没反应；现在改走 `/api/open`，和其他本地链接同一套类型白名单。
- `file://` 链接被双重转义：路径含 `&` 时 `href` 会变成 `file://C:/a&amp;b.pdf`。
- `Range: bytes=-N`（"最后 N 字节"）被当成 `0-N` 解析，音视频拖进度条会拿到错的分片。
- 块级解析没有递归深度上限：8000 层引用会抛 `RangeError` 导致白屏；现在超过 32 层
  把剩余内容按字面显示。
- `.cmd` 启动器在非 ASCII 路径（如 `C:\Users\张三\`）下失效：`mdview-node.txt` 原先用
  ASCII 写入，非 ASCII 字符变成 `?`；改用系统 OEM 代码页。
- 非 UTF-8 文件会"越换越乱"：GBK 解码后若替换字符反而更多，现在保留 UTF-8 原文。
- 目录太大被截断时界面没有任何提示；现在侧栏会显示"只列出了前一部分"。
- `mdview-silent.vbs` 对盘根（`D:\`）不剥尾反斜杠，会让命令行引号闭合错位。
- `process.isSea` 在 Node 24 上是 `undefined`，SEA 分支永远走不到；改用 `node:sea` 的 `isSea()`。
- `package.json` 同时有 `private: true` 和 `bin`，语义冲突；去掉 `bin`。

### 工程

- 新增 `tools/check/security.mjs`（30 项断言）并接入 `npm test` 与 CI：Host 校验、打开类型
  白名单、状态变更端点（session / keepalive / bye）、`/asset` 响应头、目录链接、junction
  越界，以及 `install.ps1` 必须带 UTF-8 BOM、`portable-install.ps1` 必须纯 ASCII
  （这两项此前出现过静默回归）。
- 新增 `tools/check/xss-fuzz.mjs`（25 组攻击性输入 + 3 条正常性断言）：不是抓关键字，而是解析产出
  的标签与属性，断言没有 script/iframe/object 且 href/src 不是危险协议（`file:` 也一并丢弃）。
- 目录树遍历加上限（6000 条目 / 20000 目录项 / 8 秒），超大目录或 junction 不再卡住几十秒。
- 清理死代码：`fileToken`、`rotateTokens()`、`taskFirst`、不可达的 `data:image` 分支、
  `allow()` 的 `recursive` 参数、`readJsonBody()`。
- `grabTemplate` 抽到 `tools/lib/template.mjs`，三个脚本共用，不再各存一份。
- 便携版 zip 补上 `mdview-silent.vbs`（此前遗漏，安装后会退化为短暂的黑色窗口）；zip 清单缺文件改为直接失败。
- 安装脚本在写 per-user `ProgId` 前，同时检查已有的 `FileExts\ProgId`、`UserChoice` 和
  `HKCU\Software\Classes\<ext>` 默认值，不再可能在已有默认程序时抢默认。
- 安装脚本会一并复制 SECURITY、KNOWN-ISSUES、CHANGELOG、CONTRIBUTING、LICENSE
  （安装后 README 里的链接不再断），不再安装无用的 `portable-install.ps1`；
  停止正在运行的服务时会给出提示。
- 移除 `docs/使用说明与排障.md`；其中的故障排查内容改由 GitHub issue 与 KNOWN-ISSUES 承接。
- Node 版本要求提到 20+（18 已 EOL，CI 只覆盖 20/22/24）。
- 测试子套件加 180 秒超时，避免 BOM 那种死循环把 CI 拖到 job 上限。

## [1.0.0] — 2026-10-17

首个公开版本。

### 功能

- 双击 `.md` 用系统浏览器打开，零依赖、零联网、只监听 `127.0.0.1`。
- 单个后台服务服务所有文档；关掉浏览器标签页约 45 秒后自动退出，兜底空闲 15 分钟退出。
- 目录树、大纲（跟随滚动高亮）、最近打开、源码 / 预览切换、深浅色、打印 / 导出 PDF。
- 离线语法高亮（JS/TS/Python/Go/Rust/Java/C/SQL/Shell/HTML/CSS/JSON/Markdown）。
- 手写 Markdown 解析器：标题、列表（含嵌套与任务列表）、表格（含对齐）、引用、代码围栏、
  链接 / 图片 / 锚点、GFM 删除线与 `==高亮==`。
- 单文件 exe（`--build-sea`）打包，对方不需要安装 Node。
- 安装 / 卸载只改 `HKCU`，关联有备份可回滚。

### 安全

- `/view?f=` 不再把 URL 中的路径加入白名单；白名单只能由 `/api/open` 扩展。
- 增加 `Host` 校验，挡住 DNS rebinding。
- `/api/open`、`/api/shutdown` 要求 `X-Mdview: 1` 请求头，挡住跨源 CSRF。
- 打开外部文件改用 `rundll32 url.dll,FileProtocolHandler`，不再经过 `cmd /c start`，
  路径里的 `&` 不再被解释成命令分隔符。
- HTML 响应增加 `Content-Security-Policy`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。

### 修复

- 源码版安装脚本的自检步骤从未真正启动查看器，导致每次安装都误报"服务未启动"。
- 单文件版的 `使用说明.txt` 用 ASCII 写入中文，产物是乱码；改为 UTF-8 + BOM。
- `/?dir=` 参数此前无人读取，刷新或复用服务时目录树会退回第一个根目录。
- 文档里一个畸形百分号转义（如 `a%ZZ.md`）会让整篇报"打不开这个文件"。
- `/api/shutdown` 退出时未清理 `server.json`，会留下"状态文件存在但服务未响应"。

### 工程

- 新增 `npm test`：自动起临时服务、跑完渲染 / 最近打开 / 隐形字符回归、再自动收服务。
- 新增 GitHub Actions（`windows-latest`，Node 20 / 22 / 24）。
- 文档里的本机绝对路径全部改成可移植写法。
