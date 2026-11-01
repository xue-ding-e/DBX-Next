# 跨仓库自更新与签名发布通用手册

这份手册用于桌面应用、命令行工具、Electron/Tauri 应用、原生安装包和内部软件。它把“能下载更新”和“能安全安装更新”拆成独立问题，并给出自签、平台签名、unsigned 本地包、对象存储更新源和上游分支隔离的共同做法。

## 先区分四层

自更新经常被误认为只有一个 `latest.json`。实际至少有四层：

| 层 | 要回答的问题 | 常见实现 |
| --- | --- | --- |
| 发现 | 应用从哪里知道有新版本？ | GitHub Releases、对象存储、COS/S3、自己的 API |
| 下载 | 安装包如何到达客户端？ | HTTPS、CDN、代理、断点下载、镜像 |
| 完整性 | 下载的字节是否被截断或替换？ | SHA-256、长度、内容类型、版本和文件名校验 |
| 来源认证 | 这些字节是否由项目发布者批准？ | updater 签名、公钥 pin、平台代码签名、受控发布服务 |

HTTPS 只保护传输路径和证书对应的域名，不能单独证明对象存储中的文件是项目维护者批准的版本。SHA-256 能发现文件变化，但如果校验值和安装包来自同一个未认证来源，攻击者可以同时替换两者。真正的更新认证需要独立信任根，例如应用内置的公钥、平台签名证书或受保护的发布服务。

平台代码签名和 updater 签名也不是同一个东西：

- Windows Authenticode、macOS Developer ID/Notarization 主要解决操作系统是否信任安装器或可执行文件。
- Tauri updater、Electron 自定义 updater 或应用自己的 manifest 签名主要解决“应用下载后是否接受这次更新”。
- 一个应用可以同时需要两者，也可以只在内部 unsigned 测试渠道使用 updater 签名而跳过平台签名。

## 签名不是唯一形态，但要明确安全等级

### 自签更新（推荐生产渠道）

项目自己生成一对密钥：公钥编入应用，私钥只存在 CI Secret、HSM 或受控签名服务中。发布时用私钥签 manifest/安装包，客户端只接受匹配公钥的更新。

优点是和 GitHub、COS、S3、CDN 解耦；迁移下载源时不用更换客户端信任模型。缺点是私钥丢失会导致无法发布新版本，公钥轮换需要兼容旧客户端。

最低要求：

1. 私钥不进 Git、不写日志、不放在应用安装目录。
2. 公钥固定在发布版本中，更新 manifest 不能自行改变它。
3. 私钥使用 CI Secret 或外部签名服务；构建机只短暂读取，发布结束清理临时文件。
4. 记录公钥指纹、版本、发布提交和产物 SHA-256，但不要记录私钥或密码。

### 平台/服务商签名

可以使用 Authenticode、Developer ID、云签名或 VSign 一类服务。它们适合解决“系统弹窗信任”和企业发布合规，不能自动替代应用自己的 updater 公钥校验。

例如 DSH NEXT 的实际模式是：本地 unsigned 包用于开发和 updater qualification，正式 Windows 包通过受控签名阶段处理证书和签名缓存；上传阶段再把已验证的产物发布到固定下载源。这种分层比让每个开发者机器持有生产证书更安全。

### unsigned 本地/测试渠道

unsigned 不是“错误”，但必须明确它的边界：

- 只允许 `local`、`nightly` 或内部测试源。
- 更新源使用独立域名、对象前缀或 release channel。
- UI 明确显示“测试包/未签名包”，不能把它当生产更新。
- 测试 updater 可以使用本地 HTTP fixture、临时目录和随机字节；测试不得读取生产配置或执行真实安装器。
- 生产渠道仍要求应用签名或受控平台签名。

### 仅 HTTPS + hash

这适合低风险内部工具或已有可信分发网络的场景。它提供传输完整性和截断检测，但不能独立证明发布者身份。使用时应把 manifest 放在独立权限控制下，并记录风险接受范围；不要把它描述成等同于数字签名。

