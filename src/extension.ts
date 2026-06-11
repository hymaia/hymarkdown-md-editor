import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

const viewType = "markdownWysiwyg.editor";

type WebviewRequest =
  | { type: "uploadImage"; requestId: number; fileName: string; mimeType: string; dataUrl: string }
  | { type: "resolveWebviewUrl"; requestId: number; url: string }
  | { type: "print"; contentHtml: string };

type WebviewResponse =
  | { type: "uploadImageResult"; requestId: number; markdownPath: string }
  | { type: "uploadImageError"; requestId: number; error: string }
  | { type: "resolveWebviewUrlResult"; requestId: number; url: string }
  | { type: "resolveWebviewUrlError"; requestId: number; error: string };

export function activate(context: vscode.ExtensionContext) {
  const provider = new MarkdownWysiwygProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.commands.registerCommand("markdownWysiwyg.open", async (resource?: vscode.Uri) => {
      const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        vscode.window.showWarningMessage("Open a Markdown file first.");
        return;
      }

      await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
    }),
    vscode.commands.registerCommand("markdownWysiwyg.find", async () => {
      await provider.postToActivePanel({ type: "showFind", replace: false });
    }),
    vscode.commands.registerCommand("markdownWysiwyg.findReplace", async () => {
      await provider.postToActivePanel({ type: "showFind", replace: true });
    }),
    vscode.commands.registerCommand("markdownWysiwyg.print", async () => {
      await provider.postToActivePanel({ type: "print" });
    })
  );
}

export function deactivate() {}

class MarkdownWysiwygProvider implements vscode.CustomTextEditorProvider {
  private activePanel?: vscode.WebviewPanel;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async postToActivePanel(message: unknown): Promise<void> {
    if (!this.activePanel) {
      return;
    }

    await this.activePanel.webview.postMessage(message);
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): void {
    this.activePanel = webviewPanel;
    webviewPanel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) {
        this.activePanel = event.webviewPanel;
      }
    });

    const render = () => {
      const themeUri = this.resolveThemeUri(document.uri);
      const documentRoot = this.resolveDocumentRoot(document.uri);
      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "dist"),
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
          ...(documentRoot ? [documentRoot] : []),
          ...(themeUri ? [vscode.Uri.joinPath(themeUri, "..")] : [])
        ]
      };
      webviewPanel.webview.html = this.getHtml(webviewPanel.webview, document.uri, themeUri);
    };

    render();

    let webviewReady = false;

    const postDocument = () => {
      if (token.isCancellationRequested) {
        return;
      }

      if (!webviewReady) {
        return;
      }

      webviewPanel.webview.postMessage({
        type: "setMarkdown",
        markdown: document.getText()
      });
    };

    const documentListener = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString()) {
        postDocument();
      }
    });

    const configListener = vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration("markdownWysiwyg.themePath") ||
        event.affectsConfiguration("markdownWysiwyg.baseFontSize")
      ) {
        webviewReady = false;
        render();
      }
    });

    const messageListener = webviewPanel.webview.onDidReceiveMessage(async message => {
      if (message?.type === "ready") {
        webviewReady = true;
        postDocument();
        return;
      }

      if (message?.type === "openSource") {
        await vscode.commands.executeCommand("vscode.openWith", document.uri, "default", {
          preview: false,
          viewColumn: vscode.ViewColumn.Beside
        });
        return;
      }

      if (message?.type === "openSettings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:local.markdown-wysiwyg-editor markdownWysiwyg"
        );
        return;
      }

      if (message?.type === "print" && typeof message.contentHtml === "string") {
        await this.handlePrintRequest(document, message.contentHtml);
        return;
      }

      if (message?.type === "uploadImage") {
        await this.handleUploadImageRequest(webviewPanel.webview, document, message as WebviewRequest);
        return;
      }

      if (message?.type === "resolveWebviewUrl") {
        await this.handleResolveWebviewUrlRequest(
          webviewPanel.webview,
          document,
          message as WebviewRequest
        );
        return;
      }

      if (message?.type !== "updateMarkdown" || typeof message.markdown !== "string") {
        return;
      }

      if (message.markdown === document.getText()) {
        return;
      }

      await replaceDocument(document, message.markdown);
    });

    webviewPanel.onDidDispose(() => {
      documentListener.dispose();
      messageListener.dispose();
      configListener.dispose();
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
    });

    postDocument();
  }

  /**
   * Resolve the optional user theme CSS file into a filesystem Uri.
   * The "markdownWysiwyg.themePath" setting may be absolute, or relative to the
   * document's workspace folder. Returns undefined when unset or missing.
   */
  private resolveThemeUri(documentUri: vscode.Uri): vscode.Uri | undefined {
    const configured = vscode.workspace
      .getConfiguration("markdownWysiwyg", documentUri)
      .get<string>("themePath")
      ?.trim();
    if (!configured) {
      return undefined;
    }

    if (path.isAbsolute(configured)) {
      return vscode.Uri.file(configured);
    }

    const folder = vscode.workspace.getWorkspaceFolder(documentUri);
    const base = folder?.uri ?? vscode.Uri.joinPath(documentUri, "..");
    return vscode.Uri.joinPath(base, configured);
  }

  private getHtml(
    webview: vscode.Webview,
    resource: vscode.Uri,
    themeUri?: vscode.Uri
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "editor.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "editor.css")
    );
    const bundledEditorStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "editor.css")
    );
    const katexStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "katex", "katex.min.css")
    );
    const baseFontSize = this.resolveBaseFontSize(resource);
    // Loaded last so it can override the --mw-* design tokens from editor.css.
    const themeLink = themeUri
      ? `\n  <link href="${webview.asWebviewUri(themeUri)}" rel="stylesheet">`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} https://fonts.gstatic.com; style-src ${webview.cspSource} https://fonts.googleapis.com 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;500;600;700&family=Domine:wght@400..700&display=swap" rel="stylesheet">
  <link href="${katexStyleUri}" rel="stylesheet">
  <link href="${bundledEditorStyleUri}" rel="stylesheet">
  <link href="${styleUri}" rel="stylesheet">
  <style>:root { --mw-base-font-size: ${baseFontSize}px; }</style>${themeLink}
  <title>Markdown WYSIWYG</title>
