#!/usr/bin/env python3
"""Local web console and resilient crawler for Duxiu book metadata."""

from __future__ import annotations

import csv
import json
import random
import threading
import time
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from crawl_duxiu_books import (
    FIELDS,
    access_error,
    build_page_url,
    detail_page_problem,
    extract_detail_items,
    looks_like_login,
    parse_book_detail,
)


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DEFAULT_URL = (
    "https://book.duxiu.com/search?Field=all&channel=search&sw=%E5%9B%BE%E4%B9%A6%E9%A6%86"
    "&ecode=utf-8&edtype=&searchtype=&view=0"
)


class CrawlBlocked(RuntimeError):
    """Raised when Duxiu asks for login, captcha, or institutional IP access."""


class CrawlConfig(BaseModel):
    searchUrl: str = DEFAULT_URL
    startPage: int | None = None
    pages: int = 666
    targetBooks: int = 10000
    workers: int = 5
    minDelay: float = 1.0
    maxDelay: float = 3.5
    retries: int = 2
    retryDelay: float = 2.0
    output: str = "output/duxiu_books"
    cookie: str = ""
    cookieFile: str = ""
    resume: bool = True
    flushEvery: int = 10
    saveBlockHtml: bool = True

    @property
    def search_url(self) -> str:
        return self.searchUrl

    @property
    def start_page(self) -> int | None:
        return self.startPage

    @property
    def target_books(self) -> int:
        return self.targetBooks

    @property
    def min_delay(self) -> float:
        return self.minDelay

    @property
    def max_delay(self) -> float:
        return self.maxDelay

    @property
    def retry_delay(self) -> float:
        return self.retryDelay

    @property
    def cookie_file(self) -> str:
        return self.cookieFile

    @property
    def flush_every(self) -> int:
        return self.flushEvery

    @property
    def save_block_html(self) -> bool:
        return self.saveBlockHtml

@dataclass
class CrawlMetrics:
    status: str = "idle"
    started_at: str = ""
    finished_at: str = ""
    stop_reason: str = ""
    pages_total: int = 0
    current_page: int = 0
    current_item: int = 0
    pages_completed: int = 0
    detail_links_seen: int = 0
    books_saved: int = 0
    failed_count: int = 0
    skipped_count: int = 0
    in_flight: int = 0
    last_page: int = 0
    last_item: int = 0
    last_title: str = ""
    last_url: str = ""


@dataclass
class PersistedState:
    version: int = 1
    status: str = "idle"
    search_url: str = ""
    output: str = ""
    start_page: int = 1
    end_page: int = 1
    target_books: int = 0
    workers: int = 1
    updated_at: str = ""
    last_page: int = 0
    last_item: int = 0
    last_title: str = ""
    last_url: str = ""
    stop_reason: str = ""
    books_saved: int = 0
    detail_links_seen: int = 0
    completed_pages: list[int] = field(default_factory=list)
    processed_urls: list[str] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)


