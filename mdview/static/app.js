const doc = document.querySelector("#doc");
const tree = document.querySelector("#tree");
const browser = document.querySelector("#browser");
const browseButton = document.querySelector("#browse");
const closeButton = document.querySelector("#browse-close");
const upButton = document.querySelector("#browse-up");
const scrim = document.querySelector("#browse-scrim");
const rootLabel = document.querySelector("#browser-root");
const sourcePath = new URLSearchParams(location.search).get("path") || "";
const overlay = document.querySelector("#diagram-overlay");
const overlayStage = document.querySelector("#diagram-stage");
const overlayClose = document.querySelector("#diagram-close");

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
let activeDiagram = null;
let overlayDiagram = null;
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
  mountDiagrams();
}

function mountDiagrams() {
  doc.querySelectorAll(".mermaid").forEach((node) => {
    if (node.closest(".diagram")) return;
    const svg = node.querySelector("svg");
    if (!svg) return;
    const frame = document.createElement("figure");
    frame.className = "diagram";
    const view = document.createElement("div");
    view.className = "diagram-view";
    view.tabIndex = 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "diagram-zoom";
    button.textContent = "Zoom";
    node.before(frame);
    frame.append(button, view);
    view.append(node);
    const viewer = bindDiagram(view, svg, false);
    button.addEventListener("click", () => openZoom(svg));
    frame.addEventListener("pointerenter", () => {
      activeDiagram = viewer;
    });
    frame.addEventListener("pointerleave", () => {
      if (activeDiagram === viewer) activeDiagram = null;
    });
  });
}

function bindDiagram(view, svg, wheelZooms) {
  let scale = 1;
  let home = 1;
  let baseW = 1;
  let baseH = 1;
  let drag = null;

  function measure() {
    const box = svg.viewBox && svg.viewBox.baseVal;
    if (box && box.width > 0 && box.height > 0) {
      baseW = box.width;
      baseH = box.height;
      return;
    }
    const rect = svg.getBoundingClientRect();
    baseW = Math.max(1, rect.width / scale);
    baseH = Math.max(1, rect.height / scale);
  }

  function layout() {
    svg.style.width = `${baseW * scale}px`;
    svg.style.height = `${baseH * scale}px`;
  }

  function zoomBy(factor, clientX, clientY) {
    const next = Math.min(8, Math.max(0.2, scale * factor));
    if (Math.abs(next - scale) < 0.001) return;
    const rect = view.getBoundingClientRect();
    const px = clientX == null ? view.clientWidth / 2 : clientX - rect.left;
    const py = clientY == null ? view.clientHeight / 2 : clientY - rect.top;
    const anchorX = (view.scrollLeft + px) / scale;
    const anchorY = (view.scrollTop + py) / scale;
    scale = next;
    layout();
    view.scrollLeft = anchorX * scale - px;
    view.scrollTop = anchorY * scale - py;
  }

  function fit() {
    measure();
    const availW = Math.max(1, view.clientWidth - 32);
    const availH = Math.max(1, view.clientHeight - 32);
    const next = Math.min(8, Math.max(0.2, Math.min(availW / baseW, availH / baseH)));
    scale = next;
    home = next;
    layout();
    view.scrollLeft = Math.max(0, (view.scrollWidth - view.clientWidth) / 2);
    view.scrollTop = Math.max(0, (view.scrollHeight - view.clientHeight) / 2);
  }

  function reset() {
    if (wheelZooms) {
      fit();
      return;
    }
    scale = home;
    layout();
    view.scrollLeft = 0;
    view.scrollTop = 0;
  }

  measure();
  layout();
  if (!wheelZooms) {
    const style = getComputedStyle(view);
    const extra =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);
    view.style.setProperty("--diagram-frame", `${Math.ceil(baseH + extra)}px`);
  }

  view.addEventListener("wheel", (event) => {
    if (!(wheelZooms || event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    zoomBy(Math.exp(-event.deltaY * 0.0016), event.clientX, event.clientY);
  }, { passive: false });

  view.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("a, button")) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: view.scrollLeft,
      top: view.scrollTop,
    };
    view.setPointerCapture(event.pointerId);
  });
  view.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!view.classList.contains("is-dragging") && Math.hypot(dx, dy) < 4) return;
    view.classList.add("is-dragging");
    view.scrollLeft = drag.left - dx;
    view.scrollTop = drag.top - dy;
  });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    view.classList.remove("is-dragging");
  }
  view.addEventListener("pointerup", endDrag);
  view.addEventListener("pointercancel", endDrag);
  view.addEventListener("dragstart", (event) => event.preventDefault());

  return { zoomBy, reset, fit };
}

function openZoom(source) {
  closeZoom();
  const svg = source.cloneNode(true);
  svg.style.width = "";
  svg.style.height = "";
  overlayStage.replaceChildren(svg);
  overlay.hidden = false;
  overlayDiagram = bindDiagram(overlayStage, svg, true);
  overlayDiagram.fit();
  overlayClose.focus();
}

function closeZoom() {
  overlay.hidden = true;
  overlayStage.replaceChildren();
  overlayDiagram = null;
}

async function show(text, contentType) {
  closeZoom();
  activeDiagram = null;
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
overlayClose.addEventListener("click", closeZoom);
overlay.addEventListener("click", (event) => {
  if (event.target === overlay) closeZoom();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!overlay.hidden) {
      closeZoom();
      return;
    }
    if (!browser.hidden) setPanel(false);
    return;
  }
  if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
  const viewer = (!overlay.hidden && overlayDiagram) || activeDiagram;
  if (!viewer) return;
  const zoomIn = event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
  const zoomOut = event.key === "-" || event.key === "_" || event.code === "NumpadSubtract";
  const reset = !event.shiftKey && (event.key === "0" || event.code === "Numpad0");
  if (!zoomIn && !zoomOut && !reset) return;
  event.preventDefault();
  if (reset) viewer.reset();
  else viewer.zoomBy(zoomIn ? 1.15 : 1 / 1.15);
});

if (sessionStorage.getItem("mdview.panel") === "open") setPanel(true);
refresh();
setInterval(refresh, 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
