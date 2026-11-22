const doc = document.querySelector("#doc");
const tree = document.querySelector("#tree");
const browser = document.querySelector("#browser");
const browseButton = document.querySelector("#browse");
const closeButton = document.querySelector("#browse-close");
const upButton = document.querySelector("#browse-up");
const scrim = document.querySelector("#browse-scrim");
const rootLabel = document.querySelector("#browser-root");
const sourcePath = new URLSearchParams(location.search).get("path") || "";

const renderer = new marked.Renderer();
renderer.code = function (token, info) {
  const text = typeof token === "string" ? token : token.text;
  const lang = (typeof token === "string" ? info : token.lang) || "";
  if (lang.split(/\s+/)[0] === "mermaid") {
    return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
  }
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
};
marked.use({ renderer, gfm: true });

mermaid.initialize({
  startOnLoad: false,
  layout: "elk",
  securityLevel: "strict",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  themeVariables: { fontSize: "16px" },
  flowchart: { useMaxWidth: false, htmlLabels: true, padding: 18 },
  sequence: { useMaxWidth: false, actorFontSize: 16, messageFontSize: 15, noteFontSize: 15 },
  er: { useMaxWidth: false, fontSize: 15 },
});

let etag = "";
let generation = 0;
let initial = true;
let root = "";
let parentPath = "";
let treeReady = false;
const listings = new Map();
const expanded = new Set();

function escapeHtml(value) {
  return value.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

function slug(value) {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return base || "section";
}

function assignHeadingIds() {
  const used = new Map();
  doc.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading) => {
    let id = slug(heading.textContent);
    const count = used.get(id) || 0;
    used.set(id, count + 1);
    if (count) id = `${id}-${count + 1}`;
    heading.id = id;
  });
}

function resolveLink(href) {
  if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) return null;
  const hashAt = href.indexOf("#");
  const fragment = hashAt >= 0 ? href.slice(hashAt) : "";
  const raw = hashAt >= 0 ? href.slice(0, hashAt) : href;
  if (!raw) return null;
  const directory = sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1);
  const url = new URL(raw, `file://${directory}`);
  return { path: decodeURIComponent(url.pathname), fragment };
}

function rewriteLinks() {
  doc.querySelectorAll("a[href], img[src]").forEach((node) => {
    const attr = node.tagName === "IMG" ? "src" : "href";
    const resolved = resolveLink(node.getAttribute(attr));
    if (!resolved) return;
    const markdown = /\.(?:md|markdown)$/i.test(resolved.path);
    const target = markdown
      ? `/?path=${encodeURIComponent(resolved.path)}${resolved.fragment}`
      : `/raw?path=${encodeURIComponent(resolved.path)}`;
    node.setAttribute(attr, target);
  });
}

async function drawDiagrams() {
  const nodes = [...doc.querySelectorAll(".mermaid")];
  if (!nodes.length) return;
  try {
    await mermaid.run({ nodes });
  } catch (error) {
    const note = document.createElement("p");
    note.className = "diagram-error";
    note.textContent = error.message || String(error);
    doc.prepend(note);
  }
}

async function show(text, contentType) {
  const gen = ++generation;
  const scroll = initial ? 0 : window.scrollY;
  if (contentType.startsWith("image/")) {
    doc.innerHTML = `<p><img alt="" src="/raw?path=${encodeURIComponent(sourcePath)}" /></p>`;
  } else if (/\.(?:md|markdown)$/i.test(sourcePath)) {
    doc.innerHTML = marked.parse(text);
    assignHeadingIds();
    rewriteLinks();
    await drawDiagrams();
  } else {
    doc.innerHTML = `<pre><code>${escapeHtml(text)}</code></pre>`;
  }
  if (gen !== generation) return;
  const heading = doc.querySelector("h1");
  document.title = heading ? heading.textContent : sourcePath.split("/").pop() || "mdview";
  if (initial && location.hash) {
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  } else if (!initial) {
    window.scrollTo(0, scroll);
  }
  initial = false;
}

function fail(message) {
  browseButton.title = message;
  if (initial) {
    doc.innerHTML = `<p class="diagram-error">${escapeHtml(message)}</p>`;
    initial = false;
  }
}

async function refresh() {
  if (!sourcePath) {
    fail("Pass a file to mdview.");
    return;
  }
  if (document.hidden) return;
  const response = await fetch(`/raw?path=${encodeURIComponent(sourcePath)}`, {
    cache: "no-store",
    headers: etag ? { "If-None-Match": etag } : {},
  });
  if (response.status === 304) return;
  if (!response.ok) {
    fail(response.status === 404 ? "File is not there." : "Could not read the file.");
    return;
  }
  browseButton.title = "Files";
  etag = response.headers.get("ETag") || "";
  const type = response.headers.get("Content-Type") || "";
  await show(type.startsWith("image/") ? "" : await response.text(), type);
}

