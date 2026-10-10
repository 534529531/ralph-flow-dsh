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

## 一次性配置：npm Trusted Publisher（OIDC）

**本仓库不存任何 npm token**（token 会过期，我们已经踩过两次）。改用 GitHub Actions 的 OIDC
身份直接发布：

1. 登录 <https://www.npmjs.com/> → 包 `ralphflow-dsh` → **Settings** → **Trusted Publisher**
2. 选 **GitHub Actions**，填：
   - Organization or user：`534529531`
   - Repository：`ralph-flow-dsh`
   - Workflow filename：`release.yml`
   - Environment：**留空**
3. 保存。

之后 workflow 里的 `id-token: write` + `npm publish` 就能发，不需要任何 secret。
（npm 要求 CLI ≥ 11.5.1，workflow 里用 `npm install -g npm@11` 兜底，不赌 runner 自带的那一版。）

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
| npm 报 403 / 未授权 | Trusted Publisher 没配，或 workflow 文件名填错（必须是 `release.yml`） |
| 发布成功但包内容是旧的 | `lib/` 不在 git 里，发布的是**构建产物** —— 检查「发布」作业里的 `npm run build` 有没有被跳过 |
| Release 建了但 npm 没有 | 「发布」作业失败，看它的日志；tag 与 Release 已经存在，修好后可用 `none` 重跑（会因 tag 已存在而停下，需先删 tag 与 Release） |
