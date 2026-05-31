// ══════════════════════════════════════════════
//  GLOBALS & CONSTANTS
// ══════════════════════════════════════════════
const TODAY = new Date().toISOString().split('T')[0];
const CURRENT_MONTH = TODAY.substring(0, 7);
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const CAT_COLORS = ['#18B2B0', '#e05555', '#e8a84a', '#3dba7e', '#9b8bef', '#5b9bd6', '#e8758b'];
const CAT_BADGE = { رواتب: 'pill-blue', تسويق: 'pill-accent', 'شراء منتجات': 'pill-amber', سلف: 'pill-purple', أرباح: 'pill-green', أخرى: 'pill-gray' };

const fmt = n => (parseFloat(n) || 0).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = d => d ? new Date(d.split('T')[0] + 'T00:00:00').toLocaleDateString('ar-SA') : '-';
const arMonth = k => { const [y, m] = k.split('-'); return AR_MONTHS[parseInt(m) - 1] + ' ' + y; };

// ── APP STATE ──
let state = {
    connected: false,
    simulated: true,
    hasCredentials: false,
    store: { name: 'شوب ستور', domain: 'sho9.com', avatar: 'S' },
    expenses: [],
    sales: [],
    wallet: [],
    archives: [],
    adjustments: [], // تسويات الجرد اليدوية
    viewingArc: null, // null = live
    editingId: null,
    editingType: null,
    user: null, // الحساب النشط حالياً
    users: [] // حسابات كافة موظفي اللوحة
};

let currentUsername = '';
let currentUserRole = '';

// ── SALLA LIVE DATA ──
let sallaOrders = [];
let sallaCartData = { count: 0, total: 0 };
let ordPage = 1;
let ordPageTotal = 1;

// ── CHARTS ──
let pieC, cmpC, walC, prodC;

// ══════════════════════════════════════════════
//  INIT & CHECK AUTH STATUS
// ══════════════════════════════════════════════
async function init() {
    try {
        // 1. التحقق من جلسة المستخدم وتسجيل الدخول
        const meRes = await fetch('/api/auth/me');
        if (!meRes.ok) {
            window.location.href = 'login.html';
            return;
        }
        state.user = await meRes.json();
        
        // تحديث واجهة المستخدم بالملف التعريفي للحساب النشط
        const uAvatar = document.getElementById('userAvatar');
        const uName = document.getElementById('userName');
        const uRole = document.getElementById('userRole');
        if (uAvatar && uName && uRole) {
            uAvatar.textContent = state.user.username.substring(0, 1).toUpperCase();
            currentUsername = state.user.username;
            currentUserRole = state.user.role;
            const roleLabel = currentUserRole === 'admin' ? 'مدير' : currentUserRole === 'accountant' ? 'محاسب' : 'موظف';
            
            uName.textContent = currentUsername;
            uRole.textContent = roleLabel;
        }
        
        // إظهار رابط إدارة المستخدمين حصرياً للمدير
        const navUsers = document.getElementById('nav-users');
        if (navUsers) {
            navUsers.style.display = state.user.role === 'admin' ? 'flex' : 'none';
        }

        // تطبيق الصلاحيات والقيود بناء على الدور المحاسبي
        applyRoleBasedPermissions();

        // 2. تحديث حالة الاتصال وقاعدة البيانات لسلة
        await updateDBStatus();

        // 3. تحميل المصروفات والأرشيف والتسويات
        await loadLocalData();
        await loadAdjustments();
        buildArcList();
        updateArcUI();

        // 4. جلب طلبات سلة والسلات المتروكة
        await Promise.all([
            loadOrders(true),
            loadCarts(true)
        ]);

        nav('overview');
    } catch (e) {
        console.error('خطأ أثناء تشغيل التطبيق:', e);
        toast('خطأ أثناء الاتصال بالخادم الرئيسي', 'err');
    }
}

function applyRoleBasedPermissions() {
    if (!state.user) return;
    const role = state.user.role;
    
    // الموظف لا يملك صلاحية إضافة مصروف، جرد المخزون، أو بدء أرشفة الأشهر
    if (role === 'employee') {
        const addBtn = document.getElementById('addBtn');
        const addExpBtn = document.getElementById('addExpBtn');
        const newMonthBtn = document.getElementById('newMonthBtn');
        if (addBtn) addBtn.style.display = 'none';
        if (addExpBtn) addExpBtn.style.display = 'none';
        if (newMonthBtn) newMonthBtn.style.display = 'none';
    }
}

async function handleLogout() {
    if (!confirm('هل أنت متأكد من رغبتك في تسجيل الخروج؟')) return;
    try {
        const res = await fetch('/api/auth/logout', { method: 'POST' });
        if (res.ok) {
            window.location.href = 'login.html';
        }
    } catch (e) {
        console.error(e);
        toast('فشل تسجيل الخروج من السيرفر', 'err');
    }
}

async function updateDBStatus() {
    try {
        const res = await fetch('/api/salla/auth-status');
        const data = await res.json();
        
        state.hasCredentials = data.has_credentials;
        state.connected = data.connected;
        state.store = data.store;
        
        // تحديث معلومات واجهة الاستيراد وقاعدة البيانات
        const modeEl = document.getElementById('dbStatusMode');
        const countEl = document.getElementById('dbStatusOrdersCount');
        const countWEl = document.getElementById('dbStatusWalletCount');
        
        if (modeEl && countEl) {
            if (state.connected) {
                modeEl.textContent = 'وضع سلة السحابي المتصل (مباشر)';
                modeEl.style.color = 'var(--green)';
            } else {
                modeEl.textContent = (data.imported_count > 0 || data.imported_wallet_count > 0) ? 'وضع الأوفلاين وقاعدة البيانات المحلية' : 'وضع الأوفلاين والمحاكاة الذاتية';
                modeEl.style.color = 'var(--amber)';
            }
            countEl.textContent = `${data.imported_count || 0} طلب`;
            if (countWEl) {
                countWEl.textContent = `${data.imported_wallet_count || 0} عملية`;
            }
        }

        // تحديث معلومات المتجر في اللوحة الجانبية
        const avatarEl = document.getElementById('storeAvatar');
        const nameEl = document.getElementById('storeName');
        const urlEl = document.getElementById('storeUrl');

        if (avatarEl && nameEl && urlEl) {
            if (state.store.avatar && state.store.avatar.startsWith('http')) {
                avatarEl.style.backgroundImage = `url(${state.store.avatar})`;
                avatarEl.textContent = '';
            } else {
                avatarEl.style.backgroundImage = 'none';
                avatarEl.textContent = state.store.name.substring(0, 1);
            }
            nameEl.textContent = state.store.name;
            urlEl.textContent = state.store.domain;
        }

        // تحديث شارة الربط
        const liveBadge = document.getElementById('sallaLive');
        if (liveBadge) {
            if (state.connected) {
                liveBadge.className = 'salla-live';
                liveBadge.innerHTML = '<i class="ti ti-circle-check"></i> سلة متصل';
            } else {
                liveBadge.className = 'salla-live offline';
                liveBadge.innerHTML = (data.imported_count > 0 || data.imported_wallet_count > 0) ? '<i class="ti ti-database"></i> وضع الأوفلاين (مستورد)' : '<i class="ti ti-eye-off"></i> وضع المحاكاة';
            }
        }
    } catch (e) {
        console.error('خطأ تحديث حالة قاعدة البيانات:', e);
    }
}

// تحميل المصروفات والأرشيف من الـ API وقاعدة البيانات
async function loadLocalData() {
    try {
        const expRes = await fetch(`/api/expenses`);
        state.expenses = await expRes.json();

        const arcRes = await fetch(`/api/archives`);
        state.archives = await arcRes.json();
    } catch (e) {
        console.error('خطأ في تحميل بيانات المصروفات:', e);
        toast('فشل جلب المصروفات من السيرفر', 'err');
    }
}

// تحميل تسويات جرد المخزون يدوياً
async function loadAdjustments() {
    try {
        const res = await fetch('/api/products/adjustments');
        state.adjustments = await res.json();
    } catch (e) {
        console.error('فشل جلب تسويات جرد المخزون:', e);
    }
}

// ══════════════════════════════════════════════
//  TOAST & NOTIFICATIONS
// ══════════════════════════════════════════════
function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const ic = { ok: 'check', err: 'alert-circle', info: 'info-circle', warn: 'alert-triangle' };
    el.innerHTML = `<i class="ti ti-${ic[type] || 'info-circle'}"></i> ${msg}`;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3800);
}

// ══════════════════════════════════════════════
//  NAVIGATION & ROUTING
// ══════════════════════════════════════════════
const PAGES = ['overview', 'expenses', 'salla-orders', 'salla-carts', 'salla-wallet', 'salla-products', 'import', 'users'];
const PAGE_TITLES = {
    overview: 'نظرة عامة',
    expenses: 'المصروفات',
    'salla-orders': 'طلبات سلة',
    'salla-carts': 'السلات المتروكة',
    'salla-wallet': 'محفظة سلة',
    'salla-products': 'المخزون والمنتجات',
    import: 'استيراد Excel',
    users: 'إدارة المستخدمين'
};

// دالة التحكم في القائمة الجانبية للشاشات الصغيرة (الجوال)
function toggleSidebar(open) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (!sidebar || !overlay) return;
    if (open) {
        sidebar.classList.add('open');
        overlay.style.display = 'block';
    } else {
        sidebar.classList.remove('open');
        overlay.style.display = 'none';
    }
}

function nav(name) {
    // إغلاق القائمة تلقائياً عند تغيير الصفحة على الهواتف
    toggleSidebar(false);

    PAGES.forEach(p => {
        document.getElementById('page-' + p)?.classList.remove('active');
    });
    document.getElementById('page-' + name)?.classList.add('active');
    
    // تحديث التحديد في القائمة الجانبية
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    // إيجاد العنصر الفعال وتحديده
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        const onClickStr = item.getAttribute('onclick') || '';
        if (onClickStr.includes(`'${name}'`)) {
            item.classList.add('active');
        }
    });

    document.getElementById('pageTitle').textContent = PAGE_TITLES[name] || name;

    // إخفاء زر الإضافة في الصفحات غير المحاسبية وبناء على صلاحية الموظف
    const isLocal = ['overview', 'expenses'].includes(name);
    const hasWritePermission = state.user && state.user.role !== 'employee';
    document.getElementById('addBtn').style.display = (isLocal && !state.viewingArc && hasWritePermission) ? '' : 'none';

    if (name === 'overview') renderOverview();
    if (name === 'expenses') renderExp();
    if (name === 'salla-orders') renderOrders();
    if (name === 'salla-carts') renderCarts();
    if (name === 'salla-wallet') renderWallet();
    if (name === 'salla-products') renderProducts();
    if (name === 'users') loadUsers();
}

// ══════════════════════════════════════════════
//  MONTH SWITCHER & ARCHIVES
// ══════════════════════════════════════════════
function switchMonth(val) {
    // إغلاق القائمة تلقائياً عند تغيير أرشيف الشهر على الجوال
    toggleSidebar(false);
    
    state.viewingArc = val === 'live' ? null : val;
    updateArcUI();
    buildArcList();
    
    if (state.viewingArc) {
        // جلب تفاصيل الشهر مؤرشف من الـ API
        fetch(`/api/archives/${state.viewingArc}`)
            .then(res => res.json())
            .then(data => {
                state.expenses = data.expenses || [];
                state.sales = data.sales || [];
                state.wallet = data.wallet || [];
                
                // تعبئة مبيعات الطلبات لجميع الصفحات من المبيعات المؤرشفة
                sallaOrders = state.sales;
                
                renderOverview();
                renderExp();
                renderWallet();
                
                // تحديث العداد الجانبي للطلبات
                document.getElementById('ordBadge').textContent = sallaOrders.length;
            });
    } else {
        // الرجوع للوضع المباشر
        loadLocalData().then(() => {
            // إعادة جلب مبيعات المتجر الفعالة لتحديث اللوحة بالكامل
            loadOrders(true).then(() => {
                loadCarts(true).then(() => {
                    renderOverview();
                    renderExp();
                    renderWallet();
                });
            });
        });
    }
}