function setPanel(open) {
  document.body.classList.toggle("panel-open", open);
  browser.hidden = !open;
  scrim.hidden = !open;
  browseButton.setAttribute("aria-expanded", String(open));
  sessionStorage.setItem("mdview.panel", open ? "open" : "closed");
  if (!open) {
    browseButton.focus();
    return;
  }
  if (!treeReady) loadTree();
  else revealCurrent();
}

function revealCurrent() {
  tree.querySelector(".is-current")?.scrollIntoView({ block: "nearest" });
}

async function loadTree() {
  tree.replaceChildren(note("Loading…"));
  const query = sourcePath ? `?path=${encodeURIComponent(sourcePath)}` : "";
  const response = await fetch(`/browse${query}`, { cache: "no-store" });
  if (!response.ok) {
    tree.replaceChildren(note("Could not read the folders."));
    return;
  }
  const data = await response.json();
  applyRoot(data);
  listings.clear();
  expanded.clear();
  for (const [dir, entries] of Object.entries(data.listings)) {
    listings.set(dir, entries);
    expanded.add(dir);
  }
  treeReady = true;
  renderTree();
  revealCurrent();
}

function applyRoot(data) {
  root = data.root || data.path;
  parentPath = data.parent || "";
  rootLabel.textContent = data.label || root;
  rootLabel.title = root;
  upButton.hidden = !parentPath;
}

function note(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "tree-empty";
  paragraph.textContent = message;
  return paragraph;
}

async function listDir(path) {
  const response = await fetch(`/list?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Could not read this folder.");
  return response.json();
}

async function toggleDir(path) {
  if (expanded.has(path)) {
    expanded.delete(path);
    renderTree();
    return;
  }
  expanded.add(path);
  renderTree();
  if (listings.has(path)) return;
  try {
    const data = await listDir(path);
    listings.set(path, data.entries);
  } catch (error) {
    expanded.delete(path);
    listings.set(path, []);
    tree.prepend(note(error.message));
  }
  renderTree();
}

async function ascend() {
  if (!parentPath) return;
  try {
    const data = await listDir(parentPath);
    applyRoot(data);
    listings.set(data.path, data.entries);
    expanded.add(data.path);
    renderTree();
  } catch (error) {
    tree.prepend(note(error.message));
  }
}

function renderTree() {
  const box = document.createElement("div");
  box.append(renderDir(root, 0));
  tree.replaceChildren(box);
}

function renderDir(path, depth) {
  const wrap = document.createElement("div");
  const entries = listings.get(path);
  if (!entries) {
    wrap.append(note("Loading…"));
    return wrap;
  }
  if (!entries.length && depth === 0) {
    wrap.append(note("No Markdown files"));
    return wrap;
  }
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "tree-item";
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${depth * 14}px`;
    if (entry.kind === "dir") {
      const open = expanded.has(entry.path);
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.dir = entry.path;
      button.setAttribute("aria-expanded", String(open));
      button.append(icon("chevron"), label(entry.name));
      row.append(button);
      item.append(row);
      if (open) item.append(renderDir(entry.path, depth + 1));
    } else {
      const link = document.createElement("a");
      link.href = `/?path=${encodeURIComponent(entry.path)}`;
      if (entry.path === sourcePath) {
        link.className = "is-current";
        link.setAttribute("aria-current", "page");
      }
      link.append(icon("tree-spacer"), label(entry.name));
      row.append(link);
      item.append(row);
    }
    wrap.append(item);
  }
  return wrap;
}

function icon(className) {
  const span = document.createElement("span");
  span.className = className;
  span.setAttribute("aria-hidden", "true");
  return span;
}

function label(name) {
  const span = document.createElement("span");
  span.className = "tree-name";
  span.textContent = name;
  return span;
}

tree.addEventListener("click", (event) => {
  const button = event.target.closest("[data-dir]");
  if (!button) return;
  toggleDir(button.dataset.dir);
});
browseButton.addEventListener("click", () => setPanel(browser.hidden));
closeButton.addEventListener("click", () => setPanel(false));
scrim.addEventListener("click", () => setPanel(false));
upButton.addEventListener("click", ascend);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !browser.hidden) setPanel(false);
});

if (sessionStorage.getItem("mdview.panel") === "open") setPanel(true);
refresh();
setInterval(refresh, 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
