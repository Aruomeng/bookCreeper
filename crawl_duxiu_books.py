#!/usr/bin/env python3
"""Crawl Duxiu book metadata from a search result URL.

Usage:
  python3 crawl_duxiu_books.py --url "https://book.duxiu.com/search?..." --pages 5
  python3 crawl_duxiu_books.py --url "https://book.duxiu.com/search?..." --cookie "name=value; ..."
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import requests
from lxml import html


FIELDS = [
    "题名",
    "外文题名",
    "作者",
    "出版社",
    "发行时间",
    "ISBN号",
    "页数",
    "原书定价",
    "开本",
    "主题词",
    "中图法分类号",
    "内容提要",
    "详情页Url",
]

FIELD_ALIASES = {
    "外文题名": ["外文题名", "外文书名", "原书名", "original-title"],
    "作者": ["作者", "作 者", "责任者"],
    "出版发行": ["出版发行", "出 版 发 行", "出版发行项"],
    "ISBN号": ["ISBN号", "I S B N 号", "ISBN 号"],
    "页数": ["页数", "页 数", "总页数"],
    "丛书名": ["丛书名", "丛 书 名", "系列"],
    "原书定价": ["原书定价", "原 书 定 价", "定价", "price"],
    "开本": ["开本", "开 本"],
    "主题词": ["主题词", "主 题 词"],
    "中图法分类号": ["中图法分类号", "中图分类号", "CLC"],
    "内容提要": ["内容提要", "内 容 提 要", "提要", "摘要", "摘 要"],
}

STRICT_CARD_FIELDS = {
    "作者",
    "出版发行",
    "ISBN号",
    "页数",
    "丛书名",
    "原书定价",
    "开本",
    "主题词",
    "中图法分类号",
    "内容提要",
}
DETAIL_CORE_FIELDS = {"作者", "出版发行", "ISBN号", "页数", "主题词", "中图法分类号", "内容提要"}
SEARCH_PAGE_MARKERS = [
    "中文图书专业检索",
    "返回简单检索",
    "检索规则说明",
    "显示结果： 每页显示",
    "请输入检索词",
]


@dataclass
class CrawlStats:
    pages_seen: int = 0
    detail_urls_seen: int = 0
    detail_urls_unique: int = 0
    books_saved: int = 0


@dataclass(frozen=True)
class DetailItem:
    url: str
    title: str = ""


def normalize_space(text: str) -> str:
    text = (text or "").replace("\xa0", " ")
    text = re.sub(r"&nbsp;?", " ", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def normalize_label(label: str) -> str:
    return re.sub(r"[\s:：　]+", "", label or "").strip()


def flexible_label_pattern(label: str) -> str:
    """Match labels even when Duxiu inserts spaces between label characters."""
    compact = normalize_label(label)
    return r"\s*".join(re.escape(char) for char in compact)


def build_page_url(base_url: str, page: int) -> str:
    parsed = urlparse(base_url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if "page" in params and "Pages" not in params:
        params.pop("page", None)
    params["Pages"] = str(page)
    return urlunparse(parsed._replace(query=urlencode(params, doseq=True)))


def looks_like_login(page_text: str, final_url: str) -> bool:
    lower_url = final_url.lower()
    return "login" in lower_url or "登录" in page_text[:3000] and "password" in page_text[:5000].lower()


def access_error(page_text: str, final_url: str) -> str:
    if "logout.jsp" in final_url.lower() and "IP不在我们服务的范围内" in page_text:
        return "当前运行环境的 IP 不在读秀机构授权范围内。请在校园网/VPN/授权 IP 环境下运行脚本。"
    if "IP不在我们服务的范围内" in page_text:
        return "当前运行环境的 IP 不在读秀机构授权范围内。请在校园网/VPN/授权 IP 环境下运行脚本。"
    return ""


def fetch(session: requests.Session, url: str, delay: tuple[float, float]) -> requests.Response:
    time.sleep(random.uniform(*delay))
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
        resp.encoding = resp.apparent_encoding
    return resp


def is_book_detail_url(url: str) -> bool:
    return bool(re.search(r"(?:/views/specific/\d+/)?bookDetail\.jsp\?", url))


def title_is_noise(title: str) -> bool:
    title = clean_title(title)
    if not title or len(title) > 140:
        return True
    if normalize_label(title) in {"书名", "题名", "外文题名", "中文图书"}:
        return True
    noise_markers = SEARCH_PAGE_MARKERS + [
        "可检索字段",
        "专业检索规则",
        "图书示例",
        "参考文献与引证文献",
        "参考文献",
        "目录试读",
        "你可能还需要",
        "推荐图书馆购买",
        "信息补正",
        "点击复制",
        "免责声明",
    ]
    return any(marker in title for marker in noise_markers)


def search_title_candidate(text: str) -> str:
    title = clean_title(text)
    if title_is_noise(title):
        return ""
    generic = {
        "详情",
        "详细",
        "试读",
        "阅读",
        "在线阅读",
        "馆藏纸本",
        "文献传递",
        "获取",
        "收藏",
        "分享",
        "导出",
        "封面",
    }
    if title in generic or title.startswith(("http://", "https://")):
        return ""
    return title


def extract_detail_items(page_html: str, page_url: str) -> list[DetailItem]:
    doc = html.fromstring(page_html)
    items: list[DetailItem] = []
    for anchor in doc.xpath("//a[@href]"):
        full = urljoin(page_url, anchor.get("href") or "")
        if not is_book_detail_url(full):
            continue

        candidates = [anchor.text_content()]
        for ancestor_xpath in [
            "./ancestor::li[1]",
            "./ancestor::tr[1]",
            "./ancestor::div[contains(@class,'book') or contains(@class,'result') or contains(@class,'list')][1]",
            "./ancestor::div[1]",
        ]:
            for ancestor in anchor.xpath(ancestor_xpath):
                candidates.extend(node.text_content() for node in ancestor.xpath(".//a[@href]"))
                candidates.extend(
                    node.text_content()
                    for node in ancestor.xpath(
                        ".//*[contains(@class,'title') or contains(@class,'bookname') "
                        "or contains(@class,'book-name') or contains(@class,'name')]"
                    )
                )

        title = ""
        for candidate in candidates:
            title = search_title_candidate(candidate)
            if title:
                break
        if not title:
            useful_candidates = [search_title_candidate(candidate) for candidate in candidates]
            useful_candidates = [candidate for candidate in useful_candidates if candidate]
            if useful_candidates:
                title = max(useful_candidates, key=len)
        items.append(DetailItem(full, title))
    return dedupe_detail_items(items)


def extract_detail_links(page_html: str, page_url: str) -> list[str]:
    return [item.url for item in extract_detail_items(page_html, page_url)]


def dedupe_detail_items(items: Iterable[DetailItem]) -> list[DetailItem]:
    seen: dict[str, DetailItem] = {}
    for item in items:
        if item.url not in seen:
            seen[item.url] = item
        elif item.title and not seen[item.url].title:
            seen[item.url] = item
    return list(seen.values())


def dedupe(items: Iterable[str]) -> list[str]:
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def text_nodes(doc: html.HtmlElement) -> list[str]:
    return [normalize_space(t) for t in doc.xpath("//body//text()[normalize-space()]")]


def clean_title(title: str) -> str:
    title = normalize_space(title)
    label_match = re.match(r"^(?:书名|题名)\s*[：:]\s*(.+)$", title)
    if label_match:
        title = label_match.group(1)
    title = title.strip("《》")
    title = re.sub(r"[-_｜|]?\s*读秀.*$", "", title).strip()
    title = re.sub(r"[-_｜|]?\s*图书搜索\s*$", "", title).strip()
    title = re.sub(r"[-_｜|]?\s*中文图书搜索\s*$", "", title).strip()
    title = title.strip("《》")
    return normalize_space(title)


def title_from_citation(flat_text: str) -> str:
    match = re.search(
        r"参考文献格式\s*[：:]\s*(.*?)(?=\s+(?:获取|免责声明|目录试读|书内插图及表格)\s*[：:]?|$)",
        flat_text,
    )
    if not match:
        return ""
    citation = normalize_space(match.group(1))
    patterns = [
        r"[.．]\s*(.+?)\s*\[[A-Z]\]",
        r"[.．]\s*(.+?)[.．]\s*[^.．]{1,30}[：:]",
    ]
    for pattern in patterns:
        title_match = re.search(pattern, citation)
        if title_match:
            title = clean_title(title_match.group(1))
            if not title_is_noise(title):
                return title
    return ""


def extract_title(doc: html.HtmlElement, nodes: list[str], flat_text: str = "", fallback_title: str = "") -> str:
    title_xpaths = [
        "(//dl[.//span[contains(@class,'card_text-dd-label') or contains(@class,'card_text-dd_label')]]//dt)[1]",
        "(//dl[.//dd]/dt[1])[1]",
        "//dt[contains(@class,'books-title') or contains(@class,'book-title') or contains(@class,'books_title') or contains(@class,'book_title')][1]",
        "//h1",
        "//h2",
        "//*[contains(@class,'book-title') or contains(@class,'book_title')]",
        "//*[contains(@class,'bookname') or contains(@class,'book-name') or contains(@class,'book_name')]",
        "//dl[.//dd]//dt[1]",
    ]
    for xp in title_xpaths:
        for node in doc.xpath(xp):
            val = clean_title(node.text_content())
            if not title_is_noise(val):
                return val

    citation_title = title_from_citation(flat_text)
    if citation_title:
        return citation_title

    fallback_title = clean_title(fallback_title)
    if fallback_title and not title_is_noise(fallback_title):
        return fallback_title

    raw_title = normalize_space(" ".join(doc.xpath("//title/text()")))
    title = clean_title(raw_title)
    if title and "登录" not in title and "图书搜索" not in raw_title and not title_is_noise(title):
        return title

    return ""


def extract_pairs_from_tables(doc: html.HtmlElement) -> dict[str, str]:
    pairs: dict[str, str] = {}

    def put(label: str, value: str) -> None:
        key = normalize_label(label)
        value = normalize_space(value)
        if not key or not value:
            return
        old = pairs.get(key, "")
        if not old or len(value) < len(old):
            pairs[key] = value

    for tr in doc.xpath("//tr"):
        cells = [normalize_space(c.text_content()) for c in tr.xpath("./th|./td")]
        cells = [c for c in cells if c]
        if len(cells) >= 2:
            put(cells[0], " ".join(cells[1:]))

    for node in doc.xpath("//li|//p|//div|//span"):
        text = normalize_space(node.text_content())
        if not text or len(text) > 220:
            continue
        match = re.match(r"^(.{1,16}?)[：:]\s*(.+)$", text)
        if match:
            put(match.group(1), match.group(2))
    return pairs


def value_from_pairs(pairs: dict[str, str], aliases: list[str]) -> str:
    normalized = {normalize_label(k): v for k, v in pairs.items()}
    for alias in aliases:
        key = normalize_label(alias)
        if key in normalized:
            return normalized[key]
    return ""


def value_from_text(flat_text: str, aliases: list[str]) -> str:
    labels = "|".join(flexible_label_pattern(a) for a in aliases)
    next_labels = "|".join(
        flexible_label_pattern(a)
        for names in FIELD_ALIASES.values()
        for a in names
        if a not in {"price", "CLC", "original-title"}
    )
    pattern = rf"(?:{labels})\s*[：:]\s*(.*?)(?=\s+(?:{next_labels})\s*[：:]|$)"
    match = re.search(pattern, flat_text, flags=re.I)
    return normalize_space(match.group(1)) if match else ""


def field_by_label(label: str) -> str:
    compact = normalize_label(label)
    for field, aliases in FIELD_ALIASES.items():
        for alias in aliases:
            if compact == normalize_label(alias):
                return field
    return ""


def values_from_card_dds(doc: html.HtmlElement) -> dict[str, str]:
    """Extract values from Duxiu detail rows.

    The real detail page stores rows like:
      <dd><span class="card_text-dd-label">出版发行</span>... value ...</dd>
    This is much safer than scanning the whole page, because the search/filter
    sidebar also contains words like ISBN, 出版社, and 主题.
    """
    values: dict[str, str] = {}
    label_xpath = (
        ".//span["
        "contains(concat(' ', normalize-space(@class), ' '), ' card_text-dd-label ') "
        "or contains(concat(' ', normalize-space(@class), ' '), ' card_text-dd_label ')"
        "][1]"
    )
    for dd in doc.xpath("//dd"):
        label_node = dd.xpath(label_xpath)
        if not label_node:
            label_node = dd.xpath("./span[1]")
        if not label_node:
            continue
        label = normalize_space(label_node[0].text_content())
        field = field_by_label(label)
        if not field:
            continue

        full_text = normalize_space(dd.text_content())
        value = re.sub(rf"^{flexible_label_pattern(label)}\s*[：:]?\s*", "", full_text, count=1)
        value = normalize_space(value.strip(" :：\u00a0"))
        if value:
            values[field] = value
    return values


def detail_page_problem(page_html: str, final_url: str) -> str:
    try:
        doc = html.fromstring(page_html)
    except Exception as exc:
        return f"详情页 HTML 解析失败：{exc}"

    return detail_page_problem_from_doc(doc, final_url)


def detail_page_problem_from_doc(doc: html.HtmlElement, final_url: str) -> str:
    card_values = values_from_card_dds(doc)
    core_count = sum(1 for field in DETAIL_CORE_FIELDS if card_values.get(field))
    if core_count >= 2:
        return ""

    body_head = normalize_space(" ".join(doc.xpath("//body//text()[normalize-space()]")[:300]))
    raw_title = normalize_space(" ".join(doc.xpath("//title/text()")))
    if "图书搜索" in raw_title and any(marker in body_head for marker in SEARCH_PAGE_MARKERS):
        return "响应是搜索/专业检索页，不是图书详情页"
    if any(marker in body_head for marker in SEARCH_PAGE_MARKERS) and not card_values:
        return "响应是搜索/专业检索页，不是图书详情页"
    if not card_values:
        return "未识别到详情页字段结构"
    return ""


def split_publication(value: str) -> tuple[str, str]:
    value = normalize_space(value)
    if not value:
        return "", ""

    date_match = re.search(r"(\d{4}(?:[.-]\d{1,2})?(?:[.-]\d{1,2})?)\s*$", value)
    publish_date = date_match.group(1) if date_match else ""
    publisher_part = value[: date_match.start()].strip(" ，,;；") if date_match else value
    if "：" in publisher_part:
        publisher_part = publisher_part.rsplit("：", 1)[-1]
    elif ":" in publisher_part:
        publisher_part = publisher_part.rsplit(":", 1)[-1]
    publisher = normalize_space(publisher_part.strip(" ，,;；"))
    return publisher, publish_date


def clean_summary(value: str) -> str:
    value = normalize_space(value)
    for marker in [
        "参考文献格式",
        "获取 ：",
        "获取：",
        "免责声明",
        "//<![CDATA[",
        "目录试读",
    ]:
        index = value.find(marker)
        if index != -1:
            value = value[:index]
    return normalize_space(value)


def clean_classification(value: str) -> str:
    value = normalize_space(value)
    value = re.sub(r"(?<=[A-Za-z0-9.])�+(?=[A-Za-z0-9])", ";", value)
    return normalize_space(value)


def values_from_text_nodes(nodes: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    label_to_field: dict[str, str] = {}
    for field, aliases in FIELD_ALIASES.items():
        for alias in aliases:
            label_to_field[normalize_label(alias)] = field

    current_field = ""
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer, current_field
        if current_field and buffer and not values.get(current_field):
            values[current_field] = normalize_space(" ".join(buffer).strip(" :："))
        buffer = []

    for raw in nodes:
        text = normalize_space(raw)
        if not text:
            continue

        compact = normalize_label(text)
        if compact in label_to_field:
            flush()
            current_field = label_to_field[compact]
            continue

        matched_inline = False
        for compact_label, field in label_to_field.items():
            if compact.startswith(compact_label) and re.match(rf"^{flexible_label_pattern(compact_label)}\s*[：:]", text):
                flush()
                current_field = field
                value = re.sub(rf"^{flexible_label_pattern(compact_label)}\s*[：:]\s*", "", text, count=1)
                buffer = [value] if value else []
                matched_inline = True
                break
        if matched_inline:
            continue

        if current_field:
            buffer.append(text)

    flush()
    return values


def parse_book_detail(page_html: str, page_url: str, fallback_title: str = "") -> dict[str, str]:
    doc = html.fromstring(page_html)
    problem = detail_page_problem_from_doc(doc, page_url)
    if problem:
        raise ValueError(problem)

    nodes = text_nodes(doc)
    flat_text = normalize_space(" ".join(nodes))
    card_values = values_from_card_dds(doc)
    pairs = extract_pairs_from_tables(doc)
    node_values = values_from_text_nodes(nodes)

    extracted: dict[str, str] = {}

    for field, aliases in FIELD_ALIASES.items():
        if field in STRICT_CARD_FIELDS:
            extracted[field] = card_values.get(field, "")
        else:
            extracted[field] = (
                card_values.get(field, "")
                or value_from_pairs(pairs, aliases)
                or node_values.get(field, "")
                or value_from_text(flat_text, aliases)
            )

    # Some pages pack these values into an "其他" block, as the public Zotero
    # translator examples show.
    if not extracted.get("外文题名"):
        m = re.search(r"original-title:\s*(.*?)(?=\s+(?:original-author|creatorsExt|price|citeAs|CLC):|$)", flat_text, re.I)
        if m:
            extracted["外文题名"] = normalize_space(m.group(1))
    if not extracted.get("原书定价"):
        m = re.search(r"price:\s*([^\s]+)", flat_text, re.I)
        if m:
            extracted["原书定价"] = normalize_space(m.group(1))

    publisher, publish_date = split_publication(extracted.get("出版发行", ""))
    row = {field: "" for field in FIELDS}
    row["题名"] = extract_title(doc, nodes, flat_text, fallback_title)
    row["外文题名"] = extracted.get("外文题名", "")
    row["作者"] = extracted.get("作者", "")
    row["出版社"] = publisher
    row["发行时间"] = publish_date
    row["ISBN号"] = extracted.get("ISBN号", "")
    row["页数"] = extracted.get("页数", "")
    row["原书定价"] = extracted.get("原书定价", "")
    row["开本"] = extracted.get("开本", "")
    row["主题词"] = extracted.get("主题词", "")
    row["中图法分类号"] = clean_classification(extracted.get("中图法分类号", ""))
    row["内容提要"] = clean_summary(extracted.get("内容提要", ""))
    row["详情页Url"] = page_url

    return row


def write_outputs(rows: list[dict[str, str]], output_base: Path) -> None:
    output_base.parent.mkdir(parents=True, exist_ok=True)
    csv_path = output_base.with_suffix(".csv")
    json_path = output_base.with_suffix(".json")
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)


def make_session(args: argparse.Namespace) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": args.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
            "Referer": "https://book.duxiu.com/",
        }
    )
    if args.cookie:
        session.headers["Cookie"] = args.cookie.strip()
    elif args.cookie_file:
        session.headers["Cookie"] = Path(args.cookie_file).read_text(encoding="utf-8").strip()
    return session


def crawl(args: argparse.Namespace) -> tuple[list[dict[str, str]], CrawlStats]:
    session = make_session(args)
    stats = CrawlStats()
    detail_items: list[DetailItem] = []

    for page in range(1, args.pages + 1):
        page_url = args.url if page == 1 else build_page_url(args.url, page)
        resp = fetch(session, page_url, args.delay)
        page_text = resp.text
        err = access_error(page_text, resp.url)
        if err:
            raise RuntimeError(err)
        if looks_like_login(page_text, resp.url):
            raise RuntimeError(
                "请求被重定向到登录页。请先在浏览器登录读秀，然后用 --cookie 或 --cookie-file 传入登录 Cookie。"
            )
        stats.pages_seen += 1
        items = extract_detail_items(page_text, resp.url)
        stats.detail_urls_seen += len(items)
        detail_items.extend(items)
        print(f"[page {page}] found {len(items)} detail links", file=sys.stderr)

    detail_items = dedupe_detail_items(detail_items)
    stats.detail_urls_unique = len(detail_items)
    rows: list[dict[str, str]] = []

    for index, item in enumerate(detail_items, 1):
        resp = fetch(session, item.url, args.delay)
        err = access_error(resp.text, resp.url)
        if err:
            raise RuntimeError(err)
        if looks_like_login(resp.text, resp.url):
            print(f"[skip] login required for {item.url}", file=sys.stderr)
            continue
        problem = detail_page_problem(resp.text, resp.url)
        if problem:
            print(f"[skip] {problem}: {item.url}", file=sys.stderr)
            continue
        row = parse_book_detail(resp.text, resp.url, fallback_title=item.title)
        rows.append(row)
        stats.books_saved += 1
        print(f"[detail {index}/{len(detail_items)}] {row.get('题名') or item.url}", file=sys.stderr)

    return rows, stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Crawl Duxiu book metadata from the first N search pages.")
    parser.add_argument("--url", required=True, help="Duxiu search result URL.")
    parser.add_argument("--pages", type=int, default=5, help="Number of search result pages to crawl.")
    parser.add_argument("--output", default="output/duxiu_books", help="Output basename, without extension.")
    parser.add_argument("--cookie", help="Raw Cookie header copied from a logged-in browser.")
    parser.add_argument("--cookie-file", help="Text file containing a raw Cookie header.")
    parser.add_argument("--min-delay", type=float, default=1.0, help="Minimum delay between requests.")
    parser.add_argument("--max-delay", type=float, default=2.5, help="Maximum delay between requests.")
    parser.add_argument(
        "--user-agent",
        default="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    )
    args = parser.parse_args()
    if args.pages < 1:
        parser.error("--pages must be >= 1")
    if args.min_delay < 0 or args.max_delay < args.min_delay:
        parser.error("delay range is invalid")
    args.delay = (args.min_delay, args.max_delay)
    return args


def main() -> int:
    args = parse_args()
    try:
        rows, stats = crawl(args)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    output_base = Path(args.output)
    write_outputs(rows, output_base)
    print(
        f"Done. pages={stats.pages_seen}, detail_links={stats.detail_urls_seen}, "
        f"unique={stats.detail_urls_unique}, saved={stats.books_saved}"
    )
    print(f"CSV:  {output_base.with_suffix('.csv')}")
    print(f"JSON: {output_base.with_suffix('.json')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
