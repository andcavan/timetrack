// ═══ GLOBAL APP OBJECT ═══
const App = {};

// ═══════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════
const DB_KEY='timetrack_v5';
const defaultDB={
  users:[
    {id:'u1',name:'Marco Rossi',username:'marco',role:'admin',color:'#E85D3A'},
    {id:'u2',name:'Laura Bianchi',username:'laura',role:'operator',color:'#3A7BE8'},
    {id:'u3',name:'Paolo Verdi',username:'paolo',role:'operator',color:'#2EAE6D'},
  ],
  clients:[
    {id:'c1',name:'Acme Corp',active:true,referente:'Giovanni Bianchi'},
    {id:'c2',name:'Beta Industries',active:true,referente:'Maria Rossi'},
    {id:'c3',name:'Gamma Tech',active:true,referente:'Luca Verdi'},
  ],
  projects:[
    {id:'p1',clientId:'c1',name:'Restyling Sito Web',code:'001/26',referente:'Paolo Neri',status:'active',budget:5000,budgetHours:120,deadline:'2026-09-30',
      activities:[{id:'a1',name:'Sviluppo'},{id:'a2',name:'Design'},{id:'a3',name:'Testing'}]},
    {id:'p2',clientId:'c1',name:'App Mobile',code:'002/26',referente:'Sara Bianchi',status:'active',budget:12000,budgetHours:300,deadline:'2026-12-31',
      activities:[{id:'a4',name:'Sviluppo'},{id:'a5',name:'Design'},{id:'a6',name:'Testing'},{id:'a7',name:'Deploy'}]},
    {id:'p3',clientId:'c2',name:'ERP Integration',code:'003/26',referente:'Andrea Verdi',status:'active',budget:8000,budgetHours:200,deadline:'2026-08-15',
      activities:[{id:'a8',name:'Analisi'},{id:'a9',name:'Sviluppo'},{id:'a10',name:'Testing'}]},
    {id:'p4',clientId:'c3',name:'Cloud Migration',code:'004/26',referente:'Giulia Rossi',status:'active',budget:15000,budgetHours:400,deadline:'2027-03-31',
      activities:[{id:'a11',name:'Analisi'},{id:'a12',name:'Sviluppo'},{id:'a13',name:'Deploy'},{id:'a14',name:'Riunione'}]},
  ],
  entries:[],
  rates:[
    {id:'r1',userId:null,clientId:null,projectId:null,costRate:35,clientRate:75,from:'2025-01-01',to:null},
  ],
  nextId:100,
  nextProjectNum:5
};

let db,currentUser=null,currentView='timesheet',selectedWeek,selectedDay,activeMgmt=null,mgmtProjectFilter={clientId:'',search:''};

// ═══ SUPABASE CONFIG ═══
// ⚠️ SOSTITUISCI CON I TUOI DATI SUPABASE!
const SUPABASE_URL='https://latuujorgnaksdhxazfb.supabase.co';
const SUPABASE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhdHV1am9yZ25ha3NkaHhhemZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyMDE5NzIsImV4cCI6MjA5Mzc3Nzk3Mn0.xG3LluYAsPiTdCIVYdBQk1KX70BlhTKTccIzvQ-Xz7Y';
let supa=null;
try{if(SUPABASE_URL!=='YOUR_SUPABASE_URL_HERE')supa=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY)}catch(e){console.error(e)}

let syncTimer=null;
function updateSyncStatus(status){
  const el=document.getElementById('sync-status');
  if(!el)return;
  const colors={ok:'#2EAE6D',sync:'#E8A33A',err:'#E85A4F',off:'#888'};
  const labels={ok:'✓ Sincronizzato',sync:'⟳ Sincronizzazione...',err:'✗ Errore sync',off:'○ Offline (locale)'};
  el.style.background=colors[status];
  el.innerHTML=labels[status];
}

function migrateDB(){
  if(!db)return;
  if(!db.rates)db.rates=[];
  // Rimuove campi tariffa obsoleti da users/clients se presenti da versioni precedenti
  db.users?.forEach(u=>{delete u.hourlyRate});
  db.clients?.forEach(c=>{delete c.clientRate});
  db.users?.forEach(u=>{if(u.active===undefined)u.active=true});
}
async function loadDB(){
  // Sempre prima dal localStorage per partenza veloce
  let hasLocal=false;
  let hasPendingLocal=false;
  try{
    const r=localStorage.getItem(DB_KEY);
    if(r){db=JSON.parse(r);hasLocal=true;migrateDB()}
    hasPendingLocal=localStorage.getItem(DB_KEY+'_pending')==='1';
  }catch(e){}
  
  if(supa){
    updateSyncStatus('sync');
    try{
      const {data,error}=await supa.from('timetrack_data').select('data,updated_at').eq('id',1).single();
      if(error&&error.code==='PGRST116'){
        // Nessun record nel cloud, crea il default (o usa locale se presente)
        if(!hasLocal)db=JSON.parse(JSON.stringify(defaultDB));
        const {data:newData}=await supa.from('timetrack_data').insert({id:1,data:db}).select().single();
        if(newData)lastUpdate=newData.updated_at;
        localStorage.setItem(DB_KEY,JSON.stringify(db));
        localStorage.removeItem(DB_KEY+'_pending');
      }else if(data&&data.data){
        // C'è un record nel cloud
        if(hasPendingLocal&&hasLocal){
          // Avevamo modifiche locali non sincronizzate!
          // Controlla se i dati locali sono più recenti
          const cloudTime=new Date(data.updated_at).getTime();
          const localTime=parseInt(localStorage.getItem(DB_KEY+'_savedAt')||'0');
          if(localTime>cloudTime){
            // Dati locali più recenti: pusha al cloud
            console.log('Pushing pending local changes to cloud');
            const {data:upd}=await supa.from('timetrack_data').upsert({id:1,data:db,updated_at:new Date().toISOString()}).select().single();
            if(upd)lastUpdate=upd.updated_at;
            localStorage.removeItem(DB_KEY+'_pending');
            showToast('Modifiche locali sincronizzate!');
          }else{
            // Cloud più recente: prendi cloud (perdiamo modifiche locali)
            db=data.data;
            lastUpdate=data.updated_at;
            migrateDB();
            localStorage.setItem(DB_KEY,JSON.stringify(db));
            localStorage.removeItem(DB_KEY+'_pending');
          }
        }else{
          // Caso normale: usa cloud
          db=data.data;
          lastUpdate=data.updated_at;
          migrateDB();
          localStorage.setItem(DB_KEY,JSON.stringify(db));
        }
      }
      updateSyncStatus('ok');
      pendingSync=false;
      startRealtimeSubscription();
      startPolling();
    }catch(e){
      console.error('Errore load Supabase:',e);
      updateSyncStatus('err');
      if(!db||!db.users)db=JSON.parse(JSON.stringify(defaultDB));
      // Se eravamo offline e abbiamo pending, mantieni il flag
      if(hasPendingLocal)pendingSync=true;
    }
  }else{
    // Fallback: solo localStorage
    if(!db||!db.users){db=JSON.parse(JSON.stringify(defaultDB));localStorage.setItem(DB_KEY,JSON.stringify(db))}
    updateSyncStatus('off');
  }
}

let isSavingLocal=false; // flag per ignorare echo delle nostre modifiche
let pendingSync=false; // true se ci sono modifiche non ancora confermate dal cloud
function saveDB(){
  // Salva sempre subito in localStorage per velocità
  localStorage.setItem(DB_KEY,JSON.stringify(db));
  localStorage.setItem(DB_KEY+'_savedAt',Date.now().toString());
  // Marca che ci sono dati pending
  localStorage.setItem(DB_KEY+'_pending','1');
  pendingSync=true;
  
  if(supa){
    // Debounce: aspetta 600ms prima di sincronizzare
    if(syncTimer)clearTimeout(syncTimer);
    updateSyncStatus('sync');
    syncTimer=setTimeout(async()=>{
      try{
        isSavingLocal=true;
        const {data,error}=await supa.from('timetrack_data').upsert({id:1,data:db,updated_at:new Date().toISOString()}).select().single();
        if(error)throw error;
        if(data)lastUpdate=data.updated_at;
        // Sync confermato: rimuovi flag pending
        localStorage.removeItem(DB_KEY+'_pending');
        pendingSync=false;
        updateSyncStatus('ok');
        setTimeout(()=>{isSavingLocal=false},800);
      }catch(e){
        console.error('Errore save Supabase:',e);
        updateSyncStatus('err');
        isSavingLocal=false;
        // pendingSync resta true: ritenteremo
      }
    },600);
  }
}

// Sync immediato (senza debounce) - per chiusura pagina o recupero dati
async function syncNow(){
  if(!supa||!pendingSync)return;
  if(syncTimer){clearTimeout(syncTimer);syncTimer=null}
  try{
    const {data,error}=await supa.from('timetrack_data').upsert({id:1,data:db,updated_at:new Date().toISOString()}).select().single();
    if(error)throw error;
    if(data)lastUpdate=data.updated_at;
    localStorage.removeItem(DB_KEY+'_pending');
    pendingSync=false;
    updateSyncStatus('ok');
  }catch(e){
    console.error('Errore syncNow:',e);
    updateSyncStatus('err');
  }
}

// Avviso prima di chiudere se ci sono modifiche non sincronizzate
window.addEventListener('beforeunload',e=>{
  if(pendingSync){
    // Tenta sync immediato (best effort, asincrono)
    syncNow();
    e.preventDefault();
    e.returnValue='Ci sono modifiche non ancora salvate sul cloud. Sicuro di voler chiudere?';
    return e.returnValue;
  }
});

// Quando torna online, sincronizza
window.addEventListener('online',()=>{
  if(pendingSync){
    showToast('Connessione tornata, sincronizzo...');
    syncNow();
  }
});

// Re-render della view corrente
function rerenderCurrent(){
  if(document.querySelector('.modal-backdrop'))return; // non disturbare modal aperti
  if(!currentUser)return;
  if(activeView==='timesheet')renderTimesheet();
  else if(activeView==='report')renderReport();
  else if(activeView==='projects')renderProjectReport();
  else if(activeView==='manage')renderManage();
}

// Applica nuovi dati ricevuti dal cloud
function applyRemoteData(newData,newUpdate){
  if(isSavingLocal)return; // ignora echo delle nostre modifiche
  if(lastUpdate===newUpdate)return; // stesso aggiornamento già processato
  db=newData;
  lastUpdate=newUpdate;
  localStorage.setItem(DB_KEY,JSON.stringify(db));
  rerenderCurrent();
  // Mostra notifica discreta
  const el=document.getElementById('sync-status');
  if(el){
    el.style.background='#3A7BE8';
    el.innerHTML='↓ Aggiornato da altri';
    setTimeout(()=>{updateSyncStatus('ok')},1800);
  }
}

// Sottoscrizione realtime (WebSocket - istantaneo)
let realtimeChannel=null;
function startRealtimeSubscription(){
  if(!supa)return;
  if(realtimeChannel){supa.removeChannel(realtimeChannel)}
  realtimeChannel=supa.channel('timetrack_changes')
    .on('postgres_changes',{event:'*',schema:'public',table:'timetrack_data'},payload=>{
      if(payload.new&&payload.new.data&&payload.new.updated_at){
        applyRemoteData(payload.new.data,payload.new.updated_at);
      }
    })
    .subscribe();
}

// Polling come fallback (ogni 3 secondi)
let pollTimer=null;
let lastUpdate=null;
function startPolling(){
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(async()=>{
    if(!supa||isSavingLocal)return;
    try{
      const {data,error}=await supa.from('timetrack_data').select('updated_at,data').eq('id',1).single();
      if(error||!data)return;
      if(data.updated_at!==lastUpdate){
        applyRemoteData(data.data,data.updated_at);
      }
    }catch(e){console.error('Polling err:',e)}
  },3000);
}
function todayStr(){return new Date().toISOString().split('T')[0]}
function fmtDate(d){if(!d)return'—';const[y,m,dd]=d.split('-');return`${dd}/${m}/${y}`}
function getWeekStart(d){const dt=new Date(d);const day=dt.getDay();const diff=dt.getDate()-day+(day===0?-6:1);return new Date(dt.setDate(diff)).toISOString().split('T')[0]}
function getWeekDays(s){const d=[];for(let i=0;i<7;i++){const x=new Date(s);x.setDate(x.getDate()+i);d.push(x.toISOString().split('T')[0])}return d}
const DN=['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
function showToast(m,t='success'){const el=document.getElementById('toast');el.textContent=m;el.style.background=t==='error'?'var(--red)':'var(--green)';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2500)}
function _a(){return currentUser&&currentUser.role==='admin'}
function isProjectVisible(proj){if(_a())return true;const au=proj.assignedUsers;if(!au||au.length===0)return true;return au.includes(currentUser.id)}
function gid(){return'id'+(db.nextId++)}
function openModal(h){document.getElementById('modal-root').innerHTML=`<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal">${h}</div></div>`}
function closeModal(){document.getElementById('modal-root').innerHTML=''}

