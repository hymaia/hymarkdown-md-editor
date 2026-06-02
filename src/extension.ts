import * as path from "path";
import * as vscode from "vscode";

const viewType = "markdownWysiwyg.editor";

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
      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "dist"),
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
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
      if (event.affectsConfiguration("markdownWysiwyg.themePath")) {
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
    const katexStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "katex", "katex.min.css")
    );
    // Loaded last so it can override the --mw-* design tokens from editor.css.
    const themeLink = themeUri
      ? `\n  <link href="${webview.asWebviewUri(themeUri)}" rel="stylesheet">`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${katexStyleUri}" rel="stylesheet">
  <link href="${styleUri}" rel="stylesheet">${themeLink}
  <title>Markdown WYSIWYG</title>
</head>
<body data-resource="${escapeHtml(resource.toString())}">
  <div id="root">
    <div class="toolbar" role="toolbar" aria-label="Markdown formatting">
      <button type="button" data-command="bold" title="Bold" aria-label="Bold"><strong>B</strong></button>
      <button type="button" data-command="italic" title="Italic" aria-label="Italic"><em>I</em></button>
      <button type="button" data-command="strikeThrough" title="Strikethrough" aria-label="Strikethrough"><s>S</s></button>
      <span class="divider"></span>
      <button type="button" data-block="h1" title="Heading 1" aria-label="Heading 1">H1</button>
      <button type="button" data-block="h2" title="Heading 2" aria-label="Heading 2">H2</button>
      <button type="button" data-block="blockquote" title="Quote" aria-label="Quote">"</button>
      <span class="divider"></span>
      <button type="button" data-command="insertUnorderedList" title="Bullet list" aria-label="Bullet list">-</button>
      <button type="button" data-command="insertOrderedList" title="Numbered list" aria-label="Numbered list">1.</button>
      <button type="button" data-action="link" title="Insert link" aria-label="Insert link">@</button>
      <button type="button" data-action="code" title="Inline code" aria-label="Inline code">&lt;/&gt;</button>
      <span class="divider"></span>
      <details class="toolbar-menu">
        <summary title="Table tools" aria-label="Table tools">
          <svg class="table-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <rect x="4" y="4" width="16" height="16" rx="1.5"></rect>
            <line x1="12" y1="4" x2="12" y2="20"></line>
            <line x1="4" y1="12" x2="20" y2="12"></line>
          </svg>
        </summary>
        <div class="toolbar-menu-popover" role="menu" aria-label="Table tools">
          <button type="button" data-action="table" title="Insert table" aria-label="Insert table">
            <svg class="table-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <rect x="4" y="4" width="16" height="16" rx="1.5"></rect>
              <line x1="12" y1="4" x2="12" y2="20"></line>
              <line x1="4" y1="12" x2="20" y2="12"></line>
            </svg>
          </button>
          <button type="button" data-action="row-after" title="Add row" aria-label="Add row">
            <svg class="table-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <rect x="3" y="4" width="18" height="6" rx="1"></rect>
              <line x1="12" y1="15" x2="12" y2="21"></line>
              <line x1="9" y1="18" x2="15" y2="18"></line>
            </svg>
          </button>
          <button type="button" data-action="delete-row" title="Remove row" aria-label="Remove row">
            <svg class="table-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <rect x="3" y="4" width="18" height="6" rx="1"></rect>
              <line x1="9" y1="18" x2="15" y2="18"></line>
            </svg>
          </button>
          <button type="button" data-action="column-after" title="Add column" aria-label="Add column">
            <svg class="table-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <rect x="4" y="3" width="6" height="18" rx="1"></rect>
              <line x1="18" y1="9" x2="18" y2="15"></line>
              <line x1="15" y1="12" x2="21" y2="12"></line>
            </svg>
          </button>
          <button type="button" data-action="delete-column" title="Remove column" aria-label="Remove column">
            <svg class="table-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <rect x="4" y="3" width="6" height="18" rx="1"></rect>
              <line x1="15" y1="12" x2="21" y2="12"></line>
            </svg>
          </button>
        </div>
      </details>
      <span class="divider"></span>
      <button type="button" data-action="open-source" title="Open in VS Code editor" aria-label="Open in VS Code editor">Code</button>
      <span class="status" id="status" aria-live="polite"></span>
      <button type="button" data-action="open-settings" title="Open settings" aria-label="Open settings">
        <svg class="toolbar-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"></path>
          <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2.1 2.1 0 0 1-2.97 2.97l-.04-.04a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.09 1.65V21a2.1 2.1 0 0 1-4.2 0v-.06a1.8 1.8 0 0 0-1.18-1.65 1.8 1.8 0 0 0-1.98.36l-.04.04a2.1 2.1 0 0 1-2.97-2.97l.04-.04A1.8 1.8 0 0 0 3.75 15a1.8 1.8 0 0 0-1.65-1.09H2a2.1 2.1 0 0 1 0-4.2h.06A1.8 1.8 0 0 0 3.7 8.53a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2.1 2.1 0 0 1 2.97-2.97l.04.04a1.8 1.8 0 0 0 1.98.36H8.3A1.8 1.8 0 0 0 9.39 2.3V2a2.1 2.1 0 0 1 4.2 0v.06a1.8 1.8 0 0 0 1.09 1.65 1.8 1.8 0 0 0 1.98-.36l.04-.04a2.1 2.1 0 0 1 2.97 2.97l-.04.04a1.8 1.8 0 0 0-.36 1.98v.01a1.8 1.8 0 0 0 1.65 1.09H21a2.1 2.1 0 0 1 0 4.2h-.06A1.8 1.8 0 0 0 19.4 15Z"></path>
        </svg>
      </button>
    </div>
    <main id="editor" class="editor" contenteditable="true" spellcheck="true" aria-label="Markdown document"></main>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
