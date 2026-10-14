function xmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime() {
  return { date: (1 << 5) | 1, time: 0 };
}

/** A bounded, dependency-free ZIP writer using stored entries. */
export function zipArchive(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const { date, time } = dosDateTime();
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    name.copy(header, 30);
    local.push(header, data);
    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(date, 14);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    name.copy(directory, 46);
    central.push(directory);
    offset += header.length + data.length;
  }
  const localData = Buffer.concat(local);
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(localData.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localData, centralData, end]);
}

function deliverySuffix(segment) {
  if (segment.delivery === 'voice_over') return ' (V.O.)';
  if (segment.delivery === 'off_screen') return ' (O.S.)';
  return '';
}

function targetText(segment) {
  const value = segment.manual_translation ?? segment.translation;
  if (value !== null && value !== undefined && String(value).trim()) return String(value);
  return `UNTRANSLATED — ${String(segment.text ?? '')}`;
}

function isStructural(segment) {
  return ['scene_heading', 'character', 'parenthetical', 'dialogue', 'action', 'transition'].includes(segment.type);
}

function paragraphType(segment) {
  return ({ scene_heading: 'Scene Heading', character: 'Character', dialogue: 'Dialogue', parenthetical: 'Parenthetical', transition: 'Transition', action: 'Action' })[segment.type] || 'Action';
}

function contentFor(segment) {
  if (!isStructural(segment)) return null;
  if (segment.type === 'character') return `${segment.text}${deliverySuffix(segment)}`;
  return targetText(segment);
}

function wordParagraph(text, style = 'Action') {
  return `<w:p><w:pPr><w:pStyle w:val="${xmlEscape(style.replace(/\s+/g, ''))}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

export function exportDocx({ project, segments }) {
  const paragraphs = segments.map(segment => {
    const value = contentFor(segment);
    return value === null ? '' : wordParagraph(value, paragraphType(segment));
  }).filter(Boolean).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  return { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx', content: zipArchive([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
  ]) };
}

export function exportFdx({ segments }) {
  const paragraphs = segments.map(segment => {
    const value = contentFor(segment);
    return value === null ? '' : `<Paragraph Type="${xmlEscape(paragraphType(segment))}"><Text>${xmlEscape(value)}</Text></Paragraph>`;
  }).filter(Boolean).join('');
  return { contentType: 'application/xml; charset=utf-8', extension: 'fdx', content: `<?xml version="1.0" encoding="UTF-8"?><FinalDraft DocumentType="Script" Version="5"><Content>${paragraphs}</Content></FinalDraft>` };
}

export function exportFountain({ project, segments, warnings = { count: 0 } }) {
  const lines = [`Title: ${project.title}`, `# CineVerse export`, `# Warnings: ${warnings.count}`, ''];
  for (const segment of segments) {
    if (!isStructural(segment)) continue;
    if (segment.type === 'scene_heading') lines.push('', String(contentFor(segment)).toUpperCase(), '');
    else if (segment.type === 'character') lines.push('', `${segment.text}${deliverySuffix(segment)}`);
    else if (segment.type === 'parenthetical' || segment.type === 'dialogue') lines.push(contentFor(segment));
    else if (segment.type === 'transition') lines.push('', String(segment.text).toUpperCase(), '');
    else lines.push(contentFor(segment));
  }
  return { contentType: 'text/plain; charset=utf-8', extension: 'fountain', content: `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n` };
}

export function exportScreenplayText({ project, segments, warnings = { count: 0 } }) {
  const lines = [`# CineVerse export: ${project.title}`, `# Warnings: ${warnings.count}`, ''];
  for (const segment of segments) {
    if (!isStructural(segment)) continue;
    if (segment.type === 'scene_heading') lines.push('', String(contentFor(segment)).toUpperCase(), '');
    else if (segment.type === 'character') lines.push('', `${segment.text}${deliverySuffix(segment)}`);
    else if (segment.type === 'transition') lines.push('', String(segment.text).toUpperCase(), '');
    else lines.push(contentFor(segment));
  }
  return { contentType: 'text/plain; charset=utf-8', extension: 'txt', content: `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n` };
}