function updateArcUI() {
    const ro = !!state.viewingArc;
    const label = state.viewingArc ? (state.archives.find(a => a.key === state.viewingArc)?.name || state.viewingArc) : arMonth(CURRENT_MONTH) + ' (مباشر)';
    document.getElementById('pageSub').textContent = ro ? `🗄 أرشيف: ${label}` : `📅 ${label}`;
    document.getElementById('addBtn').style.display = ro ? 'none' : '';
    document.getElementById('addExpBtn').style.display = ro ? 'none' : '';
    if (document.getElementById('newMonthBtn')) {
        document.getElementById('newMonthBtn').style.display = ro ? 'none' : '';
    }
    const arcNote = state.viewingArc ? `عرض أرشيف: ${label} — للقراءة فقط` : '';
    
    ['arcNote', 'expArcNote'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = ro ? 'flex' : 'none';
        if (id === 'arcNote') document.getElementById('arcNoteText').textContent = arcNote;
    });
}

function buildArcList() {
    const el = document.getElementById('arcList');
    const sel = document.getElementById('monthSel');
    sel.innerHTML = '<option value="live">📅 الشهر الحالي (مباشر)</option>';
    
    state.archives.forEach(a => {
        sel.innerHTML += `<option value="${a.key}">🗄 ${a.name}</option>`;
    });
    
    sel.value = state.viewingArc || 'live';
    
    if (!state.archives.length) {
        el.innerHTML = '<div style="padding:5px 12px;font-size:11px;color:var(--text3)">لا يوجد أرشيف</div>';
        return;
    }
    
    el.innerHTML = state.archives.map(a => {
        return `<div class="arc-item ${state.viewingArc === a.key ? 'sel' : ''}" onclick="viewArc('${a.key}')" style="display:flex; justify-content:space-between; align-items:center; padding: 6px 8px 6px 12px;">
          <span>${a.name}</span>
          <button onclick="event.stopPropagation(); deleteArchive('${a.key}')" style="background:transparent; border:none; color:var(--red); cursor:pointer; font-size:11px; opacity:0.6; display:flex; align-items:center; transition:opacity .15s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6" title="حذف هذا الأرشيف نهائياً">
            <i class="ti ti-trash"></i>
          </button>
        </div>`;
    }).join('');
}

// دالة حذف الأرشيف الشهري نهائياً
async function deleteArchive(key) {
    const arch = state.archives.find(a => a.key === key);
    const name = arch ? arch.name : key;
    
    if (!confirm(`هل أنت متأكد من رغبتك في حذف الأرشيف "${name}" نهائياً؟ لا يمكن استرجاع المبيعات والتسويات والمصروفات الخاصة بهذا الشهر بعد الحذف.`)) return;
    
    try {
        const response = await fetch(`/api/archives/${key}`, {
            method: 'DELETE'
        });
        const resData = await response.json();
        
        if (resData.success) {
            toast(`تم حذف الأرشيف "${name}" بنجاح!`, 'info');
            
            // إذا كنا نقوم حالياً باستعراض هذا الشهر مؤرشف، نعيده فوراً للشهر الحالي
            if (state.viewingArc === key) {
                switchMonth('live');
            } else {
                await loadLocalData();
                buildArcList();
            }
        } else {
            toast('فشل حذف الأرشيف', 'err');
        }
    } catch (e) {
        console.error('خطأ أثناء حذف الأرشيف:', e);
        toast('خطأ في الاتصال بالخادم لحذف الأرشيف', 'err');
    }
}

function viewArc(key) {
    switchMonth(key);
}

// أرشفة الشهر الحالي
function openArchModal() {
    if (state.viewingArc) { toast('عد للشهر الحالي أولاً', 'warn'); return; }
    document.getElementById('archName').value = arMonth(CURRENT_MONTH);
    
    const expTotal = state.expenses.reduce((s, e) => s + (e.amt || 0), 0);
    const sallaTotal = sallaOrders.reduce((s, o) => s + (o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0), 0);
    
    document.getElementById('archSummary').innerHTML = `
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px"><span>المصروفات</span><span class="mono red">${fmt(expTotal)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px"><span>مبيعات سلة</span><span class="mono green">${fmt(sallaTotal)}</span></div>
    `;
    document.getElementById('archModal').classList.add('open');
}

async function doArchive() {
    const name = document.getElementById('archName').value.trim() || arMonth(CURRENT_MONTH);
    
    try {
        const response = await fetch('/api/archives', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                month: CURRENT_MONTH,
                sales_json: JSON.stringify(state.sales),
                wallet_json: JSON.stringify(state.wallet)
            })
        });
        
        const resData = await response.json();
        if (resData.success) {
            // تصفير الجداول النشطة المبيعات والتسويات من قاعدة البيانات للشهر الجديد
            await fetch('/api/salla/clear-imports', { method: 'POST' });
            await fetch('/api/salla/clear-wallet-imports', { method: 'POST' });

            document.getElementById('archModal').classList.remove('open');
            toast(`تمت أرشفة "${name}" وتصفير الشهر الجديد بنجاح!`, 'ok');

            // تفريغ منطق الحالة الفعالة
            sallaOrders = [];
            state.sales = [];
            state.wallet = [];

            await loadLocalData();
            await updateDBStatus();
            await loadOrders(true);
            await loadCarts(true);
            
            buildArcList();
            updateArcUI();
            renderOverview();
            renderExp();
            renderWallet();
        } else {
            toast('فشلت عملية الأرشفة', 'err');
        }
    } catch (e) {
        console.error('خطأ أرشفة الشهر:', e);
        toast('خطأ في الاتصال بالسيرفر لتنفيذ الأرشفة', 'err');
    }
}

// ══════════════════════════════════════════════
//  SALLA LIVE API CALLS
// ══════════════════════════════════════════════
function setSyncState(status) {
    const dot = document.getElementById('syncDot');
    const txt = document.getElementById('syncTxt');
    dot.className = 'sync-dot' + (status === 'loading' ? ' loading' : status === 'error' ? ' error' : '');
    txt.textContent = status === 'loading' ? 'جاري المزامنة...' : status === 'error' ? 'فشلت المزامنة' : 'محدّث';
}

