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
      <button type="button" data-action="open-source" title="Open in VS Code editor" aria-label="Open in VS Code editor">
        Source
      </button>
      <span class="status" id="status" aria-live="polite"></span>
      <button type="button" data-action="open-settings" title="Open settings" aria-label="Open settings">
        <svg class="toolbar-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
          <path d="M19.43 12.98C19.47 12.66 19.5 12.34 19.5 12C19.5 11.66 19.47 11.33 19.42 11.02L21.54 9.37C21.73 9.22 21.78 8.95 21.66 8.73L19.66 5.27C19.54 5.05 19.28 4.96 19.05 5.05L16.56 6.05C16.04 5.65 15.48 5.32 14.87 5.07L14.5 2.42C14.46 2.18 14.25 2 14 2H10C9.75 2 9.54 2.18 9.5 2.42L9.12 5.07C8.52 5.32 7.95 5.66 7.44 6.05L4.95 5.05C4.72 4.96 4.46 5.05 4.34 5.27L2.34 8.73C2.21 8.95 2.27 9.22 2.46 9.37L4.58 11.02C4.53 11.33 4.5 11.67 4.5 12C4.5 12.33 4.53 12.66 4.58 12.98L2.46 14.63C2.27 14.78 2.22 15.05 2.34 15.27L4.34 18.73C4.46 18.95 4.72 19.04 4.95 18.95L7.44 17.95C7.96 18.35 8.52 18.68 9.13 18.93L9.5 21.58C9.54 21.82 9.75 22 10 22H14C14.25 22 14.46 21.82 14.5 21.58L14.88 18.93C15.48 18.68 16.05 18.34 16.56 17.95L19.05 18.95C19.28 19.04 19.54 18.95 19.66 18.73L21.66 15.27C21.78 15.05 21.73 14.78 21.54 14.63L19.43 12.98ZM12 15.5C10.07 15.5 8.5 13.93 8.5 12C8.5 10.07 10.07 8.5 12 8.5C13.93 8.5 15.5 10.07 15.5 12C15.5 13.93 13.93 15.5 12 15.5Z"></path>
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
