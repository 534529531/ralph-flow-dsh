# 发版（维护者）

> 一句话：**在 GitHub 上点一下，npm 上就有了。** 代码 push 本身不发版 —— 发布是显式动作。

## 发一次版

打开 <https://github.com/534529531/ralph-flow-dsh/actions/workflows/release.yml> →
**Run workflow** → 选 `bump`（`patch` / `minor` / `major` / `none`）→ Run。

命令行等价：

```bash
gh workflow run release.yml -f bump=minor
```

它依次做三件事：

| 作业 | 做什么 |
|---|---|
| **闸** | `npm ci && npm run build && npm run typecheck && npm run verify`（26 支套件）。**红了就到此为止，什么都不留下** —— tag 还没打 |
| **定版** | `npm version <bump>` → 提交 `release vX.Y.Z` → 打 annotated tag → 推回 `main` → 建 GitHub Release（`--generate-notes` 自动生成说明） |
| **发布** | checkout 那个 tag → `npm ci` → `npm run build` → `npm publish --provenance` |

约 10 分钟。完成后 npm 上是新版本、GitHub 上有一个 Release。

`bump=none` 表示「直接用 `package.json` 里现成的版本号」——手改好版本、只想发布时用。
也可以直接填 `version` 覆盖（填了它就忽略 `bump`）。

## 认证：两条路，任选一条

发布作业会**按密钥在不在自动选**：有 `NPM_TOKEN` 密钥就用它，没有就走 OIDC。
所以你可以先用 token 发，哪天把 Trusted Publisher 配好、把密钥删掉，它会自动切过去 —— 不用改 workflow。

### A. Trusted Publisher（OIDC）—— 推荐，零长期凭据

**不用存任何 npm token**（token 会过期，我们已经踩过两次）：

1. 登录 <https://www.npmjs.com/> → 包 `ralphflow-dsh` → **Settings** → **Trusted Publisher**
2. 选 **GitHub Actions**，填：
   - Organization or user：`534529531`
   - Repository：`ralph-flow-dsh`
   - Workflow filename：`release.yml`
   - Environment：**留空**
3. 保存。

之后 workflow 里的 `id-token: write` + `npm publish` 就能发，不需要任何 secret。
（npm 要求 CLI ≥ 11.5.1，workflow 里用 `npm install -g npm@11` 兜底，不赌 runner 自带的那一版。）

### B. `NPM_TOKEN` 密钥 —— 想立刻发就用这条

1. 在 <https://www.npmjs.com/settings/> 建一个 **Granular Access Token**：
   - Packages：**Read and write**，选中 `ralphflow-dsh`（或 All packages）
   - 记下过期时间 —— 到点要换
2. 加进仓库密钥：仓库 → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**，名字必须是 **`NPM_TOKEN`**，值粘贴 token。
   命令行等价：`gh secret set NPM_TOKEN`（会提示你粘贴，不回显）。
3. 不需要改任何代码。

> **别把 token 贴进任何对话、issue 或提交里** —— 它等同于这个包的发布权限。
> 泄漏了就去 npm 撤销重发一个，再更新密钥。

如果发布作业报 2FA / OTP 相关错误，说明 token 类型不对：换一个**能免 OTP 发布**的
（Granular 且允许 bypass 2FA，或经典 Automation 类型），或者干脆走 A。

## 版本号怎么选

| 改动 | 选 |
|---|---|
| 修 bug；只动文档 / 测试 | `patch` |
| 加功能、加界面、加字段（向后兼容） | `minor` |
| 改契约、改工作流 YAML 方言、删东西 | `major` |
| 已经手改好 `package.json` 的版本，只想发布 | `none` |

## 本地手动发（备用路径）

```bash
npm login                                    # token 会过期，过期就重登
npm run build && npm run typecheck && npm run verify
npm publish
```

`npm publish` 会走 `prepublishOnly`（= 上面那三条），所以**本地这条路自带全闸**。
CI 那条路跳过 `prepublishOnly`（闸已在「闸」作业里对同一份代码跑过，定版提交只改版本号），
只在发布前重新构建一次 `lib/` —— 本地路径的安全性没有被削弱。

## 为什么它不会自我循环

workflow 用 `GITHUB_TOKEN` 推 `main` 与 tag；GitHub 规定这种推送**不会**再触发其它 workflow。

## 出问题怎么办

| 现象 | 原因 / 处理 |
|---|---|
| 闸红了 | 什么都没发生（tag 还没打）。修完重跑即可 |
| `tag vX.Y.Z 已存在于远端` | 版本号不能复用，换 `bump` 或 `version` |
| npm 报 403 / 未授权 | 两条认证都没生效。先看「配置 npm 认证」那一步打印的是 `NPM_TOKEN 密钥` 还是 `trusted publishing (OIDC)`：前者说明密钥在但无效/过期，后者说明密钥不存在且 Trusted Publisher 没配好（workflow 文件名必须是 `release.yml`） |
| npm 报 2FA / OTP | token 类型不对，见「认证 B」末尾；或改用 A |
| 发布成功但包内容是旧的 | `lib/` 不在 git 里，发布的是**构建产物** —— 检查「发布」作业里的 `npm run build` 有没有被跳过 |
| Release 建了但 npm 没有 | 「发布」作业失败，看它的日志；tag 与 Release 已经存在，修好后可用 `none` 重跑（会因 tag 已存在而停下，需先删 tag 与 Release） |