async function loadOrders(reset = false) {
    if (reset) { ordPage = 1; sallaOrders = []; }
    
    // إذا كنا في وضع الأرشيف، نكتفي بعرض المبيعات مؤرشفة المسجلة بالحالة
    if (state.viewingArc) {
        sallaOrders = state.sales || [];
        renderOrders();
        updateOrdKPIs();
        renderProducts();
        updateOverviewWithSalla();
        
        const ordLoading = document.getElementById('ordLoading');
        const ordTblWrap = document.getElementById('ordTblWrap');
        if (ordLoading) ordLoading.style.display = 'none';
        if (ordTblWrap) ordTblWrap.style.display = '';
        return;
    }

    setSyncState('loading');
    const ordLoading = document.getElementById('ordLoading');
    const ordTblWrap = document.getElementById('ordTblWrap');
    if (ordLoading) ordLoading.style.display = 'flex';
    if (ordTblWrap) ordTblWrap.style.display = 'none';

    const from = document.getElementById('ordFrom').value || '2026-05-01';
    const to = document.getElementById('ordTo').value || TODAY;
    const q = document.getElementById('ordQ')?.value || '';
    const status = document.getElementById('ordStatus')?.value || '';

    try {
        let url = `/api/salla/orders?page=${ordPage}&from=${from}&to=${to}&q=${encodeURIComponent(q)}&status=${status}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.data) {
            sallaOrders = data.data;
            state.sales = data.data; // حفظ المبيعات النشطة في الحالة للاستعداد للأرشفة
            ordPageTotal = data.pagination?.total_pages || 1;
            document.getElementById('ordBadge').textContent = data.pagination?.total || sallaOrders.length;
        }
        
        setSyncState('ok');
        renderOrders();
        updateOrdKPIs();
        renderProducts();
        
        if (ordLoading) ordLoading.style.display = 'none';
        if (ordTblWrap) ordTblWrap.style.display = '';
        updateOverviewWithSalla();
    } catch (e) {
        console.error('خطأ في جلب طلبات سلة:', e);
        setSyncState('error');
    }
}

async function loadCarts(force = false) {
    // إذا كنا في وضع الأرشيف، لا توجد سلات متروكة في الأرشيف
    if (state.viewingArc) {
        sallaCartData = { count: 0, total: 0 };
        document.getElementById('cartBadge').textContent = '0';
        renderCarts([]);
        
        const cartLoading = document.getElementById('cartLoading');
        const cartTblWrap = document.getElementById('cartTblWrap');
        if (cartLoading) cartLoading.style.display = 'none';
        if (cartTblWrap) cartTblWrap.style.display = '';
        return;
    }

    const cartLoading = document.getElementById('cartLoading');
    const cartTblWrap = document.getElementById('cartTblWrap');
    if (cartLoading) cartLoading.style.display = 'flex';
    if (cartTblWrap) cartTblWrap.style.display = 'none';

    try {
        const res = await fetch('/api/salla/abandoned-carts');
        const data = await res.json();

        if (data.data) {
            sallaCartData.count = data.summary?.total_count || data.data.length;
            sallaCartData.total = data.summary?.total_value || data.data.reduce((s, c) => s + (c.total?.amount || 0), 0);
            
            document.getElementById('cartBadge').textContent = sallaCartData.count;
            renderCarts(data.data);
        }
        
        if (cartLoading) cartLoading.style.display = 'none';
        if (cartTblWrap) cartTblWrap.style.display = '';
    } catch (e) {
        console.error('خطأ في السلات المتروكة:', e);
    }
}

async function syncSalla() {
    document.getElementById('syncBtn').disabled = true;
    toast('جاري تحديث البيانات من متجر سلة...', 'info');
    await Promise.all([
        loadOrders(true),
        loadCarts(true)
    ]);
    document.getElementById('syncBtn').disabled = false;
    toast('تم تحديث البيانات بنجاح', 'ok');
}

// ── RENDER ORDERS ──
function renderOrders() {
    const body = document.getElementById('ordBody');
    if (!body) return;
    
    if (!sallaOrders.length) {
        body.innerHTML = '<tr><td colspan="8"><div class="empty"><i class="ti ti-inbox"></i><p>لا توجد طلبات في هذا النطاق</p></div></td></tr>';
        return;
    }
    
    body.innerHTML = sallaOrders.map((o, i) => {
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount ?? o.total?.amount ?? 0;
        const prod = o.items?.[0] || {};
        const st = o.status?.slug || '';
        const stCls = st === 'completed' ? 'pill-green' : st === 'under_review' ? 'pill-accent' : 'pill-amber';
        const stName = o.status?.customized?.name || o.status?.name || st;
        const thumb = prod.thumbnail ? `<img src="${prod.thumbnail}" class="product-thumb" onerror="this.style.display='none'">` : '';
        const date = (o.date?.date || o.created_at || '').substring(0, 10);
        return `<tr>
          <td style="color:var(--text3);font-size:10px">${(ordPage - 1) * 15 + i + 1}</td>
          <td><span class="mono" style="font-size:11px">#${o.reference_id || o.id}</span></td>
          <td><div class="product-chip">${thumb}<span class="product-name">${prod.name || '-'}</span></div></td>
          <td style="font-size:11px;color:var(--text2)">${o.customer?.full_name || '-'}</td>
          <td style="font-size:10px;color:var(--text3)">${payLabel(o.payment_method)}</td>
          <td><span class="mono green">${fmt(amt)}</span></td>
          <td><span class="pill ${stCls}">${stName}</span></td>
          <td style="font-size:11px;color:var(--text3)">${fmtDate(date)}</td>
        </tr>`;
    }).join('');
    
    const total = sallaOrders.reduce((s, o) => s + (o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0), 0);
    document.getElementById('ordFoot').innerHTML = `<tr class="tbl-foot"><td colspan="5">الإجمالي (${sallaOrders.length})</td><td><span class="mono green">${fmt(total)}</span></td><td colspan="2"></td></tr>`;
    
    // Pager
    const pg = document.getElementById('ordPager');
    if (!pg) return;
    pg.innerHTML = '';
    if (ordPageTotal > 1) {
        if (ordPage > 1) {
            const b = document.createElement('button');
            b.className = 'btn btn-sm';
            b.innerHTML = '<i class="ti ti-chevron-right"></i>';
            b.onclick = () => { ordPage--; loadOrders(); };
            pg.appendChild(b);
        }
        const s = document.createElement('span');
        s.style = 'font-size:11px;color:var(--text2);align-self:center;padding:0 6px';
        s.textContent = `${ordPage} / ${ordPageTotal}`;
        pg.appendChild(s);
        if (ordPage < ordPageTotal) {
            const b = document.createElement('button');
            b.className = 'btn btn-sm';
            b.innerHTML = '<i class="ti ti-chevron-left"></i>';
            b.onclick = () => { ordPage++; loadOrders(); };
            pg.appendChild(b);
        }
    }
}

function payLabel(m) {
    const map = { mada: 'مدى', apple_pay: 'Apple Pay', stc_pay: 'STC Pay', credit_card: 'بطاقة ائتمان', waiting: 'انتظار' };
    return map[m] || m || '-';
}

function updateOrdKPIs() {
    const el = document.getElementById('ordKPIs');
    if (!el) return;
    const total = sallaOrders.reduce((s, o) => s + (o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0), 0);
    const completed = sallaOrders.filter(o => o.status?.slug === 'completed').length;
    const pending = sallaOrders.filter(o => o.status?.slug === 'under_review' || o.status?.slug === 'payment_pending').length;
    
    document.getElementById('ordTotal').textContent = `${sallaOrders.length} طلب`;
    el.innerHTML = `
        <div class="kpi k-green"><i class="ti ti-shopping-cart kpi-ico"></i><div class="kpi-label">إجمالي المبيعات</div><div class="kpi-val accent">${sallaOrders.length.toLocaleString()}</div><div class="kpi-sub">ر.س ${fmt(total)}</div></div>
        <div class="kpi k-green"><i class="ti ti-check kpi-ico"></i><div class="kpi-label">طلبات مكتملة</div><div class="kpi-val green">${completed}</div><div class="kpi-sub">${sallaOrders.length ? ((completed / sallaOrders.length) * 100).toFixed(0) : 0}%</div></div>
        <div class="kpi k-amber"><i class="ti ti-clock kpi-ico"></i><div class="kpi-label">بانتظار المعالجة</div><div class="kpi-val amber">${pending}</div><div class="kpi-sub">طلب معلق</div></div>
        <div class="kpi k-blue"><i class="ti ti-currency-dollar kpi-ico"></i><div class="kpi-label">متوسط قيمة الطلب</div><div class="kpi-val blue">${sallaOrders.length ? fmt(total / sallaOrders.length) : 0}</div><div class="kpi-sub">ر.س</div></div>
    `;
}

// ── RENDER CARTS ──
function renderCarts(carts) {
    const kpis = document.getElementById('cartKPIs');
    if (kpis) {
        kpis.innerHTML = `
            <div class="kpi k-red"><i class="ti ti-basket-off kpi-ico"></i><div class="kpi-label">إجمالي السلات المتروكة</div><div class="kpi-val red">${sallaCartData.count.toLocaleString()}</div><div class="kpi-sub">سلة متروكة</div></div>
            <div class="kpi k-amber"><i class="ti ti-currency-dollar kpi-ico"></i><div class="kpi-label">قيمة السلات (تقديرية)</div><div class="kpi-val amber">${fmt(sallaCartData.total)}</div><div class="kpi-sub">ر.س</div></div>
            <div class="kpi k-purple"><i class="ti ti-percentage kpi-ico"></i><div class="kpi-label">معدل التخلي التقديري</div><div class="kpi-val purple">44.6%</div><div class="kpi-sub">من الزوار الفعليين</div></div>
        `;
    }
    
    const body = document.getElementById('cartBody');
    if (!body) return;
    
    if (!carts || !carts.length) {
        body.innerHTML = '<tr><td colspan="6"><div class="empty"><i class="ti ti-basket"></i><p>لا توجد سلات متروكة حالياً</p></div></td></tr>';
        return;
    }

    body.innerHTML = carts.map((c, i) => {
        const custName = c.customer?.full_name || 'عميل غير مسجل';
        const items = c.items?.map(it => `${it.name || ''} × ${it.quantity || 1}`).join('، ') || 'منتج غير معروف';
        const val = c.total?.amount || 0;
        const date = (c.created_at || '').substring(0, 16);
        return `<tr>
        <td style="color:var(--text3);font-size:10px">${i + 1}</td>
        <td style="font-size:11px; font-weight:600;">${custName}</td>
        <td style="font-size:11px;color:var(--text2)">${items}</td>
        <td><span class="mono amber">${fmt(val)}</span></td>
        <td style="font-size:10px;color:var(--text3)">${fmtDate(date)}</td>
        <td><span class="pill pill-red">متروكة</span></td>
      </tr>`;
    }).join('');
}

// ══════════════════════════════════════════════
//  WALLET OPERATIONS
// ══════════════════════════════════════════════
async function renderWallet() {
    const kpis = document.getElementById('walKPIs');
    if (!kpis) return;
    
    // إذا كنا في وضع الأرشيف، نعرض البيانات المسترجعة للأرشيف مباشرة ولا نتصل بالـ API
    if (state.viewingArc) {
        const importedList = state.wallet || [];
        if (importedList.length > 0) {
            const totalSales = importedList.reduce((s, t) => s + (t.amount || 0), 0);
            const totalCommission = importedList.reduce((s, t) => s + (t.commission || 0), 0);
            const totalTax = importedList.reduce((s, t) => s + (t.tax || 0), 0);
            const netPayout = importedList.reduce((s, t) => s + (t.net || 0), 0);
            const totalFees = totalCommission + totalTax;

            kpis.innerHTML = `
                <div class="kpi k-blue"><i class="ti ti-cash kpi-ico"></i><div class="kpi-label">مبيعات المحفظة الإجمالية</div><div class="kpi-val blue">${fmt(totalSales)}</div><div class="kpi-sub">ر.س · مؤرشفة</div></div>
                <div class="kpi k-accent"><i class="ti ti-wallet kpi-ico"></i><div class="kpi-label">الصافي الفعلي للمحفظة</div><div class="kpi-val accent">${fmt(netPayout)}</div><div class="kpi-sub">ر.س · مؤرشفة</div></div>
                <div class="kpi k-red"><i class="ti ti-percentage kpi-ico"></i><div class="kpi-label">العمولات والضرائب المستقطعة</div><div class="kpi-val red">${fmt(totalFees)}</div><div class="kpi-sub">${totalSales > 0 ? ((totalFees / totalSales) * 100).toFixed(2) : 0}% عمولة + ضريبة</div></div>
                <div class="kpi k-green"><i class="ti ti-checks kpi-ico"></i><div class="kpi-label">الحالة التشغيلية</div><div class="kpi-val green">مؤرشف مغلق</div><div class="kpi-sub">من كشف المحفظة المؤرشف</div></div>
            `;

            const body = document.getElementById('walBody');
            if (body) {
                body.innerHTML = importedList.map((t, i) => `<tr>
                    <td style="color:var(--text3);font-size:10px">${i + 1}</td>
                    <td style="font-family:var(--mono);font-size:10px;color:var(--text2)">#${t.reference_id}</td>
                    <td><span class="mono">${fmt(t.amount)}</span></td>
                    <td><span class="mono red">${fmt(t.commission)}</span></td>
                    <td><span class="mono green">${fmt(t.net)}</span></td>
                    <td style="font-size:11px;color:var(--text2)">${fmtDate(t.date)}</td>
                    <td><span class="pill pill-green">${t.status}</span></td>
                    <td><span style="font-size:10px;color:var(--text3)">ضريبة: ${fmt(t.tax)}</span></td>
                </tr>`).join('');

                document.getElementById('walFoot').innerHTML = `<tr class="tbl-foot"><td colspan="2">الإجمالي (${importedList.length})</td><td><span class="mono">${fmt(totalSales)}</span></td><td><span class="mono red">${fmt(totalCommission)}</span></td><td><span class="mono green">${fmt(netPayout)}</span></td><td colspan="3"></td></tr>`;
            }

            renderWalletChartFromImported(importedList);
            return;
        }
    }
    
    const from = document.getElementById('walFrom').value;
    const to = document.getElementById('walTo').value || TODAY;
    const status = document.getElementById('walStatus').value;

    try {
        const res = await fetch(`/api/salla/wallet?from=${from}&to=${to}&status=${status}`);
        const json = await res.json();
        const importedList = json.data || [];

        if (importedList.length > 0) {
            if (!state.viewingArc) {
                state.wallet = importedList; // حفظ تسويات المحفظة النشطة في الحالة للاستعداد للأرشفة
            }
            // لدينا عمليات تسوية حقيقية مستوردة من كشف حساب المحفظة!
            const totalSales = importedList.reduce((s, t) => s + (t.amount || 0), 0);
            const totalCommission = importedList.reduce((s, t) => s + (t.commission || 0), 0);
            const totalTax = importedList.reduce((s, t) => s + (t.tax || 0), 0);
            const netPayout = importedList.reduce((s, t) => s + (t.net || 0), 0);
            const totalFees = totalCommission + totalTax;

            kpis.innerHTML = `
                <div class="kpi k-blue"><i class="ti ti-cash kpi-ico"></i><div class="kpi-label">مبيعات المحفظة الإجمالية</div><div class="kpi-val blue">${fmt(totalSales)}</div><div class="kpi-sub">ر.س · مستوردة</div></div>
                <div class="kpi k-accent"><i class="ti ti-wallet kpi-ico"></i><div class="kpi-label">الصافي الفعلي للمحفظة</div><div class="kpi-val accent">${fmt(netPayout)}</div><div class="kpi-sub">ر.س · محولة لحسابك البنكي</div></div>
                <div class="kpi k-red"><i class="ti ti-percentage kpi-ico"></i><div class="kpi-label">العمولات والضرائب المستقطعة</div><div class="kpi-val red">${fmt(totalFees)}</div><div class="kpi-sub">${totalSales > 0 ? ((totalFees / totalSales) * 100).toFixed(2) : 0}% عمولة + ضريبة</div></div>
                <div class="kpi k-green"><i class="ti ti-checks kpi-ico"></i><div class="kpi-label">الحالة التشغيلية</div><div class="kpi-val green">مستوردة</div><div class="kpi-sub">من كشف المحفظة الفعلي</div></div>
            `;

            const body = document.getElementById('walBody');
            if (body) {
                body.innerHTML = importedList.map((t, i) => `<tr>
                    <td style="color:var(--text3);font-size:10px">${i + 1}</td>
                    <td style="font-family:var(--mono);font-size:10px;color:var(--text2)">#${t.reference_id}</td>
                    <td><span class="mono">${fmt(t.amount)}</span></td>
                    <td><span class="mono red">${fmt(t.commission)}</span></td>
                    <td><span class="mono green">${fmt(t.net)}</span></td>
                    <td style="font-size:11px;color:var(--text2)">${fmtDate(t.date)}</td>
                    <td><span class="pill pill-green">${t.status}</span></td>
                    <td><span style="font-size:10px;color:var(--text3)">ضريبة: ${fmt(t.tax)}</span></td>
                </tr>`).join('');

                document.getElementById('walFoot').innerHTML = `<tr class="tbl-foot"><td colspan="2">الإجمالي (${importedList.length})</td><td><span class="mono">${fmt(totalSales)}</span></td><td><span class="mono red">${fmt(totalCommission)}</span></td><td><span class="mono green">${fmt(netPayout)}</span></td><td colspan="3"></td></tr>`;
            }

            renderWalletChartFromImported(importedList);
            return;
        }
    } catch (e) {
        console.error('خطأ أثناء جلب عمليات المحفظة:', e);
    }

    // 2. إذا لم يكن هناك تسويات مستوردة، نرجع للمحاكاة/التقدير المعتاد من المبيعات
    const totalSales = sallaOrders.reduce((s, o) => s + (o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0), 0);
    let totalCommission = 0;
    sallaOrders.forEach(o => {
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
        if (o.payment_method && o.payment_method !== 'cod' && o.payment_method !== 'waiting') {
            totalCommission += (amt * 0.0175) + 1;
        }
    });
    const netPayout = totalSales - totalCommission;

    kpis.innerHTML = `
        <div class="kpi k-blue"><i class="ti ti-cash kpi-ico"></i><div class="kpi-label">مبيعات المحفظة التقديرية</div><div class="kpi-val blue">${fmt(totalSales)}</div><div class="kpi-sub">ر.س</div></div>
        <div class="kpi k-accent"><i class="ti ti-wallet kpi-ico"></i><div class="kpi-label">الصافي التقديري</div><div class="kpi-val accent">${fmt(netPayout)}</div><div class="kpi-sub">بعد خصم عمولة البوابات</div></div>
        <div class="kpi k-red"><i class="ti ti-percentage kpi-ico"></i><div class="kpi-label">عمولة البوابات التقديرية</div><div class="kpi-val red">${fmt(totalCommission)}</div><div class="kpi-sub">${totalSales > 0 ? ((totalCommission / totalSales) * 100).toFixed(2) : 0}%</div></div>
        <div class="kpi k-green"><i class="ti ti-checks kpi-ico"></i><div class="kpi-label">الحالة التشغيلية</div><div class="kpi-val green">فعال</div><div class="kpi-sub">مزامنة سحابية تقديرية</div></div>
    `;

    const body = document.getElementById('walBody');
    if (!body) return;
    
    const fromSelect = document.getElementById('walFrom').value;
    const toSelect = document.getElementById('walTo').value || TODAY;

    let filteredOrders = sallaOrders.filter(o => {
        const date = (o.date?.date || o.created_at || '').substring(0, 10);
        if (fromSelect && date < fromSelect) return false;
        if (toSelect && date > toSelect) return false;
        return true;
    });

    if (!filteredOrders.length) {
        body.innerHTML = '<tr><td colspan="8"><div class="empty"><i class="ti ti-wallet"></i><p>لا توجد مبيعات إلكترونية مسجلة بعد</p></div></td></tr>';
        return;
    }

    body.innerHTML = filteredOrders.map((o, i) => {
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
        const comm = (o.payment_method && o.payment_method !== 'cod' && o.payment_method !== 'waiting') ? (amt * 0.0175) + 1 : 0;
        const net = amt - comm;
        const date = (o.date?.date || o.created_at || '').substring(0, 10);
        return `<tr>
        <td style="color:var(--text3);font-size:10px">${i + 1}</td>
        <td style="font-family:var(--mono);font-size:10px;color:var(--text2)">#${o.reference_id || o.id}</td>
        <td><span class="mono">${fmt(amt)}</span></td>
        <td><span class="mono red">${fmt(comm)}</span></td>
        <td><span class="mono green">${fmt(net)}</span></td>
        <td style="font-size:11px;color:var(--text2)">${fmtDate(date)}</td>
        <td><span class="pill pill-green">مدفوعة</span></td>
        <td>-</td>
      </tr>`;
    }).join('');

    const totalOrdersVal = filteredOrders.reduce((s, o) => s + (o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0), 0);
    const totalCommVal = filteredOrders.reduce((s, o) => {
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
        return s + ((o.payment_method && o.payment_method !== 'cod' && o.payment_method !== 'waiting') ? (amt * 0.0175) + 1 : 0);
    }, 0);
    const totalNetVal = totalOrdersVal - totalCommVal;

    document.getElementById('walFoot').innerHTML = `<tr class="tbl-foot"><td colspan="2">الإجمالي (${filteredOrders.length})</td><td><span class="mono">${fmt(totalOrdersVal)}</span></td><td><span class="mono red">${fmt(totalCommVal)}</span></td><td><span class="mono green">${fmt(totalNetVal)}</span></td><td colspan="3"></td></tr>`;

    renderWalletChart(filteredOrders);
}

function renderWalletChart(orders) {
    const byM = {};
    orders.forEach(o => {
        const date = o.date?.date || o.created_at || CURRENT_MONTH;
        const m = date.substring(0, 7);
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
        const comm = (o.payment_method && o.payment_method !== 'cod' && o.payment_method !== 'waiting') ? (amt * 0.0175) + 1 : 0;
        const net = amt - comm;
        byM[m] = (byM[m] || 0) + net;
    });
    
    const months = Object.keys(byM).sort();
    const ctx = document.getElementById('walChart');
    if (!ctx) return;
    
    if (walC) walC.destroy();
    walC = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: months.map(arMonth),
            datasets: [{ label: 'الصافي التقديري', data: months.map(m => byM[m]), backgroundColor: '#18B2B0', borderRadius: 4 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#7a80a0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                y: { ticks: { color: '#7a80a0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } }
            }
        }
    });
}

function renderWalletChartFromImported(list) {
    const byM = {};
    list.forEach(t => {
        const m = t.date.substring(0, 7);
        byM[m] = (byM[m] || 0) + (t.net || 0);
    });
    
    const months = Object.keys(byM).sort();
    const ctx = document.getElementById('walChart');
    if (!ctx) return;
    
    if (walC) walC.destroy();
    walC = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: months.map(arMonth),
            datasets: [{ label: 'الصافي المحول', data: months.map(m => byM[m]), backgroundColor: '#18B2B0', borderRadius: 4 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#7a80a0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                y: { ticks: { color: '#7a80a0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } }
            }
        }
    });
}

// ══════════════════════════════════════════════
//  المخزون والمنتجات وحساب المبيعات الذكي
// ══════════════════════════════════════════════
function renderProducts() {
    const q = (document.getElementById('prodQ')?.value || '').toLowerCase();
    
    // 1. تجميع المبيعات من الطلبات المتاحة
    const map = {};
    sallaOrders.forEach(o => {
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
        (o.items || []).forEach(item => {
            const name = (item.name || 'غير معروف').trim();
            if (name) {
                if (!map[name]) {
                    map[name] = { name, soldCount: 0, totalRevenue: 0, purchasedCount: 0, avgCost: 0, sellingPrice: 0 };
                }
                map[name].soldCount += item.quantity || 1;
                map[name].totalRevenue += amt / ((o.items || []).length);
            }
        });
    });

    // 2. تجميع المشتريات وتحديث أسعار التكلفة والبيع من المصروفات التشغيلية
    state.expenses.forEach(e => {
        if (e.cat === 'شراء منتجات' && e.product_name) {
            const name = e.product_name.trim();
            if (name) {
                if (!map[name]) {
                    map[name] = { name, soldCount: 0, totalRevenue: 0, purchasedCount: 0, avgCost: 0, sellingPrice: 0 };
                }
                map[name].purchasedCount += e.quantity || 0;
                // آخر سعر شراء وتكلفة مسجلين
                if (e.purchase_price) map[name].avgCost = e.purchase_price;
                if (e.selling_price) map[name].sellingPrice = e.selling_price;
            }
        }
    });

    // 2.5. تجميع المنتجات من تسويات الجرد اليدوية المسجلة (حتى لو لم يكن لها مبيعات أو مشتريات)
    state.adjustments.forEach(a => {
        const name = (a.product_name || '').trim();
        if (name) {
            if (!map[name]) {
                map[name] = { name, soldCount: 0, totalRevenue: 0, purchasedCount: 0, avgCost: 0, sellingPrice: 0 };
            }
            if (a.cost > 0) map[name].avgCost = a.cost;
            if (a.price > 0) map[name].sellingPrice = a.price;
        }
    });

    // 3. احتساب المخزون الفعلي بالتكامل مع تسويات الجرد اليدوية
    let prods = Object.values(map).map(p => {
        const adj = state.adjustments.find(a => a.product_name === p.name) || { stock_offset: 0, cost: 0, price: 0 };
        
        const currentStock = p.purchasedCount - p.soldCount + adj.stock_offset;
        const avgCost = adj.cost > 0 ? adj.cost : p.avgCost;
        const sellingPrice = adj.price > 0 ? adj.price : p.sellingPrice;
        
        return {
            ...p,
            currentStock,
            avgCost,
            sellingPrice,
            stock_offset: adj.stock_offset
        };
    });

    // التصفية والفرز
    if (q) prods = prods.filter(p => p.name.toLowerCase().includes(q));
    
    // الفرز: مبيعات أعلى أولاً
    prods.sort((a, b) => b.soldCount - a.soldCount);
    
    const body = document.getElementById('prodBody');
    if (!body) return;
    
    if (!prods.length) {
        body.innerHTML = '<tr><td colspan="9"><div class="empty"><i class="ti ti-box"></i><p>لا توجد منتجات مسجلة في المشتريات أو المبيعات</p></div></td></tr>';
        return;
    }

    body.innerHTML = prods.map((p, i) => {
        // تحديد فئة المخزون ولونه
        let stockClass = 'pill-green';
        let stockLabel = `${p.currentStock.toLocaleString('ar-SA')} قطعة`;
        
        if (p.currentStock <= 0) {
            stockClass = 'pill-red';
            stockLabel = p.currentStock === 0 ? 'نفد المخزون' : `عجز جرد (${p.currentStock.toLocaleString('ar-SA')})`;
        } else if (p.currentStock < 5) {
            stockClass = 'pill-amber';
            stockLabel = `منخفض (${p.currentStock.toLocaleString('ar-SA')})`;
        }

        // حساب سعر البيع الفعلي أو المقدر
        const sellPrice = p.sellingPrice > 0 ? p.sellingPrice : (p.soldCount > 0 ? (p.totalRevenue / p.soldCount) : 0);

        return `<tr>
            <td style="color:var(--text3);font-size:10px">${i + 1}</td>
            <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;" title="${escapeHtml(p.name)}">${p.name}</td>
            <td><span class="pill ${stockClass}" style="font-weight:600">${stockLabel}</span></td>
            <td style="font-family:var(--mono)">${p.purchasedCount.toLocaleString('ar-SA')}</td>
            <td style="font-family:var(--mono)">${p.soldCount.toLocaleString('ar-SA')}</td>
            <td><span class="mono red">${p.avgCost > 0 ? fmt(p.avgCost) : '-'}</span></td>
            <td><span class="mono green">${sellPrice > 0 ? fmt(sellPrice) : '-'}</span></td>
            <td><span class="mono green" style="font-weight:700">${fmt(p.totalRevenue)}</span></td>
            <td>
                <button style="padding: 4px 8px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent3); color: var(--accent); cursor: pointer; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;" onclick="openJardModal('${escapeHtml(p.name)}')">
                    <i class="ti ti-settings"></i> جرد وتسوية
                </button>
            </td>
        </tr>`;
    }).join('');

    // تحديث الرسم البياني للمبيعات
    const top = prods.slice(0, 8);
    const ctx = document.getElementById('prodChart');
    if (!ctx) return;
    
    if (prodC) prodC.destroy();
    if (top.length) {
        prodC = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: top.map(p => p.name.substring(0, 16)),
                datasets: [{ label: 'إجمالي المبيعات', data: top.map(p => p.totalRevenue), backgroundColor: top.map((_, i) => CAT_COLORS[i % CAT_COLORS.length]), borderRadius: 4 }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#7a80a0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#dde1f0', font: { size: 10 } }, grid: { display: false } }
                }
            }
        });
    }
}

// ══════════════════════════════════════════════
//  OVERVIEW & FINANCIAL SUMMARY
// ══════════════════════════════════════════════
function renderOverview() {
    const expTotal = state.expenses.reduce((s, e) => s + (e.amt || 0), 0);
    const sallaTotal = sallaOrders.reduce((s, o) => s + (o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0), 0);
    const profit = sallaTotal - expTotal;
    const mkt = state.expenses.filter(e => e.cat === 'تسويق').reduce((s, e) => s + (e.amt || 0), 0);
    
    // تقدير صافي المحفظة
    let totalCommission = 0;
    sallaOrders.forEach(o => {
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
        if (o.payment_method && o.payment_method !== 'cod' && o.payment_method !== 'waiting') {
            totalCommission += (amt * 0.0175) + 1;
        }
    });
    const walNet = sallaTotal - totalCommission;

    const ovKPIs = document.getElementById('ovKPIs');
    if (!ovKPIs) return;
    
    ovKPIs.innerHTML = `
        <div class="kpi k-red"><i class="ti ti-receipt kpi-ico"></i><div class="kpi-label">إجمالي المصروفات</div><div class="kpi-val red">${fmt(expTotal)}</div><div class="kpi-sub">ر.س · ${state.expenses.length} بند</div></div>
        <div class="kpi k-green"><i class="ti ti-shopping-cart kpi-ico"></i><div class="kpi-label">إيرادات سلة (مباشر)</div><div class="kpi-val green">${fmt(sallaTotal)}</div><div class="kpi-sub">من ${sallaOrders.length} طلب</div></div>
        <div class="kpi k-accent"><i class="ti ti-wallet kpi-ico"></i><div class="kpi-label">الصافي المقدر بالمحفظة</div><div class="kpi-val accent">${fmt(walNet)}</div><div class="kpi-sub">بعد خصم عمولة الدفع</div></div>
        <div class="kpi ${profit >= 0 ? 'k-green' : 'k-red'}"><i class="ti ti-currency-dollar kpi-ico"></i><div class="kpi-label">صافي الربح التشغيلي</div><div class="kpi-val ${profit >= 0 ? 'green' : 'red'}">${profit < 0 ? '-' : ''}${fmt(Math.abs(profit))}</div><div class="kpi-sub">إيرادات - مصروفات</div></div>
        <div class="kpi k-amber"><i class="ti ti-speakerphone kpi-ico"></i><div class="kpi-label">التسويق والإعلانات</div><div class="kpi-val amber">${fmt(mkt)}</div><div class="kpi-sub">${expTotal ? ((mkt / expTotal) * 100).toFixed(1) : 0}% من المصاريف</div></div>
        <div class="kpi k-red"><i class="ti ti-basket-off kpi-ico"></i><div class="kpi-label">السلات المتروكة</div><div class="kpi-val red">${sallaCartData.count.toLocaleString()}</div><div class="kpi-sub">سلة متروكة</div></div>
    `;

    // PIE CHART
    const cats = {};
    state.expenses.forEach(e => { cats[e.cat] = (cats[e.cat] || 0) + (e.amt || 0); });
    const labels = Object.keys(cats), vals = labels.map(l => cats[l]), colors = labels.map((_, i) => CAT_COLORS[i % CAT_COLORS.length]);
    
    const pieLeg = document.getElementById('pieLeg');
    if (pieLeg) {
        pieLeg.innerHTML = labels.map((l, i) => `<span class="leg"><span class="leg-dot" style="background:${colors[i]}"></span>${l}</span>`).join('');
    }
    
    const pieCtx = document.getElementById('pieChart');
    if (pieCtx) {
        if (pieC) pieC.destroy();
        if (labels.length) {
            pieC = new Chart(pieCtx, { type: 'doughnut', data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 1, borderColor: '#0a0c11' }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } });
        }
    }

    // CMP BAR CHART
    const cmpCtx = document.getElementById('cmpChart');
    if (cmpCtx) {
        if (cmpC) cmpC.destroy();
        cmpC = new Chart(cmpCtx, {
            type: 'bar',
            data: {
                labels: [arMonth(CURRENT_MONTH)],
                datasets: [
                    { label: 'مصروفات', data: [expTotal], backgroundColor: '#e05555', borderRadius: 4 },
                    { label: 'إيرادات سلة', data: [sallaTotal], backgroundColor: '#3dba7e', borderRadius: 4 },
                    { label: 'صافي المحفظة', data: [walNet], backgroundColor: '#18B2B0', borderRadius: 4 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#7a80a0' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#7a80a0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } }
                }
            }
        });
    }

    // RECENT ORDERS IN OVERVIEW
    const recent = sallaOrders.slice(0, 8);
    const ovOrders = document.getElementById('ovOrders');
    if (ovOrders) {
        ovOrders.innerHTML = recent.map(o => {
            const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
            const prod = o.items?.[0] || {};
            const st = o.status?.slug || '';
            const stCls = st === 'completed' ? 'pill-green' : st === 'under_review' ? 'pill-accent' : 'pill-amber';
            const thumb = prod.thumbnail ? `<img src="${prod.thumbnail}" class="product-thumb" onerror="this.style.display='none'">` : '';
            return `<tr>
              <td><span class="mono" style="font-size:10px">#${o.reference_id || o.id}</span></td>
              <td><div class="product-chip">${thumb}<span class="product-name">${prod.name || '-'}</span></div></td>
              <td style="font-size:11px;color:var(--text2)">${o.customer?.full_name || '-'}</td>
              <td><span class="mono green">${fmt(amt)}</span></td>
              <td><span class="pill ${stCls}">${o.status?.customized?.name || o.status?.name || st}</span></td>
              <td style="font-size:10px;color:var(--text3)">${(o.date?.date || o.created_at || '').substring(0, 10)}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="6"><div class="empty"><i class="ti ti-inbox"></i><p>جاري مزامنة طلبات سلة المباشرة...</p></div></td></tr>';
    }
}

