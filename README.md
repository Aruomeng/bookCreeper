# bookCreeper

`bookCreeper` 是一个面向读秀图书搜索结果的本地采集工具，用于从搜索结果页批量进入图书详情页，解析书目信息，并输出为 CSV、JSON 以及可恢复的断点状态文件。

项目包含两种使用方式：

- Web 控制台：适合长任务批量采集，支持多线程详情页抓取、实时日志、断点续爬、失败记录和页面级配置。
- 命令行脚本：适合小批量验证、前几页试跑或快速导出。

> 使用前请确认你拥有目标站点和机构账号的合法访问权限。工具只保存页面中可见的书目信息，不负责绕过登录、验证码、机构 IP 限制或其他访问控制。

## 功能特性

- 自动按 `Pages=` 参数翻页。
- 每页搜索结果顺序抓取，详情页支持多线程并发抓取。
- 支持随机停顿、请求重试和保守限速，降低长任务中断风险。
- 支持登录 Cookie 或 Cookie 文件。
- 实时写入 CSV，按批次刷新 JSON，降低中途停止造成的数据损失。
- 自动保存断点状态，可从最后页码、最后条目继续。
- 跳过已处理过的详情链接，避免断点续爬时重复写入。
- 遇到登录失效、机构 IP 限制、验证码、安全验证等阻断页面时停止任务并保留已抓数据。
- 识别异常详情页，例如详情链接返回搜索页/专业检索页时，不写入脏数据，并保存调试 HTML。
- 专门适配读秀详情页 `<dd>` 卡片结构，避免把高级检索、脚本、免责声明等页面噪声写入字段。
- 从搜索结果页详情链接同步保留书名，详情页标题异常时用搜索结果书名兜底。
- 自动清理字段中的 `&nbsp`、不间断空格和部分中图分类分隔符乱码。
- 前端控制台支持参数栏和最近保存栏收起，日志区域可横向滚动，适合长日志观察。

## 项目结构

```text
bookCreeper/
├── crawl_duxiu_books.py      # 核心解析逻辑和命令行采集脚本
├── crawler_app.py            # FastAPI 本地控制台和多线程爬虫服务
├── static/
│   ├── index.html            # 控制台页面结构
│   ├── styles.css            # 控制台样式
│   └── app.js                # 控制台交互和状态轮询
├── output/                   # 默认输出目录
│   ├── duxiu_books.csv
│   ├── duxiu_books.json
│   ├── duxiu_books.state.json
│   ├── duxiu_books.log
│   └── debug/
└── README.md
```

## 运行环境

建议环境：

- Python 3.10 或更高版本
- 可访问读秀的网络环境，例如校园网、机构 VPN 或已授权 IP
- 已登录读秀账号对应的 Cookie

依赖包：

```bash
python3 -m pip install requests lxml fastapi uvicorn pydantic
```

如果你的环境已经安装这些包，可以跳过安装步骤。

## 采集字段

当前输出字段顺序如下：

| 字段 | 说明 |
| --- | --- |
| `题名` | 图书题名，会优先使用详情页标题；详情页标题异常时使用搜索结果页书名兜底 |
| `外文题名` | 外文题名或原书名 |
| `作者` | 作者、编者、译者等责任者信息 |
| `出版社` | 从 `出版发行` 中拆分出的出版社 |
| `发行时间` | 从 `出版发行` 中拆分出的出版/发行日期 |
| `ISBN号` | ISBN 号 |
| `页数` | 页数 |
| `原书定价` | 原书定价 |
| `开本` | 开本 |
| `主题词` | 详情页卡片中的主题词 |
| `中图法分类号` | 详情页卡片中的中图法分类号 |
| `内容提要` | 内容提要，会截掉参考文献格式、获取方式、免责声明、目录试读等尾部噪声 |
| `详情页Url` | 实际解析的详情页 URL，便于回查 |

## 快速开始：Web 控制台

启动本地服务：

```bash
python3 crawler_app.py
```

打开浏览器：

```text
http://127.0.0.1:8000
```

默认搜索 URL 为：

```text
https://book.duxiu.com/search?Field=all&channel=search&sw=%E5%9B%BE%E4%B9%A6%E9%A6%86&ecode=utf-8&edtype=&searchtype=&view=0
```

这个默认 URL 对应关键词“图书馆”。如需采集其他关键词，先在读秀页面完成检索，然后复制搜索结果页 URL 到控制台的“搜索 URL”。

### 推荐初始配置

大批量任务建议从保守参数开始：

