/* ==========================================================================
   Djignan Financial System — Export « preuve » (PDF à imprimer + Excel)
   Génère, pour UN élément (investissement, dette/créance, compte gardé), un
   document daté — informations, synthèse chiffrée, historique complet, zone de
   signature — à imprimer ou à conserver ailleurs comme preuve physique.

   Ce module ne connaît AUCUNE logique métier : chaque module de vue construit
   son propre « modèle de document » (il connaît ses données et ses calculs) et
   le passe à openProofExportModal(). Pas de dépendance circulaire, pas de
   duplication des calculs.

   Modèle de document :
   {
     title:     "Fiche d'investissement",          // type de document
     subtitle:  'Appartement Cocody',              // nom de l'élément
     warnings:  ['…'],                             // optionnel, affichés avant l'export
     signatures: ['Le déclarant (X)', 'Y'],        // libellés des zones de signature
     blocks: [
       { type: 'rows',  heading, rows: [[libellé, cellule], …] },
       { type: 'text',  heading, text },
       { type: 'table', heading, columns: [{ label, align: 'left'|'right', weight }],
                        rows: [[cellule, …], …], totals?: [cellule, …] },
     ],
   }
   Cellule : chaîne | { amount, currency } | { date: 'AAAA-MM-JJ' }
   Les montants et dates restent de VRAIS nombres/dates dans l'Excel (triables,
   sommables), et sont mis en forme lisible dans le PDF.

   Le fichier .xlsx est écrit à la main (ZIP non compressé + XML minimal) : le
   projet n'a ni bundler ni dépendance npm, donc pas de bibliothèque Excel.
   ========================================================================== */

import { formatCurrency, formatDate, escapeHtml, openModal, showToast, localISODate, ZERO_DECIMAL_CURRENCIES } from './utils.js';
import { getSetting } from './db.js';
import { t } from './i18n.js';
import { icon as svgIcon } from './icons.js';

export const PRINT_ICON = svgIcon('print', 16);

/* ---------- Préparation commune ---------- */

/** Mêmes espaces fines/insécables que dans reports.js : la police intégrée de jsPDF (Helvetica,
    WinAnsi) ne sait pas les dessiner et affiche un caractère de repli qui ressemble à « / ». */
const PDF_UNSAFE_SPACES_RE = new RegExp('[' + [0x202f, 0x00a0, 0x2009, 0x2007].map((c) => String.fromCharCode(c)).join('') + ']', 'g');
function pdfAmount(amount, currency) {
  return formatCurrency(amount, currency).replace(PDF_UNSAFE_SPACES_RE, ' ');
}

function cellText(cell) {
  if (cell == null) return '';
  if (typeof cell === 'string' || typeof cell === 'number') return String(cell);
  if (cell.amount !== undefined) return pdfAmount(cell.amount, cell.currency);
  if (cell.date !== undefined) return cell.date ? formatDate(cell.date) : '';
  return '';
}

/** Ajoute ce qui ne dépend pas de l'élément exporté : qui établit le document, et quand. */
async function prepareModel(model) {
  const profile = await getSetting('userProfile', {});
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return {
    ...model,
    issuer: [[profile.firstName, profile.lastName].filter(Boolean).join(' '), profile.jobTitle, profile.address, profile.phone].filter(Boolean),
    generatedLabel: t('Document généré le {date} à {time}', { date: formatDate(localISODate(now)), time }),
  };
}

