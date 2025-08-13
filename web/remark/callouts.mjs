import { visit } from 'unist-util-visit';

// Supports blockquote callouts like:
// > [INFO] Message
// > [!NOTE] Message
// > [WARNING] Message
// The tag (with or without !) is removed from the content and the blockquote
// is annotated with class "callout" and data-callout="type" for styling.
export default function remarkCallouts() {
  const TYPE_NORMALIZATION = {
    info: 'info',
    note: 'note',
    tip: 'tip',
    warning: 'warning',
    warn: 'warning',
    caution: 'caution',
    important: 'important',
    success: 'success',
    error: 'error',
  };

  const TAG_REGEX =
    /^\s*\[\s*!?(INFO|NOTE|TIP|WARNING|WARN|CAUTION|IMPORTANT|SUCCESS|ERROR)\s*\]\s*:?-?\s*/i;

  return (tree) => {
    visit(tree, 'blockquote', (node) => {
      if (!node.children || node.children.length === 0) return;
      const firstChild = node.children[0];
      if (
        !firstChild ||
        firstChild.type !== 'paragraph' ||
        !firstChild.children
      )
        return;

      // Find the first text node in the first paragraph
      const textIndex = firstChild.children.findIndex(
        (c) => c.type === 'text' && typeof c.value === 'string'
      );
      if (textIndex === -1) return;

      const original = firstChild.children[textIndex].value;
      const match = TAG_REGEX.exec(original);
      if (!match) return;

      const tag = match[1].toLowerCase();
      const normalized = TYPE_NORMALIZATION[tag] ?? 'info';

      // Strip the leading tag from the text content
      firstChild.children[textIndex].value = original.replace(TAG_REGEX, '');

      if (!node.data) node.data = {};
      if (!node.data.hProperties) node.data.hProperties = {};
      const existingClass = node.data.hProperties.class || '';
      node.data.hProperties.class = `${existingClass} callout`.trim();
      node.data.hProperties['data-callout'] = normalized;
    });
  };
}