function updateOverviewWithSalla() {
    if (document.getElementById('page-overview').classList.contains('active')) renderOverview();
}

// ══════════════════════════════════════════════
//  EXPENSES CRUD (SQLITE BACKEND)
// ══════════════════════════════════════════════
function renderExp() {
    const body = document.getElementById('expBody');
    if (!body) return;
    
    const cat = document.getElementById('expCat').value;
    const q = (document.getElementById('expQ').value || '').toLowerCase();
    const sort = document.getElementById('expSort').value;

    let url = `/api/expenses?cat=${cat}&q=${encodeURIComponent(q)}&sort=${sort}`;
    
    fetch(url)
        .then(res => res.json())
        .then(data => {
            const total = data.reduce((s, e) => s + (e.amt || 0), 0);
            document.getElementById('expCount').textContent = `${data.length} بند — ${fmt(total)} ر.س`;
            const ro = !!state.viewingArc || (state.user && state.user.role === 'موظف');

            body.innerHTML = data.map((r, i) => `<tr onclick="showExpenseDetails(${r.id})" style="cursor:pointer;">
            <td style="color:var(--text3);font-size:10px">${i + 1}</td>
            <td style="font-weight:600;">${r.desc}</td>
            <td><span class="pill ${CAT_BADGE[r.cat] || 'pill-gray'}">${r.cat}</span></td>
            <td><span class="mono red">${fmt(r.amt)}</span></td>
            <td style="font-size:11px;color:var(--text2)">${fmtDate(r.date)}</td>
            <td style="font-size:10px;color:var(--text3);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.note || ''}</td>
            <td onclick="event.stopPropagation();">${ro ? '' : `<div style="display:flex;gap:4px">
              <button style="width:24px;height:24px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--text2);cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center" onclick="editRow(${r.id},'expense')"><i class="ti ti-edit"></i></button>
              <button style="width:24px;height:24px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--red);cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center" onclick="delRow(${r.id},'expense')"><i class="ti ti-trash"></i></button>
            </div>`}</td>
          </tr>`).join('') || '<tr><td colspan="7"><div class="empty"><i class="ti ti-inbox"></i><p>لا توجد بنود مصروفات حالياً</p></div></td></tr>';

            document.getElementById('expFoot').innerHTML = data.length ? `<tr class="tbl-foot"><td colspan="3">الإجمالي (${data.length})</td><td><span class="mono red">${fmt(total)}</span></td><td colspan="3"></td></tr>` : '';
        });
}