// ═══ LOGIN ═══
// ═══ AUTH (password hashing) ═══
async function hashPassword(pwd){
  const enc=new TextEncoder().encode(pwd+'_timetrack_salt_2026');
  const buf=await crypto.subtle.digest('SHA-256',enc);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

let pendingLoginUserId=null;
function renderLogin(){
  document.getElementById('login-users').innerHTML=db.users.filter(u=>u.active!==false).map(u=>`<button class="login-btn" style="border-left-color:${u.color}" onclick="loginAs('${u.id}')"><span class="name">${u.username||u.name}</span><span class="role">${u.role==='admin'?'Admin':'Operatore'}</span>${!u.passwordHash?'<span class="role" style="color:var(--orange)">⚠ No password</span>':''}</button>`).join('');
}
async function loginAs(uid){
  const user=db.users.find(u=>u.id===uid);
  if(!user)return;
  if(user.active===false){showToast('Account sospeso. Contatta un amministratore.','error');return}

  // Se l'utente non ha ancora una password, chiedi di crearla
  if(!user.passwordHash){
    showPasswordModal(uid,'create');
    return;
  }
  
  // Altrimenti chiedi la password
  showPasswordModal(uid,'login');
}

function showPasswordModal(uid,mode){
  pendingLoginUserId=uid;
  const user=db.users.find(u=>u.id===uid);
  const isCreate=mode==='create';
  const title=isCreate?`Imposta password per ${user.username||user.name}`:`Accesso: ${user.username||user.name}`;
  const subtitle=isCreate?'Prima volta? Crea la tua password personale (verrà richiesta nei prossimi accessi)':'Inserisci la tua password';
  const html=`<div class="modal-backdrop" onclick="if(event.target===this)closePwdModal()"><div class="modal" style="max-width:400px">
    <h3 style="margin:0 0 8px;color:var(--accent)">${title}</h3>
    <p style="margin:0 0 20px;color:var(--text-dim);font-size:13px">${subtitle}</p>
    <div style="display:flex;flex-direction:column;gap:12px">
      <input type="password" id="pwd-input" placeholder="Password" autocomplete="${isCreate?'new-password':'current-password'}" onkeydown="if(event.key==='Enter')submitPwd()" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
      ${isCreate?'<input type="password" id="pwd-confirm" placeholder="Conferma password" autocomplete="new-password" onkeydown="if(event.key===\'Enter\')submitPwd()" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">':''}
      <div id="pwd-error" style="color:var(--red);font-size:13px;display:none"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn-ghost" onclick="closePwdModal()">Annulla</button>
        <button class="btn-primary" onclick="submitPwd()">${isCreate?'Crea password':'Accedi'}</button>
      </div>
    </div>
  </div></div>`;
  document.body.insertAdjacentHTML('beforeend',html);
  setTimeout(()=>document.getElementById('pwd-input')?.focus(),50);
}

function closePwdModal(){
  document.querySelector('.modal-backdrop')?.remove();
  pendingLoginUserId=null;
}

async function submitPwd(){
  const user=db.users.find(u=>u.id===pendingLoginUserId);
  if(!user)return;
  if(user.active===false){const e=document.getElementById('pwd-error');e.textContent='Account sospeso.';e.style.display='block';return}
  const pwdInput=document.getElementById('pwd-input');
  const pwd=pwdInput.value;
  const errEl=document.getElementById('pwd-error');
  
  if(!pwd||pwd.length<4){
    errEl.textContent='Password troppo corta (min 4 caratteri)';
    errEl.style.display='block';
    return;
  }
  
  if(!user.passwordHash){
    // Modalità creazione password
    const confirm=document.getElementById('pwd-confirm').value;
    if(pwd!==confirm){
      errEl.textContent='Le password non coincidono';
      errEl.style.display='block';
      return;
    }
    user.passwordHash=await hashPassword(pwd);
    saveDB();
    closePwdModal();
    doLogin(user);
  }else{
    // Modalità accesso
    const hash=await hashPassword(pwd);
    if(hash!==user.passwordHash){
      errEl.textContent='Password errata';
      errEl.style.display='block';
      pwdInput.value='';
      pwdInput.focus();
      return;
    }
    closePwdModal();
    doLogin(user);
  }
}

function doLogin(user){
  currentUser=user;
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app-header').style.display='flex';
  document.getElementById('app-main').style.display='block';
  renderHeader();setView('timesheet');
}

function logout(){
  currentUser=null;
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('app-header').style.display='none';
  document.getElementById('app-main').style.display='none';
  renderLogin();
}

// Cambio password (richiamabile dall'header)
function changePassword(){
  if(!currentUser)return;
  const html=`<div class="modal-backdrop" onclick="if(event.target===this)closePwdModal()"><div class="modal" style="max-width:400px">
    <h3 style="margin:0 0 20px;color:var(--accent)">Cambia password</h3>
    <div style="display:flex;flex-direction:column;gap:12px">
      <input type="password" id="cp-old" placeholder="Password attuale" autocomplete="current-password" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
      <input type="password" id="cp-new" placeholder="Nuova password" autocomplete="new-password" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
      <input type="password" id="cp-confirm" placeholder="Conferma nuova password" autocomplete="new-password" onkeydown="if(event.key==='Enter')submitChangePwd()" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
      <div id="cp-error" style="color:var(--red);font-size:13px;display:none"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn-ghost" onclick="closePwdModal()">Annulla</button>
        <button class="btn-primary" onclick="submitChangePwd()">Cambia</button>
      </div>
    </div>
  </div></div>`;
  document.body.insertAdjacentHTML('beforeend',html);
  setTimeout(()=>document.getElementById('cp-old')?.focus(),50);
}

async function submitChangePwd(){
  const oldPwd=document.getElementById('cp-old').value;
  const newPwd=document.getElementById('cp-new').value;
  const conf=document.getElementById('cp-confirm').value;
  const err=document.getElementById('cp-error');
  
  const oldHash=await hashPassword(oldPwd);
  if(oldHash!==currentUser.passwordHash){
    err.textContent='Password attuale errata';err.style.display='block';return;
  }
  if(newPwd.length<4){
    err.textContent='Nuova password troppo corta (min 4 caratteri)';err.style.display='block';return;
  }
  if(newPwd!==conf){
    err.textContent='Le password non coincidono';err.style.display='block';return;
  }
  
  currentUser.passwordHash=await hashPassword(newPwd);
  // Aggiorna anche nel db
  const u=db.users.find(x=>x.id===currentUser.id);
  if(u)u.passwordHash=currentUser.passwordHash;
  saveDB();
  closePwdModal();
  showToast('Password cambiata!');
}

// Reset password (solo admin)
async function resetUserPassword(uid){
  if(!_a())return;
  if(!confirm('Resettare la password di questo utente? Dovrà crearne una nuova al prossimo accesso.'))return;
  const u=db.users.find(x=>x.id===uid);
  if(!u)return;
  delete u.passwordHash;
  saveDB();
  renderManage();
  showToast('Password resettata');
}

// ═══ HEADER ═══
function renderHeader(){
  const pill=document.getElementById('user-pill');
  pill.style.borderColor=currentUser.color;
  pill.innerHTML=`<span class="user-dot" style="background:${currentUser.color}"></span>${currentUser.name.split(' ')[0]}`;
  const tabs=[{id:'timesheet',label:'Ore',icon:'📅'},{id:'dashboard',label:'Report',icon:'📊'},{id:'projects',label:'Commesse',icon:'📋'}];
  if(_a())tabs.push({id:'manage',label:'Gestione',icon:'⚙'});
  document.getElementById('main-nav').innerHTML=tabs.map(t=>`<button class="nav-btn ${currentView===t.id?'active':''}" onclick="setView('${t.id}')">${t.icon} ${t.label}</button>`).join('');
}
function setView(v){
  currentView=v;document.querySelectorAll('.view-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('view-'+v)?.classList.add('active');renderHeader();
  ({timesheet:renderTimesheet,dashboard:renderDashboard,projects:renderProjectReport,manage:renderManage})[v]?.();
}

// ═══ TIMESHEET ═══
function renderTimesheet(){
  selectedWeek=selectedWeek||getWeekStart(todayStr());
  document.getElementById('qe-project-search').value='';
  document.getElementById('qe-project').value='';
  if(!document.getElementById('qe-date').value)document.getElementById('qe-date').value=todayStr();
  selectedDay=document.getElementById('qe-date').value;
  renderQH();renderWeek();
}
function onQeProjectChange3(){
  const pid=document.getElementById('qe-project').value;
  const clientDisp=document.getElementById('qe-client-display');
  const as=document.getElementById('qe-activity');
  if(!pid){clientDisp.value='';as.innerHTML='<option value="">—</option>';as.disabled=true;return}
  const proj=db.projects.find(p=>p.id===pid);
  if(!proj){clientDisp.value='';as.innerHTML='<option value="">—</option>';as.disabled=true;return}
  const cl=db.clients.find(c=>c.id===proj.clientId);
  clientDisp.value=cl?.name||'?';
  if(!proj.activities?.length){as.innerHTML='<option value="">Nessuna attività</option>';as.disabled=true;return}
  as.disabled=false;as.innerHTML='<option value="">— Seleziona —</option>'+proj.activities.map(a=>`<option value="${a.id}">${a.name}</option>`).join('');
}
function renderQH(){
  const cur=parseFloat(document.getElementById('qe-hours').value);
  document.getElementById('quick-hours').innerHTML=[1,2,4,6,8].map(h=>`<button class="qh-btn ${cur===h?'active':''}" onclick="document.getElementById('qe-hours').value=${h};renderQH()">${h}h</button>`).join('');
}
function filterProjects(){
  const q=document.getElementById('qe-project-search').value.toLowerCase();
  const dd=document.getElementById('qe-project-dropdown');
  const projs=db.projects.filter(p=>p.status==='active'&&isProjectVisible(p));
  const matches=q?projs.filter(p=>{const cl=db.clients.find(c=>c.id===p.clientId);return(p.code+' '+p.name+' '+(cl?.name||'')).toLowerCase().includes(q);}):projs;
  if(!matches.length){dd.innerHTML='<div class="project-dropdown-item" style="color:var(--text-dim)">Nessun risultato</div>';dd.style.display='block';return}
  dd.innerHTML=matches.map(p=>{const cl=db.clients.find(c=>c.id===p.clientId);return`<div class="project-dropdown-item" onmousedown="selectProject('${p.id}','${(p.code+' - '+p.name).replace(/'/g,"\\'")}')"><span class="proj-code">${p.code}</span>${p.name}<div class="proj-client">${cl?.name||''}</div></div>`;}).join('');
  dd.style.display='block';
}
function hideProjectDropdown(){setTimeout(()=>{const dd=document.getElementById('qe-project-dropdown');if(dd)dd.style.display='none';},150)}
function selectProject(id,label){
  document.getElementById('qe-project').value=id;
  document.getElementById('qe-project-search').value=label;
  document.getElementById('qe-project-dropdown').style.display='none';
  onQeProjectChange3();
}
function resolveRate(userId,clientId,projectId,date){
  const rates=db.rates||[];
  const active=rates.filter(r=>r.from<=date&&(r.to===null||r.to>=date));
  const priority=[
    r=>r.userId===userId&&r.projectId===projectId&&r.clientId===null,
    r=>r.userId===userId&&r.clientId===clientId&&r.projectId===null,
    r=>r.userId===null&&r.projectId===projectId&&r.clientId===null,
    r=>r.userId===userId&&r.clientId===null&&r.projectId===null,
    r=>r.userId===null&&r.clientId===clientId&&r.projectId===null,
    r=>r.userId===null&&r.clientId===null&&r.projectId===null,
  ];
  let costRate=0,clientRate=0,costFound=false,clientFound=false;
  for(const match of priority){
    const candidates=active.filter(match).sort((a,b)=>b.from.localeCompare(a.from));
    for(const c of candidates){
      if(!costFound&&c.costRate!=null){costRate=c.costRate;costFound=true}
      if(!clientFound&&c.clientRate!=null){clientRate=c.clientRate;clientFound=true}
    }
    if(costFound&&clientFound)break;
  }
  return{costRate,clientRate};
}
function addEntry(){
  const projectId=document.getElementById('qe-project').value;
  const activityId=document.getElementById('qe-activity').value;
  const date=document.getElementById('qe-date').value;
  const hours=parseFloat(document.getElementById('qe-hours').value);
  const note=document.getElementById('qe-note').value;
  if(!projectId||!activityId||!date||!hours){showToast('Compila tutti i campi','error');return}
  if(isNaN(hours)||hours<=0||hours>24){showToast('Ore non valide','error');return}
  const proj=db.projects.find(p=>p.id===projectId);
  if(!proj){showToast('Commessa non valida','error');return}
  const r=resolveRate(currentUser.id,proj.clientId,projectId,date);
  db.entries.push({id:gid(),userId:currentUser.id,clientId:proj.clientId,projectId,activityId,date,hours,note:note||'',costRate:r.costRate,clientRate:r.clientRate,createdAt:new Date().toISOString()});
  saveDB();document.getElementById('qe-hours').value='';document.getElementById('qe-note').value='';
  showToast(`${hours}h registrate!`);renderQH();renderWeek();
}

// ═══ WEEK ═══
function changeWeek(dir){const d=new Date(selectedWeek);d.setDate(d.getDate()+dir*7);selectedWeek=d.toISOString().split('T')[0];renderWeek()}
function goToday(){selectedWeek=getWeekStart(todayStr());renderWeek()}
function selectDay(date){selectedDay=date;document.getElementById('qe-date').value=date;renderWeek()}
function renderWeek(){
  const days=getWeekDays(selectedWeek);
  document.getElementById('week-label').textContent=fmtDate(days[0])+' — '+fmtDate(days[6]);
  const entries=db.entries.filter(e=>days.includes(e.date)&&(_a()||e.userId===currentUser.id));
  document.getElementById('week-total').textContent=entries.reduce((s,e)=>s+e.hours,0).toFixed(1)+'h';
  const td=todayStr();
  document.getElementById('week-grid').innerHTML=days.map((d,i)=>{
    const de=entries.filter(e=>e.date===d),dh=de.reduce((s,e)=>s+e.hours,0);
    return`<div class="day-col ${d===td?'today':''} ${d===selectedDay?'selected':''}" onclick="selectDay('${d}')"><div class="day-header"><span class="day-name">${DN[i]}</span><span class="day-date">${d.split('-')[2]}</span>${dh>0?`<span class="day-hours">${dh}h</span>`:''}</div><div class="day-entries">${de.map(renderCard).join('')}</div></div>`;
  }).join('');
}
function renderCard(e){
  const cl=db.clients.find(c=>c.id===e.clientId),pr=db.projects.find(p=>p.id===e.projectId),ac=pr?.activities?.find(a=>a.id===e.activityId),usr=db.users.find(u=>u.id===e.userId),can=_a()||e.userId===currentUser.id,showU=_a()&&e.userId!==currentUser.id;
  return`<div class="entry-card" style="border-left-color:${usr?.color||'#888'}"><div class="entry-hours">${e.hours}h</div><div class="entry-client">${cl?.name||'?'}</div><div class="entry-project">${pr?.name||'?'}</div><div class="entry-activity">${ac?.name||'?'}</div>${showU?`<div class="entry-user">${usr?.name?.split(' ')[0]}</div>`:''}${e.note?`<div class="entry-note">${e.note}</div>`:''}${can?`<div class="entry-actions"><button class="mini-btn" data-action="edit-entry" data-id="${e.id}">✏</button><button class="mini-btn danger" data-action="delete-entry" data-id="${e.id}">🗑</button></div>`:''}</div>`;
}

// Add global event delegation for all buttons with data-action
document.addEventListener('click', function(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const pid = btn.dataset.pid;
  const aid = btn.dataset.aid;
  
  switch(action) {
    case 'delete-entry': delEntry(id); break;
    case 'edit-entry': editEntryModal(id); break;
    case 'delete-client': delClient(id); break;
    case 'edit-client': editClientModal(id); break;
    case 'delete-project': delProject(id); break;
    case 'edit-project': editProjectModal(id); break;
    case 'delete-activity': delAct(pid, aid); break;
    case 'edit-activity': editActModal(pid, aid); break;
    case 'delete-user': delUser(id); break;
    case 'reset-pwd': resetUserPassword(id); break;
    case 'edit-user': editUserModal(id); break;
    case 'toggle-user-active': toggleUserActive(id); break;
    case 'edit-rate': editRateModal(id); break;
    case 'delete-rate': delRate(id); break;
  }
});
function editEntryModal(id){
  const e=db.entries.find(x=>x.id===id);if(!e)return;
  const pr=db.projects.find(p=>p.id===e.projectId),acts=pr?.activities||[];
  // Build full cascade for client/project change
  const clients=db.clients.filter(c=>c.active);
  const projects=db.projects.filter(p=>p.clientId===e.clientId&&p.status==='active');
  openModal(`<h3>✏ Modifica Registrazione</h3>
    <div class="modal-field"><label>Cliente</label><select id="me-client" onchange="onEditClientChange()">
      ${clients.map(c=>`<option value="${c.id}" ${c.id===e.clientId?'selected':''}>${c.name}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Commessa</label><select id="me-project" onchange="onEditProjectChange()">
      ${projects.map(p=>`<option value="${p.id}" ${p.id===e.projectId?'selected':''}>${p.name}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Attività</label><select id="me-activity">
      ${acts.map(a=>`<option value="${a.id}" ${a.id===e.activityId?'selected':''}>${a.name}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Data</label><input type="date" id="me-date" value="${e.date}"></div>
    <div class="modal-field"><label>Ore</label><input type="number" id="me-hours" value="${e.hours}" min="0.25" max="24" step="0.25"></div>
    <div class="modal-field"><label>Nota</label><input type="text" id="me-note" value="${e.note||''}"></div>
    <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveEntryEdit('${id}')">Salva</button></div>`);
}
function onEditClientChange(){
  const cid=document.getElementById('me-client').value;
  const ps=document.getElementById('me-project');
  const projs=db.projects.filter(p=>p.clientId===cid&&p.status==='active');
  ps.innerHTML=projs.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  onEditProjectChange();
}
function onEditProjectChange(){
  const pid=document.getElementById('me-project').value;
  const as=document.getElementById('me-activity');
  const proj=db.projects.find(p=>p.id===pid);
  const acts=proj?.activities||[];
  as.innerHTML=acts.map(a=>`<option value="${a.id}">${a.name}</option>`).join('');
}
function saveEntryEdit(id){
  const e=db.entries.find(x=>x.id===id);if(!e)return;
  const h=parseFloat(document.getElementById('me-hours').value);
  if(isNaN(h)||h<=0||h>24){showToast('Ore non valide','error');return}
  e.clientId=document.getElementById('me-client').value;
  e.projectId=document.getElementById('me-project').value;
  e.activityId=document.getElementById('me-activity').value;
  e.date=document.getElementById('me-date').value;
  e.hours=h;e.note=document.getElementById('me-note').value;
  saveDB();closeModal();showToast('Aggiornata');renderWeek();
}
function delEntry(id){if(!confirm('Eliminare questa registrazione?'))return;db.entries=db.entries.filter(e=>e.id!==id);saveDB();showToast('Rimossa');renderWeek()}

// ═══ DASHBOARD ═══
// ═══ DASHBOARD FILTERS ═══
let reportFilters={
  period:'current-month',
  dateFrom:null,
  dateTo:null,
  clientId:null,
  projectId:null,
  userId:null
};

function onFilterChange(){
  const period=document.getElementById('filter-period').value;
  const customDates=document.getElementById('custom-dates');
  if(period==='custom'){
    customDates.style.display='grid';
  }else{
    customDates.style.display='none';
  }
}

function applyFilters(){
  reportFilters.period=document.getElementById('filter-period').value;
  reportFilters.dateFrom=document.getElementById('filter-from').value||null;
  reportFilters.dateTo=document.getElementById('filter-to').value||null;
  reportFilters.clientId=document.getElementById('filter-client').value||null;
  reportFilters.projectId=document.getElementById('filter-project').value||null;
  reportFilters.userId=document.getElementById('filter-user').value||null;
  renderDashboard();
}

function resetFilters(){
  reportFilters={period:'current-month',dateFrom:null,dateTo:null,clientId:null,projectId:null,userId:null};
  document.getElementById('filter-period').value='current-month';
  document.getElementById('filter-from').value='';
  document.getElementById('filter-to').value='';
  document.getElementById('filter-client').value='';
  document.getElementById('filter-project').value='';
  document.getElementById('filter-user').value='';
  document.getElementById('custom-dates').style.display='none';
  renderDashboard();
}

function getFilteredEntries(){
  let ents=db.entries.filter(e=>_a()||e.userId===currentUser.id);
  
  // Filtro periodo
  let fromDate,toDate;
  if(reportFilters.period==='current-month'){
    const now=new Date();
    fromDate=new Date(now.getFullYear(),now.getMonth(),1).toISOString().slice(0,10);
    toDate=new Date(now.getFullYear(),now.getMonth()+1,0).toISOString().slice(0,10);
  }else if(reportFilters.period==='last-month'){
    const now=new Date();
    fromDate=new Date(now.getFullYear(),now.getMonth()-1,1).toISOString().slice(0,10);
    toDate=new Date(now.getFullYear(),now.getMonth(),0).toISOString().slice(0,10);
  }else if(reportFilters.period==='current-year'){
    const now=new Date();
    fromDate=new Date(now.getFullYear(),0,1).toISOString().slice(0,10);
    toDate=new Date(now.getFullYear(),11,31).toISOString().slice(0,10);
  }else if(reportFilters.period==='last-year'){
    const now=new Date();
    fromDate=new Date(now.getFullYear()-1,0,1).toISOString().slice(0,10);
    toDate=new Date(now.getFullYear()-1,11,31).toISOString().slice(0,10);
  }else if(reportFilters.period==='custom'){
    fromDate=reportFilters.dateFrom;
    toDate=reportFilters.dateTo;
  }
  
  if(fromDate)ents=ents.filter(e=>e.date>=fromDate);
  if(toDate)ents=ents.filter(e=>e.date<=toDate);
  
  // Filtro cliente
  if(reportFilters.clientId)ents=ents.filter(e=>e.clientId===reportFilters.clientId);
  
  // Filtro commessa
  if(reportFilters.projectId)ents=ents.filter(e=>e.projectId===reportFilters.projectId);
  
  // Filtro utente (solo admin)
  if(_a()&&reportFilters.userId)ents=ents.filter(e=>e.userId===reportFilters.userId);
  
  return ents;
}

function updateFilterSummary(ents){
  const el=document.getElementById('filter-summary');
  if(!el)return;
  const total=db.entries.filter(e=>_a()||e.userId===currentUser.id).length;
  el.innerHTML=`${ents.length} di ${total} registrazioni`;
}

function renderDashboard(){
  // Popola i filtri
  const filterClient=document.getElementById('filter-client');
  if(filterClient){
    filterClient.innerHTML='<option value="">Tutti i clienti</option>'+db.clients.map(c=>`<option value="${c.id}" ${reportFilters.clientId===c.id?'selected':''}>${c.name}</option>`).join('');
  }
  
  const filterProject=document.getElementById('filter-project');
  if(filterProject){
    filterProject.innerHTML='<option value="">Tutte le commesse</option>'+db.projects.filter(p=>isProjectVisible(p)).map(p=>{
      const cl=db.clients.find(c=>c.id===p.clientId);
      return`<option value="${p.id}" ${reportFilters.projectId===p.id?'selected':''}>${p.code} - ${p.name} (${cl?.name||'?'})</option>`;
    }).join('');
  }
  
  const filterUser=document.getElementById('filter-user');
  if(filterUser&&_a()){
    filterUser.innerHTML='<option value="">Tutti gli utenti</option>'+db.users.map(u=>`<option value="${u.id}" ${reportFilters.userId===u.id?'selected':''}>${u.name}</option>`).join('');
    filterUser.parentElement.style.display='block';
  }else if(filterUser){
    filterUser.parentElement.style.display='none';
  }
  
  // Applica filtri
  const ents=getFilteredEntries();
  updateFilterSummary(ents);
  
  const tH=ents.reduce((s,e)=>s+e.hours,0),tC=ents.reduce((s,e)=>s+e.hours*e.costRate,0),tR=ents.reduce((s,e)=>s+e.hours*e.clientRate,0),mg=tR-tC;
  const kpis=[{l:'Ore Totali',v:tH.toFixed(1)+'h',c:'var(--accent)'}];
  if(_a()){kpis.push({l:'Costo Interno',v:'€'+tC.toFixed(0),c:'var(--red)'},{l:'Ricavo Cliente',v:'€'+tR.toFixed(0),c:'var(--green)'},{l:'Margine',v:'€'+mg.toFixed(0),c:mg>=0?'var(--green)':'var(--red)'})}
  document.getElementById('kpi-row').innerHTML=kpis.map(k=>`<div class="kpi-card"><div class="kpi-value" style="color:${k.c}">${k.v}</div><div class="kpi-label">${k.l}</div></div>`).join('');

  const byC={};ents.forEach(e=>{const c=db.clients.find(x=>x.id===e.clientId);const n=c?.name||'?';if(!byC[n])byC[n]={h:0,c:0,r:0};byC[n].h+=e.hours;byC[n].c+=e.hours*e.costRate;byC[n].r+=e.hours*e.clientRate});
  const ce=Object.entries(byC),bd=document.getElementById('client-breakdown');
  if(!ce.length)bd.innerHTML='<p class="empty-text">Nessuna registrazione con i filtri selezionati</p>';
  else{const mx=Math.max(...ce.map(([,d])=>d.h),1);bd.innerHTML=ce.map(([n,d])=>`<div class="breakdown-row"><div class="breakdown-name">${n}</div><div class="breakdown-bar"><div class="breakdown-fill" style="width:${d.h/mx*100}%;background:linear-gradient(90deg,var(--accent),var(--green))"></div></div><div class="breakdown-stats"><span>${d.h.toFixed(1)}h</span>${_a()?`<span style="color:var(--text-dim)">€${d.r.toFixed(0)}</span><span style="color:${d.r-d.c>=0?'var(--green)':'var(--red)'};font-weight:600">+€${(d.r-d.c).toFixed(0)}</span>`:''}</div></div>`).join('')}

  // PROJECT BREAKDOWN WITH DONUTS
  renderProjectBreakdown(ents);

  const all=ents.slice(-100).reverse();
  document.getElementById('recent-table').innerHTML=`<table><thead><tr><th>Data</th>${_a()?'<th>Utente</th>':''}<th>Cliente</th><th>Commessa</th><th>Attività</th><th>Ore</th>${_a()?'<th>Costo</th><th>Ricavo</th>':''}</tr></thead><tbody>${all.map(e=>{const cl=db.clients.find(c=>c.id===e.clientId),pr=db.projects.find(p=>p.id===e.projectId),ac=pr?.activities?.find(a=>a.id===e.activityId),usr=db.users.find(u=>u.id===e.userId);return`<tr><td>${fmtDate(e.date)}</td>${_a()?`<td><span class="user-tag" style="background:${usr?.color}22;color:${usr?.color}">${usr?.name?.split(' ')[0]}</span></td>`:''}<td>${cl?.name||'?'}</td><td>${pr?.name||'?'}</td><td>${ac?.name||'?'}</td><td style="font-weight:700">${e.hours}h</td>${_a()?`<td>€${(e.hours*e.costRate).toFixed(0)}</td><td>€${(e.hours*e.clientRate).toFixed(0)}</td>`:''}</tr>`}).join('')}</tbody></table>`;
}

function renderProjectBreakdown(entries){
  const projData={};
  entries.forEach(e=>{
    if(!projData[e.projectId])projData[e.projectId]={hours:0,cost:0,revenue:0,activities:{}};
    projData[e.projectId].hours+=e.hours;
    projData[e.projectId].cost+=e.hours*e.costRate;
    projData[e.projectId].revenue+=e.hours*e.clientRate;
    if(!projData[e.projectId].activities[e.activityId])projData[e.projectId].activities[e.activityId]=0;
    projData[e.projectId].activities[e.activityId]+=e.hours;
  });

  const projEntries=Object.entries(projData);
  const el=document.getElementById('project-breakdown');
  if(!projEntries.length){el.innerHTML='<p class="empty-text">Nessuna commessa questo mese</p>';return}

  el.innerHTML='<div class="proj-donut-grid">'+projEntries.map(([pid,data])=>{
    const proj=db.projects.find(p=>p.id===pid);
    if(!proj)return'';
    const client=db.clients.find(c=>c.id===proj.clientId);
    const actEntries=Object.entries(data.activities).map(([aid,h])=>{
      const act=proj.activities?.find(a=>a.id===aid);
      return{id:aid,name:act?.name||'?',hours:h,pct:(h/data.hours*100)};
    }).sort((a,b)=>b.hours-a.hours);

    const colors=['#3A7BE8','#2EAE6D','#E8A33A','#E85A4F','#A855F7','#10B981','#F59E0B','#EF4444'];
    const donutSvg=generateDonut(actEntries,colors,data.hours);

    return`<div class="proj-donut-card">
      <div class="proj-donut-header">
        <div>
          <div class="proj-donut-title">${proj.code||'—'} - ${proj.name}</div>
          <div class="proj-donut-client">${client?.name||'?'}</div>
        </div>
        <div class="proj-donut-hours">${data.hours.toFixed(1)}h</div>
      </div>
      <div class="proj-donut-content">
        <div class="proj-donut-chart">${donutSvg}<div class="proj-donut-center"><div class="proj-donut-center-val">${data.hours.toFixed(0)}h</div><div class="proj-donut-center-lab">TOTALE</div></div></div>
        <div class="proj-donut-legend">${actEntries.map((a,i)=>`<div class="proj-donut-item"><div class="proj-donut-color" style="background:${colors[i%colors.length]}"></div><div class="proj-donut-label">${a.name}</div><div class="proj-donut-value">${a.hours.toFixed(1)}h<span class="proj-donut-pct">${a.pct.toFixed(0)}%</span></div></div>`).join('')}</div>
      </div>
      ${_a()?`<div class="proj-donut-footer"><div class="proj-donut-stat"><span style="color:var(--text-dim)">💰 Costo:</span><span style="font-weight:600">€${data.cost.toFixed(0)}</span></div><div class="proj-donut-stat"><span style="color:var(--text-dim)">📈 Ricavo:</span><span style="font-weight:600;color:var(--green)">€${data.revenue.toFixed(0)}</span></div><div class="proj-donut-stat"><span style="color:var(--text-dim)">✨ Margine:</span><span style="font-weight:700;color:${data.revenue-data.cost>=0?'var(--green)':'var(--red)'}">€${(data.revenue-data.cost).toFixed(0)}</span></div></div>`:''}
    </div>`;
  }).join('')+'</div>';
}

function generateDonut(activities,colors,total){
  const size=160,strokeWidth=28,radius=(size-strokeWidth)/2,cx=size/2,cy=size/2;
  let cumulative=0;
  const paths=activities.map((act,i)=>{
    const pct=act.hours/total;
    const startAngle=cumulative*360;
    const endAngle=(cumulative+pct)*360;
    cumulative+=pct;
    const start=polarToCartesian(cx,cy,radius,endAngle);
    const end=polarToCartesian(cx,cy,radius,startAngle);
    const largeArc=endAngle-startAngle>180?1:0;
    const d=`M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}`;
    return`<path d="${d}" fill="none" stroke="${colors[i%colors.length]}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
  }).join('');
  return`<svg viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg)">${paths}</svg>`;
}

function polarToCartesian(cx,cy,r,deg){
  const rad=deg*Math.PI/180;
  return{x:cx+r*Math.cos(rad),y:cy+r*Math.sin(rad)};
}
// ═══ BACKUP SYSTEM ═══
const BACKUP_KEY='timetrack_backups';
const MAX_BACKUPS=7;

// Backup automatico giornaliero
function initAutoBackup(){
  const lastBackup=localStorage.getItem('timetrack_last_backup');
  const today=todayStr();
  if(lastBackup!==today){
    createAutoBackup();
    localStorage.setItem('timetrack_last_backup',today);
  }
  // Schedule prossimo backup a mezzanotte
  const now=new Date();
  const tomorrow=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,0,1);
  const msUntilMidnight=tomorrow-now;
  setTimeout(()=>{createAutoBackup();setInterval(createAutoBackup,24*60*60*1000)},msUntilMidnight);
}

function createAutoBackup(){
  const backups=getBackups();
  const backup={
    date:new Date().toISOString(),
    data:JSON.parse(JSON.stringify(db)),
    entries:db.entries.length,
    users:db.users.length,
    projects:db.projects.length,
    auto:true
  };
  backups.unshift(backup);
  if(backups.length>MAX_BACKUPS)backups.splice(MAX_BACKUPS);
  localStorage.setItem(BACKUP_KEY,JSON.stringify(backups));
}

function createManualBackup(){
  const backups=getBackups();
  const backup={
    date:new Date().toISOString(),
    data:JSON.parse(JSON.stringify(db)),
    entries:db.entries.length,
    users:db.users.length,
    projects:db.projects.length,
    auto:false
  };
  backups.unshift(backup);
  if(backups.length>MAX_BACKUPS)backups.splice(MAX_BACKUPS);
  localStorage.setItem(BACKUP_KEY,JSON.stringify(backups));
  showToast('💾 Backup creato!');
  renderBackupTab();
}

function getBackups(){
  try{
    const b=localStorage.getItem(BACKUP_KEY);
    return b?JSON.parse(b):[];
  }catch(e){return[]}
}

function renderBackupTab(){
  const el=document.getElementById('mgmt-content');
  const backups=getBackups();
  const now=Date.now();
  
  el.innerHTML=`<div class="mgmt-panel" style="max-width:800px">
    <h3 style="margin:0 0 12px;color:var(--accent)">💾 Backup e Ripristino</h3>
    <p style="color:var(--text-dim);font-size:14px;margin:0 0 24px">Backup automatici giornalieri + possibilità di backup manuali. Massimo ${MAX_BACKUPS} backup salvati.</p>
    
    <div style="display:flex;gap:12px;margin-bottom:32px;flex-wrap:wrap">
      <button class="add-btn-sm" onclick="createManualBackup()">💾 Crea backup ora</button>
      <button class="add-btn-sm" onclick="exportJSON()">⬇ Esporta JSON</button>
      <label style="cursor:pointer">
        <input type="file" accept=".json" onchange="importBackupFile(event)" style="display:none">
        <span class="add-btn-sm" style="display:inline-block">📁 Importa da file</span>
      </label>
      <button class="add-btn-sm" onclick="showResetModal()" style="background:var(--red);border-color:var(--red)">🔴 Reset completo</button>
    </div>

    ${backups.length===0?`<p class="empty-text">Nessun backup disponibile</p>`:`
      <div style="display:flex;flex-direction:column;gap:12px">
        ${backups.map((b,i)=>{
          const d=new Date(b.date);
          const age=Math.floor((now-d.getTime())/(1000*60*60*24));
          const ageStr=age===0?'Oggi':age===1?'Ieri':`${age} giorni fa`;
          const size=JSON.stringify(b.data).length;
          const sizeKB=(size/1024).toFixed(1);
          return`<div class="mgmt-item" style="padding:16px;cursor:pointer;transition:all .2s" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'">
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
                <span style="font-weight:600;font-size:15px">${b.auto?'🤖 Auto':'👤 Manuale'} - ${d.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'})} ${d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}</span>
                <span style="background:var(--border);padding:3px 8px;border-radius:12px;font-size:12px;color:var(--text-dim)">${ageStr}</span>
              </div>
              <div style="display:flex;gap:16px;font-size:13px;color:var(--text-dim)">
                <span>📊 ${b.entries} ore registrate</span>
                <span>👥 ${b.users} utenti</span>
                <span>📁 ${b.projects} commesse</span>
                <span>💾 ${sizeKB} KB</span>
              </div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="mini-btn" onclick="event.stopPropagation();restoreBackup(${i})" title="Ripristina">↩️</button>
              <button class="mini-btn" onclick="event.stopPropagation();downloadBackup(${i})" title="Scarica">⬇</button>
              <button class="mini-btn danger" onclick="event.stopPropagation();deleteBackup(${i})" title="Elimina">🗑</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    `}
  </div>`;
}

async function restoreBackup(index){
  const backups=getBackups();
  if(!backups[index])return;
  const b=backups[index];
  const d=new Date(b.date).toLocaleString('it-IT');
  if(!confirm(`⚠️ ATTENZIONE!\n\nRipristinare il backup del ${d}?\n\nTutti i dati attuali saranno sostituiti con quelli del backup.\n\nQuesta operazione NON può essere annullata!`))return;
  
  db=JSON.parse(JSON.stringify(b.data));
  localStorage.setItem(DB_KEY,JSON.stringify(db));
  
  // Sync al cloud se configurato
  if(supa){
    updateSyncStatus('sync');
    try{
      const {error}=await supa.from('timetrack_data').upsert({id:1,data:db,updated_at:new Date().toISOString()});
      if(error)throw error;
      updateSyncStatus('ok');
    }catch(e){
      console.error('Errore sync dopo restore:',e);
      updateSyncStatus('err');
    }
  }
  
  showToast('✅ Backup ripristinato!');
  setTimeout(()=>location.reload(),1000);
}

function downloadBackup(index){
  const backups=getBackups();
  if(!backups[index])return;
  const b=backups[index];
  const d=new Date(b.date);
  const fname=`timetrack_backup_${d.toISOString().slice(0,10)}_${d.getHours()}${d.getMinutes()}.json`;
  const blob=new Blob([JSON.stringify(b.data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=fname;
  a.click();
  URL.revokeObjectURL(url);
  showToast('💾 Backup scaricato');
}

function deleteBackup(index){
  if(!confirm('Eliminare questo backup?'))return;
  const backups=getBackups();
  backups.splice(index,1);
  localStorage.setItem(BACKUP_KEY,JSON.stringify(backups));
  showToast('Backup eliminato');
  renderBackupTab();
}

async function importBackupFile(event){
  const file=event.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=async(e)=>{
    try{
      const imported=JSON.parse(e.target.result);
      if(!imported.users||!imported.entries){
        showToast('File non valido','error');return;
      }
      if(!confirm(`⚠️ Importare i dati dal file "${file.name}"?\n\nI dati attuali saranno sostituiti.\n\nQuesta operazione NON può essere annullata!`))return;
      
      db=imported;
      localStorage.setItem(DB_KEY,JSON.stringify(db));
      
      // Sync al cloud
      if(supa){
        updateSyncStatus('sync');
        try{
          const {error}=await supa.from('timetrack_data').upsert({id:1,data:db,updated_at:new Date().toISOString()});
          if(error)throw error;
          updateSyncStatus('ok');
        }catch(e){
          console.error('Errore sync dopo import:',e);
          updateSyncStatus('err');
        }
      }
      
      showToast('✅ Dati importati!');
      setTimeout(()=>location.reload(),1000);
    }catch(e){
      console.error('Errore import:',e);
      showToast('Errore lettura file','error');
    }
  };
  reader.readAsText(file);
  event.target.value='';
}

// ═══ RESET DATABASE ═══
function showResetModal(){
  const adminUsers=db.users.filter(u=>u.role==='admin');
  if(adminUsers.length===0){
    showToast('Nessun admin disponibile','error');
    return;
  }
  
  const html=`<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal" style="max-width:500px">
    <h3 style="margin:0 0 12px;color:var(--red)">🔴 Reset Completo Database</h3>
    <p style="color:var(--text-dim);font-size:14px;margin:0 0 20px">Questa operazione cancellerà TUTTI i dati (clienti, commesse, ore registrate) e manterrà solo un utente admin che scegli tu.</p>
    
    <div style="background:rgba(232,90,79,.1);border:1px solid var(--red);border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="font-weight:700;color:var(--red);margin-bottom:8px">⚠️ ATTENZIONE</div>
      <ul style="margin:0;padding-left:20px;font-size:13px;color:var(--text-dim)">
        <li>Tutti i clienti saranno eliminati</li>
        <li>Tutte le commesse saranno eliminate</li>
        <li>Tutte le ore registrate saranno eliminate</li>
        <li>Tutti gli utenti tranne quello selezionato saranno eliminati</li>
        <li>Tutti i backup locali saranno eliminati</li>
      </ul>
    </div>
    
    <div class="modal-field">
      <label style="font-weight:600">Seleziona l'admin da mantenere:</label>
      <select id="reset-admin-select" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
        ${adminUsers.map(u=>`<option value="${u.id}">${u.name} (@${u.username||u.name})</option>`).join('')}
      </select>
    </div>
    
    <div style="margin:20px 0;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="reset-confirm-check" style="width:18px;height:18px">
        <span style="font-size:14px">Confermo di voler procedere con il reset completo</span>
      </label>
    </div>
    
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">Annulla</button>
      <button class="add-btn-sm" onclick="executeReset()" style="background:var(--red);border-color:var(--red)">🔴 Reset Database</button>
    </div>
  </div></div>`;
  
  document.body.insertAdjacentHTML('beforeend',html);
}

async function executeReset(){
  const adminId=document.getElementById('reset-admin-select').value;
  const confirmed=document.getElementById('reset-confirm-check').checked;
  
  if(!confirmed){
    showToast('Devi confermare per procedere','error');
    return;
  }
  
  if(!confirm('⚠️ ULTIMA CONFERMA\n\nSei ASSOLUTAMENTE SICURO di voler cancellare tutto?\n\nQuesta operazione è IRREVERSIBILE!')){
    return;
  }
  
  const selectedAdmin=db.users.find(u=>u.id===adminId);
  if(!selectedAdmin){
    showToast('Admin non trovato','error');
    return;
  }
  
  // Crea backup automatico prima del reset
  createManualBackup();
  
  // Reset database mantenendo solo l'admin selezionato
  db={
    nextId:100,
    nextProjectNum:1,
    users:[{
      id:selectedAdmin.id,
      name:selectedAdmin.name,
      username:selectedAdmin.username||selectedAdmin.name.toLowerCase().split(' ')[0],
      role:'admin',
      color:selectedAdmin.color||'#3A7BE8',
      passwordHash:selectedAdmin.passwordHash
    }],
    clients:[],
    projects:[],
    entries:[],
    rates:[]
  };
  
  // Salva locale
  localStorage.setItem(DB_KEY,JSON.stringify(db));
  
  // Cancella backup locali
  localStorage.removeItem(BACKUP_KEY);
  localStorage.removeItem('timetrack_last_backup');
  
  // Sync al cloud
  if(supa){
    updateSyncStatus('sync');
    try{
      const {error}=await supa.from('timetrack_data').upsert({id:1,data:db,updated_at:new Date().toISOString()});
      if(error)throw error;
      updateSyncStatus('ok');
    }catch(e){
      console.error('Errore sync dopo reset:',e);
      updateSyncStatus('err');
    }
  }
  
  closeModal();
  showToast('✅ Database resettato!');
  
  // Ricarica dopo 1.5 secondi
  setTimeout(()=>{
    location.reload();
  },1500);
}

function exportJSON(){const b=new Blob([JSON.stringify(db,null,2)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=`timetrack_${todayStr()}.json`;a.click();URL.revokeObjectURL(u);showToast('Esportato!')}

// ═══ PROJECT REPORT ═══
function renderProjectReport(){
  const g=document.getElementById('proj-report-grid');
  const projs=db.projects.filter(p=>p.status==='active'||db.entries.some(e=>e.projectId===p.id));
  if(!projs.length){g.innerHTML='<p class="empty-text">Nessuna commessa</p>';return}
  g.innerHTML=projs.map(p=>{
    const cl=db.clients.find(c=>c.id===p.clientId);
    const pe=db.entries.filter(e=>e.projectId===p.id&&(_a()||e.userId===currentUser.id));
    const uH=pe.reduce((s,e)=>s+e.hours,0),uB=_a()?pe.reduce((s,e)=>s+e.hours*e.costRate,0):0;
    const hP=p.budgetHours?Math.min(uH/p.budgetHours*100,100):0;
    const bP=_a()&&p.budget?Math.min(uB/p.budget*100,100):0;
    let dlI='',dlP=0,dlC='var(--green)';
    if(p.deadline){const now=new Date(),dl=new Date(p.deadline),diff=Math.ceil((dl-now)/(864e5));
      if(diff<0){dlI=`Scaduta da ${Math.abs(diff)}gg`;dlC='var(--red)';dlP=100}
      else if(diff<30){dlI=`${diff}gg rimasti`;dlC='var(--orange)';dlP=80}
      else{dlI=`${diff}gg rimasti`;dlP=Math.min(30,100)}}
    const hC=hP>90?'var(--red)':hP>70?'var(--orange)':'var(--accent)';
    const bC=bP>90?'var(--red)':bP>70?'var(--orange)':'var(--green)';
    const sC=p.status==='active'?'var(--green)':p.status==='completed'?'var(--accent)':'var(--orange)';
    return`<div class="proj-card">
      <div class="proj-card-head"><div><div class="proj-card-title">${p.code||'—'} - ${p.name}</div><div class="proj-card-client">${cl?.name||'?'}</div></div><span class="proj-status" style="background:${sC}22;color:${sC}">${p.status}</span></div>
      <div class="proj-meters">
        <div><div class="proj-meter-label"><span>Ore</span><span style="font-family:var(--mono);font-weight:600">${uH.toFixed(1)} / ${p.budgetHours||'∞'}h</span></div><div class="proj-meter-track"><div class="proj-meter-fill" style="width:${hP}%;background:${hC}"></div></div></div>
        ${_a()&&p.budget?`<div><div class="proj-meter-label"><span>Budget</span><span style="font-family:var(--mono);font-weight:600">€${uB.toFixed(0)} / €${p.budget}</span></div><div class="proj-meter-track"><div class="proj-meter-fill" style="width:${bP}%;background:${bC}"></div></div></div>`:''}
        ${p.deadline?`<div><div class="proj-meter-label"><span>Scadenza: ${fmtDate(p.deadline)}</span><span style="color:${dlC};font-weight:600">${dlI}</span></div><div class="proj-meter-track"><div class="proj-meter-fill" style="width:${dlP}%;background:${dlC}"></div></div></div>`:''}
      </div>
      <div class="proj-activities"><strong>Attività:</strong><div class="proj-act-list">${(p.activities||[]).map(a=>{const aH=pe.filter(e=>e.activityId===a.id).reduce((s,e)=>s+e.hours,0);return`<span class="proj-act-tag">${a.name} <b style="color:var(--accent)">${aH}h</b></span>`}).join('')}${!p.activities?.length?'<span style="font-style:italic">Nessuna</span>':''}</div></div>
    </div>`}).join('');
}

// ═══ MANAGE ═══
function renderManage(){
  document.getElementById('mgmt-tabs').innerHTML=[{id:'client',l:'Clienti'},{id:'project',l:'Commesse'},{id:'user',l:'Utenti'},{id:'rates',l:'💰 Tariffe'},{id:'backup',l:'💾 Backup'}].map(t=>`<button class="mgmt-tab ${activeMgmt===t.id?'active':''}" onclick="toggleMgmt('${t.id}')">${t.l}</button>`).join('');
  renderMC();
}
function toggleMgmt(id){activeMgmt=activeMgmt===id?null:id;mgmtProjectFilter={clientId:'',search:''};renderManage()}
function filterMgmtProjects(){
  mgmtProjectFilter.clientId=document.getElementById('mpf-client').value;
  mgmtProjectFilter.search=document.getElementById('mpf-search').value.toLowerCase();
  const listEl=document.getElementById('mpf-list');if(!listEl)return;
  const filtered=db.projects.filter(p=>{const cl=db.clients.find(c=>c.id===p.clientId);const mc=!mgmtProjectFilter.clientId||p.clientId===mgmtProjectFilter.clientId;const s=mgmtProjectFilter.search;const ms=!s||(p.code||'').toLowerCase().includes(s)||p.name.toLowerCase().includes(s)||(cl?.name||'').toLowerCase().includes(s);return mc&&ms;});
  listEl.innerHTML=filtered.map(p=>{const cl=db.clients.find(c=>c.id===p.clientId);return`<div class="mgmt-item" style="flex-direction:column;align-items:stretch"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span class="mgmt-item-name">${p.code||'—'} - ${p.name}</span><span class="mgmt-item-meta">${cl?.name||'?'}</span><span class="mgmt-item-meta">Ref: ${p.referente||'—'}</span><span class="mgmt-item-meta">€${p.budget||0}</span><span class="mgmt-item-meta">${p.budgetHours||0}h</span><span class="mgmt-item-meta">⏰ ${fmtDate(p.deadline)}</span><span class="status-badge" style="background:${p.status==='active'?'rgba(46,174,109,.13)':p.status==='completed'?'rgba(58,123,232,.13)':'rgba(232,163,58,.13)'};color:${p.status==='active'?'var(--green)':p.status==='completed'?'var(--accent)':'var(--orange)'}">${p.status}</span>${(p.assignedUsers&&p.assignedUsers.length>0)?`<span style="display:flex;align-items:center;gap:4px;margin-left:4px">${p.assignedUsers.map(uid=>{const u=db.users.find(x=>x.id===uid);return u?`<span title="${u.name}" style="width:20px;height:20px;border-radius:50%;background:${u.color};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;flex-shrink:0">${u.name.charAt(0).toUpperCase()}</span>`:''}).join('')}</span>`:`<span class="mgmt-item-meta" style="font-size:11px;color:var(--text-dim)">Tutti</span>`}<div class="mgmt-item-actions"><button class="mini-btn" data-action="edit-project" data-id="${p.id}">✏</button><button class="mini-btn danger" data-action="delete-project" data-id="${p.id}">🗑</button></div></div><div class="sub-list"><div class="sub-list-title">Attività della commessa</div>${(p.activities||[]).map(a=>`<div class="sub-item"><span class="sub-item-name">${a.name}</span><button class="mini-btn" data-action="edit-activity" data-pid="${p.id}" data-aid="${a.id}">✏</button><button class="mini-btn danger" data-action="delete-activity" data-pid="${p.id}" data-aid="${a.id}">🗑</button></div>`).join('')}<div class="sub-add"><input id="sa-${p.id}" placeholder="Nuova attività" onkeydown="if(event.key==='Enter')addAct('${p.id}')"><button class="add-btn-sm" onclick="addAct('${p.id}')">+</button></div></div></div>`;}).join('')||'<div style="color:var(--text-dim);padding:16px 0;text-align:center;font-size:13px">Nessuna commessa trovata</div>';
}
function renderMC(){
  const el=document.getElementById('mgmt-content');if(!activeMgmt){el.innerHTML='';return}
  if(activeMgmt==='client'){
    el.innerHTML=`<div class="mgmt-panel"><div class="mgmt-list">${db.clients.map(c=>`<div class="mgmt-item"><span class="mgmt-item-name">${c.name}</span><span class="mgmt-item-meta">Ref: ${c.referente||'—'}</span>${c.email?`<span class="mgmt-item-meta">${c.email}</span>`:''}<span class="status-badge" style="background:${c.active?'rgba(46,174,109,.13)':'rgba(136,136,136,.13)'};color:${c.active?'var(--green)':'#888'}">${c.active?'Attivo':'Inattivo'}</span><div class="mgmt-item-actions"><button class="mini-btn" data-action="edit-client" data-id="${c.id}">✏</button><button class="mini-btn danger" data-action="delete-client" data-id="${c.id}">🗑</button></div></div>`).join('')}</div><div class="mgmt-form"><input id="mc-name" placeholder="Nome cliente"><input id="mc-ref" placeholder="Referente"><input id="mc-email" type="email" placeholder="Email"><button class="add-btn-sm" onclick="addClient()">+ Aggiungi</button></div></div>`;
  } else if(activeMgmt==='project'){
    const _fpList=db.projects.filter(p=>{const cl=db.clients.find(c=>c.id===p.clientId);const mc=!mgmtProjectFilter.clientId||p.clientId===mgmtProjectFilter.clientId;const s=mgmtProjectFilter.search;const ms=!s||(p.code||'').toLowerCase().includes(s)||p.name.toLowerCase().includes(s)||(cl?.name||'').toLowerCase().includes(s);return mc&&ms;});
    el.innerHTML=`<div class="mgmt-panel"><div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><select id="mpf-client" onchange="filterMgmtProjects()" style="flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px"><option value="">— Tutti i clienti —</option>${db.clients.map(c=>`<option value="${c.id}" ${mgmtProjectFilter.clientId===c.id?'selected':''}>${c.name}</option>`).join('')}</select><input id="mpf-search" placeholder="Cerca per codice, nome, cliente..." value="${mgmtProjectFilter.search.replace(/"/g,'&quot;')}" oninput="filterMgmtProjects()" style="flex:2;min-width:160px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;outline:none"></div><div id="mpf-list" class="mgmt-list">${_fpList.map(p=>{const cl=db.clients.find(c=>c.id===p.clientId);return`<div class="mgmt-item" style="flex-direction:column;align-items:stretch"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span class="mgmt-item-name">${p.code||'—'} - ${p.name}</span><span class="mgmt-item-meta">${cl?.name||'?'}</span><span class="mgmt-item-meta">Ref: ${p.referente||'—'}</span><span class="mgmt-item-meta">€${p.budget||0}</span><span class="mgmt-item-meta">${p.budgetHours||0}h</span><span class="mgmt-item-meta">⏰ ${fmtDate(p.deadline)}</span><span class="status-badge" style="background:${p.status==='active'?'rgba(46,174,109,.13)':p.status==='completed'?'rgba(58,123,232,.13)':'rgba(232,163,58,.13)'};color:${p.status==='active'?'var(--green)':p.status==='completed'?'var(--accent)':'var(--orange)'}">${p.status}</span>${(p.assignedUsers&&p.assignedUsers.length>0)?`<span style="display:flex;align-items:center;gap:4px;margin-left:4px">${p.assignedUsers.map(uid=>{const u=db.users.find(x=>x.id===uid);return u?`<span title="${u.name}" style="width:20px;height:20px;border-radius:50%;background:${u.color};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;flex-shrink:0">${u.name.charAt(0).toUpperCase()}</span>`:''}).join('')}</span>`:`<span class="mgmt-item-meta" style="font-size:11px;color:var(--text-dim)">Tutti</span>`}<div class="mgmt-item-actions"><button class="mini-btn" data-action="edit-project" data-id="${p.id}">✏</button><button class="mini-btn danger" data-action="delete-project" data-id="${p.id}">🗑</button></div></div><div class="sub-list"><div class="sub-list-title">Attività della commessa</div>${(p.activities||[]).map(a=>`<div class="sub-item"><span class="sub-item-name">${a.name}</span><button class="mini-btn" data-action="edit-activity" data-pid="${p.id}" data-aid="${a.id}">✏</button><button class="mini-btn danger" data-action="delete-activity" data-pid="${p.id}" data-aid="${a.id}">🗑</button></div>`).join('')}<div class="sub-add"><input id="sa-${p.id}" placeholder="Nuova attività" onkeydown="if(event.key==='Enter')addAct('${p.id}')"><button class="add-btn-sm" onclick="addAct('${p.id}')">+</button></div></div></div>`}).join('')||'<div style="color:var(--text-dim);padding:16px 0;text-align:center;font-size:13px">Nessuna commessa trovata</div>'}</div><div class="mgmt-form"><select id="mp-client"><option value="">— Cliente —</option>${db.clients.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select><input id="mp-name" placeholder="Nome commessa"><input id="mp-ref" placeholder="Referente"><input id="mp-budget" type="number" placeholder="Budget €"><input id="mp-hours" type="number" placeholder="Budget ore"><input id="mp-deadline" type="date"><button class="add-btn-sm" onclick="addProject()">+ Aggiungi</button></div></div>`;
  } else if(activeMgmt==='user'){
    el.innerHTML=`<div class="mgmt-panel"><div class="mgmt-list">${db.users.map(u=>`<div class="mgmt-item" style="border-left:3px solid ${u.color}"><span class="mgmt-item-name">${u.name}</span><span class="mgmt-item-meta">@${u.username||'—'}</span>${u.email?`<span class="mgmt-item-meta">${u.email}</span>`:''}<span class="mgmt-item-meta">${u.role}</span><span class="mgmt-item-meta" style="color:${u.passwordHash?'var(--green)':'var(--orange)'}">${u.passwordHash?'🔒 Password set':'⚠ No password'}</span><span class="status-badge" style="background:${u.active!==false?'rgba(46,174,109,.13)':'rgba(136,136,136,.13)'};color:${u.active!==false?'var(--green)':'#888'}">${u.active!==false?'Attivo':'Sospeso'}</span><div class="mgmt-item-actions">${u.role!=='admin'&&u.id!==currentUser.id?`<button class="mini-btn${u.active===false?'':' danger'}" data-action="toggle-user-active" data-id="${u.id}" title="${u.active===false?'Riattiva utente':'Sospendi utente'}">${u.active===false?'✓ Riattiva':'⏸ Sospendi'}</button>`:''}<button class="mini-btn" data-action="edit-user" data-id="${u.id}" title="Modifica">✏</button>${u.passwordHash?`<button class="mini-btn" data-action="reset-pwd" data-id="${u.id}" title="Reset password">🔑</button>`:''}<button class="mini-btn danger" data-action="delete-user" data-id="${u.id}" title="Elimina">🗑</button></div></div>`).join('')}</div><div class="mgmt-form"><input id="mu-name" placeholder="Nome e cognome"><input id="mu-username" placeholder="Username (login)"><input id="mu-email" type="email" placeholder="Email"><select id="mu-role"><option value="">— Ruolo —</option><option value="admin">Admin</option><option value="operator">Operatore</option></select><button class="add-btn-sm" onclick="addUser()">+ Aggiungi</button></div></div>`;
  } else if(activeMgmt==='rates'){
    renderRatesTab();
  } else if(activeMgmt==='backup'){
    renderBackupTab();
  }
}

// ═══ RATES TAB ═══
function renderRatesTab(){
  if(!db.rates)db.rates=[];
  const el=document.getElementById('mgmt-content');
  const active=db.rates.filter(r=>r.to===null).sort((a,b)=>b.from.localeCompare(a.from));
  const history=db.rates.filter(r=>r.to!==null).sort((a,b)=>b.from.localeCompare(a.from));
  const uName=id=>id?db.users.find(u=>u.id===id)?.name||'?':'(tutti)';
  const cName=id=>id?db.clients.find(c=>c.id===id)?.name||'?':'(tutti)';
  const pName=id=>id?db.projects.find(p=>p.id===id)?.name||'?':'(tutte)';
  const rowHTML=r=>`<div class="mgmt-item" style="display:grid;grid-template-columns:1fr 1fr 1fr auto auto auto auto;gap:8px;align-items:center">
    <span class="mgmt-item-meta">${uName(r.userId)}</span>
    <span class="mgmt-item-meta">${cName(r.clientId)}</span>
    <span class="mgmt-item-meta">${pName(r.projectId)}</span>
    <span class="mgmt-item-meta">${r.costRate!=null?'€'+r.costRate+'/h':'—'}</span>
    <span class="mgmt-item-meta">${r.clientRate!=null?'€'+r.clientRate+'/h':'—'}</span>
    <span class="mgmt-item-meta" style="font-size:11px">dal ${r.from}${r.to?' al '+r.to:''}</span>
    <div class="mgmt-item-actions"><button class="mini-btn" data-action="edit-rate" data-id="${r.id}">✏</button><button class="mini-btn danger" data-action="delete-rate" data-id="${r.id}">🗑</button></div>
  </div>`;
  el.innerHTML=`<div class="mgmt-panel">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto auto auto;gap:8px;padding:4px 0 8px;font-size:11px;color:var(--text-dim);font-weight:600;text-transform:uppercase">
      <span>Utente</span><span>Cliente</span><span>Commessa</span><span>Costo</span><span>Ricavo</span><span>Validità</span>
    </div>
    <div class="mgmt-list">${active.map(rowHTML).join('')||'<div style="color:var(--text-dim);padding:12px 0">Nessuna tariffa attiva</div>'}</div>
    ${history.length?`<details style="margin-top:12px"><summary style="cursor:pointer;color:var(--text-dim);font-size:13px">Storico (${history.length})</summary><div class="mgmt-list" style="margin-top:8px;opacity:.7">${history.map(rowHTML).join('')}</div></details>`:''}
    <div class="mgmt-form" style="margin-top:16px">
      <select id="nr-user"><option value="">— Utente (tutti) —</option>${db.users.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select>
      <select id="nr-client"><option value="">— Cliente (tutti) —</option>${db.clients.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select>
      <select id="nr-project"><option value="">— Commessa (tutte) —</option>${db.projects.map(p=>`<option value="${p.id}">${p.code} ${p.name}</option>`).join('')}</select>
      <input id="nr-cost" type="number" step="0.5" placeholder="Costo €/h (vuoto=non impostato)">
      <input id="nr-rev" type="number" step="0.5" placeholder="Ricavo €/h (vuoto=non impostato)">
      <input id="nr-from" type="date" placeholder="Valida dal" title="Valida dal">
      <input id="nr-to" type="date" placeholder="Valida fino al (vuoto=attiva)" title="Valida fino al">
      <button class="add-btn-sm" onclick="addRate()">+ Aggiungi Tariffa</button>
    </div>
  </div>`;
}
function addRate(){
  if(!db.rates)db.rates=[];
  const userId=document.getElementById('nr-user').value||null;
  const clientId=document.getElementById('nr-client').value||null;
  const projectId=document.getElementById('nr-project').value||null;
  const costVal=document.getElementById('nr-cost').value;
  const revVal=document.getElementById('nr-rev').value;
  const from=document.getElementById('nr-from').value;
  const to=document.getElementById('nr-to').value||null;
  if(!from){showToast('Data inizio obbligatoria','error');return}
  if(costVal===''&&revVal===''){showToast('Inserisci almeno un valore (costo o ricavo)','error');return}
  const costRate=costVal!==''?parseFloat(costVal):null;
  const clientRate=revVal!==''?parseFloat(revVal):null;
  db.rates.push({id:gid(),userId,clientId,projectId,costRate,clientRate,from,to});
  saveDB();showToast('Tariffa aggiunta');renderMC();
}
function editRateModal(id){
  const r=db.rates.find(x=>x.id===id);if(!r)return;
  openModal(`<h3>✏ Modifica Tariffa</h3>
    <div class="modal-field"><label>Utente</label><select id="er-user"><option value="">— Tutti —</option>${db.users.map(u=>`<option value="${u.id}" ${u.id===r.userId?'selected':''}>${u.name}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Cliente</label><select id="er-client"><option value="">— Tutti —</option>${db.clients.map(c=>`<option value="${c.id}" ${c.id===r.clientId?'selected':''}>${c.name}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Commessa</label><select id="er-project"><option value="">— Tutte —</option>${db.projects.map(p=>`<option value="${p.id}" ${p.id===r.projectId?'selected':''}>${p.code} ${p.name}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Costo €/h</label><input type="number" id="er-cost" step="0.5" value="${r.costRate!=null?r.costRate:''}" placeholder="vuoto = non impostato"></div>
    <div class="modal-field"><label>Ricavo €/h</label><input type="number" id="er-rev" step="0.5" value="${r.clientRate!=null?r.clientRate:''}" placeholder="vuoto = non impostato"></div>
    <div class="modal-field"><label>Valida dal</label><input type="date" id="er-from" value="${r.from}"></div>
    <div class="modal-field"><label>Valida fino al</label><input type="date" id="er-to" value="${r.to||''}"></div>
    <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveRateEdit('${id}')">Salva</button></div>`);
}
function saveRateEdit(id){
  const r=db.rates.find(x=>x.id===id);if(!r)return;
  r.userId=document.getElementById('er-user').value||null;
  r.clientId=document.getElementById('er-client').value||null;
  r.projectId=document.getElementById('er-project').value||null;
  const cv=document.getElementById('er-cost').value;
  const rv=document.getElementById('er-rev').value;
  r.costRate=cv!==''?parseFloat(cv):null;
  r.clientRate=rv!==''?parseFloat(rv):null;
  r.from=document.getElementById('er-from').value;
  r.to=document.getElementById('er-to').value||null;
  saveDB();closeModal();showToast('Tariffa aggiornata');renderMC();
}
function delRate(id){if(!confirm('Eliminare questa tariffa?'))return;db.rates=db.rates.filter(r=>r.id!==id);saveDB();showToast('Eliminata');renderMC()}

// CRUD Clients
function addClient(){const n=document.getElementById('mc-name').value.trim(),ref=document.getElementById('mc-ref').value.trim(),email=document.getElementById('mc-email').value.trim();if(!n){showToast('Nome richiesto','error');return}db.clients.push({id:gid(),name:n,referente:ref,email,active:true});saveDB();showToast(n+' aggiunto');renderManage()}
function editClientModal(id){const c=db.clients.find(x=>x.id===id);if(!c)return;openModal(`<h3>✏ Modifica Cliente</h3><div class="modal-field"><label>Nome</label><input id="ec-name" value="${c.name}"></div><div class="modal-field"><label>Referente</label><input id="ec-ref" value="${c.referente||''}"></div><div class="modal-field"><label>Email</label><input type="email" id="ec-email" value="${c.email||''}"></div><div class="modal-field"><label>Stato</label><select id="ec-active"><option value="true" ${c.active?'selected':''}>Attivo</option><option value="false" ${!c.active?'selected':''}>Inattivo</option></select></div><div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveClientEdit('${id}')">Salva</button></div>`)}
function saveClientEdit(id){const c=db.clients.find(x=>x.id===id);if(!c)return;c.name=document.getElementById('ec-name').value.trim();c.referente=document.getElementById('ec-ref').value.trim();c.email=document.getElementById('ec-email').value.trim();c.active=document.getElementById('ec-active').value==='true';saveDB();closeModal();showToast('Aggiornato');renderManage()}
function delClient(id){if(!confirm('Eliminare il cliente e tutte le sue commesse e registrazioni?'))return;db.projects=db.projects.filter(p=>p.clientId!==id);db.entries=db.entries.filter(e=>e.clientId!==id);db.clients=db.clients.filter(c=>c.id!==id);saveDB();showToast('Eliminato');renderManage()}

// CRUD Projects
function addProject(){const cid=document.getElementById('mp-client').value,n=document.getElementById('mp-name').value.trim(),ref=document.getElementById('mp-ref').value.trim(),b=parseFloat(document.getElementById('mp-budget').value)||0,bh=parseFloat(document.getElementById('mp-hours').value)||0,dl=document.getElementById('mp-deadline').value||'';if(!cid){showToast('Seleziona cliente','error');return}if(!n){showToast('Nome richiesto','error');return}if(!db.nextProjectNum)db.nextProjectNum=1;const year=new Date().getFullYear().toString().slice(-2);const code=String(db.nextProjectNum).padStart(3,'0')+'/'+year;db.projects.push({id:gid(),clientId:cid,name:n,code,referente:ref,status:'active',budget:b,budgetHours:bh,deadline:dl,activities:[],assignedUsers:[]});db.nextProjectNum++;saveDB();showToast(n+' aggiunta');renderManage()}
function editProjectModal(id){const p=db.projects.find(x=>x.id===id);if(!p)return;const au=p.assignedUsers||[];const usersHtml=db.users.map(u=>`<div class="export-check-item"><input type="checkbox" id="ep-usr-${u.id}" ${au.includes(u.id)?'checked':''}><label for="ep-usr-${u.id}" style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:${u.color};display:inline-block"></span>${u.name}</label></div>`).join('');openModal(`<h3>✏ Modifica Commessa</h3><div class="modal-field"><label>Codice</label><input id="ep-code" value="${p.code||''}" placeholder="001/26"></div><div class="modal-field"><label>Nome</label><input id="ep-name" value="${p.name}"></div><div class="modal-field"><label>Cliente</label><select id="ep-client">${db.clients.map(c=>`<option value="${c.id}" ${c.id===p.clientId?'selected':''}>${c.name}</option>`).join('')}</select></div><div class="modal-field"><label>Referente</label><input id="ep-ref" value="${p.referente||''}"></div><div class="modal-field"><label>Budget €</label><input type="number" id="ep-budget" value="${p.budget||''}"></div><div class="modal-field"><label>Budget Ore</label><input type="number" id="ep-hours" value="${p.budgetHours||''}"></div><div class="modal-field"><label>Data Fine Lavori</label><input type="date" id="ep-deadline" value="${p.deadline||''}"></div><div class="modal-field"><label>Stato</label><select id="ep-status"><option value="active" ${p.status==='active'?'selected':''}>Attivo</option><option value="completed" ${p.status==='completed'?'selected':''}>Completato</option><option value="suspended" ${p.status==='suspended'?'selected':''}>Sospeso</option></select></div><div class="modal-field"><label>Utenti assegnati <span style="color:var(--text-dim);font-weight:400;font-size:10px">(vuoto = tutti)</span></label><div class="export-col-grid" style="margin-top:4px">${usersHtml}</div></div><div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveProjectEdit('${id}')">Salva</button></div>`)}
function saveProjectEdit(id){const p=db.projects.find(x=>x.id===id);if(!p)return;p.code=document.getElementById('ep-code').value.trim();p.name=document.getElementById('ep-name').value.trim();p.clientId=document.getElementById('ep-client').value;p.referente=document.getElementById('ep-ref').value.trim();p.budget=parseFloat(document.getElementById('ep-budget').value)||0;p.budgetHours=parseFloat(document.getElementById('ep-hours').value)||0;p.deadline=document.getElementById('ep-deadline').value||'';p.status=document.getElementById('ep-status').value;p.assignedUsers=db.users.filter(u=>document.getElementById('ep-usr-'+u.id)?.checked).map(u=>u.id);saveDB();closeModal();showToast('Commessa aggiornata');renderManage()}
function delProject(id){if(!confirm('Eliminare la commessa e tutte le registrazioni associate?'))return;db.entries=db.entries.filter(e=>e.projectId!==id);db.projects=db.projects.filter(p=>p.id!==id);saveDB();showToast('Eliminata');renderManage()}

// CRUD Activities (per project)
function addAct(pid){const inp=document.getElementById('sa-'+pid);const n=inp.value.trim();if(!n){showToast('Nome richiesto','error');return}const p=db.projects.find(x=>x.id===pid);if(!p)return;if(!p.activities)p.activities=[];p.activities.push({id:gid(),name:n});saveDB();showToast(n+' aggiunta');renderManage()}
function editActModal(pid,aid){const p=db.projects.find(x=>x.id===pid);if(!p)return;const a=p.activities?.find(x=>x.id===aid);if(!a)return;openModal(`<h3>✏ Modifica Attività</h3><div class="modal-field"><label>Nome</label><input id="ea-name" value="${a.name}"></div><div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveActEdit('${pid}','${aid}')">Salva</button></div>`)}
function saveActEdit(pid,aid){const p=db.projects.find(x=>x.id===pid);if(!p)return;const a=p.activities?.find(x=>x.id===aid);if(!a)return;a.name=document.getElementById('ea-name').value.trim();saveDB();closeModal();showToast('Aggiornata');renderManage()}
function delAct(pid,aid){if(!confirm('Eliminare questa attività?'))return;const p=db.projects.find(x=>x.id===pid);if(!p)return;p.activities=p.activities.filter(a=>a.id!==aid);saveDB();showToast('Eliminata');renderManage()}

// CRUD Users
function addUser(){const n=document.getElementById('mu-name').value.trim(),un=document.getElementById('mu-username').value.trim(),email=document.getElementById('mu-email').value.trim(),r=document.getElementById('mu-role').value;if(!n){showToast('Nome richiesto','error');return}if(!un){showToast('Username richiesto','error');return}if(!r){showToast('Seleziona ruolo','error');return}db.users.push({id:gid(),name:n,username:un,email,role:r,color:'#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'),active:true});saveDB();showToast(n+' aggiunto');renderManage();renderLogin()}
function editUserModal(id){const u=db.users.find(x=>x.id===id);if(!u)return;openModal(`<h3>✏ Modifica Utente</h3><div class="modal-field"><label>Nome completo</label><input id="eu-name" value="${u.name}"></div><div class="modal-field"><label>Username</label><input id="eu-username" value="${u.username||''}"></div><div class="modal-field"><label>Email</label><input type="email" id="eu-email" value="${u.email||''}"></div><div class="modal-field"><label>Ruolo</label><select id="eu-role"><option value="admin" ${u.role==='admin'?'selected':''}>Admin</option><option value="operator" ${u.role==='operator'?'selected':''}>Operatore</option></select></div><div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveUserEdit('${id}')">Salva</button></div>`)}
function saveUserEdit(id){const u=db.users.find(x=>x.id===id);if(!u)return;u.name=document.getElementById('eu-name').value.trim();u.username=document.getElementById('eu-username').value.trim();u.email=document.getElementById('eu-email').value.trim();u.role=document.getElementById('eu-role').value;saveDB();closeModal();showToast('Aggiornato');renderManage();renderLogin()}
function delUser(id){if(db.users.length<=1){showToast('Serve almeno un utente','error');return}if(id===currentUser.id){showToast('Non puoi eliminare te stesso','error');return}if(!confirm('Eliminare questo utente e tutte le sue registrazioni?'))return;db.entries=db.entries.filter(e=>e.userId!==id);db.users=db.users.filter(u=>u.id!==id);saveDB();showToast('Eliminato');renderManage();renderLogin()}
function toggleUserActive(uid){if(!_a())return;const u=db.users.find(x=>x.id===uid);if(!u)return;if(u.role==='admin'){showToast('Non puoi sospendere un amministratore','error');return}if(uid===currentUser.id){showToast('Non puoi sospendere te stesso','error');return}u.active=u.active===false?true:false;saveDB();showToast(u.active?u.name+' riattivato':u.name+' sospeso');renderManage();renderLogin()}

// ═══ IMPORT ═══
document.addEventListener('dragover',e=>{e.preventDefault()});
document.addEventListener('drop',e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(!f||!f.name.endsWith('.json'))return;const r=new FileReader();r.onload=ev=>{try{const imp=JSON.parse(ev.target.result);if(imp.users&&imp.projects){db=imp;saveDB();showToast('Importato!');logout()}else showToast('File non valido','error')}catch(err){showToast('Errore','error')}};r.readAsText(f)});

// ═══ EXPOSE FUNCTIONS GLOBALLY ═══
window.delEntry=delEntry;
window.editEntryModal=editEntryModal;
window.onEditClientChange=onEditClientChange;
window.onEditProjectChange=onEditProjectChange;
window.saveEntryEdit=saveEntryEdit;
window.addClient=addClient;
window.editClientModal=editClientModal;
window.saveClientEdit=saveClientEdit;
window.delClient=delClient;
window.addProject=addProject;
window.editProjectModal=editProjectModal;
window.saveProjectEdit=saveProjectEdit;
window.delProject=delProject;
window.addAct=addAct;
window.editActModal=editActModal;
window.saveActEdit=saveActEdit;
window.delAct=delAct;
window.addUser=addUser;
window.editUserModal=editUserModal;
window.saveUserEdit=saveUserEdit;
window.delUser=delUser;
window.toggleUserActive=toggleUserActive;
window.closeModal=closeModal;
window.onQeProjectChange3=onQeProjectChange3;
window.goToday=goToday;
window.changeWeek=changeWeek;
window.addEntry=addEntry;
window.exportJSON=exportJSON;

// ═══ EXPORT REPORT ═══
function _expPeriodLabel(){
  const p=reportFilters.period;
  const labels={
    'current-month':'Mese corrente',
    'last-month':'Mese scorso',
    'current-year':'Anno corrente',
    'last-year':'Anno scorso',
    'all':'Tutto',
    'custom':reportFilters.dateFrom&&reportFilters.dateTo?reportFilters.dateFrom+' → '+reportFilters.dateTo:'Personalizzato'
  };
  return labels[p]||p;
}

function showExportModal(){
  const isAdmin=_a();
  document.getElementById('exp-col-user-wrap').style.display=isAdmin?'':'none';
  document.getElementById('exp-col-cost-wrap').style.display=isAdmin?'':'none';
  document.getElementById('exp-col-revenue-wrap').style.display=isAdmin?'':'none';
  if(!isAdmin){
    document.getElementById('exp-col-user').checked=false;
    document.getElementById('exp-col-cost').checked=false;
    document.getElementById('exp-col-revenue').checked=false;
    document.getElementById('exp-group').querySelector('option[value="user"]').style.display='none';
  }
  document.getElementById('exp-title').value='Report Ore - '+_expPeriodLabel();
  document.getElementById('export-modal-overlay').style.display='flex';
}

function closeExportModal(){
  document.getElementById('export-modal-overlay').style.display='none';
}

function _getExpConfig(){
  return{
    title:document.getElementById('exp-title').value||'Report Ore',
    cols:{
      date:document.getElementById('exp-col-date').checked,
      user:document.getElementById('exp-col-user').checked,
      client:document.getElementById('exp-col-client').checked,
      project:document.getElementById('exp-col-project').checked,
      activity:document.getElementById('exp-col-activity').checked,
      hours:document.getElementById('exp-col-hours').checked,
      cost:document.getElementById('exp-col-cost').checked,
      revenue:document.getElementById('exp-col-revenue').checked,
      note:document.getElementById('exp-col-note').checked
    },
    groupBy:document.getElementById('exp-group').value,
    showGroupTotals:document.getElementById('exp-show-totals').checked,
    showKpi:document.getElementById('exp-show-kpi').checked
  };
}

function generateReportData(cfg){
  const ents=getFilteredEntries();
  const rows=ents.map(e=>{
    const cl=db.clients.find(x=>x.id===e.clientId);
    const pr=db.projects.find(x=>x.id===e.projectId);
    const ac=pr?.activities?.find(x=>x.id===e.activityId);
    const usr=db.users.find(x=>x.id===e.userId);
    return{
      date:e.date,
      user:usr?.name||'?',
      client:cl?.name||'?',
      project:(pr?.code?pr.code+' - ':'')+( pr?.name||'?'),
      activity:ac?.name||'?',
      hours:e.hours,
      cost:e.hours*e.costRate,
      revenue:e.hours*e.clientRate,
      note:e.note||''
    };
  });

  // KPI totals
  const kpis={
    totalHours:rows.reduce((s,r)=>s+r.hours,0),
    totalCost:rows.reduce((s,r)=>s+r.cost,0),
    totalRevenue:rows.reduce((s,r)=>s+r.revenue,0),
    count:rows.length
  };
  kpis.margin=kpis.totalRevenue-kpis.totalCost;

  // Grouping
  let groups=[];
  if(cfg.groupBy==='none'){
    groups=[{label:null,rows}];
  }else{
    const key=cfg.groupBy==='client'?'client':cfg.groupBy==='project'?'project':'user';
    const map={};
    rows.forEach(r=>{
      const k=r[key];
      if(!map[k])map[k]=[];
      map[k].push(r);
    });
    groups=Object.entries(map).map(([label,rows])=>({label,rows}));
    groups.sort((a,b)=>a.label.localeCompare(b.label));
  }

  groups=groups.map(g=>({
    ...g,
    totals:{
      hours:g.rows.reduce((s,r)=>s+r.hours,0),
      cost:g.rows.reduce((s,r)=>s+r.cost,0),
      revenue:g.rows.reduce((s,r)=>s+r.revenue,0)
    }
  }));

  return{title:cfg.title,period:_expPeriodLabel(),kpis,groups,generatedAt:new Date().toLocaleDateString('it-IT')};
}

function _buildTableHead(cfg){
  const h=[];
  if(cfg.cols.date)h.push('Data');
  if(cfg.cols.user)h.push('Utente');
  if(cfg.cols.client)h.push('Cliente');
  if(cfg.cols.project)h.push('Commessa');
  if(cfg.cols.activity)h.push('Attività');
  if(cfg.cols.hours)h.push('Ore');
  if(cfg.cols.cost)h.push('Costo €');
  if(cfg.cols.revenue)h.push('Ricavo €');
  if(cfg.cols.note)h.push('Note');
  return h;
}

function _buildTableRow(r,cfg){
  const row=[];
  if(cfg.cols.date)row.push(r.date);
  if(cfg.cols.user)row.push(r.user);
  if(cfg.cols.client)row.push(r.client);
  if(cfg.cols.project)row.push(r.project);
  if(cfg.cols.activity)row.push(r.activity);
  if(cfg.cols.hours)row.push(r.hours.toFixed(2));
  if(cfg.cols.cost)row.push(r.cost.toFixed(2));
  if(cfg.cols.revenue)row.push(r.revenue.toFixed(2));
  if(cfg.cols.note)row.push(r.note);
  return row;
}

function exportReportPDF(){
  const cfg=_getExpConfig();
  const data=generateReportData(cfg);
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const pageW=doc.internal.pageSize.getWidth();
  let y=15;

  // Header
  doc.setFont('helvetica','bold');
  doc.setFontSize(18);
  doc.setTextColor(58,123,232);
  doc.text('TimeTrack',15,y);
  doc.setFont('helvetica','normal');
  doc.setFontSize(10);
  doc.setTextColor(139,143,163);
  doc.text('Generato il '+data.generatedAt,pageW-15,y,{align:'right'});
  y+=8;
  doc.setFont('helvetica','bold');
  doc.setFontSize(14);
  doc.setTextColor(232,233,237);
  doc.text(data.title,15,y);
  y+=5;
  doc.setFont('helvetica','normal');
  doc.setFontSize(9);
  doc.setTextColor(139,143,163);
  doc.text('Periodo: '+data.period+' | '+data.kpis.count+' registrazioni',15,y);
  y+=6;

  // KPI box
  if(cfg.showKpi){
    doc.setDrawColor(42,46,59);
    doc.setFillColor(24,27,36);
    doc.roundedRect(15,y,pageW-30,18,3,3,'FD');
    doc.setFont('helvetica','bold');
    doc.setFontSize(10);
    doc.setTextColor(232,233,237);
    const kpis=[
      'Ore totali: '+data.kpis.totalHours.toFixed(2)
    ];
    if(_a()){
      kpis.push('Costo: €'+data.kpis.totalCost.toFixed(2));
      kpis.push('Ricavo: €'+data.kpis.totalRevenue.toFixed(2));
      kpis.push('Margine: €'+data.kpis.margin.toFixed(2));
    }
    const step=(pageW-30)/kpis.length;
    kpis.forEach((k,i)=>{
      doc.text(k,15+step*i+step/2,y+11,{align:'center'});
    });
    y+=24;
  }

  const head=[_buildTableHead(cfg)];
  const colStyles={};
  const hLen=head[0].length;

  data.groups.forEach(g=>{
    if(g.label){
      doc.setFont('helvetica','bold');
      doc.setFontSize(10);
      doc.setTextColor(58,123,232);
      if(y>doc.internal.pageSize.getHeight()-30){doc.addPage();y=15;}
      doc.text(g.label,15,y);
      y+=3;
    }

    const body=g.rows.map(r=>_buildTableRow(r,cfg));
    if(cfg.showGroupTotals&&g.label){
      const totRow=new Array(hLen).fill('');
      const hi=head[0];
      if(hi.includes('Ore'))totRow[hi.indexOf('Ore')]=g.totals.hours.toFixed(2);
      if(hi.includes('Costo €'))totRow[hi.indexOf('Costo €')]=g.totals.cost.toFixed(2);
      if(hi.includes('Ricavo €'))totRow[hi.indexOf('Ricavo €')]=g.totals.revenue.toFixed(2);
      totRow[0]='TOTALE';
      body.push(totRow);
    }

    doc.autoTable({
      startY:y,
      head,
      body,
      theme:'grid',
      styles:{fontSize:8,cellPadding:2,textColor:[232,233,237],lineColor:[42,46,59],fillColor:[24,27,36]},
      headStyles:{fillColor:[58,123,232],textColor:[255,255,255],fontStyle:'bold'},
      alternateRowStyles:{fillColor:[30,34,48]},
      didParseCell(data){
        if(data.row.index===body.length-1&&g.label&&cfg.showGroupTotals){
          data.cell.styles.fontStyle='bold';
          data.cell.styles.fillColor=[42,46,59];
        }
      },
      margin:{left:15,right:15}
    });
    y=doc.lastAutoTable.finalY+8;
  });

  // Footer pages
  const pageCount=doc.internal.getNumberOfPages();
  for(let i=1;i<=pageCount;i++){
    doc.setPage(i);
    doc.setFont('helvetica','normal');
    doc.setFontSize(8);
    doc.setTextColor(139,143,163);
    doc.text('Pagina '+i+' di '+pageCount,pageW-15,doc.internal.pageSize.getHeight()-8,{align:'right'});
  }

  doc.save('report_'+todayStr()+'.pdf');
  showToast('📄 PDF esportato!');
  closeExportModal();
}

function exportReportExcel(){
  const cfg=_getExpConfig();
  const data=generateReportData(cfg);
  const wb=XLSX.utils.book_new();

  // Sheet 1: Report
  const wsData=[];
  wsData.push([data.title]);
  wsData.push(['Periodo: '+data.period+'   |   Generato il: '+data.generatedAt]);
  wsData.push([]);

  const head=_buildTableHead(cfg);

  data.groups.forEach(g=>{
    if(g.label)wsData.push([g.label]);
    wsData.push(head);
    g.rows.forEach(r=>wsData.push(_buildTableRow(r,cfg)));
    if(cfg.showGroupTotals&&g.label){
      const totRow=new Array(head.length).fill('');
      if(head.includes('Ore'))totRow[head.indexOf('Ore')]=g.totals.hours;
      if(head.includes('Costo €'))totRow[head.indexOf('Costo €')]=g.totals.cost;
      if(head.includes('Ricavo €'))totRow[head.indexOf('Ricavo €')]=g.totals.revenue;
      totRow[0]='TOTALE';
      wsData.push(totRow);
    }
    wsData.push([]);
  });

  const ws=XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols']=head.map(()=>({wch:20}));
  XLSX.utils.book_append_sheet(wb,ws,'Report');

  // Sheet 2: KPI (admin only)
  if(cfg.showKpi&&_a()){
    const kpiData=[
      ['KPI Riepilogo'],
      ['Periodo',data.period],
      ['Registrazioni',data.kpis.count],
      ['Ore totali',data.kpis.totalHours],
      ['Costo totale €',data.kpis.totalCost],
      ['Ricavo totale €',data.kpis.totalRevenue],
      ['Margine €',data.kpis.margin],
      ['Margine %',data.kpis.totalRevenue>0?((data.kpis.margin/data.kpis.totalRevenue)*100).toFixed(1)+'%':'—']
    ];
    const wsKpi=XLSX.utils.aoa_to_sheet(kpiData);
    wsKpi['!cols']=[{wch:22},{wch:18}];
    XLSX.utils.book_append_sheet(wb,wsKpi,'KPI');
  }

  XLSX.writeFile(wb,'report_'+todayStr()+'.xlsx');
  showToast('📗 Excel esportato!');
  closeExportModal();
}

window.showExportModal=showExportModal;
window.closeExportModal=closeExportModal;
window.exportReportPDF=exportReportPDF;
window.exportReportExcel=exportReportExcel;
window.createManualBackup=createManualBackup;
window.importBackupFile=importBackupFile;
window.restoreBackup=restoreBackup;
window.downloadBackup=downloadBackup;
window.deleteBackup=deleteBackup;
window.showResetModal=showResetModal;
window.executeReset=executeReset;
window.onFilterChange=onFilterChange;
window.applyFilters=applyFilters;
window.resetFilters=resetFilters;
window.loginAs=loginAs;
window.logout=logout;
window.changePassword=changePassword;
window.submitChangePwd=submitChangePwd;
window.submitPwd=submitPwd;
window.closePwdModal=closePwdModal;
window.resetUserPassword=resetUserPassword;
window.setView=setView;
window.toggleMgmt=toggleMgmt;
window.renderQH=renderQH;
window.filterProjects=filterProjects;
window.filterMgmtProjects=filterMgmtProjects;
window.hideProjectDropdown=hideProjectDropdown;
window.selectProject=selectProject;
window.addRate=addRate;
window.editRateModal=editRateModal;
window.saveRateEdit=saveRateEdit;
window.delRate=delRate;

// ═══ INIT ═══
(async function(){
  await loadDB();
  selectedWeek=getWeekStart(todayStr());
  initAutoBackup();
  renderLogin();
})();