| 参数 | 推荐值 | 说明 |
| --- | --- | --- |
| 起始页 | 留空 | 断点续爬时自动从状态文件恢复 |
| 页数 | `666` | 约 9990 条搜索结果，每页通常 15 条 |
| 目标本数 | `10000` | 达到目标数量后自动停止 |
| 线程数 | `3` 到 `6` | 详情页并发数，过高更容易触发风控 |
| 最小停顿 | `1.5` | 每次请求前随机等待下限，单位秒 |
| 最大停顿 | `5` | 每次请求前随机等待上限，单位秒 |
| 重试次数 | `2` | 普通网络错误的重试次数 |
| 重试等待 | `2` | 重试递增等待基准，单位秒 |
| 断点续爬 | 勾选 | 读取已有 state/json/csv 并追加 |
| 保存阻断页面 | 勾选 | 便于排查验证页、异常详情页 |

### 控制台布局

- 左侧：参数配置栏，可收起。
- 中间：运行状态、核心指标、进度与实时日志。
- 右侧：最近保存，可收起，默认让出更多空间给日志。
- 日志区域支持横向滚动，长 URL 或长错误信息不会挤压页面。
- 参数会保存到浏览器本地存储，刷新页面不会回到默认值。Cookie 文本不会写入本地配置缓存。

## Cookie 使用方式

读秀通常需要登录态。建议使用浏览器开发者工具复制请求头中的 `Cookie`。

步骤：

1. 在浏览器中登录读秀。
2. 打开读秀搜索结果页。
3. 打开开发者工具，进入 Network。
4. 刷新页面，点击任意 `book.duxiu.com` 请求。
5. 在 Request Headers 中复制完整 `Cookie`。
6. 粘贴到控制台“Cookie 文本”，或保存到文件后填写“Cookie 文件路径”。

Cookie 文件示例：

```text
/Users/yourname/duxiu_cookie.txt
```

文件内容为一整行原始 Cookie：

```text
name=value; name2=value2; name3=value3
```

注意事项：

- Cookie 是敏感登录凭据，不建议提交到 Git 或发送给他人。
- Cookie 可能会过期。遇到登录态失效时，重新登录并更新 Cookie。
- 如果机构要求校园网或 VPN，只有 Cookie 不一定够，还需要在授权网络环境中运行。

## 输出文件

默认输出 basename 为：

```text
output/duxiu_books
```

实际生成文件：

| 文件 | 说明 |
| --- | --- |
| `output/duxiu_books.csv` | CSV 结果，使用 `utf-8-sig` 编码，方便 Excel 打开 |
| `output/duxiu_books.json` | JSON 结果，按批次刷新 |
| `output/duxiu_books.state.json` | 断点状态文件 |
| `output/duxiu_books.log` | 运行日志，一行一个 JSON 日志对象 |
| `output/debug/blocked_page_*_item_*.html` | 登录、验证码、IP 限制等阻断页面 |
| `output/debug/bad_detail_*_item_*.html` | 详情链接返回非详情页时保存的调试页面 |

如果你想保留旧结果并开始一轮干净的新采集，建议把输出 basename 改成新的路径，例如：

```text
output/duxiu_books_fixed
```

这样会生成：

```text
output/duxiu_books_fixed.csv
output/duxiu_books_fixed.json
output/duxiu_books_fixed.state.json
output/duxiu_books_fixed.log
```

## 断点续爬机制

Web 控制台的断点续爬由三个文件共同支持：

- `.state.json`：记录任务状态、最后页码、最后条目、已完成页、已处理详情 URL、失败记录等。
- `.json`：读取已有结果，恢复最近保存列表和已保存数量。
- `.csv`：如果表头和当前字段一致，则追加写入；如果表头不一致，会自动备份旧 CSV。

恢复策略：

1. 勾选“断点续爬”。
2. 如果“起始页”留空，并且 state 文件存在，则从 state 中的最后页码继续。
3. 已完成页会跳过。
4. 已处理详情 URL 会跳过。
5. 失败记录会保存在 state 中，但不会写入结果 CSV/JSON。

建议：

- 大任务不要手动删除 `.state.json`，除非你确认要重新开始。
- 如果解析字段变更过，最好换一个新的输出 basename，避免旧数据和新字段混在一起。
- 如果 CSV 表头变化，程序会自动备份旧 CSV，但 JSON 仍会按当前输出 basename 读取，必要时请手动换 basename。

## 异常处理策略

### 会停止任务的情况

以下情况会停止当前任务，并保存已经抓取好的数据：

- 登录态失效或被重定向到登录页。
- 当前 IP 不在机构授权范围内。
- 页面出现验证码、安全验证、人机验证、访问过于频繁、异常访问等关键词。

