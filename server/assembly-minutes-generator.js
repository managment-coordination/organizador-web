import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const COLORS = {
  dark: "111827",
  blue: "1F4E78",
  muted: "5B6573",
  line: "AAB3BE",
  pale: "EEF2F6",
  paleBlue: "DCE6F1",
  paleGreen: "E2F0D9",
  paleRed: "FCE4D6",
};

const clean = (value) => String(value ?? "").trim();
const number = (value, digits = 4) => Number(value || 0).toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function safeFilename(value) {
  return (clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "asamblea").slice(0, 90);
}

function borders() {
  const border = { style: BorderStyle.SINGLE, size: 1, color: COLORS.line };
  return { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
}

function paragraph(value, options = {}) {
  return new Paragraph({
    children: [new TextRun({ text: clean(value) || "-", bold: Boolean(options.bold), italics: Boolean(options.italics), color: options.color || COLORS.dark, size: options.size || 20 })],
    alignment: options.alignment || AlignmentType.JUSTIFIED,
    spacing: { before: options.before || 0, after: options.after ?? 120, line: options.line || 300 },
    keepNext: Boolean(options.keepNext),
    pageBreakBefore: Boolean(options.pageBreakBefore),
  });
}

function heading(value, level = 1, pageBreakBefore = false) {
  return new Paragraph({
    text: clean(value),
    heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
    pageBreakBefore,
    keepNext: true,
    spacing: { before: level === 1 ? 260 : 180, after: 100 },
  });
}

function cell(value, options = {}) {
  return new TableCell({
    shading: { type: ShadingType.CLEAR, fill: options.fill || "FFFFFF", color: "auto" },
    margins: { top: 70, bottom: 70, left: 80, right: 80 },
    children: [new Paragraph({
      children: [new TextRun({ text: clean(value) || "-", bold: Boolean(options.bold), color: options.color || COLORS.dark, size: options.size || 17 })],
      alignment: options.alignment || AlignmentType.LEFT,
      spacing: { after: 0 },
    })],
  });
}

function table(rows, header = false, widths = []) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: borders(),
    rows: rows.map((row, rowIndex) => new TableRow({
      tableHeader: header && rowIndex === 0,
      children: row.map((value, columnIndex) => cell(value, {
        fill: header && rowIndex === 0 ? COLORS.paleBlue : (rowIndex % 2 ? COLORS.pale : "FFFFFF"),
        bold: header && rowIndex === 0,
        alignment: columnIndex > 0 && widths.length ? AlignmentType.CENTER : AlignmentType.LEFT,
      })),
    })),
  });
}

function resultLabel(result, english = false) {
  if (!result?.base_votes) return english ? "No vote recorded" : "Sin votación registrada";
  if (result.approved) return english ? "APPROVED" : "APROBADO";
  return english ? "NOT APPROVED" : "NO APROBADO";
}

function resultTable(point, english = false) {
  const result = point.result || {};
  const labels = english
    ? { si: "In favour", no: "Against", abs: "Abstention", sin: "Not cast" }
    : { si: "A favor", no: "En contra", abs: "Abstención", sin: "Sin emitir" };
  const rows = [[english ? "Option" : "Opción", english ? "Votes" : "Votos", english ? "Coefficient" : "Coeficiente"]];
  for (const key of ["si", "no", "abs", "sin"]) rows.push([labels[key], result[key]?.votes || 0, number(result[key]?.coef || 0)]);
  rows.push([resultLabel(result, english), result.base_votes || 0, number(result.base_coef || 0)]);
  return table(rows, true, [58, 20, 22]);
}

function metadataTable(detail, minutes, english = false) {
  const item = detail.assembly || {};
  const rows = english ? [
    ["Community", item.comunidad], ["Meeting", item.nombre], ["Date and starting time", [item.fecha, item.hora_inicio].filter(Boolean).join(" ")],
    ["Place", item.lugar_celebracion || item.ubicacion], ["Call", item.convocatoria], ["President", item.presidente],
    ["Secretary / Administrator", minutes.secretario || item.administrador], ["Closing time", minutes.hora_cierre],
  ] : [
    ["Comunidad", item.comunidad], ["Asamblea", item.nombre], ["Fecha y hora de inicio", [item.fecha, item.hora_inicio].filter(Boolean).join(" ")],
    ["Lugar", item.lugar_celebracion || item.ubicacion], ["Convocatoria", item.convocatoria], ["Presidente", item.presidente],
    ["Secretario / Administrador", minutes.secretario || item.administrador], ["Hora de cierre", minutes.hora_cierre],
  ];
  return table(rows.map(([label, value]) => [label, value]), false);
}

function pointDraftMap(minutes) {
  return new Map((minutes.puntos || []).map((row) => [Number(row.id_punto), row]));
}

