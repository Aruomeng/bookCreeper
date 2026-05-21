# 读秀图书数据采集操作手册

这份手册给协助采集数据的人使用。目标是让对方不用理解代码，也能按步骤启动项目、配置关键词队列、处理验证码、检查输出结果，并把必要更改推送到 GitHub。

> 重要提醒：请只在你拥有合法访问权限的网络、账号和机构授权范围内采集数据。不要尝试绕过登录、验证码、机构 IP 限制或其他访问控制。Cookie 属于敏感登录凭据，不要提交到 Git。

## 1. 接手前确认

请先确认下面几件事都满足：

- 电脑可以访问读秀网页，最好在校园网、机构 VPN 或授权 IP 环境中。
- 已安装 Python 3.10 或更高版本。
- 已有本仓库代码，或可以从 GitHub 克隆。
- 已登录读秀账号，必要时能拿到可用 Cookie。
- 知道本次要采集的关键词列表，例如“软件工程”“信息检索”等。

## 2. 获取或更新项目代码

如果本地还没有项目：

```bash
git clone https://github.com/Aruomeng/bookCreeper.git
cd bookCreeper
```

如果本地已经有项目，先更新到最新版本：

```bash
cd /path/to/bookCreeper
git pull --rebase origin main
```

检查当前分支和状态：

```bash
git status
```

建议看到类似：

```text
On branch main
nothing to commit, working tree clean
```

## 3. 安装依赖

首次运行需要安装 Python 依赖：

```bash
python3 -m pip install -r requirements.txt
```

如果 `requirements.txt` 安装失败，可以手动安装：

```bash
python3 -m pip install requests lxml fastapi uvicorn pydantic
```

## 4. 启动控制台

在项目根目录运行：

```bash
python3 crawler_app.py
```

浏览器打开：

```text
http://127.0.0.1:8000
```

如果 8000 端口被占用，可以使用：

```bash
python3 -m uvicorn crawler_app:app --host 127.0.0.1 --port 8001
```

然后浏览器打开：

```text
http://127.0.0.1:8001
```

## 5. 准备 Cookie

如果读秀需要登录态，请按下面步骤拿 Cookie：

1. 在浏览器中登录读秀。
2. 打开一个读秀搜索结果页。
3. 打开开发者工具，进入 `Network`。
4. 刷新页面。
5. 点任意 `book.duxiu.com` 请求。
6. 在 `Request Headers` 中复制完整 `Cookie`。
7. 粘贴到控制台左侧的“Cookie 文本”。

也可以把 Cookie 保存为本地文件，例如：

```text
/Users/yourname/duxiu_cookie.txt
```

然后在控制台填写“Cookie 文件路径”。

注意：

- 不要把 Cookie 写进代码。
- 不要把 Cookie 文件提交到 Git。
- 如果任务中途出现登录失效，重新登录后更新 Cookie，再继续。

## 6. 单关键词采集

如果只采集一个关键词：

1. 在读秀搜索该关键词。
2. 复制搜索结果页 URL。
3. 粘贴到控制台“搜索 URL”。
4. 设置输出 basename，例如：

```text
output/duxiu_books
```

5. 设置页数、目标本数、线程数等参数。
6. 点击“启动”。

推荐初始参数：

| 参数 | 推荐值 |
| --- | --- |
| 起始页 | 留空 |
| 页数 | 666 |
| 目标本数 | 10000 |
| 线程数 | 3 到 5 |
| 最小停顿 秒 | 1.5 |
| 最大停顿 秒 | 5 |
| 重试次数 | 2 |
| 重试等待 秒 | 2 |
| 断点续爬 | 勾选 |
| 保存阻断页面 | 勾选 |

如果频繁出现验证码，降低线程数并提高停顿时间。

## 7. 多关键词队列采集

推荐使用“关键词队列”批量采集。

### 7.1 准备关键词列表

可以每行写一个关键词：

```text
软件工程
信息检索
数据库系统
人工智能
```

也可以每行写完整读秀搜索链接：

