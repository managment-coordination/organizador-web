const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();

// Classify the user's instruction, never UI scaffolding, tool descriptions or old turns.
export function isExplicitReadQuery(text) {
  const value = normalize(text);
  if (!value || value.length > 700 || value.split('\n').length > 8) return false;
  if (/\b(crea|crear|anade|anadir|actualiza|actualizar|registra|registrar|elimina|eliminar|borra|borrar|envia|enviar|manda|mandar|redacta|redactar|prepara|preparar|genera|generar|guarda|guardar|modifica|modificar)\b/.test(value)) return false;
  return /^(?:[¿?\s]*(?:por favor[,\s]+)?)?(?:quien|quienes|cual|cuales|cuanto|cuantos|cuanta|cuantas|cuando|donde|como|que|dime|busca|buscar|muestra|muestrame|consulta|consultar|listado|lista)\b/.test(value)
    || /\b(?:propietario|propietaria|titular|deuda|recibos|presupuesto|balance)\b/.test(value) && /[?¿]/.test(value);
}

export function currentInstruction(text, supportingText = '') {
  const instruction = String(text || '').trim();
  return { instruction, supportingText:String(supportingText || '').trim(), explicitRead:isExplicitReadQuery(instruction) };
}

export function readNeedsPreviousContext(text) {
  return /\b(ese propietario|esa propietaria|ese titular|esa tarea|ese proyecto|esa vivienda|esa propiedad|lo anterior|de el|de ella|su deuda|sus recibos)\b/.test(normalize(text));
}

export function readNeedsSupportingData(text) {
  return /\b(documento|documentos|adjunto|adjuntos|archivo|archivos|transcripcion|pantalla|reunion)\b/.test(normalize(text));
}