## 密钥生命周期

### 生成和保存

在项目初始化时生成专用 updater key，不要复用 SSH、TLS、数据库或用户配置密钥。私钥保存位置应满足：

- CI：Secret/Key Vault/HSM；通过环境变量或临时文件注入。
- 本地开发：只生成测试 key，放在用户私有目录并加入 Git ignore。
- 生产发布：由受控签名服务完成，构建机不持久化私钥。

公钥指纹应写入发布记录。不要把私钥、私钥密码、完整环境变量或带凭据的代理 URL 写进日志。

### 轮换和丢失

公钥一旦编入已发布客户端，不能直接替换成新公钥，否则旧客户端会拒绝所有更新。轮换应采用以下之一：

- 在旧客户端中预置新旧两个公钥，发布一版过渡版本，再移除旧 key。
- 使用一个长期根 key 签短期 release key。
- 把信任根放在企业管理策略中，允许受控轮换。

私钥丢失时，先停止发布并确认旧客户端仍可运行，再决定发布带新公钥的迁移版本、提供一次性手动安装器，或保留旧渠道直到迁移完成。不要生成新 key 后直接覆盖配置并声称旧客户端可自动更新。

## 更新源和分支必须分开

`main`、`upstream-main`、`release tag` 和 `latest.json` 的职责不同：

- `upstream-main` 只跟踪官方上游，用于审查、同步和产生上游 PR。
- 自有 `main` 保存下游功能、品牌和发布配置。
- Release tag 必须来自已验证的自有 main 提交。
- `latest.json` 只列出自有 release 资产，不应回退到上游 release。

上游 PR 不应带入自有 updater endpoint、品牌链接、签名公钥、发行版工作流或自有发布脚本。推荐用路径排除脚本生成 upstream-only patch，并在干净工作树上执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\prepare-upstream-pr.ps1 `
  -BaseRef upstream-main `
  -HeadRef main `
  -OutputPath "$env:TEMP\upstream-only.patch"
```

脚本应排除至少这些类别：应用 updater 实现、Tauri/Electron updater 配置、release URL、更新器测试断言、签名/发布脚本和自有品牌链接。排除清单应通过代码审查维护，不要靠人工每次记忆。

## 发布前置检查

每次构建 Release 前，按顺序验证：

1. 当前提交属于自有 `main`，工作树干净，提交 ID 已记录。
2. 版本号、release tag、manifest 版本和安装包版本一致。
3. 更新端点全部属于自有仓库/对象前缀，不能混入官方 fallback。
4. 应用内置公钥不是上游公钥，且发布环境存在对应私钥或签名服务授权。
5. 每个资产都有长度、SHA-256、签名和目标平台记录。
6. `latest.json` 只引用已上传且可下载的资产；不要先发布 manifest 再上传文件。
7. 测试渠道和生产渠道使用不同前缀、bucket 或 release channel。
8. 发布后从干净临时目录执行一次真实 feed 检查、下载、校验和版本比较。
9. 先验证一台 canary，再扩大更新范围；失败时保留旧版本和回滚入口。

## 本地 updater 验证

本地验证不应直接运行生产安装器。使用临时目录和本地 HTTP fixture，覆盖：

- 同版本和旧版本不更新。
- feed 404、408、超时和无效 manifest。
- 下载中断、部分文件、磁盘空间不足。
- hash/signature 不匹配。
- 新版本下载后只进入 ready 状态，必须显式安装。
- 安装前活动任务、未保存内容和进程退出失败。
- 更新源相同但版本变化时能重新检查。
- 测试不会写入真实用户 data、配置数据库或生产缓存。

DSH NEXT 的 `test:updates:local` 是可复用的结构：它启动一个隔离 Electron 进程，使用本地 fixture server，禁止执行真实安装器，并输出独立的 JSON/截图证据。DBX 也应保留同样的“本地 fixture + 隔离目录 + 不执行真实安装器”边界。

## 代理和更新下载

代理属于传输层，不要把代理配置和 SSH 跳板配置混为一谈：

