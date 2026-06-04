import * as crepeModule from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import * as codeBlockModule from "@milkdown/components/code-block";
import * as coreModule from "@milkdown/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import * as commonmarkModule from "@milkdown/preset-commonmark";
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
type ListKind = "bullet" | "ordered" | "task";
type ListItemNode = {
  type: { name: string };
  attrs: Record<string, unknown>;
  forEach(callback: (node: ListItemNode, offset: number, index: number) => void): void;
};
type ListContext = {
  item?: { depth: number; pos: number; node: ListItemNode };
  wrapper?: { depth: number; pos: number; node: ListItemNode };
};
type GroupLikeBuilder = {
  getGroup(key: string): {
    clear(): ListGroup;
  };
};
type ListGroup = {
  addItem(
    key: string,
    item: {
      icon: string;
      onRun: (ctx: unknown) => void;
      active?: (ctx: unknown) => boolean;
      label?: string;
    }
  ): ListGroup;
  clear(): ListGroup;
};
type EditorContext = {
  get<T>(key: unknown): T;
};
type EditorView = {
  state: {
    doc: EditorDoc;
    selection: {
      $from: ListSelection;
    };
    tr: {
      delete(from: number, to: number): EditorTransaction;
      replaceWith(from: number, to: number, node: unknown): EditorTransaction;
      setNodeMarkup(pos: number, type?: unknown, attrs?: Record<string, unknown>): EditorTransaction;
      scrollIntoView(): EditorTransaction;
    };
  };
  dispatch(transaction: EditorTransaction): void;
  focus(): void;
};
type EditorDoc = {
  content: {
    size: number;
  };
  resolve(pos: number): ListSelection;
};
type EditorTransaction = {
  doc: EditorDoc;
  setSelection(selection: unknown): EditorTransaction;
  scrollIntoView(): EditorTransaction;
};
type ListSelection = {
  depth: number;
  pos: number;
  node(depth: number): ListItemNode;
  before(depth: number): number;
};
type BlockHandlePositionContext = {
  ctx: unknown;
  active: {
    $pos: ListSelection;
    el: HTMLElement;
    node: {
      nodeSize: number;
      type: {
        name: string;
      };
    };
  };
};
type ActiveBlockHandleTarget = {
  ctx: unknown;
  pos: number;
  nodeSize: number;
};

const bulletListIcon = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
  >
    <g clip-path="url(#clip0_977_8070)">
      <path
        d="M4 10.5C3.17 10.5 2.5 11.17 2.5 12C2.5 12.83 3.17 13.5 4 13.5C4.83 13.5 5.5 12.83 5.5 12C5.5 11.17 4.83 10.5 4 10.5ZM4 4.5C3.17 4.5 2.5 5.17 2.5 6C2.5 6.83 3.17 7.5 4 7.5C4.83 7.5 5.5 6.83 5.5 6C5.5 5.17 4.83 4.5 4 4.5ZM4 16.5C3.17 16.5 2.5 17.18 2.5 18C2.5 18.82 3.18 19.5 4 19.5C4.82 19.5 5.5 18.82 5.5 18C5.5 17.18 4.83 16.5 4 16.5ZM8 19H20C20.55 19 21 18.55 21 18C21 17.45 20.55 17 20 17H8C7.45 17 7 17.45 7 18C7 18.55 7.45 19 8 19ZM8 13H20C20.55 13 21 12.55 21 12C21 11.45 20.55 11 20 11H8C7.45 11 7 11.45 7 12C7 12.55 7.45 13 8 13ZM7 6C7 6.55 7.45 7 8 7H20C20.55 7 21 6.55 21 6C21 5.45 20.55 5 20 5H8C7.45 5 7 5.45 7 6Z"
      />
    </g>
    <defs>
      <clipPath id="clip0_977_8070">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;
