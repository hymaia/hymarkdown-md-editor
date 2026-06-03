import * as crepeModule from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import * as codeBlockModule from "@milkdown/components/code-block";
import mermaid from "mermaid";
import { aiSkillsMetadataPlugin } from "./milkdown-frontmatter";

type VsCodeApi = {
  postMessage(message: unknown): void;
};

type IncomingMessage =
  | { type: "setMarkdown"; markdown: string }
  | { type: "uploadImageResult"; requestId: number; markdownPath: string }
  | { type: "uploadImageError"; requestId: number; error: string }
  | { type: "resolveWebviewUrlResult"; requestId: number; url: string }
  | { type: "resolveWebviewUrlError"; requestId: number; error: string }
  | { type: string; [key: string]: unknown };

type OutgoingMessage =
  | { type: "ready" }
  | { type: "openSource" }
  | { type: "openSettings" }
  | { type: "updateMarkdown"; markdown: string }
  | { type: "uploadImage"; requestId: number; fileName: string; mimeType: string; dataUrl: string }
  | { type: "resolveWebviewUrl"; requestId: number; url: string };

type OutgoingRequest =
  | { type: "uploadImage"; fileName: string; mimeType: string; dataUrl: string }
  | { type: "resolveWebviewUrl"; url: string };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById("editor");
const status = document.getElementById("status");
const toolbar = document.querySelector(".toolbar");

if (!root || !status || !toolbar) {
  throw new Error("Markdown WYSIWYG editor host is missing required DOM nodes.");
}

type CrepeConstructor = new (config: unknown) => {
  create(): Promise<unknown>;
  destroy(): Promise<unknown>;
  getMarkdown(): string;
  on(fn: (listener: {
    markdownUpdated(fn: (_ctx: unknown, markdown: string) => void): void;
    mounted(fn: () => void): void;
  }) => void): void;
  editor: {
    config(fn: (ctx: { update<T>(key: unknown, fn: (value: T) => T): void }) => void): {
      use(plugin: unknown): unknown;
    };
  };
};
type CodeBlockConfig = {
  renderPreview: (
    language: string,
    content: string,
    applyPreview: (value: null | string | HTMLElement) => void
  ) => void | null | string | HTMLElement;
};
type UploadOptions = {
  uploader: (
    files: FileList,
    schema: {
      nodes: Record<
        string,
        | {
            createAndFill(attrs: { src: string }): { type?: unknown; attrs?: unknown } | null;
          }
        | undefined
      >;
    }
  ) => Promise<unknown>;
  enableHtmlFileUploader: boolean;
  uploadWidgetFactory: (pos: number, spec: unknown) => unknown;
  getInsertPos?: (
    event: ClipboardEvent | DragEvent,
    ctx: unknown,
    defaultInsertPos: number
  ) => number;
};
type ImageBlockConfig = {
  onUpload: (file: File) => Promise<string>;
};
type InlineImageConfig = {
  onUpload: (file: File) => Promise<string>;
};

const { Crepe } = crepeModule as typeof crepeModule & { Crepe: CrepeConstructor };
const { codeBlockConfig } = codeBlockModule as typeof codeBlockModule & {
  codeBlockConfig: { key: unknown };
};
const editorRoot: HTMLElement = root;
const statusElement: HTMLElement = status;

let editor: InstanceType<CrepeConstructor> | undefined;
let currentMarkdown = "";
let isApplyingExternalChange = false;
let emitTimer: number | undefined;
let mermaidRenderId = 0;
let nextRequestId = 1;

const pendingRequests = new Map<
  number,
  {
    resolve(value: unknown): void;
    reject(reason?: unknown): void;
  }
>();

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: getMermaidTheme()
});

toolbar.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  if (action === "open-source") {
    emitChangeNow();
    vscode.postMessage({ type: "openSource" });
    return;
  }

  if (action === "open-settings") {
    emitChangeNow();
    vscode.postMessage({ type: "openSettings" });
  }
});

window.addEventListener("message", event => {
  const message = event.data as IncomingMessage;
  if (message.type !== "setMarkdown" || typeof message.markdown !== "string") {
    if (
      message.type === "uploadImageResult" &&
      typeof message.requestId === "number" &&
      typeof message.markdownPath === "string"
    ) {
      resolvePendingRequest(message.requestId, message.markdownPath);
      return;
    }

    if (
      message.type === "uploadImageError" &&
      typeof message.requestId === "number" &&
      typeof message.error === "string"
    ) {
      rejectPendingRequest(message.requestId, new Error(message.error));
      return;
    }

    if (
      message.type === "resolveWebviewUrlResult" &&
      typeof message.requestId === "number" &&
      typeof message.url === "string"
    ) {
      resolvePendingRequest(message.requestId, message.url);
      return;
    }

    if (
      message.type === "resolveWebviewUrlError" &&
      typeof message.requestId === "number" &&
      typeof message.error === "string"
    ) {
      rejectPendingRequest(message.requestId, new Error(message.error));
      return;
    }

    return;
  }

  if (message.markdown === currentMarkdown && editor) {
    return;
  }

  void applyMarkdown(message.markdown);
});

window.addEventListener("beforeunload", () => {
  emitChangeNow();
  void editor?.destroy();
});

vscode.postMessage({ type: "ready" } satisfies OutgoingMessage);