function openModal(type) {
    if (state.viewingArc) { toast('الشهر مؤرشف للقراءة فقط', 'warn'); return; }
    state.editingId = null;
    state.editingType = type || 'expense';

    document.getElementById('mType').value = state.editingType;
    document.getElementById('mDesc').value = '';
    document.getElementById('mAmt').value = '';
    document.getElementById('mDate').value = TODAY;
    document.getElementById('mNote').value = '';
    document.getElementById('mCat').value = 'رواتب';
    
    document.getElementById('modalTitle').innerHTML = `<i class="ti ti-plus" style="color:var(--accent)"></i> إضافة بند مصروفات`;
    toggleMFields();
    document.getElementById('addModal').classList.add('open');
}

function closeModal() {
    document.getElementById('addModal').classList.remove('open');
}

// دالة عرض تفاصيل البند التشغيلي بنقرة زر في نافذة منبثقة زجاجية
function showExpenseDetails(id) {
    const row = state.expenses.find(e => e.id === id);
    if (!row) return;

    // تعبئة البيانات العامة
    const catBadgeClass = CAT_BADGE[row.cat] || 'pill-gray';
    document.getElementById('dCat').className = `pill ${catBadgeClass}`;
    document.getElementById('dCat').textContent = row.cat;
    document.getElementById('dDate').textContent = fmtDate(row.date);
    document.getElementById('dDesc').textContent = row.desc;
    document.getElementById('dAmt').textContent = fmt(row.amt);
    document.getElementById('dNote').textContent = row.note || 'لا توجد ملاحظات إضافية لهذا البند.';

    const pSec = document.getElementById('dPurchaseSection');
    const mSec = document.getElementById('dMarketingSection');

    // تفعيل الحقول المخصصة للفئات التفصيلية
    if (row.cat === 'شراء منتجات') {
        pSec.style.display = 'block';
        mSec.style.display = 'none';

        document.getElementById('dProductName').textContent = row.product_name || 'غير محدد';
        document.getElementById('dQuantity').textContent = row.quantity ? parseInt(row.quantity).toLocaleString('ar-SA') : '1';
        document.getElementById('dPurchasePrice').textContent = row.purchase_price ? fmt(row.purchase_price) + ' ر.س' : '-';
        document.getElementById('dSellingPrice').textContent = row.selling_price ? fmt(row.selling_price) + ' ر.س' : '-';
    } else if (row.cat === 'تسويق') {
        pSec.style.display = 'none';
        mSec.style.display = 'block';

        document.getElementById('dPlatformName').textContent = row.platform_name || 'غير محدد';
    } else {
        pSec.style.display = 'none';
        mSec.style.display = 'none';
    }

    document.getElementById('detailsModal').classList.add('open');
}

function closeDetailsModal() {
    document.getElementById('detailsModal').classList.remove('open');
}

