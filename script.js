let currentPage = 'dashboard';
let currentBaseScore = 0;
let formDataCache = null;
let autoFillActualScore = true;

// === SECURITY: Auto-logout after 30 minutes of inactivity ===
let _sessionTimer = null;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function resetSessionTimer() {
  clearTimeout(_sessionTimer);
  if (window.currentUserRole) {
    _sessionTimer = setTimeout(() => {
      window.currentUserRole = null;
      document.getElementById('loginModal').style.display = 'flex';
      document.getElementById('app').style.display = 'none';
      showToast('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'error');
    }, SESSION_TIMEOUT_MS);
  }
}

// Reset timer on any user activity
['click', 'keydown', 'mousemove', 'touchstart'].forEach(evt => {
  document.addEventListener(evt, resetSessionTimer, { passive: true });
});

function showLoading(status){ document.getElementById('loading').style.display = status ? 'flex' : 'none'; }
function showToast(message,type='success'){
  const el=document.getElementById('toast');
  el.className=type; el.textContent=message; el.style.display='block';
  const duration = type === 'error' ? 5000 : 3500;
  clearTimeout(showToast._t); showToast._t=setTimeout(()=>{el.style.display='none';},duration);
}
function escapeHtml(v){ return String(v ?? '').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function fmtNum(v){ const n=Number(v||0); return Number.isInteger(n) ? String(n) : n.toFixed(2); }
function emptyRows(colspan,text='Không có dữ liệu'){ return `<tr><td colspan="${colspan}" class="center empty">${text}</td></tr>`; }
function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// Thay thế bằng URL Web App Google Apps Script của bạn (nhớ chọn Anyone)
const APP_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyNyK_nfSu9xw6JmR9obSMbEI0MP5kkepuv-iBnGybY2Em9mXg0N3MScxpXlqJiq2xL/exec";

const FRONTEND_CACHE = {};
const CACHE_METHODS = ['getKhoi', 'getNhomLoi', 'getLopTheoKhoi', 'getHocSinhTheoLop', 'getLoiTheoNhom', 'getDanhSachTuan', 'getLop', 'getFormInitData'];
const LOCAL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// localStorage cache with TTL
function lsGet(key) {
  try {
    const raw = localStorage.getItem('lms_' + key);
    if (!raw) return undefined;
    const { data, exp } = JSON.parse(raw);
    if (Date.now() > exp) { localStorage.removeItem('lms_' + key); return undefined; }
    return data;
  } catch(e) { return undefined; }
}
function lsSet(key, data) {
  try {
    localStorage.setItem('lms_' + key, JSON.stringify({ data, exp: Date.now() + LOCAL_CACHE_TTL }));
  } catch(e) { /* storage full, ignore */ }
}

async function gs(method, ...args) {
  const cacheKey = method + JSON.stringify(args);
  // Level 1: in-memory cache (instant)
  if (CACHE_METHODS.includes(method) && FRONTEND_CACHE[cacheKey] !== undefined) {
    return FRONTEND_CACHE[cacheKey];
  }
  // Level 2: localStorage cache (survives page reload, 10 min TTL)
  if (CACHE_METHODS.includes(method)) {
    const lsData = lsGet(cacheKey);
    if (lsData !== undefined) {
      FRONTEND_CACHE[cacheKey] = lsData;
      return lsData;
    }
  }

  const MAX_RETRIES = 3;
  const payload = JSON.stringify({ method, args });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(APP_SCRIPT_URL, {
        method: "POST",
        redirect: "follow",
        credentials: "omit",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: payload,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const text = await res.text();

      // Google Apps Script sometimes returns HTML instead of JSON
      // (auth redirect, rate limit, multi-account conflict)
      if (text.trimStart().startsWith("<") || text.trimStart().startsWith("<!DOCTYPE")) {
        console.warn(`[gs] Attempt ${attempt}/${MAX_RETRIES}: Got HTML instead of JSON for "${method}". Retrying...`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
          continue;
        }
        throw new Error("Máy chủ Google tạm thời không phản hồi. Vui lòng thử lại sau vài giây.");
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.warn(`[gs] Attempt ${attempt}/${MAX_RETRIES}: JSON parse failed for "${method}":`, text.substring(0, 200));
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
          continue;
        }
        throw new Error("Dữ liệu trả về không hợp lệ. Vui lòng tải lại trang.");
      }

      if (!data.success) {
        throw new Error(data.error || "Lỗi không xác định từ server");
      }

      if (CACHE_METHODS.includes(method)) {
        FRONTEND_CACHE[cacheKey] = data.result;
        lsSet(cacheKey, data.result);
      }
      return data.result;

    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`[gs] Attempt ${attempt}/${MAX_RETRIES}: Timeout for "${method}".`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
          continue;
        }
        throw new Error("Kết nối quá chậm. Vui lòng kiểm tra mạng và thử lại.");
      }
      // If it's our own thrown error (not a network/retry issue), don't retry
      if (err.message && !err.message.includes("Failed to fetch")) {
        throw err;
      }
      // Network error - retry
      console.warn(`[gs] Attempt ${attempt}/${MAX_RETRIES}: Network error for "${method}":`, err.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw new Error("Lỗi kết nối mạng. Vui lòng kiểm tra Internet và thử lại.");
    }
  }
}
async function safeTask(task){ 
  try{ 
    showLoading(true); 
    await task(); 
  } catch(err){ 
    console.error('[safeTask]', err); 
    showToast(err.message || String(err),'error'); 
  } finally { 
    showLoading(false); 
  } 
}

function toggleSidebar() {
  document.querySelector('.sidebar').classList.toggle('show');
  document.getElementById('sidebarOverlay').classList.toggle('show');
}

async function openPage(page, el){
  if (window.innerWidth <= 768) {
    document.querySelector('.sidebar').classList.remove('show');
    document.getElementById('sidebarOverlay').classList.remove('show');
  }
  currentPage = page;
  document.querySelectorAll('.menu-item').forEach(x=>x.classList.remove('active'));
  if(el) el.classList.add('active');
  if(!el){ const target=document.querySelector(`.menu-item[data-page="${page}"]`); if(target) target.classList.add('active'); }
  if(page==='dashboard') return renderDashboardPage();
  if(page==='form') return renderFormPage();
  if(page==='student') return renderStudentPage();
  if(page==='rank') return renderRankPage();
  if(page==='week') return renderWeekPage();
  if(page==='classSchedule') return renderClassSchedulePage();
  if(page==='export') return renderExportPage();
  if(page==='admin') return renderAdminPage();
  if(page==='score') return renderScorePage();
}

