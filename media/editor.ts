import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import texmath from "markdown-it-texmath";
import mermaid from "mermaid";
import katex from "katex";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

type VsCodeApi = {
  postMessage(message: unknown): void;
};

type IncomingMessage =
  | { type: "setMarkdown"; markdown: string }
  | { type: string; [key: string]: unknown };

declare const acquireVsCodeApi: () => VsCodeApi;

const TILDE = 0x7e;

// markdown-it ships GFM strikethrough for double tildes (`~~text~~`) but does
// not recognize single tildes (`~text~`). This inline rule adds single-tilde
// support so both forms render as <s>, matching the sample document.
function singleTildeStrikethrough(state: any, silent: boolean): boolean {
  const start = state.pos as number;
  if (silent) {
    return false;
  }
  if (state.src.charCodeAt(start) !== TILDE) {
    return false;
  }
  // Leave double tildes to the built-in GFM strikethrough rule.
  if (state.src.charCodeAt(start + 1) === TILDE) {
    return false;
  }

  const openScan = state.scanDelims(start, true);
  if (openScan.length !== 1 || !openScan.can_open) {
    return false;
  }

  let pos = start + 1;
  let close = -1;
  while (pos < state.posMax) {
    if (
      state.src.charCodeAt(pos) === TILDE &&
      state.src.charCodeAt(pos + 1) !== TILDE &&
      state.src.charCodeAt(pos - 1) !== TILDE
    ) {
      const closeScan = state.scanDelims(pos, true);
      if (closeScan.length === 1 && closeScan.can_close) {
        close = pos;
        break;
      }
    }
    pos += 1;
  }

  if (close < 0 || close === start + 1) {
    return false;
  }

  const tokenOpen = state.push("s_open", "s", 1);
  tokenOpen.markup = "~";

  const previousMax = state.posMax;
  state.pos = start + 1;
  state.posMax = close;
  state.md.inline.tokenize(state);
  state.pos = close + 1;
  state.posMax = previousMax;

  const tokenClose = state.push("s_close", "s", -1);
  tokenClose.markup = "~";
  return true;
}

const vscode = acquireVsCodeApi();
const markdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true
});
markdownIt.inline.ruler.after("emphasis", "single_tilde", singleTildeStrikethrough);
const defaultFenceRenderer = markdownIt.renderer.rules.fence;
markdownIt.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const language = token.info.trim().split(/\s+/)[0];
  if (language === "mermaid") {
    const code = token.content;
    return `<div class="mermaid-block" contenteditable="false" data-mermaid-source="${escapeAttribute(code)}"><div class="mermaid">${escapeHtml(code)}</div></div>`;
  }

  return defaultFenceRenderer
    ? defaultFenceRenderer(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};
markdownIt
  .use(texmath, {
    engine: katex,
    delimiters: "dollars",
    katexOptions: {
      throwOnError: false
    }
  })
  .use(markdownItTaskLists, {
    enabled: true,
    label: true
  });

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: document.body.classList.contains("vscode-dark") ? "dark" : "default"
});

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced"
});

turndown.use(gfm);
turndown.keep(["u"]);
turndown.addRule("frontmatterPanel", {
  filter(node) {
    return (
      node.nodeName === "SECTION" &&
      node instanceof HTMLElement &&
      node.classList.contains("frontmatter-panel")
    );
  },
  replacement() {
    return "";
  }
});
turndown.addRule("strikethrough", {
  filter(node) {
    if (["DEL", "S", "STRIKE"].includes(node.nodeName)) {
      return true;
    }

    // Chromium's execCommand("strikeThrough") can emit a styled span instead
    // of a <strike>/<s> element, so detect line-through spans as well.
    return (
      node instanceof HTMLElement &&
      node.nodeName === "SPAN" &&
      /line-through/.test(node.style.textDecorationLine || node.style.textDecoration || "")
    );
  },
  replacement(content) {
    return content ? `~~${content}~~` : "";
  }
});
turndown.addRule("mermaidBlock", {
  filter(node) {
    return (
      node.nodeName === "DIV" &&
      node instanceof HTMLElement &&
      node.classList.contains("mermaid-block")
    );
  },
  replacement(content, node) {
    if (!(node instanceof HTMLElement)) {
      return content;
    }

    const source = node.dataset.mermaidSource ?? "";
    return `\n\`\`\`mermaid\n${source.trimEnd()}\n\`\`\`\n`;
  }
});
turndown.addRule("katexDisplay", {
  filter(node) {
    return (
      node.nodeName === "SPAN" &&
      node instanceof HTMLElement &&
      node.classList.contains("katex-display")
    );
  },
  replacement(content, node) {
    const source = getKatexSource(node);
    return source ? `\n$$\n${source}\n$$\n` : content;
  }
});
turndown.addRule("katexInline", {
  filter(node) {
    return (
      node.nodeName === "SPAN" &&
      node instanceof HTMLElement &&
      node.classList.contains("katex") &&
      !node.closest(".katex-display")
    );
  },
  replacement(content, node) {
    const source = getKatexSource(node);
    return source ? `$${source}$` : content;
  }
});
turndown.addRule("taskListItem", {
  filter(node) {
    return (
      node.nodeName === "LI" &&
      node instanceof HTMLElement &&
      node.classList.contains("task-list-item")
    );
  },
  replacement(content, node) {
    if (!(node instanceof HTMLElement)) {
      return content;
    }

    const checkbox = node.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const checked = checkbox?.checked || checkbox?.hasAttribute("checked");
    const text = getTaskListItemText(node);
    return `- [${checked ? "x" : " "}] ${text}\n`;
  }
});

