import crypto from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function bankingTransport(req, config) {
  let origin;
  try { origin = new URL(config.publicOrigin); } catch { return false; }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password) return false;
  if (req.headers.host !== origin.host) return false;
  const secure = req.socket.encrypted === true || (config.trustLoopbackProxy === true &&
    LOOPBACK.has(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https');
  if (!secure) return false;
  if (req.method !== 'GET' && req.headers.origin !== origin.origin) return false;
  return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
}

export function createBankingHttp(config, services) {
  const confirmations = new Map();
  const attempts = new Map();
  const secret = crypto.randomBytes(32);
  const clock = services.clock || Date.now;
  function scope(req, session, community) {
    return crypto.createHmac('sha256', secret).update(JSON.stringify([
      session.id_usuario, session.auth_version, community, req.headers.cookie || '',
    ])).digest('hex');
  }
  function prune(map, now) {
    for (const [key, value] of map) if (value.until <= now) map.delete(key);
  }
  return async function bankingHttp(req, res, url) {
    if (!url.pathname.startsWith('/api/erp/banking/')) return false;
    const {sendJson, readSession, readBody, verifyPassword, runBanking} = services;
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const session = readSession(req);
    if (!session) { sendJson(res,401,{ok:false,error:'No autenticado.'}); return true; }
    const secure = bankingTransport(req,config);
    if (req.method === 'GET' && url.pathname.endsWith('/status')) {
      sendJson(res,200,{ok:true,available:config.enabled===true && secure,
        reason:config.enabled!==true?'La operativa bancaria no esta habilitada.':!secure?'Accede mediante la direccion HTTPS bancaria autorizada.':''});
      return true;
    }
    if (config.enabled !== true || !secure) {
      sendJson(res,403,{ok:false,error:'La operativa bancaria requiere configuracion segura y HTTPS autorizado.'}); return true;
    }
    if (req.method !== 'POST' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
      sendJson(res,405,{ok:false,error:'Operacion no admitida.'}); return true;
    }
    try {
      const body = await readBody(req,26*1024*1024);
      const community = body.id_comunidad;
      if (!Number.isSafeInteger(community) || community <= 0) throw new Error('Selecciona una comunidad.');
      if (!(session.comunidades || []).some(c=>c.id_comunidad===community)) {
        sendJson(res,403,{ok:false,error:'No tienes acceso a esta comunidad.'}); return true;
      }
      const key=scope(req,session,community), now=clock();
      prune(confirmations,now); prune(attempts,now);
      if (url.pathname.endsWith('/reauthenticate')) {
        const limiterKey=String(session.id_usuario);
        const limiter=attempts.get(limiterKey) || {count:0,until:now+15*60*1000};
        if (limiter.count>=5 || attempts.size>=10000 || confirmations.size>=10000) {
          sendJson(res,429,{ok:false,error:'Espera unos minutos antes de volver a verificar tu acceso.'}); return true;
        }
        limiter.count++; attempts.set(limiterKey,limiter);
        if (typeof body.password!=='string' || body.password.length>1024 || !await verifyPassword(session,body.password)) {
          sendJson(res,403,{ok:false,error:'No se ha podido verificar tu acceso.'}); return true;
        }
        attempts.delete(limiterKey);
        confirmations.set(key,{until:now+300000,at:new Date(now).toISOString()});
        sendJson(res,200,{ok:true,valid_for_seconds:300}); return true;
      }
      const trustedSession={...session,banking_reauthenticated_at:confirmations.get(key)?.at || null};
      const action=url.pathname.split('/').at(-1);
      if (!['query','command','download','reveal','document','statement-original'].includes(action)) {
        sendJson(res,404,{ok:false,error:'Operacion bancaria no encontrada.'}); return true;
      }
      let envelope;
      if (action==='download') envelope={id_comunidad:community,token:body.token};
      else if (action==='reveal') envelope={id_comunidad:community,account_id:body.account_id,reason:body.reason};
      else if (action==='document') envelope={id_comunidad:community,document_id:body.document_id,reason:body.reason};
      else if (action==='statement-original') envelope={id_comunidad:community,import_id:body.import_id,reason:body.reason};
      else {
        envelope={...body,id_comunidad:community};
        if (action==='command') envelope.origin='web';
        if (!['erp4.','erp5.'].some(prefix=>String(envelope[action] || '').startsWith(prefix))) {
          sendJson(res,400,{ok:false,error:'Operacion bancaria no valida.'}); return true;
        }
      }
      const result=await runBanking(trustedSession,action,envelope);
      if (action==='download' || action==='document' || action==='statement-original') {
        const bytes=Buffer.from(result.content_base64,'base64');
        const ext=action==='statement-original'&&['csv','xls','xlsx','txt','xml','json'].includes(result.extension)?result.extension:action==='document' && ['pdf','png','jpg'].includes(result.extension)?result.extension:'xml';
        res.writeHead(200,{'Content-Type':ext==='xml'?'application/xml; charset=utf-8':'application/octet-stream',
          'Content-Security-Policy':"sandbox; default-src 'none'",
          'Content-Disposition':`attachment; filename="${action==='statement-original'?'extracto-original.'+ext:ext==='xml'?'remesa-sepa.xml':'documento-bancario.'+ext}"`,'Content-Length':bytes.length});
        res.end(bytes);
      } else sendJson(res,200,result);
    } catch (error) {
      // Only classified domain messages cross this boundary; never stderr or request values.
      const safe=['ContractError','ConflictError','NotFoundError','PermissionError'].includes(error.bankErrorType);
      sendJson(res,error.bankErrorType==='PermissionError'?403:error.bankErrorType==='ConflictError'?409:400,
        {ok:false,error:safe?error.message:'No se pudo completar la operacion bancaria. Revisa los datos o vuelve a intentarlo.'});
    }
    return true;
  };
}