async function renderDashboardPage(){
  document.getElementById('app').innerHTML = `
    <div class="card">
      <div class="card-title">🏠 Dashboard tuần</div>
      <div class="grid-2">
        <div>
          <label>Tuần thi đua</label>
          <select id="dashboardWeek" onchange="loadDashboardData()"></select>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="label">Tổng lỗi</div><div class="value" id="dashTongLoi">0</div></div>
        <div class="stat"><div class="label">Tổng điểm trừ</div><div class="value" id="dashTongDiem">0</div></div>
        <div class="stat"><div class="label">Học sinh vi phạm</div><div class="value" id="dashSoHS">0</div></div>
        <div class="stat"><div class="label">Lớp vi phạm</div><div class="value" id="dashSoLop">0</div></div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="sub-title">📌 Thống kê nhóm lỗi</div>
        <div class="table-wrap"><table><thead><tr><th>Nhóm lỗi</th><th>Số lượng</th></tr></thead><tbody id="dashNhomLoi"></tbody></table></div>
      </div>
      <div class="card">
        <div class="sub-title">🏆 Top lớp tuần</div>
        <div class="table-wrap"><table><thead><tr><th>Hạng</th><th>Lớp</th><th>Tổng lỗi</th><th>Kết quả thi đua tự động</th></tr></thead><tbody id="dashTopLop"></tbody></table></div>
      </div>
    </div>`;
  await safeTask(async()=>{
    const weeks = await gs('getDanhSachTuan');
    document.getElementById('dashboardWeek').innerHTML = weeks.map(x=>`<option value="${x.value}" ${x.current?'selected':''}>${escapeHtml(x.label)}</option>`).join('');
    await loadDashboardData();
  });
}

async function loadDashboardData(){
  const tuanEl = document.getElementById('dashboardWeek');
  if (!tuanEl) return;
  const tuan = tuanEl.value;
  await safeTask(async()=>{
    let dash, thongKe;
    try {
      // Try combined API first (faster, 1 call)
      const data = await gs('getDashboardDataV123', tuan);
      dash = data.dash;
      thongKe = data.thongKe;
    } catch(e) {
      // Fallback to separate calls if new API not deployed yet
      console.warn('[Dashboard] getDashboardDataV123 failed, falling back to separate calls:', e.message);
      dash = await gs('getDashboardTuan', tuan);
      thongKe = await gs('getThongKeNhomLoi', tuan);
    }
    const elTongLoi = document.getElementById('dashTongLoi');
    if (elTongLoi) {
      elTongLoi.textContent = fmtNum(dash.TONG_LOI);
      document.getElementById('dashTongDiem').textContent = fmtNum(dash.TONG_DIEM_TRU);
      document.getElementById('dashSoHS').textContent = fmtNum(dash.SO_HOC_SINH);
      document.getElementById('dashSoLop').textContent = fmtNum(dash.SO_LOP);
      const nhomRows = Object.keys(thongKe).length ? Object.keys(thongKe).map(k=>`<tr><td>${escapeHtml(k)}</td><td class="center">${fmtNum(thongKe[k])}</td></tr>`).join('') : emptyRows(2);
      document.getElementById('dashNhomLoi').innerHTML = nhomRows;
      const top = dash.TOP_LOP || [];
      document.getElementById('dashTopLop').innerHTML = top.length ? top.map(x=>`<tr><td class="center">${fmtNum(x.XEP_HANG)}</td><td class="center bold">${escapeHtml(x.LOP)}</td><td class="center">${fmtNum(x.TONG_LOI)}</td><td class="right">${fmtNum(x.DIEM_THI_DUA)}</td></tr>`).join('') : emptyRows(4);
    }
  });
}

