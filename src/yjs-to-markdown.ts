import * as Y from 'yjs';
import { docUrl } from './config.ts';

type Node = Y.XmlElement | Y.XmlText | Y.XmlHook;

interface DeltaOp {
  insert?: unknown;
  attributes?: Record<string, any>;
}

/** Décode le contenu Y.js (base64) d'un document Docs et le convertit en Markdown. */
export function yjsToMarkdown(base64: string): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(base64, 'base64'));
  // Le contenu BlockNote est dans le fragment "document-store".
  const root = doc.getXmlFragment('document-store');
  const lines: string[] = [];
  for (const child of root.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === 'blockGroup') {
      renderBlockGroup(child, '', lines);
    } else if (child instanceof Y.XmlElement) {
      lines.push(textOf(child));
    }
  }
  return collapseBlankLines(lines.join('\n')).trim() + '\n';
}

function renderBlockGroup(group: Y.XmlElement, indent: string, out: string[]): void {
  let number = 0;
  let previousList: string | undefined;
  for (const container of group.toArray()) {
    if (!(container instanceof Y.XmlElement)) continue;
    const children = container.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    const content = children.find((c) => c.nodeName !== 'blockGroup');
    const nested = children.find((c) => c.nodeName === 'blockGroup');

    number = content?.nodeName === 'numberedListItem' ? number + 1 : 0;
    if (content) {
      const block = renderBlock(content, number);
      const isListItem = /ListItem$/.test(content.nodeName);
      // Deux listes de types différents doivent être séparées, sinon elles fusionnent.
      if (isListItem && previousList && previousList !== content.nodeName) out.push('');
      previousList = isListItem ? content.nodeName : undefined;
      out.push(...block.split('\n').map((l) => (l ? indent + l : l)));
      if (!isListItem) out.push('');
    }
    if (nested) renderBlockGroup(nested, indent + '    ', out);
  }
  out.push('');
}

function renderBlock(el: Y.XmlElement, number: number): string {
  const attr = (k: string) => el.getAttribute(k) as unknown;
  const text = () => inline(el);
  switch (el.nodeName) {
    case 'heading':
      return `${'#'.repeat(Math.min(Number(attr('level')) || 1, 6))} ${text()}`;
    case 'paragraph':
      return text();
    case 'bulletListItem':
    case 'toggleListItem':
      return `- ${text()}`;
    case 'numberedListItem':
      return `${number}. ${text()}`;
    case 'checkListItem':
      return `- [${String(attr('checked')) === 'true' ? 'x' : ' '}] ${text()}`;
    case 'quote':
    case 'callout':
      return text()
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'codeBlock':
      return '```' + String(attr('language') ?? '') + '\n' + textOf(el) + '\n```';
    case 'divider':
      return '---';
    case 'table':
      return renderTable(el);
    case 'image': {
      const url = String(attr('url') ?? '');
      return url ? `![${String(attr('caption') ?? attr('name') ?? '')}](${url})` : '';
    }
    case 'file':
    case 'pdf':
    case 'video':
    case 'audio': {
      const url = String(attr('url') ?? '');
      return url ? `[${String(attr('name') ?? attr('caption') ?? el.nodeName)}](${url})` : '';
    }
    default:
      // Type inconnu : on garde au moins le texte pour la recherche.
      return text();
  }
}

function renderTable(table: Y.XmlElement): string {
  const rows = table
    .toArray()
    .filter((r): r is Y.XmlElement => r instanceof Y.XmlElement)
    .map((row) =>
      row
        .toArray()
        .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
        .map((cell) => inline(cell).replace(/\n/g, ' ').replace(/\|/g, '\\|')),
    );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

/** Contenu en ligne d'un bloc : texte formaté, liens, liens internes Docs. */
function inline(el: Y.XmlElement): string {
  let out = '';
  for (const child of el.toArray() as Node[]) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as DeltaOp[]) {
        if (typeof op.insert === 'string') out += formatRun(op.insert, op.attributes ?? {});
      }
    } else if (child instanceof Y.XmlElement) {
      out += inlineElement(child);
    }
  }
  return out;
}

function inlineElement(el: Y.XmlElement): string {
  switch (el.nodeName) {
    case 'hardBreak':
      return '\n';
    case 'interlinkingLinkInline': {
      const docId = String(el.getAttribute('docId') ?? '');
      const title = String(el.getAttribute('title') ?? '') || textOf(el) || 'document';
      return docId ? `[${title}](${docUrl(docId)})` : title;
    }
    default: {
      // Paragraphes de cellules de tableau, mentions, etc.
      const nested = inline(el);
      if (nested) return nested;
      const label = el.getAttribute('title') ?? el.getAttribute('text') ?? el.getAttribute('name');
      return label ? String(label) : '';
    }
  }
}

function formatRun(text: string, a: Record<string, any>): string {
  if (!text.trim()) return text;
  // Les marqueurs Markdown doivent entourer le texte sans ses espaces de bord.
  const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  let s = core;
  if (a.code) s = '`' + s + '`';
  if (a.bold) s = `**${s}**`;
  if (a.italic) s = `*${s}*`;
  if (a.strike) s = `~~${s}~~`;
  const href = a.link?.href ?? a.link;
  if (typeof href === 'string' && href) s = `[${s}](${href})`;
  return lead + s + trail;
}

/** Texte brut de tous les descendants. */
function textOf(el: Y.XmlElement): string {
  return (el.toArray() as Node[])
    .map((c) => {
      if (c instanceof Y.XmlText) {
        return (c.toDelta() as DeltaOp[])
          .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
          .join('');
      }
      return c instanceof Y.XmlElement ? textOf(c) : '';
    })
    .join('');
}

function collapseBlankLines(s: string): string {
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}
