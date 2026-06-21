// ====== AcademyChat — asosiy mantiq ======
function initWhenReady(){
  if(!window._fbReady){
    window.addEventListener('firebase-ready', initWhenReady, {once:true});
    return;
  }
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
let allPeople = [];
let currentTab = 'chats';
let activeConvoId = null;
let activeConvoType = null; // 'dm' | 'broadcast-list'
let msgsUnsub = null;
let convoListUnsub = null;
let lastConvos = [];
let pendingBroadcastVoice = null;
let isAdminSetupMode = false;

const LS_KEY = 'academychat_session';

function $(id){ return document.getElementById(id); }
function showToast(msg){
  const t=$('toast'); t.textContent=msg; t.classList.add('on');
  clearTimeout(window._toastT);
  window._toastT=setTimeout(()=>t.classList.remove('on'),2200);
}
function initials(name){
  return (name||'?').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
}
function colorFor(seed){
  const colors=['#f5a623','#4d8dff','#1fc98d','#ef4866','#a86bf2','#ff7a45','#2fb8c4'];
  let h=0; for(const c of String(seed)) h=(h*31+c.charCodeAt(0))>>>0;
  return colors[h%colors.length];
}
function fmtTime(d){
  if(!d || !d.toDate) return '';
  return d.toDate().toLocaleTimeString('uz-UZ',{hour:'2-digit',minute:'2-digit'});
}
function fmtDay(d){
  if(!d || !d.toDate) return '';
  const dt = d.toDate();
  const today = new Date();
  if(dt.toDateString()===today.toDateString()) return 'Bugun';
  const yest = new Date(today); yest.setDate(yest.getDate()-1);
  if(dt.toDateString()===yest.toDateString()) return 'Kecha';
  return dt.toLocaleDateString('uz-UZ',{day:'numeric',month:'long'});
}
function dmId(a,b){ return [a,b].sort().join('__'); }
function escapeAttr(s){ return String(s).replace(/'/g,"\\'"); }
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

// ---------- AUTH ----------
function authError(msg){
  const el = $('authErr');
  el.textContent = msg;
  el.style.display = 'block';
}

window.submitAuth = async function(){
  const login = $('authLogin').value.trim().toLowerCase();
  const pass = $('authPass').value;
  if(!login || !pass){ authError('Login va parolni kiriting'); return; }
  if(!/^[a-z0-9_.]+$/.test(login)){ authError('Login faqat lotin harf/raqamdan iborat bo\'lsin'); return; }

  const btn = $('authSubmitBtn');
  btn.disabled = true;
  const email = loginToEmail(login);

  try{
    if(isAdminSetupMode){
      if(pass.length<6){ authError("Parol kamida 6 belgidan iborat bo'lishi kerak"); btn.disabled=false; return; }
      const userRef = doc(db,'users',login);
      const existing = await getDoc(userRef);
      if(existing.exists()){ authError('Bu login band, boshqasini tanlang'); btn.disabled=false; return; }

      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await setDoc(userRef, { login, name:'Admin', role:'admin', uid: cred.user.uid, createdAt: serverTimestamp() });
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
    if(e.code==='auth/invalid-credential' || e.code==='auth/user-not-found' || e.code==='auth/wrong-password'){
      authError('Login yoki parol xato');
    } else if(e.code==='auth/email-already-in-use'){
      authError('Bu login allaqachon band');
    } else {
      authError('Xatolik: ' + e.message);
    }
  }
  btn.disabled = false;
};

window.logout = function(){
  localStorage.removeItem(LS_KEY);
  if(msgsUnsub) msgsUnsub();
  if(convoListUnsub) convoListUnsub();
  signOut(auth);
  CU = null;
  location.reload();
};

// ---------- BOOT ----------
async function boot(){
  onAuthStateChanged(auth, async (fbUser)=>{
    if(fbUser){
      // Firebase Auth orqali tasdiqlangan foydalanuvchi
      const saved = localStorage.getItem(LS_KEY);
      if(saved){
        try{
          const parsed = JSON.parse(saved);
          const snap = await getDoc(doc(db,'users',parsed.id));
          if(snap.exists() && snap.data().uid===fbUser.uid){
            const d = snap.data();
            CU = { id: parsed.id, login: parsed.id, name: d.name, role: d.role };
            enterApp();
            return;
          }
        }catch(e){}
      }
      // localStorage mos kelmasa, uid orqali users to'plamidan qidiramiz
      try{
        const q = query(collection(db,'users'), where('uid','==',fbUser.uid));
        const qsnap = await getDocs(q);
        if(!qsnap.empty){
          const d0 = qsnap.docs[0];
          const d = d0.data();
          CU = { id: d0.id, login: d0.id, name: d.name, role: d.role };
          localStorage.setItem(LS_KEY, JSON.stringify(CU));
          enterApp();
          return;
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

  // adminFlag mavjudligini tekshirish — agar yo'q bo'lsa, Admin Setup rejimi
  try{
    const flagSnap = await getDoc(doc(db,'meta','adminFlag'));
    isAdminSetupMode = !flagSnap.exists();
  }catch(e){
    isAdminSetupMode = false;
  }

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
  if(CU.role==='admin'){
    chip.textContent = '👑 Admin';
    chip.className = 'role-chip admin';
  } else if(CU.role==='teacher'){
    chip.textContent = '👨‍🏫 Ustoz';
    chip.className = 'role-chip teacher';
  } else {
    chip.textContent = "🎒 O'quvchi";
    chip.className = 'role-chip student';
  }
  $('fabBtn').classList.toggle('hidden', CU.role==='student');
  loadPeople();
  subscribeConvoList();
  renderTab();
}

// ---------- PEOPLE ----------
async function loadPeople(){
  const snap = await getDocs(collection(db,'users'));
  allPeople = [];
  snap.forEach(d=>{
    if(d.id===CU.id) return;
    const data = d.data();
    allPeople.push({ id:d.id, name:data.name, role:data.role });
  });
  if(currentTab==='people') renderPeopleList();
}

// ---------- TABS ----------
window.goTab = function(tab){
  currentTab = tab;
  $('navChats').classList.toggle('on', tab==='chats');
  $('navPeople').classList.toggle('on', tab==='people');
  renderTab();
};

function renderTab(){
  if(currentTab==='chats') renderChatsList();
  else renderPeopleList();
}

// ---------- CHATS LIST ----------
function subscribeConvoList(){
  if(convoListUnsub) convoListUnsub();
  const q = query(collection(db,'conversations'), where('participants','array-contains', CU.id));
  convoListUnsub = onSnapshot(q, snap=>{
    lastConvos = [];
    snap.forEach(d=> lastConvos.push({ id:d.id, ...d.data() }));
    lastConvos.sort((a,b)=>{
      const at = a.lastTime?.toMillis ? a.lastTime.toMillis() : 0;
      const bt = b.lastTime?.toMillis ? b.lastTime.toMillis() : 0;
      return bt-at;
    });
    if(currentTab==='chats') renderChatsList();
  });
}

function renderChatsList(){
  const pad = $('listPad');
  let h = '';

  if(CU.role==='student'){
    h += `<div class="announce-card" onclick="openBroadcastView()">
      <div class="ic">📢</div>
      <div style="flex:1">
        <div class="tt">E'lonlar</div>
        <div class="ds">Ustozlardan umumiy xabarlar</div>
      </div>
      <div style="color:var(--text3);font-size:18px">›</div>
    </div>`;
  } else {
    h += `<div class="announce-card" onclick="openBroadcastSheet()">
      <div class="ic">📢</div>
      <div style="flex:1">
        <div class="tt">Umumiy xabar yuborish</div>
        <div class="ds">Barcha o'quvchilarga e'lon yuborish</div>
      </div>
      <div style="color:var(--text3);font-size:18px">›</div>
    </div>`;
  }

  const dms = lastConvos.filter(c=>c.type==='dm');

  if(!dms.length){
    h += `<div class="empty-list">
      <div class="ic">💬</div>
      <div class="tt">Hali suhbatlar yo'q</div>
      <div class="ds">Pastdagi ✏️ tugmasi orqali yangi suhbat boshlang</div>
    </div>`;
  } else {
    h += `<div class="section-label">Suhbatlar</div>`;
    dms.forEach(c=>{
      const peerId = c.participants.find(p=>p!==CU.id);
      const peerName = c.names ? (c.names[peerId]||peerId) : peerId;
      const peerRole = c.roles ? c.roles[peerId] : '';
      const unread = (c.unread && c.unread[CU.id]) || 0;
      let lastMsgPreview = c.lastMsg || '';
      if(c.lastType==='voice') lastMsgPreview = '🎤 Ovozli xabar';
      h += `<div class="chat-row" onclick="openDM('${peerId}','${escapeAttr(peerName)}','${peerRole}')">
        <div class="avatar" style="background:${colorFor(peerId)}">${initials(peerName)}
          ${unread>0?`<span class="unread-dot">${unread>9?'9+':unread}</span>`:''}
        </div>
        <div class="chat-row-info">
          <div class="chat-row-top">
            <div class="chat-row-name">${peerName}</div>
            <div class="chat-row-time">${c.lastTime? fmtTime(c.lastTime):''}</div>
          </div>
          <div class="chat-row-msg">${lastMsgPreview || (peerRole==='admin'?'👑 Admin':peerRole==='teacher'?'👨‍🏫 Ustoz':"🎒 O'quvchi")}</div>
        </div>
      </div>`;
    });
  }
  pad.innerHTML = h;
}

// ---------- PEOPLE LIST ----------
function renderPeopleList(){
  const pad = $('listPad');
  let h = '';
  const teachers = allPeople.filter(p=>p.role==='teacher');
  const students = allPeople.filter(p=>p.role==='student');

  if(CU.role==='admin'){
    h += `<button class="btn-primary" style="margin-bottom:16px" onclick="openAddPersonSheet()">➕ Yangi odam qo'shish</button>`;
  }

  if(!allPeople.length){
    h += `<div class="empty-list"><div class="ic">👥</div><div class="tt">Hali boshqa hech kim yo'q</div></div>`;
  } else {
    if(teachers.length){
      h += `<div class="section-label">👨‍🏫 Ustozlar</div>`;
      teachers.forEach(p=>{ h += personRowHtml(p); });
    }
    if(students.length && (CU.role==='teacher' || CU.role==='admin')){
      h += `<div class="section-label">🎒 O'quvchilar</div>`;
      students.forEach(p=>{ h += personRowHtml(p); });
    }
  }
  pad.innerHTML = h;
}

function personRowHtml(p){
  const delBtn = CU.role==='admin' ? `<button class="person-del" onclick="event.stopPropagation();deletePerson('${p.id}','${escapeAttr(p.name)}')">🗑️</button>` : '';
  return `<div class="chat-row" style="position:relative" onclick="openDM('${p.id}','${escapeAttr(p.name)}','${p.role}')">
    <div class="avatar" style="background:${colorFor(p.id)}">${initials(p.name)}</div>
    <div class="chat-row-info">
      <div class="chat-row-name">${p.name}</div>
      <div class="chat-row-msg">${p.role==='teacher'?'👨‍🏫 Ustoz':"🎒 O'quvchi"} · <span style="opacity:.7">@${p.id}</span></div>
    </div>
    ${delBtn}
  </div>`;
}

// ---------- ADD PERSON (admin only) ----------
window.openAddPersonSheet = function(){
  $('addPersonName').value='';
  $('addPersonLogin').value='';
  $('addPersonPass').value='';
  setAddPersonRole('student');
  $('addPersonSheetOverlay').style.display='flex';
};

let addPersonRole = 'student';
window.setAddPersonRole = function(role){
  addPersonRole = role;
  document.querySelectorAll('.auth-tab[data-addrole]').forEach(el=>el.classList.toggle('on', el.dataset.addrole===role));
};

window.submitAddPerson = async function(){
  const name = $('addPersonName').value.trim();
  const login = $('addPersonLogin').value.trim().toLowerCase();
  const pass = $('addPersonPass').value;
  if(!name || !login || !pass){ showToast("Barcha maydonlarni to'ldiring"); return; }
  if(pass.length<6){ showToast("Parol kamida 6 belgidan iborat bo'lsin"); return; }
  if(!/^[a-z0-9_.]+$/.test(login)){ showToast('Login faqat lotin harf/raqamdan iborat bo\'lsin'); return; }

  const userRef = doc(db,'users',login);
  const existing = await getDoc(userRef);
  if(existing.exists()){ showToast('Bu login band'); return; }

  try{
    // Ikkinchi (vaqtinchalik) Firebase App orqali yangi auth hisobini yaratamiz,
    // shunda admin sessiyasi o'zgarmaydi
    const { initializeApp, deleteApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const { getAuth: getAuth2, createUserWithEmailAndPassword: createUser2 } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");

    const tempApp = initializeApp(window._firebaseConfig, 'tempAddUser_'+Date.now());
    const tempAuth = getAuth2(tempApp);
    const email = loginToEmail(login);
    const cred = await createUser2(tempAuth, email, pass);
    const newUid = cred.user.uid;
    await deleteApp(tempApp);

    await setDoc(userRef, { login, name, role: addPersonRole, uid: newUid, createdAt: serverTimestamp(), createdBy: CU.id });
    closeSheet('addPersonSheetOverlay');
    showToast(`✅ ${name} qo'shildi`);
    await loadPeople();
  }catch(e){
    if(e.code==='auth/email-already-in-use'){ showToast('Bu login allaqachon band'); }
    else { showToast('Xatolik: '+e.message); }
  }
};

window.deletePerson = async function(personId, personName){
  if(!confirm(`${personName}ni o'chirishni tasdiqlaysizmi?`)) return;
  await deleteDoc(doc(db,'users',personId));
  showToast("O'chirildi");
  await loadPeople();
};

// ---------- NEW CHAT SHEET ----------
window.openNewSheet = function(){
  const body = $('newSheetBody');
  let h = '';
  if(!allPeople.length){
    h = `<div class="empty-list"><div class="ic">👥</div><div class="tt">Hozircha hech kim yo'q</div></div>`;
  } else {
    let visible;
    if(CU.role==='admin') visible = allPeople;
    else if(CU.role==='teacher') visible = allPeople; // teacher can msg admin + students
    else visible = allPeople.filter(p=>p.role==='teacher' || p.role==='admin'); // student -> teacher/admin only
    if(!visible.length){
      h = `<div class="empty-list"><div class="ic">👨‍🏫</div><div class="tt">Hali hech kim yo'q</div></div>`;
    }
    visible.forEach(p=>{
      const roleLabel = p.role==='admin'?'Admin':p.role==='teacher'?'Ustoz':"O'quvchi";
      h += `<div class="person-row" onclick="closeSheet('newSheetOverlay');openDM('${p.id}','${escapeAttr(p.name)}','${p.role}')">
        <div class="avatar" style="background:${colorFor(p.id)}">${initials(p.name)}</div>
        <div>
          <div class="person-row-name">${p.name}</div>
          <div class="person-row-sub">${roleLabel}</div>
        </div>
      </div>`;
    });
  }
  body.innerHTML = h;
  $('newSheetOverlay').style.display='flex';
};

window.closeSheet = function(id){ $(id).style.display='none'; };

window.openBroadcastSheet = function(){
  $('broadcastText').value='';
  $('broadcastVoicePreview').innerHTML='';
  pendingBroadcastVoice = null;
  $('broadcastSheetOverlay').style.display='flex';
};

// ---------- DM CONVERSATION ----------
window.openDM = async function(peerId, peerName, peerRole){
  activeConvoType = 'dm';
  activeConvoId = dmId(CU.id, peerId);

  $('convoAvatar').style.background = colorFor(peerId);
  $('convoAvatar').textContent = initials(peerName);
  $('convoName').textContent = peerName;
  $('convoSub').textContent = peerRole==='admin' ? '👑 Admin' : peerRole==='teacher' ? '👨‍🏫 Ustoz' : "🎒 O'quvchi";

  $('listScreen').style.display='none';
  $('convoScreen').style.display='flex';
  $('composerBar').style.display='flex';
  $('recBanner').style.display='none';
  $('msgInput').value=''; $('msgInput').style.height='auto';
  toggleSendBtn();

  const convoRef = doc(db,'conversations',activeConvoId);
  const snap = await getDoc(convoRef);
  if(!snap.exists()){
    await setDoc(convoRef,{
      type:'dm',
      participants:[CU.id, peerId],
      names:{ [CU.id]: CU.name, [peerId]: peerName },
      roles:{ [CU.id]: CU.role, [peerId]: peerRole },
      lastMsg:'', lastTime: serverTimestamp(), lastType:'text',
      unread:{ [CU.id]:0, [peerId]:0 }
    });
  } else {
    const data = snap.data();
    const unread = data.unread||{};
    unread[CU.id]=0;
    updateDoc(convoRef,{unread});
  }

  subscribeMessages(activeConvoId);
};

window.closeConvo = function(){
  if(msgsUnsub){ msgsUnsub(); msgsUnsub=null; }
  activeConvoId=null; activeConvoType=null;
  $('convoScreen').style.display='none';
  $('listScreen').style.display='flex';
};

function subscribeMessages(convoId){
  if(msgsUnsub) msgsUnsub();
  const msgsRef = collection(db,'conversations',convoId,'messages');
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
  let h = '';
  let lastDay = '';
  msgs.forEach(m=>{
    if(!m.time) return;
    const day = fmtDay(m.time);
    if(day!==lastDay){ h += `<div class="msg-day">${day}</div>`; lastDay = day; }
    const mine = m.senderId === CU.id;
    const rowClass = mine ? 'mine' : 'theirs';
    if(m.kind==='voice'){
      h += `<div class="msg-row ${rowClass}">
        <div class="bubble">
          <div class="voice-bubble" id="voice-${m.id}">
            <button class="voice-play" onclick="playVoice('${m.id}')">▶</button>
            <div class="voice-wave" id="wave-${m.id}">${'<span></span>'.repeat(18)}</div>
            <div class="voice-dur">${m.duration||0}s</div>
          </div>
          <div class="bubble-time">${fmtTime(m.time)}</div>
        </div>
      </div>`;
    } else {
      h += `<div class="msg-row ${rowClass}">
        <div class="bubble">
          <div>${escapeHtml(m.text||'')}</div>
          <div class="bubble-time">${fmtTime(m.time)}</div>
        </div>
      </div>`;
    }
  });
  view.innerHTML = h || `<div class="empty-list"><div class="ic">💬</div><div class="tt">Hali xabar yo'q</div><div class="ds">Birinchi xabarni yuboring</div></div>`;
  view.scrollTop = view.scrollHeight;
}

// ---------- SENDING TEXT ----------
window.autoGrow = function(el){
  el.style.height='auto';
  el.style.height = Math.min(el.scrollHeight,110)+'px';
};
window.toggleSendBtn = function(){
  const has = $('msgInput').value.trim().length>0;
  $('sendBtn').classList.toggle('hidden', !has);
  $('micBtn').classList.toggle('hidden', has);
};

window.sendTextMessage = async function(){
  const text = $('msgInput').value.trim();
  if(!text || !activeConvoId || activeConvoType!=='dm') return;
  $('msgInput').value=''; $('msgInput').style.height='auto';
  toggleSendBtn();

  const msgsRef = collection(db,'conversations',activeConvoId,'messages');
  await addDoc(msgsRef, {
    kind:'text', text, senderId: CU.id, senderName: CU.name, time: serverTimestamp()
  });

  await bumpConvo(text, 'text');
};

async function bumpConvo(preview, type){
  const convoRef = doc(db,'conversations',activeConvoId);
  const snap = await getDoc(convoRef);
  if(!snap.exists()) return;
  const data = snap.data();
  const unread = data.unread || {};
  data.participants.forEach(p=>{ if(p!==CU.id) unread[p] = (unread[p]||0)+1; });
  await updateDoc(convoRef, { lastMsg: preview, lastTime: serverTimestamp(), lastType: type, unread });
}

// ---------- VOICE RECORDING (DM) ----------
let mediaRecorder=null, recChunks=[], recStartTime=0, recTimerHandle=null, recStream=null;
const MAX_REC_SECONDS = 60;
const MAX_AUDIO_BYTES = 900*1024;

async function startRec(onStop){
  try{
    recStream = await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(e){
    showToast("🎤 Mikrofonga ruxsat berilmadi");
    return false;
  }
  recChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = new MediaRecorder(recStream, mime?{mimeType:mime}:undefined);
  mediaRecorder.ondataavailable = e=>{ if(e.data.size>0) recChunks.push(e.data); };
  mediaRecorder.onstop = onStop;
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
  if(mediaRecorder && mediaRecorder.state==='recording'){
    mediaRecorder.stop();
    return;
  }
  const ok = await startRec(async ()=>{
    const elapsed = Math.round((Date.now()-recStartTime)/1000);
    stopRecStream();
    $('recBanner').style.display='none';
    $('micBtn').classList.remove('recording');
    if(window._recCancelled){ window._recCancelled=false; return; }
    if(elapsed<1){ showToast('Juda qisqa ovozli xabar'); return; }
    const blob = new Blob(recChunks, {type: mediaRecorder.mimeType||'audio/webm'});
    if(blob.size > MAX_AUDIO_BYTES){ showToast("Ovozli xabar juda katta, qisqaroq yozing"); return; }
    const base64 = await blobToBase64(blob);
    await sendVoiceMessage(base64, elapsed);
  });
  if(!ok) return;
  $('micBtn').classList.add('recording');
  $('recBanner').style.display='flex';
  let secs=0;
  $('recTime').textContent='0:00';
  recTimerHandle = setInterval(()=>{
    secs++;
    const m=Math.floor(secs/60), s=secs%60;
    $('recTime').textContent = `${m}:${String(s).padStart(2,'0')}`;
    if(secs>=MAX_REC_SECONDS && mediaRecorder && mediaRecorder.state==='recording'){
      mediaRecorder.stop();
    }
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
  const msgsRef = collection(db,'conversations',activeConvoId,'messages');
  await addDoc(msgsRef, {
    kind:'voice', audio: base64, duration, senderId: CU.id, senderName: CU.name, time: serverTimestamp()
  });
  await bumpConvo('🎤 Ovozli xabar', 'voice');
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
  audio.play();
  audio.onended = ()=>{
    if(wave) wave.classList.remove('playing');
    if(btn) btn.textContent='▶';
    window._curAudio=null; window._curAudioId=null;
  };
};

// ---------- BROADCAST (teacher -> all students) ----------
let broadcastRecorder=null;

window.toggleBroadcastRecording = async function(){
  const btn = $('broadcastMicBtn');
  if(broadcastRecorder && broadcastRecorder.state==='recording'){
    broadcastRecorder.stop();
    return;
  }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    const chunks=[];
    broadcastRecorder = new MediaRecorder(stream);
    broadcastRecorder.ondataavailable = e=>{ if(e.data.size>0) chunks.push(e.data); };
    broadcastRecorder.onstop = async ()=>{
      stream.getTracks().forEach(t=>t.stop());
      btn.classList.remove('recording');
      const blob = new Blob(chunks,{type:broadcastRecorder.mimeType||'audio/webm'});
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
  }catch(e){
    showToast('Mikrofonga ruxsat berilmadi');
  }
};

window.sendBroadcast = async function(){
  const text = $('broadcastText').value.trim();
  if(!text && !pendingBroadcastVoice){ showToast("Matn yoki ovozli xabar kiriting"); return; }

  await addDoc(collection(db,'broadcastMessages'), {
    text: text || '',
    hasVoice: !!pendingBroadcastVoice,
    audio: pendingBroadcastVoice || null,
    senderId: CU.id,
    senderName: CU.name,
    time: serverTimestamp()
  });

  closeSheet('broadcastSheetOverlay');
  showToast('📢 Yuborildi');
  pendingBroadcastVoice = null;
};

window.openBroadcastView = async function(){
  activeConvoType = 'broadcast-list';
  activeConvoId = null;
  $('convoAvatar').style.background = 'var(--amber)';
  $('convoAvatar').textContent = '📢';
  $('convoName').textContent = "E'lonlar";
  $('convoSub').textContent = "Ustozlardan umumiy xabarlar";
  $('listScreen').style.display='none';
  $('convoScreen').style.display='flex';
  $('composerBar').style.display='none';
  $('recBanner').style.display='none';

  if(msgsUnsub) msgsUnsub();
  const q = query(collection(db,'broadcastMessages'), orderBy('time','desc'), limit(50));
  msgsUnsub = onSnapshot(q, snap=>{
    const msgs=[];
    snap.forEach(d=>msgs.push({id:d.id,...d.data()}));
    renderBroadcastFeed(msgs);
  });
};

function renderBroadcastFeed(msgs){
  const view = $('messagesView');
  window._msgAudioMap = window._msgAudioMap || {};
  if(!msgs.length){
    view.innerHTML = `<div class="empty-list"><div class="ic">📢</div><div class="tt">Hali e'lon yo'q</div></div>`;
    return;
  }
  let h='';
  msgs.forEach(m=>{
    if(m.audio) window._msgAudioMap[m.id]=m.audio;
    h += `<div class="msg-row theirs">
      <div class="bubble" style="max-width:88%">
        <div class="bubble-sender">👨‍🏫 ${m.senderName}</div>
        ${m.text?`<div>${escapeHtml(m.text)}</div>`:''}
        ${m.hasVoice?`<div class="voice-bubble" id="voice-${m.id}" style="margin-top:${m.text?'8px':'0'}">
          <button class="voice-play" onclick="playVoice('${m.id}')">▶</button>
          <div class="voice-wave" id="wave-${m.id}">${'<span></span>'.repeat(18)}</div>
        </div>`:''}
        <div class="bubble-time">${fmtTime(m.time)}</div>
      </div>
    </div>`;
  });
  view.innerHTML = h;
  view.scrollTop = view.scrollHeight;
}

// ---------- init ----------
document.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey && document.activeElement===$('msgInput')){
    e.preventDefault();
    sendTextMessage();
  }
});

boot();
} // end runApp

initWhenReady();
