import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView, NodeView } from "@milkdown/prose/view";
import * as milkdownUtils from "@milkdown/utils";
import yaml from "js-yaml";
import remarkFrontmatter from "remark-frontmatter";

type YamlRecord = Record<string, unknown>;
type NodeSchemaPlugin = {
  node: unknown;
};
type MilkdownUtilsWithInternalExports = typeof milkdownUtils & {
  $nodeSchema: (id: string, schema: (ctx: unknown) => unknown) => NodeSchemaPlugin;
  $remark: (id: string, remark: (ctx: unknown) => unknown) => unknown;
  $view: (
    type: unknown,
    view: (ctx: unknown) => (node: ProseNode, view: EditorView, getPos: () => number) => NodeView
  ) => unknown;
};

const { $nodeSchema, $remark, $view } =
  milkdownUtils as MilkdownUtilsWithInternalExports;

export const remarkFrontmatterPlugin = $remark("remarkFrontmatter", () => {
  return function remarkFrontmatterRunner(this: unknown) {
    return remarkFrontmatter.call(this, ["yaml"]);
  };
});

export const aiSkillsMetadataSchema = $nodeSchema("aiSkillsMetadata", () => ({
  group: "block",
  atom: true,
  isolating: true,
  selectable: false,
  draggable: false,
  attrs: {
    rawYaml: { default: "" },
    yamlData: { default: {} }
  },
  parseMarkdown: {
    match: (node: { type?: string }) => node.type === "yaml",
    runner: (
      state: { addNode: (type: unknown, attrs: unknown) => void },
      node: { value?: string },
      type: unknown
    ) => {
      const rawYaml = node.value ?? "";
      let yamlData: YamlRecord = {};
      try {
        yamlData = (yaml.load(rawYaml) as YamlRecord | undefined) ?? {};
      } catch (error) {
        console.error("YAML parse failed:", error);
      }
      state.addNode(type, { rawYaml, yamlData });
    }
  },
  toMarkdown: {
    match: (node: { type: { name: string } }) => node.type.name === "aiSkillsMetadata",
    runner: (
      state: { addNode: (type: string, attrs: unknown, value: string) => void },
      node: { attrs: { rawYaml: string } }
    ) => {
      state.addNode("yaml", undefined, node.attrs.rawYaml);
    }
  },
  parseDOM: [
    {
      tag: 'div[data-type="ai-skills-metadata"]',
      getAttrs: () => ({})
    }
  ],
  toDOM: () => ["div", { "data-type": "ai-skills-metadata" }, "Frontmatter"]
}));

