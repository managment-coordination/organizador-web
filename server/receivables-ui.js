// Same authenticated transport and visual primitives as the rest of the workspace.
function createReceivablesUI(ctx) {
  const {api, html:h, moneyLabel:money, moneyCents:parseMoney, moneyInput, communities, root, active} = ctx;
  const today=()=>new Date().toLocaleDateString('sv-SE');
  const uid=()=>crypto.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  let s, generation=0;
  const reset=()=>{generation++;s={community:0,section:'receipts',cut:today(),filters:{},offset:0,keys:new Map(),error:'',message:''};};
  reset();
  const can=key=>Boolean(s.refs?.capabilities?.[key]);
  const select=(name,label,options,value='',required=false)=>`<label>${h(label)}<select name="${name}" ${required?'required':''}>${options.map(([id,text])=>`<option value="${h(id)}" ${String(id)===String(value)?'selected':''}>${h(text)}</option>`).join('')}</select></label>`;
  const input=(name,label,type='text',value='',required=true)=>`<label>${h(label)}<input name="${name}" type="${type}" value="${h(value)}" ${required?'required':''} ${type==='text'&&name.includes('amount')?'inputmode="decimal"':''}></label>`;
  const button=(action,label,extra='',cls='')=>`<button type="button" data-fin-action="${action}" ${extra} class="${cls}">${h(label)}</button>`;
  const entityOptions=(kind,empty='Selecciona')=>[['',empty],...(kind==='property'?(s.workspace?.properties||[]).map(p=>[p.id_propiedad,p.codigo_propiedad]):[
    ...(s.workspace?.owners||[]).map(o=>['owner:'+o.id_propietario,o.nombre]),...(s.workspace?.persons||[]).map(p=>['person:'+p.id_persona_cobro,p.nombre+' (persona de cobro)'])])];
  const subject=value=>{const [type,id]=String(value).split(':');return {type,id:Number(id)};};
  const scoped=()=>({...s.filters,effective_at:s.cut,offset:s.offset,limit:50});
  const q=async(name,filters={})=>{
    const community=s.community;
    const result=await api('/api/erp/query?'+new URLSearchParams({query:name,id_comunidad:String(community),filters:JSON.stringify(filters)}));
    if(community!==s.community)throw new Error('La comunidad seleccionada ha cambiado.');
    return result;
  };
  async function command(name,payload,version,reason,evidence) {
    const token=generation,community=s.community;
    const signature=JSON.stringify([s.community,name,payload,version,reason,evidence]);
    if (!s.keys.has(signature)) s.keys.set(signature,uid());
    const result=await api('/api/erp/command',{method:'POST',body:JSON.stringify({command:'erp3.'+name,
      id_comunidad:s.community,payload,expected_version:version??null,idempotency_key:s.keys.get(signature),reason,
      evidence:evidence||null,origin:'web'})});
    if(token!==generation||community!==s.community)throw new Error('La operacion termino en la comunidad anterior. Actualiza su ficha para consultar el resultado.');
    s.keys.delete(signature);return result.entity;
  }
  async function load() {
    if (!s.community) s.community=Number(communities()[0]?.id_comunidad||0);
    if (!s.community) {s.error='No hay una comunidad seleccionada.';render();return;}
    const token=++generation;s.loading=true;s.error='';render();
    try {
      const refs=(await q('erp3.reference.get')).entity;
      const receipts=(await q('erp3.receipt.list',scoped())).entity;
      const summary=(await q('erp3.debt.summary',scoped())).entity;
      const workspace=refs.capabilities.sensitive_read?(await q('erp3.workspace.get',scoped())).entity:null;
      if(token!==generation)return;
      Object.assign(s,{refs,receipts,summary,workspace,loaded:true});
    } catch(error) {if(token===generation)s.error=error.message;}
    finally {if(token===generation){s.loading=false;render();}}
  }
  function table(headers,rows) {
    return `<div class="finTableWrap"><table class="masterDataTable finTable"><thead><tr>${headers.map(x=>`<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${row.map((cell,i)=>`<td data-label="${h(headers[i])}">${cell}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${headers.length}">No hay registros para esta seleccion.</td></tr>`}</tbody></table></div>`;
  }
  function header() {
    const tabs=[['receipts','Recibos'],['collections','Cobros y saldos'],['debt','Deuda e historico'],['adjustments','Ajustes y gastos'],['imports','Importacion historica'],['settings','Configuracion']];
    return `<div class="budgetToolbar">${select('community','Comunidad',communities().map(c=>[c.id_comunidad,c.nombre]),s.community,true)}${input('cut','A fecha de','date',s.cut)}${button('reload','Actualizar')}</div>
      <div class="budgetTabs finTabs">${tabs.filter(([key])=>key!=='imports'||can('import_history')).filter(([key])=>key!=='settings'||can('configure')||can('resolve_responsibility')).map(([key,label])=>button('section',label,`data-section="${key}"`,s.section===key?'active':'')).join('')}</div>
      ${s.filters.property_id||s.filters.owner_id?`<div class="finScope">${h(s.scopeLabel||'Ficha seleccionada')} ${button('clear-scope','Ver toda la comunidad')}</div>`:''}`;
  }
  function metrics() {
    const d=s.summary;if(!d)return '';
    const owner=Boolean(s.filters.owner_id);
    return `<div class="budgetMetrics"><div class="budgetMetric"><span>${owner?'Deuda personal acreditada':'Pendiente documentado'}</span><strong>${money(owner?d.personal_pending_cents:d.documented_subtotal_cents)}</strong></div>
      <div class="budgetMetric"><span>${owner?'Obligaciones compartidas':'Vencido ERP'}</span><strong>${money(owner?d.shared_obligations_cents:d.native_overdue_cents)}</strong></div>
      <div class="budgetMetric"><span>Cobros sin aplicar</span><strong>${money(d.native_cash_available_cents)}</strong></div>
      <div class="budgetMetric"><span>Creditos sin aplicar</span><strong>${money(d.native_credit_available_cents)}</strong></div></div>
      ${d.issues.length?`<details class="finWarning" open><summary>Cobertura incompleta: el subtotal no acredita toda la deuda (${d.issues.length} incidencias)</summary><ul>${d.issues.slice(0,30).map(i=>`<li>${h(i.message||({'insufficient_history':'La fuente no permite reconstruir este corte.','legacy_review':'Importe historico pendiente de revision.','personal_coverage_unaccredited':'Responsabilidad historica sin acreditar.'}[i.type]||i.type))}${i.available_from?' Disponible desde '+h(i.available_from):''}</li>`).join('')}</ul></details>`:''}
      <div class="finSource">Corte: ${h(s.cut)}${d.legacy_cutoffs.length?' · Historico observado: '+h(d.legacy_cutoffs.join(', ')):''}. Los saldos a favor no se descuentan automaticamente.</div>`;
  }
  function receipts() {
    const list=s.receipts||{items:[],total_count:0};
    return `<div class="toolbar">${can('prepare_emission')?button('emit','Preparar emision','','green'):''}${can('record_collection')?button('collect','Registrar cobro'):''}</div>
      <details class="finFilters" ${s.filters.search||s.filters.state?'open':''}><summary>Buscar y filtrar recibos</summary><form data-fin-form="filter" class="toolbar">${input('search','Buscar recibo, propiedad o destinatario','search',s.filters.search||'',false)}${select('state','Estado',[['','Todos'],['pendiente','Pendiente'],['parcial','Parcial'],['liquidado','Liquidado'],['anulado','Anulado'],['incobrable','Incobrable']],s.filters.state||'')}<button>Buscar</button></form></details>
      ${table(['Recibo / propiedad','Concepto / periodo','Destinatario','Importe','Pendiente','Estado',''],list.items.map(r=>[
        `<strong>${h(r.number)}</strong><br>${h(r.property_code)}`,`${h(r.description)}<br>${h(r.period_from)} a ${h(r.period_until)}`,
        h(r.subjects.find(x=>x.role==='recipient')?.name||'Sin acreditar'),money(r.amount_cents),money(r.balance.pending_cents),
        `<span class="pill">${h(r.balance.state)}</span>${r.balance.overdue?' <span class="finWarning">Vencido</span>':''}`,button('receipt','Abrir',`data-id="${r.id}"`)]))}${paging(list.total_count)}`;
  }
  function paging(count) {return `<div class="toolbar">${button('prev','Anterior',s.offset?'':'disabled')}<span>${count?`${s.offset+1}-${Math.min(s.offset+50,count)} de ${count}`:'0 registros'}</span>${button('next','Siguiente',s.offset+50<count?'':'disabled')}</div>`;}
  function collections() {
    const rows=s.workspace?.collections||[];
    return `<div class="toolbar">${can('record_collection')?button('collect','Registrar cobro','','green'):''}</div>${!can('sensitive_read')?'<p>No tienes permiso para consultar los datos de pagadores.</p>':table(['Fecha','Referencia','Cobrado','Aplicado','Disponible',''],rows.map(c=>[h(c.effective_on),h(c.external_key),money(c.amount_cents),money(c.balance.applied_cents),money(c.balance.available_cents),button('collection','Abrir',`data-id="${c.id}"`)]))+paging(s.workspace.collection_count)}
      <h3>Creditos a favor</h3>${table(['Fecha','Beneficiario','Disponible',''],(s.workspace?.credits||[]).filter(c=>BigInt(c.balance.available_cents)>0n).map(c=>[h(c.effective_on),h(s.workspace.owners.find(o=>o.id_propietario===c.owner_id)?.nombre||s.workspace.persons.find(p=>p.id_persona_cobro===c.person_id)?.nombre||'Sin identificar'),money(c.balance.available_cents),can('allocate')?button('apply-credit','Aplicar con revision',`data-id="${c.id}"`):'']))}`;
  }
  function adjustments() {
    return `<h3>Regularizaciones aprobadas</h3>${table(['Motivo','Corte','Situacion',''],(s.workspace?.regularizations||[]).map(r=>[h(r.motivo),h(r.fecha_corte),r.lines.every(l=>l.materialized_id)?'Materializada':'Pendiente de emitir',can('adjust')&&!r.lines.some(l=>l.materialized_id)?button('regularization','Preparar cargos / abonos',`data-id="${r.id_regularizacion}"`):'']))}
      <h3>Devoluciones registradas</h3>${table(['Fecha','Referencia','Importe',''],(s.workspace?.returns||[]).map(r=>[h(r.effective_on),h(r.external_key),money(r.amount_cents),r.reversal_id?'Revertida':(can('adjust')?button('return-fee','Revisar gasto',`data-id="${r.id}"`):'')+(can('return_collection')?button('return-reverse','Rectificar devolucion',`data-id="${r.id}"`):'')]))}`;
  }
  function debt() {
    const d=s.summary;
    return `${metrics()}<h3>Fuentes del pendiente</h3>${table(['Origen','Importe','Condicion'],[
      ['Recibos ERP',money(d.native_pending_cents),'Movimientos trazados'],['Aperturas importadas',money(d.observed_opening_debt_cents),'Observado al corte'],
      ['Recibos historicos sin migrar',money(d.observed_legacy_debt_cents),'Observado; no se infiere obligado']])}
      <h3>Saldos historicos importados</h3>${table(['Propiedad','Corte','Saldo','Procedencia / limitaciones',''],d.openings.map(o=>[
        h(s.workspace?.properties.find(p=>p.id_propiedad===o.property_id)?.codigo_propiedad||'Sin propiedad acreditada'),h(o.cutoff_date),money(o.amount_cents),h(o.source.system)+'<br>'+h(o.limitations),can('sensitive_read')?button('opening','Ver movimientos',`data-id="${o.id}"`):'']))}`;
  }
  const importFields=[['','No importar'],['reference','Referencia del saldo/recibo'],['property_code','Codigo de propiedad'],['owner_code','Codigo de propietario acreditado'],['amount','Saldo pendiente (EUR)'],['cutoff_date','Fecha de corte'],['coverage_from','Cobertura desde'],['coverage_until','Cobertura hasta'],['limitations','Limitaciones'],['legacy_receipt_ids','IDs de recibos historicos cubiertos']];
  function imports() {
    const flow=s.import||{};
    const upload=flow.upload,preview=flow.preview;
    return `<h3>Importacion historica</h3><form data-fin-form="upload" class="toolbar"><label>Excel o CSV<input name="file" type="file" accept=".xlsx,.csv" required></label><button>Analizar columnas</button></form>
      ${upload?`<form data-fin-form="mapping" class="masterForm"><h4>Relacionar columnas</h4><div class="masterFormGrid">${input('source','Programa de origen','text',flow.source||'')}${select('sheet','Hoja',upload.sheets.map(x=>[x,x]),upload.sheet)}${input('cutoff_date','Fecha del saldo','date',flow.cutoff||s.cut)}${input('coverage_from','Historico desde','date',flow.start||'')}${input('coverage_until','Historico hasta','date',flow.end||s.cut)}${select('scope','Contenido',[['aggregate','Saldo agregado'],['receipt','Recibo identificado']],flow.scope||'aggregate')}${input('limitations','Alcance / limitaciones','text',flow.limitations||'Saldo observado sin desglose de movimientos')}</div>
      <div class="onboardingMap">${upload.headers.map((header,index)=>`<div>${select('map_'+index,header,importFields,flow.mapping?.[header]||'')}<small>${h(upload.sample[0]?.values[header]||'')}</small></div>`).join('')}</div>
      <label class="finCheck"><input type="checkbox" name="attribution" ${flow.attribution?'checked':''}> He comprobado documentalmente la atribucion de los saldos a los propietarios indicados.</label><button>Revisar importacion</button></form>`:''}
      ${preview?`<section class="finReview"><h3>Revision: ${preview.rows.length} filas</h3>${table(['Fila','Referencia','Importe','Resultado'],preview.rows.map(r=>[h(r.row_number),h(r.normalized?.reference||''),r.normalized?money(r.normalized.amount_cents):'Sin validar',r.issues.length?`<span class="finWarning">${h(r.issues.join(' '))}</span>`:h(r.decision==='skip'?'Ya importado':'Preparado')]))}
      ${preview.state==='confirmed'?'<p>Importacion ya confirmada.</p>':preview.blocking_issues?'<p role="alert">Corrige el mapeo o los datos originales antes de confirmar.</p>':`<label class="finCheck"><input type="checkbox" id="finImportAck"> He revisado el origen, los importes, la cobertura y la atribucion.</label>${can('approve_opening')?button('confirm-import','Confirmar importacion','','green'):'<p>Se requiere permiso de aprobacion de saldos de apertura.</p>'}`}</section>`:''}
      <details><summary>Importaciones anteriores</summary>${table(['Origen','Fecha','Estado',''],(s.workspace?.imports||[]).map(i=>[h(i.source),h(i.registered_at.slice(0,10)),h(i.state),button('import-open','Revisar',`data-id="${i.id}"`)]))}</details>`;
  }
  function settings() {
    const users=s.workspace?.permission_users||[];
    const labels={read:'Consultar recibos',sensitive_read:'Consultar datos personales',prepare_emission:'Preparar emisiones',confirm_emission:'Confirmar emisiones',record_collection:'Registrar cobros',allocate:'Imputar cobros',reverse_allocation:'Desimputar',return_collection:'Registrar devoluciones',credit:'Abonar',void:'Anular',adjust:'Gastos y ajustes',refund:'Reintegrar saldos',claim:'Gestionar reclamaciones',import_history:'Importar historico',approve_opening:'Confirmar aperturas',resolve_responsibility:'Configurar obligados',classify_uncollectible:'Clasificar incobrables',transfer_responsibility:'Reasignar deuda',configure:'Configurar politicas'};
    return `${can('resolve_responsibility')?`<section><h3>Obligados economicos</h3>${button('responsibility','Configurar desde una propiedad')}</section>`:''}
      ${can('configure')?`<details><summary>Fuente de emision y corte de puesta en marcha</summary>${table(['Concepto','Desde','Hasta','Fuente'],(s.refs.coverages||[]).map(c=>[h(c.concept_key),h(c.effective_from),h(c.effective_until),h(c.authority)]))}${button('coverage','Registrar cobertura')}</details><details><summary>Gastos de devolucion</summary>${button('policy','Configurar politica')}</details>`:''}
      ${users.length?`<details><summary>Permisos de recibos por usuario</summary><form data-fin-form="permissions">${select('user','Usuario',users.map(u=>[u.id_usuario,u.nombre]),s.permissionUser||users[0].id_usuario)}<div class="finPermissions">${Object.keys(labels).map(key=>`<label class="finCheck"><input type="checkbox" name="${key}" ${(users.find(u=>u.id_usuario===Number(s.permissionUser))||users[0]).capabilities[key]?'checked':''}>${labels[key]}</label>`).join('')}</div><button>Guardar permisos</button></form></details>`:''}`;
  }
  function review() {
    const r=s.review;if(!r)return '';
    return `<section class="finReview" role="region" aria-label="Revision antes de confirmar"><h3>${h(r.title)}</h3>${r.content}<p>No se ha confirmado ningun movimiento.</p><label class="finCheck"><input id="finAck" type="checkbox"> He revisado los datos y el efecto economico.</label><div class="toolbar">${button('confirm','Confirmar','','green')}${button('cancel','Volver a editar')}</div></section>`;
  }
  function render() {
    if (!active()) return;
    root().innerHTML=`<div class="finWorkspace">${header()}${s.error?`<div role="alert" class="finWarning">${h(s.error)}</div>`:''}${s.message?`<div role="status">${h(s.message)}</div>`:''}
      ${s.loading?'<p role="status">Cargando recibos y saldos...</p>':s.loaded?(s.review?review():s.form?formHtml():s.detail?detailHtml():({receipts:receipts,collections:collections,debt:debt,adjustments,imports:imports,settings:settings}[s.section]||receipts)()):''}</div>`;
    bind();
  }
  function formHtml() {
    return `<section class="finEditor"><h3>${h(s.form.title)}</h3><form data-fin-form="operation"><div class="masterFormGrid">${s.form.fields}</div>${input('reason','Motivo / descripcion','text',s.form.reason||'')}${input('evidence','Referencia de documento o justificante','text','',s.form.evidenceRequired||false)}<div class="toolbar"><button>Revisar</button>${button('close','Cancelar')}</div></form></section>`;
  }
  function detailHtml() {
    const d=s.detail;
    if(d.type==='opening') {
      const o=d.data.opening,b=d.data.balance;
      return `${button('close','Volver al historico')}<h3>Saldo historico al ${h(o.effective_on)}</h3>${table(['Original al corte','Pendiente actual','Calidad'],[[money(o.amount_cents),money(b.remaining_cents),'Observado']])}<p>${h(o.limitations)}</p>
        <div class="toolbar">${BigInt(b.remaining_cents)>0n&&can('allocate')?button('opening-allocate','Imputar cobro'):''}${BigInt(b.remaining_cents)<0n&&can('allocate')?button('opening-credit','Aplicar saldo a favor'):''}${BigInt(b.remaining_cents)<0n&&can('refund')?button('opening-refund','Reintegrar saldo'):''}${BigInt(b.remaining_cents)>0n&&can('credit')?button('opening-abono','Preparar abono'):''}</div>
        ${table(['Fecha','Movimiento','Importe','Motivo',''],d.data.movements.map(m=>[h(m.effective_on),h({allocation:'Imputacion',reverse_allocation:'Desimputacion',credit_apply:'Aplicacion de saldo',reverse_credit_apply:'Reversion de saldo',refund:'Reintegro',credit:'Abono',reverse_credit:'Reversion de abono'}[m.kind]),money(m.amount_cents),h(m.reason),!m.reverses_id&&['allocation','credit_apply','credit'].includes(m.kind)&&can(m.kind==='credit'?'credit':'reverse_allocation')?button('opening-reverse','Rectificar',`data-id="${m.id}"`):'']))}`;
    }
    if(d.type==='receipt') {
      const r=d.data.receipt,b=d.data.balance;
      return `${button('close','Volver a recibos')}<h3>${h(r.number)} · ${h(r.description)}</h3>${table(['Emitido','Vence','Original','Aplicado','Abonado','Pendiente'],[[h(r.issued_on),h(r.due_on||''),money(b.original_cents),money(b.paid_cents),money(b.reduced_cents),money(b.pending_cents)]])}
        ${table(['Relacion','Nombre'],d.data.subjects.map(x=>[h({obligated:'Obligado economico',recipient:'Destinatario',payer:'Pagador',owner_reference:'Titular'}[x.role]||x.role),h(JSON.parse(x.snapshot_json).name)]))}
        <div class="toolbar">${can('credit')?button('credit','Preparar abono'):''}${can('void')?button('void','Anular'):''}${can('classify_uncollectible')?button('uncollectible','Clasificar incobrable'):''}${can('claim')?button('claim','Registrar gestion'):''}${can('transfer_responsibility')?button('transfer','Reasignacion excepcional'):''}</div>
        <h4>Desglose del recibo</h4>${table(['Concepto','Importe'],d.data.details.map(x=>{const c=JSON.parse(x.snapshot_json);return [h(c.calculation?.item_name||c.calculation?.item?.name||r.description),money(x.amount_cents)];}))}
        <h4>Historico</h4>${table(['Fecha efectiva','Operacion','Motivo'],d.timeline.events.map(e=>[h(e.effective_on),h(eventLabel(e.event_type)),h(e.reason)]))}`;
    }
    const c=d.data.collection,b=d.data.balance;
    return `${button('close','Volver a cobros')}<h3>Cobro · ${h(c.external_key)}</h3>${table(['Fecha','Original','Aplicado','Devuelto','Reintegrado','Disponible'],[[h(c.effective_on),money(b.original_cents),money(b.applied_cents),money(b.returned_cents),money(b.refunded_cents),money(b.available_cents)]])}<div class="toolbar">${can('allocate')?button('allocate','Imputar a recibos'):''}${can('return_collection')?button('return','Registrar devolucion'):''}${can('reverse_allocation')?button('reverse','Desimputar'):''}${can('refund')?button('refund','Reintegrar saldo'):''}${can('record_collection')&&!c.payer_owner_id&&!c.payer_person_id?button('payer','Identificar pagador'):''}</div>${table(['Recibo','Fecha','Imputado','No revertido'],d.data.allocations.map(a=>[h(a.number),h(a.effective_on),money(a.amount_cents),money(a.remaining_cents)]))}`;
  }
  const eventLabel=key=>({'erp3.allocation.confirmed':'Imputacion de cobro','erp3.collection.returned':'Devolucion','erp3.receipt.credited':'Abono','erp3.allocation.reversed':'Desimputacion','erp3.receipt.management_recorded':'Gestion de reclamacion','erp3.responsibility.transferred':'Reasignacion de responsabilidad'}[key]||'Actuacion economica registrada');
  function setForm(title,fields,build,options={}) {s.form={title,fields,build,...options};s.error='';render();}
  function operation(action) {
    const dateField=input('effective_on','Fecha efectiva','date',s.cut);
    const detail=s.detail;
    if(action==='collect') setForm('Registrar cobro',dateField+input('amount','Importe recibido')+select('payer','Pagador',entityOptions('subject','Sin identificar'))+select('method','Medio',[['transferencia','Transferencia'],['efectivo','Efectivo'],['tarjeta','Tarjeta'],['otro','Otro']])+input('reference','Referencia unica del justificante'),d=>({name:'collection.record',payload:{amount_cents:parseMoney(d.amount),currency:s.refs.currency||'EUR',effective_on:d.effective_on,method:d.method,external_source:'registro_manual',external_key:d.reference,...(d.payer?{payer:subject(d.payer)}:{})}}));
    if(['credit','void','uncollectible','claim'].includes(action)) {
      const r=detail.data.receipt;
      const releases=(detail.data.allocations||[]).filter(a=>BigInt(a.remaining_cents)>0n);
      const fields=dateField+(action==='credit'?input('amount','Importe del abono')+(releases.length?`<details class="finWide"><summary>Liberar cobros si el abono afecta a importes ya cobrados</summary>${releases.map(a=>input('release_'+a.id,'Cobro del '+a.effective_on+' · maximo '+money(a.remaining_cents),'text','0,00')).join('')}</details>`:''):action==='claim'?select('classification','Situacion',[['en_gestion','En gestion'],['reclamado','Reclamado'],['en_disputa','En disputa'],['suspendido','Suspendido'],['cerrado','Cerrado']]):'');
      setForm({credit:'Abonar recibo',void:'Anular recibo',uncollectible:'Declarar incobrable sin eliminar deuda',claim:'Registrar gestion'}[action],fields,d=>({name:action==='claim'?'claim.record':action+'.preview',version:r.version,payload:{receipt_id:r.id,effective_on:d.effective_on,...(action==='credit'?{amount_cents:parseMoney(d.amount),release_allocations:releases.map(a=>({allocation_id:a.id,amount_cents:parseMoney(d['release_'+a.id])})).filter(a=>a.amount_cents!=='0')}:{}),...(action==='uncollectible'?{classification:'incobrable'}:{}),...(action==='claim'?{classification:d.classification}:{})}}),{evidenceRequired:action==='uncollectible'});
    }
    if(action==='allocate') {
      const options=[['','Selecciona un recibo'],...(s.receipts?.items||[]).filter(r=>BigInt(r.balance.pending_cents)>0n).map(r=>[r.id,r.number+' · '+r.property_code+' · '+money(r.balance.pending_cents)])];
      setForm('Imputar cobro',dateField+select('receipt','Recibo pendiente',options,'',true)+input('amount','Importe a imputar'),d=>({name:'allocation.preview',payload:{collection_id:detail.data.collection.id,effective_on:d.effective_on,allocations:[{receipt_id:Number(d.receipt),amount_cents:parseMoney(d.amount)}]}}));
    }
    if(action==='return'||action==='reverse') {
      const lines=detail.data.allocations.filter(a=>BigInt(a.remaining_cents)>0n);
      const fields=lines.map(a=>input('reversal_'+a.id,'De '+a.number+' (max. '+money(a.remaining_cents)+')','text','0,00')).join('');
      setForm(action==='return'?'Registrar devolucion':'Liberar imputaciones',dateField+fields+(action==='return'?input('free','De fondos no aplicados','text','0,00')+input('reference','Referencia bancaria de devolucion'):''),d=>{
        const reversals=lines.map(a=>({allocation_id:a.id,amount_cents:parseMoney(d['reversal_'+a.id])})).filter(a=>a.amount_cents!=='0');
        return {name:action==='return'?'return.preview':'allocation.reverse.preview',payload:{effective_on:d.effective_on,reversals,...(action==='return'?{collection_id:detail.data.collection.id,free_cents:parseMoney(d.free),external_key:d.reference}:{})}};
      });
    }
    if(action==='refund') setForm('Reintegrar saldo disponible',dateField+input('amount','Importe a reintegrar')+select('beneficiary','Beneficiario acreditado',entityOptions('subject'),'',true),d=>({name:'refund.preview',payload:{collection_id:detail.data.collection.id,effective_on:d.effective_on,amount_cents:parseMoney(d.amount),beneficiary:subject(d.beneficiary)}}),{evidenceRequired:true});
    if(action==='payer') setForm('Identificar pagador del cobro',dateField+select('payer','Pagador acreditado',entityOptions('subject'),'',true),d=>({name:'collection.payer.preview',payload:{collection_id:detail.data.collection.id,effective_on:d.effective_on,payer:subject(d.payer)}}),{evidenceRequired:true});
    if(action==='policy') setForm('Gastos de devolucion',input('effective_from','Vigente desde','date',s.cut)+select('mode','Repercusion',[['none','No repercutir'],['actual','Coste bancario real'],['fixed','Importe fijo']])+input('amount','Importe fijo (solo si procede)','text','0,00'),d=>({name:'policy.save',version:Math.max(0,...(s.refs.policies||[]).map(p=>p.version)),payload:{effective_from:d.effective_from,return_fee_mode:d.mode,fixed_cents:d.mode==='fixed'?parseMoney(d.amount):'0'}}));
    if(action==='coverage') setForm('Registrar fuente de emision',input('concept','Concepto','text','ordinario')+input('effective_from','Desde','date','')+input('effective_until','Hasta','date',''),d=>({name:'coverage.confirm',payload:{concept_key:d.concept,effective_from:d.effective_from,effective_until:d.effective_until,authority:'erp3'}}),{evidenceRequired:true});
  }
  function describe(object) {
    const rows=[];
    const labels={amount_cents:'Importe',total_cents:'Total',before_cents:'Saldo anterior',after_cents:'Saldo posterior',available_before_cents:'Disponible anterior',available_after_cents:'Disponible posterior',effective_on:'Fecha efectiva',issued_on:'Fecha de emision',free_cents:'Fondos libres devueltos',external_key:'Referencia',released_cents:'Importe liberado',classification:'Clasificacion',effective_from:'Vigente desde',effective_until:'Vigente hasta',concept_key:'Concepto',authority:'Fuente',return_fee_mode:'Politica de gastos',fixed_cents:'Importe fijo',method:'Medio de cobro'};
    for(const [key,label] of Object.entries(labels)) if(object[key]!=null)rows.push([label,key.endsWith('_cents')?money(object[key]):h(object[key])]);
    if(object.property_id)rows.push(['Propiedad',h(s.workspace?.properties.find(p=>p.id_propiedad===object.property_id)?.codigo_propiedad||'Propiedad seleccionada')]);
    const subjectName=x=>x.name||s.workspace?.owners.find(o=>x.type==='owner'&&o.id_propietario===x.id)?.nombre||s.workspace?.persons.find(p=>x.type==='person'&&p.id_persona_cobro===x.id)?.nombre||'Sujeto no localizado';
    for(const [key,label] of [['payer','Pagador'],['recipient','Destinatario'],['beneficiary','Beneficiario']])if(object[key])rows.push([label,h(subjectName(object[key]))]);
    for(const item of object.subjects||object.obligated||[])rows.push(['Obligado economico',h(subjectName(item))]);
    for(const key of ['lines','allocations','details','reversals']) for(const item of object[key]||[]){
      rows.push([h(item.number||s.workspace?.properties.find(p=>p.id_propiedad===item.property_id)?.codigo_propiedad||'Movimiento revisado')+(item.period_key?' · '+h(item.period_key):''),money(item.amount_cents||'0')]);
      for(const [field,label] of [['recipient','Destinatario'],['payer','Pagador']])if(item[field])rows.push([label,h(subjectName(item[field]))]);
      for(const [field,label] of [['obligated','Obligados'],['source_subjects','Responsabilidad de origen'],['target_subjects','Responsabilidad de destino'],['responsibility_subjects','Obligados afectados']])
        if(item[field])rows.push([label,h(item[field].map(subjectName).join(', ')||'Sin atribucion acreditada')]);
    }
    if(object.automatic_reallocation===false)rows.push(['Aplicaciones a recibos','Los fondos quedan libres. No se imputan automaticamente.']);
    return table(['Dato','Valor revisado'],rows);
  }
  async function submit(form) {
    const kind=form.dataset.finForm,d=Object.fromEntries(new FormData(form));
    if(kind==='filter') {s.filters={...s.filters,search:d.search,state:d.state};s.offset=0;return load();}
    if(kind==='upload') {
      const file=form.elements.file.files[0];
      const upload=await api('/api/erp/receivables/import/upload?'+new URLSearchParams({id_comunidad:s.community}),{method:'POST',body:file,headers:{'x-file-name':encodeURIComponent(file.name),'content-type':file.type||'application/octet-stream'}});
      s.import={upload};render();return;
    }
    if(kind==='mapping') {
      const f=s.import;f.source=d.source;f.cutoff=d.cutoff_date;f.start=d.coverage_from;f.end=d.coverage_until;f.scope=d.scope;f.limitations=d.limitations;f.attribution=d.attribution==='on';
      f.mapping=Object.fromEntries(f.upload.headers.map((header,i)=>[header,d['map_'+i]]));
      const body={id_comunidad:s.community,token:f.upload.token,filename:f.upload.filename,sheet:d.sheet,source:f.source,mapping:f.mapping,expected_version:f.preview?.version,
        defaults:{cutoff_date:f.cutoff,coverage_from:f.start,coverage_until:f.end,scope:f.scope,limitations:f.limitations,attribution_confirmed:f.attribution}};
      const signature=JSON.stringify(body);if(f.requestSignature!==signature){f.requestKey=uid();f.requestSignature=signature;}
      f.preview=(await api('/api/erp/receivables/import/preview',{method:'POST',body:JSON.stringify({...body,idempotency_key:f.requestKey})})).entity;
      render();return;
    }
    if(kind==='permissions') {
      const user=s.workspace.permission_users.find(u=>u.id_usuario===Number(d.user));
      const payload={user_id:user.id_usuario,capabilities:Object.fromEntries(Object.keys(s.refs.capabilities).map(k=>[k,d[k]==='on']))};
      s.review={title:'Cambiar permisos de '+user.nombre,content:table(['Permiso','Acceso'],[...form.querySelectorAll('input[type=checkbox]')].map(el=>[h(el.parentElement.textContent),el.checked?'Permitido':'Denegado'])),name:'permissions.save',payload,version:user.version,reason:'Configuracion explicita de permisos por usuario y comunidad'};render();return;
    }
    if(kind==='operation') {
      const fields=form.querySelector('.masterFormGrid').cloneNode(true);
      const originals=[...form.querySelector('.masterFormGrid').querySelectorAll('input,select,textarea')];
      [...fields.querySelectorAll('input,select,textarea')].forEach((el,i)=>{
        const original=originals[i];
        if(el.tagName==='SELECT')[...el.options].forEach(option=>option.toggleAttribute('selected',option.value===original.value));
        else if(el.type==='checkbox')el.toggleAttribute('checked',original.checked);
        else if(el.tagName==='TEXTAREA')el.textContent=original.value;
        else el.setAttribute('value',original.value);
      });
      s.form.fields=fields.innerHTML;
      const request=await s.form.build(d);s.form.reason=d.reason;
      const evidence=d.evidence?{type:'external_reference',id:d.evidence}:null;
      if(request.name.endsWith('.preview')) {
        const proposal=await command(request.name,request.payload,request.version,d.reason,evidence);
        s.review={title:s.form.title,content:describe(proposal.preview),name:request.name.replace(/\.preview$/,'.confirm'),payload:{proposal_id:proposal.id},version:proposal.version,reason:d.reason,evidence};
      }else s.review={title:s.form.title,content:describe(request.payload),...request,reason:d.reason,evidence};
      render();
    }
  }
  async function action(button) {
    const name=button.dataset.finAction;
    if(name==='section'){s.section=button.dataset.section;s.detail=null;s.form=null;s.review=null;s.offset=0;render();return;}
    if(name==='reload')return load();
    if(name==='close'){s.detail=null;s.form=null;s.review=null;render();return;}
    if(name==='cancel'){s.review=null;render();return;}
    if(name==='prev'||name==='next'){s.offset=Math.max(0,s.offset+(name==='prev'?-50:50));return load();}
    if(name==='clear-scope'){s.filters={};s.offset=0;return load();}
    if(name==='confirm') {
      if(!root().querySelector('#finAck')?.checked)throw new Error('Revisa y marca la confirmacion antes de continuar.');
      const r=s.review;await command(r.name,r.payload,r.version,r.reason,r.evidence);
      s.review=null;s.form=null;s.detail=null;s.message='Operacion confirmada y registrada en el historico.';return load();
    }
    if(name==='receipt'){s.detail={type:'receipt',data:(await q('erp3.receipt.get',{receipt_id:Number(button.dataset.id),effective_at:s.cut})).entity,timeline:(await q('erp3.receipt.timeline',{receipt_id:Number(button.dataset.id),effective_at:s.cut})).entity};render();return;}
    if(name==='collection'){s.detail={type:'collection',data:(await q('erp3.collection.get',{collection_id:Number(button.dataset.id),effective_at:s.cut})).entity};render();return;}
    if(name==='opening'){s.detail={type:'opening',data:(await q('erp3.opening.get',{opening_id:Number(button.dataset.id),effective_at:s.cut})).entity};render();return;}
    if(name==='return-reverse') {
      setForm('Rectificar devolucion',input('effective_on','Fecha efectiva','date',s.cut),d=>({name:'return.reverse.preview',payload:{return_id:Number(button.dataset.id),effective_on:d.effective_on}}),{evidenceRequired:true});return;
    }
    if(name==='opening-refund'||name==='opening-abono') {
      const opening=s.detail.data.opening,refund=name==='opening-refund';
      setForm(refund?'Reintegrar saldo historico':'Abonar saldo historico',input('effective_on','Fecha efectiva','date',s.cut)+input('amount','Importe')+(refund?select('beneficiary','Beneficiario acreditado',entityOptions('subject'),'',true):''),d=>({name:'opening.move.preview',payload:{opening_id:opening.id,kind:refund?'refund':'credit',effective_on:d.effective_on,amount_cents:parseMoney(d.amount),...(refund?{beneficiary:subject(d.beneficiary)}:{})}}),{evidenceRequired:true});return;
    }
    if(name==='opening-reverse') {
      const m=s.detail.data.movements.find(x=>x.id===Number(button.dataset.id));
      setForm('Rectificar movimiento historico',input('effective_on','Fecha efectiva','date',s.cut)+input('amount','Importe a revertir','text',moneyInput(m.amount_cents)),d=>({name:'opening.move.preview',payload:{opening_id:m.opening_id,kind:{allocation:'reverse_allocation',credit_apply:'reverse_credit_apply',credit:'reverse_credit'}[m.kind],reverses_id:m.id,effective_on:d.effective_on,amount_cents:parseMoney(d.amount)}}),{evidenceRequired:true});return;
    }
    if(name==='opening-allocate'||name==='opening-credit') {
      const opening=s.detail.data.opening;
      const options=name==='opening-allocate'?(s.workspace.collections||[]).filter(c=>BigInt(c.balance.available_cents)>0n).map(c=>[c.id,c.external_key+' · '+money(c.balance.available_cents)]):(s.receipts.items||[]).filter(r=>BigInt(r.balance.pending_cents)>0n).map(r=>[r.id,r.number+' · '+r.property_code]);
      setForm(name==='opening-allocate'?'Aplicar cobro al saldo historico':'Aplicar saldo a favor',input('effective_on','Fecha efectiva','date',s.cut)+select('target',name==='opening-allocate'?'Cobro disponible':'Recibo',options,'',true)+input('amount','Importe'),d=>({name:'opening.move.preview',payload:{opening_id:opening.id,kind:name==='opening-allocate'?'allocation':'credit_apply',effective_on:d.effective_on,amount_cents:parseMoney(d.amount),[name==='opening-allocate'?'collection_id':'receipt_id']:Number(d.target)}}),{evidenceRequired:true});return;
    }
    if(name==='apply-credit') {
      const credit=s.workspace.credits.find(c=>c.id===Number(button.dataset.id));
      setForm('Aplicar credito a recibo',input('effective_on','Fecha efectiva','date',s.cut)+select('receipt','Recibo pendiente',(s.receipts.items||[]).filter(r=>BigInt(r.balance.pending_cents)>0n).map(r=>[r.id,r.number+' · '+r.property_code]),'',true)+input('amount','Importe'),d=>({name:'credit.apply.preview',payload:{credit_id:credit.id,receipt_id:Number(d.receipt),amount_cents:parseMoney(d.amount),effective_on:d.effective_on}}));return;
    }
    if(name==='regularization') {
      const reg=s.workspace.regularizations.find(r=>r.id_regularizacion===Number(button.dataset.id));
      setForm('Preparar regularizacion: '+reg.motivo,input('effective_on','Fecha efectiva de emision','date',s.cut)+`<div class="finWide">${table(['Propiedad / periodo','Diferencia','Obligado acreditado'],reg.lines.filter(l=>BigInt(l.diferencia_centimos)!==0n).map(l=>[h(l.codigo_propiedad)+' · '+h(l.periodo_clave),money(l.diferencia_centimos),select('subject_'+l.id_linea,'Obligado',entityOptions('subject'),'',true)]))}</div>`,d=>({name:'regularization.emission.preview',payload:{regularization_id:reg.id_regularizacion,effective_on:d.effective_on,decisions:reg.lines.map(l=>({line_id:l.id_linea,subjects:BigInt(l.diferencia_centimos)===0n?[]:[subject(d['subject_'+l.id_linea])],...(BigInt(l.diferencia_centimos)<0n?{credit_beneficiary:subject(d['subject_'+l.id_linea])}:{})}))}}),{evidenceRequired:true});return;
    }
    if(name==='return-fee') {
      const returned=s.workspace.returns.find(r=>r.id===Number(button.dataset.id));
      const details=JSON.parse(returned.details_json);const choices=(Array.isArray(details)?details:details.details||[]).map(d=>[d.receipt_id,s.receipts.items.find(r=>r.id===d.receipt_id)?.number||'Recibo de la devolucion']);
      if(!choices.length)throw new Error('La devolucion no tiene un recibo asociado. No se atribuye el gasto automaticamente.');
      setForm('Gasto independiente de devolucion',input('effective_on','Fecha del gasto','date',s.cut)+select('receipt','Recibo de origen',choices,'',true)+input('amount','Coste bancario real')+input('reference','Referencia del justificante de gasto'),d=>({name:'return.fee.preview',payload:{return_id:returned.id,receipt_id:Number(d.receipt),cost_cents:parseMoney(d.amount),cost_reference:d.reference,effective_on:d.effective_on}}),{evidenceRequired:true});return;
    }
    if(name==='transfer') {
      const r=s.detail.data.receipt,buckets=s.detail.timeline.responsibilities;
      setForm('Reasignacion excepcional de deuda',input('effective_on','Fecha efectiva','date',s.cut)+select('bucket','Deuda de origen',buckets.map((b,i)=>[i,b.subjects.map(x=>s.workspace.owners.find(o=>x.type==='owner'&&o.id_propietario===x.id)?.nombre||s.workspace.persons.find(p=>x.type==='person'&&p.id_persona_cobro===x.id)?.nombre||'Sin atribuir').join(', ')+' · '+money(b.pending_cents)]),'',true)+select('target','Nuevo obligado',entityOptions('subject'),'',true)+input('amount','Importe a reasignar')+input('authorization','Autorizacion expresa'),d=>({name:'responsibility.transfer.preview',payload:{effective_on:d.effective_on,authorization_reference:d.authorization,lines:[{receipt_id:r.id,amount_cents:parseMoney(d.amount),source_subjects:buckets[Number(d.bucket)].subjects,target_subjects:[subject(d.target)]}]}}),{evidenceRequired:true});return;
    }
    if(name==='confirm-import') {
      if(!root().querySelector('#finImportAck')?.checked)throw new Error('Confirma la revision de la importacion.');
      const p=s.import.preview;
      await command('history.import.confirm',{import_id:p.id},p.version,'Confirmacion humana del historico y sus limitaciones',{type:'external_reference',id:s.import.upload?.file_hash||'importacion-'+p.id});
      s.import.preview.state='confirmed';s.message='Importacion confirmada sin fabricar recibos ni cobros.';return load();
    }
    if(name==='import-open'){s.import={preview:(await q('erp3.history.import.get',{import_id:Number(button.dataset.id)})).entity};render();return;}
    if(name==='emit') {
      const plans=(await q('erp2.plan.list')).items||[];
      if(!plans.length)throw new Error('No hay planes aprobados. Aprueba un presupuesto o una derrama primero.');
      setForm('Preparar emision',select('plan','Presupuesto / derrama',plans.map(p=>[p.id_plan_version,(p.denominacion||p.tipo)+' · '+p.fecha_inicio+' a '+p.fecha_fin]),'',true),d=>({name:'emission.preview',payload:{plan_version_id:Number(d.plan),period_keys:[],issued_on:s.cut}}));
      s.form.plans=plans;
      const planField=root().querySelector('[name=plan]');
      async function periods(){const p=plans.find(p=>p.id_plan_version===Number(planField.value));const result=(await q('erp2.plan.export.preview',{id_plan:p.id_plan})).entity;
        const area=document.createElement('div');area.className='masterFormGrid';area.id='finPeriods';area.innerHTML=result.periods.map(period=>`<label class="finCheck"><input type="checkbox" name="period" value="${h(period.clave_periodo)}">${h(period.fecha_inicio)} a ${h(period.fecha_fin)}</label>`).join('');root().querySelector('#finPeriods')?.remove();planField.closest('label').after(area);
        s.form.build=d=>({name:'emission.preview',payload:{plan_version_id:Number(d.plan),period_keys:[...root().querySelectorAll('[name=period]:checked')].map(x=>x.value),issued_on:s.cut}});
      }
      planField.addEventListener('change',()=>run(periods));await periods();return;
    }
    if(name==='responsibility') {
      const owners=entityOptions('subject').filter(([id])=>id);
      setForm('Confirmar obligados economicos',select('property','Propiedad',entityOptions('property'),s.filters.property_id||'',true)+input('effective_from','Efectivo desde','date',s.cut)+input('effective_until','Hasta (opcional)','date','',false)+`<fieldset><legend>Obligados acreditados</legend>${owners.map(([id,label])=>`<label class="finCheck"><input type="checkbox" name="obligated" value="${h(id)}">${h(label)}</label>`).join('')}</fieldset>`,async d=>{
        const subjects=[...root().querySelectorAll('[name=obligated]:checked')].map(x=>subject(x.value));
        if(!subjects.length)throw new Error('Selecciona al menos un obligado acreditado.');
        const current=(await q('erp3.responsibility.get',{property_id:Number(d.property)})).entity;
        return {name:'responsibility.confirm',version:current.version,payload:{property_id:Number(d.property),effective_from:d.effective_from,subjects,...(d.effective_until?{effective_until:d.effective_until}:{})}};
      },{evidenceRequired:true});return;
    }
    operation(name);
  }
  async function run(fn,element) {
    if(s.busy)return;s.busy=true;root().inert=true;if(element)element.disabled=true;s.error='';
    try{await fn();}catch(error){s.error=error.message;const warning=document.createElement('div');warning.className='finWarning';warning.setAttribute('role','alert');warning.textContent=error.message;root().querySelector('.finWorkspace')?.prepend(warning);}
    finally{s.busy=false;root().inert=false;if(element?.isConnected)element.disabled=false;}
  }
  function bind() {
    root().querySelectorAll('[data-fin-action]').forEach(b=>b.onclick=()=>run(()=>action(b),b));
    root().querySelectorAll('[data-fin-form]').forEach(f=>f.onsubmit=e=>{e.preventDefault();run(()=>submit(f),f.querySelector('button:not([type=button])'));});
    root().querySelector('[name=community]')?.addEventListener('change',e=>{const community=Number(e.target.value);reset();s.community=community;load();});
    root().querySelector('[name=cut]')?.addEventListener('change',e=>{s.cut=e.target.value;s.detail=null;s.form=null;s.review=null;load();});
    root().querySelector('[data-fin-form=permissions] [name=user]')?.addEventListener('change',e=>{s.permissionUser=Number(e.target.value);render();});
  }
  return {load,render,reset,open(community,filters={},label=''){reset();s.community=community;s.filters=filters;s.scopeLabel=label;s.section=Object.keys(filters).length?'debt':'receipts';ctx.navigate();},ensure(){if(!s.loaded&&!s.loading)load();}};
}
