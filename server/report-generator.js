import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";

const COLORS = {
  blue: "1F4E78",
  dark: "0F172A",
  muted: "64748B",
  line: "D8E0E8",
  paleBlue: "D9EAF7",
  paleGrey: "F2F4F7",
  paleGreen: "E2F0D9",
  paleAmber: "FFF2CC",
  paleRed: "FCE4D6"
};

const clean = (value) => String(value || "").trim();

function safeFilename(value, limit = 90) {
  return (clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "informe").slice(0, limit);
}

function textParagraph(value, prefix = "", options = {}) {
  const children = [];
  if (prefix) children.push(new TextRun({ text: prefix, bold: true, color: COLORS.dark }));
  children.push(new TextRun({ text: clean(value) || "-", color: COLORS.dark }));
  return new Paragraph({
    children,
    spacing: { after: options.after ?? 100, line: 290 },
    keepNext: Boolean(options.keepNext)
  });
}

function sectionHeading(text, level = 1) {
  return new Paragraph({
    text,
    heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
    spacing: { before: level === 1 ? 260 : 170, after: 100 },
    keepNext: true
  });
}

function cell(value, options = {}) {
  return new TableCell({
    shading: { type: ShadingType.CLEAR, fill: options.fill || "FFFFFF", color: "auto" },
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    verticalAlign: "center",
    children: [new Paragraph({
      children: [new TextRun({
        text: clean(value) || "-",
        bold: Boolean(options.bold),
        color: options.color || COLORS.dark,
        size: 19
      })],
      spacing: { after: 0 }
    })]
  });
}

function infoTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorders(),
    rows: rows.map(([label, value], index) => new TableRow({
      children: [
        cell(label, { fill: COLORS.paleBlue, bold: true, color: COLORS.blue }),
        cell(value, { fill: index % 2 ? COLORS.paleGrey : "FFFFFF" })
      ]
    }))
  });
}

function tableBorders() {
  const border = { style: BorderStyle.SINGLE, size: 1, color: COLORS.line };
  return { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
}

function isDecision(row) {
  const content = `${clean(row.tipo_registro)} ${clean(row.comentario)}`.toLowerCase();
  return ["decision", "acuerdo", "aprobad", "rechazad", "confirmad"].some((word) => content.includes(word));
}

function timeline(history) {
  if (!history.length) return [textParagraph("No existen seguimientos registrados.")];
  const result = [];
  history.forEach((row, index) => {
    const fill = isDecision(row) ? COLORS.paleGreen : COLORS.paleBlue;
    const stateChange = [row.estado_anterior, row.estado_nuevo].map(clean).filter(Boolean).join(" -> ") || "-";
    const owner = clean(row.responsable_nuevo) || clean(row.responsable_anterior) || "-";
    result.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: tableBorders(),
      rows: [
        new TableRow({ children: [
          cell(`${index + 1}. ${clean(row.fecha_hora)}`, { fill, bold: true, color: COLORS.blue }),
          cell(clean(row.tipo_registro) || "Seguimiento", { fill, bold: true, color: COLORS.blue })
        ] }),
        new TableRow({ children: [
          cell(`Estado: ${stateChange}\nResponsable: ${owner}`),
          cell(`Registrado por: ${clean(row.usuario) || "-"}`)
        ] })
      ]
    }));
    result.push(textParagraph(row.comentario, "Actuacion: "));
    if (clean(row.proximo_paso)) result.push(textParagraph(row.proximo_paso, "Proximo paso indicado: ", { after: 180 }));
  });
  return result;
}

function attachmentBlocks(attachments) {
  if (!attachments.length) return [textParagraph("No existen anexos asociados.")];
  const result = [];
  attachments.forEach((row, index) => {
    const name = clean(row.nombre_archivo) || `Anexo ${index + 1}`;
    result.push(new Paragraph({
      children: [
        new TextRun({ text: `Anexo ${index + 1}. ${name}`, bold: true, color: COLORS.blue }),
        new TextRun({ text: `\nFecha: ${clean(row.fecha_adjuntado) || "-"}`, color: COLORS.muted })
      ],
      spacing: { before: 140, after: 80 },
      keepNext: true
    }));
    const resolvedPath = clean(row.resolvedPath);
    const extension = path.extname(name).toLowerCase();
    if (resolvedPath && fs.existsSync(resolvedPath) && [".png", ".jpg", ".jpeg"].includes(extension)) {
      try {
        result.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({ data: fs.readFileSync(resolvedPath), transformation: { width: 560, height: 350 }, type: extension === ".png" ? "png" : "jpg" })],
          spacing: { after: 140 }
        }));
      } catch {
        result.push(textParagraph("El archivo esta disponible en la ficha web, pero no pudo incrustarse en Word."));
      }
    } else if (resolvedPath && fs.existsSync(resolvedPath)) {
      result.push(textParagraph("Archivo incluido en el expediente digital y disponible desde la ficha web."));
    } else {
      result.push(textParagraph("Archivo historico pendiente de disponibilidad en el servidor."));
    }
  });
  return result;
}