function meetingBody(detail, minutes, english = false) {
  const item = detail.assembly || {};
  const totals = detail.totals || {};
  const drafts = pointDraftMap(minutes);
  const points = detail.points || [];
  const body = [];
  const labels = english ? {
    title: "MINUTES", constitution: "1. Constitution of the meeting", quorum: "2. Attendance and voting quorum",
    agenda: "3. Agenda", point: "Agenda item", debate: "Discussion", agreement: "Resolution", close: "Closing of the meeting",
    signaturePresident: "The President", signatureSecretary: "The Secretary / Administrator",
  } : {
    title: "ACTA", constitution: "1. Constitución de la asamblea", quorum: "2. Asistencia y cuórum de votación",
    agenda: "3. Orden del día", point: "Punto", debate: "Exposición y debate", agreement: "Acuerdo", close: "Cierre de la sesión",
    signaturePresident: "El Presidente", signatureSecretary: "El Secretario / Administrador",
  };

  body.push(paragraph(labels.title, { bold: true, size: 34, alignment: AlignmentType.CENTER, after: 40 }));
  body.push(paragraph(item.nombre, { bold: true, size: 28, alignment: AlignmentType.CENTER, after: 30 }));
  body.push(paragraph(item.comunidad, { bold: true, size: 22, alignment: AlignmentType.CENTER, color: COLORS.blue, after: 220 }));
  body.push(metadataTable(detail, minutes, english));
  body.push(heading(labels.constitution));
  const defaultOpening = english
    ? `The meeting is constituted at the place, date and time stated above, chaired by ${clean(item.presidente) || "the appointed President"}, with ${clean(minutes.secretario || item.administrador) || "the appointed Secretary/Administrator"} acting as secretary.`
    : `En el lugar, fecha y hora indicados queda constituida la asamblea, bajo la presidencia de ${clean(item.presidente) || "la persona designada"}, actuando como Secretario/Administrador ${clean(minutes.secretario || item.administrador) || "la persona designada"}.`;
  body.push(paragraph((english ? minutes.introduccion_en : minutes.introduccion_es) || defaultOpening));
  body.push(heading(labels.quorum));
  const quorum = english
    ? `${totals.attended_owners || 0} owners attend in person or by representation, representing a coefficient of ${number(totals.attended_coef)}. The legal voting base registered in the application comprises ${totals.eligible_votes || 0} owners and a coefficient of ${number(totals.eligible_coef)}. ${totals.without_vote || 0} attending owner(s) are recorded without voting rights and are excluded from that base.`
    : `Asisten personalmente o por representación ${totals.attended_owners || 0} propietarios, que representan un coeficiente de ${number(totals.attended_coef)}. La base con derecho a voto registrada en la aplicación comprende ${totals.eligible_votes || 0} propietarios y un coeficiente de ${number(totals.eligible_coef)}. Constan ${totals.without_vote || 0} asistentes sin derecho a voto, excluidos de dicha base.`;
  body.push(paragraph(quorum));
  const withoutVote = (detail.attendance || []).filter((row) => row.sin_voto || row.moroso);
  if (withoutVote.length) body.push(table([[english ? "Owner without voting rights" : "Propietario sin derecho a voto", english ? "Coefficient" : "Coeficiente"], ...withoutVote.map((row) => [row.propietario, number(row.coeficiente)])], true));
  body.push(heading(labels.agenda));
  points.forEach((point, index) => body.push(paragraph(`P${index + 1}. ${point.titulo}`, { bold: true, keepNext: true })));

  points.forEach((point, index) => {
    const draft = drafts.get(Number(point.id_punto)) || {};
    const debate = english ? draft.debate_en : draft.debate_es;
    const agreement = english ? draft.acuerdo_en : draft.acuerdo_es;
    const automaticAgreement = english
      ? `The result recorded by the application is: ${resultLabel(point.result, true)}.`
      : `El resultado registrado por la aplicación es: ${resultLabel(point.result, false)}.`;
    body.push(heading(`${labels.point} ${index + 1}. ${point.titulo}`, 1, index === 0));
    body.push(heading(labels.debate, 2));
    body.push(paragraph(debate || (english ? "Pending review and completion from the meeting transcript." : "Pendiente de revisión y cumplimentación a partir de la transcripción de la sesión."), { italics: !debate }));
    body.push(heading(labels.agreement, 2));
    body.push(paragraph(agreement || automaticAgreement, { bold: true }));
    body.push(resultTable(point, english));
  });

  body.push(heading(labels.close, 1, true));
  const defaultClosing = english
    ? `There being no further business, the meeting is closed at ${clean(minutes.hora_cierre) || "the time pending confirmation"}. These minutes are issued for review and signature by the President and the Secretary/Administrator.`
    : `No habiendo más asuntos que tratar, se levanta la sesión a las ${clean(minutes.hora_cierre) || "hora pendiente de confirmar"}. La presente acta se extiende para su revisión y firma por el Presidente y el Secretario/Administrador.`;
  body.push(paragraph((english ? minutes.cierre_en : minutes.cierre_es) || defaultClosing));
  body.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } }, rows: [new TableRow({ children: [cell(`\n\n${labels.signaturePresident}\n${clean(item.presidente) || "________________"}`, { alignment: AlignmentType.CENTER }), cell(`\n\n${labels.signatureSecretary}\n${clean(minutes.secretario || item.administrador) || "________________"}`, { alignment: AlignmentType.CENTER })] })] }));
  return body;
}

