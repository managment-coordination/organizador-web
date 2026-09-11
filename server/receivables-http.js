import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function receivablesImportHttp(req, res, url, services) {
  if (!url.pathname.startsWith('/api/erp/receivables/import/')) return false;
  const {readSession, runErpContract, readRawBody, readBody, sendJson, readWorkbook, uploadsDir, dataDir} = services;
  const session = readSession(req);
  if (!session) { sendJson(res,401,{ok:false,error:'No autenticado.'}); return true; }
  const body = url.pathname.endsWith('/preview') ? await readBody(req, 2*1024*1024) : {};
  const community = Number(body.id_comunidad || url.searchParams.get('id_comunidad'));
  // Authorize before reading an uploaded workbook or exposing its contents.
  await runErpContract(session,'query',{query:'erp3.import.access',id_comunidad:community,filters:{}});
  if (req.method !== 'POST') { sendJson(res,405,{ok:false,error:'Operacion no admitida.'}); return true; }
  const folder = path.join(uploadsDir,'erp3-history',String(community));
  if (url.pathname.endsWith('/upload')) {
    const filename = decodeURIComponent(String(req.headers['x-file-name'] || 'historico.xlsx')).replace(/[\\/\r\n]/g,'_');
    const extension = path.extname(filename).toLowerCase();
    if (!['.xlsx','.csv'].includes(extension)) throw new Error('Utiliza Excel .xlsx o CSV.');
    const buffer = await readRawBody(req,20*1024*1024);
    const parsed = await readWorkbook(buffer,filename,String(url.searchParams.get('sheet')||''));
    validateWorkbook(parsed);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const token = digest+extension;
    fs.mkdirSync(folder,{recursive:true});
    if (!fs.existsSync(path.join(folder,token))) fs.writeFileSync(path.join(folder,token),buffer,{mode:0o600});
    sendJson(res,200,{ok:true,token,filename,file_hash:digest,headers:parsed.headers,sheets:parsed.sheets,sheet:parsed.sheet,
      sample:parsed.rows.slice(0,5),row_count:parsed.rows.length});
    return true;
  }
  if (url.pathname.endsWith('/preview')) {
    if (!/^[a-f0-9]{64}\.(xlsx|csv)$/.test(body.token||'')) throw new Error('Archivo no valido.');
    const stored = path.join(folder,body.token);
    if (!fs.existsSync(stored)) throw new Error('Vuelve a seleccionar el archivo.');
    const buffer = fs.readFileSync(stored);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash!==body.token.slice(0,64)) throw new Error('El archivo original ha cambiado.');
    const parsed = await readWorkbook(buffer,body.token,body.sheet||'');
    validateWorkbook(parsed);
    if (Object.keys(body.mapping||{}).some(h=>!parsed.headers.includes(h))) throw new Error('El mapeo contiene columnas ajenas al archivo.');
    const result = await runErpContract(session,'command',{command:'erp3.history.import.preview',id_comunidad:community,
      payload:{source:body.source,file_hash:hash,file_name:body.filename||body.token,file_path:path.relative(dataDir,stored),
        sheet:parsed.sheet,rows:parsed.rows,mapping:body.mapping||{},defaults:body.defaults||{}},
      idempotency_key:body.idempotency_key,expected_version:body.expected_version??null,origin:'importer',
      reason:'Revision de importacion historica desde archivo conservado',evidence:{type:'external_reference',id:hash}});
    sendJson(res,200,result);
    return true;
  }
  sendJson(res,404,{ok:false,error:'Operacion no encontrada.'});
  return true;
}

function validateWorkbook(parsed) {
  if (new Set(parsed.headers).size!==parsed.headers.length) throw new Error('Hay cabeceras duplicadas. Renombralas antes de importar.');
  if (!parsed.rows.length || parsed.rows.length>500) throw new Error('Revisa un archivo de entre 1 y 500 filas.');
}