function conclusionFor(state) {
  const value = clean(state).toLowerCase();
  if (value.includes("bloque")) return "El expediente permanece bloqueado. Debe resolverse la causa indicada y registrar una nueva decision antes de continuar.";
  if (value.includes("final") || value.includes("termin")) return "El expediente consta como finalizado. El historial anterior documenta las actuaciones que condujeron a su cierre.";
  if (value.includes("tercero")) return "El expediente queda pendiente de una actuacion externa. Conviene mantener la fecha objetivo y el responsable del siguiente contacto actualizados.";
  return "El expediente continua activo. La situacion vigente y el siguiente paso quedan recogidos en este informe para facilitar su seguimiento.";
}

export async function buildEntityReport({ type, item, history = [], attachments = [] }) {
  const isTask = type === "task";
  const entityLabel = isTask ? "tarea" : "proyecto";
  const title = clean(isTask ? item.titulo : item.nombre);
  const state = clean(isTask ? item.estado : item.estado_general);
  const owner = clean(isTask ? item.responsable : item.responsable_principal);
  const nextOwner = clean(item.responsable_proximo_paso);
  const nextDate = clean(item.fecha_objetivo_proximo_paso || item.fecha_proxima_revision);
  const nextStep = clean(isTask ? item.proximo_paso : item.observaciones);
  const firstDate = history.length ? clean(history[0].fecha_hora) : "sin seguimientos";
  const lastDate = history.length ? clean(history.at(-1).fecha_hora) : clean(item.fecha_ultima_actualizacion);
  const generatedAt = new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "short" }).format(new Date());
  const summary = `${entityLabel[0].toUpperCase() + entityLabel.slice(1)} en estado ${state || "sin definir"}, con prioridad ${clean(item.prioridad) || "sin definir"} y responsabilidad actual de ${owner || "sin asignar"}. El expediente contiene ${history.length} actuaciones registradas desde ${firstDate}. La ultima actualizacion consta en ${lastDate || "fecha no indicada"}.`;
  const children = [
    new Paragraph({ children: [new TextRun({ text: `INFORME DE ${entityLabel.toUpperCase()}`, bold: true, color: COLORS.blue, size: 24 })], spacing: { after: 40 } }),
    new Paragraph({ children: [new TextRun({ text: title, bold: true, color: COLORS.dark, size: 40 })], spacing: { after: 80 } }),
    new Paragraph({ children: [new TextRun({ text: `${clean(item.comunidad) || "Sin comunidad"} | Generado: ${generatedAt}`, color: COLORS.muted, size: 18 })], spacing: { after: 220 } }),
    sectionHeading("Resumen ejecutivo"),
    textParagraph(summary),
    sectionHeading("Situacion actual"),
    infoTable([
      ["Estado", state],
      ["Prioridad", item.prioridad],
      ["Responsable actual", owner],
      ["Responsable del proximo paso", nextOwner],
      ["Fecha objetivo", nextDate],
      ["Categoria", item.categoria],
      ...(isTask ? [["Proyecto de referencia", item.proyecto]] : [])
    ]),
    ...(clean(item.descripcion) ? [sectionHeading("Contexto"), textParagraph(item.descripcion)] : []),
    sectionHeading("Actuaciones cronologicas"),
    ...timeline(history),
    sectionHeading("Proximos pasos"),
    infoTable([
      ["Actuacion prevista", nextStep || "No se ha definido un proximo paso."],
      ["Responsable", nextOwner || owner || "Sin asignar"],
      ["Fecha objetivo", nextDate || "Sin fecha"]
    ]),
    sectionHeading("Conclusion"),
    textParagraph(conclusionFor(state)),
    sectionHeading("Anexos"),
    ...attachmentBlocks(attachments)
  ];

  const document = new Document({
    creator: "Organizador Web",
    title: `Informe de ${entityLabel}: ${title}`,
    styles: {
      default: { document: { run: { font: "Aptos", size: 20, color: COLORS.dark } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 30, bold: true, color: COLORS.blue }, paragraph: { keepNext: true } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 23, bold: true, color: COLORS.blue }, paragraph: { keepNext: true } }
      ]
    },
    sections: [{
      properties: { page: { margin: { top: 900, right: 950, bottom: 900, left: 950 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "ORGANIZADOR - INFORME DE SEGUIMIENTO", color: COLORS.muted, size: 16 })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Documento generado desde el historial central del Organizador | Pagina ", color: COLORS.muted, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: COLORS.muted, size: 16 })] })] }) },
      children
    }]
  });
  const filename = `Informe_${entityLabel}_${safeFilename(title)}_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.docx`;
  return { buffer: await Packer.toBuffer(document), filename };
}
