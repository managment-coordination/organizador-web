import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Document, Footer, Header, HeadingLevel, ImageRun, Packer, PageNumber, Paragraph, TextRun, AlignmentType } from 'docx';
import { currentStep, executiveEvents, readableText as clean, reportOptions } from './report-domain.js';

const heading = text => new Paragraph({ text, heading:HeadingLevel.HEADING_1, keepNext:true, spacing:{before:180,after:70} });
function paragraphs(text, prefix = '') {
  return (clean(text) || 'No consta.').split(/\n+/).map((line,i) => new Paragraph({
    children:[...(prefix && i===0 ? [new TextRun({text:prefix,bold:true})] : []),new TextRun(line)],
    spacing:{after:70,line:260}, widowControl:true
  }));
}
const meta = text => new Paragraph({children:[new TextRun({text:clean(text),color:'525252',size:19})],spacing:{after:70},keepNext:true});
const closed = state => /finalizado|archivado/i.test(state);

function imageDimensions(bytes, extension) {
  if (extension === '.png' && bytes.length >= 24) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes[0]===255 && bytes[1]===216) {
    let offset=2;
    while(offset+9<bytes.length) {
      if(bytes[offset]!==255) break;
      const marker=bytes[offset+1], length=bytes.readUInt16BE(offset+2);
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) return [bytes.readUInt16BE(offset+7),bytes.readUInt16BE(offset+5)];
      if(length<2) break;
      offset+=length+2;
    }
  }
  throw new Error('Dimensiones no disponibles');
}

function annexes(attachments) {
  if (!attachments.length) return paragraphs('No se han seleccionado anexos para esta version.');
  return attachments.flatMap((row,index) => {
    const blocks=[heading(`Anexo ${index+1} | ${clean(row.nombre_archivo)}`),meta(`${row.categoria_documental || 'Sin clasificar'} | ${row.fecha_adjuntado || 'Sin fecha'} | ${row.usuario || 'Autor no registrado'}`)];
    blocks.push(...paragraphs(row.id_registro ? `Vinculado al seguimiento ${row.id_registro}.` : 'Documento general del expediente.'));
    const extension=path.extname(row.nombre_archivo || '').toLowerCase();
    if(row.resolvedPath && fs.existsSync(row.resolvedPath) && ['.png','.jpg','.jpeg'].includes(extension)) {
      try {
        const bytes=fs.readFileSync(row.resolvedPath);
        const [width,height]=imageDimensions(bytes,extension);
        if(!(width>0 && height>0)) throw new Error('Imagen no valida');
        const scale=Math.min(500/width,500/height,1);
        blocks.push(new Paragraph({alignment:AlignmentType.CENTER,children:[new ImageRun({data:bytes,type:extension==='.png'?'png':'jpg',transformation:{width:Math.round(width*scale),height:Math.round(height*scale)}})]}));
      } catch { blocks.push(...paragraphs('No ha sido posible previsualizar la imagen. El original se conserva en Documentos del expediente.')); }
    } else {
      blocks.push(...paragraphs(row.resolvedPath ? 'Original conservado en Documentos del expediente. Este anexo contiene su referencia documental; el archivo no esta incrustado en Word.' : 'Original no disponible en el servidor. Pendiente de recuperar.'));
    }
    return blocks;
  });
}

function timeline(history, attachments) {
  if(!history.length) return paragraphs('No hay actuaciones registradas.');
  return history.flatMap(row=>{
    const id=row.id_registro ?? row.id_registro_proyecto;
    const blocks=[new Paragraph({text:`${row.fecha_hora || 'Sin fecha'} | ${row.tipo_registro || 'Seguimiento'}`,heading:HeadingLevel.HEADING_2,keepNext:true}),
      meta(`Registro ${id ?? '-'} | ${row.usuario || 'Autor no registrado'}`), ...paragraphs(row.comentario)];
    if(row.estado_nuevo && row.estado_nuevo!==row.estado_anterior) blocks.push(...paragraphs(`${row.estado_anterior || 'Sin estado'} -> ${row.estado_nuevo}`,'Cambio de estado: '));
    if(row.responsable_nuevo) blocks.push(...paragraphs(row.responsable_nuevo,'Responsable registrado: '));
    if(row.proximo_paso) blocks.push(...paragraphs(row.proximo_paso,'Proximo paso en esa fecha: '));
    const linked=attachments.map((a,i)=>({...a,index:i+1})).filter(a=>Number(a.id_registro)>0 && Number(a.id_registro)===Number(id));
    if(linked.length) blocks.push(...paragraphs(linked.map(a=>`Anexo ${a.index}: ${a.nombre_archivo}`).join('\n'),'Documentos relacionados: '));
    return blocks;
  });
}