const editor = document.getElementById("editor") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const toolbar = document.querySelector(".toolbar") as HTMLElement;

let frontmatter = "";
let currentMarkdown = "";
let isApplyingExternalChange = false;
let emitTimer: number | undefined;
let activeTableCell: HTMLTableCellElement | null = null;

toolbar.addEventListener("mousedown", event => {
  if ((event.target as HTMLElement).closest("button, summary")) {
    event.preventDefault();
  }
});
toolbar.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) {
    return;
  }

  const command = button.dataset.command;
  const block = button.dataset.block;
  const action = button.dataset.action;

  if (action === "open-source") {
    emitChangeNow();
    vscode.postMessage({ type: "openSource" });
    return;
  }

  editor.focus();

  if (command) {
    document.execCommand(command);
    emitChangeSoon();
    return;
  }

  if (block) {
    applyBlock(block);
    emitChangeSoon();
    return;
  }

  if (action === "link") {
    const url = window.prompt("URL");
    if (url) {
      document.execCommand("createLink", false, url);
      emitChangeSoon();
    }
    return;
  }

  if (action === "code") {
    wrapSelection("code");
    emitChangeSoon();
    return;
  }

  if (action) {
    applyTableAction(action);
    emitChangeSoon();
  }
});
document.addEventListener("click", event => {
  if (!(event.target as HTMLElement).closest(".toolbar-menu")) {
    closeToolbarMenus();
  }
});

document.addEventListener("selectionchange", rememberSelectedTableCell);
editor.addEventListener("input", emitChangeSoon);
editor.addEventListener("focusin", event => {
  rememberTableCellFromTarget(event.target);
});
editor.addEventListener("focusout", () => {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (
      active instanceof Element &&
      (active.closest("td, th") || active.closest(".toolbar-menu"))
    ) {
      return;
    }

    clearActiveTableHighlights();
  }, 0);
});
editor.addEventListener("keydown", event => {
  const cell = getTableCellFromTarget(event.target) ?? activeTableCell;
  if (!cell) {
    return;
  }

  if (event.key === "Tab") {
    handleTableTab(event, cell);
    return;
  }

  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }

  const target = getKeyboardNavigationCell(cell, event.key);
  if (!target) {
    return;
  }

  event.preventDefault();
  focusCell(target);
});
editor.addEventListener("click", event => {
  rememberTableCellFromTarget(event.target);
  const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>(
    'input[type="checkbox"]'
  );
  if (!checkbox) {
    return;
  }

  syncCheckboxAttribute(checkbox);
  emitChangeNow();
});
editor.addEventListener("change", event => {
  const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>(
    'input[type="checkbox"]'
  );
  if (!checkbox) {
    return;
  }

  syncCheckboxAttribute(checkbox);
  emitChangeNow();
});
editor.addEventListener("blur", emitChangeNow);
editor.addEventListener("paste", event => {
  event.preventDefault();

  const html = event.clipboardData?.getData("text/html");
  if (html) {
    insertNormalizedHtmlPaste(html);
    return;
  }

  const text = event.clipboardData?.getData("text/plain");
  if (!text) {
    return;
  }

  insertNormalizedTextPaste(text);
});