const orderedListIcon = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
  >
    <g clip-path="url(#clip0_977_8067)">
      <path
        d="M8 7H20C20.55 7 21 6.55 21 6C21 5.45 20.55 5 20 5H8C7.45 5 7 5.45 7 6C7 6.55 7.45 7 8 7ZM20 17H8C7.45 17 7 17.45 7 18C7 18.55 7.45 19 8 19H20C20.55 19 21 18.55 21 18C21 17.45 20.55 17 20 17ZM20 11H8C7.45 11 7 11.45 7 12C7 12.55 7.45 13 8 13H20C20.55 13 21 12.55 21 12C21 11.45 20.55 11 20 11ZM4.5 16H2.5C2.22 16 2 16.22 2 16.5C2 16.78 2.22 17 2.5 17H4V17.5H3.5C3.22 17.5 3 17.72 3 18C3 18.28 3.22 18.5 3.5 18.5H4V19H2.5C2.22 19 2 19.22 2 19.5C2 19.78 2.22 20 2.5 20H4.5C4.78 20 5 19.78 5 19.5V16.5C5 16.22 4.78 16 4.5 16ZM2.5 5H3V7.5C3 7.78 3.22 8 3.5 8C3.78 8 4 7.78 4 7.5V4.5C4 4.22 3.78 4 3.5 4H2.5C2.22 4 2 4.22 2 4.5C2 4.78 2.22 5 2.5 5ZM4.5 10H2.5C2.22 10 2 10.22 2 10.5C2 10.78 2.22 11 2.5 11H3.8L2.12 12.96C2.04 13.05 2 13.17 2 13.28V13.5C2 13.78 2.22 14 2.5 14H4.5C4.78 14 5 13.78 5 13.5C5 13.22 4.78 13 4.5 13H3.2L4.88 11.04C4.96 10.95 5 10.83 5 10.72V10.5C5 10.22 4.78 10 4.5 10Z"
      />
    </g>
    <defs>
      <clipPath id="clip0_977_8067">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;
const todoListIcon = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
  >
    <path
      d="M5.66936 16.3389L9.39244 12.6158C9.54115 12.4671 9.71679 12.3937 9.91936 12.3957C10.1219 12.3976 10.2975 12.4761 10.4463 12.6312C10.5847 12.7823 10.654 12.9585 10.654 13.1599C10.654 13.3613 10.5847 13.5363 10.4463 13.6851L6.32704 17.8197C6.14627 18.0004 5.93538 18.0908 5.69436 18.0908C5.45333 18.0908 5.24243 18.0004 5.06166 17.8197L3.01744 15.7754C2.87899 15.637 2.81136 15.4629 2.81456 15.2533C2.81776 15.0437 2.88859 14.8697 3.02706 14.7312C3.16551 14.5928 3.34008 14.5235 3.55076 14.5235C3.76144 14.5235 3.93494 14.5928 4.07126 14.7312L5.66936 16.3389ZM5.66936 8.72359L9.39244 5.00049C9.54115 4.85177 9.71679 4.77838 9.91936 4.78031C10.1219 4.78223 10.2975 4.86075 10.4463 5.01586C10.5847 5.16691 10.654 5.34314 10.654 5.54454C10.654 5.74592 10.5847 5.92097 10.4463 6.06969L6.32704 10.2043C6.14627 10.3851 5.93538 10.4755 5.69436 10.4755C5.45333 10.4755 5.24243 10.3851 5.06166 10.2043L3.01744 8.16009C2.87899 8.02162 2.81136 7.84759 2.81456 7.63799C2.81776 7.42837 2.88859 7.25433 3.02706 7.11586C3.16551 6.97741 3.34008 6.90819 3.55076 6.90819C3.76144 6.90819 3.93494 6.97741 4.07126 7.11586L5.66936 8.72359ZM13.7597 16.5581C13.5472 16.5581 13.3691 16.4862 13.2253 16.3424C13.0816 16.1986 13.0097 16.0204 13.0097 15.8078C13.0097 15.5952 13.0816 15.4171 13.2253 15.2735C13.3691 15.13 13.5472 15.0582 13.7597 15.0582H20.7597C20.9722 15.0582 21.1503 15.1301 21.2941 15.2739C21.4378 15.4177 21.5097 15.5959 21.5097 15.8085C21.5097 16.0211 21.4378 16.1992 21.2941 16.3427C21.1503 16.4863 20.9722 16.5581 20.7597 16.5581H13.7597ZM13.7597 8.94276C13.5472 8.94276 13.3691 8.87085 13.2253 8.72704C13.0816 8.58324 13.0097 8.40504 13.0097 8.19244C13.0097 7.97985 13.0816 7.80177 13.2253 7.65819C13.3691 7.5146 13.5472 7.44281 13.7597 7.44281H20.7597C20.9722 7.44281 21.1503 7.51471 21.2941 7.65851C21.4378 7.80233 21.5097 7.98053 21.5097 8.19311C21.5097 8.40571 21.4378 8.5838 21.2941 8.72739C21.1503 8.87097 20.9722 8.94276 20.7597 8.94276H13.7597Z"
    />
  </svg>