const COMBINING_MARKS_RE = new RegExp('[\\u0300-\\u036f]', 'g');
function filenameBase(model) {
  const slug = `${model.title}-${model.subtitle}`
    .normalize('NFD').replace(COMBINING_MARKS_RE, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return `djignan-${slug}-${localISODate()}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ==========================================================================
   PDF (jsPDF, déjà vendorisé)
   ========================================================================== */
function buildPdf(model) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const PAGE_W = 210;
  const M = 14;
  const CONTENT_W = PAGE_W - 2 * M;
  const BOTTOM = 278;
  const LINE = 4.8;
  let y = 18;

  const ensureSpace = (height) => {
    if (y + height > BOTTOM) { doc.addPage(); y = 18; }
  };
  const gray = () => doc.setTextColor(110, 115, 140);
  const dark = () => doc.setTextColor(25, 28, 45);
  const accent = () => doc.setTextColor(79, 91, 255);

  // En-tête
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); gray();
  doc.text('Djignan Financial System', M, y); y += 7;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); dark();
  doc.text(doc.splitTextToSize(model.title, CONTENT_W), M, y); y += 8;
  doc.setFontSize(13);
  const subtitleLines = doc.splitTextToSize(model.subtitle, CONTENT_W);
  doc.text(subtitleLines, M, y); y += subtitleLines.length * 6 + 1;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); gray();
  for (const line of model.issuer) { doc.text(doc.splitTextToSize(line, CONTENT_W), M, y); y += 4.6; }
  doc.text(model.generatedLabel, M, y); y += 4;
  doc.setDrawColor(200, 204, 220); doc.line(M, y, PAGE_W - M, y); y += 7;

  const heading = (label) => {
    ensureSpace(14);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); accent();
    doc.text(label, M, y); y += 6;
  };

  for (const block of model.blocks) {
    heading(block.heading);

    if (block.type === 'rows') {
      const labelW = 62;
      for (const [label, cell] of block.rows) {
        const valueLines = doc.splitTextToSize(cellText(cell) || '—', CONTENT_W - labelW);
        ensureSpace(valueLines.length * LINE + 2);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); gray();
        doc.text(label, M, y);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); dark();
        doc.text(valueLines, M + labelW, y);
        y += valueLines.length * LINE + 1.2;
        doc.setDrawColor(235, 237, 245); doc.line(M, y - 3.4, PAGE_W - M, y - 3.4);
      }
      y += 5;
    } else if (block.type === 'text') {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); dark();
      for (const line of doc.splitTextToSize(block.text || '—', CONTENT_W)) {
        ensureSpace(LINE + 1);
        doc.text(line, M, y); y += LINE;
      }
      y += 5;
    } else if (block.type === 'table') {
      const totalWeight = block.columns.reduce((s, c) => s + c.weight, 0);
      const widths = block.columns.map((c) => (c.weight / totalWeight) * CONTENT_W);
      const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : M); return acc; }, []);
      const headerCells = block.columns.map((c) => c.label);
      const drawRow = (cells, { bold = false, header = false } = {}) => {
        doc.setFont('helvetica', bold || header ? 'bold' : 'normal'); doc.setFontSize(9);
        const lines = cells.map((cell, i) => doc.splitTextToSize(cellText(cell), widths[i] - 3));
        const rowH = Math.max(...lines.map((l) => l.length)) * 4.2 + 2.4;
        if (y + rowH > BOTTOM) {
          // Nouvelle page : on répète l'en-tête du tableau pour que chaque page reste lisible seule.
          doc.addPage(); y = 18;
          if (!header) { drawRow(headerCells, { header: true }); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(9); }
        }
        if (header) { doc.setFillColor(232, 234, 255); doc.rect(M, y - 4, CONTENT_W, rowH, 'F'); }
        dark();
        lines.forEach((cellLines, i) => {
          const align = block.columns[i].align;
          doc.text(cellLines, align === 'right' ? xs[i] + widths[i] - 1.5 : xs[i] + 1.5, y, align === 'right' ? { align: 'right' } : undefined);
        });
        y += rowH;
        doc.setDrawColor(228, 230, 240); doc.line(M, y - 4, PAGE_W - M, y - 4);
      };
      ensureSpace(20);
      drawRow(headerCells, { header: true });
      if (!block.rows.length) {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(9); gray();
        doc.text(t('Aucun mouvement enregistré.'), M + 1.5, y); y += 6;
      }
      for (const row of block.rows) drawRow(row);
      if (block.totals) drawRow(block.totals, { bold: true });
      y += 5;
    }
  }

  // Zone(s) de signature
  if (model.signatures?.length) {
    ensureSpace(42);
    heading(t('Validation'));
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); dark();
    doc.text(t('Fait le ____________________ à ____________________'), M, y); y += 7;
    const boxW = (CONTENT_W - 8 * (model.signatures.length - 1)) / model.signatures.length;
    model.signatures.forEach((label, i) => {
      const x = M + i * (boxW + 8);
      doc.setDrawColor(150, 155, 180); doc.rect(x, y, boxW, 22);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); gray();
      doc.text(doc.splitTextToSize(`${t('Signature')} — ${label}`, boxW - 4), x + 2, y + 5);
    });
    y += 26;
  }

  // Pied de page sur chaque page (le nombre total n'est connu qu'à la fin)
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); gray();
    const footer = doc.splitTextToSize(`Djignan Financial System — ${model.title} — ${model.subtitle}`, CONTENT_W - 30)[0];
    doc.text(footer, M, 290);
    doc.text(t('Page {page} / {total}', { page: i, total }), PAGE_W - M, 290, { align: 'right' });
  }
  return doc;
}

/* ==========================================================================
   Excel (.xlsx) — écrit à la main
   ========================================================================== */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const S = { DEFAULT: 0, BOLD: 1, HEADER: 2, DATE: 3, MONEY2: 4, MONEY0: 5, TITLE: 6, WRAP: 7 };

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const XML_CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');
const xmlEscape = (value) => String(value).replace(XML_CONTROL_CHARS_RE, '').replace(/[&<>"]/g, (c) => XML_ESCAPES[c]);

function colName(index) {
  let n = index;
  let name = '';
  do { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return name;
}

function excelDateSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Cellule du modèle -> { xml(ref), width } pour une cellule de feuille. `style` impose un style de
    texte (titre, en-tête, gras, retour à la ligne) ; les nombres et dates gardent leur format. */
function sheetCell(cell, ref, style = S.DEFAULT) {
  if (cell == null || cell === '') return { xml: '', width: 0 };
  if (typeof cell === 'number') return { xml: `<c r="${ref}"><v>${cell}</v></c>`, width: String(cell).length };
  if (typeof cell === 'object' && cell.amount !== undefined) {
    const fmt = ZERO_DECIMAL_CURRENCIES.has(cell.currency) ? S.MONEY0 : S.MONEY2;
    return { xml: `<c r="${ref}" s="${fmt}"><v>${Number(cell.amount) || 0}</v></c>`, width: 16 };
  }
  if (typeof cell === 'object' && cell.date !== undefined) {
    return cell.date
      ? { xml: `<c r="${ref}" s="${S.DATE}"><v>${excelDateSerial(cell.date)}</v></c>`, width: 12 }
      : { xml: '', width: 0 };
  }
  const text = String(cell);
  return {
    xml: `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`,
    width: style === S.WRAP ? 60 : Math.min(text.length, 60),
  };
}

/** Feuille = { name, rows: [[{ cell, style? } | cellule, …], …] }. */
function sheetXml(sheet) {
  const widths = [];
  const rowsXml = sheet.rows.map((row, ri) => {
    const cells = row.map((entry, ci) => {
      const isStyled = entry && typeof entry === 'object' && 'cell' in entry;
      const built = sheetCell(isStyled ? entry.cell : entry, `${colName(ci)}${ri + 1}`, isStyled ? entry.style : S.DEFAULT);
      widths[ci] = Math.max(widths[ci] || 0, built.width);
      return built.xml;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(11, w + 3))}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>${cols}</cols><sheetData>${rowsXml}</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EAFF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment horizontal="left"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Modèle de document -> feuilles : « Résumé » (informations, synthèse, textes) puis une feuille par
    tableau (en-têtes en première ligne, directement exploitable en tri/filtre/tableau croisé). */
function modelToSheets(model) {
  const summaryRows = [
    [{ cell: model.title, style: S.TITLE }],
    [{ cell: model.subtitle, style: S.BOLD }],
    ...model.issuer.map((line) => [line]),
    [model.generatedLabel],
    [],
  ];
  const tableSheets = [];
  for (const block of model.blocks) {
    if (block.type === 'rows') {
      summaryRows.push([{ cell: block.heading, style: S.BOLD }]);
      for (const [label, cell] of block.rows) summaryRows.push([label, cell]);
      summaryRows.push([]);
    } else if (block.type === 'text') {
      summaryRows.push([{ cell: block.heading, style: S.BOLD }, { cell: block.text || '—', style: S.WRAP }]);
      summaryRows.push([]);
    } else if (block.type === 'table') {
      const rows = [block.columns.map((c) => ({ cell: c.label, style: S.HEADER })), ...block.rows];
      if (block.totals) rows.push(block.totals.map((cell) => (typeof cell === 'string' ? { cell, style: S.BOLD } : cell)));
      tableSheets.push({ name: block.heading, rows });
    }
  }
  const used = new Set();
  const named = [{ name: t('Résumé'), rows: summaryRows }, ...tableSheets].map((sheet) => {
    // Excel limite un nom de feuille à 31 caractères et refuse [ ] : * ? / \
    const base = sheet.name.replace(/[\][:*?/\\]/g, ' ').trim() || 'Feuille';
    let name = base.slice(0, 31);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return { ...sheet, name };
  });
  return named;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP « stocké » (sans compression) : suffisant pour un .xlsx de quelques Ko, et évite d'embarquer
    un compresseur. Noms de fichiers en UTF-8 (bit 11). */
function buildZip(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, data);

    const entry = new Uint8Array(46 + name.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true); ev.setUint16(4, 20, true); ev.setUint16(6, 20, true); ev.setUint16(8, 0x0800, true); ev.setUint16(10, 0, true);
    ev.setUint16(12, dosTime, true); ev.setUint16(14, dosDate, true);
    ev.setUint32(16, crc, true); ev.setUint32(20, data.length, true); ev.setUint32(24, data.length, true);
    ev.setUint16(28, name.length, true);
    ev.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, e) => sum + e.length, 0);
  const end = new Uint8Array(22);
  const dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, files.length, true); dv.setUint16(10, files.length, true);
  dv.setUint32(12, centralSize, true); dv.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: XLSX_MIME });
}

function buildXlsx(model) {
  const sheets = modelToSheets(model);
  const sheetEntries = sheets.map((_, i) => i + 1);
  const files = [
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetEntries.map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetEntries.map((n) => `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', content: STYLES_XML },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(sheet) })),
  ];
  return buildZip(files);
}