function entityBlocks(entry, mode, index, collection) {
  const {type,item,attachments=[],commitments=[]}=entry;
  const history=[...(entry.history || [])].sort((a,b)=>String(a.fecha_hora || '').localeCompare(String(b.fecha_hora || '')) || Number(a.id_registro ?? a.id_registro_proyecto)-Number(b.id_registro ?? b.id_registro_proyecto));
  const title=clean(type==='task'?item.titulo:item.nombre);
  const state=clean(type==='task'?item.estado:item.estado_general);
  const owner=clean(type==='task'?item.responsable:item.responsable_principal);
  const step=currentStep(item,type);
  const events=executiveEvents(history);
  const pending=commitments.filter(row=>row.estado==='Pendiente');
  const blocks=[new Paragraph({text:collection?`${index+1}. ${title}`:title,heading:HeadingLevel.TITLE,pageBreakBefore:collection && index>0,spacing:{before:160,after:160},keepNext:true}),
    meta(`${type==='task'?'Tarea':'Proyecto'} | ${item.comunidad || 'Comunidad no indicada'} | ${mode==='ejecutivo'?'Informe ejecutivo':'Informe completo'}`),
    heading('Resumen ejecutivo'),
    ...paragraphs(`El expediente consta en estado ${state || 'sin definir'}. ${closed(state)?'No se presentan los pasos historicos como actuaciones pendientes.':step?`La actuacion vigente registrada es: ${step}`:'No consta un proximo paso vigente.'}`),
    ...paragraphs(item.descripcion || 'No consta una descripcion del expediente.','Objeto: '),
    heading('Actuaciones y decisiones principales')];
  if(events.length) events.forEach(row=>blocks.push(...paragraphs(row.comentario,`${row.fecha_hora || 'Sin fecha'}: `)));
  else blocks.push(...paragraphs('No hay actuaciones registradas.'));
  blocks.push(heading('Situacion actual'),
    ...paragraphs(`${state || 'Sin definir'} | Prioridad: ${item.prioridad || 'Sin definir'}`,'Estado: '),
    ...paragraphs(owner || 'Sin asignar','Responsable general: '),
    ...paragraphs(item.responsable_proximo_paso || 'Sin asignar','Responsable del proximo paso: '),
    ...paragraphs(history.at(-1)?.fecha_hora || item.fecha_ultima_actualizacion || 'No consta','Ultima actualizacion: '));
  if(type==='project') blocks.push(...paragraphs(item.fase_aprobacion || 'Sin clasificar (historico)','Fase de aprobacion: '));
  if(mode==='completo') blocks.push(heading('Historico completo'),...timeline(history,attachments));
  blocks.push(heading('Proximos pasos'));
  if(closed(state)) blocks.push(...paragraphs('El expediente figura cerrado. Los pasos de actuaciones anteriores son historicos, no pendientes actuales.'));
  else blocks.push(...paragraphs(step || 'No se ha definido un proximo paso.'),...paragraphs(item.fecha_objetivo_proximo_paso || item.fecha_proxima_revision || 'Sin fecha acordada','Fecha prevista: '));
  if(pending.length) {
    blocks.push(heading(closed(state)?'Pendientes que requieren revision':'Compromisos y decisiones pendientes'));
    pending.forEach(row=>blocks.push(...paragraphs(row.descripcion),...paragraphs(`${row.responsable || 'Sin asignar'} | ${row.fecha_objetivo || 'Sin fecha acordada'}`,'Responsable y plazo: ')));
  }
  blocks.push(heading('Conclusion'),...paragraphs(closed(state)?`El expediente esta ${state.toLowerCase()} segun el estado registrado. ${pending.length?'Existen pendientes registrados que deben revisarse antes de dar por concluida la gestion.':'No constan compromisos pendientes registrados.'}`:`El expediente permanece ${state.toLowerCase() || 'sin estado definido'}. ${pending.length?`Quedan ${pending.length} compromisos o decisiones pendientes registrados.`:'La siguiente actuacion debe atender al proximo paso vigente, si esta definido.'}`),heading('Anexos seleccionados'),...annexes(attachments));
  return blocks;
}

async function build({title,entries,mode='completo',author='',collection=false}) {
  reportOptions({mode});
  const date=new Intl.DateTimeFormat('es-ES',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Madrid'}).format(new Date());
  const children=[meta(`Generado el ${date} | ${author || 'Organizador Web'}`)];
  if(collection) children.push(new Paragraph({text:clean(title),heading:HeadingLevel.TITLE}),...paragraphs(`${entries.length} expedientes independientes. Version ${mode==='ejecutivo'?'ejecutiva':'completa'} basada en todo el historico disponible.`));
  entries.forEach((entry,index)=>children.push(...entityBlocks(entry,mode,index,collection)));
  const document=new Document({creator:author || 'Organizador Web',title:clean(title),styles:{
    default:{document:{run:{font:'Arial',size:22,color:'000000'}},
      title:{run:{font:'Arial',size:36,bold:true,color:'000000'},paragraph:{keepNext:true}},
      heading1:{run:{font:'Arial',size:26,bold:true,color:'000000'},paragraph:{keepNext:true}},
      heading2:{run:{font:'Arial',size:23,bold:true,color:'000000'},paragraph:{keepNext:true}}
    },paragraphStyles:[
      {id:'Normal',name:'Normal',run:{font:'Arial',size:22,color:'000000'}}
    ]},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1100,bottom:1100,left:1400,right:1400}}},
      headers:{default:new Header({children:[meta(entries[0]?.item.comunidad || 'Organizador')]})},
      footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun('Pagina '),new TextRun({children:[PageNumber.CURRENT]})]})]})},children}]});
  const safe=clean(title).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9_-]+/g,'_').slice(0,80);
  const filename=`Informe_${mode}_${safe}_${new Date().toISOString().slice(0,10)}_${crypto.randomBytes(5).toString('hex')}.docx`;
  return {buffer:await Packer.toBuffer(document),filename};
}
export const buildEntityReport = entry => build({title:entry.type==='task'?entry.item.titulo:entry.item.nombre,entries:[entry],mode:entry.mode,author:entry.author});
export const buildCollectionReport = args => build({...args,collection:true});