`;
const topBarImageIcon = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
  >
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M4 5H20V19H4V5ZM6 7V15.2L9.2 12L12.4 15.2L14.4 13.2L18 16.8V7H6ZM18 19L14.4 15.4L12.4 17.4L9.2 14.2L6 17.4V17H6V19H18ZM16 11C15.17 11 14.5 10.33 14.5 9.5C14.5 8.67 15.17 8 16 8C16.83 8 17.5 8.67 17.5 9.5C17.5 10.33 16.83 11 16 11Z"
    />
  </svg>
`;
const topBarTableIcon = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
  >
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M4 5H20V19H4V5ZM6 7V9H18V7H6ZM6 11V17H10V11H6ZM12 11V17H18V11H12Z"
    />
  </svg>
`;
const topBarCodeBlockIcon = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
  >
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M3 5H21V19H3V5ZM5 7V17H19V7H5ZM10 12L7.5 9.5L6.1 10.9L7.2 12L6.1 13.1L7.5 14.5L10 12ZM12 14H17V16H12V14Z"
    />
  </svg>
`;
const trashIconSvg = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M7.30775 20.4997C6.81058 20.4997 6.385 20.3227 6.031 19.9687C5.677 19.6147 5.5 19.1892 5.5 18.692V5.99973H5.25C5.0375 5.99973 4.85942 5.92782 4.71575 5.78398C4.57192 5.64015 4.5 5.46198 4.5 5.24948C4.5 5.03682 4.57192 4.85873 4.71575 4.71523C4.85942 4.57157 5.0375 4.49973 5.25 4.49973H9C9 4.2549 9.08625 4.04624 9.25875 3.87374C9.43108 3.7014 9.63967 3.61523 9.8845 3.61523H14.1155C14.3603 3.61523 14.5689 3.7014 14.7413 3.87374C14.9138 4.04624 15 4.2549 15 4.49973H18.75C18.9625 4.49973 19.1406 4.57165 19.2843 4.71548C19.4281 4.85932 19.5 5.03748 19.5 5.24998C19.5 5.46265 19.4281 5.64073 19.2843 5.78423C19.1406 5.9279 18.9625 5.99973 18.75 5.99973H18.5V18.692C18.5 19.1892 18.323 19.6147 17.969 19.9687C17.615 20.3227 17.1894 20.4997 16.6923 20.4997H7.30775ZM17 5.99973H7V18.692C7 18.7818 7.02883 18.8556 7.0865 18.9132C7.14417 18.9709 7.21792 18.9997 7.30775 18.9997H16.6923C16.7821 18.9997 16.8558 18.9709 16.9135 18.9132C16.9712 18.8556 17 18.7818 17 18.692V5.99973ZM10.1543 16.9997C10.3668 16.9997 10.5448 16.9279 10.6885 16.7842C10.832 16.6404 10.9037 16.4622 10.9037 16.2497V8.74973C10.9037 8.53723 10.8318 8.35907 10.688 8.21523C10.5443 8.07157 10.3662 7.99973 10.1535 7.99973C9.941 7.99973 9.76292 8.07157 9.61925 8.21523C9.47575 8.35907 9.404 8.53723 9.404 8.74973V16.2497C9.404 16.4622 9.47583 16.6404 9.6195 16.7842C9.76333 16.9279 9.94158 16.9997 10.1543 16.9997ZM13.8465 16.9997C14.059 16.9997 14.2371 16.9279 14.3807 16.7842C14.5243 16.6404 14.596 16.4622 14.596 16.2497V8.74973C14.596 8.53723 14.5242 8.35907 14.3805 8.21523C14.2367 8.07157 14.0584 7.99973 13.8458 7.99973C13.6333 7.99973 13.4552 8.07157 13.3115 8.21523C13.168 8.35907 13.0962 8.53723 13.0962 8.74973V16.2497C13.0962 16.4622 13.1682 16.6404 13.312 16.7842C13.4557 16.9279 13.6338 16.9997 13.8465 16.9997Z"
    />
  </svg>
