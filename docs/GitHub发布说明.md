# 源衡智控 GitHub 发布说明

适用项目：`C:\Users\12237\Desktop\实验`。

Git 保存本地代码版本，GitHub 保存远程仓库。建议参赛阶段先建私有仓库，邀请队友协作；是否公开和采用哪种开源许可证，等团队确认后再决定。项目已有第三方许可证和声明需要保留。

## 1. 已完成的本地准备

- 本地使用 `main` 分支。用 `git status` 查看提交状态，用 `git remote -v` 查看远程地址，用 `git branch -vv` 查看分支的远程跟踪状态。
- 扩展 `.gitignore`，忽略本地环境变量、凭据 CSV、数据库及备份、日志、依赖、Java 编译产物、旧前端备份和测试截图。
- 保留 Java/Python/前端源码、地图、SQL、测试源码、启动脚本、说明文档、公开市场参考样本和明确标识的虚拟数据包。
- `.env.example` 中的密钥字段为空，可作为配置模板；真实 `.env` 留在本机，由后端读取。

本次源码检查仅按常见凭据格式扫描，不代表完整安全审计。未来新增文件时，提交前仍需确认文件清单。`.gitignore` 不是访问控制，不能阻止使用 `git add -f` 强制加入文件，也不会清除已经进入历史的文件。

## 2. 在 GitHub 创建空仓库

登录自己的 GitHub，使用右上角 `+` → `New repository`：

| 选项 | 建议值 |
| --- | --- |
| Repository name | `yuanheng-energy` |
| Description | 源衡智控：工业企业源网荷储优化与 AI 辅助决策平台 |
| Visibility | `Private` |
| README | 不勾选，使用项目已有文件 |
| .gitignore | 不添加，使用项目已有文件 |
| License | 暂不添加，先保留第三方声明 |

点击 `Create repository`，复制仓库的 HTTPS 地址。仓库地址不包含密码或访问令牌。

## 3. 设置本项目的提交署名

打开 PowerShell。以下姓名和邮箱均为占位文字，先替换，再执行：

```powershell
cd "C:\Users\12237\Desktop\实验"
git config user.name "你的提交署名"
git config user.email "你在GitHub设置中确认的提交邮箱"
```

如果需要隐藏个人邮箱，在 GitHub 的邮箱设置中查看并使用自己的 `noreply` 地址，不要凭空拼写地址。这里不使用 `--global`，只配置本项目。

电脑已安装 Git。如果当前终端提示找不到 `git`，重新打开 PowerShell；仍找不到时，可先执行：

```powershell
$env:Path = "C:\Program Files\Git\cmd;" + $env:Path
```

## 4. 检查并创建首次提交

```powershell
git status --short
git check-ignore -- .env data/power_optimizer.db data/logs backend-java/classes
git add .
git diff --cached --stat
git diff --cached --name-only
```

确认暂存清单中没有真实 `.env`、凭据 CSV、数据库、数据库备份、日志或用户上传的业务文件。不要使用 `git add -f` 绕过忽略规则。确认后提交：

```powershell
git commit -m "Initial version of Yuanheng Energy"
```

项目功能源码、地图和第三方图表运行文件应当存在于提交中。不要因为体积较大误删 `frontend/vendor/echarts-5.6.0/` 的运行文件、LICENSE 和 NOTICE。

## 5. 关联并上传

将下面的用户名和仓库名替换为第 2 步创建的仓库，执行：

```powershell
git remote add origin https://github.com/你的用户名/yuanheng-energy.git
git remote -v
git push -u origin main
```

首次上传时，Git Credential Manager 通常会打开浏览器完成 GitHub 登录授权。如果没有出现浏览器登录，先检查 Git 凭据管理器配置。百炼 API Key 不用于 GitHub 身份验证；不要把任何令牌写在远程仓库地址中，也不要发到聊天中。

上传成功后刷新仓库页面，确认代码和 README 可见，再检查仓库中没有凭据、数据库和日志。对私有仓库，需要在仓库设置中邀请队友后，队友才能访问。

## 6. 后续更新

每次完成一项修改，先查看文件清单，再提交、上传：

```powershell
git status --short
git add .
git diff --cached --stat
git diff --cached --name-only
git commit -m "Describe this update"
git push
```

提交说明应描述实际修改。多人协作时，应先同步远程变更，再开始工作；发生冲突时逐个处理，不要通过强制推送覆盖队友提交。

## 7. 在另一台电脑运行

```powershell
git clone https://github.com/你的用户名/yuanheng-energy.git
cd yuanheng-energy
.\start.ps1
```

需要 JDK 21+ 和 Python 3.10+。首次运行会准备本地依赖和数据库；登录账号、业务记录以及 AI 密钥不随代码迁移。需要使用外部 AI 时，单独在运行机器配置环境变量或本地 `.env`，密钥只交给后端。

演示数据从“虚拟数据包”导入；实际业务数据通过系统正规导入流程迁移。模拟数据、预测结果和真实计量数据要分别标识。

## 8. 代码上传与网页上线

GitHub 仓库用于源码托管。GitHub Pages 提供静态站点托管，不能运行本项目的 Java/Python 后端和 SQLite 业务服务。完整系统继续部署在云服务器上，GitHub 负责版本管理；服务器单独管理环境变量、数据库、Nginx 和服务进程。

上传后检查本地与远程分支是否一致，并在 GitHub 仓库页面核对文件。源码上传不会自动部署系统；从远程重新克隆、在新机器启动和服务器自动部署需要分别验证。
