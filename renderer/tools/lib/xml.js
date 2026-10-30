// XML pretty-printer (uses the browser's DOMParser). Returns null for invalid XML.
export function formatXml(xmlStr) {
  try {
    const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    const decl = xmlStr.trim().match(/^<\?xml[^?]*\?>/)?.[0];
    // Keep top-level comments/PIs around the root element, not just the root itself.
    const body = Array.from(doc.childNodes).map((c) => serializeNode(c, 0)).filter(Boolean).join('\n');
    return decl ? decl + '\n' + body : body;
  } catch { return null; }
}

// textContent/attribute values come back decoded, so re-escape them or the output isn't valid XML.
const xmlText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlAttr = (s) => xmlText(s).replace(/"/g, '&quot;');

function serializeNode(node, depth) {
  const pad = '  '.repeat(depth);
  switch (node.nodeType) {
    case Node.TEXT_NODE: { const t = node.textContent.trim(); return t ? pad + xmlText(t) : ''; }
    case Node.CDATA_SECTION_NODE: return `${pad}<![CDATA[${node.data}]]>`;
    case Node.PROCESSING_INSTRUCTION_NODE: return `${pad}<?${node.target} ${node.data}?>`;
    case Node.COMMENT_NODE: return `${pad}<!--${node.data}-->`;
    case Node.ELEMENT_NODE: break;
    default: return '';
  }
  const tag = node.tagName;
  const attrs = Array.from(node.attributes).map((a) => ` ${a.name}="${xmlAttr(a.value)}"`).join('');
  const children = Array.from(node.childNodes).map((c) => serializeNode(c, depth + 1)).filter(Boolean);
  if (!children.length) return `${pad}<${tag}${attrs}/>`;
  if (children.length === 1 && !children[0].includes('\n')) return `${pad}<${tag}${attrs}>${children[0].trim()}</${tag}>`;
  return `${pad}<${tag}${attrs}>\n${children.join('\n')}\n${pad}</${tag}>`;
}