- xenterm 动态隧道提供本机 SOCKS5 listener，例如 `127.0.0.1:1080`。
- 应用连接配置可以按连接填写 SOCKS5/HTTP CONNECT，只有选中的连接经过代理。
- 更新器下载代理应单独读取受控的 HTTP(S) proxy 环境变量或应用设置；不能把数据库连接的代理自动变成全局代理。
- loopback、内网地址和 `NO_PROXY` 规则要明确；不要为了“能更新”把所有请求强制走代理。
- 带密码的代理 URL 不得回显到错误、日志、release 记录或测试快照。

一个通用的验证矩阵至少包括：直连、HTTP 代理、SOCKS5 代理、代理不可达、代理认证失败、`NO_PROXY` 命中和代理恢复后的重试。

## 不同技术栈的落地方式

### Tauri

Tauri 通常在配置中声明 updater endpoint 和公钥，在构建时生成平台资产与 updater 签名。建议把这些内容分成三层：

- `tauri.conf.json`：只放稳定的应用标识、更新 endpoint 和公钥。
- 构建脚本：检查版本、提交、目标平台、私钥环境变量和资产清单。
- CI Secret：保存 `TAURI_SIGNING_PRIVATE_KEY` 或等价的密钥服务凭据。

本地测试可以使用 unsigned bundle 或 `--no-bundle` 二进制，但不要把本地 unsigned 产物上传到生产更新目录。生产构建必须在 ASCII 路径、固定 Rust target 和明确的签名环境中执行；Windows 构建还要单独核对 NSIS/MSI、Authenticode 和 updater 签名是否是三套不同门禁。

Tauri CLI 可以生成项目自己的 key pair。下面的示例使用空 passphrase，只适合已经由操作系统 ACL/密钥库保护的专用发布机；生产环境更推荐使用 passphrase、CI Secret 或外部签名服务：

```powershell
pnpm dlx @tauri-apps/cli signer generate `
  --password "" `
  --write-keys "$env:LOCALAPPDATA\MyApp\updater.key" `
  --ci
