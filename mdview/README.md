# mdview

Local Markdown viewer. The browser receives the file’s current text and draws it. Saving the file updates the open page. ` ```mermaid ` blocks are drawn with Mermaid 12, using the ELK layout. Each diagram has a Zoom button. On the page and in that zoom view, drag to scroll, and use +/−/0 or a pinch to zoom.

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

Requires Python 3. Mermaid and Marked are downloaded once into `static/vendor/`.
