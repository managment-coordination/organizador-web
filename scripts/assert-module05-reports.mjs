import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildEntityReport,buildCollectionReport} from '../server/report-generator.js';
import {currentStep,reportOptions,selectReportAttachments,reportSnapshot} from '../server/report-domain.js';

const root=path.resolve(import.meta.dirname,'..');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'organizador-report-qa-'));
const item={id_proyecto:12,id_comunidad:1,comunidad:'Macrocomunidad San Roque Club',nombre:'Renovacion de alumbrado',descripcion:'Sustitucion de equipos deteriorados y comprobacion de protecciones.',estado_general:'Finalizado',responsable_principal:'Administracion',responsable_proximo_paso:'Administracion',proximo_paso_actual:'Paso antiguo que no debe presentarse como pendiente',observaciones:'LEGACY_STALE_STEPS'};
const history=[{id_registro_proyecto:2,fecha_hora:'2026-09-08 10:00',tipo_registro:'Decision',usuario:'Elena',comentario:'Se confirma la finalizacion tras comprobar el funcionamiento.',estado_anterior:'En curso',estado_nuevo:'Finalizado'},
{id_registro_proyecto:1,fecha_hora:'2026-08-01 09:00',tipo_registro:'Seguimiento',usuario:'Luis',comentario:'Se recibe el presupuesto de sustitucion.\nSe conserva el documento para su revision.',proximo_paso:'Solicitar confirmacion'}];
const entry={type:'project',item,history,attachments:[],commitments:[]};
assert.throws(()=>reportOptions({mode:'pdf'}));
assert.throws(()=>selectReportAttachments([{id_anexo:1}],reportOptions({attachment_ids:[2]})));
assert.deepEqual(selectReportAttachments([{id_anexo:1}],reportOptions({attachment_ids:[]})),[]);
assert.equal(currentStep({...item,proximo_paso_actual:null},'project'),'');
const first=reportSnapshot([entry],{mode:'completo'},'Luis');
assert.equal(first.snapshot.entries[0].history.length,2);
for(const mode of ['ejecutivo','completo']) {
  const report=await buildEntityReport({...entry,mode,author:'Luis'});
  fs.writeFileSync(path.join(out,mode+'.docx'),report.buffer);
}
const combined=await buildCollectionReport({title:'Seguimiento para directiva',mode:'completo',entries:[entry,{...entry,type:'task',item:{...item,titulo:'Revision cotidiana',estado:'Pendiente',responsable:'Elena',proximo_paso:'Confirmar visita'}}]});
fs.writeFileSync(path.join(out,'conjunto.docx'),combined.buffer);
const python=process.env.PYTHON_BIN || (process.platform==='win32'?'C:/Users/EQUIPO/AppData/Local/Programs/Python/Python314/python.exe':'python3');
const check=spawnSync(python,['-',out,path.join(root,'data/report-templates/1.docx')],{encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(root,'server'),PYTHONUTF8:'1'},input:`import sys,zipfile,pathlib,xml.etree.ElementTree as E
from report_template import apply_template
p=pathlib.Path(sys.argv[1]); w='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
for mode in ['ejecutivo','completo','conjunto']:
 f=p/(mode+'.docx')
 with zipfile.ZipFile(f) as z:
  document=E.fromstring(z.read('word/document.xml'))
  text=' '.join(t.text or '' for t in document.iter(w+'t'))
  assert 'LEGACY_STALE_STEPS' not in text
  assert ('Historico completo' in text)==(mode!='ejecutivo')
  assert 'Objeto:' in text and 'Conclusion' in text
  assert not list(document.iter(w+'tbl')), 'Narrative is not trapped in tables'
 if pathlib.Path(sys.argv[2]).exists():
  f.write_bytes(apply_template(f.read_bytes(),sys.argv[2]))
  with zipfile.ZipFile(f) as z:
   assert 'word/letterhead_header1.xml' in z.namelist()
   assert 'word/media/letterhead_image1.png' in z.namelist()
   assert E.fromstring(z.read('word/document.xml')).find('.//'+w+'pgMar').get(w+'left')=='1701'
print('Word formats, complete chronology, no stale current steps, paragraphs, template relationships: OK')
`});
assert.equal(check.status,0,check.stderr || check.stdout);
console.log(check.stdout.trim());
console.log('QA documents: '+out);
