# mdview

Local Markdown viewer. The browser receives the file’s current text and draws it. Saving the file updates the open page. ` ```mermaid ` blocks are drawn with Mermaid 12, using the ELK layout. Each diagram and each image has a Zoom button. On the page and in that zoom view, drag to scroll, and use +/−/0 or a pinch to zoom.

```bash
mdview docs/planner-architecture.md
```

The command prints one URL and opens it:

```text
http://127.0.0.1:47321/?path=/absolute/path/to/file.md
```

Pass `--no-open` to print the URL without opening a browser. The server listens only on `127.0.0.1`. A later `mdview` reuses it.

Relative links and images are resolved from the Markdown file’s directory. A link to another `.md` file opens in this viewer. Other files are served from that same directory. Links that only jump to a heading stay on the page.

A Files button at the left edge opens a collapsible sidebar of Markdown files. It starts at the git repository that contains the open file, and folders that contain no Markdown stay out of the list.

Requires Python 3. Mermaid, Marked, and DOMPurify are downloaded once into `static/vendor/`.

## Security

The server listens on `127.0.0.1`. A request is rejected unless its Host header is `127.0.0.1:47321` or `localhost:47321`. A request whose Origin is not `http://127.0.0.1:47321` or `http://localhost:47321` is rejected. `/raw`, `/list`, and `/browse` only read inside the git root of a file opened with `mdview`. A file that is not in a git repository is limited to its own directory. Markdown is sanitized with DOMPurify before it is shown. The downloaded Mermaid, Marked, and DOMPurify files are checked against pinned SHA-256 hashes.