/* ==========================================================================
   Interface : petite modale PDF / Imprimer / Excel
   ========================================================================== */
export async function generateProof(model, kind) {
  const prepared = await prepareModel(model);
  const base = filenameBase(prepared);
  if (kind === 'xlsx') {
    downloadBlob(buildXlsx(prepared), `${base}.xlsx`);
    return;
  }
  if (!window.jspdf) throw new Error(t("La bibliothèque PDF n'est pas chargée (vendor/jspdf.umd.min.js manquant)."));
  const doc = buildPdf(prepared);
  if (kind === 'print') {
    doc.autoPrint();
    // window.open peut être refusé (bloqueur de fenêtres, certaines WebViews natives) : repli sur
    // un téléchargement plutôt que de ne rien faire.
    const opened = window.open(doc.output('bloburl'), '_blank');
    if (!opened) doc.save(`${base}.pdf`);
    return;
  }
  doc.save(`${base}.pdf`);
}

/** `buildDocument` est appelée à l'ouverture (données fraîches) et renvoie le modèle de document. */
export async function openProofExportModal(buildDocument) {
  let model;
  try {
    model = await buildDocument();
  } catch (err) {
    console.warn('[ProofExport]', err);
    showToast(t('Échec de la génération du document.'));
    return;
  }
  const modal = openModal(`
    <p style="margin:0 0 12px;" class="fs-13 c-muted">${t("Génère un document daté (informations, synthèse, historique complet et zone de signature) à imprimer ou à conserver ailleurs comme preuve.")}</p>
    ${(model.warnings || []).map((w) => `<div class="alert alert-warn mb-12">${escapeHtml(w)}</div>`).join('')}
    <div class="proof-actions">
      <button type="button" class="btn btn-primary" data-proof="pdf">${t('Télécharger le PDF')}</button>
      <button type="button" class="btn btn-ghost" data-proof="print">${t('Imprimer')}</button>
      <button type="button" class="btn btn-ghost" data-proof="xlsx">${t('Excel (.xlsx)')}</button>
    </div>`, { title: t('Exporter — {name}', { name: model.subtitle }) });

  modal.el.querySelectorAll('[data-proof]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await generateProof(model, btn.dataset.proof);
        if (btn.dataset.proof !== 'print') showToast(t('Document généré.'));
      } catch (err) {
        console.warn('[ProofExport]', err);
        showToast(err.message || t('Échec de la génération du document.'));
      } finally {
        btn.disabled = false;
      }
    });
  });
}