```

把生成的 `.pub` 内容写入应用的 updater 配置，把私钥路径作为 `TAURI_SIGNING_PRIVATE_KEY_PATH` 注入发布进程。私钥文件不进仓库、不上传 issue/PR、不打印到日志；发布门禁应同时检查 endpoint、内置公钥、私钥存在和目标 GitHub/COS 仓库。

### Electron

Electron 应用常用 `electron-builder`、`electron-updater` 或自定义 `generic` provider。不要把“能下载 latest.yml”当成安装成功。应验证：

- feed URL、artifact URL、平台/架构和版本一致。
- differential download 关闭或经过单独验证后再启用。
- 下载后执行 hash/signature 校验，再进入 ready 状态。
- 本地 updater qualification 使用临时 `userData`、fixture server 和禁止 quit/relaunch 的 stub。

DSH NEXT 的本地 updater qualification 采用真实 Electron HTTP 路径，但禁止执行安装器；Windows 本地包区分 `unsigned` 和正式签名模式，上传前还会记录目标、版本、channel、公开 URL 和构建提交。这是一种适合大型 Electron 项目的可复用边界。

### 原生/自定义 updater

如果应用不是 Tauri/Electron，可采用一个签名 manifest：

```json
{
  "channel": "stable",
  "version": "1.2.3",
  "commit": "<verified-commit>",
  "platforms": {
    "windows-x64": {
      "url": "https://download.example/app-1.2.3-win-x64.zip",
      "sha256": "<sha256>",
      "signature": "<detached-signature>"
    }
  }
}
```

客户端先校验 manifest 签名，再校验资产 hash，最后确认版本高于当前版本且平台匹配。manifest 和资产可以放在不同 CDN，但必须防止客户端被旧 manifest 降级；需要支持 rollback 时，应使用明确的 rollback policy，而不是简单接受任意低版本。

## 常见故障与判定顺序

| 现象 | 先检查 | 不要直接做的事 |
| --- | --- | --- |
| Feed 404 | channel、路径、发布顺序、对象权限 | 盲目重试或切回上游 URL |
| 版本存在但提示无更新 | SemVer、`v` 前缀、预发布比较、当前版本 | 修改比较函数绕过门禁 |
| 下载成功但拒绝安装 | updater 公钥、签名格式、资产是否被重打包 | 删除校验或改成信任任意 HTTPS |
| Windows SmartScreen 警告 | Authenticode 证书和时间戳 | 把平台签名当作 updater 签名替代品 |
| macOS 能下载但打不开 | Developer ID、notarization、quarantine | 关闭 Gatekeeper 作为发布方案 |
| 代理下 feed 能开但资产失败 | feed 和 asset 是否经过同一 proxy、SNI、`NO_PROXY` | 设置全局代理污染数据库连接 |
| 更新后回滚 | cache、旧版本备份、安装前状态文件 | 覆盖用户 data 或重复下载未知版本 |
| 测试通过但生产失败 | 测试/生产 endpoint、bucket、签名 key 是否混用 | 复制测试 key 到生产 |

排查顺序应固定为：当前版本和 channel → feed HTTP 状态 → manifest 内容 → manifest 签名 → 资产 URL/长度 → 资产 hash → 平台安装签名 → 安装后启动和迁移。每一步只记录非敏感摘要。

## 发布、回滚和撤销

发布系统应把“准备”“上传”“公开 channel”“记录 commit”分成可重试阶段：

1. 在干净提交上构建并记录 provenance。
2. 生成所有平台资产，逐个计算 hash 和签名。
3. 上传到临时前缀并从公网只读下载验证。
4. 写入 manifest/metadata，验证它引用的每个资产都存在。
5. 原子切换 `latest`/channel 指针。
6. canary 验证后再扩大范围。

如果上传超时或结果不明，先查询远端对象和发布记录，不要盲目重传。若已发布错误版本，优先撤回 channel 指针、保留资产证据，再发布修复版本；不要删除用户本地配置或把数据库迁移回滚和应用回滚混在一起。

## 迁移到一个新的 Next 仓库

从官方仓库派生 Next 版本时，建议按下面的顺序：

1. 抓取官方 `main` 到 `upstream-main`，不把它当作自有发布分支。
2. 自有 `main` 只包含下游功能、品牌、更新源和发布脚本。
3. 为自有更新源生成独立的测试 manifest 和 channel。
4. 让 updater 实现从仓库地址、channel 和公钥配置中读取，不在上游功能补丁中散落硬编码。
5. 生成 upstream-only patch 时排除自有 updater、测试断言、release workflow、签名脚本和品牌链接。
6. 先构建 unsigned 本地包和本地 updater fixture，再接入正式签名服务。
7. 自有 release 使用 main 的 commit provenance；上游 PR 使用 upstream-main 的基线和独立 patch。

这样，应用功能可以向上游提交，发行渠道可以留在 Next 仓库；用户连接配置、代理设置和发布配置不会被迫复制到两个软件或两个仓库。

## 最小交付清单

在宣布“自更新已完成”前，必须能回答“是”：

- [ ] 连接层可以填写代理，并能按连接启用/停用。
- [ ] xenterm SOCKS5 通过本机 loopback 可被实际连接测试使用。
- [ ] 自有 main 和 upstream-main 的来源清晰且可复现。
- [ ] updater 不回退到官方 release 或官方 CDN。
- [ ] 上游 PR 生成器排除所有自有 updater/签名/发布文件。
- [ ] 本地 unsigned 包和生产 signed 包使用不同 channel。
- [ ] release 运行前检查私钥、公钥、仓库、版本、commit 和资产 hash。
- [ ] 至少有一次本地 fixture updater 资格测试和一次真实公网只读验证。
- [ ] 安装包/portable 替换保留旧版本回滚和用户 data 备份。
- [ ] 发生签名缺失时系统明确失败，不会悄悄改成信任任意下载。
