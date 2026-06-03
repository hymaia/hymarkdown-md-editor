import * as path from "path";
import * as vscode from "vscode";

const viewType = "markdownWysiwyg.editor";

type WebviewRequest =
  | { type: "uploadImage"; requestId: number; fileName: string; mimeType: string; dataUrl: string }
  | { type: "resolveWebviewUrl"; requestId: number; url: string };

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
    })
  );
}

export function deactivate() {}

class MarkdownWysiwygProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): void {
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
      <button type="button" data-action="open-source" title="Open in VS Code editor" aria-label="Open in VS Code editor">Code</button>
      <span class="status" id="status" aria-live="polite"></span>
      <button type="button" data-action="open-settings" title="Open settings" aria-label="Open settings">
        <svg class="toolbar-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"></path>
          <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2.1 2.1 0 0 1-2.97 2.97l-.04-.04a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.09 1.65V21a2.1 2.1 0 0 1-4.2 0v-.06a1.8 1.8 0 0 0-1.18-1.65 1.8 1.8 0 0 0-1.98.36l-.04.04a2.1 2.1 0 0 1-2.97-2.97l.04-.04A1.8 1.8 0 0 0 3.75 15a1.8 1.8 0 0 0-1.65-1.09H2a2.1 2.1 0 0 1 0-4.2h.06A1.8 1.8 0 0 0 3.7 8.53a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2.1 2.1 0 0 1 2.97-2.97l.04.04a1.8 1.8 0 0 0 1.98.36H8.3A1.8 1.8 0 0 0 9.39 2.3V2a2.1 2.1 0 0 1 4.2 0v.06a1.8 1.8 0 0 0 1.09 1.65 1.8 1.8 0 0 0 1.98-.36l.04-.04a2.1 2.1 0 0 1 2.97 2.97l-.04.04a1.8 1.8 0 0 0-.36 1.98v.01a1.8 1.8 0 0 0 1.65 1.09H21a2.1 2.1 0 0 1 0 4.2h-.06A1.8 1.8 0 0 0 19.4 15Z"></path>
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
  return relative || path.basename(targetUri.fsPath);
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
  const absolutePath = path.resolve(documentDir, url);
  return webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString();
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