```text
https://book.duxiu.com/search?channel=search&gtag=&sw=%E8%BD%AF%E4%BB%B6%E5%B7%A5%E7%A8%8B&ecode=utf-8&Field=all&Sort=&adminid=&btype=&seb=0&pid=0&year=&sectyear=&showc=0&fenleiID=&searchtype=&authid=0&exp=0&expertsw=
https://book.duxiu.com/search?channel=search&gtag=&sw=%E4%BF%A1%E6%81%AF%E6%A3%80%E7%B4%A2&ecode=utf-8&Field=all&Sort=&adminid=&btype=&seb=0&pid=0&year=&sectyear=&showc=0&fenleiID=&searchtype=&authid=0&exp=0&expertsw=
```

支持两种导入方式：

- 直接粘贴到“关键词 / 搜索链接”文本框。
- 上传 `.txt` 或 `.csv` 文件。

### 7.2 导入队列

1. 在左侧“任务范围”中找到“关键词队列”。
2. 粘贴关键词列表或上传文件。
3. 点击“导入队列”。
4. 控制台会自动载入第一个关键词。
5. 检查“当前输出目录”是否正确。

输出会按关键词自动分文件夹。

如果输出 basename 是：

```text
output/duxiu_books
```

那么“软件工程”的输出会写入：

```text
output/duxiu_books/软件工程/duxiu_books.csv
output/duxiu_books/软件工程/duxiu_books.json
output/duxiu_books/软件工程/duxiu_books.state.json
output/duxiu_books/软件工程/duxiu_books.log
```

“信息检索”的输出会写入：

```text
output/duxiu_books/信息检索/duxiu_books.csv
output/duxiu_books/信息检索/duxiu_books.json
output/duxiu_books/信息检索/duxiu_books.state.json
output/duxiu_books/信息检索/duxiu_books.log
```

### 7.3 手动模式

默认是手动模式。

流程：

1. 导入关键词队列。
2. 点击“启动”，开始当前关键词。
3. 当前关键词完成后，队列会停住。
4. 此时可以修改参数，例如线程数、停顿时间、Cookie、页数。
5. 点击“确认进入下一个”。
6. 检查下一个关键词和输出目录。
7. 再点击“启动”。

手动模式适合不稳定网络、容易验证码、或者需要每个关键词单独调整参数的情况。

### 7.4 连续模式

如果希望自动连续采集：

1. 勾选“连续模式：完成后自动下一个”。
2. 导入关键词队列。
3. 点击“启动”。

开启连续模式后，一个关键词完成后会自动载入并启动下一个关键词。

注意：

- 连续模式下不适合中途改参数。
- 如果遇到验证码、登录失效、机构 IP 限制等阻断，任务会停住，不会强行继续。
- 处理完验证码后，可以点击“启动/继续”恢复。

## 8. 专注模式和验证码处理

遇到验证码或风控时，推荐使用“专注模式”。

操作：

1. 点击右上角“专注模式”。
2. 页面左侧是读秀官方网页，右侧是实时日志。
3. 如果日志显示验证码/风控，左侧会自动切到对应官方页面。
4. 在左侧完成验证码或登录。
5. 验证完成后，页面会回到正常读秀页面。
6. 点击“启动/继续”。

常见日志：

```text
遇到验证/风控页面：antispider
已暂停在第 36 页第 3 条
请在专注模式左侧完成验证，然后点击“启动/继续”
```

处理原则：

- 不要反复点击启动。
- 先在专注模式完成验证。
- 如果一直触发验证码，降低线程数，提高停顿时间。
- 如果显示 IP 不在服务范围内，先切换校园网、VPN 或授权网络。

## 9. 断点续爬

默认建议勾选“断点续爬”。

断点文件会记录：

- 当前关键词。
- 最后页码和条目。
- 已完成页。
- 已处理详情链接。
- 已保存数量。
- 失败记录。

如果任务中断：

1. 不要删除输出文件。
2. 保持“断点续爬”勾选。
3. 修复 Cookie、网络或验证码问题。
4. 点击“启动/继续”。

如果你要完全重新采集某个关键词：

1. 换一个新的输出 basename，或删除该关键词文件夹。
2. 起始页可留空或填 1。
3. 再启动任务。