`;

const milkdownCore = coreModule as unknown as {
  commandsCtx: unknown;
  editorViewCtx: unknown;
};
const milkdownCommonmark = commonmarkModule as unknown as {
  bulletListSchema: { type(ctx: unknown): unknown };
  clearTextInCurrentBlockCommand: { key: unknown };
  liftListItemCommand: { key: unknown };
  listItemSchema: { type(ctx: unknown): unknown };
  orderedListSchema: { type(ctx: unknown): unknown };
  paragraphSchema: { type(ctx: unknown): { create(): unknown } };
  wrapInBlockTypeCommand: { key: unknown };
};

const { Crepe } = crepeModule as typeof crepeModule & { Crepe: CrepeConstructor };
const { codeBlockConfig } = codeBlockModule as typeof codeBlockModule & {
  codeBlockConfig: { key: unknown };
};
const editorRoot: HTMLElement = root;
const statusElement: HTMLElement = status;
const toolbarElement: HTMLElement = toolbar as HTMLElement;

let editor: InstanceType<CrepeConstructor> | undefined;
let currentMarkdown = "";
let isApplyingExternalChange = false;
let emitTimer: number | undefined;
let mermaidRenderId = 0;
let nextRequestId = 1;
let activeBlockHandleTarget: ActiveBlockHandleTarget | undefined;
let blockHandleActionsVisible = false;

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

toolbarElement.addEventListener("click", event => {
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

window.addEventListener("pointerdown", event => {
  if (event.button !== 0) {
    return;
  }

  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (target.closest(".milkdown-block-handle")) {
    return;
  }

  if (editorRoot.contains(target) && target.closest(".ProseMirror")) {
    document.body.dataset.mwSelectingText = "true";
  }
}, true);

window.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const blockHandle = target.closest<HTMLElement>(".milkdown-block-handle");
  if (!blockHandle) {
    hideBlockHandleActions();
    return;
  }

  if (target.closest(".mw-block-handle-actions")) {
    return;
  }

  const operationItem = target.closest<HTMLElement>(".operation-item");
  if (!operationItem || !isBlockDragHandleItem(blockHandle, operationItem)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  blockHandleActionsVisible = !blockHandleActionsVisible;
  attachBlockHandleActions(blockHandle);
}, true);

window.addEventListener("pointerup", clearTextSelectionDragState, true);
window.addEventListener("pointercancel", clearTextSelectionDragState, true);
window.addEventListener("blur", clearTextSelectionDragState);

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
      [crepeModule.CrepeFeature.TopBar]: {
        buildTopBar: configureListButtons,
        imageIcon: topBarImageIcon,
        tableIcon: topBarTableIcon,
        codeBlockIcon: topBarCodeBlockIcon
      },
      [crepeModule.CrepeFeature.BlockEdit]: {
        buildMenu: configureSlashMenuListButtons,
        blockHandle: {
          getPosition: getBlockHandlePosition
        }
      },
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
      attachBlockHandleActions();
    });
  });

  try {
    await editor.create();
    attachToolbarToTopBar();
    attachBlockHandleActions();
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

function clearTextSelectionDragState(): void {
  delete document.body.dataset.mwSelectingText;
}

function configureListButtons(builder: GroupLikeBuilder): void {
  const listGroup = builder.getGroup("list");
  listGroup.clear()
    .addItem("bullet-list", {
      icon: bulletListIcon,
      active: (ctx: unknown) => isCurrentListKind(ctx, "bullet"),
      onRun: (ctx: unknown) => runListAction(ctx, "bullet")
    })
    .addItem("ordered-list", {
      icon: orderedListIcon,
      active: (ctx: unknown) => isCurrentListKind(ctx, "ordered"),
      onRun: (ctx: unknown) => runListAction(ctx, "ordered")
    })
    .addItem("task-list", {
      icon: todoListIcon,
      active: (ctx: unknown) => isCurrentListKind(ctx, "task"),
      onRun: (ctx: unknown) => runListAction(ctx, "task")
    });
}

function configureSlashMenuListButtons(builder: GroupLikeBuilder): void {
  const listGroup = builder.getGroup("list");
  listGroup.clear()
    .addItem("bullet-list", {
      label: "Bullet List",
      icon: bulletListIcon,
      onRun: (ctx: unknown) => runListAction(ctx, "bullet")
    })
    .addItem("ordered-list", {
      label: "Ordered List",
      icon: orderedListIcon,
      onRun: (ctx: unknown) => runListAction(ctx, "ordered")
    })
    .addItem("task-list", {
      label: "Task List",
      icon: todoListIcon,
      onRun: (ctx: unknown) => runListAction(ctx, "task")
    });
}

function runListAction(ctx: unknown, kind: ListKind): void {
  const editorCtx = ctx as EditorContext;
  const commands = editorCtx.get<any>(milkdownCore.commandsCtx);
  const view = editorCtx.get<EditorView>(milkdownCore.editorViewCtx);
  const state = view.state;
  const listContext = findListContext(state.selection.$from);

  if (kind === "task") {
    if (listContext.item?.node.attrs.checked != null) {
      commands.call(milkdownCommonmark.liftListItemCommand.key);
      return;
    }

    if (listContext.item) {
      const tr = state.tr;
      tr.setNodeMarkup(listContext.item.pos, undefined, {
        ...listContext.item.node.attrs,
        checked: false
      });
      view.dispatch(tr.scrollIntoView());
      return;
    }

    commands.call(milkdownCommonmark.wrapInBlockTypeCommand.key, {
      nodeType: milkdownCommonmark.listItemSchema.type(ctx),
      attrs: { checked: false }
    });
    return;
  }

  const desiredWrapperType =
    kind === "bullet"
      ? milkdownCommonmark.bulletListSchema.type(ctx)
      : milkdownCommonmark.orderedListSchema.type(ctx);
  const currentWrapperType = listContext.wrapper?.node.type;
  const currentItem = listContext.item?.node;

  if (currentWrapperType === desiredWrapperType && currentItem?.attrs.checked == null) {
    commands.call(milkdownCommonmark.liftListItemCommand.key);
    return;
  }

  if (listContext.wrapper) {
    const tr = state.tr;
    tr.setNodeMarkup(listContext.wrapper.pos, desiredWrapperType, {
      ...listContext.wrapper.node.attrs
    });
    listContext.wrapper.node.forEach((child, offset) => {
      if (child.type !== milkdownCommonmark.listItemSchema.type(ctx)) {
        return;
      }

      const attrs = {
        ...child.attrs,
        listType: kind,
        checked: null
      };
      tr.setNodeMarkup(listContext.wrapper!.pos + 1 + offset, undefined, attrs);
    });
    view.dispatch(tr.scrollIntoView());
    return;
  }

  commands.call(milkdownCommonmark.wrapInBlockTypeCommand.key, {
    nodeType: desiredWrapperType
  });
}

function isCurrentListKind(ctx: unknown, kind: ListKind): boolean {
  const editorCtx = ctx as EditorContext;
  const view = editorCtx.get<EditorView>(milkdownCore.editorViewCtx);
  const listContext = findListContext(view.state.selection.$from);

  if (kind === "task") {
    return Boolean(listContext.item && listContext.item.node.attrs.checked != null);
  }

  const wrapperType =
    kind === "bullet"
      ? milkdownCommonmark.bulletListSchema.type(ctx)
      : milkdownCommonmark.orderedListSchema.type(ctx);
  return listContext.wrapper?.node.type === wrapperType && listContext.item?.node.attrs.checked == null;
}

function findListContext($from: ListSelection): ListContext {
  const context: ListContext = {};
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (!context.item && node.type.name === "list_item") {
      context.item = { depth, pos: $from.before(depth), node };
    }

    if (
      !context.wrapper &&
      (node.type.name === "bullet_list" || node.type.name === "ordered_list")
    ) {
      context.wrapper = { depth, pos: $from.before(depth), node };
    }

    if (context.item && context.wrapper) {
      break;
    }
  }
  return context;
}

function attachToolbarToTopBar(): void {
  const topBar = document.querySelector(".milkdown-top-bar");
  if (!topBar || toolbarElement.parentElement === topBar) {
    return;
  }

  topBar.append(toolbarElement);
}

function getBlockHandlePosition({
  ctx,
  active
}: BlockHandlePositionContext): Omit<DOMRect, "toJSON"> {
  activeBlockHandleTarget = {
    ctx,
    pos: active.$pos.pos,
    nodeSize: active.node.nodeSize
  };
  blockHandleActionsVisible = false;
  attachBlockHandleActions();

  const rect = active.el.getBoundingClientRect();
  const topOffset = active.node.type.name === "list_item" ? 4 : 0;

  return {
    x: rect.x,
    y: rect.y + topOffset,
    top: rect.top + topOffset,
    bottom: rect.bottom + topOffset,
    left: rect.left,
    right: rect.right,
    width: rect.width,
    height: rect.height
  };
}

function attachBlockHandleActions(handle?: HTMLElement): void {
  const blockHandle = handle ?? document.querySelector<HTMLElement>(".milkdown-block-handle");
  if (!blockHandle || blockHandle.querySelector(".mw-block-handle-actions")) {
    if (blockHandle) {
      syncBlockHandleActions(blockHandle);
    }
    return;
  }

  const actions = document.createElement("div");
  actions.className = "mw-block-handle-actions";
  actions.dataset.show = "false";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "mw-delete-block";
  deleteButton.setAttribute("aria-label", "Delete block");
  deleteButton.innerHTML = trashIconSvg;
  deleteButton.addEventListener("pointerdown", event => {
    event.preventDefault();
    event.stopPropagation();
    deleteActiveBlock();
  });

  actions.appendChild(deleteButton);
  blockHandle.appendChild(actions);
  positionBlockHandleActions(blockHandle, actions);
  syncBlockHandleActions(blockHandle);
}

function syncBlockHandleActions(blockHandle?: HTMLElement): void {
  const targetHandle = blockHandle ?? document.querySelector<HTMLElement>(".milkdown-block-handle");
  const actions = targetHandle?.querySelector<HTMLElement>(".mw-block-handle-actions");
  if (!targetHandle || !actions) {
    return;
  }

  positionBlockHandleActions(targetHandle, actions);
  actions.dataset.show = blockHandleActionsVisible && activeBlockHandleTarget ? "true" : "false";
}

function positionBlockHandleActions(blockHandle: HTMLElement, actions: HTMLElement): void {
  const operationItems = Array.from(blockHandle.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains("operation-item")
  );
  const dragHandle = operationItems[1];
  if (!dragHandle) {
    return;
  }

  actions.style.left = `${dragHandle.offsetLeft + dragHandle.offsetWidth / 2}px`;
}

function hideBlockHandleActions(): void {
  if (!blockHandleActionsVisible) {
    return;
  }

  blockHandleActionsVisible = false;
  syncBlockHandleActions();
}

function isBlockDragHandleItem(blockHandle: HTMLElement, operationItem: HTMLElement): boolean {
  const operationItems = Array.from(blockHandle.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains("operation-item")
  );
  return operationItems[1] === operationItem;
}

function deleteActiveBlock(): void {
  const target = activeBlockHandleTarget;
  if (!target) {
    return;
  }

  const editorCtx = target.ctx as EditorContext;
  const view = editorCtx.get<EditorView>(milkdownCore.editorViewCtx);
  const from = target.pos;
  const docSize = view.state.doc.content.size;
  const to = Math.min(from + target.nodeSize, docSize);
  const selectionPos = Math.max(0, Math.min(from, to - 1));
  let tr =
    from === 0 && to >= docSize
      ? view.state.tr.replaceWith(0, docSize, milkdownCommonmark.paragraphSchema.type(target.ctx).create())
      : view.state.tr.delete(from, to);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(selectionPos) as never));

  view.dispatch(tr.scrollIntoView());
  view.focus();
  activeBlockHandleTarget = undefined;
  hideBlockHandleActions();
  emitChangeSoon();
}

async function uploadImageFile(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const markdownPath = await postWebviewRequest<string>({
    type: "uploadImage",
    fileName: file.name,
    mimeType: file.type,
    dataUrl
  });
  return markdownPath;
}

async function resolveDomUrl(url: string): Promise<string> {
  if (!url.trim()) {
    return url;
  }

  if (isExternalImageUrl(url)) {
    return url;
  }

  try {
    const resolvedUrl = await postWebviewRequest<string>({
      type: "resolveWebviewUrl",
      url
    });
    return resolvedUrl;
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