</head>
<body data-resource="${escapeHtml(resource.toString())}">
  <div id="root">
    <div class="toolbar" role="toolbar" aria-label="Markdown formatting">
      <span class="status" id="status" aria-live="polite"></span>
      <button type="button" data-action="open-source" title="Open in VS Code editor" aria-label="Open in VS Code editor">
        <svg class="toolbar-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
          <path d="M14.06 9.02L14.98 9.94L5.92 19H5V18.08L14.06 9.02ZM17.66 3C17.41 3 17.15 3.1 16.96 3.29L15.13 5.12L18.88 8.87L20.71 7.04C21.1 6.65 21.1 6.02 20.71 5.63L18.37 3.29C18.17 3.09 17.92 3 17.66 3ZM14.06 6.19L3 17.25V21H6.75L17.81 9.94L14.06 6.19Z"/>
        </svg>
      </button>
      <button type="button" data-action="open-settings" title="Open settings" aria-label="Open settings">
        <svg class="toolbar-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
          <path fill-rule="evenodd" d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.13-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
        </svg>
      </button>
    </div>
    <main class="editor-shell" aria-label="Markdown document">
      <div id="editor" class="editor"></div>
    </main>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private resolveBaseFontSize(documentUri: vscode.Uri): number {
    const configured = vscode.workspace
      .getConfiguration("markdownWysiwyg", documentUri)
      .get<number>("baseFontSize", 16);
    if (!Number.isFinite(configured)) {
      return 16;
    }

    return Math.min(32, Math.max(8, configured));
  }

  private resolveDocumentRoot(documentUri: vscode.Uri): vscode.Uri | undefined {
    if (documentUri.scheme !== "file") {
      return undefined;
    }

    const folder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (folder) {
      return folder.uri;
    }

    return vscode.Uri.file(path.dirname(documentUri.fsPath));
  }

  private async handlePrintRequest(document: vscode.TextDocument, contentHtml: string): Promise<void> {
    const printDir = vscode.Uri.file(path.join(os.tmpdir(), "hymarkdown-print"));
    await vscode.workspace.fs.createDirectory(printDir);

    const baseName = sanitizeFileName(path.basename(document.uri.fsPath || "document.md", path.extname(document.uri.fsPath))) || "document";
    const targetUri = vscode.Uri.joinPath(printDir, `${baseName}-${Date.now()}.html`);
    const printTitle = path.basename(document.uri.fsPath || "document.md", path.extname(document.uri.fsPath)) || "document";
    const html = this.getPrintHtml(document.uri, contentHtml, printTitle);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(html, "utf8"));
    await vscode.env.openExternal(targetUri);
  }

  private getPrintHtml(documentUri: vscode.Uri, contentHtml: string, title: string): string {
    const distStyleUri = vscode.Uri.joinPath(this.context.extensionUri, "dist", "editor.css");
    const editorStyleUri = vscode.Uri.joinPath(this.context.extensionUri, "media", "editor.css");
    const katexStyleUri = vscode.Uri.joinPath(this.context.extensionUri, "media", "katex", "katex.min.css");
    const themeUri = this.resolveThemeUri(documentUri);
    const themeLink = themeUri ? `\n  <link href="${escapeHtml(themeUri.toString())}" rel="stylesheet">` : "";
    const baseFontSize = this.resolveBaseFontSize(documentUri);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1000">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;500;600;700&family=Domine:wght@400..700&display=swap" rel="stylesheet">
  <link href="${escapeHtml(katexStyleUri.toString())}" rel="stylesheet">
  <link href="${escapeHtml(distStyleUri.toString())}" rel="stylesheet">
  <link href="${escapeHtml(editorStyleUri.toString())}" rel="stylesheet">
  <style>:root { --mw-base-font-size: ${baseFontSize}px; }</style>${themeLink}
  <title>${escapeHtml(title)}</title>
  <script>
    window.addEventListener("load", () => {
      window.setTimeout(() => window.print(), 250);
    });
  </script>
</head>
<body class="mw-print">
  <div id="root">
    <div class="editor">
      <div class="milkdown">
        <div class="ProseMirror">
${contentHtml}
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  private async handleUploadImageRequest(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    message: WebviewRequest
  ): Promise<void> {
    if (message.type !== "uploadImage") {
      return;
    }

    try {
      const markdownPath = await saveImageNextToMarkdown(document, message);
      await postWebviewMessage(webview, {
        type: "uploadImageResult",
        requestId: message.requestId,
        markdownPath
      });
    } catch (error) {
      await postWebviewMessage(webview, {
        type: "uploadImageError",
        requestId: message.requestId,
        error: getErrorMessage(error)
      });
    }
  }

  private async handleResolveWebviewUrlRequest(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    message: WebviewRequest
  ): Promise<void> {
    if (message.type !== "resolveWebviewUrl") {
      return;
    }

    try {
      const url = resolveWebviewUrl(document, webview, message.url);
      await postWebviewMessage(webview, {
        type: "resolveWebviewUrlResult",
        requestId: message.requestId,
        url
      });
    } catch (error) {
      await postWebviewMessage(webview, {
        type: "resolveWebviewUrlError",
        requestId: message.requestId,
        error: getErrorMessage(error)
      });
    }
  }
}