停止后控制台会显示最后位置：

```text
最后位置：第 N 页第 M 条
```

同时状态文件也会记录：

```json
{
  "last_page": 149,
  "last_item": 12,
  "last_url": "..."
}
```

处理方式：

1. 先不要删除输出文件。
2. 检查 `output/debug/blocked_page_*_item_*.html`。
3. 更新 Cookie、切换授权网络或降低线程数/提高停顿时间。
4. 重新启动任务并勾选“断点续爬”。

### 不写入结果但继续任务的情况

如果详情链接返回的不是详情页，而是搜索页、专业检索页或无法识别的页面，程序会：

- 不写入 CSV/JSON。
- 记录失败数。
- 写入 `.state.json` 的 `failed` 数组。
- 保存 `output/debug/bad_detail_*_item_*.html`。
- 继续处理其他详情页。

这样可以避免出现类似下面的脏数据：

```json
{
  "中图法分类号": "年代： 请选择 至 请先选择开始年代 显示结果： 每页显示15条 ..."
}
```

## 命令行脚本

命令行脚本适合采集前几页进行验证。它是单进程顺序抓取，不提供 Web 控制台的实时日志、断点续爬、多线程和阻断页面保存能力。

基本用法：

```bash
python3 crawl_duxiu_books.py \
  --url 'https://book.duxiu.com/search?Field=all&channel=search&sw=%E5%9B%BE%E4%B9%A6%E9%A6%86&ecode=utf-8&edtype=&searchtype=&view=0' \
  --pages 5 \
  --cookie '这里粘贴登录后的 Cookie'
```

使用 Cookie 文件：

```bash
python3 crawl_duxiu_books.py \
  --url 'https://book.duxiu.com/search?Field=all&channel=search&sw=%E5%9B%BE%E4%B9%A6%E9%A6%86&ecode=utf-8&edtype=&searchtype=&view=0' \
  --pages 5 \
  --cookie-file /Users/yourname/duxiu_cookie.txt
```

指定输出文件 basename：

```bash
python3 crawl_duxiu_books.py \
  --url 'https://book.duxiu.com/search?Field=all&channel=search&sw=%E5%9B%BE%E4%B9%A6%E9%A6%86&ecode=utf-8&edtype=&searchtype=&view=0' \
  --pages 5 \
  --output output/test_books \
  --cookie-file /Users/yourname/duxiu_cookie.txt
```

调整随机停顿：

```bash
python3 crawl_duxiu_books.py \
  --url 'https://book.duxiu.com/search?Field=all&channel=search&sw=%E5%9B%BE%E4%B9%A6%E9%A6%86&ecode=utf-8&edtype=&searchtype=&view=0' \
  --pages 5 \
  --min-delay 2 \
  --max-delay 5 \
  --cookie-file /Users/yourname/duxiu_cookie.txt
```

命令行参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--url` | 必填 | 读秀搜索结果页 URL |
| `--pages` | `5` | 采集搜索结果页数 |
| `--output` | `output/duxiu_books` | 输出 basename，不带扩展名 |
| `--cookie` | 空 | 直接传入原始 Cookie |
| `--cookie-file` | 空 | 从文本文件读取 Cookie |
| `--min-delay` | `1.0` | 每次请求随机等待下限 |
| `--max-delay` | `2.5` | 每次请求随机等待上限 |
| `--user-agent` | Chrome UA | 自定义 User-Agent |

## Web API

本地控制台提供以下接口，供页面调用，也可用于简单自动化：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 控制台页面 |
| `GET` | `/api/default-config` | 默认配置 |
| `POST` | `/api/start` | 启动任务 |
| `POST` | `/api/stop` | 请求停止任务 |
| `GET` | `/api/status` | 当前状态、日志、最近保存、输出文件路径 |

`POST /api/start` 请求体示例：

```json
{
  "searchUrl": "https://book.duxiu.com/search?Field=all&channel=search&sw=%E5%9B%BE%E4%B9%A6%E9%A6%86&ecode=utf-8&edtype=&searchtype=&view=0",
  "startPage": null,
  "pages": 666,
  "targetBooks": 10000,
  "workers": 5,
  "minDelay": 1.0,
  "maxDelay": 3.5,
  "retries": 2,
  "retryDelay": 2.0,
  "output": "output/duxiu_books",
  "cookie": "",
  "cookieFile": "/Users/yourname/duxiu_cookie.txt",
  "resume": true,
  "flushEvery": 10,
  "saveBlockHtml": true
}
```

## 解析逻辑说明

读秀详情页中的核心字段通常位于如下结构：

```html
<dd>
  <span class="card_text-dd-label">出版发行</span>
  <span class="gray1">：</span>
  沈阳：辽宁科学技术出版社，2015.03