class CrawlerService:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.metrics = CrawlMetrics()
        self.logs: deque[dict[str, str]] = deque(maxlen=1500)
        self.recent_rows: deque[dict[str, str]] = deque(maxlen=30)
        self.config: CrawlConfig | None = None
        self.state = PersistedState()
        self.rows: list[dict[str, str]] = []
        self.processed_urls: set[str] = set()
        self.completed_pages: set[int] = set()
        self.csv_file = None
        self.csv_writer: csv.DictWriter | None = None
        self.output_base = Path("output/duxiu_books")
        self.last_json_flush = 0

    def start(self, config: CrawlConfig) -> None:
        self._validate_config(config)
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise RuntimeError("爬虫正在运行，请先停止当前任务。")
            self.config = config
            self.stop_event.clear()
            self.metrics = CrawlMetrics(status="starting")
            self.logs.clear()
            self.recent_rows.clear()
            self.rows = []
            self.processed_urls = set()
            self.completed_pages = set()
            self.last_json_flush = 0
            self.output_base = Path(config.output)
            self.thread = threading.Thread(target=self._run, args=(config,), daemon=True)
            self.thread.start()

    def _validate_config(self, config: CrawlConfig) -> None:
        if not config.search_url.startswith(("http://", "https://")):
            raise RuntimeError("搜索 URL 必须以 http:// 或 https:// 开头。")
        if config.pages < 1:
            raise RuntimeError("页数必须大于等于 1。")
        if config.target_books < 1:
            raise RuntimeError("目标本数必须大于等于 1。")
        if config.workers < 1 or config.workers > 32:
            raise RuntimeError("线程数必须在 1 到 32 之间。")
        if config.min_delay < 0 or config.max_delay < config.min_delay:
            raise RuntimeError("随机停顿范围不正确：最大停顿必须大于等于最小停顿。")
        if config.retries < 0:
            raise RuntimeError("重试次数不能小于 0。")
        if config.retry_delay < 0:
            raise RuntimeError("重试等待不能小于 0。")

    def stop(self) -> None:
        self.stop_event.set()
        self.log("warn", "收到停止请求：会保存已完成记录后退出。")

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "metrics": asdict(self.metrics),
                "config": self.safe_config(),
                "logs": list(self.logs)[-300:],
                "recentRows": list(self.recent_rows),
                "state": asdict(self.state),
                "files": {
                    "csv": str(self.output_base.with_suffix(".csv")),
                    "json": str(self.output_base.with_suffix(".json")),
                    "state": str(self.output_base.with_suffix(".state.json")),
                    "log": str(self.output_base.with_suffix(".log")),
                },
            }

    def safe_config(self) -> dict[str, Any]:
        if not self.config:
            return {}
        data = self.config.model_dump(by_alias=True)
        data["cookie"] = "已填写" if data.get("cookie") else ""
        return data

    def log(self, level: str, message: str) -> None:
        item = {"time": now(), "level": level, "message": message}
        with self.lock:
            self.logs.append(item)
            log_path = self.output_base.with_suffix(".log")
            try:
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")
            except OSError:
                pass

    def _run(self, config: CrawlConfig) -> None:
        started = now()
        try:
            self._prepare_outputs(config)
            start_page, end_page = self._resolve_page_range(config)
            with self.lock:
                self.metrics.status = "running"
                self.metrics.started_at = started
                self.metrics.pages_total = max(0, end_page - start_page + 1)
                self.state.status = "running"
                self.state.search_url = config.search_url
                self.state.output = config.output
                self.state.start_page = start_page
                self.state.end_page = end_page
                self.state.target_books = config.target_books
                self.state.workers = config.workers
            self._save_state()
            self.log("info", f"启动爬虫：第 {start_page} 页到第 {end_page} 页，目标 {config.target_books} 本，线程 {config.workers}。")

            for page in range(start_page, end_page + 1):
                if self.stop_event.is_set() or self._target_reached(config):
                    break
                if page in self.completed_pages:
                    self.log("info", f"第 {page} 页已完成，跳过。")
                    continue
                self._crawl_page(config, page)

            final_status = "stopped" if self.stop_event.is_set() else "completed"
            if self._target_reached(config):
                final_status = "completed"
                self.log("info", f"达到目标数量：已保存 {self.metrics.books_saved} 本。")
            self._finish(final_status, self.metrics.stop_reason)
        except CrawlBlocked as exc:
            self._finish("blocked", str(exc))
        except Exception as exc:
            self._finish("error", str(exc))
        finally:
            self._close_outputs()

    def _prepare_outputs(self, config: CrawlConfig) -> None:
        self.output_base.parent.mkdir(parents=True, exist_ok=True)
        state_path = self.output_base.with_suffix(".state.json")
        json_path = self.output_base.with_suffix(".json")
        csv_path = self.output_base.with_suffix(".csv")

        if config.resume and state_path.exists():
            try:
                state_data = json.loads(state_path.read_text(encoding="utf-8"))
                self.state = PersistedState(**{k: v for k, v in state_data.items() if k in PersistedState.__dataclass_fields__})
                self.processed_urls = set(self.state.processed_urls)
                self.completed_pages = set(self.state.completed_pages)
                self.log("info", f"载入断点：最后保存第 {self.state.last_page} 页第 {self.state.last_item} 条。")
            except Exception as exc:
                self.log("warn", f"断点文件读取失败，将从配置页开始：{exc}")

        if config.resume and json_path.exists():
            try:
                self.rows = json.loads(json_path.read_text(encoding="utf-8"))
                for row in self.rows[-30:]:
                    self.recent_rows.append(row)
                self.metrics.books_saved = len(self.rows)
                self.state.books_saved = len(self.rows)
            except Exception as exc:
                self.log("warn", f"JSON 结果读取失败，将继续写新结果：{exc}")

        write_header = True
        mode = "w"
        if config.resume and csv_path.exists():
            try:
                with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
                    existing_header = next(csv.reader(f), [])
                if existing_header == FIELDS:
                    mode = "a"
                    write_header = False
                else:
                    backup = csv_path.with_suffix(f".csv.bak-{int(time.time())}")
                    csv_path.rename(backup)
                    self.log("warn", f"CSV 表头已变化，旧文件备份为 {backup}。")
            except StopIteration:
                pass
        self.csv_file = csv_path.open(mode, encoding="utf-8-sig", newline="")
        self.csv_writer = csv.DictWriter(self.csv_file, fieldnames=FIELDS)
        if write_header:
            self.csv_writer.writeheader()
            self.csv_file.flush()

    def _resolve_page_range(self, config: CrawlConfig) -> tuple[int, int]:
        if config.resume and config.start_page is None and self.state.last_page:
            start_page = self.state.last_page
        else:
            start_page = config.start_page or 1
        start_page = max(1, start_page)
        pages = max(1, config.pages)
        return start_page, start_page + pages - 1

    def _crawl_page(self, config: CrawlConfig, page: int) -> None:
        page_session = self._make_session(config)
        page_url = config.search_url if page == 1 else build_page_url(config.search_url, page)
        with self.lock:
            self.metrics.current_page = page
            self.metrics.current_item = 0
        self.log("info", f"抓取搜索页 {page}：{page_url}")
        resp = self._request(page_session, page_url, config, page=page, item=0)
        detail_items = extract_detail_items(resp.text, resp.url)
        with self.lock:
            self.metrics.detail_links_seen += len(detail_items)
            self.state.detail_links_seen = self.metrics.detail_links_seen
        self.log("info", f"第 {page} 页发现 {len(detail_items)} 条详情链接。")

        tasks = [(idx, item.url, item.title) for idx, item in enumerate(detail_items, 1) if item.url not in self.processed_urls]
        if not tasks:
            self._mark_page_completed(page)
            return

        with ThreadPoolExecutor(max_workers=max(1, config.workers)) as executor:
            futures = {
                executor.submit(self._crawl_detail, config, page, idx, url, search_title): (idx, url)
                for idx, url, search_title in tasks
                if not self.stop_event.is_set() and not self._target_reached(config)
            }
            while futures:
                done, _ = wait(futures, timeout=0.5, return_when=FIRST_COMPLETED)
                with self.lock:
                    self.metrics.in_flight = len(futures)
                if self.stop_event.is_set():
                    for future in futures:
                        future.cancel()
                    break
                for future in done:
                    idx, url = futures.pop(future)
                    try:
                        row = future.result()
                    except CrawlBlocked:
                        raise
                    except Exception as exc:
                        self._record_failure(page, idx, url, str(exc))
                        continue
                    if row:
                        self._save_row(row, page, idx, url, config)
                    if self._target_reached(config):
                        self.stop_event.set()
                        break

        with self.lock:
            self.metrics.in_flight = 0
        if not self.stop_event.is_set() and not self._target_reached(config):
            self._mark_page_completed(page)

    def _crawl_detail(
        self, config: CrawlConfig, page: int, item: int, url: str, search_title: str = ""
    ) -> dict[str, str] | None:
        if self.stop_event.is_set():
            return None
        with self.lock:
            self.metrics.current_page = page
            self.metrics.current_item = item
        session = self._make_session(config)
        resp = self._request(session, url, config, page=page, item=item)
        problem = detail_page_problem(resp.text, resp.url)
        if problem:
            self._save_debug_html(resp.text, "bad_detail", page, item, config)
            raise RuntimeError(problem)
        row = parse_book_detail(resp.text, resp.url, fallback_title=search_title)
        return row

    def _request(self, session: requests.Session, url: str, config: CrawlConfig, page: int, item: int) -> requests.Response:
        last_error = ""
        for attempt in range(1, max(1, config.retries) + 2):
            if self.stop_event.is_set():
                raise RuntimeError("任务已停止")
            time.sleep(random.uniform(config.min_delay, config.max_delay))
            try:
                resp = session.get(url, timeout=35)
                resp.raise_for_status()
                if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
                    resp.encoding = resp.apparent_encoding
                block_reason = self._detect_block(resp.text, resp.url)
                if block_reason:
                    with self.lock:
                        self.metrics.last_page = page
                        self.metrics.last_item = item
                        self.metrics.last_url = url
                        self.state.last_page = page
                        self.state.last_item = item
                        self.state.last_url = url
                    self._save_block_html(resp.text, page, item, config)
                    raise CrawlBlocked(f"{block_reason}；停止在第 {page} 页第 {item} 条。")
                return resp
            except CrawlBlocked:
                raise
            except Exception as exc:
                last_error = str(exc)
                if attempt <= config.retries:
                    self.log("warn", f"请求失败，重试 {attempt}/{config.retries}：第 {page} 页第 {item} 条，{last_error}")
                    time.sleep(config.retry_delay * attempt)
                else:
                    raise RuntimeError(last_error)
        raise RuntimeError(last_error or "请求失败")

    def _detect_block(self, text: str, final_url: str) -> str:
        err = access_error(text, final_url)
        if err:
            return err
        if looks_like_login(text, final_url):
            return "登录态失效或被重定向到登录页"
        block_words = [
            "验证码",
            "安全验证",
            "人机验证",
            "访问过于频繁",
            "请输入验证码",
            "异常访问",
            "操作太频繁",
        ]
        for word in block_words:
            if word in text[:5000]:
                return f"遇到验证/风控页面：{word}"
        return ""

    def _save_block_html(self, text: str, page: int, item: int, config: CrawlConfig) -> None:
        self._save_debug_html(text, "blocked_page", page, item, config)

    def _save_debug_html(self, text: str, prefix: str, page: int, item: int, config: CrawlConfig) -> None:
        if not config.save_block_html:
            return
        path = self.output_base.parent / "debug" / f"{prefix}_{page}_item_{item}.html"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            self.log("warn", f"已保存调试 HTML：{path}")
        except OSError as exc:
            self.log("warn", f"保存调试 HTML 失败：{exc}")

    def _save_row(self, row: dict[str, str], page: int, item: int, url: str, config: CrawlConfig) -> None:
        with self.lock:
            if url in self.processed_urls:
                self.metrics.skipped_count += 1
                return
            self.processed_urls.add(url)
            self.rows.append(row)
            self.recent_rows.append(row)
            self.metrics.books_saved += 1
            self.metrics.last_page = page
            self.metrics.last_item = item
            self.metrics.last_title = row.get("题名", "")
            self.metrics.last_url = url
            self.state.last_page = page
            self.state.last_item = item
            self.state.last_title = row.get("题名", "")
            self.state.last_url = url
            self.state.books_saved = self.metrics.books_saved
            self.state.processed_urls = sorted(self.processed_urls)
            if self.csv_writer and self.csv_file:
                self.csv_writer.writerow(row)
                self.csv_file.flush()
            self.log("info", f"保存：第 {page} 页第 {item} 条，{row.get('题名') or '未命名'}")
            if self.metrics.books_saved - self.last_json_flush >= max(1, config.flush_every):
                self._flush_json_locked()
            self._save_state_locked()

    def _record_failure(self, page: int, item: int, url: str, error: str) -> None:
        with self.lock:
            self.metrics.failed_count += 1
            self.state.failed.append({"page": page, "item": item, "url": url, "error": error, "time": now()})
            self.log("error", f"失败：第 {page} 页第 {item} 条，{error}")
            self._save_state_locked()

    def _mark_page_completed(self, page: int) -> None:
        with self.lock:
            self.completed_pages.add(page)
            self.metrics.pages_completed = len(self.completed_pages)
            self.state.completed_pages = sorted(self.completed_pages)
            self.state.last_page = max(self.state.last_page, page)
            self.state.last_item = self.state.last_item or 0
            self.log("info", f"第 {page} 页完成。")
            self._flush_json_locked()
            self._save_state_locked()

    def _finish(self, status: str, reason: str = "") -> None:
        with self.lock:
            self.metrics.status = status
            self.metrics.finished_at = now()
            self.metrics.stop_reason = reason
            self.state.status = status
            self.state.stop_reason = reason
            self.state.books_saved = self.metrics.books_saved
            self.state.processed_urls = sorted(self.processed_urls)
            self.state.completed_pages = sorted(self.completed_pages)
            self._flush_json_locked()
            self._save_state_locked()
        if reason:
            self.log("warn" if status in {"blocked", "stopped"} else "error", reason)
        self.log("info", f"任务结束：{status}。最后位置：第 {self.metrics.last_page} 页第 {self.metrics.last_item} 条。")

    def _flush_json_locked(self) -> None:
        json_path = self.output_base.with_suffix(".json")
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(self.rows, ensure_ascii=False, indent=2), encoding="utf-8")
        self.last_json_flush = self.metrics.books_saved

    def _save_state(self) -> None:
        with self.lock:
            self._save_state_locked()

    def _save_state_locked(self) -> None:
        self.state.updated_at = now()
        state_path = self.output_base.with_suffix(".state.json")
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(asdict(self.state), ensure_ascii=False, indent=2), encoding="utf-8")

    def _close_outputs(self) -> None:
        with self.lock:
            if self.csv_file:
                self.csv_file.flush()
                self.csv_file.close()
                self.csv_file = None
                self.csv_writer = None

    def _target_reached(self, config: CrawlConfig) -> bool:
        return config.target_books > 0 and self.metrics.books_saved >= config.target_books

    def _make_session(self, config: CrawlConfig) -> requests.Session:
        session = requests.Session()
        session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
                "Referer": "https://book.duxiu.com/",
            }
        )
        cookie = config.cookie.strip()
        if not cookie and config.cookie_file:
            cookie_path = Path(config.cookie_file).expanduser()
            if cookie_path.exists():
                cookie = cookie_path.read_text(encoding="utf-8").strip()
        if cookie:
            session.headers["Cookie"] = cookie
        return session


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


service = CrawlerService()
app = FastAPI(title="Duxiu Book Crawler Console")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/default-config")
def default_config() -> dict[str, Any]:
    return CrawlConfig().model_dump(by_alias=True)


@app.post("/api/start")
def start(config: CrawlConfig) -> dict[str, str]:
    try:
        service.start(config)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": "true"}


@app.post("/api/stop")
def stop() -> dict[str, str]:
    service.stop()
    return {"ok": "true"}


@app.get("/api/status")
def status() -> dict[str, Any]:
    return service.snapshot()


if __name__ == "__main__":
    try:
        uvicorn.run("crawler_app:app", host="127.0.0.1", port=8000, reload=False)
    except KeyboardInterrupt:
        pass