// دالة فتح نافذة جرد وتسوية المخزون
let currentJardProduct = '';
function openJardModal(productName) {
    if (state.viewingArc) { toast('الشهر مؤرشف للقراءة فقط', 'warn'); return; }
    if (currentUserRole === 'employee') {
        toast('عذراً، ليس لديك صلاحية للقيام بالجرد وتسوية المخزون.', 'error');
        return;
    }
    
    currentJardProduct = productName;
    const nameEl = document.getElementById('jProductName');
    const inputEl = document.getElementById('jProductNameInput');
    const calcRow = document.getElementById('jCalcStockRow');
    const titleEl = document.querySelector('#jardModal .modal-title');
    
    if (productName) {
        // تعديل جرد لمنتج موجود
        titleEl.innerHTML = `<i class="ti ti-box" style="color:var(--accent)"></i> جرد وتسوية مخزون المنتج`;
        nameEl.style.display = 'block';
        inputEl.style.display = 'none';
        nameEl.textContent = productName;
        calcRow.style.display = 'flex';
        
        // حساب المخزون التلقائي الحالي
        let purchased = 0;
        let sold = 0;
        
        state.expenses.forEach(e => {
            if (e.cat === 'شراء منتجات' && e.product_name && e.product_name.trim() === productName) {
                purchased += e.quantity || 0;
            }
        });
        
        sallaOrders.forEach(o => {
            (o.items || []).forEach(it => {
                if ((it.name || '').trim() === productName) {
                    sold += it.quantity || 1;
                }
            });
        });
        
        const calcStock = purchased - sold;
        document.getElementById('jCalcStock').textContent = `${calcStock} قطعة`;
        
        // إيجاد التسوية المخزنة إن وجدت لتعبئة الحقول
        const adj = state.adjustments.find(a => a.product_name === productName) || { stock_offset: 0, cost: 0, price: 0 };
        
        document.getElementById('jStockOffset').value = adj.stock_offset !== 0 ? adj.stock_offset : '';
        document.getElementById('jCost').value = adj.cost > 0 ? adj.cost : '';
        document.getElementById('jPrice').value = adj.price > 0 ? adj.price : '';
    } else {
        // إضافة منتج يدوي جديد بالكامل للمخزون
        titleEl.innerHTML = `<i class="ti ti-plus" style="color:var(--accent)"></i> إضافة منتج جديد للمخزون`;
        nameEl.style.display = 'none';
        inputEl.style.display = 'block';
        inputEl.value = '';
        calcRow.style.display = 'none';
        
        document.getElementById('jStockOffset').value = '';
        document.getElementById('jCost').value = '';
        document.getElementById('jPrice').value = '';
    }
    
    document.getElementById('jardModal').classList.add('open');
}

function closeJardModal() {
    document.getElementById('jardModal').classList.remove('open');
}

async function saveJard() {
    let productName = currentJardProduct;
    if (!productName) {
        productName = document.getElementById('jProductNameInput').value.trim();
    }
    
    if (!productName) {
        toast('يرجى كتابة اسم المنتج بالكامل', 'warn');
        return;
    }
    
    const stockOffset = parseInt(document.getElementById('jStockOffset').value) || 0;
    const cost = parseFloat(document.getElementById('jCost').value) || 0;
    const price = parseFloat(document.getElementById('jPrice').value) || 0;
    
    try {
        const res = await fetch('/api/products/adjustments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                product_name: productName,
                stock_offset: stockOffset,
                cost: cost,
                price: price
            })
        });
        
        const data = await res.json();
        if (data.success) {
            toast('تم حفظ المنتج وتسوية المخزون بنجاح!', 'ok');
            closeJardModal();
            await loadAdjustments();
            renderProducts();
        } else {
            toast('فشل حفظ تسوية المخزون', 'err');
        }
    } catch (e) {
        console.error('خطأ أثناء حفظ الجرد:', e);
        toast('خطأ اتصال بالسيرفر لحفظ الجرد', 'err');
    }
}

function toggleMFields() {
    const type = document.getElementById('mType').value;
    const catGrp = document.getElementById('mCatGrp');
    const cat = document.getElementById('mCat').value;
    
    const pFields = document.getElementById('mPurchaseFields');
    const mFields = document.getElementById('mMarketingFields');
    
    if (type === 'expense') {
        catGrp.style.display = '';
        
        // تبديل الحقول الديناميكية حسب الفئة المحددة
        if (cat === 'شراء منتجات') {
            pFields.style.display = 'block';
            mFields.style.display = 'none';
            populateProductsDropdown();
        } else if (cat === 'تسويق') {
            pFields.style.display = 'none';
            mFields.style.display = 'block';
        } else {
            pFields.style.display = 'none';
            mFields.style.display = 'none';
        }
    } else {
        catGrp.style.display = 'none';
        pFields.style.display = 'none';
        mFields.style.display = 'none';
    }
}