window.addEventListener("message", event => {
  const message = event.data as IncomingMessage;
  if (message.type !== "setMarkdown" || typeof message.markdown !== "string") {
    return;
  }

  if (message.markdown === currentMarkdown && editor.innerHTML.trim() !== "") {
    return;
  }

  applyMarkdown(message.markdown);
});

vscode.postMessage({ type: "ready" });

function applyMarkdown(markdown: string): void {
  isApplyingExternalChange = true;
  const parsed = splitFrontmatter(markdown);
  frontmatter = parsed.frontmatter;
  currentMarkdown = markdown;
  editor.innerHTML = renderFrontmatterTable(parsed.frontmatter) + markdownIt.render(parsed.body);
  prepareRichContent();
  setStatus("Loaded");
  isApplyingExternalChange = false;
}

function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const match = markdown.match(/^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: "", body: markdown };
  }

  return {
    frontmatter: match[0],
    body: markdown.slice(match[0].length)
  };
}

function emitChangeSoon(): void {
  if (isApplyingExternalChange) {
    return;
  }

  setStatus("Editing");
  window.clearTimeout(emitTimer);
  emitTimer = window.setTimeout(emitChangeNow, 250);
}

function emitChangeNow(): void {
  if (isApplyingExternalChange) {
    return;
  }

  window.clearTimeout(emitTimer);
  frontmatter = getFrontmatterFromTable() ?? frontmatter;
  const body = normalizeMarkdown(turndown.turndown(editor.innerHTML));
  const nextMarkdown = frontmatter + body;
  commitMarkdown(nextMarkdown, "Saved from rich editor");
}

function commitMarkdown(markdown: string, label: string): void {
  currentMarkdown = markdown;
  vscode.postMessage({ type: "updateMarkdown", markdown });
  setStatus(label);
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

type FrontmatterRow = {
  key: string;
  value: string;
  kind: "scalar" | "list";
};

function renderFrontmatterTable(rawFrontmatter: string): string {
  if (!rawFrontmatter) {
    return "";
  }

  const rows = parseFrontmatterRows(rawFrontmatter);
  if (rows.length === 0) {
    return `<section class="frontmatter-panel" contenteditable="false"><div class="frontmatter-title">Frontmatter</div><pre>${escapeHtml(rawFrontmatter.trim())}</pre></section>`;
  }

  const tableRows = rows
    .map(
      row =>
        `<tr data-kind="${row.kind}"><th scope="row" data-key="${escapeAttribute(row.key)}">${escapeHtml(row.key)}</th><td contenteditable="true" data-frontmatter-value="${escapeAttribute(row.key)}">${escapeHtml(row.value)}</td></tr>`
    )
    .join("");

  return `<section class="frontmatter-panel" contenteditable="false"><div class="frontmatter-title">Frontmatter</div><table><tbody>${tableRows}</tbody></table></section>`;
}

function parseFrontmatterRows(rawFrontmatter: string): FrontmatterRow[] {
  const lines = rawFrontmatter
    .replace(/^---[ \t]*\r?\n/, "")
    .replace(/\r?\n---[ \t]*(?:\r?\n)?$/, "")
    .split(/\r?\n/);
  const rows: FrontmatterRow[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const scalar = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!scalar) {
      continue;
    }

    const key = scalar[1];
    const value = scalar[2] ?? "";
    const list: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const item = lines[cursor].match(/^\s*-\s*(.*)$/);
      if (!item) {
        break;
      }

      list.push(item[1]);
      cursor += 1;
    }

    if (list.length > 0 && value === "") {
      rows.push({ key, value: list.join(", "), kind: "list" });
      index = cursor - 1;
    } else {
      rows.push({ key, value, kind: "scalar" });
    }
  }

  return rows;
}