## 10. 输出结果检查

每个关键词文件夹里主要看这些文件：

```text
duxiu_books.csv
duxiu_books.json
duxiu_books.state.json
duxiu_books.log
```

建议检查：

- CSV 是否能打开。
- CSV 行数是否接近预期。
- `详情页Url` 是否有值。
- `题名`、`作者`、`出版社` 等字段是否明显错位。
- 日志中是否有大量失败、验证码或 IP 限制。

快速查看 CSV 行数：

```bash
wc -l output/duxiu_books/软件工程/duxiu_books.csv
```

快速查看最近日志：

```bash
tail -50 output/duxiu_books/软件工程/duxiu_books.log
```

## 11. 常见问题

### 页面提示 IP 不在服务范围内

原因通常是当前网络不在机构授权范围。

处理：

- 切换到校园网。
- 打开机构 VPN。
- 确认读秀网页本身能正常访问。

### 频繁出现验证码

处理：

- 线程数降到 2 到 3。
- 最小停顿调到 2 秒以上。
- 最大停顿调到 6 到 10 秒。
- 每次验证码完成后再继续。

### 一个关键词完成后没有进入下一个

先看是否开启了连续模式：

- 未开启连续模式：需要手动点击“确认进入下一个”，再点“启动”。
- 已开启连续模式：检查是否遇到验证码、登录失效或 IP 限制。

### 输出目录看起来像连在一起

最新版会自动修正旧格式路径。正确格式应该类似：

```text
output/duxiu_books/软件工程/duxiu_books.csv
output/duxiu_books/信息检索/duxiu_books.csv
```

如果看到类似下面的路径，说明可能没有刷新到最新版前端：

```text
output/duxiu_books_软件工程
output/duxiu_books/软件工程/信息检索
```

处理：

1. 刷新浏览器。
2. 必要时强制刷新：`Command + Shift + R`。
3. 确认本地代码已更新：

```bash
git pull --rebase origin main
```

### 日志显示挤在一行或撑破页面

最新版已经修复日志换行。请强制刷新页面。

## 12. 结束任务

任务完成后：

1. 确认状态为 `completed` 或者确认已达到目标数量。
2. 检查 CSV/JSON 是否生成。
3. 检查日志是否没有严重错误。
4. 如有验证码中断，确认最后是否已经继续完成。
5. 保留输出文件夹，不要手动改文件名。

## 13. 提交和推送代码更改

如果只是采集数据，通常不需要提交代码。

如果你修改了代码、README、操作手册或配置模板，请按下面流程提交。

先查看改动：

```bash
git status
git diff --stat
```

如果确认要提交全部改动：

```bash
git add .
git commit -m "Update crawler operation docs"
git push origin main
```

如果推送被拒绝，通常是远端有新提交：

```bash
git pull --rebase origin main
git push origin main
```

如果 rebase 冲突，不要乱删文件，先联系项目负责人。

## 14. 不要提交的内容

不要提交以下内容：

- Cookie 文本或 Cookie 文件。
- 账号密码。
- 临时截图。
- 无关系统文件，例如 `.DS_Store`。
- 不确定是否需要入库的大体量输出数据。

提交前可以检查：

```bash
git status --short
```

如果看到 Cookie、临时文件或不该提交的输出文件，先不要提交，联系项目负责人确认。

## 15. 给项目负责人的交接信息

每次采集完成后，建议把下面信息发给负责人：

```text
采集时间：
运行环境：校园网 / VPN / 授权 IP
关键词：
输出目录：
完成状态：completed / stopped / blocked / error
总保存数：
失败数：
是否遇到验证码：
是否更新过 Cookie：
备注：
```

示例：

```text
采集时间：2026-05-21 16:30
运行环境：机构 VPN
关键词：软件工程、信息检索
输出目录：output/duxiu_books
完成状态：completed
总保存数：软件工程 10000，信息检索 8230
失败数：软件工程 0，信息检索 2
是否遇到验证码：是，处理 1 次后继续
是否更新过 Cookie：是
备注：信息检索结果不足 10000，疑似搜索结果自然结束
```