// دالة تفريغ وتعبئة المنتجات في القائمة المنسدلة
function populateProductsDropdown() {
    const sel = document.getElementById('mProductSelect');
    if (!sel) return;

    // تجميع المنتجات الفريدة من قائمة الطلبات والمصروفات
    const productsMap = {};
    sallaOrders.forEach(o => {
        (o.items || []).forEach(it => {
            const name = (it.name || '').trim();
            if (name) productsMap[name] = true;
        });
    });

    state.expenses.forEach(e => {
        if (e.cat === 'شراء منتجات' && e.product_name) {
            const name = e.product_name.trim();
            if (name) productsMap[name] = true;
        }
    });

    const uniqueProducts = Object.keys(productsMap).sort();

    sel.innerHTML = '<option value="">-- اختر المنتج --</option>';
    uniqueProducts.forEach(prod => {
        sel.innerHTML += `<option value="${escapeHtml(prod)}">${escapeHtml(prod)}</option>`;
    });
    sel.innerHTML += '<option value="custom">* منتج مخصص غير مدرج بالقائمة...</option>';
    
    // إخفاء حقل التخصيص بشكل افتراضي عند التغيير
    document.getElementById('mProductCustom').style.display = 'none';
    document.getElementById('mProductCustom').value = '';
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// دالة معالجة إظهار حقل كتابة اسم منتج مخصص
function toggleCustomProductField() {
    const sel = document.getElementById('mProductSelect');
    const customInput = document.getElementById('mProductCustom');
    if (!sel || !customInput) return;
    
    if (sel.value === 'custom') {
        customInput.style.display = 'block';
        customInput.focus();
    } else {
        customInput.style.display = 'none';
    }
}

// دالة الحساب التلقائي لمجموع المشتريات
function recalcPurchaseAmt() {
    const qty = parseInt(document.getElementById('mQuantity').value) || 0;
    const price = parseFloat(document.getElementById('mPurchasePrice').value) || 0;
    const total = qty * price;
    
    document.getElementById('mCalcTotal').textContent = fmt(total);
    // تحديث حقل المبلغ الرئيسي لمساعدة المستخدم
    document.getElementById('mAmt').value = total > 0 ? total.toFixed(2) : '';
}

async function saveRow() {
    const type = document.getElementById('mType').value;
    const desc = document.getElementById('mDesc').value.trim();
    const amt = parseFloat(document.getElementById('mAmt').value);
    const date = document.getElementById('mDate').value;
    const note = document.getElementById('mNote').value.trim();
    const cat = document.getElementById('mCat').value;

    if (!desc || isNaN(amt) || amt <= 0 || !date) {
        toast('يرجى تعبئة كافة الحقول بشكل صحيح', 'warn');
        return;
    }

    // إعداد الحمولة مع الحقول الأساسية
    const payload = { desc, cat: type === 'expense' ? cat : 'أخرى', amt, date, note };
    
    // إضافة الحقول الإضافية إذا كان تصنيف المصروف يتطلب ذلك
    if (type === 'expense' && cat === 'شراء منتجات') {
        const prodSel = document.getElementById('mProductSelect').value;
        payload.product_name = prodSel === 'custom' 
            ? document.getElementById('mProductCustom').value.trim() 
            : prodSel;
        payload.quantity = parseInt(document.getElementById('mQuantity').value) || null;
        payload.purchase_price = parseFloat(document.getElementById('mPurchasePrice').value) || null;
        payload.selling_price = parseFloat(document.getElementById('mSellingPrice').value) || null;
    } else if (type === 'expense' && cat === 'تسويق') {
        payload.platform_name = document.getElementById('mPlatformSelect').value;
    }

    try {
        let response;
        if (state.editingId) {
            // تعديل
            response = await fetch(`/api/expenses/${state.editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            // إضافة جديد
            response = await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        const resData = await response.json();
        if (resData.success) {
            closeModal();
            toast('تم حفظ البند بنجاح', 'ok');
            await loadLocalData();
            renderExp();
            renderOverview();
        } else {
            toast('فشل الحفظ في قاعدة البيانات', 'err');
        }
    } catch (e) {
        console.error('خطأ حفظ المصروف:', e);
        toast('خطأ اتصال بقاعدة البيانات', 'err');
    }
}

async function delRow(id, type) {
    if (state.viewingArc) { toast('الشهر مؤرشف للقراءة فقط', 'warn'); return; }
    if (state.user && state.user.role === 'موظف') { toast('عذراً، لا تملك الصلاحية لحذف المصروفات.', 'warn'); return; }
    if (!confirm('هل أنت متأكد من رغبتك في حذف هذا البند نهائياً؟')) return;

    try {
        const response = await fetch(`/api/expenses/${id}`, {
            method: 'DELETE'
        });
        const resData = await response.json();
        if (resData.success) {
            toast('تم حذف البند بنجاح', 'info');
            await loadLocalData();
            renderExp();
            renderOverview();
        }
    } catch (e) {
        console.error(e);
    }
}

function editRow(id, type) {
    if (state.viewingArc) { toast('الشهر مؤرشف للقراءة فقط', 'warn'); return; }
    if (state.user && state.user.role === 'موظف') { toast('عذراً، لا تملك الصلاحية لتعديل المصروفات.', 'warn'); return; }
    state.editingId = id;
    state.editingType = 'expense';

    const row = state.expenses.find(e => e.id === id);
    if (!row) return;

    document.getElementById('mType').value = 'expense';
    document.getElementById('mDesc').value = row.desc || '';
    document.getElementById('mAmt').value = row.amt || 0;
    document.getElementById('mDate').value = row.date || TODAY;
    document.getElementById('mNote').value = row.note || '';
    document.getElementById('mCat').value = row.cat || 'أخرى';
    
    document.getElementById('modalTitle').innerHTML = `<i class="ti ti-edit" style="color:var(--amber)"></i> تعديل بند المصروفات`;
    
    // تفعيل وتحديث الحقول الديناميكية
    toggleMFields();
    
    // تعبئة الحقول الديناميكية بناءً على الفئة المسترجعة
    if (row.cat === 'شراء منتجات') {
        populateProductsDropdown();
        const sel = document.getElementById('mProductSelect');
        const customInput = document.getElementById('mProductCustom');
        
        let found = false;
        if (row.product_name) {
            for (let opt of sel.options) {
                if (opt.value === row.product_name) {
                    sel.value = row.product_name;
                    found = true;
                    break;
                }
            }
            if (!found) {
                sel.value = 'custom';
                customInput.style.display = 'block';
                customInput.value = row.product_name;
            }
        } else {
            sel.value = '';
        }
        
        document.getElementById('mQuantity').value = row.quantity || '';
        document.getElementById('mPurchasePrice').value = row.purchase_price || '';
        document.getElementById('mSellingPrice').value = row.selling_price || '';
        
        // تحديث المجموع المحسوب المعروض
        const qty = parseInt(row.quantity) || 0;
        const price = parseFloat(row.purchase_price) || 0;
        document.getElementById('mCalcTotal').textContent = fmt(qty * price);
    } else if (row.cat === 'تسويق') {
        if (row.platform_name) {
            document.getElementById('mPlatformSelect').value = row.platform_name;
        }
    }
    
    document.getElementById('addModal').classList.add('open');
}

// قطع ربط متجر سلة وتسجيل الخروج
async function disconnectSallaStore() {
    if (!confirm('هل تريد فعلاً قطع الربط بمتجر سلة؟ لن تتمكن من تتبع طلباتك المباشرة بعد الآن.')) return;
    try {
        const res = await fetch('/api/salla/disconnect');
        const data = await res.json();
        if (data.success) {
            toast('تم قطع الارتباط بالمتجر بنجاح', 'ok');
            setTimeout(() => window.location.href = '/login.html', 1000);
        }
    } catch (e) {
        toast('خطأ في إرسال طلب تسجيل الخروج', 'err');
    }
}

// ══════════════════════════════════════════════
//  CSV & EXCEL EXPORTS
// ══════════════════════════════════════════════
function exportAll() {
    const rows = [['النوع', 'البيان', 'الفئة', 'المبلغ (ر.س)', 'التاريخ', 'ملاحظة']];
    state.expenses.forEach(e => rows.push(['مصروف', e.desc, e.cat, e.amt, e.date, e.note || '']));
    dlCSV(rows, `محاسبة_شوب_ستور_${state.viewingArc || CURRENT_MONTH}.csv`);
}

function exportOrdCSV() {
    const rows = [['المرجع', 'المنتج', 'العميل', 'الإجمالي (ر.س)', 'طريقة الدفع', 'الحالة', 'التاريخ']];
    sallaOrders.forEach(o => {
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
        rows.push([o.reference_id, o.items?.[0]?.name || '', o.customer?.full_name || '', amt, o.payment_method, o.status?.name || '', (o.date?.date || o.created_at || '').substring(0, 10)]);
    });
    dlCSV(rows, `طلبات_سلة_${TODAY}.csv`);
}

function dlCSV(rows, fname) {
    const csv = '\uFEFF' + rows.map(r => r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = fname;
    a.click();
    toast('تم تصدير الملف بنجاح', 'ok');
}

// ══════════════════════════════════════════════
//  EXCEL IMPORT OPERATIONS
// ══════════════════════════════════════════════
function readXLSX(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = e => {
            try {
                const wb = XLSX.read(e.target.result, { type: 'binary', cellDates: true });
                const ws = wb.Sheets[wb.SheetNames[0]];
                resolve(XLSX.utils.sheet_to_json(ws, { defval: '' }));
            } catch (err) { reject(err); }
        };
        r.onerror = reject; r.readAsBinaryString(file);
    });
}

async function handleImport(ev, type) {
    const file = ev.target.files[0];
    if (!file) return;
    
    const resElPrimary = document.getElementById('ir-' + type);
    const resElPage = document.getElementById('ir-wallet-page');
    
    // كائن ذكي يقوم بتحديث كلي المؤشرين بالتزامن عند استدعائه
    const resEl = {
        set textContent(val) {
            if (resElPrimary) resElPrimary.textContent = val;
            if (type === 'wallet' && resElPage) resElPage.textContent = val;
        },
        set innerHTML(val) {
            if (resElPrimary) resElPrimary.innerHTML = val;
            if (type === 'wallet' && resElPage) resElPage.innerHTML = val;
        }
    };
    
    resEl.textContent = 'جاري المعالجة وإضافة البنود...';

    try {
        const rows = await readXLSX(file);
        let count = 0;
        
        if (type === 'expense') {
            for (let r of rows) {
                const desc = String(r['البيان'] || r['الوصف'] || Object.values(r)[0] || '');
                const amt = parseFloat(r['المبلغ'] || Object.values(r)[1] || 0);
                const cat = String(r['الفئة'] || 'أخرى');
                const date = String(r['التاريخ'] || TODAY);
                const note = String(r['ملاحظة'] || '');

                if (desc && amt > 0) {
                    await fetch('/api/expenses', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ desc, cat, amt, date, note })
                    });
                    count++;
                }
            }
            
            resEl.innerHTML = `<span style="color:var(--green)">✓ تم استيراد ${count} بند مصروفات إلى قاعدة البيانات بنجاح</span>`;
            toast(`استيراد ${count} مصروف بنجاح`, 'ok');
            await loadLocalData();
            renderExp();
            renderOverview();
        } else if (type === 'sales') {
            const parsedOrders = [];
            const getValue = (row, keys) => {
                for (let k of keys) {
                    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
                }
                for (let actualKey in row) {
                    for (let k of keys) {
                        const trimmedActual = actualKey.trim().replace(/\s+/g, ' ');
                        const trimmedK = k.trim().replace(/\s+/g, ' ');
                        if (trimmedActual.includes(trimmedK)) return row[actualKey];
                    }
                }
                return '';
            };

            // تحديد ما إذا كان الملف هو "تقرير أداء المنتجات" (ملخص مبيعات كل منتج) 
            // وليس "تقرير الطلبات التفصيلي" (حيث لا توجد أرقام طلبات فردية وتواريخ)
            const sampleRow = rows[0] || {};
            const hasRef = getValue(sampleRow, ['رقم الطلب', 'رقم المرجع', 'المرجع', 'reference_id', 'order_id', 'id', 'Order ID']);
            const hasProd = getValue(sampleRow, ['المنتج', 'اسم المنتج', 'product_name', 'Product']);
            const isProductReport = !hasRef && hasProd;

            if (isProductReport) {
                toast('تم اكتشاف ملف تقرير مبيعات المنتجات! جاري توليد بيانات مبيعات متكاملة...', 'info');
                let idx = 1;
                for (let r of rows) {
                    const prodName = String(getValue(r, ['المنتج', 'اسم المنتج', 'product_name', 'Product'])).trim();
                    const sku = String(getValue(r, ['SKU', 'رمز المنتج']) || '').trim();
                    const quantity = parseInt(getValue(r, ['الكمية المباعة', 'الكمية', 'العدد', 'quantity', 'qty', 'Quantity']) || 1);
                    // نفضل "إجمالي المبيعات (ر.س)" أو "صافي المبيعات"
                    let amount = parseFloat(getValue(r, ['إجمالي المبيعات (ر.س)', 'إجمالي المبيعات', 'صافي المبيعات', 'المبيعات', 'المبلغ', 'total', 'amount', 'price', 'Total Sales']) || 0);

                    if (prodName && amount > 0) {
                        // توليد رقم مرجعي فريد لكل منتج لمنع تصادم المفاتيح
                        const refId = `V-${sku || Math.random().toString(36).substring(2, 6).toUpperCase()}-${idx++}`;
                        
                        parsedOrders.push({
                            reference_id: refId,
                            date: TODAY, // نضع تاريخ اليوم ليتطابق مع نطاق البحث الافتراضي
                            status_slug: 'completed',
                            status_name: 'تم التنفيذ',
                            payment_method: 'mada',
                            amount: amount,
                            customer_name: 'مبيعات إكسل (تقرير المنتجات)',
                            product_name: prodName,
                            product_thumbnail: '',
                            quantity: quantity
                        });
                    }
                }
            } else {
                // تقرير الطلبات التفصيلي المعتاد
                for (let r of rows) {
                    const refId = String(getValue(r, ['رقم الطلب', 'رقم المرجع', 'المرجع', 'reference_id', 'order_id', 'id', 'Order ID'])).trim();
                    let dateRaw = getValue(r, ['تاريخ الطلب', 'تاريخ المبيعة', 'التاريخ', 'date', 'created_at', 'Order Date', 'Date']);
                    let amount = parseFloat(getValue(r, ['إجمالي الطلب', 'إجمالي المبيعات', 'المبلغ', 'السعر', 'صافي المبيعات', 'total', 'amount', 'price', 'Net Sales', 'Total']) || 0);
                    const custName = String(getValue(r, ['اسم العميل', 'العميل', 'customer', 'customer_name', 'Customer Name']) || 'عميل خارجي').trim();
                    const prodName = String(getValue(r, ['اسم المنتج', 'المنتج', 'المنتجات', 'product_name', 'items', 'Products', 'Product']) || 'منتج مستورد').trim();
                    const payMethod = String(getValue(r, ['طريقة الدفع', 'الدفع', 'payment_method', 'Payment Method']) || 'mada').trim();
                    const statusName = String(getValue(r, ['حالة الطلب', 'الحالة', 'status', 'Order Status']) || 'تم التنفيذ').trim();
                    const quantity = parseInt(getValue(r, ['الكمية', 'العدد', 'quantity', 'qty', 'Quantity']) || 1);

                    if (refId && amount > 0) {
                        let dateStr = TODAY;
                        if (dateRaw) {
                            if (dateRaw instanceof Date) {
                                dateStr = dateRaw.toISOString().split('T')[0];
                            } else {
                                dateStr = String(dateRaw).substring(0, 10);
                            }
                        }

                        let statusSlug = 'completed';
                        if (statusName.includes('معلق') || statusName.includes('بانتظار الدفع') || statusName.includes('pending')) {
                            statusSlug = 'payment_pending';
                        } else if (statusName.includes('مراجعة') || statusName.includes('review')) {
                            statusSlug = 'under_review';
                        }

                        let paySlug = 'mada';
                        const lowerPay = payMethod.toLowerCase();
                        if (lowerPay.includes('apple') || lowerPay.includes('آبل')) paySlug = 'apple_pay';
                        else if (lowerPay.includes('stc') || lowerPay.includes('اس تي سي')) paySlug = 'stc_pay';
                        else if (lowerPay.includes('credit') || lowerPay.includes('بطاقة') || lowerPay.includes('فيزا') || lowerPay.includes('visa') || lowerPay.includes('master')) paySlug = 'credit_card';
                        else if (lowerPay.includes('cod') || lowerPay.includes('عند الاستلام')) paySlug = 'cod';
                        else if (lowerPay.includes('انتظار')) paySlug = 'waiting';

                        parsedOrders.push({
                            reference_id: refId,
                            date: dateStr,
                            status_slug: statusSlug,
                            status_name: statusName,
                            payment_method: paySlug,
                            amount: amount,
                            customer_name: custName,
                            product_name: prodName,
                            product_thumbnail: '',
                            quantity: quantity
                        });
                    }
                }
            }

            if (parsedOrders.length > 0) {
                const response = await fetch('/api/salla/imported-orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orders: parsedOrders })
                });

                const resData = await response.json();
                if (resData.success) {
                    resEl.innerHTML = `<span style="color:var(--green)">✓ تم استيراد ${resData.count} مبيعة بنجاح وحفظها في قاعدة البيانات SQLite!</span>`;
                    toast(`استيراد ${resData.count} مبيعة بنجاح`, 'ok');
                    
                    await updateDBStatus();
                    await loadOrders(true);
                    nav('overview');
                } else {
                    resEl.innerHTML = `<span style="color:var(--red)">فشل استيراد المبيعات لقاعدة البيانات</span>`;
                }
            } else {
                resEl.innerHTML = `<span style="color:var(--amber)">⚠️ لم يتم العثور على مبيعات صالحة بالملف (تأكد من وجود الأعمدة: رقم الطلب، المبلغ، التاريخ أو تقرير أداء المنتجات مع أعمدة المنتج وإجمالي المبيعات)</span>`;
            }
        } else if (type === 'wallet') {
            const parsedTransactions = [];
            const getValue = (row, keys) => {
                for (let k of keys) {
                    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
                }
                for (let actualKey in row) {
                    for (let k of keys) {
                        const trimmedActual = actualKey.trim().replace(/\s+/g, ' ');
                        const trimmedK = k.trim().replace(/\s+/g, ' ');
                        if (trimmedActual.includes(trimmedK)) return row[actualKey];
                    }
                }
                return '';
            };

            for (let r of rows) {
                const refId = String(getValue(r, ['رقم العملية', 'رقم الحركة', 'المرجع', 'reference_id', 'Transaction ID', 'id'])).trim();
                const totalAmt = parseFloat(getValue(r, ['المبلغ الإجمالي', 'المبلغ', 'amount', 'Total Amount']) || 0);
                const commAmt = parseFloat(getValue(r, ['مبلغ العمولة', 'العمولة', 'commission', 'Commission']) || 0);
                const netAmt = parseFloat(getValue(r, ['المبلغ المستحق بدون الضريبة', 'المبلغ المستحق', 'الصافي المستحق', 'الصافي', 'net', 'Net Amount']) || (totalAmt - commAmt));
                const taxAmt = parseFloat(getValue(r, ['رسوم الضريبة', 'الضريبة', 'tax', 'Tax']) || 0);
                let dateRaw = getValue(r, ['تاريخ الاستحقاق', 'تاريخ العملية', 'التاريخ', 'date', 'Date']);
                const statusStr = String(getValue(r, ['الحالة', 'status', 'Status']) || 'مدفوعة').trim();

                if (refId && totalAmt > 0) {
                    let dateStr = TODAY;
                    if (dateRaw) {
                        if (dateRaw instanceof Date) {
                            dateStr = dateRaw.toISOString().split('T')[0];
                        } else {
                            dateStr = String(dateRaw).substring(0, 10);
                        }
                    }

                    parsedTransactions.push({
                        reference_id: refId,
                        amount: totalAmt,
                        commission: commAmt,
                        net: netAmt,
                        tax: taxAmt,
                        date: dateStr,
                        status: statusStr,
                        note: ''
                    });
                }
            }

            if (parsedTransactions.length > 0) {
                const response = await fetch('/api/salla/imported-wallet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transactions: parsedTransactions })
                });

                const resData = await response.json();
                if (resData.success) {
                    resEl.innerHTML = `<span style="color:var(--green)">✓ تم استيراد ${resData.count} تسوية محفظة بنجاح وحفظها في قاعدة البيانات SQLite!</span>`;
                    toast(`استيراد ${resData.count} تسوية محفظة بنجاح`, 'ok');
                    
                    await updateDBStatus();
                    await renderWallet();
                    nav('salla-wallet');
                } else {
                    resEl.innerHTML = `<span style="color:var(--red)">فشل حفظ التسويات في قاعدة البيانات</span>`;
                }
            } else {
                resEl.innerHTML = `<span style="color:var(--amber)">⚠️ لم يتم العثور على تسويات صالحة بالملف (تأكد من وجود أعمدة: رقم العملية، المبلغ الإجمالي، تاريخ الاستحقاق)</span>`;
            }
        } else if (type === 'products') {
            const parsedProducts = [];
            const getValue = (row, keys) => {
                for (let k of keys) {
                    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
                }
                for (let actualKey in row) {
                    for (let k of keys) {
                        const trimmedActual = actualKey.trim().replace(/\s+/g, ' ');
                        const trimmedK = k.trim().replace(/\s+/g, ' ');
                        if (trimmedActual.includes(trimmedK)) return row[actualKey];
                    }
                }
                return '';
            };

            for (let r of rows) {
                const prodName = String(getValue(r, ['اسم المنتج', 'المنتج', 'Product Name', 'Product', 'name'])).trim();
                const stockOffset = parseInt(getValue(r, ['الكمية الافتتاحية', 'المخزون الافتتاحي', 'الكمية', 'المخزون', 'Quantity', 'Stock', 'Initial Stock', 'qty'])) || 0;
                const cost = parseFloat(getValue(r, ['سعر التكلفة', 'سعر الشراء', 'التكلفة', 'Cost', 'Purchase Cost', 'purchase_price'])) || 0;
                const price = parseFloat(getValue(r, ['سعر البيع', 'سعر البيع المقدر', 'البيع', 'Price', 'Selling Price', 'selling_price'])) || 0;

                if (prodName) {
                    parsedProducts.push({
                        product_name: prodName,
                        stock_offset: stockOffset,
                        cost: cost,
                        price: price
                    });
                }
            }

            if (parsedProducts.length > 0) {
                const response = await fetch('/api/products/adjustments/bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ products: parsedProducts })
                });

                const resData = await response.json();
                if (resData.success) {
                    resEl.innerHTML = `<span style="color:var(--green)">✓ تم استيراد ${resData.count} منتج بنجاح وحفظها في قاعدة البيانات SQLite!</span>`;
                    toast(`استيراد ${resData.count} منتج بنجاح`, 'ok');
                    
                    await loadAdjustments();
                    renderProducts();
                    nav('salla-products');
                } else {
                    resEl.innerHTML = `<span style="color:var(--red)">فشل استيراد المنتجات لقاعدة البيانات</span>`;
                }
            } else {
                resEl.innerHTML = `<span style="color:var(--amber)">⚠️ لم يتم العثور على منتجات صالحة بالملف (تأكد من وجود عمود: اسم المنتج)</span>`;
            }
        }
    } catch (e) {
        resEl.innerHTML = `<span style="color:var(--red)">خطأ: ${e.message}</span>`;
        toast('فشل استيراد الملف', 'err');
    }
    ev.target.value = '';
}

async function clearImportedData() {
    if (!confirm('هل أنت متأكد من رغبتك في حذف جميع مبيعات سلة المستوردة من إكسل؟ لا يمكن التراجع عن هذه الخطوة.')) return;
    
    try {
        const response = await fetch('/api/salla/clear-imports', {
            method: 'POST'
        });
        const resData = await response.json();
        if (resData.success) {
            toast('تم تفريغ مبيعات إكسل المستوردة بالكامل!', 'info');
            await updateDBStatus();
            await loadOrders(true);
            renderOverview();
        } else {
            toast('فشل مسح البيانات المستوردة', 'err');
        }
    } catch (e) {
        console.error(e);
        toast('خطأ في الاتصال بالسيرفر لتصفير البيانات', 'err');
    }
}

async function clearWalletImportedData() {
    if (!confirm('هل أنت متأكد من رغبتك في حذف جميع تسويات المحفظة المستوردة من إكسل؟ لا يمكن التراجع عن هذه الخطوة.')) return;
    
    try {
        const response = await fetch('/api/salla/clear-wallet-imports', {
            method: 'POST'
        });
        const resData = await response.json();
        if (resData.success) {
            toast('تم تفريغ تسويات المحفظة المستوردة بالكامل!', 'info');
            await updateDBStatus();
            await renderWallet();
            renderOverview();
        } else {
            toast('فشل مسح بيانات المحفظة المستوردة', 'err');
        }
    } catch (e) {
        console.error(e);
        toast('خطأ في الاتصال بالسيرفر لتصفير المحفظة', 'err');
    }
}

// دالة التحكم في عرض مربع استيراد المحفظة في صفحة كشف المحفظة
function toggleWalletImportBox() {
    const box = document.getElementById('walletImportBox');
    if (!box) return;
    if (box.style.display === 'none') {
        box.style.display = 'block';
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
        box.style.display = 'none';
        const resPageEl = document.getElementById('ir-wallet-page');
        if (resPageEl) resPageEl.innerHTML = '';
    }
}

// ══════════════════════════════════════════════
//  DRAG & DROP EVENTS FOR IMPORT
// ══════════════════════════════════════════════
function setupDragAndDrop() {
    const list = [
        { id: 'iz-sales', type: 'sales' },
        { id: 'iz-wallet', type: 'wallet' },
        { id: 'iz-wallet-page', type: 'wallet' },
        { id: 'iz-exp', type: 'expense' },
        { id: 'iz-products', type: 'products' }
    ];
    
    list.forEach(item => {
        const el = document.getElementById(item.id);
        if (!el) return;
        el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
        el.addEventListener('dragleave', () => el.classList.remove('over'));
        el.addEventListener('drop', e => {
            e.preventDefault(); el.classList.remove('over');
            const f = e.dataTransfer.files[0];
            if (f) handleImport({ target: { files: [f], value: '' } }, item.type);
        });
    });
}

// ══════════════════════════════════════════════
//  إدارة المستخدمين
// ══════════════════════════════════════════════

let currentEditUserId = '';

async function loadUsers() {
    if (currentUserRole === 'employee') return; // Employees cannot view users

    try {
        const res = await fetch('/api/users');
        if (!res.ok) throw new Error('فشل جلب المستخدمين');
        const users = await res.json();
        renderUsers(users);
    } catch (e) {
        toast(e.message, 'error');
    }
}

function renderUsers(users) {
    const tbody = document.getElementById('usersTbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    users.forEach(user => {
        const tr = document.createElement('tr');
        const isSelf = user.username === currentUsername;
        const roleLabel = user.role === 'admin' ? 'مدير' : user.role === 'accountant' ? 'محاسب' : 'موظف';
        const roleColor = user.role === 'admin' ? 'var(--blue)' : user.role === 'accountant' ? 'var(--amber)' : 'var(--accent)';
        
        tr.innerHTML = `
            <td>${user.id}</td>
            <td>${user.username}</td>
            <td>${user.email || '-'}</td>
            <td><span style="color: ${roleColor}; border: 1px solid ${roleColor}33; background: ${roleColor}11; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${roleLabel}</span></td>
            <td>${user.created_at || '-'}</td>
            <td>
                <button class="btn btn-sm" onclick="openUserModal('${user.id}', '${user.username}', '${user.role}', '${user.email || ''}')"><i class="ti ti-edit"></i> تعديل</button>
                <button class="btn btn-sm" style="color: var(--red); border-color: rgba(224,85,85,0.2); background: transparent" onclick="deleteUser('${user.id}')" ${isSelf ? 'disabled' : ''}><i class="ti ti-trash"></i> حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openUserModal(id = '', username = '', role = 'employee', email = '') {
    currentEditUserId = id;
    document.getElementById('uUsername').value = username;
    document.getElementById('uEmail').value = email;
    document.getElementById('uPassword').value = ''; // empty means do not change if editing
    document.getElementById('uRole').value = role;
    
    const title = document.querySelector('#userModal .modal-title');
    if (id) {
        title.innerHTML = '<i class="ti ti-user-edit" style="color:var(--accent)"></i> تعديل مستخدم';
        document.getElementById('uPassword').placeholder = "اتركه فارغاً للاحتفاظ بكلمة المرور الحالية";
    } else {
        title.innerHTML = '<i class="ti ti-user-plus" style="color:var(--accent)"></i> إضافة مستخدم جديد';
        document.getElementById('uPassword').placeholder = "كلمة المرور";
    }
    
    document.getElementById('userModal').classList.add('open');
}

function closeUserModal() {
    document.getElementById('userModal').classList.remove('open');
}

async function saveUser() {
    const username = document.getElementById('uUsername').value.trim();
    const email = document.getElementById('uEmail').value.trim();
    const password = document.getElementById('uPassword').value;
    const role = document.getElementById('uRole').value;
    
    if (!username) {
        toast('الرجاء إدخال اسم المستخدم', 'error');
        return;
    }
    
    if (!email) {
        toast('الرجاء إدخال البريد الإلكتروني', 'error');
        return;
    }
    
    if (!currentEditUserId && !password) {
        toast('الرجاء إدخال كلمة المرور للمستخدم الجديد', 'error');
        return;
    }
    
    const url = currentEditUserId ? `/api/users/${currentEditUserId}` : '/api/users';
    const method = currentEditUserId ? 'PUT' : 'POST';
    
    const body = { username, email, role };
    if (password) body.password = password;
    
    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'فشل حفظ المستخدم');
        }
        
        toast('تم الحفظ بنجاح', 'success');
        closeUserModal();
        loadUsers();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deleteUser(id) {
    if (!confirm('هل أنت متأكد من حذف هذا المستخدم؟')) return;
    
    try {
        const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('فشل الحذف');
        
        toast('تم حذف المستخدم', 'success');
        loadUsers();
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ══════════════════════════════════════════════
//  DOCUMENT INITIALIZATION
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    const ordTo = document.getElementById('ordTo');
    const walTo = document.getElementById('walTo');
    if (ordTo) ordTo.value = TODAY;
    if (walTo) walTo.value = TODAY;

    init();
    setupDragAndDrop();

    // إغلاق النوافذ عند الضغط خارجها
    ['addModal', 'archModal', 'detailsModal', 'jardModal', 'userModal'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', e => {
            if (e.target === el) el.classList.remove('open');
        });
    });
});