function annexBody(detail) {
  const points = detail.points || [];
  const body = [heading("ANEXO I. RESULTADOS Y DETALLE INDIVIDUAL DE VOTACIONES", 1)];
  const summaryRows = [["Resultado", ...points.map((_, index) => `P${index + 1}`)]];
  for (const key of ["si", "no", "abs", "sin"]) {
    const label = { si: "AF - Votos", no: "EC - Votos", abs: "ABS - Votos", sin: "Sin emitir" }[key];
    summaryRows.push([label, ...points.map((point) => point.result?.[key]?.votes || 0)]);
  }
  summaryRows.push(["Acuerdo", ...points.map((point) => resultLabel(point.result))]);
  body.push(table(summaryRows, true));
  body.push(paragraph("Abreviaturas: AF = A favor | EC = En contra | ABS = Abstención | SV = Sin voto.", { italics: true, size: 17, before: 100 }));

  const voteRows = [["Propietario / representado", "Tipo", "Representante", "Coef.", "Derecho", ...points.map((_, index) => `P${index + 1}`)]];
  for (const attendee of detail.attendance || []) {
    voteRows.push([
      attendee.propietario,
      attendee.tipo === "representado" ? "R" : "P",
      attendee.tipo === "representado" ? attendee.representante : "-",
      number(attendee.coeficiente),
      attendee.sin_voto || attendee.moroso ? "NO" : "SÍ",
      ...points.map((point) => {
        if (attendee.sin_voto || attendee.moroso) return "SV";
        const value = detail.votes?.[String(point.id_punto)]?.[attendee.propietario]?.voto || "sin";
        return { si: "AF", no: "EC", abs: "ABS", sin: "-" }[value] || "-";
      }),
    ]);
  }
  body.push(table(voteRows, true));
  body.push(heading("ANEXO II. DOCUMENTACIÓN DEL EXPEDIENTE", 1, true));
  const documents = detail.documents || [];
  if (!documents.length) body.push(paragraph("No consta documentación anexa en el expediente digital de la asamblea."));
  else body.push(table([["N.º", "Documento", "Carpeta", "Descripción"], ...documents.map((row, index) => [index + 1, row.nombre_archivo, row.carpeta || "General", row.descripcion || "-"])], true));
  return body;
}

export async function buildAssemblyMinutes({ detail, minutes }) {
  const item = detail.assembly || {};
  const draft = clean(minutes.estado) !== "Cerrada";
  const headerText = draft ? "BORRADOR PENDIENTE DE REVISIÓN" : "ACTA DE ASAMBLEA";
  const document = new Document({
    creator: "Organizador Web",
    title: `Acta ${clean(item.nombre)}`,
    styles: {
      default: { document: { run: { font: "Arial", size: 20, color: COLORS.dark } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Arial", size: 27, bold: true, color: COLORS.blue }, paragraph: { keepNext: true } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Arial", size: 22, bold: true, color: COLORS.dark }, paragraph: { keepNext: true } },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 850, right: 900, bottom: 850, left: 900 } } },
        headers: { default: new Header({ children: [paragraph(headerText, { bold: draft, color: draft ? "A61B1B" : COLORS.muted, size: 15, alignment: AlignmentType.RIGHT, after: 0 })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${clean(item.codigo)} | Página `, color: COLORS.muted, size: 15 }), new TextRun({ children: [PageNumber.CURRENT], color: COLORS.muted, size: 15 })] })] }) },
        children: [...meetingBody(detail, minutes, false), ...meetingBody(detail, minutes, true)],
      },
      {
        properties: { page: { size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 650, right: 500, bottom: 650, left: 500 } } },
        headers: { default: new Header({ children: [paragraph(`${headerText} | ANEXOS`, { bold: draft, color: draft ? "A61B1B" : COLORS.muted, size: 14, alignment: AlignmentType.RIGHT, after: 0 })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${clean(item.codigo)} | Página `, color: COLORS.muted, size: 15 }), new TextRun({ children: [PageNumber.CURRENT], color: COLORS.muted, size: 15 })] })] }) },
        children: annexBody(detail),
      },
    ],
  });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  return { buffer: await Packer.toBuffer(document), filename: `Acta_${safeFilename(item.nombre)}_${stamp}.docx` };
}