async function applyMarkdown(markdown: string): Promise<void> {
  isApplyingExternalChange = true;
  window.clearTimeout(emitTimer);
  currentMarkdown = markdown;
  setStatus("Loading");

  await editor?.destroy();
  editorRoot.replaceChildren();

  editor = new Crepe({
    root: editorRoot,
    defaultValue: markdown,
    features: {
      [crepeModule.CrepeFeature.TopBar]: true,
      [crepeModule.CrepeFeature.AI]: false
    },
    featureConfigs: {
      [crepeModule.CrepeFeature.Placeholder]: {
        text: "Start writing...",
        mode: "block"
      },
      [crepeModule.CrepeFeature.CodeMirror]: {
        previewOnlyByDefault: false,
        previewLabel: "Preview",
        previewToggleButton: (previewOnlyMode: boolean) =>
          previewOnlyMode ? "Edit" : "Preview"
      }
    }
  });

  editor.editor
    .config(ctx => {
      ctx.update<UploadOptions>("uploadConfig", (previous: UploadOptions) => ({
        ...previous,
        uploader: async (files, schema) => {
          const images: File[] = [];

          for (let i = 0; i < files.length; i += 1) {
            const file = files.item(i);
            if (file && file.type.includes("image")) {
              images.push(file);
            }
          }

          const nodeType = schema.nodes["image-block"] ?? schema.nodes.image;
          if (!nodeType) {
            return [];
          }

          const nodes = await Promise.all(
            images.map(async file => nodeType.createAndFill({ src: await uploadImageFile(file) }))
          );

          return nodes.filter((node): node is NonNullable<typeof node> => Boolean(node));
        }
      }));
      ctx.update<ImageBlockConfig>("imageBlockConfigCtx", (previous: ImageBlockConfig) => ({
        ...previous,
        onUpload: uploadImageFile,
        proxyDomURL: resolveDomUrl
      }));
      ctx.update<InlineImageConfig>("inlineImageConfigCtx", (previous: InlineImageConfig) => ({
        ...previous,
        onUpload: uploadImageFile,
        proxyDomURL: resolveDomUrl
      }));
      ctx.update<CodeBlockConfig>(codeBlockConfig.key, previous => ({
        ...previous,
        renderPreview: (language, content, applyPreview) => {
          if (language.toLowerCase() !== "mermaid" || content.trim().length === 0) {
            return previous.renderPreview(language, content, applyPreview);
          }

          applyPreview('<div class="mermaid-preview">Rendering diagram...</div>');
          const id = `mermaid-${Date.now()}-${mermaidRenderId++}`;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: getMermaidTheme()
          });
          mermaid
            .render(id, content)
            .then(({ svg }) => {
              applyPreview(`<div class="mermaid-preview">${svg}</div>`);
            })
            .catch(error => {
              applyPreview(
                `<div class="mermaid-preview">${escapeHtml(getErrorMessage(error))}</div>`
              );
            });
        }
      }));
    })
    .use(aiSkillsMetadataPlugin);

  editor.on(listener => {
    listener.markdownUpdated((_ctx, markdownValue) => {
      if (isApplyingExternalChange) {
        return;
      }

      void markdownValue;
      emitChangeSoon();
    });
    listener.mounted(() => {
      isApplyingExternalChange = false;
      setStatus("Loaded");
    });
  });

  try {
    await editor.create();
  } catch (error) {
    isApplyingExternalChange = false;
    setStatus("Failed to load");
    console.error(error);
  }
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
  if (isApplyingExternalChange || !editor) {
    return;
  }

  window.clearTimeout(emitTimer);
  const markdown = normalizeMarkdown(editor.getMarkdown());
  if (markdown === currentMarkdown) {
    setStatus("Saved");
    return;
  }

  currentMarkdown = markdown;
  vscode.postMessage({ type: "updateMarkdown", markdown });
  setStatus("Saved");
}

function normalizeMarkdown(markdown: string): string {
  return markdown.trimEnd() + "\n";
}

function setStatus(message: string): void {
  statusElement.textContent = message;
}

async function uploadImageFile(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const result = await postWebviewRequest<{ markdownPath: string }>({
    type: "uploadImage",
    fileName: file.name,
    mimeType: file.type,
    dataUrl
  });
  return result.markdownPath;
}

async function resolveDomUrl(url: string): Promise<string> {
  if (isExternalImageUrl(url)) {
    return url;
  }

  try {
    const result = await postWebviewRequest<{ url: string }>({
      type: "resolveWebviewUrl",
      url
    });
    return result.url;
  } catch {
    return url;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Image upload did not produce a data URL."));
    });

    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read uploaded image."));
    });

    reader.readAsDataURL(file);
  });
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

function postWebviewRequest<T>(message: OutgoingRequest): Promise<T> {
  const requestId = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    vscode.postMessage({ ...message, requestId } as OutgoingMessage);
  });
}

function resolvePendingRequest(requestId: number, value: unknown): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    return;
  }

  pendingRequests.delete(requestId);
  pending.resolve(value);
}

function rejectPendingRequest(requestId: number, error: unknown): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    return;
  }

  pendingRequests.delete(requestId);
  pending.reject(error);
}

function getMermaidTheme(): "dark" | "default" {
  return document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-high-contrast")
    ? "dark"
    : "default";
}