export const aiSkillsMetadataView = $view(aiSkillsMetadataSchema.node, () => {
  return (node, view, getPos) => {
    const dom = document.createElement("section");
    dom.setAttribute("data-type", "ai-skills-metadata");
    dom.setAttribute("draggable", "false");
    dom.className = "frontmatter-panel";
    dom.addEventListener("dragstart", event => {
      if (!(event.target as HTMLElement | null)?.closest(".frontmatter-row-handle")) {
        event.preventDefault();
      }
    });
    dom.addEventListener("dragover", event => {
      if ((event.target as HTMLElement | null)?.closest(".frontmatter-table")) {
        event.preventDefault();
      }
    });
    dom.addEventListener("drop", event => {
      if ((event.target as HTMLElement | null)?.closest(".frontmatter-table")) {
        event.preventDefault();
      }
    });

    const getYamlData = () => (node.attrs.yamlData ?? {}) as YamlRecord;
    let draggedRowIndex: number | undefined;

    const hideButtonGroups = () => {
      dom.querySelectorAll<HTMLElement>(".frontmatter-row-handle").forEach(handle => {
        handle.dataset.actions = "false";
      });
    };

    const hideHandles = () => {
      dom.querySelectorAll<HTMLElement>(".frontmatter-row-handle").forEach(handle => {
        handle.dataset.show = "false";
        handle.dataset.actions = "false";
      });
    };

    const showOnlyHandle = (visibleHandle: HTMLElement) => {
      dom.querySelectorAll<HTMLElement>(".frontmatter-row-handle").forEach(handle => {
        if (handle !== visibleHandle) {
          handle.dataset.show = "false";
          handle.dataset.actions = "false";
        }
      });
      visibleHandle.dataset.show = "true";
    };

    dom.addEventListener("pointerleave", () => {
      window.setTimeout(() => {
        if (!dom.matches(":hover")) {
          hideHandles();
        }
      }, 200);
    });

    const dispatchYamlData = (nextData: YamlRecord) => {
      const rawYaml = yaml.dump(nextData, { lineWidth: -1 }).trim();
      const transaction = view.state.tr.setNodeMarkup(getPos(), undefined, {
        rawYaml,
        yamlData: nextData
      });
      view.dispatch(transaction);
    };

    const renderTable = () => {
      dom.replaceChildren();

      const title = document.createElement("div");
      title.className = "frontmatter-title";
      title.textContent = "Frontmatter";
      dom.appendChild(title);

      const yamlData = getYamlData();
      const entries = Object.entries(yamlData);

      const table = document.createElement("table");
      table.className = "frontmatter-table";
      table.addEventListener("pointermove", event => {
        if (!(event.target as HTMLElement | null)?.closest(".frontmatter-row-handle")) {
          hideButtonGroups();
        }
      });

      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      const keyHeader = document.createElement("th");
      keyHeader.textContent = "Property";
      const valueHeader = document.createElement("th");
      valueHeader.textContent = "Value";
      headerRow.append(keyHeader, valueHeader);
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      table.appendChild(tbody);

      entries.forEach(([key, value], rowIndex) => {
        const row = createEditableRow(key, value, rowIndex);
        tbody.appendChild(row);
      });

      dom.appendChild(table);

      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "frontmatter-add-row";
      addButton.textContent = "+";
      addButton.setAttribute("aria-label", "Add frontmatter row");
      addButton.addEventListener("click", () => {
        const uniqueKey = getUniqueKey("property");
        dispatchYamlData({ ...getYamlData(), [uniqueKey]: "" });
        requestAnimationFrame(() => {
          const keyInput = dom.querySelector<HTMLInputElement>(
            `[data-frontmatter-key="${CSS.escape(uniqueKey)}"]`
          );
          keyInput?.focus();
          keyInput?.select();
        });
      });
      dom.appendChild(addButton);
    };

    const createEditableRow = (key: string, value: unknown, rowIndex: number) => {
      const row = document.createElement("tr");
      row.dataset.rowIndex = String(rowIndex);
      row.dataset.frontmatterKey = key;

      const keyCell = document.createElement("td");
      const keyInput = document.createElement("input");
      keyInput.type = "text";
      keyInput.value = key;
      keyInput.className = "frontmatter-field frontmatter-key";
      keyInput.dataset.frontmatterKey = key;
      keyInput.spellcheck = false;
      keyInput.addEventListener("blur", () => {
        const nextKey = keyInput.value.trim();
        if (!nextKey || nextKey === key) {
          keyInput.value = key;
          return;
        }

        const yamlData = getYamlData();
        const nextData: YamlRecord = {};
        for (const [currentKey, currentValue] of Object.entries(yamlData)) {
          if (currentKey === key) {
            nextData[nextKey] = currentValue;
          } else if (currentKey !== nextKey) {
            nextData[currentKey] = currentValue;
          }
        }
        dispatchYamlData(nextData);
      });
      wireCellKeyboard(keyInput);
      keyCell.appendChild(keyInput);

      const valueCell = document.createElement("td");
      const valueInput = document.createElement("textarea");
      valueInput.value = stringifyValue(value);
      valueInput.className = "frontmatter-field frontmatter-value";
      valueInput.rows = Math.max(1, valueInput.value.split("\n").length);
      valueInput.spellcheck = false;
      valueInput.addEventListener("input", () => {
        valueInput.rows = Math.max(1, valueInput.value.split("\n").length);
      });
      valueInput.addEventListener("blur", () => {
        const yamlData = getYamlData();
        dispatchYamlData({ ...yamlData, [key]: parseEditedValue(value, valueInput.value) });
      });
      wireCellKeyboard(valueInput);
      valueCell.appendChild(valueInput);

      row.addEventListener("dragover", event => {
        if (draggedRowIndex === undefined) {
          return;
        }
        event.preventDefault();
        row.classList.add("frontmatter-drop-target");
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("frontmatter-drop-target");
      });
      row.addEventListener("drop", event => {
        event.preventDefault();
        row.classList.remove("frontmatter-drop-target");
        if (draggedRowIndex === undefined || draggedRowIndex === rowIndex) {
          draggedRowIndex = undefined;
          return;
        }
        reorderRows(draggedRowIndex, rowIndex);
        draggedRowIndex = undefined;
      });

      row.append(keyCell, valueCell);
      requestAnimationFrame(() => {
        if (row.isConnected) {
          attachRowHandle(row, key, rowIndex);
        }
      });
      return row;
    };

    const attachRowHandle = (row: HTMLTableRowElement, key: string, rowIndex: number) => {
      dom
        .querySelector(`.frontmatter-row-handle[data-row-index="${rowIndex}"]`)
        ?.remove();

      const panelRect = dom.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const actionHandle = document.createElement("div");
      actionHandle.className = "frontmatter-row-handle";
      actionHandle.dataset.rowIndex = String(rowIndex);
      actionHandle.dataset.show = "false";
      actionHandle.dataset.actions = "false";
      actionHandle.draggable = true;
      actionHandle.style.left = `${rowRect.left - panelRect.left}px`;
      actionHandle.style.top = `${rowRect.top - panelRect.top + rowRect.height / 2}px`;
      actionHandle.innerHTML = rowHandleIconSvg;
      let didDrag = false;
      actionHandle.addEventListener("dragstart", event => {
        draggedRowIndex = rowIndex;
        didDrag = true;
        actionHandle.dataset.dragging = "true";
        actionHandle.dataset.actions = "false";
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", key);
        }
      });
      actionHandle.addEventListener("dragend", () => {
        draggedRowIndex = undefined;
        actionHandle.dataset.dragging = "false";
        dom.querySelectorAll(".frontmatter-drop-target").forEach(target => {
          target.classList.remove("frontmatter-drop-target");
        });
        requestAnimationFrame(() => {
          didDrag = false;
        });
      });
      actionHandle.addEventListener("click", event => {
        if (didDrag || (event.target as HTMLElement | null)?.closest("button")) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        actionHandle.dataset.actions =
          actionHandle.dataset.actions === "true" ? "false" : "true";
      });

      const buttonGroup = document.createElement("div");
      buttonGroup.className = "frontmatter-button-group";
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "frontmatter-delete-row";
      deleteButton.setAttribute("aria-label", `Delete ${key}`);
      deleteButton.innerHTML = trashIconSvg;
      deleteButton.addEventListener("pointerdown", event => {
        event.preventDefault();
        event.stopPropagation();
        const { [key]: _removed, ...nextData } = getYamlData();
        dispatchYamlData(nextData);
      });
      buttonGroup.appendChild(deleteButton);
      actionHandle.appendChild(buttonGroup);
      dom.appendChild(actionHandle);

      const setVisible = (visible: boolean) => {
        if (visible) {
          showOnlyHandle(actionHandle);
          return;
        }
        actionHandle.dataset.show = "false";
        actionHandle.dataset.actions = "false";
      };

      row.addEventListener("pointerenter", () => setVisible(true));
      actionHandle.addEventListener("pointerleave", () => {
        actionHandle.dataset.actions = "false";
      });
      actionHandle.addEventListener("focusin", () => setVisible(true));
      actionHandle.addEventListener("focusout", () => {
        actionHandle.dataset.actions = "false";
        setVisible(false);
      });
    };

    const reorderRows = (fromIndex: number, toIndex: number) => {
      const entries = Object.entries(getYamlData());
      const [moved] = entries.splice(fromIndex, 1);
      if (!moved) {
        return;
      }

      entries.splice(toIndex, 0, moved);
      dispatchYamlData(Object.fromEntries(entries));
    };

    const getUniqueKey = (baseKey: string) => {
      const yamlData = getYamlData();
      if (!(baseKey in yamlData)) {
        return baseKey;
      }

      let index = 2;
      while (`${baseKey}${index}` in yamlData) {
        index += 1;
      }
      return `${baseKey}${index}`;
    };

    renderTable();

    return {
      dom,
      update: updatedNode => {
        if (updatedNode.type.name !== "aiSkillsMetadata") {
          return false;
        }
        node = updatedNode;
        renderTable();
        return true;
      },
      stopEvent: event => {
        if (
          event.type === "dragstart" ||
          event.type === "dragover" ||
          event.type === "drop"
        ) {
          return true;
        }

        return event.target instanceof HTMLElement && dom.contains(event.target);
      },
      ignoreMutation: mutation => {
        return mutation.target instanceof HTMLElement && dom.contains(mutation.target);
      }
    };
  };
});

