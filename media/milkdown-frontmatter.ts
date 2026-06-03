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
    dom.className = "frontmatter-panel";

    const renderTable = () => {
      dom.replaceChildren();

      const title = document.createElement("div");
      title.className = "frontmatter-title";
      title.textContent = "Frontmatter";
      dom.appendChild(title);

      const yamlData = (node.attrs.yamlData ?? {}) as YamlRecord;
      const entries = Object.entries(yamlData);
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "frontmatter-empty";
        empty.textContent = "No metadata";
        dom.appendChild(empty);
        return;
      }

      const table = document.createElement("table");
      const tbody = document.createElement("tbody");
      table.appendChild(tbody);

      for (const [key, value] of entries) {
        const row = document.createElement("tr");

        const keyCell = document.createElement("th");
        keyCell.scope = "row";
        keyCell.textContent = key;

        const valueCell = document.createElement("td");
        valueCell.textContent = stringifyValue(value);
        valueCell.title = "Double-click to edit";
        valueCell.addEventListener("dblclick", () => {
          editValue(key, value, valueCell);
        });

        row.append(keyCell, valueCell);
        tbody.appendChild(row);
      }

      dom.appendChild(table);
    };

    const editValue = (key: string, previousValue: unknown, cell: HTMLTableCellElement) => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = stringifyValue(previousValue);
      input.className = "frontmatter-input";

      const cancel = () => {
        renderTable();
      };

      const save = () => {
        const yamlData = (node.attrs.yamlData ?? {}) as YamlRecord;
        const nextValue = Array.isArray(previousValue)
          ? input.value
              .split(",")
              .map(item => item.trim())
              .filter(Boolean)
          : input.value;
        const nextData = { ...yamlData, [key]: nextValue };
        const rawYaml = yaml.dump(nextData, { lineWidth: -1 }).trim();
        const transaction = view.state.tr.setNodeMarkup(getPos(), undefined, {
          rawYaml,
          yamlData: nextData
        });
        view.dispatch(transaction);
      };

      input.addEventListener("blur", save);
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          input.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      });

      cell.replaceChildren(input);
      input.focus();
      input.select();
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
      stopEvent: event => event.target instanceof HTMLInputElement
    };
  };
});

function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(", ");
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