async function renderFormPage(){
  document.getElementById('app').innerHTML = `
    <div class="card">
      <div class="card-title">📝 Nhập vi phạm</div>
      <div class="grid-2">
        <div><label>Ngày vi phạm</label><input type="date" id="ngayVP"></div>
        <div><label>Khối</label><select id="khoi" onchange="changeKhoi()"></select></div>
        <div><label>Lớp</label><select id="lop" onchange="changeLop()"></select></div>
        <div><label>Học sinh</label><select id="hocSinh"></select></div>
        <div><label>Nhóm lỗi</label><select id="nhomLoi" onchange="changeNhomLoi()"></select></div>
        <div><label>Lỗi vi phạm</label><select id="maLoi" onchange="changeLoi()"></select></div>
        <div><label>Điểm trừ chuẩn</label><input id="diemGoc" readonly></div>
        <div><label>Số lần / mức độ</label><input id="soLan" type="number" min="1" step="1" value="1" oninput="recalcActualScore()"></div>
        <div><label>Điểm trừ thực tế</label><input id="diemTru" type="number" step="0.01" oninput="autoFillActualScore=false"></div>
        <div><label>Gợi ý tính điểm</label><div class="muted-box">Giáo viên có thể sửa Điểm trừ thực tế nếu muốn trừ nhiều hơn lỗi chuẩn.</div></div>
      </div>
      <div style="margin-top:14px"><label>Ghi chú</label><textarea id="ghiChu"></textarea></div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn-primary" onclick="saveFormViPham()">💾 Lưu vi phạm</button>
        <button class="btn-secondary" onclick="resetFormViPham()">↺ Đặt lại</button>
      </div>
    </div>`;
  document.getElementById('ngayVP').value = todayStr();
  await safeTask(async()=>{
    let khoiList, nhomList;
    try {
      let initData = formDataCache;
      if (!initData) {
        initData = await gs('getFormInitData');
        formDataCache = initData;
      }
      khoiList = initData.khoiList || [];
      nhomList = initData.nhomList || [];
    } catch(e) {
      console.warn('[Form] getFormInitData failed, falling back:', e.message);
      khoiList = await gs('getKhoi');
      nhomList = await gs('getNhomLoi');
    }
      
    document.getElementById('khoi').innerHTML = `<option value="">-- Chọn khối --</option>` + 
      khoiList.map(x => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
        
    document.getElementById('nhomLoi').innerHTML = `<option value="">-- Chọn nhóm lỗi --</option>` + 
      nhomList.map(x => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');

    document.getElementById('lop').innerHTML = `<option value="">-- Chọn lớp --</option>`;
    document.getElementById('hocSinh').innerHTML = `<option value="">-- Chọn học sinh --</option>`;
    document.getElementById('maLoi').innerHTML = `<option value="">-- Chọn lỗi --</option>`;
  });
}
function resetFormViPham(){ 
  autoFillActualScore=true; 
  currentBaseScore=0; 
  if (currentPage !== 'form' || !document.getElementById('ngayVP')) return;
  document.getElementById('ngayVP').value = todayStr();
  document.getElementById('khoi').value = '';
  document.getElementById('lop').innerHTML = '<option value="">-- Chọn lớp --</option>';
  document.getElementById('hocSinh').innerHTML = '<option value="">-- Chọn học sinh --</option>';
  document.getElementById('nhomLoi').value = '';
  document.getElementById('maLoi').innerHTML = '<option value="">-- Lỗi vi phạm --</option>';
  document.getElementById('diemGoc').value = '';
  document.getElementById('soLan').value = '1';
  document.getElementById('diemTru').value = '';
  document.getElementById('ghiChu').value = '';
}
async function changeKhoi(){
  const khoi = document.getElementById('khoi').value;
  document.getElementById('lop').innerHTML = `<option value="">-- Chọn lớp --</option>`;
  document.getElementById('hocSinh').innerHTML = `<option value="">-- Chọn học sinh --</option>`;
  if(!khoi) return;
  await safeTask(async()=>{
    const lopList = await gs('getLopTheoKhoi', khoi);
    document.getElementById('lop').innerHTML = `<option value="">-- Chọn lớp --</option>` + lopList.map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
  });
}
async function changeLop(){
  const lop = document.getElementById('lop').value;
  document.getElementById('hocSinh').innerHTML = `<option value="">-- Chọn học sinh --</option>`;
  if(!lop) return;
  await safeTask(async()=>{
    const hsList = await gs('getHocSinhTheoLop', lop);
    document.getElementById('hocSinh').innerHTML = `<option value="">-- Chọn học sinh --</option>` + hsList.map(x=>`<option value="${escapeHtml(x.ID_HS)}">${escapeHtml(x.HO_TEN)}</option>`).join('');
  });
}
async function changeNhomLoi(){
  const nhom = document.getElementById('nhomLoi').value;
  document.getElementById('maLoi').innerHTML = `<option value="">-- Chọn lỗi --</option>`;
  document.getElementById('diemGoc').value = '';
  document.getElementById('diemTru').value = '';
  currentBaseScore = 0;
  if(!nhom) return;
  await safeTask(async()=>{
    const list = await gs('getLoiTheoNhom', nhom);
    document.getElementById('maLoi').innerHTML = `<option value="">-- Chọn lỗi --</option>` + list.map(x=>`<option value="${escapeHtml(x.maLoi)}" data-diem="${x.diemTru ?? x.diem ?? 0}">${escapeHtml(x.tenLoi)}</option>`).join('');
  });
}
async function changeLoi(){
  const ma = document.getElementById('maLoi').value;
  if(!ma){ currentBaseScore=0; document.getElementById('diemGoc').value=''; document.getElementById('diemTru').value=''; return; }
  await safeTask(async()=>{
    const data = await gs('getThongTinLoi', ma);
    currentBaseScore = Number(data.diemTru ?? data.diem ?? 0);
    document.getElementById('diemGoc').value = fmtNum(currentBaseScore);
    autoFillActualScore = true;
    recalcActualScore();
  });
}
function recalcActualScore(){
  const soLan = Math.max(1, Number(document.getElementById('soLan').value || 1));
  const autoValue = currentBaseScore * soLan;
  if(autoFillActualScore || !document.getElementById('diemTru').value){
    document.getElementById('diemTru').value = autoValue ? String(autoValue) : '';
  }
}
async function saveFormViPham(){
  const hs = document.getElementById('hocSinh');
  const payload = {
    ngay: document.getElementById('ngayVP').value,
    idHs: hs.value,
    hoTen: hs.selectedIndex >= 0 ? hs.options[hs.selectedIndex].text : '',
    khoi: document.getElementById('khoi').value,
    lop: document.getElementById('lop').value,
    maLoi: document.getElementById('maLoi').value,
    soLan: document.getElementById('soLan').value,
    diemTruGv: document.getElementById('diemTru').value,
    ghiChu: document.getElementById('ghiChu').value
  };
  await safeTask(async()=>{
    const res = await gs('saveViPham', payload);
    showToast(res.message || 'Đã lưu vi phạm');
    resetFormViPham();
  });
}

async function renderStudentPage(){
  document.getElementById('app').innerHTML = `
    <div class="card">
      <div class="section-head"><div class="card-title" style="margin:0">👨‍🎓 Tổng hợp học sinh</div><div style="min-width:320px"><label>Tuần</label><select id="studentWeek" onchange="loadStudentData()"></select></div></div>
      <div class="table-wrap"><table><thead><tr><th>Khối</th><th>Lớp</th><th>Học sinh</th><th>Chuyên cần</th><th>Trang phục</th><th>Giao thông</th><th>CSVC</th><th>SHTT</th><th>VP khác</th><th>Tổng lỗi</th><th>Tổng điểm trừ</th><th>Thao tác</th></tr></thead><tbody id="studentTable"></tbody></table></div>
    </div>`;
  await safeTask(async()=>{
    const weeks = await gs('getDanhSachTuan');
    document.getElementById('studentWeek').innerHTML = weeks.map(x=>`<option value="${x.value}" ${x.current?'selected':''}>${escapeHtml(x.label)}</option>`).join('');
    await loadStudentData();
  });
}
async function loadStudentData(){
  const weekEl = document.getElementById('studentWeek');
  if (!weekEl) return;
  const tuan = weekEl.value;
  await safeTask(async()=>{
    const data = await gs('getTongHopHocSinh', tuan);
    const tableEl = document.getElementById('studentTable');
    if (tableEl) {
      tableEl.innerHTML = data.length ? data.map(x=>`<tr><td class="center">${escapeHtml(x.KHOI)}</td><td class="center bold">${escapeHtml(x.LOP)}</td><td>${escapeHtml(x.HO_TEN)}</td><td class="center">${fmtNum(x.CHUYEN_CAN)}</td><td class="center">${fmtNum(x.TRANG_PHUC)}</td><td class="center">${fmtNum(x.GIAO_THONG)}</td><td class="center">${fmtNum(x.CSVC)}</td><td class="center">${fmtNum(x.SINH_HOAT_TAP_THE)}</td><td class="center">${fmtNum(x.VI_PHAM_KHAC)}</td><td class="center">${fmtNum(x.TONG_LOI)}</td><td class="right">${fmtNum(x.TONG_DIEM_TRU)}</td><td class="center"><button class="btn-secondary" onclick="openStudentViolation('${x.ID_HS}','${escapeHtml(x.HO_TEN)}')">Xem lỗi</button></td></tr>`).join('') : emptyRows(12);
    }
  });
}

async function renderRankPage(){
  document.getElementById('app').innerHTML = `
    <div class="card">
      <div class="section-head" style="flex-wrap:wrap; gap:12px;">
        <div class="card-title" style="margin:0; width:100%;">🏫 Xếp hạng lớp</div>
        <div style="display:flex; gap:12px; flex-wrap:wrap; width:100%;">
          <div style="flex:1; min-width:150px;"><label>Tuần</label><select id="rankWeek" onchange="loadRankData()"></select></div>
          <div style="flex:1; min-width:150px;"><label>Ca học</label><select id="rankCa" onchange="loadRankData()"><option value="">Tất cả các ca</option><option value="SANG">Ca Sáng</option><option value="CHIEU">Ca Chiều</option></select></div>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Hạng</th><th>Khối</th><th>Lớp</th><th>Số HS vi phạm</th><th>Tổng lỗi</th><th>Tổng điểm trừ</th><th>Điểm nề nếp</th><th>SHTT</th><th>ĐHT</th><th>Kết quả thi đua</th></tr></thead><tbody id="rankTable"></tbody></table></div>
    </div>`;
  await safeTask(async()=>{
    const weeks = await gs('getDanhSachTuan');
    document.getElementById('rankWeek').innerHTML = weeks.map(x=>`<option value="${x.value}" ${x.current?'selected':''}>${escapeHtml(x.label)}</option>`).join('');
    await loadRankData();
  });
}
async function loadRankData(){
  const tuan = document.getElementById('rankWeek').value;
  const ca = document.getElementById('rankCa').value;
  
  await safeTask(async()=>{
    let data = await gs('getXepHangLopAPI', tuan);
    
    if (ca) {
      const lopsCa = await gs('getLopTheoCa', ca);
      data = data.filter(x => lopsCa.includes(x.LOP));
    }
    
    // Sort logically like the score page
    data = data.sort((a,b) => {
      if (b.DIEM_THI_DUA !== a.DIEM_THI_DUA) return b.DIEM_THI_DUA - a.DIEM_THI_DUA;
      return a.TONG_LOI - b.TONG_LOI;
    }).map((x,i) => ({...x, XEP_HANG: i+1}));

    const rankTbl = document.getElementById('rankTable');
    if (rankTbl) rankTbl.innerHTML = data.length ? data.map(x=>`<tr><td class="center bold">${fmtNum(x.XEP_HANG)}</td><td class="center">${escapeHtml(x.KHOI)}</td><td class="center bold">${escapeHtml(x.LOP)}</td><td class="center">${fmtNum(x.SO_HOC_SINH_VI_PHAM)}</td><td class="center">${fmtNum(x.TONG_LOI)}</td><td class="right">${fmtNum(x.TONG_DIEM_TRU)}</td><td class="right">${fmtNum(x.NN)}</td><td class="right">${fmtNum(x.SHTT)}</td><td class="right">${fmtNum(x.DHT)}</td><td class="right bold">${fmtNum(x.DIEM_THI_DUA)}</td></tr>`).join('') : emptyRows(10);
  });
}

async function renderWeekPage(){
  document.getElementById('app').innerHTML = `
    <div class="card">
      <div class="section-head"><div class="card-title" style="margin:0">📊 Báo cáo tuần</div><div style="min-width:320px"><label>Tuần</label><select id="reportWeek" onchange="loadWeekReportData()"></select></div></div>
      <div class="table-wrap"><table><thead><tr><th>Ngày</th><th>Khối</th><th>Lớp</th><th>Học sinh</th><th>Nhóm lỗi</th><th>Lỗi</th><th>Số lần</th><th>Điểm trừ</th><th>Ghi chú</th></tr></thead><tbody id="reportTable"></tbody></table></div>
    </div>`;
  await safeTask(async()=>{
    const weeks = await gs('getDanhSachTuan');
    document.getElementById('reportWeek').innerHTML = weeks.map(x=>`<option value="${x.value}" ${x.current?'selected':''}>${escapeHtml(x.label)}</option>`).join('');
    await loadWeekReportData();
  });
}
async function loadWeekReportData(){
  const tuan = document.getElementById('reportWeek').value;
  await safeTask(async()=>{
    let data = await gs('getDanhSachViPhamTheoTuan', tuan);
    
    // Sort logic: Date -> Khoi -> Lop
    data.sort((a, b) => {
      // 1. Sort by Date (ascending)
      const parseDate = (dStr) => {
        if (!dStr) return 0;
        const parts = String(dStr).split('/');
        if (parts.length === 3) {
          return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
        }
        return new Date(dStr).getTime() || 0;
      };
      
      const timeA = parseDate(a.NGAY_VP);
      const timeB = parseDate(b.NGAY_VP);
      if (timeA !== timeB) return timeA - timeB;
      
      // 2. Sort by Khoi (numeric)
      const khoiA = parseInt(a.KHOI) || 0;
      const khoiB = parseInt(b.KHOI) || 0;
      if (khoiA !== khoiB) return khoiA - khoiB;
      
      // 3. Sort by Lop (alphanumeric, so 10A2 comes before 10A10)
      const lopA = String(a.LOP || '');
      const lopB = String(b.LOP || '');
      return lopA.localeCompare(lopB, undefined, { numeric: true, sensitivity: 'base' });
    });

    document.getElementById('reportTable').innerHTML = data.length ? data.map(x=>`<tr><td class="center">${escapeHtml(x.NGAY_VP)}</td><td class="center">${escapeHtml(x.KHOI)}</td><td class="center bold">${escapeHtml(x.LOP)}</td><td>${escapeHtml(x.HO_TEN)}</td><td class="center">${escapeHtml(x.NHOM_LOI)}</td><td>${escapeHtml(x.TEN_LOI || x.tenLoi || '')}</td><td class="center">${fmtNum(x.SO_LAN || 1)}</td><td class="right">${fmtNum(x.DIEM_TRU || x.diemTru || 0)}</td><td>${escapeHtml(x.GHI_CHU || '')}</td></tr>`).join('') : emptyRows(9);
  });
}

async function renderExportPage(){
  document.getElementById('app').innerHTML = `
    <div class="card">
      <div class="card-title">📥 Xuất Excel</div>
      <div class="grid-2"><div><label>Chọn tuần</label><select id="exportWeek"></select></div></div>
      <div class="note">File xuất sẽ gồm 3 sheet: Danh sách vi phạm, Tổng lỗi tuần, Xếp hạng lớp.</div>
      <div class="btn-row" style="margin-top:14px"><button class="btn-primary" onclick="exportExcelTuan()">📄 Tạo file Excel</button></div>
      <div id="exportResult" style="margin-top:16px"></div>
    </div>`;
  await safeTask(async()=>{
    const weeks = await gs('getDanhSachTuan');
    document.getElementById('exportWeek').innerHTML = weeks.map(x=>`<option value="${x.value}" ${x.current?'selected':''}>${escapeHtml(x.label)}</option>`).join('');
  });
}
async function exportExcelTuan(){
  const tuan = document.getElementById('exportWeek').value;
  await safeTask(async()=>{
    const url = await gs('exportBaoCaoTuan', tuan);
    document.getElementById('exportResult').innerHTML = `<div class="muted-box"><div><b>✅ Xuất báo cáo thành công</b></div><div style="margin-top:8px"><a href="${url}" target="_blank"><button class="btn-primary">⬇️ Mở file Excel</button></a></div></div>`;
    showToast('Đã tạo file Excel thành công');
  });
}

async function renderAdminPage(){
    document.getElementById('app').innerHTML = `
      <div class="card">
        <div class="card-title">⚙️ Quản trị danh mục</div>
        <div class="admin-grid">
            <div class="card" style="margin:0">
              <div class="sub-title">🔑 Quản lý Tài khoản</div>
              <label>Tài khoản</label><input id="adminUser">
              <label style="margin-top:10px">Mật khẩu</label><input id="adminPass">
              <label style="margin-top:10px">Quyền</label>
              <select id="adminRole">
                <option value="SCORER">Giám thị / Cờ đỏ (Chỉ nhập vi phạm)</option>
                <option value="ADMIN">Admin (Toàn quyền)</option>
              </select>
              <div class="btn-row" style="margin-top:14px">
                <button class="btn-primary" onclick="saveAdminAccount()">Tạo / Cập nhật</button>
              </div>
              <div style="margin-top:20px;max-height:200px;overflow-y:auto;">
                <table style="font-size:13px;">
                  <thead><tr><th>Tài khoản</th><th>Quyền</th><th></th></tr></thead>
                  <tbody id="adminAccountsTable"></tbody>
                </table>
              </div>
            </div>
  
          <div class="card" style="margin:0">
            <div class="sub-title">🏢  Thêm lớp mới</div>
            <label>Khối</label><input id="adminKhoiLop" placeholder="Ví dụ: 10">
            <label style="margin-top:10px">Tên lớp</label><input id="adminTenLop" placeholder="Ví dụ: 10A12">
            <div class="btn-row" style="margin-top:14px"><button class="btn-primary" onclick="saveAdminClass()">Lưu lớp</button></div>
          </div>
          <div class="card" style="margin:0">
            <div class="sub-title">👨‍🎓  Thêm học sinh mới</div>
            <label>Mã học sinh</label><input id="adminMaHS" placeholder="Có thể để trống">
            <label style="margin-top:10px">Khối</label><input id="adminKhoiHS" placeholder="Ví dụ: 10">
            <label style="margin-top:10px">Lớp</label><input id="adminLopHS" placeholder="Ví dụ: 10A12">
            <label style="margin-top:10px">Họ tên</label><input id="adminHoTenHS">
            <label style="margin-top:10px">Ngày sinh</label><input id="adminNgaySinhHS" placeholder="dd/MM/yyyy hoặc để trống">
            <label style="margin-top:10px">Giới tính</label><select id="adminGioiTinhHS"><option value="">-- Chọn --</option><option>Nam</option><option>Nữ</option></select>
            <div class="btn-row" style="margin-top:14px"><button class="btn-primary" onclick="saveAdminStudent()">Lưu học sinh</button></div>
          </div>
          <div class="card" style="margin:0">
            <div class="sub-title">⚠️  Thêm lỗi vi phạm mới</div>
            <label>Mã lỗi</label><input id="adminMaLoi">
            <label style="margin-top:10px">Nhóm lỗi</label><input id="adminNhomLoi" placeholder="Ví dụ: GIAO_THONG">
            <label style="margin-top:10px">Tên lỗi</label><input id="adminTenLoi">
            <label style="margin-top:10px">Điểm trừ chuẩn</label><input id="adminDiemTru" type="number" step="0.01">
            <label style="margin-top:10px">Đơn vị</label><input id="adminDonVi" value="Lần">
            <label style="margin-top:10px">Mô tả</label><textarea id="adminMoTa"></textarea>
            <div class="btn-row" style="margin-top:14px"><button class="btn-primary" onclick="saveAdminError()">Lưu lỗi</button></div>
          </div>
        </div>
        <div class="note">Sau khi thêm mới, dữ liệu sẽ tự xuất hiện ở các menu chọn tương ứng.</div>
      </div>`;
    await loadAdminAccounts();
  }
  async function loadAdminAccounts() {
    await safeTask(async()=>{ 
        const accs = await gs('getDanhSachTaiKhoan');
        document.getElementById('adminAccountsTable').innerHTML = accs.map(x=>`<tr><td>${escapeHtml(x.USERNAME)}</td><td>${escapeHtml(x.ROLE)}</td><td><button class="btn-danger" style="padding:2px 6px;font-size:12px;" onclick="deleteAdminAccount('${escapeHtml(x.USERNAME)}')">Xóa</button></td></tr>`).join('');
    });
  }
  async function saveAdminAccount(){
    const user = document.getElementById('adminUser').value;
    const pass = document.getElementById('adminPass').value;
    const role = document.getElementById('adminRole').value;
    if(!user || !pass) return showToast('Vui lòng nhập tài khoản và mật khẩu', 'error');
    await safeTask(async()=>{ 
        const res = await gs('taoTaiKhoan', user, pass, role); 
        showToast(res.message || 'Đã tạo tài khoản'); 
        document.getElementById('adminUser').value=''; 
        document.getElementById('adminPass').value=''; 
        await loadAdminAccounts();
    });
  }
  async function deleteAdminAccount(username){
    if(!confirm(`Bạn có chắc muốn xóa tài khoản ${username}?`)) return;
    await safeTask(async()=>{ 
        const res = await gs('xoaTaiKhoan', username); 
        showToast(res.message || 'Đã xóa tài khoản'); 
        await loadAdminAccounts();
    });
  }
  async function saveAdminClass(){
    const payload = { KHOI: document.getElementById('adminKhoiLop').value, TEN_LOP: document.getElementById('adminTenLop').value };
    await safeTask(async()=>{ const res = await gs('themLop', payload); showToast(res.message || 'Đã thêm lớp'); document.getElementById('adminKhoiLop').value=''; document.getElementById('adminTenLop').value=''; });
  }
  async function saveAdminStudent(){
    const payload = { MA_HS: document.getElementById('adminMaHS').value, KHOI: document.getElementById('adminKhoiHS').value, LOP: document.getElementById('adminLopHS').value, HO_TEN: document.getElementById('adminHoTenHS').value, NGAY_SINH: document.getElementById('adminNgaySinhHS').value, GIOI_TINH: document.getElementById('adminGioiTinhHS').value };
    await safeTask(async()=>{ const res = await gs('themHocSinh', payload); showToast(res.message || 'Đã thêm học sinh'); ['adminMaHS','adminKhoiHS','adminLopHS','adminHoTenHS','adminNgaySinhHS'].forEach(id=>document.getElementById(id).value=''); document.getElementById('adminGioiTinhHS').value=''; });
  }
  async function saveAdminError(){
    const payload = { MA_LOI: document.getElementById('adminMaLoi').value, NHOM_LOI: document.getElementById('adminNhomLoi').value, TEN_LOI: document.getElementById('adminTenLoi').value, DIEM_TRU: document.getElementById('adminDiemTru').value, DON_VI: document.getElementById('adminDonVi').value, MO_TA: document.getElementById('adminMoTa').value };
    await safeTask(async()=>{ const res = await gs('themLoiViPham', payload); showToast(res.message || 'Đã thêm lỗi'); ['adminMaLoi','adminNhomLoi','adminTenLoi','adminDiemTru','adminMoTa'].forEach(id=>document.getElementById(id).value=''); document.getElementById('adminDonVi').value='Lần'; });
  }

async function renderClassSchedulePage() {
  document.getElementById('app').innerHTML = `
  <div class="card">
    <div class="card-title">📋 Sắp xếp lớp theo ca</div>
    <p>Gán các lớp vào ca Sáng hoặc Chiều để dễ dàng quản lý nhập điểm.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Lớp</th>
            <th>Ca hiện tại</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody id="classScheduleTable"></tbody>
      </table>
    </div>
  </div>`;
  loadClassSchedule();
}

async function loadClassSchedule() {
  await safeTask(async () => {
    const list = await gs('getDanhSachSapXep');
    document.getElementById('classScheduleTable').innerHTML = list.map(x => `
      <tr>
        <td class="bold center">${escapeHtml(x.LOP)}</td>
        <td class="center">
          <span style="display:inline-block;padding:4px 8px;border-radius:4px;font-weight:bold;font-size:12px;background:${x.CA==='SANG'?'#dbeafe':(x.CA==='CHIEU'?'#fee2e2':'#f1f5f9')};color:${x.CA==='SANG'?'#1e40af':(x.CA==='CHIEU'?'#991b1b':'#475569')}">
            ${x.CA === 'SANG' ? 'Sáng' : (x.CA === 'CHIEU' ? 'Chiều' : 'Chưa xếp')}
          </span>
        </td>
        <td class="center">
          <button class="btn-primary" style="padding:4px 10px;font-size:12px;margin-right:4px;" onclick="saveClassSchedule('${escapeHtml(x.LOP)}', 'SANG')">Gán Sáng</button>
          <button class="btn-danger" style="padding:4px 10px;font-size:12px;background:#f97316;margin-right:4px;" onclick="saveClassSchedule('${escapeHtml(x.LOP)}', 'CHIEU')">Gán Chiều</button>
          ${x.CA ? `<button style="padding:4px 10px;font-size:12px;background:#94a3b8;color:white;border:none;border-radius:4px;cursor:pointer;" onclick="saveClassSchedule('${escapeHtml(x.LOP)}', '')">Hủy ca</button>` : ''}
        </td>
      </tr>
    `).join('');
  });
}

async function saveClassSchedule(lop, ca) {
  await safeTask(async () => {
    const res = await gs('saveSapXepLop', lop, ca);
    showToast(res.message);
    await loadClassSchedule();
  });
}

async function renderScorePage(){
  document.getElementById('app').innerHTML=`
  <div class="card">
    <div class="card-title">📚 Quản lý điểm - Nhập điểm tiêu chí tuần</div>
    <div class="grid-2">
      <select id="sTuan" onchange="previewNNSHTT(); loadRankingTable(this.value); loadDiemTieuChiTable()"><option value="">-- Chọn tuần --</option></select>
      <select id="sCa" onchange="loadLopTheoCaUI()"><option value="">-- Chọn ca --</option><option value="SANG">Ca Sáng</option><option value="CHIEU">Ca Chiều</option></select>
      <select id="sLop" onchange="loadDiemTieuChiTable(); previewNNSHTT()"><option value="">-- Chọn lớp --</option></select>
    </div>
    
    <div id="diemNgayWrap" style="margin-top:16px; display:none; padding:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;">
      <div class="sub-title" style="margin-bottom:12px;">📝 Nhập điểm tiêu chí tuần (Học tốt, Chuyên cần...)</div>
      <div class="grid-2">
        <div><label>Học tốt</label><input type="number" id="sHocTot" placeholder="Nhập điểm số"></div>
        <div><label>Chuyên cần</label><input type="number" id="sChuyenCan" placeholder="Nhập điểm số"></div>
        <div><label>Điểm tốt</label><input type="number" id="sDiemTot" placeholder="Nhập điểm số"></div>
        <div><label>Điểm xấu</label><input type="number" id="sDiemXau" placeholder="Nhập điểm số"></div>
      </div>
      <button class="btn-primary" style="margin-top:14px" onclick="saveDiemTieuChiFE()">Lưu điểm tiêu chí tuần</button>
      
      <div style="margin-top:20px;">
        <h4 style="margin-bottom:8px;">📊 Dữ liệu điểm tiêu chí các tuần</h4>
        <div id="tableDiemNgay"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">🏆 Tổng kết & Xếp hạng</div>
    <div class="grid-2">
      <input id="previewNN" placeholder="Điểm Nề nếp (hệ thống tính)" readonly style="background:#f8fafc;color:#047857;font-weight:bold;border:1px dashed #cbd5e1;">
      <input id="previewSHTT" placeholder="Điểm SHTT (hệ thống tính)" readonly style="background:#f8fafc;color:#047857;font-weight:bold;border:1px dashed #cbd5e1;">
      <input id="sDHT" placeholder="Nhập Điểm Học Tập (Tổng kết)">
      <input id="sTDT" placeholder="Nhập Điểm Thi Đua (Tổng kết)">
    </div>
    <button class="btn-primary" style="margin-top:14px" onclick="saveScoreV123()">Lưu tổng kết & Xếp hạng</button>
    <button class="btn-danger" style="margin-top:14px;margin-left:8px" onclick="deleteScoreV123()">Xóa tổng kết</button>
  </div>
  
  <div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <span>Kết quả xếp hạng tuần</span>
      <div style="display:flex;gap:8px">
        <select id="sKhoiFilter" style="width:150px;min-height:36px;padding:6px;border-radius:8px" onchange="renderRankTable()">
          <option value="">Tất cả khối</option>
          <option value="10">Khối 10</option>
          <option value="11">Khối 11</option>
          <option value="12">Khối 12</option>
        </select>
        <button class="btn-primary" style="padding:6px 16px;min-height:36px" onclick="exportRankExcel()">Xuất Excel</button>
      </div>
    </div>
    <div id="scoreRank"></div>
  </div>`;
  loadScoreDropdownV1258();
}

async function loadRankingTable(tuan) {
  if (!tuan) {
    document.getElementById('scoreRank').innerHTML = '';
    return;
  }
  showLoading(true);
  try {
    window.currentRankData = await gs('getRankThiDuaV123', Number(tuan));
    renderRankTable();
  } catch(e) {
    console.error(e);
  } finally {
    showLoading(false);
  }
}

function renderRankTable() {
  if (!window.currentRankData) return;
  const khoi = document.getElementById('sKhoiFilter').value;
  let d = window.currentRankData;
  if (khoi) {
    d = d.filter(x => String(x.KHOI) === String(khoi));
  }
  d = d.sort((a,b) => {
    if (b.DIEM_THI_DUA !== a.DIEM_THI_DUA) return b.DIEM_THI_DUA - a.DIEM_THI_DUA;
    return a.TONG_LOI - b.TONG_LOI;
  }).map((x,i) => ({...x, HANG: i+1}));

  document.getElementById('scoreRank').innerHTML='<div class="table-wrap"><table><thead><tr><th>Hạng</th><th>Lớp</th><th>ĐHT</th><th>NN</th><th>SHTT</th><th>TĐT</th></tr></thead><tbody>'+
  d.map(x=>`<tr><td class="center">${x.HANG}</td><td class="center bold">${x.LOP}</td><td class="right">${x.DHT}</td><td class="right">${x.NN}</td><td class="right">${x.SHTT}</td><td class="right bold">${x.DIEM_THI_DUA}</td></tr>`).join('')+'</tbody></table></div>';
}

function exportRankExcel() {
  if (!window.currentRankData || window.currentRankData.length === 0) {
    showToast('Không có dữ liệu để xuất', 'error');
    return;
  }
  const khoi = document.getElementById('sKhoiFilter').value;
  let d = window.currentRankData;
  if (khoi) d = d.filter(x => String(x.KHOI) === String(khoi));
  
  d = d.sort((a,b) => {
    if (b.DIEM_THI_DUA !== a.DIEM_THI_DUA) return b.DIEM_THI_DUA - a.DIEM_THI_DUA;
    return a.TONG_LOI - b.TONG_LOI;
  }).map((x,i) => ({...x, HANG: i+1}));

  let csv = 'Hạng,Lớp,ĐHT,NN,SHTT,TĐT\n';
  d.forEach(x => { csv += `${x.HANG},${x.LOP},${x.DHT},${x.NN},${x.SHTT},${x.DIEM_THI_DUA}\n`; });
  
  const blob = new Blob(["\uFEFF"+csv], {type: 'text/csv;charset=utf-8;'});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `Xep_Hang_Thi_Dua_${khoi ? 'Khoi_'+khoi : 'Toan_Truong'}.csv`;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
}

// ================= DIEM NGAY LOGIC =================

async function loadLopTheoCaUI() {
  const ca = document.getElementById('sCa').value;
  const wrap = document.getElementById('diemNgayWrap');
  if (!ca) {
    document.getElementById('sLop').innerHTML = '<option value="">-- Chọn lớp --</option>';
    wrap.style.display = 'none';
    return;
  }
  await safeTask(async () => {
    const lops = await gs('getLopTheoCa', ca);
    document.getElementById('sLop').innerHTML = '<option value="">-- Chọn lớp --</option>' + 
      lops.map(x => `<option>${x}</option>`).join('');
    wrap.style.display = 'block';
  });
}

async function saveDiemTieuChiFE() {
  const lop = document.getElementById('sLop').value;
  const tuan = document.getElementById('sTuan').value;
  if (!tuan) return showToast('Vui lòng chọn tuần', 'error');
  if (!lop) return showToast('Vui lòng chọn lớp', 'error');

  const data = {
    LOP: lop,
    TUAN: tuan,
    HOC_TOT: document.getElementById('sHocTot').value || 0,
    CHUYEN_CAN: document.getElementById('sChuyenCan').value || 0,
    DIEM_TOT: document.getElementById('sDiemTot').value || 0,
    DIEM_XAU: document.getElementById('sDiemXau').value || 0,
    NGUOI_NHAP: window.currentUser ? window.currentUser.USERNAME : ''
  };

  await safeTask(async () => {
    const res = await gs('saveDiemTieuChiTuan', data);
    showToast(res.message);
    document.getElementById('sHocTot').value = '';
    document.getElementById('sChuyenCan').value = '';
    document.getElementById('sDiemTot').value = '';
    document.getElementById('sDiemXau').value = '';
    await loadDiemTieuChiTable();
  });
}

async function loadDiemTieuChiTable() {
  const lop = document.getElementById('sLop').value;
  if (!lop) {
    document.getElementById('tableDiemNgay').innerHTML = '<div style="color:#64748b">Vui lòng chọn lớp.</div>';
    return;
  }
  
  await safeTask(async () => {
    const diemList = await gs('getDiemTieuChiTuan', lop);
    
    if (!diemList || diemList.length === 0) {
      document.getElementById('tableDiemNgay').innerHTML = '<div style="color:#64748b">Chưa có dữ liệu điểm tiêu chí.</div>';
      return;
    }
    
    // Sort by TUAN descending (assuming numeric extraction or simple string sort works for week)
    diemList.sort((a,b) => {
        const tA = parseInt(String(a.TUAN).replace(/\D/g,'')) || 0;
        const tB = parseInt(String(b.TUAN).replace(/\D/g,'')) || 0;
        return tB - tA;
    });

    document.getElementById('tableDiemNgay').innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tuần</th>
              <th>Học tốt</th>
              <th>Chuyên cần</th>
              <th>Điểm tốt</th>
              <th>Điểm xấu</th>
            </tr>
          </thead>
          <tbody>
            ${diemList.map(x => `
              <tr>
                <td class="center bold">${x.TUAN}</td>
                <td class="right">${x.HOC_TOT}</td>
                <td class="right">${x.CHUYEN_CAN}</td>
                <td class="right">${x.DIEM_TOT}</td>
                <td class="right">${x.DIEM_XAU}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  });
}

async function loadScoreDropdownV1258(){
  await safeTask(async()=>{
   const weeks=await gs('getDanhSachTuan')||[];
   document.getElementById('sTuan').innerHTML='<option value="">-- Chọn tuần --</option>'+
   weeks.map(x=>`<option value="${x.value||x.TUAN}">${x.label||x.value||x.TUAN}</option>`).join('');
   const lops=await gs('getLop')||[];
   document.getElementById('sLop').innerHTML='<option value="">-- Chọn lớp --</option>'+
   lops.map(x=>`<option>${x}</option>`).join('');
  });
}

async function saveScoreV123() {
    const tuan = document.getElementById('sTuan').value;
    const lop = document.getElementById('sLop').value;
    const dht = document.getElementById('sDHT').value;
    const tdt = document.getElementById('sTDT').value;
    
    if (!tuan) return showToast('Vui lòng chọn tuần', 'error');
    if (!lop) return showToast('Vui lòng chọn lớp', 'error');
    if (dht === '') return showToast('Vui lòng nhập điểm học tập', 'error');
    if (tdt === '') return showToast('Vui lòng nhập điểm thi đua', 'error');
    
    await safeTask(async () => {
        await gs('saveDiemHocTapV123', {
            TUAN: tuan,
            LOP: lop,
            DHT: Number(dht),
            TDT: Number(tdt)
        });
        showToast(`Đã lưu điểm cho lớp ${lop} (Tuần ${tuan})`);
        loadRankingTable(tuan);
    });
}

async function deleteScoreV123() {
    const tuan = document.getElementById('sTuan').value;
    const lop = document.getElementById('sLop').value;
    
    if (!tuan || !lop) return showToast('Vui lòng chọn tuần và lớp', 'error');
    if (!confirm(`Bạn có chắc muốn xoá điểm lớp ${lop} trong tuần ${tuan}?`)) return;
    
    await safeTask(async () => {
        await gs('deleteDiemHocTapV123', tuan, lop);
        showToast('Đã xoá điểm thành công');
        document.getElementById('sDHT').value = '';
        document.getElementById('sTDT').value = '';
        loadRankingTable(tuan);
    });
}

async function previewNNSHTT() {
    const tuan = document.getElementById('sTuan').value;
    const lop = document.getElementById('sLop').value;
    if (!tuan || !lop) {
      document.getElementById('previewNN').value = "";
      document.getElementById('previewSHTT').value = "";
      return;
    }
    document.getElementById('previewNN').value = "Đang tính toán...";
    document.getElementById('previewSHTT').value = "Đang tính toán...";
    try {
      showLoading(true);
      const res = await gs('getPreviewDiemNNSHTT', tuan, lop);
      document.getElementById('previewNN').value = "Điểm Nền nếp: " + res.NN;
      document.getElementById('previewSHTT').value = "Điểm SHTT: " + res.SHTT;
    } catch(err) {
      document.getElementById('previewNN').value = "Lỗi!";
      document.getElementById('previewSHTT').value = "Lỗi!";
      alert("Lỗi khi tính toán: " + err.message);
    } finally {
      showLoading(false);
    }
  }

async function doLogin() {
    const user = document.getElementById('loginUsername').value;
    const pass = document.getElementById('loginPassword').value;
    if (!user) return showToast('Vui lòng nhập tài khoản', 'error');
    if (!pass) return showToast('Vui lòng nhập mật khẩu', 'error');
    
    await safeTask(async () => {
      const res = await gs('login', user, pass);
      if (res && res.success) {
        finishLogin(res.role, res.username);
      } else {
        showToast(res ? res.message : 'Sai tài khoản hoặc mật khẩu', 'error');
      }
    });
}

async function doGuestLogin() {
  await safeTask(async () => {
    const res = await gs('login', 'khach', '');
    finishLogin('VIEWER', 'Khách');
  });
}
  
  function finishLogin(role, username) {
    window.currentUserRole = role;
    document.getElementById('loginModal').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    showToast(`Đăng nhập thành công (${role})`);
    resetSessionTimer();
    
    // Setup Sidebar based on role
    document.querySelectorAll('.menu-item').forEach(el => el.style.display = 'block');
    
    if (role === 'VIEWER') {
      const form = document.querySelector('.menu-item[data-page="form"]'); if(form) form.style.display = 'none';
      const classSched = document.querySelector('.menu-item[data-page="classSchedule"]'); if(classSched) classSched.style.display = 'none';
      const score = document.querySelector('.menu-item[data-page="score"]'); if(score) score.style.display = 'none';
      const exp = document.querySelector('.menu-item[data-page="export"]'); if(exp) exp.style.display = 'none';
      const adm = document.querySelector('.menu-item[data-page="admin"]'); if(adm) adm.style.display = 'none';
    } else if (role === 'SCORER') {
      const classSched = document.querySelector('.menu-item[data-page="classSchedule"]'); if(classSched) classSched.style.display = 'none';
      const score = document.querySelector('.menu-item[data-page="score"]'); if(score) score.style.display = 'none';
      const exp = document.querySelector('.menu-item[data-page="export"]'); if(exp) exp.style.display = 'none';
      const adm = document.querySelector('.menu-item[data-page="admin"]'); if(adm) adm.style.display = 'none';
    }
    
    openPage('dashboard', document.querySelector('.menu-item[data-page="dashboard"]'));
  }

async function openStudentViolation(idHs,name){
    document.getElementById('violationModal').style.display='block';
    document.getElementById('violationTitle').innerText='Danh sách lỗi: '+name;
    const tuan=(document.querySelector('select[id="weekSelect"]')||{}).value||'';
    const data=await gs('getChiTietLoiHocSinh',idHs,tuan);
    document.getElementById('violationList').innerHTML=data.length?data.map(x=>`
    <div class="muted-box">
    <input type="checkbox" class="vpCheck" value="${x.ID_VP}">
    ${x.NGAY_VP} | ${x.TEN_LOI} | -${x.DIEM_TRU} điểm
    </div>`).join(''):'Không có lỗi';
    loadAuditLog();
}

function closeViolationModal(){
   document.getElementById('violationModal').style.display='none';
}

async function deleteSelectedViolation(){
   const ids=[...document.querySelectorAll('.vpCheck:checked')].map(x=>x.value);
   if(!ids.length){showToast('Chưa chọn lỗi cần xóa','error');return;}
   if(!confirm('Xác nhận xóa '+ids.length+' lỗi?')) return;
   const res=await gs('deleteMultiViPham',ids);
   showToast(res.message);
   closeViolationModal();
   loadStudentData();
}

async function loadAuditLog(){
   const data=await gs('getAuditLog');
   document.getElementById('auditList').innerHTML=data.slice(0,20).map(x=>
   `<div>${x.THOI_GIAN} | ${x.ACTION} | ${x.ID_VP}</div>`
   ).join('');
}