function wireCellKeyboard(input: HTMLInputElement | HTMLTextAreaElement) {
  input.addEventListener("keydown", event => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Tab") {
      keyboardEvent.preventDefault();
      if (input instanceof HTMLTextAreaElement) {
        insertText(input, "\t");
      }
      return;
    }

    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      input.blur();
    }
  });
}

function insertText(input: HTMLTextAreaElement, text: string) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
  const nextPosition = start + text.length;
  input.setSelectionRange(nextPosition, nextPosition);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function parseEditedValue(previousValue: unknown, editedValue: string): unknown {
  if (Array.isArray(previousValue)) {
    return editedValue
      .split(/\n|,/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  return editedValue;
}

function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join("\n");
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

export const aiSkillsMetadataPlugin = [
  remarkFrontmatterPlugin,
  aiSkillsMetadataSchema,
  aiSkillsMetadataView
];

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
</svg>`;

const rowHandleIconSvg = `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="16"
  height="16"
  viewBox="0 0 16 16"
  aria-hidden="true"
  focusable="false"
>
  <path
    d="M3.5 9.83366C3.35833 9.83366 3.23961 9.78571 3.14383 9.68983C3.04794 9.59394 3 9.47516 3 9.33349C3 9.19171 3.04794 9.07299 3.14383 8.97733C3.23961 8.88155 3.35833 8.83366 3.5 8.83366H12.5C12.6417 8.83366 12.7604 8.8816 12.8562 8.97749C12.9521 9.07338 13 9.19216 13 9.33383C13 9.4756 12.9521 9.59433 12.8562 9.68999C12.7604 9.78577 12.6417 9.83366 12.5 9.83366H3.5ZM3.5 7.16699C3.35833 7.16699 3.23961 7.11905 3.14383 7.02316C3.04794 6.92727 3 6.80849 3 6.66683C3 6.52505 3.04794 6.40633 3.14383 6.31066C3.23961 6.21488 3.35833 6.16699 3.5 6.16699H12.5C12.6417 6.16699 12.7604 6.21494 12.8562 6.31083C12.9521 6.40671 13 6.52549 13 6.66716C13 6.80894 12.9521 6.92766 12.8562 7.02333C12.7604 7.1191 12.6417 7.16699 12.5 7.16699H3.5Z"
  />
</svg>`;
