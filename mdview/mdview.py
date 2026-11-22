#!/usr/bin/env python3
"""Open a Markdown file in a local browser page that redraws when the file changes."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 47321
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
VENDOR = STATIC / "vendor"
STATE = Path.home() / ".local" / "share" / "mdview"
VENDORS = {
    "marked.min.js": "https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js",
    "mermaid.min.js": "https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js",
}
SKIP_NAMES = {
    ".git",
    "node_modules",
    "__pycache__",
    ".next",
    "dist",
    "build",
    ".venv",
    "venv",
    "coverage",
    ".turbo",
}
MARKDOWN = {".md", ".markdown"}
TYPES = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
}


def _pretty(path: Path) -> str:
    home = Path.home().resolve()
    try:
        relative = path.resolve().relative_to(home)
    except ValueError:
        return str(path)
    text = relative.as_posix()
    return "~" if text == "." else f"~/{text}"


def _parent(directory: Path) -> str | None:
    parent = directory.parent
    if parent == directory or directory == Path.home().resolve():
        return None
    if parent in {Path("/"), Path("/Users"), Path("/private")}:
        return None
    return str(parent)


def _project_root(start: Path) -> Path:
    current = start.resolve()
    if current.is_file():
        current = current.parent
    origin = current
    home = Path.home().resolve()
    while True:
        if (current / ".git").exists():
            return current
        if current == home or current.parent == current:
            return origin
        current = current.parent


def _chain(directory: Path, root: Path) -> list[Path]:
    directory = directory.resolve()
    root = root.resolve()
    if directory != root and root not in directory.parents:
        return [root]
    chain = []
    current = directory
    while True:
        chain.append(current)
        if current == root or current.parent == current:
            break
        current = current.parent
    chain.reverse()
    return chain


def _contains_markdown(directory: Path, max_depth: int = 6) -> bool:
    try:
        for dirpath, dirnames, filenames in os.walk(directory):
            dirnames[:] = [
                name for name in dirnames if not name.startswith(".") and name not in SKIP_NAMES
            ]
            if len(Path(dirpath).relative_to(directory).parts) >= max_depth:
                dirnames[:] = []
            for name in filenames:
                if name.startswith("."):
                    continue
                if Path(name).suffix.lower() in MARKDOWN:
                    return True
    except OSError:
        return False
    return False


def _list_dir(directory: Path) -> list[dict]:
    entries = []
    try:
        children = list(directory.iterdir())
    except OSError:
        return entries
    for child in children:
        name = child.name
        if name.startswith(".") or name in SKIP_NAMES:
            continue
        try:
            if child.is_dir():
                if _contains_markdown(child):
                    entries.append({"name": name, "path": str(child.resolve()), "kind": "dir"})
            elif child.is_file() and child.suffix.lower() in MARKDOWN:
                entries.append({"name": name, "path": str(child.resolve()), "kind": "file"})
        except OSError:
            continue
    entries.sort(key=lambda entry: (entry["kind"] != "dir", entry["name"].casefold()))
    return entries


def page_url(path: Path) -> str:
    quoted = urllib.parse.quote(str(path), safe="/")
    return f"http://{HOST}:{PORT}/?path={quoted}"


def ensure_vendor() -> None:
    VENDOR.mkdir(parents=True, exist_ok=True)
    for name, url in VENDORS.items():
        target = VENDOR / name
        if target.stat().st_size > 0 if target.exists() else False:
            continue
        try:
            urllib.request.urlretrieve(url, target)
        except Exception as error:
            raise SystemExit(f"mdview: could not download {name}: {error}") from error


class Handler(BaseHTTPRequestHandler):
    server_version = "mdview"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            self._bytes(200, b"ok", "text/plain; charset=utf-8")
            return
        if path in ("/", "/index.html"):
            self._static(STATIC / "index.html")
            return
        if path == "/app.css":
            self._static(STATIC / "app.css")
            return
        if path == "/app.js":
            self._static(STATIC / "app.js")
            return
        if path.startswith("/vendor/"):
            self._static(VENDOR / Path(path).name)
            return
        if path == "/raw":
            self._raw()
            return
        if path == "/list":
            self._list()
            return
        if path == "/browse":
            self._browse()
            return
        self._bytes(404, b"not found", "text/plain; charset=utf-8")

    def _absolute(self) -> tuple[Path | None, bool]:
        requested = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("path", [""])[0]
        if not requested:
            return None, False
        candidate = Path(requested).expanduser()
        if not candidate.is_absolute():
            self._bytes(400, b"path must be absolute", "text/plain; charset=utf-8")
            return None, True
        try:
            return candidate.resolve(strict=True), False
        except FileNotFoundError:
            self._bytes(404, b"not found", "text/plain; charset=utf-8")
            return None, True

    def _browse(self) -> None:
        target, failed = self._absolute()
        if failed:
            return
        if target is None:
            target = Path.home().resolve()
        root = _project_root(target)
        directory = target if target.is_dir() else target.parent
        listings = {str(folder): _list_dir(folder) for folder in _chain(directory, root)}
        self._json(
            200,
            {
                "root": str(root),
                "parent": _parent(root),
                "label": _pretty(root),
                "current": str(target) if target.is_file() else "",
                "listings": listings,
            },
        )

    def _list(self) -> None:
        target, failed = self._absolute()
        if failed:
            return
        if target is None:
            self._bytes(400, b"missing path", "text/plain; charset=utf-8")
            return
        directory = target if target.is_dir() else target.parent
        self._json(
            200,
            {
                "path": str(directory),
                "parent": _parent(directory),
                "label": _pretty(directory),
                "entries": _list_dir(directory),
            },
        )

    def _json(self, status: int, payload: dict) -> None:
        self._bytes(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _raw(self) -> None:
        requested = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("path", [""])[0]
        if not requested:
            self._bytes(400, b"missing path", "text/plain; charset=utf-8")
            return
        candidate = Path(requested).expanduser()
        if not candidate.is_absolute():
            self._bytes(400, b"path must be absolute", "text/plain; charset=utf-8")
            return
        try:
            found = candidate.resolve(strict=True)
        except FileNotFoundError:
            self._bytes(404, b"not found", "text/plain; charset=utf-8")
            return
        if not found.is_file():
            self._bytes(404, b"not a file", "text/plain; charset=utf-8")
            return
        stat = found.stat()
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        body = found.read_bytes()
        content_type = TYPES.get(found.suffix.lower(), "")
        if not content_type:
            content_type = "text/plain; charset=utf-8" if _text(body) else "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, file: Path) -> None:
        if not file.is_file():
            self._bytes(404, b"not found", "text/plain; charset=utf-8")
            return
        self._bytes(200, file.read_bytes(), TYPES.get(file.suffix.lower(), "application/octet-stream"))

    def _bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def _text(body: bytes) -> bool:
    if b"\0" in body[:1024]:
        return False
    try:
        body.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def healthy() -> bool:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/health", timeout=0.4) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def ensure_server() -> None:
    ensure_vendor()
    if healthy():
        return
    STATE.mkdir(parents=True, exist_ok=True)
    log = open(STATE / "server.log", "a", encoding="utf-8")
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "serve"],
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(50):
        if healthy():
            return
        time.sleep(0.1)
    raise SystemExit("mdview: the local page did not start. See ~/.local/share/mdview/server.log")


def serve() -> None:
    ensure_vendor()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Open Markdown in a browser page that follows file saves.")
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--no-open", action="store_true", help="print the URL without opening a browser")
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve()
        return
    args = parser.parse_args()
    if not args.files:
        parser.error("give at least one Markdown file")
    ensure_server()
    for file in args.files:
        found = file.expanduser().resolve(strict=True)
        if not found.is_file():
            raise SystemExit(f"mdview: not a file: {found}")
        url = page_url(found)
        print(url)
        if not args.no_open:
            webbrowser.open(url)


if __name__ == "__main__":
    main()
