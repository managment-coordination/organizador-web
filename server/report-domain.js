import crypto from 'node:crypto';

export const DOCUMENT_CATEGORIES = ['Sin clasificar', 'Presupuesto', 'Factura', 'Contrato', 'Informe tecnico', 'Fotografia', 'Otro'];
export function reportOptions(input = {}) {
  const mode = input.mode ?? 'completo';
  if (!['ejecutivo', 'completo'].includes(mode)) throw new Error('ValueError: Formato de informe no valido.');
  const ids = input.attachment_ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0))) {
    throw new Error('ValueError: Seleccion de anexos no valida.');
  }
  return { mode, attachment_ids: ids === undefined ? undefined : [...new Set(ids)] };
}
export function selectReportAttachments(attachments, options) {
  if (options.attachment_ids === undefined) return attachments;
  const allowed = new Set(attachments.map(row => Number(row.id_anexo)));
  if (options.attachment_ids.some(id => !allowed.has(id))) throw new Error('PermissionError: Anexo ajeno al informe o sin permiso.');
  return attachments.filter(row => options.attachment_ids.includes(Number(row.id_anexo)));
}
export function reportSnapshot(entries, options, author) {
  const snapshot = { schema: 'operational_report_v2', mode: options.mode, author, captured_at: new Date().toISOString(), entries: entries.map(entry => ({
    type: entry.type, item: entry.item, history: entry.history, commitments: entry.commitments,
    attachments: entry.attachments.map(({ resolvedPath, ruta_archivo, ...row }) => row)
  })) };
  return { snapshot, snapshot_sha256: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

export function readableText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
export function currentStep(item, type) {
  // Never fall back to the legacy observations field: it can contain years of obsolete steps.
  return readableText(type === 'task' ? item.proximo_paso : item.proximo_paso_actual);
}
export function executiveEvents(history) {
  const seen = new Set();
  return history.filter(row => {
    const key = readableText(row.comentario).toLocaleLowerCase('es');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).filter((row, index, rows) => index === 0 || index === rows.length - 1 ||
    /decisi[oó]n|acuerdo|aprobaci[oó]n|rechazo/i.test(row.tipo_registro || '') ||
    (row.estado_nuevo && row.estado_anterior && row.estado_nuevo !== row.estado_anterior));
}