async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  edit.replace(document.uri, fullRange, text);
  await vscode.workspace.applyEdit(edit);
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function postWebviewMessage(webview: vscode.Webview, message: WebviewResponse): Promise<void> {
  await webview.postMessage(message);
}

async function saveImageNextToMarkdown(
  document: vscode.TextDocument,
  message: Extract<WebviewRequest, { type: "uploadImage" }>
): Promise<string> {
  if (document.uri.scheme !== "file") {
    throw new Error("Save the Markdown file first so uploaded images can be copied next to it.");
  }

  const documentDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
  const targetName = await findAvailableImageName(documentDir, buildImageFileName(message.fileName, message.mimeType));
  const targetUri = vscode.Uri.joinPath(documentDir, targetName);
  const bytes = decodeDataUrl(message.dataUrl);
  await vscode.workspace.fs.writeFile(targetUri, bytes);

  const relative = path.relative(documentDir.fsPath, targetUri.fsPath).replaceAll(path.sep, "/");
  return encodeMarkdownUrlPath(relative || path.basename(targetUri.fsPath));
}

async function findAvailableImageName(
  directory: vscode.Uri,
  fileName: string
): Promise<string> {
  const parsed = path.parse(fileName);
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0 ? fileName : `${parsed.name}-${index}${parsed.ext}`;
    const candidateUri = vscode.Uri.joinPath(directory, candidate);
    try {
      await vscode.workspace.fs.stat(candidateUri);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return candidate;
      }

      throw error;
    }
  }

  throw new Error("Unable to find a free image filename.");
}

function buildImageFileName(fileName: string, mimeType: string): string {
  const sanitized = sanitizeFileName(path.basename(fileName));
  const parsed = path.parse(sanitized);
  const ext = parsed.ext || mimeTypeToExtension(mimeType) || ".png";
  const base = parsed.name || "image";
  return `${base}${ext.startsWith(".") ? ext : `.${ext}`}`;
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim() || "image";
}

function mimeTypeToExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tiff";
    case "image/avif":
      return ".avif";
    default:
      return "";
  }
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid image payload.");
  }

  const payload = match[3] ?? "";
  if (!match[2]) {
    return new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8"));
  }

  return new Uint8Array(Buffer.from(payload, "base64"));
}

function encodeMarkdownUrlPath(value: string): string {
  return value
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError &&
    error.code === "FileNotFound"
  );
}

function resolveWebviewUrl(
  document: vscode.TextDocument,
  webview: vscode.Webview,
  url: string
): string {
  if (!url.trim()) {
    return url;
  }

  if (isExternalImageUrl(url)) {
    return url;
  }

  if (url.startsWith("file:")) {
    return webview.asWebviewUri(vscode.Uri.parse(url)).toString();
  }

  if (document.uri.scheme !== "file") {
    return url;
  }

  const documentDir = path.dirname(document.uri.fsPath);
  const absolutePath = path.resolve(documentDir, decodeMarkdownUrlPath(url));
  return webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString();
}

function decodeMarkdownUrlPath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function isExternalImageUrl(url: string): boolean {
  return (
    url.startsWith("http:") ||
    url.startsWith("https:") ||
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("vscode-webview:")
  );
}
