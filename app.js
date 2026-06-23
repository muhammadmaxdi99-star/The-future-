// ====== AcademyChat — asosiy mantiq ======
function initWhenReady(){
  if(!window._fbReady){ window.addEventListener('firebase-ready', initWhenReady, {once:true}); return; }
  runApp();
}

function runApp(){
const { collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp } = window._fb;
const { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } = window._fbAuth;
const db = window._db;
const auth = window._auth;
const LOGIN_DOMAIN = '@academychat.local';
function loginToEmail(login){ return login.toLowerCase()+LOGIN_DOMAIN; }

let CU = null;
let isAdminSetupMode = false;
let allPeople = [];       // teachers + students (users with role teacher/student/admin)
let allGroups = [];       // {id,name,teacherId,teacherName,studentIds:[]}
let activeScreen = 'home'; // home | groups-list | teachers-list | dm-list | group-convo | dm-convo | broadcast-feed
let activeConvoId = null;
let activeConvoKind = null; // 'dm' | 'group' | 'broadcast'
let msgsUnsub = null;
let listsUnsub = [];
let lastDms = [];
let pendingBroadcastVoice = null;

const LS_KEY = 'academychat_session';

function $(id){ return document.getElementById(id); }
function showToast(msg){
  const t=$('toast'); t.textContent=msg; t.classList.add('on');
  clearTimeout(window._toastT);
  window._toastT=setTimeout(()=>t.classList.remove('on'),2200);
}
function initials(name){ return (name||'?').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase(); }
function colorFor(seed){
  const colors=['#f5a623','#4d8dff','#1fc98d','#ef4866','#a86bf2','#ff7a45','#2fb8c4'];
  let h=0; for(const c of String(seed)) h=(h*31+c.charCodeAt(0))>>>0;
  return colors[h%colors.length];
}
function fmtTime(d){ if(!d||!d.toDate) return ''; return d.toDate().toLocaleTimeString('uz-UZ',{hour:'2-digit',minute:'2-digit'}); }
function fmtDay(d){
  if(!d||!d.toDate) return '';
  const dt=d.toDate(), today=new Date();
  if(dt.toDateString()===today.toDateString()) return 'Bugun';
  const yest=new Date(today); yest.setDate(yest.getDate()-1);
  if(dt.toDateString()===yest.toDateString()) return 'Kecha';
  return dt.toLocaleDateString('uz-UZ',{day:'numeric',month:'long'});
}
function dmId(a,b){ return [a,b].sort().join('__'); }
function escapeAttr(s){ return String(s).replace(/'/g,"\\'"); }
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function roleLabel(role){ return role==='admin'?'👑 Admin':role==='teacher'?'👨‍🏫 Ustoz':"🎒 O'quvchi"; }

// ===================== AUTH =====================
function authError(msg){ const el=$('authErr'); el.textContent=msg; el.style.display='block'; }

window.submitAuth = async function(){
  const login = $('authLogin').value.trim().toLowerCase();
  const pass = $('authPass').value;
  if(!login || !pass){ authError('Login va parolni kiriting'); return; }
  if(!/^[a-z0-9_.]+$/.test(login)){ authError("Login faqat lotin harf/raqamdan iborat bo'lsin"); return; }

  const btn = $('authSubmitBtn');
  btn.disabled = true;
  const email = loginToEmail(login);

  try{
    if(isAdminSetupMode){
      if(pass.length<6){ authError("Parol kamida 6 belgidan iborat bo'lishi kerak"); btn.disabled=false; return; }
      const userRef = doc(db,'users',login);
      const existing = await getDoc(userRef);
      if(existing.exists()){ authError('Bu login band'); btn.disabled=false; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await setDoc(userRef, { login, name:'Admin', role:'admin', uid:cred.user.uid, createdAt: serverTimestamp() });
      await setDoc(doc(db,'meta','adminFlag'), { exists:true });
      CU = { id: login, login, name:'Admin', role:'admin' };
      localStorage.setItem(LS_KEY, JSON.stringify(CU));
      enterApp();
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
      const userRef = doc(db,'users',login);
      const snap = await getDoc(userRef);
      if(!snap.exists()){ authError('Hisob topilmadi'); await signOut(auth); btn.disabled=false; return; }
      const data = snap.data();
      CU = { id: login, login, name: data.name, role: data.role };
      localStorage.setItem(LS_KEY, JSON.stringify(CU));
      enterApp();
    }
  } catch(e){
    if(['auth/invalid-credential','auth/user-not-found','auth/wrong-password'].includes(e.code)) authError('Login yoki parol xato');
    else if(e.code==='auth/email-already-in-use') authError('Bu login allaqachon band');
    else authError('Xatolik: '+e.message);
  }
  btn.disabled = false;
};

window.logout = function(){
  localStorage.removeItem(LS_KEY);
  cleanupListeners();
  signOut(auth);
  CU = null;
  location.reload();
};

function cleanupListeners(){
  if(msgsUnsub){ msgsUnsub(); msgsUnsub=null; }
  listsUnsub.forEach(u=>u && u());
  listsUnsub = [];
}

// ===================== BOOT =====================
async function boot(){
  onAuthStateChanged(auth, async (fbUser)=>{
    if(fbUser){
      const saved = localStorage.getItem(LS_KEY);
      if(saved){
        try{
          const parsed = JSON.parse(saved);
          const snap = await getDoc(doc(db,'users',parsed.id));
          if(snap.exists() && snap.data().uid===fbUser.uid){
            const d = snap.data();
            CU = { id: parsed.id, login: parsed.id, name: d.name, role: d.role };
            enterApp(); return;
          }
        }catch(e){}
      }
      try{
        const q = query(collection(db,'users'), where('uid','==',fbUser.uid));
        const qsnap = await getDocs(q);
        if(!qsnap.empty){
          const d0 = qsnap.docs[0], d = d0.data();
          CU = { id: d0.id, login: d0.id, name: d.name, role: d.role };
          localStorage.setItem(LS_KEY, JSON.stringify(CU));
          enterApp(); return;
        }
      }catch(e){}
      showAuthScreen();
    } else {
      showAuthScreen();
    }
  });
}

async function showAuthScreen(){
  $('bootScreen').classList.add('hidden');
  try{
    const flagSnap = await getDoc(doc(db,'meta','adminFlag'));
    isAdminSetupMode = !flagSnap.exists();
  }catch(e){ isAdminSetupMode = false; }

  if(isAdminSetupMode){
    $('authTitle').textContent = "Admin hisobini yarating";
    $('authSub').textContent = "Tizimni boshqarish uchun birinchi admin hisobini o'rnating";
    $('authSubmitBtn').textContent = "Admin sifatida yaratish";
  }
  $('authScreen').classList.remove('hidden');
}

function enterApp(){
  $('bootScreen').classList.add('hidden');
  $('authScreen').classList.add('hidden');
  $('mainShell').style.display='flex';
  $('meName').textContent = CU.name;
  const chip = $('meRoleChip');
  chip.textContent = roleLabel(CU.role);
  chip.className = 'role-chip ' + (CU.role==='admin'?'admin':CU.role==='teacher'?'teacher':'student');
  loadPeopleAndGroups();
  goHome();
}

// ===================== DATA LOADING =====================
async function loadPeopleAndGroups(){
  const usnap = await getDocs(collection(db,'users'));
  allPeople = [];
  usnap.forEach(d=>{ if(d.id!==CU.id) allPeople.push({ id:d.id, ...d.data() }); });

  const gsnap = await getDocs(collection(db,'groups'));
  allGroups = [];
  gsnap.forEach(d=> allGroups.push({ id:d.id, ...d.data() }));

  if(activeScreen==='home') renderHome();
  else if(activeScreen==='groups-list') renderGroupsList();
  else if(activeScreen==='teachers-list') renderTeachersList();
  else if(activeScreen==='dm-list') renderDmList();
}

function myGroups(){
  if(CU.role==='admin') return allGroups;
  if(CU.role==='teacher') return allGroups.filter(g=>g.teacherId===CU.id);
  return allGroups.filter(g=> (g.studentIds||[]).includes(CU.id));
}

// ===================== NAVIGATION =====================
window.goHome = function(){
  cleanupListeners();
  activeScreen = 'home';
  $('homeScreen').style.display='flex';
  $('listScreen').style.display='none';
  $('convoScreen').style.display='none';
  renderHome();
};

function showListScreen(title, fabHtml, fabOnclick){
  $('homeScreen').style.display='none';
  $('listScreen').style.display='flex';
  $('convoScreen').style.display='none';
  $('listTitle').textContent = title;
  const fab = $('fabBtn');
  if(fabHtml){
    fab.classList.remove('hidden');
    fab.innerHTML = fabHtml;
    fab.onclick = fabOnclick;
  } else {
    fab.classList.add('hidden');
  }
}

// ===================== HOME =====================
function renderHome(){
  const pad = $('homePad');
  let h = '';

  if(CU.role==='student'){
    h += `<div class="announce-card" onclick="openBroadcastFeed()">
      <div class="ic">📢</div>
      <div style="flex:1"><div class="tt">E'lonlar</div><div class="ds">Ustozlardan umumiy xabarlar</div></div>
      <div style="color:var(--text3);font-size:18px">›</div>
    </div>`;
  } else {
    h += `<div class="announce-card" onclick="openBroadcastSheet()">
      <div class="ic">📢</div>
      <div style="flex:1"><div class="tt">Umumiy xabar yuborish</div><div class="ds">Barcha o'quvchilarga e'lon yuborish</div></div>
      <div style="color:var(--text3);font-size:18px">›</div>
    </div>`;
  }

  h += `<div class="folder-grid">`;
  h += `<div class="folder-card" onclick="openGroupsList()">
      <div class="ic" style="background:rgba(245,166,35,.18);color:var(--amber)">🏠</div>
      <div class="tt">Guruhlar</div>
      <div class="ds">${CU.role==='student'?'Mening sinflarim':"Sinflar va o'quvchilar"}</div>
      ${myGroups().length?`<div class="folder-badge">${myGroups().length}</div>`:''}
    </div>`;

  if(CU.role!=='student'){
    h += `<div class="folder-card" onclick="openTeachersList()">
      <div class="ic" style="background:rgba(77,141,255,.18);color:#7fb0ff">👤</div>
      <div class="tt">Xodimlar</div>
      <div class="ds">Ustozlar ro'yxati</div>
      ${allPeople.filter(p=>p.role==='teacher').length?`<div class="folder-badge">${allPeople.filter(p=>p.role==='teacher').length}</div>`:''}
    </div>`;
  }

  h += `<div class="folder-card" onclick="openDmList()">
      <div class="ic" style="background:rgba(31,201,141,.18);color:var(--green)">💬</div>
      <div class="tt">Shaxsiy xabarlar</div>
      <div class="ds">Birma-bir suhbatlar</div>
    </div>`;
  h += `</div>`;

  $('homePad').innerHTML = h;
}

// ===================== GROUPS LIST =====================
window.openGroupsList = function(){
  activeScreen = 'groups-list';
  const fabHtml = CU.role==='admin' ? '➕' : null;
  showListScreen('🏠 Guruhlar', fabHtml, CU.role==='admin' ? openAddGroupSheet : null);
  renderGroupsList();
};

function renderGroupsList(){
  const list = myGroups();
  let h = '';
  if(!list.length){
    h = `<div class="empty-list"><div class="ic">🏠</div><div class="tt">Hali guruh yo'q</div>${CU.role==='admin'?'<div class="ds">Pastdagi ➕ tugmasi orqali guruh yarating</div>':''}</div>`;
  } else {
    h += `<div class="row-list">`;
    list.forEach(g=>{
      const cnt = (g.studentIds||[]).length;
      h += `<div class="chat-row" onclick="openGroupConvo('${g.id}')">
        <div class="avatar group" style="background:${colorFor(g.id)}">${initials(g.name)}</div>
        <div class="chat-row-info">
          <div class="chat-row-top"><div class="chat-row-name">${g.name}</div></div>
          <div class="chat-row-msg">👨‍🏫 ${g.teacherName||'—'} · 🎒 ${cnt} o'quvchi</div>
        </div>
      </div>`;
    });
    h += `</div>`;
  }
  $('listPad').innerHTML = h;
}

window.openAddGroupSheet = function(){
  $('addGroupName').value='';
  const sel = $('addGroupTeacher');
  const teachers = allPeople.filter(p=>p.role==='teacher');
  sel.innerHTML = teachers.length ? teachers.map(t=>`<option value="${t.id}">${t.name}</option>`).join('') : '<option value="">Ustoz yo\'q</option>';
  $('groupSheetTitle').textContent = '➕ Yangi guruh';
  $('addGroupSheetOverlay').dataset.editId = '';
  $('addGroupSheetOverlay').style.display='flex';
};

window.submitAddGroup = async function(){
  const name = $('addGroupName').value.trim();
  const teacherId = $('addGroupTeacher').value;
  if(!name){ showToast('Guruh nomini kiriting'); return; }
  const teacher = allPeople.find(p=>p.id===teacherId);

  await addDoc(collection(db,'groups'), {
    name, teacherId: teacherId||null, teacherName: teacher?teacher.name:null,
    studentIds: [], createdAt: serverTimestamp(), createdBy: CU.id
  });
  closeSheet('addGroupSheetOverlay');
  showToast(`✅ "${name}" guruhi yaratildi`);
  await loadPeopleAndGroups();
};

// ===================== GROUP CONVERSATION =====================
window.openGroupConvo = async function(groupId){
  const g = allGroups.find(x=>x.id===groupId);
  if(!g) return;
  activeConvoId = groupId;
  activeConvoKind = 'group';

  $('convoAvatar').className = 'avatar group';
  $('convoAvatar').style.background = colorFor(groupId);
  $('convoAvatar').textContent = initials(g.name);
  $('convoName').textContent = g.name;
  $('convoSub').textContent = `👨‍🏫 ${g.teacherName||'—'} · 🎒 ${(g.studentIds||[]).length} o'quvchi`;

  $('homeScreen').style.display='none';
  $('listScreen').style.display='none';
  $('convoScreen').style.display='flex';
  $('groupTabsBar').classList.remove('hidden');
  $('msgInput').value=''; $('msgInput').style.height='auto';
  toggleSendBtn();

  const manageBtn = $('convoManageBtn');
  if(CU.role==='admin' || (CU.role==='teacher' && g.teacherId===CU.id)){
    manageBtn.classList.remove('hidden');
    manageBtn.onclick = ()=>openGroupManage(groupId);
  } else {
    manageBtn.classList.add('hidden');
  }

  switchGroupTab('chat');
  subscribeMessages('groups', groupId);
};

// ===================== GROUP TABS: Chat / O'quvchilar (vazifa kalendar) =====================
let curGroupTaskMonth = new Date().getMonth();
let curGroupTaskYear = new Date().getFullYear();
let openStudentCardId = null;
let groupTasksCache = {}; // { 'studentId_YYYY-MM': { '1':'text', '2':'text', ... } }

window.switchGroupTab = function(tab){
  document.querySelectorAll('.group-tab').forEach((el,i)=>el.classList.toggle('on', (tab==='chat'&&i===0)||(tab==='students'&&i===1)));
  if(tab==='chat'){
    $('messagesView').classList.remove('hidden');
    $('studentsView').classList.add('hidden');
    $('composerBar').style.display='flex';
    $('recBanner').style.display='none';
  } else {
    $('messagesView').classList.add('hidden');
    $('studentsView').classList.remove('hidden');
    $('composerBar').style.display='none';
    $('recBanner').style.display='none';
    renderGroupStudentsView();
  }
};

function renderGroupStudentsView(){
  const g = allGroups.find(x=>x.id===activeConvoId);
  if(!g){ $('studentsView').innerHTML=''; return; }
  const memberIds = g.studentIds||[];
  const members = allPeople.filter(p=>memberIds.includes(p.id));

  let h = '';
  if(!members.length){
    h = `<div class="empty-list"><div class="ic">🎒</div><div class="tt">Bu guruhda o'quvchi yo'q</div></div>`;
  } else {
    members.forEach(s=>{
      const isOpen = openStudentCardId===s.id;
      h += `<div class="student-card ${isOpen?'open':''}" id="scard-${s.id}">
        <div class="student-card-head" onclick="toggleStudentCard('${s.id}')">
          <div class="avatar" style="background:${colorFor(s.id)}">${initials(s.name)}</div>
          <div style="flex:1">
            <div class="student-card-name">${s.name}</div>
            <div class="student-card-sub">@${s.id}</div>
          </div>
          <div class="student-card-arrow">▼</div>
        </div>
        <div class="student-cal" id="scal-${s.id}"></div>
      </div>`;
    });
  }
  $('studentsView').innerHTML = h;
  if(openStudentCardId && members.find(m=>m.id===openStudentCardId)){
    renderStudentCalendar(openStudentCardId);
  }
}

window.toggleStudentCard = async function(studentId){
  if(openStudentCardId===studentId){
    openStudentCardId = null;
    renderGroupStudentsView();
    return;
  }
  openStudentCardId = studentId;
  renderGroupStudentsView();
};

async function loadGroupTasksMonth(studentId, year, month){
  const key = `${studentId}_${year}-${String(month+1).padStart(2,'0')}`;
  if(groupTasksCache[key]) return groupTasksCache[key];
  const tasksRef = doc(db,'groupTasks', activeConvoId+'_'+key);
  const snap = await getDoc(tasksRef);
  const data = snap.exists() ? (snap.data().days||{}) : {};
  groupTasksCache[key] = data;
  return data;
}

async function renderStudentCalendar(studentId){
  const calEl = $('scal-'+studentId);
  if(!calEl) return;
  calEl.innerHTML = `<div style="text-align:center;padding:14px;color:var(--text3);font-size:12px">Yuklanmoqda...</div>`;

  const year = curGroupTaskYear, month = curGroupTaskMonth;
  const tasks = await loadGroupTasksMonth(studentId, year, month);
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const monthNames = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentyabr','Oktyabr','Noyabr','Dekabr'];

  let h = `<div class="cal-month-bar">
    <button onclick="changeGroupTaskMonth(-1,'${studentId}')">◀</button>
    <span>${monthNames[month]} ${year}</span>
    <button onclick="changeGroupTaskMonth(1,'${studentId}')">▶</button>
  </div>
  <div class="cal-grid">`;
  for(let d=1; d<=daysInMonth; d++){
    const hasTask = !!tasks[String(d)];
    h += `<div class="cal-cell ${hasTask?'has-task':''}" onclick="openTaskNote('${studentId}',${year},${month},${d})">${d}${hasTask?'<span class="dot"></span>':''}</div>`;
  }
  h += `</div>`;
  calEl.innerHTML = h;
}

window.changeGroupTaskMonth = function(delta, studentId){
  curGroupTaskMonth += delta;
  if(curGroupTaskMonth<0){ curGroupTaskMonth=11; curGroupTaskYear--; }
  if(curGroupTaskMonth>11){ curGroupTaskMonth=0; curGroupTaskYear++; }
  renderStudentCalendar(studentId);
};

window.openTaskNote = async function(studentId, year, month, day){
  const student = allPeople.find(p=>p.id===studentId);
  const dateLabel = `${day}-${['Yan','Fev','Mar','Apr','May','Iyun','Iyul','Avg','Sen','Okt','Noy','Dek'][month]} ${year}`;
  const canEdit = CU.role==='admin' || CU.role==='teacher';

  const key = `${studentId}_${year}-${String(month+1).padStart(2,'0')}`;
  const tasks = await loadGroupTasksMonth(studentId, year, month);
  const existingText = tasks[String(day)] || '';

  $('taskNoteTitle').textContent = `📝 ${student?student.name:''} — ${dateLabel}`;

  if(canEdit){
    $('taskNoteBody').innerHTML = `
      <div class="task-date-label">${dateLabel} kuni uchun vazifa</div>
      <textarea class="task-textarea" id="taskNoteInput" placeholder="Vazifa matnini yozing...">${escapeHtml(existingText)}</textarea>
      <button class="btn-primary" onclick="saveTaskNote('${studentId}',${year},${month},${day})">💾 Saqlash</button>
      ${existingText?`<button class="btn-primary" style="background:var(--red);margin-top:8px" onclick="deleteTaskNote('${studentId}',${year},${month},${day})">🗑️ O'chirish</button>`:''}
    `;
  } else {
    $('taskNoteBody').innerHTML = `
      <div class="task-date-label">${dateLabel} kuni uchun vazifa</div>
      <div class="task-readonly">${existingText ? escapeHtml(existingText).replace(/\n/g,'<br>') : '<span style="color:var(--text3)">Bu kunga vazifa yo\'q</span>'}</div>
    `;
  }
  $('taskNoteSheetOverlay').style.display='flex';
};

window.saveTaskNote = async function(studentId, year, month, day){
  const text = $('taskNoteInput').value.trim();
  const key = `${studentId}_${year}-${String(month+1).padStart(2,'0')}`;
  const tasksRef = doc(db,'groupTasks', activeConvoId+'_'+key);
  const snap = await getDoc(tasksRef);
  const days = snap.exists() ? (snap.data().days||{}) : {};
  if(text) days[String(day)] = text;
  else delete days[String(day)];

  await setDoc(tasksRef, { groupId: activeConvoId, studentId, year, month, days, updatedAt: serverTimestamp() });
  groupTasksCache[key] = days;
  closeSheet('taskNoteSheetOverlay');
  showToast('✅ Saqlandi');
  renderStudentCalendar(studentId);
};

window.deleteTaskNote = async function(studentId, year, month, day){
  const key = `${studentId}_${year}-${String(month+1).padStart(2,'0')}`;
  const tasksRef = doc(db,'groupTasks', activeConvoId+'_'+key);
  const snap = await getDoc(tasksRef);
  if(snap.exists()){
    const days = snap.data().days||{};
    delete days[String(day)];
    await setDoc(tasksRef, { groupId: activeConvoId, studentId, year, month, days, updatedAt: serverTimestamp() });
    groupTasksCache[key] = days;
  }
  closeSheet('taskNoteSheetOverlay');
  showToast("O'chirildi");
  renderStudentCalendar(studentId);
};

window.openGroupManage = function(groupId){
  const g = allGroups.find(x=>x.id===groupId);
  if(!g) return;
  const students = allPeople.filter(p=>p.role==='student');
  const memberIds = g.studentIds||[];
  let h = `<div style="font-size:13px;font-weight:700;margin-bottom:10px">O'quvchilarni belgilang</div>`;
  if(!students.length){
    h += `<div class="empty-list" style="padding:24px"><div class="ic">🎒</div><div class="tt">Hali o'quvchi yo'q</div></div>`;
  } else {
    students.forEach(s=>{
      h += `<label class="checkbox-row">
        <input type="checkbox" data-sid="${s.id}" ${memberIds.includes(s.id)?'checked':''}>
        <div class="avatar" style="width:34px;height:34px;font-size:12px;background:${colorFor(s.id)}">${initials(s.name)}</div>
        <div style="font-size:13.5px;font-weight:600">${s.name}</div>
      </label>`;
    });
  }
  $('addStudentToGroupOverlay').querySelector('.sheet-body').innerHTML = h + `
    <button class="btn-primary" onclick="saveGroupMembers('${groupId}')">💾 Saqlash</button>
    <button class="btn-primary" style="background:var(--card);color:var(--text);margin-top:8px;border:1px solid var(--border)" onclick="openAddStudentSheet()">➕ Yangi o'quvchi yaratish</button>
    <button class="btn-primary" style="background:var(--red);margin-top:8px" onclick="deleteGroupConfirm('${groupId}')">🗑️ Guruhni o'chirish</button>
  `;
  $('addStudentToGroupOverlay').style.display='flex';
};

window.saveGroupMembers = async function(groupId){
  const checks = document.querySelectorAll('#addStudentToGroupOverlay input[type=checkbox]');
  const ids = [];
  checks.forEach(c=>{ if(c.checked) ids.push(c.dataset.sid); });
  await updateDoc(doc(db,'groups',groupId), { studentIds: ids });
  closeSheet('addStudentToGroupOverlay');
  showToast('✅ Yangilandi');
  await loadPeopleAndGroups();
  if(activeConvoKind==='group' && activeConvoId===groupId) openGroupConvo(groupId);
};

window.deleteGroupConfirm = async function(groupId){
  if(!confirm("Guruhni o'chirishni tasdiqlaysizmi?")) return;
  await deleteDoc(doc(db,'groups',groupId));
  closeSheet('addStudentToGroupOverlay');
  showToast("O'chirildi");
  closeConvo();
  await loadPeopleAndGroups();
};

// ===================== TEACHERS LIST (Xodimlar) =====================
window.openTeachersList = function(){
  activeScreen = 'teachers-list';
  const fabHtml = CU.role==='admin' ? '➕' : null;
  showListScreen('👤 Xodimlar', fabHtml, CU.role==='admin' ? openAddTeacherSheet : null);
  renderTeachersList();
};

function renderTeachersList(){
  const teachers = allPeople.filter(p=>p.role==='teacher');
  let h = '';
  if(!teachers.length){
    h = `<div class="empty-list"><div class="ic">👨‍🏫</div><div class="tt">Hali ustoz yo'q</div>${CU.role==='admin'?'<div class="ds">Pastdagi ➕ tugmasi orqali ustoz qo\'shing</div>':''}</div>`;
  } else {
    h += `<div class="row-list">`;
    teachers.forEach(p=>{
      const delBtn = CU.role==='admin' ? `<button class="person-del" onclick="event.stopPropagation();deletePerson('${p.id}','${escapeAttr(p.name)}')">🗑️</button>` : '';
      h += `<div class="chat-row" onclick="openDM('${p.id}','${escapeAttr(p.name)}','${p.role}')">
        <div class="avatar" style="background:${colorFor(p.id)}">${initials(p.name)}</div>
        <div class="chat-row-info">
          <div class="chat-row-name">${p.name}</div>
          <div class="chat-row-msg">👨‍🏫 Ustoz · @${p.id}</div>
        </div>
        ${delBtn}
      </div>`;
    });
    h += `</div>`;
  }
  $('listPad').innerHTML = h;
}

window.openAddTeacherSheet = function(){
  $('addTeacherName').value=''; $('addTeacherLogin').value=''; $('addTeacherPass').value='';
  $('addTeacherSheetOverlay').style.display='flex';
};

window.submitAddTeacher = async function(){
  await createPersonAccount($('addTeacherName').value.trim(), $('addTeacherLogin').value.trim().toLowerCase(), $('addTeacherPass').value, 'teacher', 'addTeacherSheetOverlay', renderTeachersList);
};

window.deletePerson = async function(personId, personName){
  if(!confirm(`${personName}ni o'chirishni tasdiqlaysizmi?`)) return;
  await deleteDoc(doc(db,'users',personId));
  showToast("O'chirildi");
  await loadPeopleAndGroups();
};

// ===================== ADD STUDENT (within group manage) =====================
window.openAddStudentSheet = function(){
  $('addStudentName').value=''; $('addStudentLogin').value=''; $('addStudentPass').value='';
  $('addStudentToGroupOverlay').querySelector('.sheet-body').innerHTML = `
    <div class="field"><label>Ism familiya</label><input type="text" id="addStudentName" placeholder="Ism Familiya"></div>
    <div class="field"><label>Login</label><input type="text" id="addStudentLogin" placeholder="masalan: ali_2010"></div>
    <div class="field"><label>Parol</label><input type="text" id="addStudentPass" placeholder="Parol o'rnating"></div>
    <button class="btn-primary" onclick="submitAddStudent()">✅ Qo'shish</button>
  `;
  $('addStudentToGroupOverlay').style.display='flex';
};

window.submitAddStudent = async function(){
  await createPersonAccount($('addStudentName').value.trim(), $('addStudentLogin').value.trim().toLowerCase(), $('addStudentPass').value, 'student', 'addStudentToGroupOverlay', null);
};

async function createPersonAccount(name, login, pass, role, sheetId, afterRenderFn){
  if(!name || !login || !pass){ showToast("Barcha maydonlarni to'ldiring"); return; }
  if(pass.length<6){ showToast("Parol kamida 6 belgidan iborat bo'lsin"); return; }
  if(!/^[a-z0-9_.]+$/.test(login)){ showToast("Login faqat lotin harf/raqamdan iborat bo'lsin"); return; }

  const userRef = doc(db,'users',login);
  const existing = await getDoc(userRef);
  if(existing.exists()){ showToast('Bu login band'); return; }

  try{
    const { initializeApp, deleteApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const { getAuth: getAuth2, createUserWithEmailAndPassword: createUser2 } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
    const tempApp = initializeApp(window._firebaseConfig, 'tempAddUser_'+Date.now());
    const tempAuth = getAuth2(tempApp);
    const email = loginToEmail(login);
    const cred = await createUser2(tempAuth, email, pass);
    const newUid = cred.user.uid;
    await deleteApp(tempApp);

    await setDoc(userRef, { login, name, role, uid:newUid, createdAt: serverTimestamp(), createdBy: CU.id });
    closeSheet(sheetId);
    showToast(`✅ ${name} qo'shildi`);
    await loadPeopleAndGroups();
    if(afterRenderFn) afterRenderFn();
  }catch(e){
    if(e.code==='auth/email-already-in-use') showToast('Bu login allaqachon band');
    else showToast('Xatolik: '+e.message);
  }
}

// ===================== DM LIST (Shaxsiy xabarlar) =====================
window.openDmList = function(){
  activeScreen = 'dm-list';
  showListScreen('💬 Shaxsiy xabarlar', '✏️', openNewDmSheet);
  subscribeDmList();
};

function subscribeDmList(){
  cleanupListeners();
  const q = query(collection(db,'conversations'), where('participants','array-contains', CU.id));
  const unsub = onSnapshot(q, snap=>{
    lastDms = [];
    snap.forEach(d=> lastDms.push({ id:d.id, ...d.data() }));
    lastDms.sort((a,b)=>{
      const at=a.lastTime?.toMillis?a.lastTime.toMillis():0, bt=b.lastTime?.toMillis?b.lastTime.toMillis():0;
      return bt-at;
    });
    if(activeScreen==='dm-list') renderDmList();
  });
  listsUnsub.push(unsub);
}

function renderDmList(){
  let h = '';
  if(!lastDms.length){
    h = `<div class="empty-list"><div class="ic">💬</div><div class="tt">Hali suhbatlar yo'q</div><div class="ds">Pastdagi ✏️ tugmasi orqali yangi suhbat boshlang</div></div>`;
  } else {
    h += `<div class="row-list">`;
    lastDms.forEach(c=>{
      const peerId = c.participants.find(p=>p!==CU.id);
      const peerName = c.names ? (c.names[peerId]||peerId) : peerId;
      const peerRole = c.roles ? c.roles[peerId] : '';
      const unread = (c.unread && c.unread[CU.id]) || 0;
      let preview = c.lastMsg || '';
      if(c.lastType==='voice') preview = '🎤 Ovozli xabar';
      h += `<div class="chat-row" onclick="openDM('${peerId}','${escapeAttr(peerName)}','${peerRole}')">
        <div class="avatar" style="background:${colorFor(peerId)}">${initials(peerName)}
          ${unread>0?`<span class="unread-dot">${unread>9?'9+':unread}</span>`:''}
        </div>
        <div class="chat-row-info">
          <div class="chat-row-top"><div class="chat-row-name">${peerName}</div><div class="chat-row-time">${c.lastTime?fmtTime(c.lastTime):''}</div></div>
          <div class="chat-row-msg">${preview || roleLabel(peerRole)}</div>
        </div>
      </div>`;
    });
    h += `</div>`;
  }
  $('listPad').innerHTML = h;
}

window.openNewDmSheet = function(){
  const body = $('newDmSheetBody');
  let visible;
  if(CU.role==='admin') visible = allPeople;
  else if(CU.role==='teacher') visible = allPeople;
  else visible = allPeople.filter(p=>p.role==='teacher' || p.role==='admin');

  let h = '';
  if(!visible.length){
    h = `<div class="empty-list"><div class="ic">👥</div><div class="tt">Hozircha hech kim yo'q</div></div>`;
  } else {
    visible.forEach(p=>{
      h += `<div class="person-row" onclick="closeSheet('newDmSheetOverlay');openDM('${p.id}','${escapeAttr(p.name)}','${p.role}')">
        <div class="avatar" style="background:${colorFor(p.id)}">${initials(p.name)}</div>
        <div><div class="person-row-name">${p.name}</div><div class="person-row-sub">${roleLabel(p.role)}</div></div>
      </div>`;
    });
  }
  body.innerHTML = h;
  $('newDmSheetOverlay').style.display='flex';
};

window.closeSheet = function(id){ $(id).style.display='none'; };

// ===================== DM CONVERSATION =====================
window.openDM = async function(peerId, peerName, peerRole){
  activeConvoKind = 'dm';
  activeConvoId = dmId(CU.id, peerId);

  $('convoAvatar').className = 'avatar';
  $('convoAvatar').style.background = colorFor(peerId);
  $('convoAvatar').textContent = initials(peerName);
  $('convoName').textContent = peerName;
  $('convoSub').textContent = roleLabel(peerRole);

  $('homeScreen').style.display='none';
  $('listScreen').style.display='none';
  $('convoScreen').style.display='flex';
  $('composerBar').style.display='flex';
  $('recBanner').style.display='none';
  $('msgInput').value=''; $('msgInput').style.height='auto';
  toggleSendBtn();
  $('convoManageBtn').classList.add('hidden');
  $('groupTabsBar').classList.add('hidden');
  $('messagesView').classList.remove('hidden');
  $('studentsView').classList.add('hidden');

  const convoRef = doc(db,'conversations',activeConvoId);
  const snap = await getDoc(convoRef);
  if(!snap.exists()){
    await setDoc(convoRef,{
      type:'dm', participants:[CU.id, peerId],
      names:{ [CU.id]:CU.name, [peerId]:peerName },
      roles:{ [CU.id]:CU.role, [peerId]:peerRole },
      lastMsg:'', lastTime: serverTimestamp(), lastType:'text',
      unread:{ [CU.id]:0, [peerId]:0 }
    });
  } else {
    const data = snap.data();
    const unread = data.unread||{};
    unread[CU.id]=0;
    updateDoc(convoRef,{unread});
  }
  subscribeMessages('conversations', activeConvoId);
};

window.closeConvo = function(){
  if(msgsUnsub){ msgsUnsub(); msgsUnsub=null; }
  $('convoScreen').style.display='none';
  if(activeScreen==='home'){ $('homeScreen').style.display='flex'; }
  else { $('listScreen').style.display='flex'; }
  activeConvoId=null; activeConvoKind=null;
};

function subscribeMessages(rootCollection, convoId){
  if(msgsUnsub) msgsUnsub();
  const msgsRef = collection(db, rootCollection, convoId, 'messages');
  const q = query(msgsRef, orderBy('time','asc'), limit(200));
  msgsUnsub = onSnapshot(q, snap=>{
    const msgs = [];
    snap.forEach(d=> msgs.push({ id:d.id, ...d.data() }));
    window._msgAudioMap = {};
    msgs.forEach(m=>{ if(m.kind==='voice') window._msgAudioMap[m.id]=m.audio; });
    renderMessages(msgs);
  });
}

function renderMessages(msgs){
  const view = $('messagesView');
  let h = '', lastDay = '';
  msgs.forEach(m=>{
    if(!m.time) return;
    const day = fmtDay(m.time);
    if(day!==lastDay){ h += `<div class="msg-day">${day}</div>`; lastDay = day; }
    const mine = m.senderId === CU.id;
    const rowClass = mine ? 'mine' : 'theirs';
    const showSender = activeConvoKind==='group' && !mine;
    if(m.kind==='voice'){
      h += `<div class="msg-row ${rowClass}"><div class="bubble">
        ${showSender?`<div class="bubble-sender">${escapeHtml(m.senderName||'')}</div>`:''}
        <div class="voice-bubble" id="voice-${m.id}">
          <button class="voice-play" onclick="playVoice('${m.id}')">▶</button>
          <div class="voice-wave" id="wave-${m.id}">${'<span></span>'.repeat(18)}</div>
          <div class="voice-dur">${m.duration||0}s</div>
        </div>
        <div class="bubble-time">${fmtTime(m.time)}</div>
      </div></div>`;
    } else {
      h += `<div class="msg-row ${rowClass}"><div class="bubble">
        ${showSender?`<div class="bubble-sender">${escapeHtml(m.senderName||'')}</div>`:''}
        <div>${escapeHtml(m.text||'')}</div>
        <div class="bubble-time">${fmtTime(m.time)}</div>
      </div></div>`;
    }
  });
  view.innerHTML = h || `<div class="empty-list"><div class="ic">💬</div><div class="tt">Hali xabar yo'q</div><div class="ds">Birinchi xabarni yuboring</div></div>`;
  view.scrollTop = view.scrollHeight;
}

// ===================== SENDING TEXT =====================
window.autoGrow = function(el){ el.style.height='auto'; el.style.height = Math.min(el.scrollHeight,110)+'px'; };
window.toggleSendBtn = function(){
  const has = $('msgInput').value.trim().length>0;
  $('sendBtn').classList.toggle('hidden', !has);
  $('micBtn').classList.toggle('hidden', has);
};

window.sendTextMessage = async function(){
  const text = $('msgInput').value.trim();
  if(!text || !activeConvoId) return;
  $('msgInput').value=''; $('msgInput').style.height='auto';
  toggleSendBtn();

  const rootCollection = activeConvoKind==='group' ? 'groups' : 'conversations';
  const msgsRef = collection(db, rootCollection, activeConvoId, 'messages');
  await addDoc(msgsRef, { kind:'text', text, senderId: CU.id, senderName: CU.name, time: serverTimestamp() });

  if(activeConvoKind==='dm') await bumpConvo(text, 'text');
};

async function bumpConvo(preview, type){
  if(activeConvoKind!=='dm') return;
  const convoRef = doc(db,'conversations',activeConvoId);
  const snap = await getDoc(convoRef);
  if(!snap.exists()) return;
  const data = snap.data();
  const unread = data.unread || {};
  data.participants.forEach(p=>{ if(p!==CU.id) unread[p] = (unread[p]||0)+1; });
  await updateDoc(convoRef, { lastMsg: preview, lastTime: serverTimestamp(), lastType: type, unread });
}

// ===================== VOICE RECORDING =====================
let mediaRecorder=null, recChunks=[], recStartTime=0, recTimerHandle=null, recStream=null;
const MAX_REC_SECONDS = 60;
const MAX_AUDIO_BYTES = 900*1024;

function pickSupportedMime(){
  const candidates = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus',''];
  for(const c of candidates){
    if(c==='') return '';
    if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

async function startRec(onStop){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    showToast("Bu brauzer mikrofonni qo'llamaydi"); return false;
  }
  try{
    recStream = await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(e){
    showToast("🎤 Mikrofonga ruxsat berilmadi"); return false;
  }
  recChunks = [];
  const mime = pickSupportedMime();
  try{
    mediaRecorder = new MediaRecorder(recStream, mime?{mimeType:mime}:undefined);
  }catch(e){
    mediaRecorder = new MediaRecorder(recStream);
  }
  mediaRecorder.ondataavailable = e=>{ if(e.data.size>0) recChunks.push(e.data); };
  mediaRecorder.onstop = onStop;
  mediaRecorder.onerror = ()=>{ showToast('Audio yozishda xatolik'); stopRecStream(); };
  mediaRecorder.start();
  recStartTime = Date.now();
  return true;
}

function stopRecStream(){
  if(recStream){ recStream.getTracks().forEach(t=>t.stop()); recStream=null; }
  if(recTimerHandle){ clearInterval(recTimerHandle); recTimerHandle=null; }
}

function blobToBase64(blob){
  return new Promise((res,rej)=>{
    const r = new FileReader();
    r.onload = ()=>res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

window.toggleRecording = async function(){
  if(mediaRecorder && mediaRecorder.state==='recording'){ mediaRecorder.stop(); return; }
  const ok = await startRec(async ()=>{
    const elapsed = Math.round((Date.now()-recStartTime)/1000);
    stopRecStream();
    $('recBanner').style.display='none';
    $('micBtn').classList.remove('recording');
    if(window._recCancelled){ window._recCancelled=false; return; }
    if(elapsed<1){ showToast('Juda qisqa ovozli xabar'); return; }
    const blob = new Blob(recChunks, {type: mediaRecorder.mimeType||'audio/webm'});
    if(!blob.size){ showToast('Audio yozilmadi, qaytadan urinib ko\'ring'); return; }
    if(blob.size > MAX_AUDIO_BYTES){ showToast("Ovozli xabar juda katta, qisqaroq yozing"); return; }
    try{
      const base64 = await blobToBase64(blob);
      await sendVoiceMessage(base64, elapsed);
    }catch(e){ showToast('Yuborishda xatolik: '+e.message); }
  });
  if(!ok) return;
  $('micBtn').classList.add('recording');
  $('recBanner').style.display='flex';
  let secs=0; $('recTime').textContent='0:00';
  recTimerHandle = setInterval(()=>{
    secs++;
    const m=Math.floor(secs/60), s=secs%60;
    $('recTime').textContent = `${m}:${String(s).padStart(2,'0')}`;
    if(secs>=MAX_REC_SECONDS && mediaRecorder && mediaRecorder.state==='recording') mediaRecorder.stop();
  },1000);
};

window.cancelRecording = function(){
  window._recCancelled = true;
  if(mediaRecorder && mediaRecorder.state==='recording') mediaRecorder.stop();
  $('recBanner').style.display='none';
  $('micBtn').classList.remove('recording');
};

async function sendVoiceMessage(base64, duration){
  if(!activeConvoId) return;
  const rootCollection = activeConvoKind==='group' ? 'groups' : 'conversations';
  const msgsRef = collection(db, rootCollection, activeConvoId, 'messages');
  await addDoc(msgsRef, { kind:'voice', audio: base64, duration, senderId: CU.id, senderName: CU.name, time: serverTimestamp() });
  if(activeConvoKind==='dm') await bumpConvo('🎤 Ovozli xabar', 'voice');
}

window.playVoice = function(msgId){
  const wave = $('wave-'+msgId);
  const btn = document.querySelector(`#voice-${msgId} .voice-play`);
  if(window._curAudio && window._curAudioId===msgId){
    window._curAudio.pause();
    if(wave) wave.classList.remove('playing');
    if(btn) btn.textContent='▶';
    window._curAudio=null; window._curAudioId=null;
    return;
  }
  if(window._curAudio){
    window._curAudio.pause();
    document.querySelectorAll('.voice-wave.playing').forEach(w=>w.classList.remove('playing'));
    document.querySelectorAll('.voice-play').forEach(b=>b.textContent='▶');
  }
  const audioSrc = window._msgAudioMap && window._msgAudioMap[msgId];
  if(!audioSrc){ showToast('Audio topilmadi'); return; }
  const audio = new Audio(audioSrc);
  window._curAudio = audio; window._curAudioId = msgId;
  if(wave) wave.classList.add('playing');
  if(btn) btn.textContent='⏸';
  audio.play().catch(e=>showToast('Audio ochilmadi: '+e.message));
  audio.onended = ()=>{ if(wave) wave.classList.remove('playing'); if(btn) btn.textContent='▶'; window._curAudio=null; window._curAudioId=null; };
};

// ===================== BROADCAST =====================
let broadcastRecorder=null;

window.openBroadcastSheet = function(){
  $('broadcastText').value='';
  $('broadcastVoicePreview').innerHTML='';
  pendingBroadcastVoice = null;
  $('broadcastSheetOverlay').style.display='flex';
};

window.toggleBroadcastRecording = async function(){
  const btn = $('broadcastMicBtn');
  if(broadcastRecorder && broadcastRecorder.state==='recording'){ broadcastRecorder.stop(); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ showToast("Mikrofon qo'llab-quvvatlanmaydi"); return; }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    const chunks=[];
    const mime = pickSupportedMime();
    broadcastRecorder = mime ? new MediaRecorder(stream,{mimeType:mime}) : new MediaRecorder(stream);
    broadcastRecorder.ondataavailable = e=>{ if(e.data.size>0) chunks.push(e.data); };
    broadcastRecorder.onstop = async ()=>{
      stream.getTracks().forEach(t=>t.stop());
      btn.classList.remove('recording');
      const blob = new Blob(chunks,{type:broadcastRecorder.mimeType||'audio/webm'});
      if(!blob.size){ showToast('Audio yozilmadi'); return; }
      if(blob.size > MAX_AUDIO_BYTES){ showToast('Ovozli xabar juda katta'); pendingBroadcastVoice=null; return; }
      pendingBroadcastVoice = await blobToBase64(blob);
      $('broadcastVoicePreview').innerHTML = `<div style="display:flex;align-items:center;gap:8px;background:var(--card);padding:10px 12px;border-radius:12px">
        <span style="color:var(--green);font-size:13px;font-weight:600">🎤 Ovozli xabar tayyor</span>
        <button style="margin-left:auto;color:var(--red);font-size:12px;font-weight:700" onclick="pendingBroadcastVoice=null;document.getElementById('broadcastVoicePreview').innerHTML=''">O'chirish</button>
      </div>`;
    };
    broadcastRecorder.start();
    btn.classList.add('recording');
    showToast('🎤 Yozib boring...');
  }catch(e){ showToast('Mikrofonga ruxsat berilmadi'); }
};

window.sendBroadcast = async function(){
  const text = $('broadcastText').value.trim();
  if(!text && !pendingBroadcastVoice){ showToast("Matn yoki ovozli xabar kiriting"); return; }

  try{
    await addDoc(collection(db,'broadcastMessages'), {
      text: text || '', hasVoice: !!pendingBroadcastVoice, audio: pendingBroadcastVoice || null,
      senderId: CU.id, senderName: CU.name, time: serverTimestamp()
    });
    closeSheet('broadcastSheetOverlay');
    showToast('📢 Yuborildi');
    pendingBroadcastVoice = null;
  }catch(e){ showToast('Xatolik: '+e.message); }
};

window.openBroadcastFeed = function(){
  activeScreen = 'broadcast-feed';
  activeConvoKind = 'broadcast';
  activeConvoId = null;
  $('convoAvatar').className = 'avatar';
  $('convoAvatar').style.background = 'var(--amber)';
  $('convoAvatar').textContent = '📢';
  $('convoName').textContent = "E'lonlar";
  $('convoSub').textContent = "Ustozlardan umumiy xabarlar";
  $('homeScreen').style.display='none';
  $('listScreen').style.display='none';
  $('convoScreen').style.display='flex';
  $('composerBar').style.display='none';
  $('recBanner').style.display='none';
  $('convoManageBtn').classList.add('hidden');
  $('groupTabsBar').classList.add('hidden');
  $('messagesView').classList.remove('hidden');
  $('studentsView').classList.add('hidden');

  cleanupListeners();
  const q = query(collection(db,'broadcastMessages'), orderBy('time','desc'), limit(50));
  const unsub = onSnapshot(q, snap=>{
    const msgs=[];
    snap.forEach(d=>msgs.push({id:d.id,...d.data()}));
    renderBroadcastFeed(msgs);
  });
  listsUnsub.push(unsub);
};

function renderBroadcastFeed(msgs){
  const view = $('messagesView');
  window._msgAudioMap = window._msgAudioMap || {};
  if(!msgs.length){ view.innerHTML = `<div class="empty-list"><div class="ic">📢</div><div class="tt">Hali e'lon yo'q</div></div>`; return; }
  let h='';
  msgs.forEach(m=>{
    if(m.audio) window._msgAudioMap[m.id]=m.audio;
    h += `<div class="msg-row theirs"><div class="bubble" style="max-width:88%">
      <div class="bubble-sender">👨‍🏫 ${escapeHtml(m.senderName||'')}</div>
      ${m.text?`<div>${escapeHtml(m.text)}</div>`:''}
      ${m.hasVoice?`<div class="voice-bubble" id="voice-${m.id}" style="margin-top:${m.text?'8px':'0'}">
        <button class="voice-play" onclick="playVoice('${m.id}')">▶</button>
        <div class="voice-wave" id="wave-${m.id}">${'<span></span>'.repeat(18)}</div>
      </div>`:''}
      <div class="bubble-time">${fmtTime(m.time)}</div>
    </div></div>`;
  });
  view.innerHTML = h;
  view.scrollTop = view.scrollHeight;
}

// ===================== convo close override for special screens =====================
const _origCloseConvo = window.closeConvo;
window.closeConvo = function(){
  if(msgsUnsub){ msgsUnsub(); msgsUnsub=null; }
  cleanupListeners();
  $('convoScreen').style.display='none';
  $('groupTabsBar').classList.add('hidden');
  $('messagesView').classList.remove('hidden');
  $('studentsView').classList.add('hidden');
  openStudentCardId = null;
  if(activeScreen==='home' || activeScreen==='broadcast-feed'){
    activeScreen='home';
    $('homeScreen').style.display='flex';
    renderHome();
  } else {
    $('listScreen').style.display='flex';
  }
  activeConvoId=null; activeConvoKind=null;
};

// ===================== keyboard ENTER to send =====================
document.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey && document.activeElement===$('msgInput')){
    e.preventDefault();
    sendTextMessage();
  }
});

boot();
} // end runApp

initWhenReady();
