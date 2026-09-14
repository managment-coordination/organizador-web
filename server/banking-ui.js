// Banking requests use the dedicated, authenticated HTTPS boundary only.
function createBankingUI(ctx) {
  const {api,html:h,root,active,communities,moneyLabel:money}=ctx;
  const today=()=>new Date().toLocaleDateString('sv-SE');
  let s,generation=0,reconciliation;
  const reset=()=>{generation++;reconciliation?.cancel();s={community:0,section:'remittances',offset:0,keys:new Map(),error:'',filters:{},selected:new Map()};};
  reset();
  async function openReconciliation(community,filters={},scope=''){
    s.community=community;s.section='reconciliation';s.filters=filters;s.scope=scope;
    reconciliation ||= createReconciliationUI({...ctx,active:()=>active()&&s.section==='reconciliation',
      openRemittances:community=>{reset();s.community=community;return load();}});
    const opening=reconciliation.open(community,filters,scope);ctx.navigate();return opening;
  }
  const can=k=>Boolean(s.permissions?.[k]);
  const labels={activa:'Activa',activo:'Activo',pendiente:'Pendiente de revision',suspendido:'Suspendido',suspendida:'Suspendida',
    revocado:'Revocado',caducado:'Caducado',agotado:'Agotado',recurrente:'Recurrente',puntual:'Puntual',
    preparada:'Preparada',fichero_disponible:'Lista para exportar',cancelacion_solicitada:'Retirada solicitada',exportada:'Exportada',presentada:'Presentada',
    seguimiento:'En seguimiento',finalizada:'Finalizada',cancelada:'Cancelada',confirmada:'Confirmada',confirmado:'Confirmado',
    technical:'Acuse tecnico',pending:'Pendiente',rejected:'Rechazado',settlement:'Cobro acreditado',returned:'Devuelto',cancelled:'Cerrado',conflict:'Revisar contradiccion'};
  const label=x=>labels[x]||x||'';
  const button=(action,text,extra='',cls='')=>`<button type="button" class="${cls}" data-bank-action="${action}" ${extra}>${h(text)}</button>`;
  const field=(name,text,type='text',value='',required=true)=>`<label>${h(text)}<input name="${name}" type="${type}" value="${h(value)}" ${required?'required':''} autocomplete="${type==='password'?'current-password':'off'}"></label>`;
  const select=(name,text,options,value='',required=true)=>`<label>${h(text)}<select name="${name}" ${required?'required':''}>${options.map(([v,t])=>`<option value="${h(v)}" ${String(v)===String(value)?'selected':''}>${h(t)}</option>`).join('')}</select></label>`;
  const check=(name,text,checked=false)=>`<label class="finCheck"><input type="checkbox" name="${name}" ${checked?'checked':''}>${h(text)}</label>`;
  const table=(headers,rows)=>`<div class="finTableWrap"><table class="masterDataTable finTable"><thead><tr>${headers.map(t=>`<th>${h(t)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(r=>`<tr>${r.map((v,i)=>`<td data-label="${h(headers[i])}">${v}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${headers.length}">No hay registros para esta seleccion.</td></tr>`}</tbody></table></div>`;
  const total=rows=>rows.reduce((v,r)=>v+BigInt(r.pending_cents||r.amount_cents||'0'),0n).toString();
  const subject=value=>{const [type,id]=String(value).split(':');return {type,id:Number(id)};};
  const subjectOptions=()=>[['','Selecciona'],...(s.owners||[]).map(o=>['owner:'+o.id,o.label]),...(s.persons||[]).map(o=>['person:'+o.id,o.label])];
  const creditorOptions=()=>[['','Selecciona'],...(s.creditors||[]).map(c=>[c.id,c.name+' · '+c.masked])];
  const accountOptions=()=>[['','Selecciona'],...(s.accounts||[]).map(a=>[a.id,a.masked+' · '+label(a.state)])];
  const evidenceValue=e=>typeof e==='object'?e:{type:'external_reference',id:e};
  async function post(action,body) {
    const token=generation,community=s.community;
    const result=await api('/api/erp/banking/'+action,{method:'POST',body:JSON.stringify({...body,id_comunidad:community})});
    if(token!==generation||community!==s.community)throw new Error('El contexto ha cambiado. Consulta la comunidad anterior para comprobar el resultado.');
    return result;
  }
  const q=async(name,filters={})=>(await post('query',{query:'erp4.'+name,filters})).entity;
  async function command(name,payload,version,reason,evidence) {
    const signature=JSON.stringify([s.community,name,payload,version,reason,evidence]);
    if(!s.keys.has(signature))s.keys.set(signature,crypto.randomUUID());
    return (await post('command',{command:'erp4.'+name,payload,expected_version:version??null,
      idempotency_key:s.keys.get(signature),reason,evidence:evidenceValue(evidence),origin:'web'})).entity;
  }
  async function all(name,filters={}) {
    const result=[];
    for(let offset=0;offset<20000;offset+=200){const page=await q(name,{...filters,offset,limit:200});result.push(...page.items);if(result.length>=page.total)return result;}
    throw new Error('Acota la seleccion: hay mas de 20.000 registros.');
  }
  async function references(){
    if(s.owners)return;
    s.owners=await all('reference.list',{kind:'owners'});
    s.persons=await all('reference.list',{kind:'persons'});
    s.properties=await all('reference.list',{kind:'properties'});
  }
  async function load() {
    if(!s.community)s.community=Number(communities()[0]?.id_comunidad||0);
    if(!s.community){s.error='Selecciona una comunidad.';render();return;}
    const token=++generation;s.loading=true;s.error='';render();
    try {
      s.status=await api('/api/erp/banking/status');
      if(token!==generation)return;
      if(!s.status.available)return;
      try{const workspace=await q('workspace.get');s.permissions=workspace.permissions;s.counts=workspace.counts;s.liveEnabled=workspace.live_enabled;}
      catch(error){
        if(token!==generation)return;
        if(ctx.isSuperuser?.()&&error.status===403&&error.message==='No tienes permiso para esta operacion bancaria.'){
          s.permissionUsers=(await q('permissions.get')).users;s.section='settings';s.permissions={};return;
        }
        throw error;
      }
      s.creditors=(await q('creditor.list')).items;
      s.documents=await all('document.list');
      if(s.section==='remittances')s.list=await q('remittance.list',{...s.filters,offset:s.offset,limit:50});
      if(s.section==='mandates'){s.accounts=await all('account.list');s.list=await q('mandate.list',{...s.filters,offset:s.offset,limit:50});s.domiciles=s.filters.property_id?(await q('direct_debit.list',{property_id:s.filters.property_id})).items:null;}
      if(s.section==='results'&&can('results'))s.list=await q('results.list',{offset:s.offset,limit:50});
      if(s.section==='settings'&&ctx.isSuperuser?.())s.permissionUsers=(await q('permissions.get')).users;
      if(s.section==='external'){s.control=await q('control.list',{...(s.filters.property_id?{property_id:s.filters.property_id}:{}),search:s.externalSearch||'',offset:s.offset,limit:50});s.list={total:s.control.total};}
      s.loaded=true;
    }catch(error){if(token===generation)s.error=error.message;}
    finally{if(token===generation){s.loading=false;render();}}
  }
  const paging=()=>`<div class="toolbar">${button('prev','Anterior',s.offset?'':'disabled')}<span>${s.list?.total||0} registros</span>${button('next','Siguiente',s.offset+50<(s.list?.total||0)?'':'disabled')}</div>`;
  function render() {
    if(!active())return;
    if(s.section==='reconciliation'){reconciliation?.render();return;}
    const tabs=[['remittances','Remesas'],['reconciliation','Conciliacion'],['mandates','Cuentas y mandatos'],['results','Resultados'],['external','Instrucciones externas'],['settings','Configuracion']];
    root().innerHTML=`<div class="finWorkspace bankWorkspace"><div class="budgetToolbar">${select('bankCommunity','Comunidad',communities().map(c=>[c.id_comunidad,c.nombre]),s.community)}${button('reload','Actualizar')}</div>
      ${s.status?.available?`<div class="budgetTabs finTabs">${tabs.filter(([key])=>key!=='results'||can('results')).map(([key,text])=>button('section',text,`data-section="${key}"`,s.section===key?'active':'')).join('')}</div>`:''}
      ${s.scope?`<div class="finScope">${h(s.scope)} ${button('clear-scope','Ver comunidad')}</div>`:''}
      ${s.status?.available&&s.liveEnabled===false?'<p class="finWarning">Operativa real deshabilitada. Solo entorno de pruebas; no presentar ficheros al banco.</p>':''}
      ${s.error?`<div class="finWarning" role="alert">${h(s.error)}</div>`:''}${s.message?`<p role="status">${h(s.message)}</p>`:''}
      ${s.loading?'<p role="status">Cargando informacion bancaria...</p>':s.status&&!s.status.available?`<div class="finWarning" role="status">${h(s.status.reason)} No se permiten operaciones bancarias desde este acceso.</div>`:
        s.review?reviewHtml():s.form?formHtml():s.selection?selectionHtml():s.detail?detailHtml():s.section==='settings'?settingsHtml():s.section==='mandates'?mandatesHtml():s.section==='results'?resultsHtml():s.section==='external'?externalHtml():remittancesHtml()}</div>`;
    bind();
  }
  function remittancesHtml(){return `<div class="toolbar">${can('prepare')?button('prepare','Preparar remesa','','green'):''}</div>
    ${s.counts?.needs_review?`<p class="finWarning">${h(s.counts.needs_review)} remesas requieren revision.</p>`:''}
    ${table(['Fecha de cargo','Recibos','Importe','Estado',''],(s.list?.items||[]).map(r=>[h(r.requested_on),h(r.line_count),money(r.amount_cents),h(label(r.state))+(r.needs_review?' · Revisar':''),button('remittance','Abrir',`data-id="${r.id}"`)]))}${paging()}`;}
  function mandatesHtml(){return `<div class="toolbar">${can('manage_accounts')?button('account','Nueva cuenta'):''}${can('manage_mandates')?button('mandate','Nuevo mandato','','green'):''}${can('manage_accounts')?button('import','Importar cuentas'):''}</div>
    ${table(['Pagador','Cuenta','Propiedades','Vigencia','Estado',''],(s.list?.items||[]).map(m=>[h(m.debtor_name),h(m.account.masked),h(m.property_ids.length),h(m.effective_from),h(label(m.state)),button('mandate-detail','Abrir',`data-id="${m.id}"`)]))}${paging()}
    ${s.domiciles?`<h3>Domiciliacion de la propiedad</h3>${table(['Desde','Hasta','Situacion',''],s.domiciles.map(d=>[h(d.effective_from),h(d.effective_until||'Actualidad'),h(label(d.state))+(d.current?' · Vigente':''),d.current&&can('manage_mandates')?button('domicile-state','Gestionar',`data-id="${d.id}"`):'']))}`:''}
    <details><summary>Cuentas registradas (${s.accounts?.length||0})</summary>${table(['Cuenta','Estado',''],(s.accounts||[]).map(a=>[h(a.masked),h(label(a.state)),button('account-detail','Gestionar',`data-id="${a.id}"`)]))}</details>`;}
  function resultsHtml(){return `<div class="toolbar">${button('result-upload','Importar respuesta bancaria')}${button('result-manual','Registrar resultado acreditado')}</div>
    ${table(['Registrado','Origen','Estado',''],(s.list?.items||[]).map(r=>[h(r.registered_at.slice(0,10)),r.profile_id==='pain002'?'Respuesta del banco':'Evidencia revisada',h(label(r.state)),button('result-detail','Revisar',`data-id="${r.id}"`)]))}${paging()}`;}
  function externalHtml(){return `<div class="toolbar">${can('prepare')?button('external','Registrar instrucciones anteriores'):''}</div>
    <form data-bank-form="external-search" class="toolbar">${field('search','Buscar recibo o propiedad','search',s.externalSearch||'',false)}<button>Buscar</button></form>
    ${table(['Recibo / propiedad','Corte','Estado',''],(s.control?.external_instructions||[]).map(r=>[h(r.number+' · '+r.property_code),h(r.cutoff_on),h(label(r.state)),r.state==='activa'&&can('present_cancel')?button('external-close','Acreditar cierre',`data-id="${r.id}"`):'']))}${paging()}`;}
  function settingsHtml(){return `<div class="toolbar">${can('configure_creditor')?button('creditor','Configurar acreedor'):''}</div>
    <details><summary>Documentos bancarios protegidos</summary>${button('bank-document-upload','Adjuntar documento')}${table(['Documento','Fecha',''],(s.documents||[]).map(d=>[h(d.label),h(d.registered_at.slice(0,10)),can('export')&&can('reveal')?button('bank-document-download','Descargar',`data-id="${d.id}"`):'']))}</details>
    ${table(['Comunidad / acreedor','Cuenta de ingreso','Identificador','Configuracion',''],(s.creditors||[]).map(c=>[h(c.name),h(c.masked),h(c.creditor_identifier),c.profile?'Configurada':'Pendiente',can('configure_creditor')?button('profile','Revisar configuracion',`data-id="${c.id}"`):'']))}
    ${s.permissionUsers?`<details open><summary>Permisos bancarios por usuario</summary>${select('permissionUser','Usuario',s.permissionUsers.map(u=>[u.id_usuario,u.nombre]),s.permissionUser||s.permissionUsers[0]?.id_usuario)}
      ${table(['Operacion','Acceso'],Object.entries({read_masked:'Consultar datos enmascarados',manage_accounts:'Gestionar cuentas',manage_mandates:'Gestionar mandatos y domiciliaciones',configure_creditor:'Configurar acreedor',prepare:'Preparar remesas',export:'Exportar ficheros',reveal:'Consultar IBAN completo',present_cancel:'Presentaciones y cancelaciones',results:'Confirmar resultados',audit:'Consultar auditoria'}).map(([k,t])=>{
        const user=s.permissionUsers.find(u=>u.id_usuario===Number(s.permissionUser))||s.permissionUsers[0],grant=user?.grants.find(g=>g.capability===k);
        return [h(t),button('permission',grant?.allowed?'Revocar':'Conceder',`data-capability="${k}" data-user="${user?.id_usuario}" data-version="${grant?.version||0}" data-allow="${grant?.allowed?'0':'1'}"`)];}))}</details>`:''}`;}
  function form(title,fields,build,options={}){s.form={title,fields,build,...options};s.error='';s.review=null;render();}
  function formHtml(){const f=s.form;return `<section class="finEditor"><h3>${h(f.title)}</h3><form data-bank-form="operation"><div class="masterFormGrid">${f.fields}</div>
    ${field('reason','Motivo / descripcion','text',f.reason||'')}${s.documents?.length?select('bank_document','Documento protegido (opcional)',[['','Referencia externa'],...s.documents.map(d=>[d.id,d.label+' · '+d.registered_at])],f.documentId||'',false):''}${field('evidence','Referencia de la evidencia conservada','text',typeof f.evidence==='string'?f.evidence:'',!s.documents?.length)}
    ${f.reauth?field('password','Confirma tu contrasena','password'):''}<div class="toolbar"><button>${f.submitLabel||'Revisar'}</button>${button('close-form','Cancelar')}</div></form></section>`;}
  function reviewHtml(){return `<section class="finReview" aria-label="Revision bancaria"><h3>${h(s.review.title)}</h3>${s.review.content}
    <p>No se ha confirmado la operacion. Exportar o presentar una remesa no registra un cobro.</p>${check('bankAck','He revisado los datos y la evidencia.')}
    <div class="toolbar">${button('confirm','Confirmar','','green')}${button('edit','Volver a editar')}</div></section>`;}
  function selectedRows(){return [...s.selected.values()];}
  function selectionHtml(){const sel=s.selection;return `<h3>${h(sel.title)}</h3><form data-bank-form="search" class="toolbar">${field('search','Buscar','search',sel.search||'',false)}<button>Buscar</button></form>
    <div class="toolbar">${button('select-visible','Seleccionar visibles')}${button('deselect','Deseleccionar todas')}<strong>${s.selected.size} seleccionadas${sel.kind==='receipts'?' · '+money(total(selectedRows())):''}</strong></div>
    ${table(sel.kind==='receipts'?['Seleccionar','Recibo / propiedad','Pendiente','Revision']:['Seleccionar','Propiedad','Configuracion'],sel.rows.map(r=>[
      `<input type="checkbox" data-bank-select="${r.id}" aria-label="Seleccionar ${h(r.label||r.number)}" ${s.selected.has(r.id)?'checked':''} ${r.issues?.length?'disabled':''}>`,
      h(r.label||r.number+' · '+r.property_code),sel.kind==='receipts'?money(r.pending_cents):h(r.issues?.join(' ')||r.alcance||''),
      ...(sel.kind==='receipts'?[h(r.issues?.join(' ')||(r.retry_of?'Reenvio: requiere confirmacion':'Pendiente de validacion final'))+(r.requires_third_party_authorization?button('third-party',sel.authorizations?.[r.id]?'Autorizacion incorporada':'Autorizar pagador distinto',`data-id="${r.id}"`):'')]:[])]))}
    <div class="toolbar">${button('selection-prev','Anterior',sel.offset?'':'disabled')}<span>${sel.total} registros</span>${button('selection-next','Siguiente',sel.offset+100<sel.total?'':'disabled')}</div>
    ${sel.kind==='receipts'?`${button('notice-draft','Preparar avisos de domiciliacion',s.selected.size?'':'disabled')}${sel.drafts?sel.drafts.map((d,i)=>`<details><summary>${h(d.recipient)}</summary><label>Borrador de aviso<textarea readonly rows="8">${h(d.text)}</textarea></label>${button('copy-notice','Copiar texto',`data-index="${i}"`)}</details>`).join(''):''}<p class="finWarning">La prenotificacion debe estar ya enviada y cubrir estos importes y la fecha de cargo.</p>${field('sent_on','Prenotificacion enviada el','date',sel.sentOn||today())}${check('sent_ack','Confirmo que estos avisos ya se han enviado y conservo la evidencia.',!!sel.sentAck)}`:''}
    <div class="toolbar">${button('selection-review','Revisar seleccion',s.selected.size?'':'disabled','green')}${button('close','Cancelar')}</div>`;}
  function detailHtml(){const d=s.detail,x=d.data;
    if(d.type==='account')return `${button('close','Volver')}<h3>${h(x.masked)}</h3><p>${h(label(x.state))}</p><div class="toolbar">${can('manage_accounts')?button('account-link','Vincular pagador / titular')+button('account-state','Cambiar estado'):''}${can('reveal')?button('reveal','Consultar IBAN'):''}</div>${s.revealed?`<div role="status" class="bankRevealed">${h(s.revealed)} ${button('hide-iban','Ocultar')}</div>`:''}`;
    if(d.type==='mandate')return `${button('close','Volver')}<h3>${h(d.summary?.debtor_name||'Mandato')}</h3><p>${h(label(x.state))} · ${h(label(x.kind))}</p><div class="toolbar">${can('manage_mandates')?button('mandate-state','Cambiar estado')+(x.state==='activo'?button('domicile','Gestionar propiedades'):'')+(['activo','pendiente','suspendido'].includes(x.state)?button('mandate-account','Cambiar cuenta'):'')+button('mandate-successor','Vincular mandato sucesor'):''}</div>
      ${table(['Desde','Hasta','Cuenta','Firma'],x.revisions.map(r=>[h(r.effective_from),h(r.effective_until||'Actualidad'),h(r.account.masked),h(r.signed_on)]))}<details><summary>Historico</summary>${table(['Fecha','Actuacion'],x.events.map(e=>[h(e.effective_on),h(label(e.event_type))]))}</details>`;
    if(d.type==='result')return `${button('close','Volver')}<h3>Revision de resultado</h3>${table(['Seleccionar','Fecha','Resultado','Correspondencia','Importe','Estado',''],x.lines.map(r=>[r.state!=='confirmada'&&r.matched&&!r.contradictory&&['technical','rejected','cancelled'].includes(r.kind)?`<input type="checkbox" name="result_row" value="${r.id}" aria-label="Seleccionar resultado del ${h(r.effective_on)}">`:'',h(r.effective_on),h(label(r.kind)),r.matched?'Recibo vinculado':'Pendiente de identificar',r.amount_cents?money(r.amount_cents):'No acredita fondos',h(label(r.state)),r.state!=='confirmada'?button('result-line','Revisar',`data-id="${r.id}"`):'']))}${button('result-batch','Revisar acuses y rechazos seleccionados')}`;
    if(d.type==='import')return `${button('close','Volver')}<h3>Importacion de cuentas</h3><p class="finWarning">Los mandatos y las referencias de propietarios permanecen pendientes de acreditacion.</p>${table(['Fila','Cuenta','Revision'],x.items.map(r=>[h(r.row),h(r.masked),h(r.issues.join(' ')||'Sin incidencias de formato')]))}${x.state==='pendiente'?button('import-confirm','Revisar filas validas','','green'):'Confirmada'}`;
    const file=x.files?.at(-1);
    return `${button('close','Volver')}<h3>Remesa · ${h(x.requested_on)}</h3><div class="toolbar"><strong>${money(total(x.lines))}</strong><span>${h(label(x.state))}</span></div>${x.needs_review?'<p class="finWarning" role="alert">La remesa requiere revision. No presentes otro intento mientras exista incertidumbre.</p>':''}
      <div class="toolbar">${can('prepare')&&!file&&x.state==='preparada'?button('build','Validar fichero'):''}${can('export')&&file?button('export','Exportar XML','','green'):''}${can('present_cancel')&&file&&x.state==='exportada'?button('present','Registrar presentacion')+button('not-presented','Acreditar no presentacion'):''}${can('present_cancel')&&file&&['exportada','presentada','seguimiento'].includes(x.state)?button('withdraw','Solicitar retirada'):''}${can('present_cancel')&&['preparada','validada','fichero_disponible'].includes(x.state)?button('cancel-local','Cancelar remesa'):''}${can('results')?button('result-manual','Registrar resultado'):''}</div>
      ${table(['Recibo','Pagador','Cuenta','Importe','Situacion',''],x.lines.map(r=>[h(r.concept),h(r.debtor_name),h(r.masked),money(r.amount_cents),h(label(r.state)),button('economic','Ver recibo',`data-id="${r.receipt_id}"`)+(r.state==='returned'&&r.events.some(e=>e.return_id)?button('return-fee','Revisar gasto independiente',`data-id="${r.events.filter(e=>e.return_id).at(-1).return_id}"`):'')+(can('results')&&r.state==='conflict'?r.events.filter(e=>e.kind==='conflict').map(e=>button('conflict-review','Revisar contradiccion',`data-id="${e.id}"`)).join(''):'')+(can('manage_mandates')&&r.mandate?.kind==='puntual'&&['rejected','cancelled'].includes(r.state)?button('oneoff-retry','Acreditar fallo puntual',`data-id="${r.id}"`):'')+(can('present_cancel')&&r.state==='settlement'?button('reversal','Solicitar inversion',`data-id="${r.id}"`):'')]))}
      <details><summary>Historico de intentos y resultados</summary>${table(['Recibo','Fecha','Resultado'],x.lines.flatMap(r=>r.events.map(e=>[h(r.concept),h(e.effective_on),h(label(e.kind))])))}</details>`;
  }
  async function openSelection(kind,options){s.selected=new Map();s.form=null;s.review=null;s.selection={kind,offset:0,search:'',...options};await loadSelection();}
  async function loadSelection(){const sel=s.selection;const result=await q(sel.kind==='receipts'?'receipt.candidates':'reference.list',{
    ...sel.filters,search:sel.search,offset:sel.offset,limit:100});sel.rows=result.items;sel.total=result.total;render();}
  async function chooseAction(action,b) {
    if(action==='reload'){s.detail=null;s.form=null;s.review=null;s.selection=null;return load();}
    if(action==='section'){if(b.dataset.section==='reconciliation')return openReconciliation(s.community,s.filters,s.scope);s.section=b.dataset.section;s.offset=0;s.filters={};s.scope='';s.form=null;s.detail=null;s.review=null;s.selection=null;return load();}
    if(action==='prev'||action==='next'){s.offset+=action==='next'?50:-50;return load();}
    if(action==='clear-scope'){s.filters={};s.scope='';return load();}
    if(action==='close'){s.form=null;s.review=null;s.detail=null;s.selection=null;s.revealed=null;return load();}
    if(action==='close-form'){s.form=null;s.review=null;render();return;}
    if(action==='edit'){s.review=null;render();return;}
    if(action==='hide-iban'){s.revealed=null;render();return;}
    if(action==='confirm'){
      if(!root().querySelector('[name="bankAck"]')?.checked)throw new Error('Confirma la revision antes de continuar.');
      const review=s.review;
      const result=await review.run();s.review=null;s.form=null;s.selection=null;s.detail=null;s.revealed=null;
      s.message='Operacion registrada correctamente.';if(review.after)await review.after(result);else await load();return;
    }
    if(action==='remittance'){s.detail={type:'remittance',data:await q('remittance.get',{id:Number(b.dataset.id)})};render();return;}
    if(action==='mandate-detail'){s.detail={type:'mandate',data:await q('mandate.detail',{id:Number(b.dataset.id)}),summary:s.list.items.find(m=>m.id===Number(b.dataset.id))};render();return;}
    if(action==='account-detail'){s.detail={type:'account',data:s.accounts.find(a=>a.id===Number(b.dataset.id))};render();return;}
    if(action==='result-detail'){s.detail={type:'result',data:await q('results.get',{id:Number(b.dataset.id)})};render();return;}
    if(action==='economic'){await ctx.openReceipt?.(s.community,Number(b.dataset.id));return;}
    if(action==='return-fee'){await ctx.openReturnFee?.(s.community,Number(b.dataset.id));return;}
    if(action==='bank-document-upload')return form('Adjuntar documento bancario',select('purpose','Finalidad',[
      ...(can('manage_mandates')?[['mandate','Mandato o autorizacion']]:[]),...(can('manage_accounts')?[['account','Cuenta bancaria']]:[]),
      ...(can('configure_creditor')?[['creditor','Contrato de la comunidad']]:[]),...(can('results')?[['result','Justificante de resultado']]:[])])+field('file','PDF o imagen','file'),async(f,node)=>({name:'document.upload',payload:{purpose:f.purpose,filename:node.elements.file.files[0].name,data:await fileBase64(node.elements.file.files[0])},summary:[['Documento','Archivo protegido; no se incorpora a la IA']]}));
    if(action==='bank-document-download')return form('Descargar documento protegido','',f=>({special:()=>downloadDocument(Number(b.dataset.id),f.reason),summary:[['Acceso','Descarga de datos sensibles, con registro de acceso']]}),{reauth:true});
    if(action==='account')return form('Nueva cuenta',field('iban','IBAN')+field('alias','Nombre de referencia','text','',false),f=>({name:'account.create',payload:{iban:f.iban,alias:f.alias},summary:[['Cuenta',mask(f.iban)],['Referencia',f.alias]]}));
    if(action==='account-link'){
      await references();const a=s.detail.data;
      return form('Relacion con la cuenta',select('subject','Persona',subjectOptions())+select('role','Relacion',[['titular','Titular de la cuenta'],['cotitular','Cotitular'],['autorizado','Autorizado'],['pagador','Pagador']])+field('from','Desde','date',today()),f=>({name:'account.link',version:a.version,payload:{account_id:a.id,subject:subject(f.subject),role:f.role,effective_from:f.from}}));
    }
    if(action==='account-state'){const a=s.detail.data;return form('Estado de cuenta',select('state','Estado',[['activa','Activa'],['bloqueada','Bloqueada'],['cerrada','Cerrada']],a.state),f=>({name:'account.state',version:a.version,payload:{id:a.id,state:f.state}}));}
    if(action==='reveal'){const a=s.detail.data;return form('Consulta bancaria restringida','',f=>({special:async()=>post('reveal',{account_id:a.id,reason:f.reason}),after:result=>{s.detail={type:'account',data:a};s.revealed=result.iban;render();setTimeout(()=>{s.revealed=null;render();},30000);},summary:[['Cuenta',a.masked]]}),{reauth:true});}
    if(action==='creditor')return form('Acreedor de la comunidad',field('name','Nombre de la comunidad')+field('creditor_identifier','Identificador de acreedor')+field('iban','Cuenta de ingreso')+addressFields()+field('from','Vigente desde','date',today()),f=>({name:'creditor.create',payload:{name:f.name,creditor_identifier:f.creditor_identifier,iban:f.iban,address:address(f),effective_from:f.from},summary:[['Acreedor',f.name],['Cuenta',mask(f.iban)]]}),{reauth:true});
    if(action==='profile'){
      const c=s.creditors.find(x=>x.id===Number(b.dataset.id));
      const current=await q('profile.get',{creditor_id:c.id}),cfg=current.config||{};
      return form('Configuracion bancaria',field('bank_name','Banco','text',cfg.bank_name||'')+field('cutoff','Hora de corte','time',cfg.cutoff||'14:00')+field('lead','Dias habiles de antelacion','number',String(cfg.lead_business_days||1))+field('countries','Paises admitidos (ES, DE...)','text',(cfg.countries||['ES']).join(', '))+field('holidays','Festivos (AAAA-MM-DD, separados por coma)','text',(cfg.holidays||[]).join(', '),false)+field('max_lines','Maximo de recibos','number',String(cfg.max_lines||1000))+field('max_total','Importe maximo (EUR)','text',decimal(cfg.max_total_cents||'10000000'))+
        select('mode','Modo',[['test','Pruebas: sin presentacion real'],['live','Operativa real acreditada']],cfg.mode||'test')+check('accepted','Perfil validado por el banco',cfg.bank_profile_accepted)+check('external','He revisado las instrucciones bancarias externas',cfg.external_instructions_reviewed)+check('oneoff','El banco permite reintentos de mandatos puntuales fallidos',cfg.allow_failed_oneoff_retry),f=>({name:'profile.configure',version:current.version,payload:{creditor_id:c.id,config:{...cfg,bank_name:f.bank_name,timezone:cfg.timezone||'Europe/Madrid',cutoff:f.cutoff,lead_business_days:Number(f.lead),holidays:split(f.holidays),countries:split(f.countries).map(v=>v.toUpperCase()),max_lines:Number(f.max_lines),max_total_cents:ctx.moneyCents(f.max_total),recurrent_sequence:cfg.recurrent_sequence||'RCUR',mode:f.mode,bank_profile_accepted:!!f.accepted,external_instructions_reviewed:!!f.external,allow_failed_oneoff_retry:!!f.oneoff}}}),{reauth:true});
    }
    if(action==='mandate'){
      await references();if(!s.accounts)s.accounts=await all('account.list');
      return form('Nuevo mandato',select('creditor','Acreedor',creditorOptions())+select('account','Cuenta bancaria',accountOptions())+select('debtor','Pagador autorizado',subjectOptions())+field('debtor_name','Nombre que figura en el mandato')+select('signer','Firmante',subjectOptions())+field('capacity','En calidad de')+select('kind','Mandato',[['recurrente','Recurrente'],['puntual','Puntual']])+field('signed','Fecha de firma','date',today())+field('from','Vigente desde','date',today())+addressFields()+
        `<details><summary>Referencia y plazo de prenotificacion</summary>${field('rum','Referencia de mandato (opcional)','text','',false)}${field('notice','Plazo acordado en dias (si distinto de 14)','number','',false)}</details><fieldset class="bankPropertySelection"><legend>Propiedades cubiertas</legend>${field('propertySearch','Filtrar propiedades','search','',false)}${button('properties-all','Seleccionar visibles')}${button('properties-none','Deseleccionar todas')}${s.properties.map(p=>`<label class="finCheck" data-bank-property="${h(p.label.toLocaleLowerCase())}"><input type="checkbox" name="property" value="${p.id}">${h(p.label)}</label>`).join('')}</fieldset>`,f=>({name:'mandate.create',payload:{creditor_id:Number(f.creditor),account_id:Number(f.account),kind:f.kind,debtor:subject(f.debtor),debtor_name:f.debtor_name,signers:[{subject:subject(f.signer),capacity:f.capacity}],signed_on:f.signed,effective_from:f.from,address:address(f),property_ids:f.properties,...(f.rum?{rum:f.rum}:{}),...(f.notice?{prenotification_agreement:{days:Number(f.notice),evidence:evidenceValue(f.evidence)}}:{})},summary:[['Pagador',f.debtor_name],['Cuenta',s.accounts.find(a=>a.id===Number(f.account))?.masked],['Propiedades',String(f.properties.length)],['Firma',f.signed]]}));
    }
    if(action==='properties-all'||action==='properties-none'){root().querySelectorAll('[data-bank-property]').forEach(row=>{if(action==='properties-none'||!row.hidden)row.querySelector('input').checked=action==='properties-all';});return;}
    if(action==='mandate-account'){
      const m=await q('mandate.edit',{id:s.detail.data.id});s.accounts=await all('account.list');
      return form('Cambiar cuenta del mandato',select('account','Nueva cuenta',accountOptions(),m.payload.account_id)+field('from','Cambio efectivo desde','date',today()),f=>({name:'mandate.amend',version:m.version,payload:{...m.payload,account_id:Number(f.account),effective_from:f.from},summary:[['Cuenta anterior',s.accounts.find(a=>a.id===m.payload.account_id)?.masked],['Nueva cuenta',s.accounts.find(a=>a.id===Number(f.account))?.masked],['Desde',f.from],['Mandato','Quedara pendiente de validar. Se conservan pagador, firmantes y propiedades.']]}));
    }
    if(action==='mandate-successor'){
      const m=s.detail.data,candidates=(await all('mandate.list')).filter(n=>n.id>m.id&&n.state==='activo');
      return form('Vincular mandato sucesor',select('successor','Nuevo mandato firmado y validado',[['','Selecciona'],...candidates.map(n=>[n.id,n.debtor_name+' · '+n.account.masked+' · '+n.signed_on])])+field('on','Fecha efectiva','date',today()),f=>({name:'mandate.succeed',version:m.version,payload:{predecessor_id:m.id,successor_id:Number(f.successor),successor_version:candidates.find(n=>n.id===Number(f.successor)).version,effective_on:f.on},summary:[['Efecto','Conservar la cadena de autorizaciones. No cambia las domiciliaciones existentes.']]}));
    }
    if(action==='mandate-state'){const m=s.detail.data;return form('Estado del mandato',select('state','Nuevo estado',[['activo','Activo'],['suspendido','Suspendido'],['revocado','Revocado'],['caducado','Caducado por inactividad']])+field('on','Fecha efectiva','date',today()),f=>({name:'mandate.transition',version:m.version,payload:{id:m.id,state:f.state,effective_on:f.on}}));}
    if(action==='domicile-state'){const d=s.domiciles.find(d=>d.id===Number(b.dataset.id)&&d.current);return form('Estado de domiciliacion',select('state','Cambio',[['suspendida','Suspender'],['finalizada','Finalizar']])+field('from','Desde','date',today()),f=>({name:'direct_debit.state',version:d.version,payload:{id:d.id,state:f.state,effective_from:f.from}}));}
    if(action==='domicile'){const m=s.detail.data;return form('Propiedades domiciliadas',field('from','Cambio efectivo desde','date',today()),f=>({special:()=>openSelection('billing',{title:'Propiedades cubiertas por el mandato',mandate:m,from:f.from,reason:f.reason,evidence:f.evidence,filters:{kind:'billing',mandate_id:m.id,on:f.from}}),immediate:true}));}
    if(action==='prepare')return form('Preparar remesa',select('creditor','Acreedor',creditorOptions())+field('requested','Fecha de cargo','date',today()),f=>({special:()=>openSelection('receipts',{title:'Seleccionar recibos',reason:f.reason,evidence:f.evidence,filters:{creditor_id:Number(f.creditor),requested_on:f.requested,...s.filters}}),immediate:true}));
    if(action==='select-visible'){s.selection.sentAck=false;s.selection.drafts=null;for(const r of s.selection.rows)if(!r.issues?.length)s.selected.set(r.id,r);render();return;}
    if(action==='deselect'){s.selection.sentAck=false;s.selection.drafts=null;s.selected.clear();render();return;}
    if(action==='notice-draft'){s.selection.drafts=(await q('notification.draft',{receipt_ids:selectedRows().map(r=>r.id),requested_on:s.selection.filters.requested_on})).drafts;render();return;}
    if(action==='copy-notice'){await navigator.clipboard.writeText(s.selection.drafts[Number(b.dataset.index)].text);return;}
    if(action==='third-party'){
      const sel=s.selection,row=sel.rows.find(r=>r.id===Number(b.dataset.id));
      return form('Autorizacion de pagador distinto',`<p class="finWarning">El mandato pertenece a un pagador distinto del recibo. Esta autorizacion solo afecta a este intento; no traslada deuda ni cambia el obligado.</p>`,f=>({immediate:true,special:()=>{sel.authorizations={...sel.authorizations,[row.id]:{mandate_id:row.mandate_id,evidence:evidenceValue(f.evidence)}};sel.sentAck=false;sel.drafts=null;s.selection=sel;render();}}));
    }
    if(action==='selection-prev'||action==='selection-next'){s.selection.offset+=action==='selection-next'?100:-100;return loadSelection();}
    if(action==='selection-review'){
      const sel=s.selection,rows=selectedRows();if(!rows.length)throw new Error('Selecciona propiedades o recibos.');
      if(sel.kind==='external'){
        s.review={title:'Confirmar instrucciones externas',content:table(['Recibo / propiedad'],rows.map(r=>[h(r.label)])),run:()=>command('external.register',{...sel.payload,receipt_ids:rows.map(r=>r.id)},null,sel.reason,sel.evidence)};render();return;
      }
      if(sel.kind==='billing'){
        const payload={mandate_id:sel.mandate.id,billing_config_ids:rows.map(r=>r.id),effective_from:sel.from,
          replacements:Object.fromEntries(rows.filter(r=>r.replacement).map(r=>[String(r.replacement.id),r.replacement.version]))};
        s.review={title:'Confirmar domiciliaciones',content:table(['Propiedad','Cambio'],rows.map(r=>[h(r.label),r.replacement?'Sustituir domiciliacion':'Nueva domiciliacion'])),run:()=>command('direct_debit.confirm',payload,sel.mandate.version,sel.reason,sel.evidence)};render();return;
      }
      const sent=root().querySelector('[name="sent_on"]').value;
      if(!root().querySelector('[name="sent_ack"]').checked)throw new Error('Confirma el envio ya realizado. Preparar un borrador no acredita que se haya enviado.');
      const notice=await command('notification.record',{sent_on:sent,lines:rows.map(r=>({receipt_id:r.id,amount_cents:r.pending_cents,requested_on:sel.filters.requested_on,mandate_id:r.mandate_id}))},null,sel.reason,sel.evidence);
      const payload={creditor_id:sel.filters.creditor_id,requested_on:sel.filters.requested_on,notification_id:notice.id,receipt_ids:rows.map(r=>r.id),retry_of:Object.fromEntries(rows.filter(r=>r.retry_of).map(r=>[String(r.id),r.retry_of])),third_party_authorizations:Object.fromEntries(rows.filter(r=>sel.authorizations?.[r.id]).map(r=>[String(r.id),sel.authorizations[r.id]]))};
      const preview=await command('remittance.preview',payload,null,sel.reason,sel.evidence);
      s.review={title:'Confirmar remesa · '+money(preview.total_cents),content:table(['Recibo','Propiedad','Importe','Intento'],rows.map(r=>[h(r.number),h(r.property_code),money(r.pending_cents),r.retry_of?'Reenvio expreso':'Primera presentacion'])),run:()=>command('remittance.prepare',{...payload,preview_hash:preview.preview_hash},null,sel.reason,sel.evidence)};render();return;
    }
    if(['build','export','present','withdraw','not-presented','cancel-local','reversal'].includes(action)){
      const rem=s.detail.data,file=rem.files.at(-1);
      const fields=action==='present'?field('date','Presentado el','date',today())+field('reference','Justificante bancario'):action==='reversal'?field('date','Fecha de solicitud','date',today()):'';
      const names={build:'remittance.build',export:'remittance.export',present:'presentation.record',withdraw:'cancellation.request','not-presented':'cancellation.not_presented','cancel-local':'remittance.cancel_local',reversal:'reversal.request'};
      return form({build:'Validar remesa',export:'Exportar fichero bancario',present:'Registrar presentacion',withdraw:'Solicitar retirada','not-presented':'Acreditar que no se ha presentado','cancel-local':'Cancelar remesa',reversal:'Solicitar inversion al banco'}[action],fields,f=>({name:names[action],version:rem.version,
        payload:action==='build'||action==='cancel-local'?{id:rem.id}:action==='reversal'?{line_id:Number(b.dataset.id),effective_on:f.date}:{file_id:file.id,...(action==='export'?{acknowledge_bank_data:true}:action==='present'?{effective_on:f.date,bank_reference:f.reference}:action==='not-presented'?{declare_not_presented:true}:{})},
        summary:[['Fecha de cargo',rem.requested_on],['Recibos',String(rem.lines.length)],['Importe',money(total(rem.lines))]],
        ...(action==='export'?{after:async result=>{await download(result.download_token);await load();}}:{})}),{reauth:action==='export'});
    }
    if(action==='permission'){const p={user_id:Number(b.dataset.user),capability:b.dataset.capability,allowed:b.dataset.allow==='1'};return form('Permiso bancario','',()=>({name:'permissions.save',version:Number(b.dataset.version),payload:p,summary:[['Operacion',p.allowed?'Conceder acceso':'Revocar acceso']]}));}
    if(action==='conflict-review'){const rem=s.detail.data;return form('Revisar contradiccion',field('on','Fecha de revision','date',today())+check('keep','Conservar los hechos economicos confirmados'),f=>({name:'conflict.review',version:rem.version,payload:{event_id:Number(b.dataset.id),effective_on:f.on,keep_economic_history:!!f.keep},summary:[['Efecto','Registrar revision. No rectifica cobros, devoluciones ni deuda.']]}));}
    if(action==='oneoff-retry'){const row=s.detail.data.lines.find(r=>r.id===Number(b.dataset.id));return form('Acreditar fallo de mandato puntual',field('on','Fecha de acreditacion','date',today()),f=>({name:'mandate.authorize_retry',version:row.mandate.version,payload:{line_id:row.id,effective_on:f.on},summary:[['Recibo',row.concept],['Efecto','Solo habilita propuesta de reenvio; no crea otra remesa ni amplia el mandato.']]}));}
    if(action==='external'){
      return form('Instrucciones externas al corte',field('source','Programa / origen')+field('reference','Referencia bancaria')+field('cutoff','Fecha de corte','date',today()),f=>({immediate:true,special:()=>openSelection('external',{title:'Seleccionar recibos con instruccion externa',reason:f.reason,evidence:f.evidence,payload:{source:f.source,reference:f.reference,cutoff_on:f.cutoff},filters:{kind:'receipts'}})}));
    }
    if(action==='external-close'){const r=s.control.external_instructions.find(r=>r.id===Number(b.dataset.id));return form('Acreditar cierre externo',field('on','Cierre efectivo','date',today()),f=>({name:'external.close',version:r.version,payload:{id:r.id,effective_on:f.on,terminal_confirmed:true},summary:[['Recibo',r.number],['Efecto','Liberar la reserva externa; no cambia deuda']]}));}
    if(action==='result-upload')return form('Importar respuesta bancaria',field('file','Archivo de respuesta (.xml)','file')+field('on','Fecha del resultado','date',today()),async(f,formNode)=>({name:'results.import',payload:{format:'pain002',effective_on:f.on,data:await fileBase64(formNode.elements.file.files[0])},after:async r=>{s.detail={type:'result',data:await q('results.get',{id:r.id})};render();},summary:[['Archivo',formNode.elements.file.files[0]?.name],['Fecha',f.on]]}));
    if(action==='result-manual'){
      const lines=s.detail?.type==='remittance'?s.detail.data.lines:[];
      return form('Resultado bancario acreditado',(lines.length?select('attempt','Recibo',lines.map(l=>[l.attempt_key,l.concept+' · '+l.debtor_name])):field('attempt','Referencia exacta de instruccion'))+select('kind','Resultado',[['technical','Acuse sin fondos'],['rejected','Rechazo'],['settlement','Cobro acreditado'],['returned','Devolucion'],['cancelled','Retirada confirmada']])+field('on','Fecha efectiva','date',today())+
        `<details><summary>Movimiento de fondos</summary>${field('amount','Importe EUR','text','',false)}${field('bank_event','Identificador de movimiento bancario','text','',false)}${field('psp','Banco emisor del resultado','text','',false)}${field('service','Servicio','text','CORE',false)}${check('funds','La evidencia acredita fondos, no es solo un acuse')}</details>`+check('terminal','El banco acredita el cierre definitivo de la instruccion'),f=>({name:'results.import',payload:{format:'manual',effective_on:f.on,data:[{attempt_key:f.attempt,kind:f.kind,effective_on:f.on,...(f.amount?{amount_cents:ctx.moneyCents(f.amount),currency:'EUR',bank_event_id:f.bank_event,psp:f.psp,service:f.service}:{}),funds_evidence:!!f.funds,terminal:!!f.terminal}]},after:async r=>{s.detail={type:'result',data:await q('results.get',{id:r.id})};render();},summary:[['Resultado',label(f.kind)],['Fecha',f.on],['Importe',f.amount||'Sin fondos acreditados']]}));
    }
    if(action==='result-line'){
      const result=s.detail.data,row=result.lines.find(r=>r.id===Number(b.dataset.id));
      if(!row.matched||row.contradictory||row.kind==='pending')return form('Aclarar resultado pendiente',field('attempt','Referencia exacta de instruccion del banco')+select('kind','Resultado acreditado',[['technical','Acuse sin fondos'],['rejected','Rechazo'],['cancelled','Retirada confirmada'],['settlement','Cobro acreditado'],['returned','Devolucion']])+field('on','Fecha efectiva','date',row.effective_on||today())+
        `<details><summary>Movimiento de fondos, cuando corresponda</summary>${field('amount','Importe EUR','text','',false)}${field('bank_event','Identificador bancario','text','',false)}${field('psp','Banco','text','',false)}${field('service','Servicio','text','CORE',false)}${check('funds','Fondos acreditados')}</details>`+check('terminal','Cierre definitivo acreditado'),async f=>{
          const instruction=await q('instruction.find',{attempt_key:f.attempt});
          return {name:'results.resolve',version:row.version,payload:{result_line_id:row.id,line_id:instruction.id,details:{kind:f.kind,effective_on:f.on,terminal:!!f.terminal,funds_evidence:!!f.funds,...(f.amount?{amount_cents:ctx.moneyCents(f.amount),currency:'EUR',bank_event_id:f.bank_event,psp:f.psp,service:f.service}:{})}},summary:[['Referencia',f.attempt],['Resultado',label(f.kind)],['Efecto','Solo aclaracion: requiere despues confirmar el resultado economico.']],after:async()=>{s.detail={type:'result',data:await q('results.get',{id:result.id})};render();}};
        });
      const options=['settlement','returned'].includes(row.kind)?await q('results.choices',{result_line_id:row.id}):{collections:[],returns:[]};const choices=options.collections;
      const actions=row.kind==='settlement'?[['record_collection','Registrar cobro'],['link_collection','Enlazar cobro existente']]:row.kind==='returned'?[['return','Devolver cobro identificado'],['link_return','Enlazar devolucion existente'],['terminal_without_collection','Cierre acreditado sin cobro identificado']]:[['none','Registrar resultado sin fondos']];
      return form('Confirmar resultado',select('action','Accion',actions)+
        (row.kind==='settlement'?field('allocate','Importe a imputar al recibo (EUR)','text','0'):'')+
        (['settlement','returned'].includes(row.kind)?select('collection','Cobro identificado',[['','Selecciona si corresponde'],...choices.map(c=>[c.id,c.effective_on+' · '+money(c.amount_cents)+' · disponible '+money(c.balance.available_cents)])],'',false):'')+
        (row.kind==='returned'?select('returned','Devolucion ya registrada',[['','Selecciona solo para enlazar'],...(options.returns||[]).map(d=>[d.id,d.effective_on+' · '+money(d.amount_cents)])],'',false)+field('free','Saldo libre devuelto (EUR)','text','0')+`<fieldset><legend>Imputaciones que revierte la devolucion</legend>${choices.flatMap(c=>c.allocations.filter(a=>BigInt(a.remaining_cents)>0n).map(a=>field('reverse_'+a.id,a.number+' · no revertido '+money(a.remaining_cents),'text','0'))).join('')}</fieldset>`:''),async f=>{
          const reversals=Object.entries(f).filter(([k])=>k.startsWith('reverse_')).map(([k,v])=>({allocation_id:Number(k.slice(8)),amount_cents:ctx.moneyCents(v)})).filter(r=>BigInt(r.amount_cents)>0n);
          const decision={result_line_id:row.id,action:f.action,...(row.kind==='settlement'?{allocate_cents:ctx.moneyCents(f.allocate)}:{}),...(f.collection?{collection_id:Number(f.collection)}:{}),...(f.action==='link_return'?{return_id:Number(f.returned)}:{}),...(f.action==='return'?{return_spec:{free_cents:ctx.moneyCents(f.free),reversals}}:{})};
          const payload={result_id:result.id,decisions:[decision]};const pv=await command('results.preview',payload,null,f.reason,f.evidence);
          return {name:'results.confirm',version:pv.version,payload:{...payload,preview_hash:pv.preview_hash},summary:[['Resultado',label(row.kind)],['Fecha',row.effective_on],['Importe',row.amount_cents?money(row.amount_cents):'Sin fondos acreditados'],['Accion',actions.find(a=>a[0]===f.action)?.[1]]]};
        });
    }
    if(action==='result-batch'){
      const result=s.detail.data,ids=[...root().querySelectorAll('[name="result_row"]:checked')].map(e=>Number(e.value));
      if(!ids.length||ids.length>200)throw new Error('Selecciona entre 1 y 200 acuses, rechazos o cierres acreditados.');
      return form('Confirmar resultados sin movimiento de fondos',table(['Fecha','Resultado'],result.lines.filter(r=>ids.includes(r.id)).map(r=>[h(r.effective_on),h(label(r.kind))])),async f=>{
        const payload={result_id:result.id,decisions:ids.map(id=>({result_line_id:id,action:'none'}))};
        const pv=await command('results.preview',payload,null,f.reason,f.evidence);
        return {name:'results.confirm',version:pv.version,payload:{...payload,preview_hash:pv.preview_hash},summary:[['Resultados seleccionados',String(ids.length)],['Efecto','No registra cobros; rechazos/cierres acreditados liberan sus reservas.']]};
      });
    }
    if(action==='import')return form('Importar cuentas observadas',field('source','Programa / origen')+field('cutoff','Fecha de corte','date',today())+field('file','Archivo Excel (.xlsx) o CSV','file')+button('paste-import','Pegar filas de Excel'),async(f,node)=>{
      const file=node.elements.file.files[0],source={file_base64:await fileBase64(file),filename:file.name};
      return {immediate:true,special:async()=>{
        const parsed=await command('import.analyze',source,null,f.reason,f.evidence);
        return importMapping(parsed,f,source);
      }};
    },{submitLabel:'Analizar columnas'});
    if(action==='paste-import')return form('Pegar cuentas observadas',field('source','Origen')+field('cutoff','Fecha de corte','date',today())+`<label>Cuentas (IBAN y referencia, separados por tabulador)<textarea name="rows" rows="7" required spellcheck="false" autocomplete="off"></textarea></label>`,f=>({name:'import.preview',payload:{source:f.source,cutoff:f.cutoff,rows:f.rows.split(/\r?\n/).filter(x=>x.trim()).map(line=>{const [iban,alias='']=line.split('\t');return {iban:iban.trim(),alias:alias.trim()};})},after:async r=>{s.detail={type:'import',data:await q('import.get',{id:r.id})};render();},summary:[['Origen',f.source],['Corte',f.cutoff],['Efecto','Solo cuentas observadas; no activa mandatos']]}));
    if(action==='import-confirm'){const imp=s.detail.data;return form('Confirmar cuentas revisadas','',()=>({name:'import.confirm',version:imp.version,payload:{id:imp.id,rows:imp.items.filter(r=>!r.issues.length).map(r=>r.row),acknowledge_observed_mandates:true},summary:[['Cuentas sin incidencias',String(imp.items.filter(r=>!r.issues.length).length)],['Mandatos','Permanecen pendientes de acreditar']]}));}
  }
  const split=v=>String(v||'').split(',').map(x=>x.trim()).filter(Boolean);
  const decimal=v=>{const cents=BigInt(v);return (cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0');};
  function importMapping(parsed,source,file){
    const options=[['','No importar'],...parsed.columns.map(c=>[c.index,c.label+(c.sample?' · '+c.sample.slice(0,60):'')])];
    form('Relacionar columnas',select('sheet_index','Hoja',parsed.sheets.map(x=>[x.index,x.label]),parsed.sheet_index)+
      select('iban','Columna de IBAN',options,'',true)+select('alias','Nombre de referencia',options,'',false)+
      select('observed_property_reference','Referencia de propiedad (observada)',options,'',false)+select('observed_payer_reference','Referencia de pagador (observada)',options,'',false)+select('observed_mandate_reference','Referencia de mandato (observada)',options,'',false),
      async f=>{
        if(Number(f.sheet_index)!==parsed.sheet_index){
          const updated=await command('import.analyze',{...file,sheet_index:Number(f.sheet_index)},null,f.reason,f.evidence);
          return {immediate:true,special:()=>importMapping(updated,source,file)};
        }
        const mapping=Object.fromEntries(['iban','alias','observed_property_reference','observed_payer_reference','observed_mandate_reference'].filter(k=>f[k]!=='').map(k=>[k,Number(f[k])]));
        return {name:'import.file_preview',payload:{source_id:parsed.source_id,mapping,source:source.source,cutoff:source.cutoff},
          after:async r=>{s.detail={type:'import',data:await q('import.get',{id:r.id})};render();},
          summary:[['Origen',source.source],['Filas',String(parsed.row_count)],['Corte',source.cutoff],['Mandatos','No se activan: requieren acreditacion']]};
      },{reason:source.reason,evidence:source.evidence,sheetChange:async index=>{
        const updated=await command('import.analyze',{...file,sheet_index:Number(index)},null,source.reason,source.evidence);
        importMapping(updated,source,file);
      }});
  }
  const mask=value=>{const v=String(value).replace(/\s/g,'');return v.length>8?v.slice(0,2)+'** **** ... '+v.slice(-4):'Cuenta por validar';};
  const addressFields=()=>field('country','Pais (ES, DE...)','text','ES')+field('town','Localidad')+field('street','Calle','text','',false)+field('building','Numero','text','',false)+field('postal','Codigo postal','text','',false);
  const address=f=>({country:f.country.toUpperCase(),town:f.town,...(f.street?{street:f.street}:{}),...(f.building?{building:f.building}:{}),...(f.postal?{postal_code:f.postal}:{})});
  async function fileBase64(file){if(!file||file.size>16*1024*1024)throw new Error('Selecciona un archivo de hasta 16 MB.');return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('No se pudo leer el archivo.'));reader.readAsDataURL(file);});}
  async function download(token){const response=await fetch('/api/erp/banking/download',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',credentials:'same-origin',body:JSON.stringify({id_comunidad:s.community,token})});if(!response.ok)throw new Error((await response.json()).error||'No se pudo descargar el fichero.');const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='remesa-sepa.xml';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function downloadDocument(documentId,reason){const response=await fetch('/api/erp/banking/document',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',credentials:'same-origin',body:JSON.stringify({id_comunidad:s.community,document_id:documentId,reason})});if(!response.ok)throw new Error((await response.json()).error||'No se pudo descargar el documento.');const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]||'documento-bancario';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function submit(formNode){
    const f=Object.fromEntries(new FormData(formNode));f.properties=[...formNode.querySelectorAll('[name="property"]:checked')].map(x=>Number(x.value));f.receipts=[...formNode.querySelectorAll('[name="receipt"]:checked')].map(x=>Number(x.value));
    const current=s.form;
    if(f.bank_document)f.evidence={type:'imported_document',id:Number(f.bank_document)};
    if(!f.evidence)throw new Error('Selecciona un documento protegido o indica la referencia de la evidencia conservada.');
    if(current.reauth){await post('reauthenticate',{password:f.password});formNode.elements.password.value='';delete f.password;}
    const built=await current.build(f,formNode);
    if(built.immediate){s.form=null;await built.special();return;}
    // Preserve edits in memory only. Raw banking inputs never use storage or query strings.
    formNode.querySelectorAll('input,select,textarea').forEach(el=>{
      if(el.type==='password'||el.type==='file')return;
      if(el.tagName==='TEXTAREA')el.textContent=el.value;
      else if(el.tagName==='SELECT')[...el.options].forEach(o=>o.toggleAttribute('selected',o.selected));
      else if(el.type==='checkbox')el.toggleAttribute('checked',el.checked);
      else el.setAttribute('value',el.value);
    });
    current.fields=formNode.querySelector('.masterFormGrid').innerHTML;current.reason=f.reason;current.evidence=formNode.elements.evidence.value;current.documentId=f.bank_document;
    const displayed=[...formNode.querySelectorAll('label')].flatMap(labelNode=>{
      const el=labelNode.querySelector('input,select,textarea');if(!el||el.type==='password'||el.type==='file'||['property','receipt','rows','reversals'].includes(el.name))return [];
      const title=[...labelNode.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ');
      const value=el.type==='checkbox'?(el.checked?'Si':'No'):el.tagName==='SELECT'?el.selectedOptions[0]?.textContent:el.name==='iban'?mask(el.value):el.value;
      return value?[[title,value]]:[];
    });
    s.review={title:current.title,content:table(['Dato','Valor'],(built.summary||displayed).map(r=>r.map(v=>h(v||'')))),
      run:built.special||(()=>command(built.name,built.payload,built.version,f.reason,f.evidence)),after:built.after};render();
  }
  function busyControls(){root().setAttribute('aria-busy',String(!!s.busy));if(s.busy)root().querySelectorAll('button:not(:disabled)').forEach(b=>{b.dataset.bankBusyDisabled='1';b.disabled=true;});
    else root().querySelectorAll('[data-bank-busy-disabled]').forEach(b=>{b.disabled=false;delete b.dataset.bankBusyDisabled;});}
  async function safe(fn){if(s.busy)return;s.busy=true;busyControls();try{await fn();}catch(error){s.error=error.message;const existing=root().querySelector('[role="alert"]');if(existing)existing.textContent=s.error;else{const alert=document.createElement('div');alert.className='finWarning';alert.setAttribute('role','alert');alert.textContent=s.error;root().prepend(alert);}}finally{s.busy=false;busyControls();}}
  function bind(){
    root().querySelectorAll('[data-bank-action]').forEach(b=>b.onclick=()=>safe(()=>chooseAction(b.dataset.bankAction,b)));
    const community=root().querySelector('[name="bankCommunity"]');if(community)community.onchange=()=>{reset();s.community=Number(community.value);load();};
    root().querySelector('[name="permissionUser"]')?.addEventListener('change',e=>{s.permissionUser=Number(e.target.value);render();});
    root().querySelector('[name="sheet_index"]')?.addEventListener('change',e=>{const f=s.form;if(f.sheetChange)safe(()=>f.sheetChange(e.target.value));});
    root().querySelector('[name="sent_ack"]')?.addEventListener('change',e=>{s.selection.sentAck=e.target.checked;});
    root().querySelector('[name="sent_on"]')?.addEventListener('input',e=>{s.selection.sentOn=e.target.value;s.selection.sentAck=false;root().querySelector('[name="sent_ack"]').checked=false;});
    root().querySelector('[name="propertySearch"]')?.addEventListener('input',e=>{const needle=e.target.value.toLocaleLowerCase();root().querySelectorAll('[data-bank-property]').forEach(r=>r.hidden=!r.dataset.bankProperty.includes(needle));});
    root().querySelectorAll('[data-bank-select]').forEach(el=>el.onchange=()=>{const id=Number(el.dataset.bankSelect);s.selection.sentAck=false;s.selection.drafts=null;if(el.checked)s.selected.set(id,s.selection.rows.find(r=>r.id===id));else s.selected.delete(id);render();});
    root().querySelector('[data-bank-form="operation"]')?.addEventListener('submit',e=>{e.preventDefault();safe(()=>submit(e.target));});
    root().querySelector('[data-bank-form="search"]')?.addEventListener('submit',e=>{e.preventDefault();s.selection.search=new FormData(e.target).get('search');s.selection.offset=0;safe(loadSelection);});
    root().querySelector('[data-bank-form="external-search"]')?.addEventListener('submit',e=>{e.preventDefault();s.externalSearch=new FormData(e.target).get('search');s.offset=0;safe(load);});
    busyControls();
  }
  return {render,reset,openReconciliation,ensure:()=>{if(s.section!=='reconciliation'&&!s.loaded&&!s.loading)load();},open:(community,filters={},scope='')=>{reset();s.community=community;s.filters=filters;s.scope=scope;s.section=filters.owner_id||filters.property_id?'mandates':'remittances';ctx.navigate();}};
}
