// ═══ GLOBAL APP OBJECT ═══
const App = {};

// ═══════════════════════════════════════
//  DATABASE (in-memory, ricomposto dalle tabelle Supabase)
//  La sicurezza è garantita da Supabase Auth + RLS lato server:
//  gli operator ricevono solo le proprie entries e MAI tariffe,
//  costi o budget (le query su quelle tabelle tornano vuote).
// ═══════════════════════════════════════
let db=null,currentUser=null,currentEmail=null,currentView='timesheet',selectedWeek,selectedDay,activeMgmt=null,mgmtProjectFilter={clientId:'',search:''};

// Flusso invito/recovery: il tipo va letto dall'URL PRIMA che il client
// Supabase consumi il token dal fragment
const _authFlowType=new URLSearchParams((location.hash||'').replace(/^#/,'')).get('type');

// ═══ SUPABASE CONFIG ═══
// La publishable key è pubblica per progettazione: senza sessione autenticata
// le policy RLS non le concedono alcun accesso. (Sostituisce la vecchia anon
// key legacy: il gateway delle Edge Functions accetta solo le chiavi nuove.)
const SUPABASE_URL='https://latuujorgnaksdhxazfb.supabase.co';
const SUPABASE_KEY='sb_publishable_xA_K9OBN3t3zUR4OBobx9A_vErdBrir';
const supa=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY);

function updateSyncStatus(status){
  const el=document.getElementById('sync-status');
  if(!el)return;
  const colors={ok:'#2EAE6D',sync:'#E8A33A',err:'#E85A4F',off:'#888'};
  const labels={ok:'✓ Sincronizzato',sync:'⟳ Sincronizzazione...',err:'✗ Errore sync',off:'○ Offline'};
  el.style.background=colors[status];
  el.innerHTML=labels[status];
}
// Carica tutte le tabelle e ricompone l'oggetto db con la forma storica
// (users, clients, projects+activities annidate, entries con costi, rates).
// Per gli operator le query su rates/project_finance/entry_costs tornano
// vuote per RLS: budget e costi restano a 0 e la UI già li nasconde.
async function loadAll(){
  updateSyncStatus('sync');
  const [profiles,clients,projects,activities,entries,rates,finance,costs]=await Promise.all([
    supa.from('profiles').select('*').order('name'),
    supa.from('clients').select('*').order('name'),
    supa.from('projects').select('*'),
    supa.from('activities').select('*'),
    supa.from('entries').select('*'),
    supa.from('rates').select('*'),
    supa.from('project_finance').select('*'),
    supa.from('entry_costs').select('*'),
  ]);
  const bad=[profiles,clients,projects,activities,entries,rates,finance,costs].find(r=>r.error);
  if(bad){updateSyncStatus('err');throw bad.error}
  const finMap={};(finance.data||[]).forEach(f=>{finMap[f.project_id]=Number(f.budget)});
  const actByProj={};(activities.data||[]).forEach(a=>{(actByProj[a.project_id]=actByProj[a.project_id]||[]).push({id:a.id,name:a.name})});
  const costMap={};(costs.data||[]).forEach(c=>{costMap[c.entry_id]=c});
  db={
    users:(profiles.data||[]).map(p=>({id:p.id,name:p.name,username:p.username||'',email:p.email||'',role:p.role,color:p.color,active:p.active})),
    clients:(clients.data||[]).map(c=>({id:c.id,name:c.name,referente:c.referente||'',email:c.email||'',active:c.active})),
    projects:(projects.data||[]).map(p=>({id:p.id,clientId:p.client_id,name:p.name,code:p.code||'',referente:p.referente||'',status:p.status,budget:finMap[p.id]||0,budgetHours:p.budget_hours?Number(p.budget_hours):0,deadline:p.deadline||'',activities:actByProj[p.id]||[],assignedUsers:p.assigned_users||[]})),
    entries:(entries.data||[]).map(e=>{const c=costMap[e.id];return{id:e.id,userId:e.user_id,clientId:e.client_id,projectId:e.project_id,activityId:e.activity_id,date:e.date,hours:Number(e.hours),note:e.note||'',costRate:c?Number(c.cost_rate):0,clientRate:c?Number(c.client_rate):0,createdAt:e.created_at}}),
    rates:(rates.data||[]).map(r=>({id:r.id,userId:r.user_id,clientId:r.client_id,projectId:r.project_id,costRate:r.cost_rate!=null?Number(r.cost_rate):null,clientRate:r.client_rate!=null?Number(r.client_rate):null,from:r.valid_from,to:r.valid_to})),
  };
  updateSyncStatus('ok');
}

function friendlyDbError(error){
  const m=error?.message||'';
  if(m.includes('row-level security')||m.includes('Campo protetto')||m.includes('riservata agli amministratori'))return'Permesso negato';
  if(m.includes('duplicate key'))return'Elemento già esistente';
  if(m.includes('violates check constraint'))return'Valore non valido';
  if(m.includes('Failed to fetch')||m.includes('NetworkError'))return'Connessione assente, riprova';
  return'Errore di salvataggio';
}

// Esegue una scrittura Supabase; su successo ricarica i dati.
// Ritorna true/false: su false la UI non deve applicare nulla.
async function dbWrite(query,okMsg){
  updateSyncStatus('sync');
  const {error}=await query;
  if(error){
    console.error('Errore scrittura:',error);
    updateSyncStatus('err');
    showToast(friendlyDbError(error),'error');
    return false;
  }
  try{await loadAll()}catch(e){console.error(e)}
  if(okMsg)showToast(okMsg);
  return true;
}

// Re-render della view corrente
function rerenderCurrent(){
  if(document.querySelector('.modal-backdrop'))return; // non disturbare modal aperti
  if(document.querySelector('#modal-root .modal-overlay'))return; // modali di modifica aperti
  if(!currentUser)return;
  ({timesheet:renderWeek,dashboard:renderDashboard,projects:renderProjectReport,manage:renderManage})[currentView]?.();
}

// Sottoscrizione realtime per tabella: su ogni cambiamento ricarica
// e ri-renderizza (RLS filtra gli eventi per utente lato server)
let realtimeChannel=null,rtRefreshTimer=null;
function scheduleRemoteRefresh(){
  if(rtRefreshTimer)clearTimeout(rtRefreshTimer);
  rtRefreshTimer=setTimeout(async()=>{
    if(!currentUser)return;
    try{await loadAll();rerenderCurrent()}catch(e){console.error(e)}
  },400);
}
function startRealtimeSubscription(){
  if(realtimeChannel)supa.removeChannel(realtimeChannel);
  realtimeChannel=supa.channel('timetrack_changes');
  ['profiles','clients','projects','activities','entries','rates','project_finance','entry_costs'].forEach(t=>{
    realtimeChannel.on('postgres_changes',{event:'*',schema:'public',table:t},scheduleRemoteRefresh);
  });
  realtimeChannel.subscribe();
}

// Polling di sicurezza (60s): copre eventuali eventi realtime persi
let pollTimer=null;
function startPolling(){
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(async()=>{
    if(!currentUser)return;
    try{await loadAll();rerenderCurrent()}catch(e){console.error('Refresh err:',e)}
  },60000);
}
function localYMD(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function parseYMD(s){const[y,m,dd]=s.split('-').map(Number);return new Date(y,m-1,dd)}
function todayStr(){return localYMD(new Date())}
function fmtDate(d){if(!d)return'—';const[y,m,dd]=d.split('-');return`${dd}/${m}/${y}`}
function getWeekStart(d){const dt=parseYMD(d);const day=dt.getDay();const diff=dt.getDate()-day+(day===0?-6:1);dt.setDate(diff);return localYMD(dt)}
function getWeekDays(s){const d=[];const x=parseYMD(s);for(let i=0;i<7;i++){d.push(localYMD(x));x.setDate(x.getDate()+1)}return d}
const DN=['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
function showToast(m,t='success'){const el=document.getElementById('toast');el.textContent=m;el.style.background=t==='error'?'var(--red)':'var(--green)';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2500)}
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function _a(){return currentUser&&currentUser.role==='admin'}
// Valida i colori prima di interpolarli in HTML/style (difesa XSS)
function safeColor(c){return /^#[0-9A-Fa-f]{6}$/.test(c||'')?c:'#888888'}
function isProjectVisible(proj){if(_a())return true;const au=proj.assignedUsers;if(!au||au.length===0)return true;return au.includes(currentUser.id)}
function gid(){return crypto.randomUUID()}
function openModal(h){document.getElementById('modal-root').innerHTML=`<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal">${h}</div></div>`}
function closeModal(){document.getElementById('modal-root').innerHTML=''}

// ═══ AUTH (Supabase Auth: email + password verificate lato server) ═══
function renderLogin(){
  const saved=localStorage.getItem('tt_saved_email');
  if(saved){
    const el=document.getElementById('login-username');
    if(el)el.value=saved;
    const cb=document.getElementById('login-remember');
    if(cb)cb.checked=true;
    setTimeout(()=>document.getElementById('login-password')?.focus(),50);
  }else{
    setTimeout(()=>document.getElementById('login-username')?.focus(),50);
  }
}

function _loginError(msg){
  const errEl=document.getElementById('login-error');
  errEl.textContent=msg;errEl.style.display='block';
}

async function submitLogin(){
  const email=document.getElementById('login-username').value.trim();
  const password=document.getElementById('login-password').value;
  const errEl=document.getElementById('login-error');
  errEl.style.display='none';
  if(!email){_loginError('Inserisci la tua email');return}
  if(!password){_loginError('Inserisci la password');return}
  const btn=document.querySelector('#login-form .btn-primary');
  if(btn)btn.disabled=true;
  const {error}=await supa.auth.signInWithPassword({email,password});
  if(btn)btn.disabled=false;
  if(error){
    console.error('Login fallito:',error.message);
    _loginError(error.message.includes('Invalid login credentials')?'Email o password errati':'Accesso non riuscito, riprova');
    document.getElementById('login-password').value='';
    document.getElementById('login-password').focus();
    return;
  }
  const remember=document.getElementById('login-remember')?.checked;
  if(remember)localStorage.setItem('tt_saved_email',email);
  else localStorage.removeItem('tt_saved_email');
  const ok=await initSession();
  if(!ok)return;
  document.getElementById('login-password').value='';
}

// Carica i dati e apre l'app se la sessione è valida e il profilo attivo
async function initSession(){
  const {data:{session}}=await supa.auth.getSession();
  if(!session)return false;
  try{await loadAll()}catch(e){
    console.error('Errore caricamento dati:',e);
    _loginError('Impossibile caricare i dati, riprova');
    return false;
  }
  const me=db.users.find(u=>u.id===session.user.id);
  if(!me){
    await supa.auth.signOut();
    _loginError('Profilo non trovato. Contatta un amministratore.');
    return false;
  }
  if(me.active===false){
    await supa.auth.signOut();
    _loginError('Account sospeso. Contatta un amministratore.');
    return false;
  }
  currentEmail=session.user.email;
  doLogin(me);
  return true;
}

function doLogin(user){
  currentUser=user;
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app-header').style.display='flex';
  document.getElementById('app-main').style.display='block';
  startRealtimeSubscription();
  startPolling();
  renderHeader();setView('timesheet');
}

async function logout(){
  try{await supa.auth.signOut()}catch(e){console.error(e)}
  if(realtimeChannel){supa.removeChannel(realtimeChannel);realtimeChannel=null}
  if(pollTimer){clearInterval(pollTimer);pollTimer=null}
  currentUser=null;currentEmail=null;db=null;
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('app-header').style.display='none';
  document.getElementById('app-main').style.display='none';
  document.getElementById('login-username').value='';
  document.getElementById('login-password').value='';
  document.getElementById('login-error').style.display='none';
  renderLogin();
}

function closePwdModal(){
  document.querySelector('.modal-backdrop')?.remove();
}

// Cambio password (richiamabile dall'header)
function changePassword(){
  if(!currentUser)return;
  const html=`<div class="modal-backdrop" onclick="if(event.target===this)closePwdModal()"><div class="modal" style="max-width:400px">
    <h3 style="margin:0 0 20px;color:var(--accent)">Cambia password</h3>
    <div style="display:flex;flex-direction:column;gap:12px">
      <input type="password" id="cp-old" placeholder="Password attuale" autocomplete="current-password" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
      <input type="password" id="cp-new" placeholder="Nuova password (min 8 caratteri)" autocomplete="new-password" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
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
  if(newPwd.length<8){
    err.textContent='Nuova password troppo corta (min 8 caratteri)';err.style.display='block';return;
  }
  if(newPwd!==conf){
    err.textContent='Le password non coincidono';err.style.display='block';return;
  }
  // Verifica la password attuale rifacendo il login
  const {error:oldErr}=await supa.auth.signInWithPassword({email:currentEmail,password:oldPwd});
  if(oldErr){
    err.textContent='Password attuale errata';err.style.display='block';return;
  }
  const {error}=await supa.auth.updateUser({password:newPwd});
  if(error){
    console.error(error);
    err.textContent='Cambio password non riuscito, riprova';err.style.display='block';return;
  }
  closePwdModal();
  showToast('Password cambiata!');
}

// ═══ IMPOSTA PASSWORD (arrivo da link di invito o di recovery) ═══
function showSetPasswordModal(){
  if(document.getElementById('sp-new'))return;
  const html=`<div class="modal-backdrop"><div class="modal" style="max-width:400px">
    <h3 style="margin:0 0 8px;color:var(--accent)">Imposta la tua password</h3>
    <p style="margin:0 0 20px;color:var(--text-dim);font-size:13px">Scegli la password che userai per accedere a TimeTrack</p>
    <div style="display:flex;flex-direction:column;gap:12px">
      <input type="password" id="sp-new" placeholder="Nuova password (min 8 caratteri)" autocomplete="new-password" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
      <input type="password" id="sp-confirm" placeholder="Conferma password" autocomplete="new-password" onkeydown="if(event.key==='Enter')submitSetPwd()" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px">
      <div id="sp-error" style="color:var(--red);font-size:13px;display:none"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn-primary" onclick="submitSetPwd()">Salva password</button>
      </div>
    </div>
  </div></div>`;
  document.body.insertAdjacentHTML('beforeend',html);
  setTimeout(()=>document.getElementById('sp-new')?.focus(),50);
}

async function submitSetPwd(){
  const pwd=document.getElementById('sp-new').value;
  const conf=document.getElementById('sp-confirm').value;
  const err=document.getElementById('sp-error');
  if(pwd.length<8){err.textContent='Password troppo corta (min 8 caratteri)';err.style.display='block';return}
  if(pwd!==conf){err.textContent='Le password non coincidono';err.style.display='block';return}
  const {error}=await supa.auth.updateUser({password:pwd});
  if(error){
    console.error(error);
    err.textContent='Salvataggio non riuscito, riprova';err.style.display='block';return;
  }
  closePwdModal();
  showToast('Password impostata!');
  await initSession();
}

// Estrae un messaggio leggibile dagli errori di supa.functions.invoke:
// la nostra funzione risponde {error}, il gateway Supabase {code,message}
async function fnErrorMessage(error,fallback){
  if(!error.context){
    if(error.name==='FunctionsFetchError')return `${fallback}: funzione non raggiungibile (rete o deploy mancante)`;
    return error.message?`${fallback} (${error.message})`:fallback;
  }
  const status=error.context.status;
  try{
    const ctx=await error.context.json();
    if(ctx?.error)return ctx.error;
    if(ctx?.message)return `${fallback} (${status||'?'}: ${ctx.message})`;
  }catch(e){}
  return status?`${fallback} (HTTP ${status})`:fallback;
}

// Reset password (solo admin): genera un link di reimpostazione via
// Edge Function (nessuna email: il link va girato a mano alla persona)
async function resetUserPassword(uid){
  if(!_a())return;
  const u=db.users.find(x=>x.id===uid);
  if(!u)return;
  if(!u.email||!u.email.includes('@')){showToast('Utente senza email','error');return}
  if(!confirm(`Generare un link di reimpostazione password per ${u.name} (${u.email})?`))return;
  const {data,error}=await supa.functions.invoke('invite-user',{body:{action:'recovery',email:u.email}});
  if(error){
    console.error(error);
    showToast(await fnErrorMessage(error,'Generazione non riuscita'),'error');
    return;
  }
  showInviteLinkModal(`Link per ${esc(u.name)}`,data.link);
}

// ═══ HEADER ═══
function renderHeader(){
  const pill=document.getElementById('user-pill');
  pill.style.borderColor=safeColor(currentUser.color);
  pill.innerHTML=`<span class="user-dot" style="background:${safeColor(currentUser.color)}"></span>${esc(currentUser.name.split(' ')[0])}`;
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
  as.disabled=false;as.innerHTML='<option value="">— Seleziona —</option>'+proj.activities.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('');
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
  dd.innerHTML=matches.map(p=>{const cl=db.clients.find(c=>c.id===p.clientId);const label=(p.code+' - '+p.name).replace(/\\/g,'\\\\').replace(/'/g,"\\'");return`<div class="project-dropdown-item" onmousedown="selectProject('${p.id}','${esc(label)}')"><span class="proj-code">${esc(p.code)}</span>${esc(p.name)}<div class="proj-client">${esc(cl?.name||'')}</div></div>`;}).join('');
  dd.style.display='block';
}
function hideProjectDropdown(){setTimeout(()=>{const dd=document.getElementById('qe-project-dropdown');if(dd)dd.style.display='none';},150)}
function selectProject(id,label){
  document.getElementById('qe-project').value=id;
  document.getElementById('qe-project-search').value=label;
  document.getElementById('qe-project-dropdown').style.display='none';
  onQeProjectChange3();
}
// La risoluzione tariffe avviene lato server (funzione SQL resolve_rates
// + trigger snapshot_entry_rates): il client non conosce mai le tariffe.
async function addEntry(){
  const projectId=document.getElementById('qe-project').value;
  const activityId=document.getElementById('qe-activity').value;
  const date=document.getElementById('qe-date').value;
  const hours=parseFloat(document.getElementById('qe-hours').value);
  const note=document.getElementById('qe-note').value;
  if(!projectId||!activityId||!date||!hours){showToast('Compila tutti i campi','error');return}
  if(isNaN(hours)||hours<=0||hours>24){showToast('Ore non valide','error');return}
  const proj=db.projects.find(p=>p.id===projectId);
  if(!proj){showToast('Commessa non valida','error');return}
  // Le tariffe vengono snapshotate lato server dal trigger (gli operator non le vedono mai)
  const ok=await dbWrite(supa.from('entries').insert({id:gid(),user_id:currentUser.id,client_id:proj.clientId,project_id:projectId,activity_id:activityId,date,hours,note:note||''}),`${hours}h registrate!`);
  if(!ok)return;
  document.getElementById('qe-project-search').value='';
  document.getElementById('qe-project').value='';
  onQeProjectChange3();
  document.getElementById('qe-hours').value='';
  document.getElementById('qe-note').value='';
  renderQH();renderWeek();
}

// ═══ WEEK ═══
function changeWeek(dir){const d=parseYMD(selectedWeek);d.setDate(d.getDate()+dir*7);selectedWeek=localYMD(d);renderWeek()}
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
  return`<div class="entry-card" style="border-left-color:${safeColor(usr?.color)}"><div class="entry-hours">${e.hours}h</div><div class="entry-client">${esc(cl?.name||'?')}</div><div class="entry-project">${esc(pr?.name||'?')}</div><div class="entry-activity">${esc(ac?.name||'?')}</div>${showU?`<div class="entry-user">${esc(usr?.name?.split(' ')[0])}</div>`:''}${e.note?`<div class="entry-note">${esc(e.note)}</div>`:''}${can?`<div class="entry-actions"><button class="mini-btn" data-action="edit-entry" data-id="${e.id}">✏</button><button class="mini-btn danger" data-action="delete-entry" data-id="${e.id}">🗑</button></div>`:''}</div>`;
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
    case 'set-status-active': setProjectStatus(id,'active'); break;
    case 'set-status-completed': setProjectStatus(id,'completed'); break;
    case 'set-status-suspended': setProjectStatus(id,'suspended'); break;
    case 'delete-activity': delAct(pid, aid); break;
    case 'edit-activity': editActModal(pid, aid); break;
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
      ${clients.map(c=>`<option value="${c.id}" ${c.id===e.clientId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Commessa</label><select id="me-project" onchange="onEditProjectChange()">
      ${projects.map(p=>`<option value="${p.id}" ${p.id===e.projectId?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Attività</label><select id="me-activity">
      ${acts.map(a=>`<option value="${a.id}" ${a.id===e.activityId?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Data</label><input type="date" id="me-date" value="${e.date}"></div>
    <div class="modal-field"><label>Ore</label><input type="number" id="me-hours" value="${e.hours}" min="0.25" max="24" step="0.25"></div>
    <div class="modal-field"><label>Nota</label><input type="text" id="me-note" value="${esc(e.note||'')}"></div>
    <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveEntryEdit('${id}')">Salva</button></div>`);
}
function onEditClientChange(){
  const cid=document.getElementById('me-client').value;
  const ps=document.getElementById('me-project');
  const projs=db.projects.filter(p=>p.clientId===cid&&p.status==='active');
  ps.innerHTML=projs.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  onEditProjectChange();
}
function onEditProjectChange(){
  const pid=document.getElementById('me-project').value;
  const as=document.getElementById('me-activity');
  const proj=db.projects.find(p=>p.id===pid);
  const acts=proj?.activities||[];
  as.innerHTML=acts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('');
}
async function saveEntryEdit(id){
  const e=db.entries.find(x=>x.id===id);if(!e)return;
  const h=parseFloat(document.getElementById('me-hours').value);
  if(isNaN(h)||h<=0||h>24){showToast('Ore non valide','error');return}
  const upd={
    client_id:document.getElementById('me-client').value,
    project_id:document.getElementById('me-project').value,
    activity_id:document.getElementById('me-activity').value||null,
    date:document.getElementById('me-date').value,
    hours:h,
    note:document.getElementById('me-note').value
  };
  closeModal();
  const ok=await dbWrite(supa.from('entries').update(upd).eq('id',id),'Aggiornata');
  if(ok)renderWeek();
}
async function delEntry(id){
  if(!confirm('Eliminare questa registrazione?'))return;
  const ok=await dbWrite(supa.from('entries').delete().eq('id',id),'Rimossa');
  if(ok)renderWeek();
}

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
let projReportFilters={search:'',clientId:'',status:'',sort:'deadline'};

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
    fromDate=localYMD(new Date(now.getFullYear(),now.getMonth(),1));
    toDate=localYMD(new Date(now.getFullYear(),now.getMonth()+1,0));
  }else if(reportFilters.period==='last-month'){
    const now=new Date();
    fromDate=localYMD(new Date(now.getFullYear(),now.getMonth()-1,1));
    toDate=localYMD(new Date(now.getFullYear(),now.getMonth(),0));
  }else if(reportFilters.period==='current-year'){
    const now=new Date();
    fromDate=localYMD(new Date(now.getFullYear(),0,1));
    toDate=localYMD(new Date(now.getFullYear(),11,31));
  }else if(reportFilters.period==='last-year'){
    const now=new Date();
    fromDate=localYMD(new Date(now.getFullYear()-1,0,1));
    toDate=localYMD(new Date(now.getFullYear()-1,11,31));
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
    filterClient.innerHTML='<option value="">Tutti i clienti</option>'+db.clients.map(c=>`<option value="${c.id}" ${reportFilters.clientId===c.id?'selected':''}>${esc(c.name)}</option>`).join('');
  }
  
  const filterProject=document.getElementById('filter-project');
  if(filterProject){
    filterProject.innerHTML='<option value="">Tutte le commesse</option>'+db.projects.filter(p=>isProjectVisible(p)).map(p=>{
      const cl=db.clients.find(c=>c.id===p.clientId);
      return`<option value="${p.id}" ${reportFilters.projectId===p.id?'selected':''}>${esc(p.code)} - ${esc(p.name)} (${esc(cl?.name||'?')})</option>`;
    }).join('');
  }
  
  const filterUser=document.getElementById('filter-user');
  if(filterUser&&_a()){
    filterUser.innerHTML='<option value="">Tutti gli utenti</option>'+db.users.map(u=>`<option value="${u.id}" ${reportFilters.userId===u.id?'selected':''}>${esc(u.name)}</option>`).join('');
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
  else{const mx=Math.max(...ce.map(([,d])=>d.h),1);bd.innerHTML=ce.map(([n,d])=>`<div class="breakdown-row"><div class="breakdown-name">${esc(n)}</div><div class="breakdown-bar"><div class="breakdown-fill" style="width:${d.h/mx*100}%;background:linear-gradient(90deg,var(--accent),var(--green))"></div></div><div class="breakdown-stats"><span>${d.h.toFixed(1)}h</span>${_a()?`<span style="color:var(--text-dim)">€${d.r.toFixed(0)}</span><span style="color:${d.r-d.c>=0?'var(--green)':'var(--red)'};font-weight:600">+€${(d.r-d.c).toFixed(0)}</span>`:''}</div></div>`).join('')}

  // PROJECT BREAKDOWN WITH DONUTS
  renderProjectBreakdown(ents);

  const all=ents.slice(-100).reverse();
  document.getElementById('recent-table').innerHTML=`<table><thead><tr><th>Data</th>${_a()?'<th>Utente</th>':''}<th>Cliente</th><th>Commessa</th><th>Attività</th><th>Ore</th>${_a()?'<th>Costo</th><th>Ricavo</th>':''}</tr></thead><tbody>${all.map(e=>{const cl=db.clients.find(c=>c.id===e.clientId),pr=db.projects.find(p=>p.id===e.projectId),ac=pr?.activities?.find(a=>a.id===e.activityId),usr=db.users.find(u=>u.id===e.userId);return`<tr><td>${fmtDate(e.date)}</td>${_a()?`<td><span class="user-tag" style="background:${safeColor(usr?.color)}22;color:${safeColor(usr?.color)}">${esc(usr?.name?.split(' ')[0])}</span></td>`:''}<td>${esc(cl?.name||'?')}</td><td>${esc(pr?.name||'?')}</td><td>${esc(ac?.name||'?')}</td><td style="font-weight:700">${e.hours}h</td>${_a()?`<td>€${(e.hours*e.costRate).toFixed(0)}</td><td>€${(e.hours*e.clientRate).toFixed(0)}</td>`:''}</tr>`}).join('')}</tbody></table>`;
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

    const sC=proj.status==='active'?'var(--green)':proj.status==='completed'?'var(--accent)':'var(--orange)';
    const sL=proj.status==='active'?'Attivo':proj.status==='completed'?'Completato':'Sospeso';
    return`<div class="proj-donut-card">
      <div class="proj-donut-header">
        <div>
          <div class="proj-donut-title">${esc(proj.code||'—')} - ${esc(proj.name)}</div>
          <div class="proj-donut-client">${esc(client?.name||'?')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px"><span style="background:${sC}22;color:${sC};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600">${sL}</span><div class="proj-donut-hours">${data.hours.toFixed(1)}h</div></div>
      </div>
      <div class="proj-donut-content">
        <div class="proj-donut-chart">${donutSvg}<div class="proj-donut-center"><div class="proj-donut-center-val">${data.hours.toFixed(0)}h</div><div class="proj-donut-center-lab">TOTALE</div></div></div>
        <div class="proj-donut-legend">${actEntries.map((a,i)=>`<div class="proj-donut-item"><div class="proj-donut-color" style="background:${colors[i%colors.length]}"></div><div class="proj-donut-label">${esc(a.name)}</div><div class="proj-donut-value">${a.hours.toFixed(1)}h<span class="proj-donut-pct">${a.pct.toFixed(0)}%</span></div></div>`).join('')}</div>
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
// ═══ BACKUP (solo export: i backup veri sono quelli automatici di Supabase) ═══
function renderBackupTab(){
  const el=document.getElementById('mgmt-content');
  el.innerHTML=`<div class="mgmt-panel" style="max-width:800px">
    <h3 style="margin:0 0 12px;color:var(--accent)">💾 Backup</h3>
    <p style="color:var(--text-dim);font-size:14px;margin:0 0 16px">
      I dati sono protetti dai <b>backup automatici di Supabase</b> (Dashboard → Database → Backups).
      Da qui puoi scaricare un export JSON dei dati visibili al tuo account, da conservare come copia periodica.
    </p>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <button class="add-btn-sm" onclick="exportJSON()">⬇ Esporta JSON</button>
    </div>
  </div>`;
}

function exportJSON(){const b=new Blob([JSON.stringify(db,null,2)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=`timetrack_${todayStr()}.json`;a.click();URL.revokeObjectURL(u);showToast('Esportato!')}

// ═══ PROJECT REPORT ═══
function projectStats(p){
  const pe=db.entries.filter(e=>e.projectId===p.id&&(_a()||e.userId===currentUser.id));
  const uH=pe.reduce((s,e)=>s+e.hours,0),uB=_a()?pe.reduce((s,e)=>s+e.hours*e.costRate,0):0;
  const hPraw=p.budgetHours?uH/p.budgetHours*100:0;
  const bPraw=_a()&&p.budget?uB/p.budget*100:0;
  const dlDiff=p.deadline?Math.ceil((new Date(p.deadline)-new Date())/(864e5)):null;
  return{pe,uH,uB,hP:Math.min(hPraw,100),bP:Math.min(bPraw,100),hPraw,bPraw,dlDiff};
}
function projectRisk(p,st){
  if(p.status==='completed')return{level:null,label:''};
  const overdue=st.dlDiff!==null&&st.dlDiff<0;
  const overHours=p.budgetHours&&st.hPraw>=100;
  const overBudget=_a()&&p.budget&&st.bPraw>=100;
  if(overdue||overHours||overBudget)return{level:'danger',label:overdue?'Scaduta':overBudget?'Fuori budget':'Ore esaurite'};
  const nearDl=st.dlDiff!==null&&st.dlDiff>=0&&st.dlDiff<14;
  const nearHours=p.budgetHours&&st.hPraw>85;
  const nearBudget=_a()&&p.budget&&st.bPraw>85;
  if(nearDl||nearHours||nearBudget)return{level:'warn',label:nearDl?`Scade tra ${st.dlDiff}gg`:nearBudget?'Budget quasi esaurito':'Ore quasi esaurite'};
  return{level:null,label:''};
}
function renderProjectReport(){
  const g=document.getElementById('proj-report-grid');
  projReportFilters.search=(document.getElementById('prf-search')?.value||'').toLowerCase();
  projReportFilters.clientId=document.getElementById('prf-client')?.value||'';
  projReportFilters.status=document.getElementById('prf-status')?.value||'';
  projReportFilters.sort=document.getElementById('prf-sort')?.value||'deadline';
  const f=projReportFilters;
  const csel=document.getElementById('prf-client');
  if(csel)csel.innerHTML='<option value="">— Tutti i clienti —</option>'+db.clients.map(c=>`<option value="${c.id}" ${f.clientId===c.id?'selected':''}>${esc(c.name)}</option>`).join('');
  const projs=db.projects.filter(p=>{
    if(f.status&&p.status!==f.status)return false;
    if(!(p.status==='active'||db.entries.some(e=>e.projectId===p.id)))return false;
    if(f.clientId&&p.clientId!==f.clientId)return false;
    if(f.search){const cl=db.clients.find(c=>c.id===p.clientId);if(!(((p.code||'')+' '+p.name+' '+(cl?.name||'')).toLowerCase().includes(f.search)))return false}
    return true;
  });
  const rows=projs.map(p=>{const st=projectStats(p);return{p,st,risk:projectRisk(p,st)}});
  rows.sort((a,b)=>{
    switch(f.sort){
      case 'hoursPct':return b.st.hPraw-a.st.hPraw;
      case 'hours':return b.st.uH-a.st.uH;
      case 'budget':return (b.p.budget||0)-(a.p.budget||0);
      case 'name':return (a.p.name||'').localeCompare(b.p.name||'');
      default:return (a.p.deadline?new Date(a.p.deadline).getTime():Infinity)-(b.p.deadline?new Date(b.p.deadline).getTime():Infinity);
    }
  });
  const kpiEl=document.getElementById('proj-kpi-row');
  if(kpiEl){
    const totH=rows.reduce((s,r)=>s+r.st.uH,0);
    const nActive=rows.filter(r=>r.p.status==='active').length;
    const nRisk=rows.filter(r=>r.risk.level==='danger').length;
    const totCost=_a()?rows.reduce((s,r)=>s+r.st.uB,0):0;
    const totBudget=_a()?rows.reduce((s,r)=>s+(r.p.budget||0),0):0;
    kpiEl.innerHTML=[
      {l:'Commesse',v:rows.length,s:`${nActive} attive`},
      {l:'Ore registrate',v:totH.toFixed(1)+'h',s:''},
      ...(_a()?[{l:'Budget consumato',v:'€'+totCost.toFixed(0),s:totBudget?'su €'+totBudget.toFixed(0):''}]:[]),
      {l:'A rischio',v:nRisk,s:nRisk?'da verificare':'tutto ok',c:nRisk?'var(--red)':'var(--green)'}
    ].map(k=>`<div class="proj-kpi"><div class="proj-kpi-val"${k.c?` style="color:${k.c}"`:''}>${k.v}</div><div class="proj-kpi-label">${k.l}</div>${k.s?`<div class="proj-kpi-sub">${k.s}</div>`:''}</div>`).join('');
  }
  if(!rows.length){g.innerHTML='<p class="empty-text">Nessuna commessa</p>';return}
  g.innerHTML=rows.map(({p,st,risk})=>{
    const cl=db.clients.find(c=>c.id===p.clientId);
    let dlI='',dlP=0,dlC='var(--green)';
    if(p.deadline){const diff=st.dlDiff;
      if(diff<0){dlI=`Scaduta da ${Math.abs(diff)}gg`;dlC='var(--red)';dlP=100}
      else if(diff<30){dlI=`${diff}gg rimasti`;dlC='var(--orange)';dlP=80}
      else{dlI=`${diff}gg rimasti`;dlP=Math.min(30,100)}}
    const hC=st.hP>90?'var(--red)':st.hP>70?'var(--orange)':'var(--accent)';
    const bC=st.bP>90?'var(--red)':st.bP>70?'var(--orange)':'var(--green)';
    const sC=p.status==='active'?'var(--green)':p.status==='completed'?'var(--accent)':'var(--orange)';
    const sL=p.status==='active'?'Attivo':p.status==='completed'?'Completato':'Sospeso';
    const riskBadge=risk.level?`<span class="proj-risk-badge ${risk.level}">${risk.label}</span>`:'';
    return`<div class="proj-card" style="cursor:pointer" onclick="openProjectDetail('${p.id}')">
      <div class="proj-card-head"><div><div class="proj-card-title">${esc(p.code||'—')} - ${esc(p.name)}</div><div class="proj-card-client">${esc(cl?.name||'?')}</div></div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">${riskBadge}<span class="proj-status" style="background:${sC}22;color:${sC}">${sL}</span></div></div>
      <div class="proj-meters">
        <div><div class="proj-meter-label"><span>Ore</span><span style="font-family:var(--mono);font-weight:600">${st.uH.toFixed(1)} / ${p.budgetHours||'∞'}h</span></div><div class="proj-meter-track"><div class="proj-meter-fill" style="width:${st.hP}%;background:${hC}"></div></div></div>
        ${_a()&&p.budget?`<div><div class="proj-meter-label"><span>Budget</span><span style="font-family:var(--mono);font-weight:600">€${st.uB.toFixed(0)} / €${p.budget}</span></div><div class="proj-meter-track"><div class="proj-meter-fill" style="width:${st.bP}%;background:${bC}"></div></div></div>`:''}
        ${p.deadline?`<div><div class="proj-meter-label"><span>Scadenza: ${fmtDate(p.deadline)}</span><span style="color:${dlC};font-weight:600">${dlI}</span></div><div class="proj-meter-track"><div class="proj-meter-fill" style="width:${dlP}%;background:${dlC}"></div></div></div>`:''}
      </div>
      <div class="proj-activities"><strong>Attività:</strong><div class="proj-act-list">${(p.activities||[]).map(a=>{const aH=st.pe.filter(e=>e.activityId===a.id).reduce((s,e)=>s+e.hours,0);return`<span class="proj-act-tag">${esc(a.name)} <b style="color:var(--accent)">${aH}h</b></span>`}).join('')}${!p.activities?.length?'<span style="font-style:italic">Nessuna</span>':''}</div></div>
    </div>`}).join('');
}
function openProjectDetail(id){
  const p=db.projects.find(x=>x.id===id);if(!p)return;
  const cl=db.clients.find(c=>c.id===p.clientId);
  const st=projectStats(p);
  const hC=st.hP>90?'var(--red)':st.hP>70?'var(--orange)':'var(--accent)';
  const bC=st.bP>90?'var(--red)':st.bP>70?'var(--orange)':'var(--green)';
  const sC=p.status==='active'?'var(--green)':p.status==='completed'?'var(--accent)':'var(--orange)';
  const sL=p.status==='active'?'Attivo':p.status==='completed'?'Completato':'Sospeso';
  let dlI='',dlC='var(--green)';
  if(p.deadline){const diff=st.dlDiff;if(diff<0){dlI=`Scaduta da ${Math.abs(diff)}gg`;dlC='var(--red)'}else if(diff<30){dlI=`${diff}gg rimasti`;dlC='var(--orange)'}else{dlI=`${diff}gg rimasti`}}
  const actHtml=(p.activities||[]).map(a=>{const aH=st.pe.filter(e=>e.activityId===a.id).reduce((s,e)=>s+e.hours,0);return`<span class="proj-act-tag">${esc(a.name)} <b style="color:var(--accent)">${aH}h</b></span>`}).join('')||'<span style="font-style:italic;color:var(--text-dim)">Nessuna attività</span>';
  const byUser={};st.pe.forEach(e=>{byUser[e.userId]=(byUser[e.userId]||0)+e.hours});
  const userHtml=Object.entries(byUser).sort((a,b)=>b[1]-a[1]).map(([uid,h])=>{const u=db.users.find(x=>x.id===uid);return`<span class="proj-act-tag"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${safeColor(u?.color)};margin-right:4px"></span>${esc(u?.name||'?')} <b style="color:var(--accent)">${h}h</b></span>`}).join('')||'<span style="font-style:italic;color:var(--text-dim)">Nessuna registrazione</span>';
  const recent=[...st.pe].sort((a,b)=>(b.date+(b.createdAt||'')).localeCompare(a.date+(a.createdAt||''))).slice(0,8);
  const recentHtml=recent.map(e=>{const u=db.users.find(x=>x.id===e.userId);const a=p.activities?.find(x=>x.id===e.activityId);return`<div style="display:flex;gap:8px;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)"><span style="font-family:var(--mono);color:var(--text-dim);min-width:70px">${fmtDate(e.date)}</span>${_a()?`<span style="min-width:70px">${esc(u?.name?.split(' ')[0]||'?')}</span>`:''}<span style="flex:1;color:var(--text-dim)">${esc(a?.name||'—')}${e.note?' · '+esc(e.note):''}</span><span style="font-weight:600">${e.hours}h</span></div>`}).join('')||'<div style="color:var(--text-dim);font-size:12px;padding:8px 0">Nessuna registrazione</div>';
  const stBtn=(s,l,col,bg)=>`<button class="mini-btn" onclick="setProjectStatus('${p.id}','${s}').then(()=>{renderProjectReport();openProjectDetail('${p.id}')})"${p.status===s?` style="background:${bg};color:${col};border-color:${col}"`:''}>${l}</button>`;
  openModal(`<h3>${esc(p.code||'—')} - ${esc(p.name)}</h3>
    <div style="display:flex;gap:10px;align-items:center;margin:-6px 0 14px;flex-wrap:wrap"><span class="proj-card-client">${esc(cl?.name||'?')}</span><span style="color:var(--text-dim);font-size:12px">Ref: ${esc(p.referente||'—')}</span><span class="proj-status" style="background:${sC}22;color:${sC}">${sL}</span></div>
    <div class="proj-meters">
      <div><div class="proj-meter-label"><span>Ore</span><span style="font-family:var(--mono);font-weight:600">${st.uH.toFixed(1)} / ${p.budgetHours||'∞'}h</span></div><div class="proj-meter-track"><div class="proj-meter-fill" style="width:${st.hP}%;background:${hC}"></div></div></div>
      ${_a()&&p.budget?`<div><div class="proj-meter-label"><span>Budget</span><span style="font-family:var(--mono);font-weight:600">€${st.uB.toFixed(0)} / €${p.budget}</span></div><div class="proj-meter-track"><div class="proj-meter-fill" style="width:${st.bP}%;background:${bC}"></div></div></div>`:''}
      ${p.deadline?`<div><div class="proj-meter-label"><span>Scadenza: ${fmtDate(p.deadline)}</span><span style="color:${dlC};font-weight:600">${dlI}</span></div></div>`:''}
    </div>
    <div class="proj-activities"><strong>Ore per attività:</strong><div class="proj-act-list">${actHtml}</div></div>
    ${_a()?`<div class="proj-activities"><strong>Ore per utente:</strong><div class="proj-act-list">${userHtml}</div></div>`:''}
    <div class="proj-activities"><strong>Ultime registrazioni:</strong><div style="margin-top:6px">${recentHtml}</div></div>
    <div class="modal-actions" style="flex-wrap:wrap;gap:6px">
      ${stBtn('active','● Attivo','var(--green)','rgba(46,174,109,.18)')}
      ${stBtn('completed','✓ Completato','var(--accent)','rgba(58,123,232,.18)')}
      ${stBtn('suspended','⏸ Sospeso','var(--orange)','rgba(232,163,58,.18)')}
      <button class="btn-outline" onclick="editProjectModal('${p.id}')">✏ Modifica</button>
      <button class="add-btn-sm" onclick="closeModal()">Chiudi</button>
    </div>`);
}
window.openProjectDetail=openProjectDetail;

// ═══ MANAGE ═══
function renderManage(){
  document.getElementById('mgmt-tabs').innerHTML=[{id:'client',l:'Clienti'},{id:'project',l:'Commesse'},{id:'user',l:'Utenti'},{id:'rates',l:'💰 Tariffe'},{id:'backup',l:'💾 Backup'}].map(t=>`<button class="mgmt-tab ${activeMgmt===t.id?'active':''}" onclick="toggleMgmt('${t.id}')">${t.l}</button>`).join('');
  renderMC();
}
function toggleMgmt(id){activeMgmt=activeMgmt===id?null:id;mgmtProjectFilter={clientId:'',search:''};renderManage()}
function _mgmtFilteredProjects(){
  return db.projects.filter(p=>{const cl=db.clients.find(c=>c.id===p.clientId);const mc=!mgmtProjectFilter.clientId||p.clientId===mgmtProjectFilter.clientId;const s=mgmtProjectFilter.search;const ms=!s||(p.code||'').toLowerCase().includes(s)||p.name.toLowerCase().includes(s)||(cl?.name||'').toLowerCase().includes(s);return mc&&ms;});
}
function _mgmtProjRow(p){
  const cl=db.clients.find(c=>c.id===p.clientId);
  return`<div class="mgmt-item" style="flex-direction:column;align-items:stretch"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span class="mgmt-item-name">${esc(p.code||'—')} - ${esc(p.name)}</span><span class="mgmt-item-meta">${esc(cl?.name||'?')}</span><span class="mgmt-item-meta">Ref: ${esc(p.referente||'—')}</span><span class="mgmt-item-meta">€${p.budget||0}</span><span class="mgmt-item-meta">${p.budgetHours||0}h</span><span class="mgmt-item-meta">⏰ ${fmtDate(p.deadline)}</span><span class="status-badge" style="background:${p.status==='active'?'rgba(46,174,109,.13)':p.status==='completed'?'rgba(58,123,232,.13)':'rgba(232,163,58,.13)'};color:${p.status==='active'?'var(--green)':p.status==='completed'?'var(--accent)':'var(--orange)'}"}>${p.status==='active'?'Attivo':p.status==='completed'?'Completato':'Sospeso'}</span>${(p.assignedUsers&&p.assignedUsers.length>0)?`<span style="display:flex;align-items:center;gap:4px;margin-left:4px">${p.assignedUsers.map(uid=>{const u=db.users.find(x=>x.id===uid);return u?`<span title="${esc(u.name)}" style="width:20px;height:20px;border-radius:50%;background:${safeColor(u.color)};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;flex-shrink:0">${esc(u.name.charAt(0).toUpperCase())}</span>`:''}).join('')}</span>`:`<span class="mgmt-item-meta" style="font-size:11px;color:var(--text-dim)">Tutti</span>`}<div class="mgmt-item-actions"><button class="mini-btn" data-action="set-status-active" data-id="${p.id}" style="${p.status==='active'?'background:rgba(46,174,109,.18);color:var(--green);border-color:var(--green)':''}" title="Imposta Attivo">● Attivo</button><button class="mini-btn" data-action="set-status-completed" data-id="${p.id}" style="${p.status==='completed'?'background:rgba(58,123,232,.18);color:var(--accent);border-color:var(--accent)':''}" title="Imposta Completato">✓ Completato</button><button class="mini-btn" data-action="set-status-suspended" data-id="${p.id}" style="${p.status==='suspended'?'background:rgba(232,163,58,.18);color:var(--orange);border-color:var(--orange)':''}" title="Imposta Sospeso">⏸ Sospeso</button><button class="mini-btn" data-action="edit-project" data-id="${p.id}">✏</button><button class="mini-btn danger" data-action="delete-project" data-id="${p.id}">🗑</button></div></div><div class="sub-list"><div class="sub-list-title">Attività della commessa</div>${(p.activities||[]).map(a=>`<div class="sub-item"><span class="sub-item-name">${esc(a.name)}</span><button class="mini-btn" data-action="edit-activity" data-pid="${p.id}" data-aid="${a.id}">✏</button><button class="mini-btn danger" data-action="delete-activity" data-pid="${p.id}" data-aid="${a.id}">🗑</button></div>`).join('')}<div class="sub-add"><input id="sa-${p.id}" placeholder="Nuova attività" onkeydown="if(event.key==='Enter')addAct('${p.id}')"><button class="add-btn-sm" onclick="addAct('${p.id}')">+</button></div></div></div>`;
}
function filterMgmtProjects(){
  mgmtProjectFilter.clientId=document.getElementById('mpf-client').value;
  mgmtProjectFilter.search=document.getElementById('mpf-search').value.toLowerCase();
  const listEl=document.getElementById('mpf-list');if(!listEl)return;
  listEl.innerHTML=_mgmtFilteredProjects().map(_mgmtProjRow).join('')||'<div style="color:var(--text-dim);padding:16px 0;text-align:center;font-size:13px">Nessuna commessa trovata</div>';
}
function renderMC(){
  const el=document.getElementById('mgmt-content');if(!activeMgmt){el.innerHTML='';return}
  if(activeMgmt==='client'){
    el.innerHTML=`<div class="mgmt-panel"><div class="mgmt-list">${db.clients.map(c=>`<div class="mgmt-item"><span class="mgmt-item-name">${esc(c.name)}</span><span class="mgmt-item-meta">Ref: ${esc(c.referente||'—')}</span>${c.email?`<span class="mgmt-item-meta">${esc(c.email)}</span>`:''}<span class="status-badge" style="background:${c.active?'rgba(46,174,109,.13)':'rgba(136,136,136,.13)'};color:${c.active?'var(--green)':'#888'}">${c.active?'Attivo':'Inattivo'}</span><div class="mgmt-item-actions"><button class="mini-btn" data-action="edit-client" data-id="${c.id}">✏</button><button class="mini-btn danger" data-action="delete-client" data-id="${c.id}">🗑</button></div></div>`).join('')}</div><div class="mgmt-form"><input id="mc-name" placeholder="Nome cliente"><input id="mc-ref" placeholder="Referente"><input id="mc-email" type="email" placeholder="Email"><button class="add-btn-sm" onclick="addClient()">+ Aggiungi</button></div></div>`;
  } else if(activeMgmt==='project'){
    el.innerHTML=`<div class="mgmt-panel"><div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><select id="mpf-client" onchange="filterMgmtProjects()" style="flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px"><option value="">— Tutti i clienti —</option>${db.clients.map(c=>`<option value="${c.id}" ${mgmtProjectFilter.clientId===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select><input id="mpf-search" placeholder="Cerca per codice, nome, cliente..." value="${esc(mgmtProjectFilter.search)}" oninput="filterMgmtProjects()" style="flex:2;min-width:160px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;outline:none"></div><div id="mpf-list" class="mgmt-list">${_mgmtFilteredProjects().map(_mgmtProjRow).join('')||'<div style="color:var(--text-dim);padding:16px 0;text-align:center;font-size:13px">Nessuna commessa trovata</div>'}</div><div class="mgmt-form"><select id="mp-client"><option value="">— Cliente —</option>${db.clients.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input id="mp-name" placeholder="Nome commessa"><input id="mp-ref" placeholder="Referente"><input id="mp-budget" type="number" placeholder="Budget €"><input id="mp-hours" type="number" placeholder="Budget ore"><input id="mp-deadline" type="date"><button class="add-btn-sm" onclick="addProject()">+ Aggiungi</button></div></div>`;
  } else if(activeMgmt==='user'){
    el.innerHTML=`<div class="mgmt-panel"><div class="mgmt-list">${db.users.map(u=>`<div class="mgmt-item" style="border-left:3px solid ${safeColor(u.color)}"><span class="mgmt-item-name">${esc(u.name)}</span><span class="mgmt-item-meta">@${esc(u.username||'—')}</span>${u.email?`<span class="mgmt-item-meta">${esc(u.email)}</span>`:''}<span class="mgmt-item-meta">${esc(u.role)}</span><span class="status-badge" style="background:${u.active!==false?'rgba(46,174,109,.13)':'rgba(136,136,136,.13)'};color:${u.active!==false?'var(--green)':'#888'}">${u.active!==false?'Attivo':'Sospeso'}</span><div class="mgmt-item-actions">${u.role!=='admin'&&u.id!==currentUser.id?`<button class="mini-btn${u.active===false?'':' danger'}" data-action="toggle-user-active" data-id="${u.id}" title="${u.active===false?'Riattiva utente':'Sospendi utente'}">${u.active===false?'✓ Riattiva':'⏸ Sospendi'}</button>`:''}<button class="mini-btn" data-action="edit-user" data-id="${u.id}" title="Modifica">✏</button><button class="mini-btn" data-action="reset-pwd" data-id="${u.id}" title="Genera link reimpostazione password">🔑</button></div></div>`).join('')}</div><div class="mgmt-form"><button class="add-btn-sm" onclick="addUser()">+ Nuovo utente (invito)</button></div></div>`;
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
  const uName=id=>id?esc(db.users.find(u=>u.id===id)?.name||'?'):'(tutti)';
  const cName=id=>id?esc(db.clients.find(c=>c.id===id)?.name||'?'):'(tutti)';
  const pName=id=>id?esc(db.projects.find(p=>p.id===id)?.name||'?'):'(tutte)';
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
      <select id="nr-user"><option value="">— Utente (tutti) —</option>${db.users.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <select id="nr-client"><option value="">— Cliente (tutti) —</option>${db.clients.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <select id="nr-project"><option value="">— Commessa (tutte) —</option>${db.projects.map(p=>`<option value="${p.id}">${esc(p.code)} ${esc(p.name)}</option>`).join('')}</select>
      <input id="nr-cost" type="number" step="0.5" placeholder="Costo €/h (vuoto=non impostato)">
      <input id="nr-rev" type="number" step="0.5" placeholder="Ricavo €/h (vuoto=non impostato)">
      <input id="nr-from" type="date" placeholder="Valida dal" title="Valida dal">
      <input id="nr-to" type="date" placeholder="Valida fino al (vuoto=attiva)" title="Valida fino al">
      <button class="add-btn-sm" onclick="addRate()">+ Aggiungi Tariffa</button>
    </div>
  </div>`;
}
async function addRate(){
  const userId=document.getElementById('nr-user').value||null;
  const clientId=document.getElementById('nr-client').value||null;
  const projectId=document.getElementById('nr-project').value||null;
  const costVal=document.getElementById('nr-cost').value;
  const revVal=document.getElementById('nr-rev').value;
  const from=document.getElementById('nr-from').value;
  const to=document.getElementById('nr-to').value||null;
  if(!from){showToast('Data inizio obbligatoria','error');return}
  if(costVal===''&&revVal===''){showToast('Inserisci almeno un valore (costo o ricavo)','error');return}
  const ok=await dbWrite(supa.from('rates').insert({id:gid(),user_id:userId,client_id:clientId,project_id:projectId,cost_rate:costVal!==''?parseFloat(costVal):null,client_rate:revVal!==''?parseFloat(revVal):null,valid_from:from,valid_to:to}),'Tariffa aggiunta');
  if(ok)renderMC();
}
function editRateModal(id){
  const r=db.rates.find(x=>x.id===id);if(!r)return;
  openModal(`<h3>✏ Modifica Tariffa</h3>
    <div class="modal-field"><label>Utente</label><select id="er-user"><option value="">— Tutti —</option>${db.users.map(u=>`<option value="${u.id}" ${u.id===r.userId?'selected':''}>${esc(u.name)}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Cliente</label><select id="er-client"><option value="">— Tutti —</option>${db.clients.map(c=>`<option value="${c.id}" ${c.id===r.clientId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Commessa</label><select id="er-project"><option value="">— Tutte —</option>${db.projects.map(p=>`<option value="${p.id}" ${p.id===r.projectId?'selected':''}>${esc(p.code)} ${esc(p.name)}</option>`).join('')}</select></div>
    <div class="modal-field"><label>Costo €/h</label><input type="number" id="er-cost" step="0.5" value="${r.costRate!=null?r.costRate:''}" placeholder="vuoto = non impostato"></div>
    <div class="modal-field"><label>Ricavo €/h</label><input type="number" id="er-rev" step="0.5" value="${r.clientRate!=null?r.clientRate:''}" placeholder="vuoto = non impostato"></div>
    <div class="modal-field"><label>Valida dal</label><input type="date" id="er-from" value="${r.from}"></div>
    <div class="modal-field"><label>Valida fino al</label><input type="date" id="er-to" value="${r.to||''}"></div>
    <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveRateEdit('${id}')">Salva</button></div>`);
}
async function saveRateEdit(id){
  const r=db.rates.find(x=>x.id===id);if(!r)return;
  const cv=document.getElementById('er-cost').value;
  const rv=document.getElementById('er-rev').value;
  const upd={
    user_id:document.getElementById('er-user').value||null,
    client_id:document.getElementById('er-client').value||null,
    project_id:document.getElementById('er-project').value||null,
    cost_rate:cv!==''?parseFloat(cv):null,
    client_rate:rv!==''?parseFloat(rv):null,
    valid_from:document.getElementById('er-from').value,
    valid_to:document.getElementById('er-to').value||null
  };
  closeModal();
  const ok=await dbWrite(supa.from('rates').update(upd).eq('id',id),'Tariffa aggiornata');
  if(ok)renderMC();
}
async function delRate(id){
  if(!confirm('Eliminare questa tariffa?'))return;
  const ok=await dbWrite(supa.from('rates').delete().eq('id',id),'Eliminata');
  if(ok)renderMC();
}

// CRUD Clients
async function addClient(){const n=document.getElementById('mc-name').value.trim(),ref=document.getElementById('mc-ref').value.trim(),email=document.getElementById('mc-email').value.trim();if(!n){showToast('Nome richiesto','error');return}const ok=await dbWrite(supa.from('clients').insert({id:gid(),name:n,referente:ref,email,active:true}),n+' aggiunto');if(ok)renderManage()}
function editClientModal(id){const c=db.clients.find(x=>x.id===id);if(!c)return;openModal(`<h3>✏ Modifica Cliente</h3><div class="modal-field"><label>Nome</label><input id="ec-name" value="${esc(c.name)}"></div><div class="modal-field"><label>Referente</label><input id="ec-ref" value="${esc(c.referente||'')}"></div><div class="modal-field"><label>Email</label><input type="email" id="ec-email" value="${esc(c.email||'')}"></div><div class="modal-field"><label>Stato</label><select id="ec-active"><option value="true" ${c.active?'selected':''}>Attivo</option><option value="false" ${!c.active?'selected':''}>Inattivo</option></select></div><div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveClientEdit('${id}')">Salva</button></div>`)}
async function saveClientEdit(id){const c=db.clients.find(x=>x.id===id);if(!c)return;const upd={name:document.getElementById('ec-name').value.trim(),referente:document.getElementById('ec-ref').value.trim(),email:document.getElementById('ec-email').value.trim(),active:document.getElementById('ec-active').value==='true'};closeModal();const ok=await dbWrite(supa.from('clients').update(upd).eq('id',id),'Aggiornato');if(ok)renderManage()}
async function delClient(id){if(!confirm('Eliminare il cliente e tutte le sue commesse e registrazioni?'))return;const ok=await dbWrite(supa.from('clients').delete().eq('id',id),'Eliminato');if(ok)renderManage()}

// CRUD Projects
async function addProject(){
  const cid=document.getElementById('mp-client').value,n=document.getElementById('mp-name').value.trim(),ref=document.getElementById('mp-ref').value.trim(),b=parseFloat(document.getElementById('mp-budget').value)||0,bh=parseFloat(document.getElementById('mp-hours').value)||0,dl=document.getElementById('mp-deadline').value||null;
  if(!cid){showToast('Seleziona cliente','error');return}
  if(!n){showToast('Nome richiesto','error');return}
  updateSyncStatus('sync');
  // Contatore atomico lato server (solo admin)
  const {data:num,error:numErr}=await supa.rpc('next_project_num');
  if(numErr){console.error(numErr);updateSyncStatus('err');showToast(friendlyDbError(numErr),'error');return}
  const year=new Date().getFullYear().toString().slice(-2);
  const code=String(num).padStart(3,'0')+'/'+year;
  const pid=gid();
  const {error:insErr}=await supa.from('projects').insert({id:pid,client_id:cid,name:n,code,referente:ref,status:'active',budget_hours:bh,deadline:dl,assigned_users:[]});
  if(insErr){console.error(insErr);updateSyncStatus('err');showToast(friendlyDbError(insErr),'error');return}
  const ok=await dbWrite(supa.from('project_finance').upsert({project_id:pid,budget:b}),n+' aggiunta');
  if(ok)renderManage();
}
function editProjectModal(id){const p=db.projects.find(x=>x.id===id);if(!p)return;const au=p.assignedUsers||[];const usersHtml=db.users.map(u=>`<div class="export-check-item"><input type="checkbox" id="ep-usr-${u.id}" ${au.includes(u.id)?'checked':''}><label for="ep-usr-${u.id}" style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:${safeColor(u.color)};display:inline-block"></span>${esc(u.name)}</label></div>`).join('');openModal(`<h3>✏ Modifica Commessa</h3><div class="modal-field"><label>Codice</label><input id="ep-code" value="${esc(p.code||'')}" placeholder="001/26"></div><div class="modal-field"><label>Nome</label><input id="ep-name" value="${esc(p.name)}"></div><div class="modal-field"><label>Cliente</label><select id="ep-client">${db.clients.map(c=>`<option value="${c.id}" ${c.id===p.clientId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div><div class="modal-field"><label>Referente</label><input id="ep-ref" value="${esc(p.referente||'')}"></div><div class="modal-field"><label>Budget €</label><input type="number" id="ep-budget" value="${p.budget||''}"></div><div class="modal-field"><label>Budget Ore</label><input type="number" id="ep-hours" value="${p.budgetHours||''}"></div><div class="modal-field"><label>Data Fine Lavori</label><input type="date" id="ep-deadline" value="${p.deadline||''}"></div><div class="modal-field"><label>Stato</label><select id="ep-status"><option value="active" ${p.status==='active'?'selected':''}>Attivo</option><option value="completed" ${p.status==='completed'?'selected':''}>Completato</option><option value="suspended" ${p.status==='suspended'?'selected':''}>Sospeso</option></select></div><div class="modal-field"><label>Utenti assegnati <span style="color:var(--text-dim);font-weight:400;font-size:10px">(vuoto = tutti)</span></label><div class="export-col-grid" style="margin-top:4px">${usersHtml}</div></div><div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveProjectEdit('${id}')">Salva</button></div>`)}
async function saveProjectEdit(id){
  const p=db.projects.find(x=>x.id===id);if(!p)return;
  const upd={
    code:document.getElementById('ep-code').value.trim(),
    name:document.getElementById('ep-name').value.trim(),
    client_id:document.getElementById('ep-client').value,
    referente:document.getElementById('ep-ref').value.trim(),
    budget_hours:parseFloat(document.getElementById('ep-hours').value)||0,
    deadline:document.getElementById('ep-deadline').value||null,
    status:document.getElementById('ep-status').value,
    assigned_users:db.users.filter(u=>document.getElementById('ep-usr-'+u.id)?.checked).map(u=>u.id)
  };
  const budget=parseFloat(document.getElementById('ep-budget').value)||0;
  closeModal();
  updateSyncStatus('sync');
  const {error:updErr}=await supa.from('projects').update(upd).eq('id',id);
  if(updErr){console.error(updErr);updateSyncStatus('err');showToast(friendlyDbError(updErr),'error');return}
  const ok=await dbWrite(supa.from('project_finance').upsert({project_id:id,budget}),'Commessa aggiornata');
  if(ok)renderManage();
}
async function delProject(id){
  if(!confirm('Eliminare la commessa e tutte le registrazioni associate?'))return;
  const ok=await dbWrite(supa.from('projects').delete().eq('id',id),'Eliminata');
  if(ok)renderManage();
}
async function setProjectStatus(id,status){
  const ok=await dbWrite(supa.from('projects').update({status}).eq('id',id),'Stato aggiornato');
  if(ok)renderManage();
}
window.setProjectStatus=setProjectStatus;

// CRUD Activities (per project)
async function addAct(pid){const inp=document.getElementById('sa-'+pid);const n=inp.value.trim();if(!n){showToast('Nome richiesto','error');return}const ok=await dbWrite(supa.from('activities').insert({id:gid(),project_id:pid,name:n}),n+' aggiunta');if(ok)renderManage()}
function editActModal(pid,aid){const p=db.projects.find(x=>x.id===pid);if(!p)return;const a=p.activities?.find(x=>x.id===aid);if(!a)return;openModal(`<h3>✏ Modifica Attività</h3><div class="modal-field"><label>Nome</label><input id="ea-name" value="${esc(a.name)}"></div><div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveActEdit('${pid}','${aid}')">Salva</button></div>`)}
async function saveActEdit(pid,aid){const n=document.getElementById('ea-name').value.trim();closeModal();const ok=await dbWrite(supa.from('activities').update({name:n}).eq('id',aid),'Aggiornata');if(ok)renderManage()}
async function delAct(pid,aid){if(!confirm('Eliminare questa attività?'))return;const ok=await dbWrite(supa.from('activities').delete().eq('id',aid),'Eliminata');if(ok)renderManage()}

// CRUD Users
// La creazione account passa dalla Edge Function "invite-user" (server-side,
// solo admin): il browser non tocca mai la service_role key. La funzione
// restituisce il link di invito da girare alla persona (nessuna email).
function addUser(){
  openModal(`<h3>➕ Nuovo utente</h3>
    <div class="modal-field"><label>Nome e cognome</label><input id="nu-name" placeholder="Mario Rossi"></div>
    <div class="modal-field"><label>Email (sarà il login)</label><input type="email" id="nu-email" placeholder="mario.rossi@azienda.it"></div>
    <div class="modal-field"><label>Username</label><input id="nu-username" placeholder="mario"></div>
    <div class="modal-field"><label>Ruolo</label><select id="nu-role"><option value="operator">Operatore</option><option value="admin">Admin</option></select></div>
    <div id="nu-error" style="color:var(--red);font-size:13px;display:none;margin-bottom:8px"></div>
    <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" id="nu-submit" onclick="submitNewUser()">Crea e genera link</button></div>`);
  setTimeout(()=>document.getElementById('nu-name')?.focus(),50);
}
async function submitNewUser(){
  const name=document.getElementById('nu-name').value.trim();
  const email=document.getElementById('nu-email').value.trim().toLowerCase();
  const username=document.getElementById('nu-username').value.trim();
  const role=document.getElementById('nu-role').value;
  const err=document.getElementById('nu-error');
  const showErr=m=>{err.textContent=m;err.style.display='block'};
  err.style.display='none';
  if(!name||!username){showErr('Nome e username sono obbligatori');return}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){showErr('Email non valida');return}
  const btn=document.getElementById('nu-submit');
  btn.disabled=true;btn.textContent='Creazione...';
  const {data,error}=await supa.functions.invoke('invite-user',{body:{action:'invite',email,name,username,role}});
  if(error){
    btn.disabled=false;btn.textContent='Crea e genera link';
    showErr(await fnErrorMessage(error,'Creazione non riuscita'));
    return;
  }
  try{await loadAll()}catch(e){console.error(e)}
  showInviteLinkModal(`Utente ${esc(name)} creato`,data.link);
  renderManage();
}
// Modal riutilizzabile: mostra un link di invito/recovery con bottone Copia
function showInviteLinkModal(title,link){
  openModal(`<h3>✅ ${title}</h3>
    <p style="font-size:13px;color:var(--text-dim);margin:0 0 12px">Invia questo link alla persona (WhatsApp, Teams, email...). Cliccandolo imposterà la propria password. <b>Scade in circa 24 ore.</b></p>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="il-link" readonly value="${esc(link)}" style="flex:1;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px" onclick="this.select()">
      <button class="add-btn-sm" onclick="copyInviteLink()">📋 Copia</button>
    </div>
    <div class="modal-actions"><button class="add-btn-sm" onclick="closeModal()">Chiudi</button></div>`);
}
async function copyInviteLink(){
  const el=document.getElementById('il-link');
  try{await navigator.clipboard.writeText(el.value);showToast('Link copiato!')}
  catch(e){el.select();document.execCommand('copy');showToast('Link copiato!')}
}
function editUserModal(id){const u=db.users.find(x=>x.id===id);if(!u)return;openModal(`<h3>✏ Modifica Utente</h3><div class="modal-field"><label>Nome completo</label><input id="eu-name" value="${esc(u.name)}"></div><div class="modal-field"><label>Username</label><input id="eu-username" value="${esc(u.username||'')}"></div><div class="modal-field"><label>Email (gestita dall'account di accesso)</label><input type="email" id="eu-email" value="${esc(u.email||'')}" disabled style="opacity:.6"></div><div class="modal-field"><label>Ruolo</label><select id="eu-role"><option value="admin" ${u.role==='admin'?'selected':''}>Admin</option><option value="operator" ${u.role==='operator'?'selected':''}>Operatore</option></select></div><div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Annulla</button><button class="add-btn-sm" onclick="saveUserEdit('${id}')">Salva</button></div>`)}
async function saveUserEdit(id){
  const u=db.users.find(x=>x.id===id);if(!u)return;
  const upd={
    name:document.getElementById('eu-name').value.trim(),
    username:document.getElementById('eu-username').value.trim()||null,
    role:document.getElementById('eu-role').value
  };
  closeModal();
  // Il cambio ruolo è consentito solo agli admin: lo verifica il server
  const ok=await dbWrite(supa.from('profiles').update(upd).eq('id',id),'Aggiornato');
  if(ok)renderManage();
}
async function toggleUserActive(uid){
  if(!_a())return;
  const u=db.users.find(x=>x.id===uid);if(!u)return;
  if(u.role==='admin'){showToast('Non puoi sospendere un amministratore','error');return}
  if(uid===currentUser.id){showToast('Non puoi sospendere te stesso','error');return}
  const newActive=u.active===false;
  const ok=await dbWrite(supa.from('profiles').update({active:newActive}).eq('id',uid),newActive?u.name+' riattivato':u.name+' sospeso');
  if(ok)renderManage();
}

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
window.submitNewUser=submitNewUser;
window.copyInviteLink=copyInviteLink;
window.editUserModal=editUserModal;
window.saveUserEdit=saveUserEdit;
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
  doc.setTextColor(33,37,41);
  doc.text(data.title,15,y);
  y+=5;
  doc.setFont('helvetica','normal');
  doc.setFontSize(9);
  doc.setTextColor(139,143,163);
  doc.text('Periodo: '+data.period+' | '+data.kpis.count+' registrazioni',15,y);
  y+=6;

  // KPI box
  if(cfg.showKpi){
    doc.setDrawColor(210,213,222);
    doc.setFillColor(245,246,250);
    doc.roundedRect(15,y,pageW-30,18,3,3,'FD');
    doc.setFont('helvetica','bold');
    doc.setFontSize(10);
    doc.setTextColor(33,37,41);
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
      styles:{fontSize:8,cellPadding:2,textColor:[33,37,41],lineColor:[210,213,222],fillColor:[255,255,255]},
      headStyles:{fillColor:[58,123,232],textColor:[255,255,255],fontStyle:'bold'},
      alternateRowStyles:{fillColor:[245,246,250]},
      didParseCell(data){
        if(data.row.index===body.length-1&&g.label&&cfg.showGroupTotals){
          data.cell.styles.fontStyle='bold';
          data.cell.styles.fillColor=[226,230,240];
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
window.onFilterChange=onFilterChange;
window.applyFilters=applyFilters;
window.resetFilters=resetFilters;
window.submitLogin=submitLogin;
window.logout=logout;
window.changePassword=changePassword;
window.submitChangePwd=submitChangePwd;
window.submitSetPwd=submitSetPwd;
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

// ═══ OROLOGIO HEADER ═══
function updateHeaderClock(){
  const el=document.getElementById('header-clock');
  if(!el)return;
  const now=new Date();
  const date=now.toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const time=now.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
  el.innerHTML=`<span class="hc-date">${date.charAt(0).toUpperCase()+date.slice(1)}</span><span class="hc-time">${time}</span>`;
}

// ═══ INIT ═══
(async function(){
  selectedWeek=getWeekStart(todayStr());
  updateHeaderClock();
  setInterval(updateHeaderClock,1000);

  // Pulizia: la vecchia versione salvava l'intero DB (hash password inclusi)
  // in localStorage — rimuovi ogni residuo dai dispositivi
  ['timetrack_v5','timetrack_v5_pending','timetrack_v5_savedAt','timetrack_backups','timetrack_last_backup','tt_saved_username']
    .forEach(k=>localStorage.removeItem(k));

  // Link di recovery (email "reimposta password"): mostra la schermata dedicata
  supa.auth.onAuthStateChange((event)=>{
    if(event==='PASSWORD_RECOVERY')showSetPasswordModal();
  });

  updateSyncStatus('sync');
  const {data:{session}}=await supa.auth.getSession();
  if(session){
    if(_authFlowType==='invite'||_authFlowType==='recovery'||_authFlowType==='signup'){
      // Arrivo da link di invito/recovery: prima imposta la password
      updateSyncStatus('ok');
      showSetPasswordModal();
    }else{
      // Sessione esistente: auto-login
      const ok=await initSession().catch(e=>{console.error(e);return false});
      if(!ok)renderLogin();
    }
  }else{
    updateSyncStatus('ok');
    renderLogin();
  }
})();