function getFrontmatterFromTable(): string | null {
  const panel = editor.querySelector<HTMLElement>(".frontmatter-panel");
  if (!panel) {
    return null;
  }

  const rows = Array.from(panel.querySelectorAll<HTMLTableRowElement>("tr"));
  if (rows.length === 0) {
    return frontmatter;
  }

  const lines = ["---"];
  for (const row of rows) {
    const keyCell = row.querySelector<HTMLElement>("[data-key]");
    // Original rows carry the key in data-key; rows added via Tab have an
    // editable <th>, so fall back to its text content.
    const key = (keyCell?.textContent?.trim() || keyCell?.dataset.key || "").trim();
    const value = row.querySelector<HTMLElement>("[data-frontmatter-value]")?.textContent?.trim() ?? "";
    if (!key) {
      continue;
    }

    if (row.dataset.kind === "list") {
      lines.push(`${key}:`);
      for (const item of value.split(",").map(item => item.trim()).filter(Boolean)) {
        lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function prepareRichContent(): void {
  for (const link of Array.from(editor.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    link.title = link.href;
    link.rel = "noreferrer";
  }

  for (const math of Array.from(editor.querySelectorAll<HTMLElement>(".katex, .katex-display"))) {
    math.contentEditable = "false";
  }

  renderMermaidBlocks();
  updateActiveTableHighlights();
}

function syncCheckboxAttribute(checkbox: HTMLInputElement): void {
  if (checkbox.checked) {
    checkbox.setAttribute("checked", "checked");
  } else {
    checkbox.removeAttribute("checked");
  }
}

function getTaskListItemText(item: HTMLElement): string {
  const clone = item.cloneNode(true) as HTMLElement;
  clone.querySelector('input[type="checkbox"]')?.remove();
  return clone.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function getKatexSource(node: Node): string {
  if (!(node instanceof HTMLElement)) {
    return "";
  }

  return (
    node.querySelector<HTMLElement>('annotation[encoding="application/x-tex"]')?.textContent?.trim() ??
    ""
  );
}

function renderMermaidBlocks(): void {
  const blocks = Array.from(editor.querySelectorAll<HTMLElement>(".mermaid-block .mermaid"));
  if (blocks.length === 0) {
    return;
  }

  mermaid.run({ nodes: blocks }).catch(error => {
    console.error("[Markdown WYSIWYG] Mermaid render failed", error);
  });
}

function insertNormalizedHtmlPaste(html: string): void {
  const markdown = turndown.turndown(html).trim();
  const rendered = markdownIt.render(markdown);
  document.execCommand("insertHTML", false, rendered);
  prepareRichContent();
  emitChangeSoon();
}

function insertNormalizedTextPaste(text: string): void {
  if (looksLikeMarkdown(text)) {
    document.execCommand("insertHTML", false, markdownIt.render(text));
    prepareRichContent();
  } else {
    document.execCommand("insertText", false, text);
  }

  emitChangeSoon();
}

function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\||-\s+\[[ xX]\]\s)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\[[^\]]+\]\([^)]+\))/.test(
    text
  );
}

function applyTableAction(action: string): void {
  if (action === "table") {
    insertTable();
    return;
  }

  const cell = getSelectedTableCell() ?? activeTableCell;
  if (!cell) {
    setStatus("Place cursor in a table");
    return;
  }

  if (isFrontmatterCell(cell)) {
    setStatus("Frontmatter table cannot be structurally edited");
    return;
  }

  switch (action) {
    case "row-after":
      insertRowAfter(cell);
      break;
    case "column-after":
      insertColumnAfter(cell);
      break;
    case "delete-row":
      deleteRow(cell);
      break;
    case "delete-column":
      deleteColumn(cell);
      break;
  }
}

function insertTable(): void {
  document.execCommand(
    "insertHTML",
    false,
    `<table><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead><tbody><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><p><br></p>`
  );
  rememberSelectedTableCell();
  updateActiveTableHighlights();
}

function getSelectedTableCell(): HTMLTableCellElement | null {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  if (element && editor.contains(element) && !element.closest("td, th")) {
    clearActiveTableHighlights();
    return null;
  }

  const cell = getTableCellFromTarget(element ?? null);
  if (cell) {
    activeTableCell = cell;
  }
  return cell;
}

function rememberSelectedTableCell(): void {
  const cell = getSelectedTableCell();
  if (cell) {
    activeTableCell = cell;
    updateActiveTableHighlights();
  }
}

function rememberTableCellFromTarget(target: EventTarget | null): void {
  const cell = getTableCellFromTarget(target);
  if (cell) {
    activeTableCell = cell;
    updateActiveTableHighlights();
    return;
  }

  if (target instanceof Element && editor.contains(target)) {
    clearActiveTableHighlights();
  }
}

function insertRowAfter(cell: HTMLTableCellElement): void {
  const row = cell.parentElement as HTMLTableRowElement | null;
  if (!row) {
    return;
  }

  const next = row.cloneNode(true) as HTMLTableRowElement;
  for (const nextCell of Array.from(next.cells)) {
    nextCell.innerHTML = "<br>";
  }
  row.after(next);
  focusCell(next.cells[Math.min(cell.cellIndex, next.cells.length - 1)]);
  updateActiveTableHighlights();
}

function getTabbableCells(cell: HTMLTableCellElement): HTMLTableCellElement[] {
  const table = cell.closest("table");
  if (!table) {
    return [cell];
  }

  // Document-order cells; in the frontmatter panel (contenteditable=false)
  // only the editable value <td> qualifies, so Tab walks value cells only.
  return Array.from(table.rows)
    .flatMap(row => Array.from(row.cells) as HTMLTableCellElement[])
    .filter(candidate => candidate.isContentEditable);
}

function handleTableTab(event: KeyboardEvent, cell: HTMLTableCellElement): void {
  event.preventDefault();
  const cells = getTabbableCells(cell);
  const index = cells.indexOf(cell);

  if (event.shiftKey) {
    if (index > 0) {
      focusCell(cells[index - 1]);
    }
    return;
  }

  if (index >= 0 && index < cells.length - 1) {
    focusCell(cells[index + 1]);
    return;
  }

  // Last (bottom-right) cell: grow the structure instead of leaving it.
  if (isFrontmatterCell(cell)) {
    appendFrontmatterRow(cell);
  } else {
    appendTableRow(cell);
  }
  emitChangeSoon();
}

function appendTableRow(cell: HTMLTableCellElement): void {
  const table = cell.closest("table");
  const body = table?.tBodies[0] ?? (cell.parentElement?.parentElement as HTMLElement | null);
  const templateRow = (body?.lastElementChild ?? cell.parentElement) as HTMLTableRowElement | null;
  if (!body || !templateRow) {
    return;
  }

  const next = templateRow.cloneNode(true) as HTMLTableRowElement;
  for (const nextCell of Array.from(next.cells)) {
    nextCell.innerHTML = "<br>";
  }
  body.appendChild(next);
  focusCell(next.cells[0]);
  updateActiveTableHighlights();
}

function appendFrontmatterRow(cell: HTMLTableCellElement): void {
  const body = cell.closest("tbody") ?? cell.closest("table");
  if (!body) {
    return;
  }

  const row = document.createElement("tr");
  row.dataset.kind = "scalar";
  const key = document.createElement("th");
  key.scope = "row";
  key.contentEditable = "true";
  key.dataset.key = "";
  key.innerHTML = "<br>";
  const value = document.createElement("td");
  value.contentEditable = "true";
  value.setAttribute("data-frontmatter-value", "");
  value.innerHTML = "<br>";
  row.append(key, value);
  body.appendChild(row);

  // Land on the new key so the user can name the field first.
  focusCell(key);
  updateActiveTableHighlights();
}

function insertColumnAfter(cell: HTMLTableCellElement): void {
  const table = cell.closest("table");
  const index = cell.cellIndex;
  if (!table || index < 0) {
    return;
  }

  for (const row of Array.from(table.rows)) {
    const reference = row.cells[index];
    const newCell = document.createElement(reference?.tagName.toLowerCase() === "th" ? "th" : "td");
    newCell.innerHTML = reference?.tagName.toLowerCase() === "th" ? "Column" : "<br>";
    reference?.after(newCell);
  }
  const nextCell = cell.parentElement?.children[index + 1] as HTMLTableCellElement | undefined;
  focusCell(nextCell);
  updateActiveTableHighlights();
}

function deleteRow(cell: HTMLTableCellElement): void {
  const row = cell.parentElement as HTMLTableRowElement | null;
  const table = cell.closest("table");
  if (!row || !table || table.tBodies[0]?.rows.length <= 1 || row.parentElement?.tagName === "THEAD") {
    setStatus("Cannot delete this row");
    return;
  }

  const nextFocus = (row.nextElementSibling ?? row.previousElementSibling)?.children[
    Math.min(cell.cellIndex, row.cells.length - 1)
  ] as HTMLTableCellElement | undefined;
  row.remove();
  focusCell(nextFocus);
  updateActiveTableHighlights();
}

function deleteColumn(cell: HTMLTableCellElement): void {
  const table = cell.closest("table");
  const index = cell.cellIndex;
  if (!table || index < 0 || table.rows[0]?.cells.length <= 1) {
    return;
  }

  const focusIndex = Math.max(0, index - 1);
  let nextFocus: HTMLTableCellElement | undefined;
  for (const row of Array.from(table.rows)) {
    row.cells[index]?.remove();
    nextFocus ??= row.cells[focusIndex];
  }
  focusCell(nextFocus);
  updateActiveTableHighlights();
}

function focusCell(cell?: HTMLTableCellElement): void {
  if (!cell) {
    return;
  }

  activeTableCell = cell;
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  updateActiveTableHighlights();
}

function closeToolbarMenus(): void {
  for (const menu of Array.from(toolbar.querySelectorAll<HTMLDetailsElement>("details"))) {
    menu.open = false;
  }
}

function getTableCellFromTarget(target: EventTarget | null): HTMLTableCellElement | null {
  const element = target instanceof Element ? target : null;
  return element?.closest("td, th") as HTMLTableCellElement | null;
}

function clearActiveTableHighlights(): void {
  activeTableCell = null;
  clearTableHighlightClasses();
}

function clearTableHighlightClasses(): void {
  for (const highlighted of Array.from(
    editor.querySelectorAll(".table-active-row, .table-active-column, .table-active-cell")
  )) {
    highlighted.classList.remove("table-active-row", "table-active-column", "table-active-cell");
  }
}

function updateActiveTableHighlights(): void {
  const cell = activeTableCell;
  clearTableHighlightClasses();
  const table = cell?.closest("table");
  if (!cell || !table || !table.isConnected) {
    return;
  }

  const row = cell.parentElement as HTMLTableRowElement | null;
  const columnIndex = cell.cellIndex;
  row?.classList.add("table-active-row");
  cell.classList.add("table-active-cell");

  if (columnIndex < 0) {
    return;
  }

  for (const tableRow of Array.from(table.rows)) {
    tableRow.cells[columnIndex]?.classList.add("table-active-column");
  }
}

function getKeyboardNavigationCell(
  cell: HTMLTableCellElement,
  key: string
): HTMLTableCellElement | null {
  const table = cell.closest("table");
  const row = cell.parentElement as HTMLTableRowElement | null;
  if (!table || !row) {
    return null;
  }

  const rows = Array.from(table.rows);
  const rowIndex = rows.indexOf(row);
  const cellIndex = cell.cellIndex;
  if (rowIndex < 0 || cellIndex < 0) {
    return null;
  }

  if (key === "ArrowUp") {
    const previousRow = rows[rowIndex - 1];
    return previousRow?.cells[Math.min(cellIndex, previousRow.cells.length - 1)] ?? null;
  }

  if (key === "ArrowDown") {
    const nextRow = rows[rowIndex + 1];
    return nextRow?.cells[Math.min(cellIndex, nextRow.cells.length - 1)] ?? null;
  }

  if (key === "ArrowLeft") {
    if (cellIndex > 0) {
      return row.cells[cellIndex - 1];
    }

    const previousRow = rows[rowIndex - 1];
    return previousRow?.cells[previousRow.cells.length - 1] ?? null;
  }

  if (key === "ArrowRight") {
    if (cellIndex < row.cells.length - 1) {
      return row.cells[cellIndex + 1];
    }

    const nextRow = rows[rowIndex + 1];
    return nextRow?.cells[0] ?? null;
  }

  return null;
}

function isFrontmatterCell(cell: HTMLTableCellElement): boolean {
  return Boolean(cell.closest(".frontmatter-panel"));
}

function applyBlock(block: string): void {
  switch (block) {
    case "h1":
      document.execCommand("formatBlock", false, "h1");
      break;
    case "h2":
      document.execCommand("formatBlock", false, "h2");
      break;
    case "blockquote":
      document.execCommand("formatBlock", false, "blockquote");
      break;
  }
}

function wrapSelection(tagName: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  if (range.collapsed) {
    const element = document.createElement(tagName);
    element.textContent = "code";
    range.insertNode(element);
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }

  const element = document.createElement(tagName);
  element.appendChild(range.extractContents());
  range.insertNode(element);
  selection.removeAllRanges();
}

function setStatus(label: string): void {
  status.textContent = label;
  window.setTimeout(() => {
    if (status.textContent === label) {
      status.textContent = "";
    }
  }, 1200);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