</dd>
```

本项目对以下字段采用严格卡片解析：

- 作者
- 出版发行
- ISBN号
- 页数
- 丛书名
- 原书定价
- 开本
- 主题词
- 中图法分类号
- 内容提要

这样做是为了避免从整页文本中误抓：

- 高级检索表单
- 主题分类导航
- JavaScript 脚本
- 免责声明
- 参考文献与引证文献区域
- “你可能还需要”等推荐列表

书名解析采用三层策略：

1. 优先读取详情页中明确的书名节点。
2. 如果详情页标题区异常，尝试从“参考文献格式”中解析书名。
3. 如果仍无法得到有效书名，使用搜索结果页中详情链接对应的书名作为兜底。

字段清洗会统一处理：

- `&nbsp` 和 HTML 不间断空格。
- `题名` 中的 `_图书搜索` 等页面后缀。
- `内容提要` 后面的参考文献、免责声明、目录试读等噪声。
- `中图法分类号` 中夹在分类号之间的替换字符乱码，例如 `G259.252��G252.17`。

`出版发行` 会进一步拆分为：

- `出版社`
- `发行时间`

`内容提要` 会在以下标记处截断：

- `参考文献格式`
- `获取 ：`
- `获取：`
- `免责声明`
- `//<![CDATA[`
- `目录试读`

## 推荐采集流程

大批量采集建议按以下流程：

1. 先用命令行或 Web 控制台采集 1 到 5 页，检查字段是否符合预期。
2. 确认 Cookie、网络环境、输出路径无误。
3. 设置较保守的线程数和停顿时间，例如线程数 `3`，随机停顿 `2-6` 秒。
4. 启动正式任务。
5. 观察实时日志和失败数。
6. 如果遇到验证或 IP 限制，停止后检查 debug HTML。
7. 更新 Cookie 或调整网络，再使用同一 basename 断点续爬。
8. 完成后优先检查 CSV 中的 `题名`、`出版社`、`ISBN号`、`主题词`、`中图法分类号`、`内容提要`。

## 常见问题

### 只有第一页数据怎么办？

读秀分页使用 `Pages=` 参数。项目会自动改写搜索 URL 中的 `Pages` 值：

```text
Pages=1
Pages=2
Pages=3
```

如果搜索 URL 中含有小写 `page` 且没有 `Pages`，程序会移除 `page` 并使用 `Pages`。

### 为什么有的详情页失败？

常见原因：

- 详情页请求被重定向到搜索页。
- 登录态失效。
- 机构访问权限不足。
- 页面结构和常规详情页不同。
- 网站返回了安全验证页。

失败详情可在 `.state.json` 的 `failed` 数组和 `output/debug/` 中查看。

### 为什么 CSV 出现重复？

可能原因：

- 关闭断点续爬后重新使用同一输出 basename。
- 删除了 state 文件但保留了 CSV。
- 字段变更后继续向旧 CSV 追加。

建议做法：

- 正式采集时保持“断点续爬”开启。
- 需要重跑时使用新的输出 basename。
- 不要手动混用不同版本的 CSV/JSON/state。

### 为什么前端配置刷新后还在？

前端会把除 Cookie 文本以外的配置保存到浏览器 `localStorage`。这是为了避免长任务调参后刷新页面丢配置。

### 如何清理旧任务？

如果确认不再需要断点和旧数据，可以删除对应 basename 的输出文件：

```bash
rm output/duxiu_books.csv
rm output/duxiu_books.json
rm output/duxiu_books.state.json
rm output/duxiu_books.log
```

也可以更安全地换一个新的输出 basename，而不是删除旧文件。

## 维护建议

- 优先修改 `crawl_duxiu_books.py` 中的解析函数，再让 Web 控制台复用。
- 修改输出字段时同步更新 `FIELDS`、README 和前端最近保存展示。
- 修改字段后建议换新的输出 basename，避免旧 CSV 表头和新字段不一致。
- 如果读秀页面结构变化，先保存异常 HTML，再用浏览器开发者工具确认字段所在 DOM。
- 不建议把线程数调得过高。长任务的稳定性通常比瞬时速度更重要。

## 合规提醒

请在授权范围内使用本工具，遵守目标网站、学校/机构和数据源的使用规范。遇到验证码、安全验证、登录限制或访问频率限制时，应降低频率、暂停任务或重新确认访问权限。本项目不会也不应被用于绕过访问控制。
