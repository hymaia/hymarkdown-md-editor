import { $nodeSchema, $remark, $view } from '@milkdown/utils';
import remarkFrontmatter from 'remark-frontmatter';
import yaml from 'js-yaml';

export const remarkFrontmatterPlugin = $remark('remarkFrontmatter', () => {
    return function () {
        // this -> Unified processor
        return remarkFrontmatter.call(this, ['yaml']);
    };
});

export const aiSkillsMetadataSchema = $nodeSchema('aiSkillsMetadata', () => ({
    group: 'block',
    atom: true,
    isolating: true,
    attrs: {
        rawYaml: { default: '' },
        yamlData: { default: {} }
    },
    parseMarkdown: {
        match: (node) => {
            return node.type === 'yaml';
        },
        runner: (state, node, type) => {
            const rawYaml = node.value;
            let yamlData = {};
            try {
                yamlData = yaml.load(rawYaml) || {};
            } catch (error) {
                console.error('YAML parse failed:', error);
            }
            state.addNode(type, { rawYaml, yamlData });
        }
    },
    toMarkdown: {
        match: (node) => node.type.name === 'aiSkillsMetadata',
        runner: (state, node) => {
            state.addNode('yaml', undefined, node.attrs.rawYaml);
        }
    },
    parseDOM: [{
        tag: 'div[data-type="ai-skills-metadata"]',
        getAttrs: () => ({})
    }],
    toDOM: () => ['div', { 'data-type': 'ai-skills-metadata' }, 'Metadata Table']
}));


export const aiSkillsMetadataView = $view(aiSkillsMetadataSchema.node, () => {
    return (node, view, getPos) => {
        const dom = document.createElement('div');
        dom.setAttribute('data-type', 'ai-skills-metadata');
        dom.className = 'ai-skills-metadata-container';
        dom.style.margin = '1.5rem 0';
        dom.style.fontFamily = 'sans-serif';

        const renderTable = () => {
            dom.innerHTML = ''; 
            const table = document.createElement('table');
            table.style.width = '100%';
            table.style.borderCollapse = 'collapse';
            table.style.textAlign = 'left';

            const yamlData = node.attrs.yamlData || {};

            Object.entries(yamlData).forEach(([key, value]) => {
                const tr = document.createElement('tr');
                const tdKey = document.createElement('th');
                tdKey.textContent = key;
                tdKey.style.fontWeight = '600';
                tdKey.style.padding = '8px';
                tdKey.style.border = '1px solid #ddd';
                tdKey.style.backgroundColor = '#f9fafb';
                tdKey.style.width = '30%';

                const tdValue = document.createElement('td');
                tdValue.textContent = value;
                tdValue.style.padding = '8px';
                tdValue.style.border = '1px solid #ddd';
                tdValue.style.width = '70%';
                tdValue.style.cursor = 'text';

                tdValue.addEventListener('dblclick', () => {
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = value;
                    input.style.width = '100%';
                    input.style.boxSizing = 'border-box';
                    input.style.padding = '4px';
                    input.style.outline = 'none';
                    input.style.border = '1px solid #3b82f6';

                    const save = () => {
                        const newValue = input.value;
                        if (newValue !== value) {
                            const newData = { ...yamlData, [key]: newValue };
                            const newRawYaml = yaml.dump(newData, {lineWidth: -1});
                            const tr = view.state.tr.setNodeMarkup(getPos(), undefined, {
                                rawYaml: newRawYaml.trim(),
                                yamlData: newData
                            });
                            view.dispatch(tr);
                        } else {
                            renderTable();
                        }
                    };

                    input.addEventListener('blur', save);
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            input.blur(); 
                        } else if (e.key === 'Escape') {
                            renderTable();
                        }
                    });

                    tdValue.innerHTML = '';
                    tdValue.appendChild(input);
                    input.focus();
                });

                tr.appendChild(tdKey);
                tr.appendChild(tdValue);
                table.appendChild(tr);
            });

            dom.appendChild(table);
        };

        renderTable();

        return {
            dom,
            update: (updatedNode) => {
                if (updatedNode.type.name !== 'aiSkillsMetadata') return false;
                node = updatedNode;
                renderTable();
                return true;
            },
            stopEvent: (e) => {
                return e.target.tagName === 'INPUT';
            }
        };
    };
});


export const aiSkillsMetadataPlugin = [
    remarkFrontmatterPlugin,
    aiSkillsMetadataSchema,
    aiSkillsMetadataView
];