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
  | { type: string; [key: string]: unknown };

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

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default"
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

vscode.postMessage({ type: "ready" });

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
      ctx.update<CodeBlockConfig>(codeBlockConfig.key, previous => ({
        ...previous,
        renderPreview: (language, content, applyPreview) => {
          if (language.toLowerCase() !== "mermaid" || content.trim().length === 0) {
            return previous.renderPreview(language, content, applyPreview);
          }

          const container = document.createElement("div");
          container.className = "mermaid-preview";
          container.textContent = "Rendering diagram...";

          const id = `mermaid-${Date.now()}-${mermaidRenderId++}`;
          mermaid
            .render(id, content)
            .then(({ svg }) => {
              container.innerHTML = svg;
              applyPreview(container);
            })
            .catch(error => {
              container.textContent = getErrorMessage(error);
              applyPreview(container);
            });

          return container;
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
