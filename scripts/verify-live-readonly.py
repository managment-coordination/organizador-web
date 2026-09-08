"""Local server administrator smoke test: no credentials printed or changed."""
import base64
import hashlib
import hmac
import json
from pathlib import Path
import sqlite3
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from access_control import profile

root=Path('/home/coordinador/apps/organizador-web')
secret=(root/'data/session_secret').read_text().strip().encode()
conn=sqlite3.connect(f'file:{root}/data/organizador_tareas.db?mode=ro',uri=True)
conn.row_factory=sqlite3.Row
results=[]
def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=')

for row in conn.execute('SELECT id_usuario FROM usuarios WHERE activo=1').fetchall():
    user=profile(conn,row[0])
    ready=bool(user['password_configurada'] and not user['requiere_cambio_password'] and not user['bloqueado'])
    payload=encode(json.dumps({**user,'exp':int(time.time())+60,'alcance_comunidades':'todas'}).encode())
    token=(payload+b'.'+encode(hmac.new(secret,payload,hashlib.sha256).digest())).decode()
    routes=['/api/me']
    if ready:
        routes+=['/api/security/access'] if user['rol']=='Seguridad' else ['/api/overview','/api/workflow']
        if user['rol'] not in {'Seguridad','Presidente'}:
            routes+=['/api/daily-operations','/api/assemblies','/api/reports-center']
        if user['rol']=='Superusuario':routes+=['/api/admin']
        if user['rol']!='Seguridad':
            allowed={int(c['id_comunidad']) for c in user['comunidades']}
            candidate=next((r for r in conn.execute('SELECT id_solicitud,id_comunidad,id_usuario_presidente FROM solicitudes_presidente ORDER BY id_solicitud DESC')
                if r['id_comunidad'] in allowed and (user['rol']!='Presidente' or r['id_usuario_presidente']==user['id_usuario'])),None)
            if candidate:routes+=['/api/president/request?id='+str(candidate['id_solicitud'])]
    for route in routes:
        req=urllib.request.Request('http://127.0.0.1:8771'+route,headers={'Cookie':'organizador_web_session='+token})
        try:
            with urllib.request.urlopen(req,timeout=30) as response:status=response.status
        except urllib.error.HTTPError as error:status=error.code
        assert status==(200 if ready else 401),(user['rol'],route,status)
    results.append({'role':user['rol'],'ready':ready,'routes_verified':len(routes)})
assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
print(json.dumps({'ok':True,'users':results,'integrity':'ok'}))
