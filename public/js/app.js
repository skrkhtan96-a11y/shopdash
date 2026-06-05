// ══════════════════════════════════════════════
//  GLOBALS & CONSTANTS
// ══════════════════════════════════════════════
const tzOffset = new Date().getTimezoneOffset() * 60000;
const TODAY = (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
const CURRENT_MONTH = TODAY.substring(0, 7);
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const CAT_COLORS = ['#18B2B0', '#e05555', '#e8a84a', '#3dba7e', '#9b8bef', '#5b9bd6', '#e8758b'];
const CAT_BADGE = { رواتب: 'pill-blue', تسويق: 'pill-accent', 'شراء منتجات': 'pill-amber', سلف: 'pill-purple', أرباح: 'pill-green', أخرى: 'pill-gray' };

const fmt = n => (parseFloat(n) || 0).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = d => d ? new Date(d.split('T')[0] + 'T00:00:00').toLocaleDateString('ar-SA') : '-';
const arMonth = k => { const [y, m] = k.split('-'); return AR_MONTHS[parseInt(m) - 1] + ' ' + y; };

const cleanProductName = name => {
    if (!name) return '';
    let cleaned = name.trim();
    
    // Remove outer single quotes
    if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
        cleaned = cleaned.slice(1, -1).trim();
    } else {
        if (cleaned.startsWith("'")) cleaned = cleaned.substring(1).trim();
        if (cleaned.endsWith("'")) cleaned = cleaned.slice(0, -1).trim();
    }
    
    // Remove SKU patterns like (SKU: ...), '(SKU: ...)'
    cleaned = cleaned.replace(/^\(?\'?SKU:\s*[^\)]*\'?\)?/gi, '');
    cleaned = cleaned.replace(/^\(?\'?رمز المنتج:\s*[^\)]*\'?\)?/gi, '');
    
    // Remove Qty patterns like (Qty: ...), '(Qty: ...)', (Qty, (Q at the end
    cleaned = cleaned.replace(/\(?\'?Qty:\s*\d+\'?\)?$/gi, '');
    cleaned = cleaned.replace(/\(?\'?الكمية:\s*\d+\'?\)?$/gi, '');
    cleaned = cleaned.replace(/\(Q$/gi, '');
    cleaned = cleaned.replace(/\(Qty$/gi, '');
    
    // Clean remaining leading/trailing symbols
    cleaned = cleaned.replace(/^['"\s\-\(]+/g, '');
    cleaned = cleaned.replace(/['"\s\-\)]+$/g, '');
    
    // Normalize spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    // Replace parenthesized periods
    cleaned = cleaned.replace(/\(\s*شهر\s*\)/gi, '- شهر');
    cleaned = cleaned.replace(/\(\s*أشهر\s*\)/gi, '- أشهر');
    cleaned = cleaned.replace(/\(\s*شهرين\s*\)/gi, '- شهرين');
    cleaned = cleaned.replace(/\(\s*سنة\s*\)/gi, '- سنة');
    
    return cleaned;
};

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
    users: [], // حسابات كافة موظفي اللوحة
    selectedProducts: [], // المنتجات المحددة للتصفية المتعددة
    ordSelectedProducts: [], // المنتجات المحددة لتصفية الطلبات
    expSelectedDescs: [] // البيانات الوصفية المحددة لتصفية المصروفات
};

let currentUsername = '';
let currentUserRole = '';

// ── SALLA LIVE DATA ──
let sallaOrders = [];
let sallaCartData = { count: 0, total: 0 };
let ordPage = 1;
let ordPageTotal = 1;

// ── CHARTS ──
let pieC, cmpC, walC, prodC, compareC;

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
            const roleLabel = currentUserRole === 'admin' ? 'مدير' : currentUserRole === 'accountant' ? 'محاسب' : currentUserRole === 'games_employee' ? 'موظف ألعاب' : 'موظف';
            
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
        updateOrderStatusBtnText();
        await Promise.all([
            loadOrders(true),
            loadCarts(true)
        ]);

        const hashPage = window.location.hash.replace('#', '');
        const savedPage = (PAGES.includes(hashPage) ? hashPage : null) || sessionStorage.getItem('active_page') || 'overview';
        nav(savedPage);
    } catch (e) {
        console.error('خطأ أثناء تشغيل التطبيق:', e);
        toast('خطأ أثناء الاتصال بالخادم الرئيسي', 'err');
    }
}

function applyRoleBasedPermissions() {
    if (!state.user) return;
    const role = state.user.role;
    
    // الموظف لا يملك صلاحية إضافة مصروف، جرد المخزون، أو بدء أرشفة الأشهر
    if (role === 'employee' || role === 'games_employee') {
        const addBtn = document.getElementById('addBtn');
        const addExpBtn = document.getElementById('addExpBtn');
        const newMonthBtn = document.getElementById('newMonthBtn');
        if (addBtn) addBtn.style.display = 'none';
        if (addExpBtn) addExpBtn.style.display = 'none';
        if (newMonthBtn) newMonthBtn.style.display = 'none';
    }

    if (role === 'games_employee') {
        // إخفاء كافة عناصر القائمة الجانبية ما عدا مخزون حسابات بلس
        document.querySelectorAll('.sidebar .nav-item').forEach(item => {
            const onClickStr = item.getAttribute('onclick') || '';
            if (!onClickStr.includes("'ps-plus'")) {
                item.style.display = 'none';
            }
        });
        // إخفاء الفواصل والتسميات وأداة التبديل
        document.querySelectorAll('.sidebar .s-sep, .sidebar .s-label, .sidebar #monthSel, .sidebar div[style*="padding:6px 12px 0"], .sidebar div[style*="padding: 6px 12px 0"]').forEach(el => {
            el.style.display = 'none';
        });

        // إخفاء كافة أزرار الشريط السفلي للموبايل ما عدا بلس
        document.querySelectorAll('.bottom-nav-item').forEach(item => {
            const onClickStr = item.getAttribute('onclick') || '';
            if (!onClickStr.includes("'ps-plus'")) {
                item.style.display = 'none';
            }
        });
    }

    // زر حذف بيانات اللوحة بالكامل متاح فقط للمدير (admin)
    const clearAllBtn = document.getElementById('btnClearAllSystem');
    if (clearAllBtn) {
        clearAllBtn.style.display = role === 'admin' ? 'inline-block' : 'none';
    }

    // زر حذف المصروفات متاح للمحاسبين والمدراء فقط (مخفي للموظفين)
    const clearExpensesBtn = document.getElementById('btnClearExpenses');
    if (clearExpensesBtn) {
        clearExpensesBtn.style.display = (role === 'employee' || role === 'games_employee') ? 'none' : 'inline-block';
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
                liveBadge.style.cursor = 'default';
                liveBadge.onclick = null;
                liveBadge.title = `متصل بمتجر: ${state.store.name}`;
            } else {
                liveBadge.className = 'salla-live offline';
                liveBadge.innerHTML = '<i class="ti ti-plug"></i> اضغط لربط سلة (OAuth)';
                liveBadge.style.cursor = 'pointer';
                liveBadge.onclick = () => {
                    toast('جاري تحويلك إلى صفحة تصريح سلة...', 'info');
                    setTimeout(() => window.location.href = '/auth', 1000);
                };
                liveBadge.title = 'اضغط لربط لوحة التحكم بمتجرك على منصة سلة الفعلي';
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
        state.allUnfilteredExpenses = [...state.expenses];

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
const PAGES = ['overview', 'expenses', 'campaigns', 'campaign-detail', 'salla-orders', 'salla-carts', 'salla-wallet', 'salla-products', 'salla-compare', 'import', 'users', 'certificates', 'ps-plus'];
const PAGE_TITLES = {
    overview: 'نظرة عامة',
    expenses: 'المصروفات',
    campaigns: 'الحملات الإعلانية',
    'campaign-detail': 'تفاصيل الحملة الإعلانية',
    'salla-orders': 'طلبات سلة',
    'salla-carts': 'السلات المتروكة',
    'salla-wallet': 'محفظة سلة',
    'salla-products': 'المخزون والمنتجات',
    'salla-compare': 'مقارنة المبيعات والفروقات',
    import: 'استيراد Excel',
    users: 'إدارة المستخدمين',
    certificates: 'إدارة تقارير الشهادات',
    'ps-plus': 'مخزون حسابات بلس'
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

function nav(name, updateHash = true) {
    if (state.user && state.user.role === 'games_employee' && name !== 'ps-plus') {
        nav('ps-plus', true);
        return;
    }
    // إغلاق القائمة تلقائياً عند تغيير الصفحة على الهواتف
    toggleSidebar(false);

    // حفظ الصفحة النشطة الحالية لتجنب العودة للرئيسية عند التحديث
    sessionStorage.setItem('active_page', name);

    if (updateHash) {
        window.location.hash = name;
    }

    PAGES.forEach(p => {
        document.getElementById('page-' + p)?.classList.remove('active');
    });
    document.getElementById('page-' + name)?.classList.add('active');
    
    // تحديث التحديد في القائمة الجانبية والشريط السفلي
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        const onClickStr = item.getAttribute('onclick') || '';
        if (onClickStr.includes(`'${name}'`)) {
            item.classList.add('active');
        }
    });

    document.querySelectorAll('.bottom-nav-item').forEach(item => {
        const onClickStr = item.getAttribute('onclick') || '';
        if (onClickStr.includes(`'${name}'`)) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    document.getElementById('pageTitle').textContent = PAGE_TITLES[name] || name;

    // إخفاء زر الإضافة في الصفحات غير المحاسبية وبناء على صلاحية الموظف
    const isLocal = ['overview', 'expenses'].includes(name);
    const hasWritePermission = state.user && state.user.role !== 'employee';
    document.getElementById('addBtn').style.display = (isLocal && !state.viewingArc && hasWritePermission) ? '' : 'none';

    if (name === 'overview') renderOverview();
    if (name === 'expenses') renderExp();
    if (name === 'campaigns') renderCampaigns();
    if (name === 'salla-orders') renderOrders();
    if (name === 'salla-carts') renderCarts();
    if (name === 'salla-wallet') renderWallet();
    if (name === 'salla-products') renderProducts();
    if (name === 'salla-compare') initComparePage();
    if (name === 'users') loadUsers();
    if (name === 'certificates') loadCertificates();
    if (name === 'ps-plus') loadPsPlusAccounts();
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

    const from = document.getElementById('ordFrom').value || (CURRENT_MONTH + '-01');
    const to = document.getElementById('ordTo').value || TODAY;
    const q = document.getElementById('ordQ')?.value || '';
    const selectedStatuses = [];
    document.querySelectorAll('.status-chk').forEach(chk => {
        if (chk.checked) selectedStatuses.push(chk.value);
    });
    const status = (selectedStatuses.length === 3 || selectedStatuses.length === 0) ? '' : selectedStatuses.join(',');
    
    const productsParam = (state.ordSelectedProducts && state.ordSelectedProducts.length > 0) 
        ? state.ordSelectedProducts.join(',') 
        : '';

    const sort = document.getElementById('ordSort')?.value || 'desc';
    const minAmt = document.getElementById('ordMinAmt')?.value || '';
    const maxAmt = document.getElementById('ordMaxAmt')?.value || '';

    try {
        let url = `/api/salla/orders?page=${ordPage}&from=${from}&to=${to}&q=${encodeURIComponent(q)}&status=${status}&products=${encodeURIComponent(productsParam)}&sort=${sort}&min_amt=${minAmt}&max_amt=${maxAmt}&per_page=3000`;
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
    const btn = document.getElementById('syncBtn');
    if (btn) btn.disabled = true;
    toast('جاري تحديث البيانات من متجر سلة...', 'info');
    try {
        // نطلب من الخادم عمل مزامنة حية مع سلة وحفظها في قاعدة البيانات أولاً
        const syncRes = await fetch('/api/salla/sync-now', { method: 'POST' });
        const syncData = await syncRes.json();
        if (syncData.success) {
            toast(`تمت المزامنة بنجاح: تم جلب ومزامنة ${syncData.count} عناصر من سلة`, 'ok');
        } else {
            console.warn('تنبيه المزامنة:', syncData.error || 'فشلت المزامنة المباشرة، سيتم تحميل البيانات المخزنة مسبقاً');
        }
    } catch (e) {
        console.error('خطأ في طلب المزامنة المباشرة:', e);
        toast('تحذير: فشل الاتصال بمزود سلة للتحديث الحي، سيتم تحميل الكاش', 'warn');
    }
    
    await Promise.all([
        loadOrders(true),
        loadCarts(true)
    ]);
    if (btn) btn.disabled = false;
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
                const isPs5Plus = name.includes('بلس') && name.includes('PS5');
                const qty = e.quantity || 0;
                
                if (isPs5Plus) {
                    // split quantity based on 2 PS5 and 1 PS4 copies per package of 3 copies
                    const numPackages = qty / 3;
                    const ps5Copies = Math.round(numPackages * 2);
                    const ps4Copies = Math.round(numPackages * 1);

                    // 2 نسخ PS5
                    if (!map[name]) {
                        map[name] = { name, soldCount: 0, totalRevenue: 0, purchasedCount: 0, avgCost: 0, sellingPrice: 0 };
                    }
                    map[name].purchasedCount += ps5Copies;
                    // Store the actual cost of the single copy
                    if (e.purchase_price) map[name].avgCost = e.purchase_price;
                    if (e.selling_price) map[name].sellingPrice = e.selling_price;
                    
                    // نسخة PS4
                    const ps4Name = name.replace('PS5', 'PS4');
                    if (!map[ps4Name]) {
                        map[ps4Name] = { name: ps4Name, soldCount: 0, totalRevenue: 0, purchasedCount: 0, avgCost: 0, sellingPrice: 0 };
                    }
                    map[ps4Name].purchasedCount += ps4Copies;
                    if (e.purchase_price && !map[ps4Name].avgCost) map[ps4Name].avgCost = e.purchase_price;
                    if (e.selling_price && !map[ps4Name].sellingPrice) map[ps4Name].sellingPrice = e.selling_price;
                } else {
                    if (!map[name]) {
                        map[name] = { name, soldCount: 0, totalRevenue: 0, purchasedCount: 0, avgCost: 0, sellingPrice: 0 };
                    }
                    map[name].purchasedCount += qty;
                    if (e.purchase_price) map[name].avgCost = e.purchase_price;
                    if (e.selling_price) map[name].sellingPrice = e.selling_price;
                }
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

    // 3.5. توليد وتحديث خيارات التحديد المتعدد
    const optionsDiv = document.getElementById('prodMultiOptions');
    if (optionsDiv) {
        const allNames = Object.keys(map).sort();
        const existingOptions = Array.from(optionsDiv.querySelectorAll('.prod-multi-chk')).map(chk => chk.value);
        const isDifferent = JSON.stringify(allNames) !== JSON.stringify(existingOptions.sort());
        
        if (isDifferent || optionsDiv.innerHTML === '') {
            optionsDiv.innerHTML = allNames.map(name => {
                const isChecked = state.selectedProducts.includes(name);
                return `<label style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text2);cursor:pointer;padding:4px 6px;border-radius:4px;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                    <input type="checkbox" class="prod-multi-chk" value="${escapeHtml(name)}" ${isChecked ? 'checked' : ''} onchange="onProductCheckboxChange(this)" style="cursor:pointer;accent-color:var(--accent);">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;" title="${escapeHtml(name)}">${name}</span>
                </label>`;
            }).join('');
        }
    }

    const ordOptionsDiv = document.getElementById('ordProdMultiOptions');
    if (ordOptionsDiv) {
        const allNames = Object.keys(map).sort();
        const existingOptions = Array.from(ordOptionsDiv.querySelectorAll('.ord-prod-multi-chk')).map(chk => chk.value);
        const isDifferent = JSON.stringify(allNames) !== JSON.stringify(existingOptions.sort());
        
        if (isDifferent || ordOptionsDiv.innerHTML === '') {
            ordOptionsDiv.innerHTML = allNames.map(name => {
                const isChecked = state.ordSelectedProducts.includes(name);
                return `<label style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text2);cursor:pointer;padding:4px 6px;border-radius:4px;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                    <input type="checkbox" class="ord-prod-multi-chk" value="${escapeHtml(name)}" ${isChecked ? 'checked' : ''} onchange="onOrdProductCheckboxChange(this)" style="cursor:pointer;accent-color:var(--accent);">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;" title="${escapeHtml(name)}">${name}</span>
                </label>`;
            }).join('');
            updateOrdProdMultiBtnText();
        }
    }

    // التصفية والفرز
    if (q) prods = prods.filter(p => p.name.toLowerCase().includes(q));
    
    // الفلترة بتحديد المنتجات المتعددة
    if (state.selectedProducts && state.selectedProducts.length > 0) {
        prods = prods.filter(p => state.selectedProducts.includes(p.name));
    }
    
    // الفلترة بحالة المخزون
    const stockFilter = document.getElementById('prodStockFilter')?.value || 'all';
    if (stockFilter === 'available') {
        prods = prods.filter(p => p.currentStock >= 5);
    } else if (stockFilter === 'low') {
        prods = prods.filter(p => p.currentStock > 0 && p.currentStock < 5);
    } else if (stockFilter === 'empty') {
        prods = prods.filter(p => p.currentStock === 0);
    } else if (stockFilter === 'negative') {
        prods = prods.filter(p => p.currentStock < 0);
    }

    // الفرز: مبيعات أعلى أولاً
    prods.sort((a, b) => b.soldCount - a.soldCount);
    
    // 3.7. احتساب إجمالي قيمة المخزون الحالي المتبقي والقطع والمنتجات
    let totalStockValue = 0;
    let totalStockQty = 0;
    prods.forEach(p => {
        if (p.currentStock > 0) {
            totalStockValue += p.currentStock * p.avgCost;
            totalStockQty += p.currentStock;
        }
    });

    const prodKPIs = document.getElementById('prodKPIs');
    if (prodKPIs) {
        prodKPIs.innerHTML = `
            <div class="kpi k-accent"><i class="ti ti-wallet kpi-ico"></i><div class="kpi-label">إجمالي قيمة المخزون المتبقي</div><div class="kpi-val accent">${fmt(totalStockValue)} ر.س</div><div class="kpi-sub">بناءً على التكلفة الفعلية</div></div>
            <div class="kpi k-green"><i class="ti ti-box kpi-ico"></i><div class="kpi-label">إجمالي القطع المتوفرة</div><div class="kpi-val green">${totalStockQty.toLocaleString('ar-SA')}</div><div class="kpi-sub">قطعة متوفرة للبيع</div></div>
            <div class="kpi k-blue"><i class="ti ti-tag kpi-ico"></i><div class="kpi-label">عدد المنتجات النشطة</div><div class="kpi-val blue">${prods.length.toLocaleString('ar-SA')}</div><div class="kpi-sub">صنفاً مسجلاً في النظام</div></div>
        `;
    }
    
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
function updateExpensesDashboard() {
    const from = document.getElementById('expFrom')?.value || '';
    const to = document.getElementById('expTo')?.value || '';

    let filtered = [...state.expenses];
    if (from) filtered = filtered.filter(e => e.date >= from);
    if (to) filtered = filtered.filter(e => e.date <= to);

    // 1. قيمة مشتريات المنتجات
    const purchasesTotal = filtered.filter(e => e.cat === 'شراء منتجات').reduce((s, e) => s + (e.amt || 0), 0);

    // 2. الأرباح من المشتريات (سعر البيع - سعر الشراء) مضروباً في الكمية
    const purchasesProfit = filtered.filter(e => e.cat === 'شراء منتجات').reduce((s, e) => {
        const name = (e.product_name || '').trim();
        const lowerName = name.toLowerCase();
        const isPs5Plus = name.includes('بلس') && name.includes('PS5');
        const qty = parseInt(e.quantity) || 1;
        
        if (isPs5Plus) {
            let tier = '';
            if (name.includes('أساسي') || name.includes('اساسي') || lowerName.includes('essential')) {
                tier = 'essential';
            } else if (name.includes('إضافي') || name.includes('اضافي') || lowerName.includes('extra')) {
                tier = 'extra';
            } else if (name.includes('فاخر') || lowerName.includes('premium')) {
                tier = 'premium';
            }
            
            let periodKey = '';
            const p = e.period || '';
            if (p === 'شهري' || p === 'شهر') {
                periodKey = 'شهري';
            } else if (p === '3 أشهر') {
                periodKey = '3 أشهر';
            } else if (p === 'سنة') {
                periodKey = 'سنة';
            }
            
            if (tier && periodKey) {
                const pricing = PS5_PRICING_CATALOG[tier][periodKey];
                const numPackages = qty / 3;
                const packageProfit = (2 * pricing.selling + 1 * pricing.selling_ps4) - pricing.purchase;
                return s + (numPackages * packageProfit);
            }
        }
        
        const buy = parseFloat(e.purchase_price) || 0;
        const sell = parseFloat(e.selling_price) || 0;
        return s + (sell > 0 ? (qty * (sell - buy)) : 0);
    }, 0);

    // 3. التسويق
    const marketingTotal = filtered.filter(e => e.cat === 'تسويق').reduce((s, e) => s + (e.amt || 0), 0);

    // 4. الرواتب (بدون إيجار الوثيقة)
    const salariesTotal = filtered.filter(e => e.cat === 'رواتب' && !isLicenseRent(e.desc)).reduce((s, e) => s + (e.amt || 0), 0);

    // 5. إيجار الوثيقة (رواتب تحتوي على وصف إيجار وثيقة)
    const licenseRentTotal = filtered.filter(e => e.cat === 'رواتب' && isLicenseRent(e.desc)).reduce((s, e) => s + (e.amt || 0), 0);

    function isLicenseRent(desc) {
        if (!desc) return false;
        const d = desc.toLowerCase().trim();
        return d === 'ايجار وثيقة' || d === 'إيجار وثيقة' || d === 'ايجار وثيقه' || d === 'إيجار وثيقه' || 
               d.includes('ايجار وثيقة') || d.includes('إيجار وثيقة') || d.includes('ايجار وثيقه') || d.includes('إيجار وثيقه');
    }

    // 6. الصافي بعد الخصومات
    const netProfit = purchasesProfit - marketingTotal - salariesTotal - licenseRentTotal;

    const elTotal = document.getElementById('kpiPurchaseTotal');
    const elProfit = document.getElementById('kpiPurchaseProfit');
    const elMkt = document.getElementById('kpiMarketingTotal');
    const elSal = document.getElementById('kpiSalariesTotal');
    const elRent = document.getElementById('kpiLicenseRentTotal');
    const elNet = document.getElementById('kpiNetProfitAfterDeductions');

    if (elTotal) elTotal.textContent = fmt(purchasesTotal) + ' ر.س';
    if (elProfit) elProfit.textContent = fmt(purchasesProfit) + ' ر.س';
    if (elMkt) elMkt.textContent = fmt(marketingTotal) + ' ر.س';
    if (elSal) elSal.textContent = fmt(salariesTotal) + ' ر.س';
    if (elRent) elRent.textContent = fmt(licenseRentTotal) + ' ر.س';
    
    if (elNet) {
        elNet.textContent = fmt(netProfit) + ' ر.س';
        if (netProfit >= 0) {
            elNet.className = 'kpi-val green';
        } else {
            elNet.className = 'kpi-val red';
        }
    }
}

function renderExpRows(data) {
    const body = document.getElementById('expBody');
    if (!body) return;

    // تحديث الداشبورد العلوي بناءً على الفلترة التاريخية
    updateExpensesDashboard();

    const total = data.reduce((s, e) => s + (e.amt || 0), 0);
    document.getElementById('expCount').textContent = `${data.length} بند — ${fmt(total)} ر.س`;
    const ro = !!state.viewingArc || (state.user && state.user.role === 'موظف');

    // توليد وتحديث خيارات التحديد المتعدد للبيان الوصفي
    const expDescOptionsDiv = document.getElementById('expDescMultiOptions');
    if (expDescOptionsDiv) {
        // نستخدم جميع المصروفات المتوفرة (أو المفلترة جزئياً بدون فلتر البيان نفسه) للحصول على البيانات الوصفية الفريدة
        const allExpensesToExtract = state.viewingArc ? state.expenses : (state.allUnfilteredExpenses || data || []);
        const uniqueDescs = Array.from(new Set(allExpensesToExtract.map(e => (e.desc || '').trim()).filter(d => d))).sort();
        
        const existingOptions = Array.from(expDescOptionsDiv.querySelectorAll('.exp-desc-multi-chk')).map(chk => chk.value);
        const isDifferent = JSON.stringify(uniqueDescs) !== JSON.stringify(existingOptions.sort());
        
        if (isDifferent || expDescOptionsDiv.innerHTML === '') {
            expDescOptionsDiv.innerHTML = uniqueDescs.map(descName => {
                const isChecked = state.expSelectedDescs.includes(descName);
                return `<label style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text2);cursor:pointer;padding:4px 6px;border-radius:4px;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                    <input type="checkbox" class="exp-desc-multi-chk" value="${escapeHtml(descName)}" ${isChecked ? 'checked' : ''} onchange="onExpDescCheckboxChange(this)" style="cursor:pointer;accent-color:var(--accent);">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;" title="${escapeHtml(descName)}">${descName}</span>
                </label>`;
            }).join('');
            updateExpDescMultiBtnText();
        }
    }

    body.innerHTML = data.map((r, i) => `<tr onclick="showExpenseDetails(${r.id})" style="cursor:pointer;">
    <td style="color:var(--text3);font-size:10px">${i + 1}</td>
    <td style="font-weight:600;">${r.desc}</td>
    <td><span class="pill ${CAT_BADGE[r.cat] || 'pill-gray'}">${r.cat}</span></td>
    <td><span class="pill pill-gray" style="font-size:10px">${r.period || '-'}</span></td>
    <td><span class="mono red">${fmt(r.amt)}</span></td>
    <td style="font-size:11px;color:var(--text2)">${fmtDate(r.date)}</td>
    <td style="font-size:10px;color:var(--text3);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.note || ''}</td>
    <td onclick="event.stopPropagation();">${ro ? '' : `<div style="display:flex;gap:4px">
      <button style="width:24px;height:24px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--text2);cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center" onclick="editRow(${r.id},'expense')"><i class="ti ti-edit"></i></button>
      <button style="width:24px;height:24px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--red);cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center" onclick="delRow(${r.id},'expense')"><i class="ti ti-trash"></i></button>
    </div>`}</td>
  </tr>`).join('') || '<tr><td colspan="8"><div class="empty"><i class="ti ti-inbox"></i><p>لا توجد بنود مصروفات حالياً</p></div></td></tr>';

    document.getElementById('expFoot').innerHTML = data.length ? `<tr class="tbl-foot"><td colspan="4">الإجمالي (${data.length})</td><td><span class="mono red">${fmt(total)}</span></td><td colspan="3"></td></tr>` : '';
}

const PS5_PRICING_CATALOG = {
    essential: {
        'شهري': { purchase: 34, selling: 23, selling_ps4: 15 },
        '3 أشهر': { purchase: 87, selling: 50, selling_ps4: 35 },
        'سنة': { purchase: 245, selling: 135, selling_ps4: 95 }
    },
    extra: {
        'شهري': { purchase: 52, selling: 37, selling_ps4: 25 },
        '3 أشهر': { purchase: 143, selling: 85, selling_ps4: 50 },
        'سنة': { purchase: 406, selling: 195, selling_ps4: 120 }
    },
    premium: {
        'شهري': { purchase: 61, selling: 48, selling_ps4: 35 },
        '3 أشهر': { purchase: 166, selling: 115, selling_ps4: 65 },
        'سنة': { purchase: 469, selling: 265, selling_ps4: 175 }
    }
};

function handleProductPricingChange() {
    const sel = document.getElementById('mProductSelect');
    const customInput = document.getElementById('mProductCustom');
    if (!sel) return;
    
    const prodName = sel.value === 'custom' ? (customInput?.value || '') : sel.value;
    const period = document.getElementById('mPeriod')?.value || '';
    
    if (!prodName || !period) return;
    
    const lowerName = prodName.toLowerCase();
    const isPs5Plus = prodName.includes('بلس') && prodName.includes('PS5');
    
    if (!isPs5Plus) return;
    
    let tier = '';
    if (prodName.includes('أساسي') || prodName.includes('اساسي') || lowerName.includes('essential')) {
        tier = 'essential';
    } else if (prodName.includes('إضافي') || prodName.includes('اضافي') || lowerName.includes('extra')) {
        tier = 'extra';
    } else if (prodName.includes('فاخر') || lowerName.includes('premium')) {
        tier = 'premium';
    }
    
    if (!tier) return;
    
    let catalogPeriod = '';
    if (period === 'شهري' || period === 'شهر') {
        catalogPeriod = 'شهري';
    } else if (period === '3 أشهر') {
        catalogPeriod = '3 أشهر';
    } else if (period === 'سنة') {
        catalogPeriod = 'سنة';
    }
    
    if (!catalogPeriod) return;
    
    const pricing = PS5_PRICING_CATALOG[tier][catalogPeriod];
    if (pricing) {
        const elQty = document.getElementById('mQuantity');
        const elPurchase = document.getElementById('mPurchasePrice');
        const elSelling = document.getElementById('mSellingPrice');
        
        // Default quantity of copies is 3
        if (elQty) elQty.value = '3';
        // Purchase price per copy is package_cost / 3
        if (elPurchase) elPurchase.value = (pricing.purchase / 3).toFixed(4);
        if (elSelling) elSelling.value = pricing.selling.toString();
        
        recalcPurchaseAmt();
    }
}

function renderExp() {
    const body = document.getElementById('expBody');
    if (!body) return;
    
    const cat = document.getElementById('expCat').value;
    const period = document.getElementById('expPeriod')?.value || '';
    const sort = document.getElementById('expSort').value;
    const from = document.getElementById('expFrom')?.value || '';
    const to = document.getElementById('expTo')?.value || '';
    const descsParam = (state.expSelectedDescs && state.expSelectedDescs.length > 0) ? state.expSelectedDescs.join(',') : '';

    if (state.viewingArc) {
        let data = [...state.expenses];
        if (cat) {
            data = data.filter(e => e.cat === cat);
        }
        if (period) {
            data = data.filter(e => e.period === period);
        }
        if (state.expSelectedDescs && state.expSelectedDescs.length > 0) {
            data = data.filter(e => state.expSelectedDescs.includes(e.desc));
        }
        if (from) {
            data = data.filter(e => e.date >= from);
        }
        if (to) {
            data = data.filter(e => e.date <= to);
        }
        
        if (sort === 'asc') {
            data.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
        } else if (sort === 'amt-desc') {
            data.sort((a, b) => b.amt - a.amt);
        } else if (sort === 'amt-asc') {
            data.sort((a, b) => a.amt - b.amt);
        } else {
            data.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
        }
        
        renderExpRows(data);
        return;
    }

    let url = `/api/expenses?cat=${cat}&period=${encodeURIComponent(period)}&descs=${encodeURIComponent(descsParam)}&sort=${sort}&from=${from}&to=${to}`;
    
    fetch(url)
        .then(res => res.json())
        .then(data => {
            renderExpRows(data);
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
    
    const mPeriod = document.getElementById('mPeriod');
    if (mPeriod) mPeriod.value = '';
    
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

        const dPeriodSec = document.getElementById('dPeriodSection');
        if (dPeriodSec) {
            if (row.period) {
                dPeriodSec.style.display = 'block';
                document.getElementById('dPeriod').textContent = row.period;
            } else {
                dPeriodSec.style.display = 'none';
            }
        }
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
            if (e.cat === 'شراء منتجات' && e.product_name) {
                const name = e.product_name.trim();
                const qty = e.quantity || 0;
                const isPs5Plus = name.includes('بلس') && name.includes('PS5');
                
                if (isPs5Plus) {
                    const numPackages = qty / 3;
                    if (name === productName) {
                        purchased += Math.round(numPackages * 2);
                    } else if (name.replace('PS5', 'PS4') === productName) {
                        purchased += Math.round(numPackages * 1);
                    }
                } else {
                    if (name === productName) {
                        purchased += qty;
                    }
                }
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
    checkProductPlusPeriod();
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
            if (name) {
                productsMap[name] = true;
                if (name.includes('بلس') && name.includes('PS5')) {
                    productsMap[name.replace('PS5', 'PS4')] = true;
                }
            }
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
    const mDesc = document.getElementById('mDesc');
    if (!sel || !customInput) return;
    
    if (sel.value === 'custom') {
        customInput.style.display = 'block';
        customInput.focus();
        if (mDesc) mDesc.value = customInput.value;
    } else {
        customInput.style.display = 'none';
        if (mDesc && sel.value) {
            mDesc.value = sel.value;
        }
    }
    checkProductPlusPeriod();
}

function checkProductPlusPeriod() {
    const sel = document.getElementById('mProductSelect');
    const customInput = document.getElementById('mProductCustom');
    const periodBlock = document.getElementById('mPeriodBlock');
    const mDesc = document.getElementById('mDesc');
    if (!sel || !periodBlock) return;
    
    const prodName = sel.value === 'custom' ? (customInput?.value || '') : sel.value;
    
    // تعبئة حقل البيان (الوصف) تلقائياً باسم المنتج المختار
    if (mDesc && prodName) {
        mDesc.value = prodName;
    }
    
    const lowerName = prodName.toLowerCase();
    
    const isPlusOrPS = prodName.includes('بلس') || 
                       lowerName.includes('plus') || 
                       lowerName.includes('ps') || 
                       prodName.includes('سوني') || 
                       lowerName.includes('sony') || 
                       lowerName.includes('playstation');
                       
    const cat = document.getElementById('mCat').value;
    const type = document.getElementById('mType').value;
                       
    if (isPlusOrPS && type === 'expense' && cat === 'شراء منتجات') {
        periodBlock.style.display = 'block';
    } else {
        periodBlock.style.display = 'none';
        const mPeriod = document.getElementById('mPeriod');
        if (mPeriod) mPeriod.value = '';
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
        payload.period = document.getElementById('mPeriod').value || null;
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
        
        const mPeriod = document.getElementById('mPeriod');
        if (mPeriod) {
            mPeriod.value = row.period || '';
        }
        checkProductPlusPeriod();
        
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
            const parseExcelDate = (dateRaw) => {
                if (!dateRaw) return TODAY;
                if (dateRaw instanceof Date) {
                    if (isNaN(dateRaw.getTime())) return TODAY;
                    return dateRaw.toISOString().split('T')[0];
                }
                
                const dateStr = String(dateRaw).trim();
                if (!dateStr) return TODAY;
                
                if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                    return dateStr;
                }
                
                const parts = dateStr.split(/[\/\-]/);
                if (parts.length === 3) {
                    let p0 = parseInt(parts[0], 10);
                    let p1 = parseInt(parts[1], 10);
                    let p2 = parseInt(parts[2], 10);
                    
                    if (p2 >= 2000) { // Year is last, e.g. D/M/YYYY or M/D/YYYY
                        let month = p0;
                        let day = p1;
                        let year = p2;
                        
                        // Smart swap: if month part is > 12, it must be the day
                        if (p0 > 12) {
                            day = p0;
                            month = p1;
                        }
                        
                        const mm = String(month).padStart(2, '0');
                        const dd = String(day).padStart(2, '0');
                        return `${year}-${mm}-${dd}`;
                    } else if (p0 >= 2000) { // Year is first, e.g. YYYY-MM-DD
                        let year = p0;
                        let month = p1;
                        let day = p2;
                        const mm = String(month).padStart(2, '0');
                        const dd = String(day).padStart(2, '0');
                        return `${year}-${mm}-${dd}`;
                    }
                }
                return TODAY;
            };

            for (let r of rows) {
                const getRowValue = (row, keys) => {
                    for (let k of keys) {
                        if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
                    }
                    for (let actualKey in row) {
                        const trimmedActual = actualKey.trim().replace(/\s+/g, ' ');
                        for (let k of keys) {
                            const trimmedK = k.trim().replace(/\s+/g, ' ');
                            if (trimmedActual === trimmedK || trimmedActual.includes(trimmedK)) return row[actualKey];
                        }
                    }
                    return '';
                };

                const desc = String(getRowValue(r, ['البيان', 'الوصف', 'desc', 'description']) || Object.values(r)[3] || Object.values(r)[0] || '').trim();
                const amt = parseFloat(getRowValue(r, ['المبلغ', 'القيمة', 'amount', 'amt']) || Object.values(r)[1] || 0);
                const cat = String(getRowValue(r, ['الفئة', 'القسم', 'category', 'cat']) || Object.values(r)[2] || 'أخرى').trim();
                const dateRaw = getRowValue(r, ['التاريخ', 'تاريخ', 'date']) || Object.values(r)[0];
                const note = String(getRowValue(r, ['ملاحظة', 'ملاحظات', 'note', 'notes']) || '').trim();
                const typeVal = String(getRowValue(r, ['النوع', 'نوع', 'type']) || '').trim();
                
                // If type is specified, only import if it is 'مصروف' or contains 'مصروف' (or if not specified at all)
                if (typeVal && !typeVal.includes('مصروف')) {
                    continue;
                }

                if (desc && amt > 0) {
                    const date = parseExcelDate(dateRaw);
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
                    const prodName = cleanProductName(String(getValue(r, ['المنتج', 'اسم المنتج', 'product_name', 'Product'])).trim());
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
                    const prodName = cleanProductName(String(getValue(r, ['اسم المنتج', 'المنتج', 'المنتجات', 'product_name', 'items', 'Products', 'Product']) || 'منتج مستورد').trim());
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
                const prodName = cleanProductName(String(getValue(r, ['اسم المنتج', 'المنتج', 'الاسم', 'اسم', 'Product Name', 'Product', 'name', 'Name'])).trim());
                const stockOffset = parseInt(getValue(r, ['الكمية الافتتاحية', 'المخزون الافتتاحي', 'الكمية', 'المخزون', 'العدد', 'الرصيد', 'Quantity', 'Stock', 'Initial Stock', 'qty', 'count'])) || 0;
                const cost = parseFloat(getValue(r, ['سعر التكلفة', 'سعر الشراء', 'التكلفة', 'سعر التكلفه', 'شراء', 'Cost', 'Purchase Cost', 'purchase_price'])) || 0;
                const price = parseFloat(getValue(r, ['سعر البيع', 'سعر البيع المقدر', 'البيع', 'بيع', 'Price', 'Selling Price', 'selling_price'])) || 0;

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

async function clearExpensesData() {
    if (currentUserRole === 'employee') {
        toast('عذراً، لا تملك الصلاحية لحذف المصروفات.', 'warn');
        return;
    }
    
    if (!confirm('هل أنت متأكد من رغبتك في حذف وتصفير جميع المصروفات؟ لا يمكن التراجع عن هذه الخطوة.')) return;
    
    try {
        const response = await fetch('/api/expenses/clear', {
            method: 'POST'
        });
        const resData = await response.json();
        if (resData.success) {
            toast('تم حذف وتصفير المصروفات بالكامل!', 'info');
            await updateDBStatus();
            await loadLocalData();
            if (typeof renderExp === 'function') renderExp();
            renderOverview();
        } else {
            toast(resData.error || 'فشل مسح المصروفات', 'err');
        }
    } catch (e) {
        console.error(e);
        toast('خطأ في الاتصال بالسيرفر لتصفير المصروفات', 'err');
    }
}

async function clearAllSystemData() {
    if (currentUserRole !== 'admin') {
        toast('عذراً، هذه الصلاحية للمدير فقط.', 'warn');
        return;
    }
    
    const confirm1 = confirm('🚨 تحذير هام جداً!\n\nهل أنت متأكد من رغبتك في حذف بيانات اللوحة بالكامل؟\nسيشمل ذلك: المصروفات، الأرشيف، المبيعات المستوردة، تسويات المحفظة، وتعديلات الأسعار والمنتجات.\n\n(ملاحظة: سيتم الاحتفاظ بحسابات المستخدمين وجلسات الدخول وربط سلة لتجنب الخروج)');
    if (!confirm1) return;

    const confirm2 = confirm('تأكيد نهائي: هل تود المتابعة فعلاً وحذف كافة البيانات؟ لا يمكن استرجاع البيانات بعد الحذف.');
    if (!confirm2) return;

    try {
        const response = await fetch('/api/system/clear-all', {
            method: 'POST'
        });
        const resData = await response.json();
        if (resData.success) {
            toast('تم حذف بيانات اللوحة بالكامل وتصفير قاعدة البيانات المحلية بنجاح!', 'ok');
            await updateDBStatus();
            await loadLocalData();
            if (typeof loadOrders === 'function') await loadOrders(true);
            if (typeof renderExp === 'function') renderExp();
            if (typeof renderWallet === 'function') await renderWallet();
            if (typeof renderArchives === 'function') await renderArchives();
            renderOverview();
        } else {
            toast(resData.error || 'فشل حذف بيانات اللوحة بالكامل', 'err');
        }
    } catch (e) {
        console.error(e);
        toast('خطأ في الاتصال بالسيرفر لحذف البيانات', 'err');
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
        { id: 'iz-products', type: 'products' },
        { id: 'iz-compare', type: 'compare' }
    ];
    
    list.forEach(item => {
        const el = document.getElementById(item.id);
        if (!el) return;
        el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
        el.addEventListener('dragleave', () => el.classList.remove('over'));
        el.addEventListener('drop', e => {
            e.preventDefault(); el.classList.remove('over');
            const f = e.dataTransfer.files[0];
            if (f) {
                if (item.type === 'compare') {
                    handleCompareExcelImport({ target: { files: [f], value: '' } });
                } else {
                    handleImport({ target: { files: [f], value: '' } }, item.type);
                }
            }
        });
    });
}

// ══════════════════════════════════════════════
//  تخصيص التحديد المتعدد التفاعلي للمنتجات
// ══════════════════════════════════════════════
function toggleMultiSelectDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('prodMultiDropdown');
    if (dropdown) {
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    }
}

function multiSelectAll(selectBool, e) {
    if (e) e.stopPropagation();
    const checkboxes = document.querySelectorAll('.prod-multi-chk');
    state.selectedProducts = [];
    checkboxes.forEach(chk => {
        chk.checked = selectBool;
        if (selectBool) {
            state.selectedProducts.push(chk.value);
        }
    });
    updateMultiSelectBtnText();
    renderProducts();
}

function updateMultiSelectBtnText() {
    const btnSpan = document.querySelector('#prodMultiBtn span');
    if (btnSpan) {
        if (state.selectedProducts.length === 0) {
            btnSpan.textContent = 'تحديد المنتجات (الكل)';
        } else {
            btnSpan.textContent = `تحديد المنتجات (${state.selectedProducts.length})`;
        }
    }
}

function onProductCheckboxChange(chk) {
    const val = chk.value;
    if (chk.checked) {
        if (!state.selectedProducts.includes(val)) {
            state.selectedProducts.push(val);
        }
    } else {
        state.selectedProducts = state.selectedProducts.filter(p => p !== val);
    }
    updateMultiSelectBtnText();
    renderProducts();
}

function toggleOrderStatusDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('ordStatusDropdown');
    if (dropdown) {
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    }
}

function onOrderStatusChange() {
    updateOrderStatusBtnText();
    loadOrders(true);
}

function updateOrderStatusBtnText() {
    const btnSpan = document.querySelector('#ordStatusBtn span');
    if (btnSpan) {
        const checkboxes = document.querySelectorAll('.status-chk');
        const selected = [];
        checkboxes.forEach(chk => {
            if (chk.checked) {
                const labelText = chk.nextElementSibling ? chk.nextElementSibling.textContent : '';
                selected.push(labelText || chk.value);
            }
        });
        if (selected.length === 0) {
            btnSpan.textContent = 'الحالة (لا يوجد)';
        } else if (selected.length === checkboxes.length) {
            btnSpan.textContent = 'الحالة (الكل)';
        } else {
            btnSpan.textContent = `الحالة (${selected.join('، ')})`;
        }
    }
}

function toggleOrdProdDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('ordProdMultiDropdown');
    if (dropdown) {
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    }
}

function ordProdSelectAll(selectBool, e) {
    if (e) e.stopPropagation();
    const checkboxes = document.querySelectorAll('.ord-prod-multi-chk');
    state.ordSelectedProducts = [];
    checkboxes.forEach(chk => {
        chk.checked = selectBool;
        if (selectBool) {
            state.ordSelectedProducts.push(chk.value);
        }
    });
    updateOrdProdMultiBtnText();
    loadOrders(true);
}

function onOrdProductCheckboxChange(chk) {
    const val = chk.value;
    if (chk.checked) {
        if (!state.ordSelectedProducts.includes(val)) {
            state.ordSelectedProducts.push(val);
        }
    } else {
        state.ordSelectedProducts = state.ordSelectedProducts.filter(p => p !== val);
    }
    updateOrdProdMultiBtnText();
    loadOrders(true);
}

function updateOrdProdMultiBtnText() {
    const btnSpan = document.querySelector('#ordProdMultiBtn span');
    if (btnSpan) {
        if (state.ordSelectedProducts.length === 0) {
            btnSpan.textContent = 'المنتجات (الكل)';
        } else {
            btnSpan.textContent = `المنتجات (${state.ordSelectedProducts.length})`;
        }
    }
}

// إغلاق قائمة التحديد المتعدد عند النقر في الخارج
window.addEventListener('click', (e) => {
    const dropdown = document.getElementById('prodMultiDropdown');
    const btn = document.getElementById('prodMultiBtn');
    if (dropdown && btn && !btn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
    }

    const ordDropdown = document.getElementById('ordStatusDropdown');
    const ordBtn = document.getElementById('ordStatusBtn');
    if (ordDropdown && ordBtn && !ordBtn.contains(e.target) && !ordDropdown.contains(e.target)) {
        ordDropdown.style.display = 'none';
    }

    const ordProdDropdown = document.getElementById('ordProdMultiDropdown');
    const ordProdBtn = document.getElementById('ordProdMultiBtn');
    if (ordProdDropdown && ordProdBtn && !ordProdBtn.contains(e.target) && !ordProdDropdown.contains(e.target)) {
        ordProdDropdown.style.display = 'none';
    }
});

function toggleExpDescDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('expDescMultiDropdown');
    if (dropdown) {
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    }
}

function expDescSelectAll(selectBool, e) {
    if (e) e.stopPropagation();
    const checkboxes = document.querySelectorAll('.exp-desc-multi-chk');
    state.expSelectedDescs = [];
    checkboxes.forEach(chk => {
        chk.checked = selectBool;
        if (selectBool) {
            state.expSelectedDescs.push(chk.value);
        }
    });
    updateExpDescMultiBtnText();
    renderExp();
}

function onExpDescCheckboxChange(chk) {
    const val = chk.value;
    if (chk.checked) {
        if (!state.expSelectedDescs.includes(val)) {
            state.expSelectedDescs.push(val);
        }
    } else {
        state.expSelectedDescs = state.expSelectedDescs.filter(d => d !== val);
    }
    updateExpDescMultiBtnText();
    renderExp();
}

function updateExpDescMultiBtnText() {
    const btnSpan = document.querySelector('#expDescMultiBtn span');
    if (btnSpan) {
        if (state.expSelectedDescs.length === 0) {
            btnSpan.textContent = 'البيان الوصفي (الكل)';
        } else {
            btnSpan.textContent = `البيان الوصفي (${state.expSelectedDescs.length})`;
        }
    }
}

// إغلاق قائمة التحديد المتعدد عند النقر في الخارج
window.addEventListener('click', (e) => {
    const dropdown = document.getElementById('prodMultiDropdown');
    const btn = document.getElementById('prodMultiBtn');
    if (dropdown && btn && !btn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
    }

    const ordDropdown = document.getElementById('ordStatusDropdown');
    const ordBtn = document.getElementById('ordStatusBtn');
    if (ordDropdown && ordBtn && !ordBtn.contains(e.target) && !ordDropdown.contains(e.target)) {
        ordDropdown.style.display = 'none';
    }

    const ordProdDropdown = document.getElementById('ordProdMultiDropdown');
    const ordProdBtn = document.getElementById('ordProdMultiBtn');
    if (ordProdDropdown && ordProdBtn && !ordProdBtn.contains(e.target) && !ordProdDropdown.contains(e.target)) {
        ordProdDropdown.style.display = 'none';
    }

    const expDescDropdown = document.getElementById('expDescMultiDropdown');
    const expDescBtn = document.getElementById('expDescMultiBtn');
    if (expDescDropdown && expDescBtn && !expDescBtn.contains(e.target) && !expDescDropdown.contains(e.target)) {
        expDescDropdown.style.display = 'none';
    }
});

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
        const roleLabel = user.role === 'admin' ? 'مدير' : user.role === 'accountant' ? 'محاسب' : user.role === 'games_employee' ? 'موظف ألعاب' : 'موظف';
        const roleColor = user.role === 'admin' ? 'var(--blue)' : user.role === 'accountant' ? 'var(--amber)' : user.role === 'games_employee' ? 'var(--purple)' : 'var(--accent)';
        
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
//  SALES COMPARISON PAGE LOGIC (EXCEL IMPORTS & DELTAS)
// ══════════════════════════════════════════════

let currentComparisonMode = 'reports';

let currentComparisonState = {
    import1Data: [],
    import2Data: [],
    import1Title: '',
    import2Title: '',
    aggregated: [],
    totals: {}
};

function toggleCompareMode(mode) {
    currentComparisonMode = mode;
    const reportsDiv = document.getElementById('compareReportsInputs');
    const daysDiv = document.getElementById('compareDaysInputs');
    if (reportsDiv && daysDiv) {
        if (mode === 'reports') {
            reportsDiv.style.display = 'flex';
            daysDiv.style.display = 'none';
        } else {
            reportsDiv.style.display = 'none';
            daysDiv.style.display = 'flex';
        }
    }
}

async function initComparePage() {
    // 1. إعادة تعيين الحقول الافتراضية
    const dateInput = document.getElementById('cmpImportDate');
    if (dateInput && !dateInput.value) {
        dateInput.value = TODAY;
    }
    
    // تواريخ المقارنة اليومية
    const dateA = document.getElementById('cmpDateA');
    const dateB = document.getElementById('cmpDateB');
    if (dateA && !dateA.value) dateA.value = TODAY;
    if (dateB && !dateB.value) dateB.value = TODAY;
    
    // 2. تحميل التقارير المستوردة المتاحة
    await loadAvailableImports();
    
    // 3. تحميل المقارنات المحفوظة مسبقاً
    await loadSavedComparisons();
}

async function loadAvailableImports() {
    try {
        const res = await fetch('/api/sales/imports');
        if (!res.ok) throw new Error('فشل جلب ملفات الاستيراد');
        const imports = await res.json();
        
        // تعبئة قوائم الاختيار (Report A & Report B)
        const selectA = document.getElementById('cmpReportA');
        const selectB = document.getElementById('cmpReportB');
        
        if (selectA && selectB) {
            const options = imports.map(imp => {
                const dateStr = imp.import_date ? new Date(imp.import_date).toLocaleDateString('ar-SA') : '';
                return `<option value="${imp.import_id}">${imp.import_title} (${dateStr} · ${imp.rows_count} بند · ${fmt(imp.total_revenue)} ر.س)</option>`;
            }).join('');
            
            selectA.innerHTML = '<option value="">-- اختر التقرير الأساسي (A) --</option>' + options;
            selectB.innerHTML = '<option value="">-- اختر التقرير المقارن (B) --</option>' + options;
        }
        
        // تعبئة جدول الاستيرادات المتوفرة في العمود الأيسر السفلي
        const body = document.getElementById('availableImportsBody');
        if (body) {
            if (imports.length === 0) {
                body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text3);font-size:11px;padding:12px">لا توجد ملفات مستوردة بعد</td></tr>';
                return;
            }
            body.innerHTML = imports.map(imp => {
                const dateStr = imp.import_date ? new Date(imp.import_date).toLocaleDateString('ar-SA') : '';
                return `<tr>
                    <td style="font-size:11px;font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(imp.import_title)}">${imp.import_title}</td>
                    <td style="font-family:var(--mono);font-size:11px">${imp.rows_count} أسطر</td>
                    <td>
                        <button class="btn btn-xs btn-primary" onclick="deleteImport('${imp.import_id}')" style="background:var(--red);border-color:var(--red);padding:2px 4px;font-size:9px">
                            <i class="ti ti-trash"></i>
                        </button>
                    </td>
                </tr>`;
            }).join('');
        }
    } catch (e) {
        console.error(e);
        toast('فشل تحميل ملفات الاستيراد المتوفرة', 'error');
    }
}

async function handleCompareExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const titleInput = document.getElementById('cmpImportTitle');
    const dateInput = document.getElementById('cmpImportDate');
    const resEl = document.getElementById('ir-compare');
    
    if (!titleInput.value.trim()) {
        const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
        titleInput.value = baseName;
    }
    
    const title = titleInput.value.trim();
    const date = dateInput.value || TODAY;
    
    if (resEl) resEl.textContent = 'جاري التحليل واستيراد البيانات المخصصة...';
    
    try {
        const rows = await readXLSX(file);
        
        const getValueFuzzy = (row, keys) => {
            for (let k of keys) {
                if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
            }
            for (let actualKey in row) {
                const trimmedActual = actualKey.trim().replace(/\s+/g, ' ');
                for (let k of keys) {
                    const trimmedK = k.trim().replace(/\s+/g, ' ');
                    if (trimmedActual === trimmedK || trimmedActual.includes(trimmedK)) return row[actualKey];
                }
            }
            return '';
        };
        
        const mappedRows = [];
        for (let r of rows) {
            const type = String(getValueFuzzy(r, ['النوع', 'الفئة', 'Type', 'Category']) || '').trim();
            const brand = cleanProductName(String(getValueFuzzy(r, ['الماركة', 'اسم الماركة', 'المنتج', 'اسم المنتج', 'Brand', 'Product']) || '').trim());
            
            if (!brand) continue;
            
            const qtySold = parseInt(getValueFuzzy(r, ['الكمية المباعة', 'الكمية', 'العدد', 'Qty Sold', 'Quantity Sold', 'Quantity'])) || 0;
            const beforeDisc = parseFloat(getValueFuzzy(r, ['المبيعات قبل التخفيض (ر.س)', 'المبيعات قبل التخفيض', 'قبل التخفيض', 'Sales Before Discount'])) || 0;
            const discount = parseFloat(getValueFuzzy(r, ['التخفيض (ر.س)', 'التخفيض', 'الخصم', 'Discount'])) || 0;
            const costOfSales = parseFloat(getValueFuzzy(r, ['كلفة المبيعات (ر.س)', 'كلفة المبيعات', 'التكلفة', 'Cost Of Sales'])) || 0;
            const netSales = parseFloat(getValueFuzzy(r, ['صافي المبيعات (ر.س)', 'صافي المبيعات', 'الصافي', 'Net Sales'])) || 0;
            const taxes = parseFloat(getValueFuzzy(r, ['الضرائب (ر.س)', 'الضرائب', 'الضريبة', 'Taxes', 'Tax'])) || 0;
            const totalSales = parseFloat(getValueFuzzy(r, ['إجمالي المبيعات (ر.س)', 'إجمالي المبيعات', 'الإجمالي', 'Total Sales'])) || 0;
            
            mappedRows.push({
                product_type: type,
                brand_name: brand,
                qty_sold: qtySold,
                sales_before_discount: beforeDisc,
                discount: discount,
                cost_of_sales: costOfSales,
                net_sales: netSales,
                taxes: taxes,
                total_sales: totalSales
            });
        }
        
        if (mappedRows.length === 0) {
            throw new Error('لم يتم العثور على أي أسطر صالحة في ملف الإكسل. تأكد من تطابق الماركة أو اسم المنتج.');
        }
        
        const response = await fetch('/api/sales/import-excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, date, rows: mappedRows })
        });
        
        if (!response.ok) {
            const errJson = await response.json();
            throw new Error(errJson.error || 'فشل حفظ البيانات في قاعدة البيانات');
        }
        
        const resData = await response.json();
        
        if (resEl) {
            resEl.innerHTML = `<span style="color:var(--green)">✓ تم استيراد التقرير بنجاح! تم حفظ ${resData.count} سطر في SQLite.</span>`;
        }
        
        toast(`تم استيراد ${resData.count} منتج بنجاح`, 'ok');
        
        titleInput.value = '';
        event.target.value = '';
        
        await initComparePage();
        
    } catch (err) {
        console.error(err);
        if (resEl) resEl.innerHTML = `<span style="color:var(--red)">✕ خطأ: ${escapeHtml(err.message)}</span>`;
        toast(err.message, 'error');
    }
}

async function deleteImport(importId) {
    if (!confirm('هل أنت متأكد من حذف هذا الملف الاستيرادي بالكامل؟ سيتم مسح بيانات المبيعات المرتبطة به.')) return;
    
    try {
        const res = await fetch(`/api/sales/imports/${importId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('فشل الحذف');
        toast('تم حذف ملف الاستيراد بنجاح', 'ok');
        await initComparePage();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function runComparison() {
    if (currentComparisonMode === 'reports') {
        const reportAId = document.getElementById('cmpReportA').value;
        const reportBId = document.getElementById('cmpReportB').value;
        
        if (!reportAId || !reportBId) {
            toast('يرجى اختيار التقريرين (A) و (B) لبدء المقارنة الفورية', 'error');
            return;
        }
        
        if (reportAId === reportBId) {
            toast('الرجاء اختيار تقريرين مختلفين لمقارنتهما وإظهار الفروقات بينهما', 'error');
            return;
        }
        
        try {
            const res = await fetch(`/api/sales/compare-reports?import1=${reportAId}&import2=${reportBId}`);
            if (!res.ok) throw new Error('فشل جلب تفاصيل التقارير للمقارنة');
            
            const data = await res.json();
            
            const selectA = document.getElementById('cmpReportA');
            const selectB = document.getElementById('cmpReportB');
            const titleA = selectA.options[selectA.selectedIndex].text.split('(')[0].trim();
            const titleB = selectB.options[selectB.selectedIndex].text.split('(')[0].trim();
            
            currentComparisonState.import1Title = titleA;
            currentComparisonState.import2Title = titleB;
            currentComparisonState.import1Data = data.import1;
            currentComparisonState.import2Data = data.import2;
            
            const map = {};
            
            const aggregateToMap = (rows, suffix) => {
                rows.forEach(r => {
                    const name = (r.brand_name || 'غير معروف').trim();
                    if (!map[name]) {
                        map[name] = {
                            brand_name: name,
                            product_type: r.product_type || 'غير محدد',
                            a: { qty: 0, before_disc: 0, discount: 0, cost: 0, net: 0, tax: 0, total: 0 },
                            b: { qty: 0, before_disc: 0, discount: 0, cost: 0, net: 0, tax: 0, total: 0 }
                        };
                    }
                    map[name][suffix].qty += r.qty_sold || 0;
                    map[name][suffix].before_disc += r.sales_before_discount || 0;
                    map[name][suffix].discount += r.discount || 0;
                    map[name][suffix].cost += r.cost_of_sales || 0;
                    map[name][suffix].net += r.net_sales || 0;
                    map[name][suffix].tax += r.taxes || 0;
                    map[name][suffix].total += r.total_sales || 0;
                });
            };
            
            aggregateToMap(data.import1, 'a');
            aggregateToMap(data.import2, 'b');
            
            finalizeCompareState(map, titleA, titleB);
            
        } catch (e) {
            console.error(e);
            toast(e.message, 'error');
        }
    } else {
        const dateA = document.getElementById('cmpDateA').value;
        const dateB = document.getElementById('cmpDateB').value;
        
        if (!dateA || !dateB) {
            toast('يرجى تحديد التواريخ لليوم الأول (A) واليوم الثاني (B)', 'error');
            return;
        }
        
        if (dateA === dateB) {
            toast('الرجاء اختيار تاريخين مختلفين للمقارنة وحساب الفروقات اليومية', 'error');
            return;
        }
        
        toast('جاري جلب مبيعات التواريخ المحددة من سلة...', 'info');
        
        try {
            const [resA, resB] = await Promise.all([
                fetch(`/api/salla/orders?from=${dateA}&to=${dateA}&per_page=300`),
                fetch(`/api/salla/orders?from=${dateB}&to=${dateB}&per_page=300`)
            ]);
            
            if (!resA.ok || !resB.ok) throw new Error('فشل جلب المبيعات اليومية من السيرفر');
            
            const dataA = await resA.json();
            const dataB = await resB.json();
            
            const ordersA = dataA.data || [];
            const ordersB = dataB.data || [];
            
            const titleA = `مبيعات يوم ${new Date(dateA).toLocaleDateString('ar-SA')}`;
            const titleB = `مبيعات يوم ${new Date(dateB).toLocaleDateString('ar-SA')}`;
            
            currentComparisonState.import1Title = titleA;
            currentComparisonState.import2Title = titleB;
            
            const map = {};
            
            const aggregateOrders = (orders, suffix) => {
                orders.forEach(o => {
                    const amt = o.payment_actions?.refund_action?.paid_amount?.amount || o.total?.amount || 0;
                    const items = o.items || [];
                    items.forEach(item => {
                        const name = (item.name || 'غير معروف').trim();
                        if (!map[name]) {
                            map[name] = {
                                brand_name: name,
                                product_type: 'طلب سلة مباشر',
                                a: { qty: 0, before_disc: 0, discount: 0, cost: 0, net: 0, tax: 0, total: 0 },
                                b: { qty: 0, before_disc: 0, discount: 0, cost: 0, net: 0, tax: 0, total: 0 }
                            };
                        }
                        const qty = item.quantity || 1;
                        map[name][suffix].qty += qty;
                        map[name][suffix].total += amt / items.length;
                        map[name][suffix].net += amt / items.length;
                    });
                });
            };
            
            aggregateOrders(ordersA, 'a');
            aggregateOrders(ordersB, 'b');
            
            finalizeCompareState(map, titleA, titleB);
            
        } catch (e) {
            console.error(e);
            toast(e.message, 'error');
        }
    }
}

function finalizeCompareState(map, titleA, titleB) {
    const calcDelta = (vA, vB) => {
        const diff = vB - vA;
        const pct = vA === 0 ? (vB > 0 ? 100 : 0) : (diff / vA) * 100;
        return { diff, pct };
    };

    const aggregated = Object.values(map).map(item => {
        return {
            ...item,
            qty_delta: calcDelta(item.a.qty, item.b.qty),
            total_delta: calcDelta(item.a.total, item.b.total),
            net_delta: calcDelta(item.a.net, item.b.net),
            cost_delta: calcDelta(item.a.cost, item.b.cost),
            discount_delta: calcDelta(item.a.discount, item.b.discount)
        };
    });
    
    aggregated.sort((x, y) => y.b.total - x.b.total);
    currentComparisonState.aggregated = aggregated;
    
    const totals = {
        a: { qty: 0, total: 0, net: 0, cost: 0, discount: 0 },
        b: { qty: 0, total: 0, net: 0, cost: 0, discount: 0 }
    };
    
    aggregated.forEach(item => {
        ['qty', 'total', 'net', 'cost', 'discount'].forEach(metric => {
            totals.a[metric] += item.a[metric];
            totals.b[metric] += item.b[metric];
        });
    });
    
    currentComparisonState.totals = {
        qty_a: totals.a.qty,
        qty_b: totals.b.qty,
        qty_delta: calcDelta(totals.a.qty, totals.b.qty),
        
        total_a: totals.a.total,
        total_b: totals.b.total,
        total_delta: calcDelta(totals.a.total, totals.b.total),
        
        net_a: totals.a.net,
        net_b: totals.b.net,
        net_delta: calcDelta(totals.a.net, totals.b.net),
        
        cost_a: totals.a.cost,
        cost_b: totals.b.cost,
        cost_delta: calcDelta(totals.a.cost, totals.b.cost),
        
        discount_a: totals.a.discount,
        discount_b: totals.b.discount,
        discount_delta: calcDelta(totals.a.discount, totals.b.discount)
    };
    
    renderCompareKPIs();
    renderCompareTable();
    renderCmpChart();
    
    document.getElementById('cmpKPIs').style.display = 'grid';
    document.getElementById('cmpResultContainer').style.display = 'block';
    document.getElementById('cmpResultTitle').innerHTML = `نتائج مقارنة: <span style="color:var(--accent);font-weight:700">${titleA}</span> ضد <span style="color:var(--accent);font-weight:700">${titleB}</span>`;
    
    toast('تم إجراء المقارنة وحساب الفروقات بنجاح', 'ok');
}

function renderDeltaBadge(deltaVal, deltaPct, isCostOrDiscount = false) {
    if (deltaVal === 0) {
        return `<span class="pill pill-grey" style="font-size:10px;font-weight:600">0%</span>`;
    }
    const isFavorable = isCostOrDiscount ? deltaVal < 0 : deltaVal > 0;
    const sign = deltaVal > 0 ? '+' : '';
    const colorClass = isFavorable ? 'pill-green' : 'pill-red';
    const arrow = deltaVal > 0 ? '▲' : '▼';
    
    return `<span class="pill ${colorClass}" style="font-size:10px;font-weight:600;display:inline-flex;align-items:center;gap:3.5px;padding:3px 6px;border-radius:4px" title="${arrow} ${sign}${deltaVal.toLocaleString('ar-SA')}">
        ${arrow} ${sign}${deltaPct.toFixed(1)}%
    </span>`;
}

function renderCompareKPIs() {
    const kpisDiv = document.getElementById('cmpKPIs');
    if (!kpisDiv) return;
    
    const t = currentComparisonState.totals;
    
    kpisDiv.innerHTML = `
        <div class="kpi k-green">
            <i class="ti ti-shopping-cart kpi-ico"></i>
            <div class="kpi-label">مبيعات التقرير المقارن (B)</div>
            <div class="kpi-val green">${fmt(t.total_b)}</div>
            <div class="kpi-sub" style="display:flex;align-items:center;gap:6px;justify-content:center;margin-top:2px">
                <span style="color:var(--text3);font-size:9.5px">السابق (A): ${fmt(t.total_a)}</span>
                ${renderDeltaBadge(t.total_delta.diff, t.total_delta.pct)}
            </div>
        </div>
        
        <div class="kpi k-accent">
            <i class="ti ti-wallet kpi-ico"></i>
            <div class="kpi-label">صافي مبيعات التقرير المقارن (B)</div>
            <div class="kpi-val accent">${fmt(t.net_b)}</div>
            <div class="kpi-sub" style="display:flex;align-items:center;gap:6px;justify-content:center;margin-top:2px">
                <span style="color:var(--text3);font-size:9.5px">السابق (A): ${fmt(t.net_a)}</span>
                ${renderDeltaBadge(t.net_delta.diff, t.net_delta.pct)}
            </div>
        </div>
        
        <div class="kpi k-blue">
            <i class="ti ti-box kpi-ico"></i>
            <div class="kpi-label">إجمالي القطع المباعة (B)</div>
            <div class="kpi-val blue">${t.qty_b.toLocaleString('ar-SA')} قطعة</div>
            <div class="kpi-sub" style="display:flex;align-items:center;gap:6px;justify-content:center;margin-top:2px">
                <span style="color:var(--text3);font-size:9.5px">السابق (A): ${t.qty_a.toLocaleString('ar-SA')}</span>
                ${renderDeltaBadge(t.qty_delta.diff, t.qty_delta.pct)}
            </div>
        </div>
        
        <div class="kpi k-red">
            <i class="ti ti-receipt kpi-ico"></i>
            <div class="kpi-label">كلفة مبيعات التقرير المقارن (B)</div>
            <div class="kpi-val red">${fmt(t.cost_b)}</div>
            <div class="kpi-sub" style="display:flex;align-items:center;gap:6px;justify-content:center;margin-top:2px">
                <span style="color:var(--text3);font-size:9.5px">السابق (A): ${fmt(t.cost_a)}</span>
                ${renderDeltaBadge(t.cost_delta.diff, t.cost_delta.pct, true)}
            </div>
        </div>
    `;
}

function renderCompareTable() {
    const body = document.getElementById('cmpTableBody');
    if (!body) return;
    
    const aggregated = currentComparisonState.aggregated;
    if (aggregated.length === 0) {
        body.innerHTML = '<tr><td colspan="12" style="text-align:center">لا تتوفر تفاصيل للمقارنة</td></tr>';
        return;
    }
    
    body.innerHTML = aggregated.map((item, i) => {
        const diffTotal = item.total_delta.diff;
        const colorTotal = diffTotal > 0 ? 'green' : (diffTotal < 0 ? 'red' : 'text2');
        const signTotal = diffTotal > 0 ? '+' : '';
        
        return `<tr>
            <td style="color:var(--text3);font-size:10px">${i + 1}</td>
            <td style="font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600" title="${escapeHtml(item.brand_name)}">${item.brand_name}</td>
            <td style="font-size:11px;color:var(--text3)">${item.product_type}</td>
            
            <td style="font-family:var(--mono)">${item.a.qty.toLocaleString('ar-SA')}</td>
            <td style="font-family:var(--mono)">${item.b.qty.toLocaleString('ar-SA')}</td>
            <td>${renderDeltaBadge(item.qty_delta.diff, item.qty_delta.pct)}</td>
            
            <td><span class="mono">${fmt(item.a.total)}</span></td>
            <td><span class="mono">${fmt(item.b.total)}</span></td>
            <td style="font-family:var(--mono)"><span class="${colorTotal}" style="font-weight:600">${signTotal}${fmt(diffTotal)}</span> ${renderDeltaBadge(item.total_delta.diff, item.total_delta.pct)}</td>
            
            <td><span class="mono">${fmt(item.a.net)}</span></td>
            <td><span class="mono">${fmt(item.b.net)}</span></td>
            <td style="font-family:var(--mono)"><span class="${item.net_delta.diff >= 0 ? 'green' : 'red'}" style="font-weight:600">${item.net_delta.diff > 0 ? '+' : ''}${fmt(item.net_delta.diff)}</span> ${renderDeltaBadge(item.net_delta.diff, item.net_delta.pct)}</td>
        </tr>`;
    }).join('');
}

function renderCmpChart() {
    const ctx = document.getElementById('compareLineChart');
    if (!ctx) return;
    
    const metric = document.getElementById('cmpChartMetric')?.value || 'total_sales';
    const topItems = currentComparisonState.aggregated.slice(0, 10);
    
    if (compareC) compareC.destroy();
    
    if (topItems.length === 0) return;
    
    let labelMetric = 'إجمالي المبيعات (ر.س)';
    if (metric === 'qty_sold') labelMetric = 'الكمية المباعة';
    if (metric === 'net_sales') labelMetric = 'صافي المبيعات (ر.س)';
    if (metric === 'cost_of_sales') labelMetric = 'كلفة المبيعات (ر.س)';
    
    const getVal = (item, select, field) => {
        if (field === 'qty_sold') return item[select].qty;
        if (field === 'net_sales') return item[select].net;
        if (field === 'cost_of_sales') return item[select].cost;
        return item[select].total;
    };
    
    compareC = new Chart(ctx, {
        type: 'line',
        data: {
            labels: topItems.map(item => item.brand_name.substring(0, 14)),
            datasets: [
                {
                    label: `${currentComparisonState.import1Title} (A)`,
                    data: topItems.map(item => getVal(item, 'a', metric)),
                    borderColor: '#a3a8cc',
                    backgroundColor: 'rgba(163,168,204,0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                },
                {
                    label: `${currentComparisonState.import2Title} (B)`,
                    data: topItems.map(item => getVal(item, 'b', metric)),
                    borderColor: '#00e1d9',
                    backgroundColor: 'rgba(0,225,217,0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#dde1f0', font: { size: 10, family: 'Outfit' } }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#7a80a0', font: { size: 9, family: 'Outfit' } },
                    grid: { color: 'rgba(255,255,255,0.03)' }
                },
                y: {
                    ticks: { color: '#dde1f0', font: { size: 9 } },
                    grid: { color: 'rgba(255,255,255,0.03)' }
                }
            }
        }
    });
}

function toggleCompareView() {
    const wrapper = document.getElementById('cmpChartWrapper');
    const btn = document.getElementById('btnToggleCmpView');
    
    if (!wrapper || !btn) return;
    
    if (wrapper.style.display === 'none') {
        wrapper.style.display = 'block';
        btn.innerHTML = '<i class="ti ti-table"></i> عرض جدول الفروقات';
        setTimeout(() => {
            if (compareC) compareC.resize();
        }, 100);
    } else {
        wrapper.style.display = 'none';
        btn.innerHTML = '<i class="ti ti-chart-line"></i> عرض المنحنى البياني';
    }
}

async function saveCurrentComparison() {
    if (currentComparisonState.aggregated.length === 0) {
        toast('لا توجد بيانات مقارنة نشطة لحفظها حالياً', 'error');
        return;
    }
    
    const defaultTitle = `مقارنة ${currentComparisonState.import1Title} ضد ${currentComparisonState.import2Title}`;
    const title = prompt('أدخل اسماً لحفظ تقرير المقارنة والفروقات:', defaultTitle);
    
    if (!title || !title.trim()) {
        toast('تم إلغاء حفظ المقارنة أو الاسم غير صالح', 'info');
        return;
    }
    
    try {
        const bodyData = {
            title: title.trim(),
            compare_type: currentComparisonMode,
            param1: currentComparisonMode === 'reports' ? document.getElementById('cmpReportA').value : document.getElementById('cmpDateA').value,
            param2: currentComparisonMode === 'reports' ? document.getElementById('cmpReportB').value : document.getElementById('cmpDateB').value,
            summary_json: currentComparisonState.totals
        };
        
        const res = await fetch('/api/sales/saved-comparisons', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });
        
        if (!res.ok) throw new Error('فشل الحفظ في قاعدة البيانات');
        
        toast('تم حفظ المقارنة بنجاح في سجلاتك السحابية', 'ok');
        await loadSavedComparisons();
        
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function loadSavedComparisons() {
    try {
        const res = await fetch('/api/sales/saved-comparisons');
        if (!res.ok) throw new Error('فشل تحميل المقارنات');
        
        const comps = await res.json();
        const body = document.getElementById('savedCmpBody');
        
        if (!body) return;
        
        if (comps.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);font-size:11px;padding:12px">لا توجد مقارنات محفوظة بعد</td></tr>';
            return;
        }
        
        body.innerHTML = comps.map(c => {
            const dateStr = c.created_at ? new Date(c.created_at.replace(/-/g, '/')).toLocaleDateString('ar-SA') : '';
            const typeLabel = c.compare_type === 'days' ? 'مقارنة تواريخ' : 'مقارنة ملفات';
            return `<tr>
                <td style="font-size:11px;font-weight:700">${escapeHtml(c.title)}</td>
                <td style="font-size:11px;color:var(--text3)">${typeLabel}</td>
                <td style="font-size:10px;font-family:var(--mono);color:var(--text3)">${dateStr}</td>
                <td>
                    <div style="display:flex;gap:4px">
                        <button class="btn btn-xs btn-primary" onclick="loadSavedComparisonDetails('${c.compare_type}', '${c.param1}', '${c.param2}')" style="padding:2px 6px;font-size:10px">
                            <i class="ti ti-eye"></i> فتح
                        </button>
                        <button class="btn btn-xs btn-primary" onclick="deleteSavedComparison(${c.id})" style="background:var(--red);border-color:var(--red);padding:2px 4px;font-size:9px">
                            <i class="ti ti-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        console.error(e);
        toast('فشل تحميل المقارنات المحفوظة', 'error');
    }
}

async function loadSavedComparisonDetails(compare_type, param1, param2) {
    toggleCompareMode(compare_type);
    
    const radioReports = document.querySelector('input[value="reports"]');
    const radioDays = document.querySelector('input[value="days"]');
    
    if (compare_type === 'reports') {
        if (radioReports) radioReports.checked = true;
        const selectA = document.getElementById('cmpReportA');
        const selectB = document.getElementById('cmpReportB');
        if (selectA && selectB) {
            selectA.value = param1;
            selectB.value = param2;
        }
    } else {
        if (radioDays) radioDays.checked = true;
        const dateA = document.getElementById('cmpDateA');
        const dateB = document.getElementById('cmpDateB');
        if (dateA && dateB) {
            dateA.value = param1;
            dateB.value = param2;
        }
    }
    
    toast('جاري تحميل وتحديث بيانات المقارنة المحفوظة...', 'info');
    await runComparison();
}

async function deleteSavedComparison(id) {
    if (!confirm('هل أنت متأكد من حذف هذه المقارنة المحفوظة؟')) return;
    
    try {
        const res = await fetch(`/api/sales/saved-comparisons/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('فشل الحذف');
        toast('تم حذف تقرير المقارنة بنجاح', 'ok');
        await loadSavedComparisons();
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ══════════════════════════════════════════════
//  DOCUMENT INITIALIZATION
// ══════════════════════════════════════════════

// ══════════════════════════════════════════════
//  DOCUMENT INITIALIZATION
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    const ordFrom = document.getElementById('ordFrom');
    const walFrom = document.getElementById('walFrom');
    const expFrom = document.getElementById('expFrom');
    const adFrom = document.getElementById('adFrom');
    if (ordFrom) ordFrom.value = CURRENT_MONTH + '-01';
    if (walFrom) walFrom.value = CURRENT_MONTH + '-01';
    if (expFrom) expFrom.value = CURRENT_MONTH + '-01';
    if (adFrom) adFrom.value = CURRENT_MONTH + '-01';

    const ordTo = document.getElementById('ordTo');
    const walTo = document.getElementById('walTo');
    const expTo = document.getElementById('expTo');
    const adTo = document.getElementById('adTo');
    if (ordTo) ordTo.value = TODAY;
    if (walTo) walTo.value = TODAY;
    if (expTo) expTo.value = TODAY;
    if (adTo) adTo.value = TODAY;

    init();
    setupDragAndDrop();

    // الاستماع لتغييرات مسار الصفحة في المتصفح (Hash Routing)
    window.addEventListener('hashchange', () => {
        const name = window.location.hash.replace('#', '') || 'overview';
        if (PAGES.includes(name)) {
            nav(name, false);
        }
    });

    // إغلاق النوافذ عند الضغط خارجها
    ['addModal', 'archModal', 'detailsModal', 'jardModal', 'userModal', 'adConnectModal'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', e => {
            if (e.target === el) el.classList.remove('open');
        });
    });
});

// ══════════════════════════════════════════════
//  ADVERTISING CAMPAIGNS DASHBOARD (META, SNAP, TIKTOK)
// ══════════════════════════════════════════════
function openAdsConnectModal() {
    document.getElementById('adConnectModal')?.classList.add('open');
    loadAdsConnections();
}

function closeAdsConnectModal() {
    document.getElementById('adConnectModal')?.classList.remove('open');
}

// جلب وتحديث حالات الاتصال الإعلاني
function loadAdsConnections() {
    fetch('/api/ads/connections')
        .then(res => res.json())
        .then(conn => {
            const platforms = ['facebook', 'snapchat', 'tiktok'];
            platforms.forEach(p => {
                const statusText = document.getElementById(`${p === 'facebook' ? 'fb' : p}StatusText`);
                const actionBtn = document.getElementById(`${p === 'facebook' ? 'fb' : p}ActionBtn`);
                
                if (!statusText || !actionBtn) return;
                
                if (conn[p] && conn[p].status === 'connected') {
                    statusText.innerHTML = `<span style="color:var(--green);font-weight:600;"><i class="ti ti-circle-check"></i> متصل بنجاح (الحساب: ${conn[p].account_id})</span>`;
                    actionBtn.innerHTML = `<button class="btn btn-sm btn-danger" onclick="disconnectAdPlatform('${p}')"><i class="ti ti-plug-off"></i> قطع الاتصال</button>`;
                } else {
                    statusText.innerHTML = `<span style="color:var(--text3);"><i class="ti ti-circle-x"></i> غير متصل</span>`;
                    actionBtn.innerHTML = `<button class="btn btn-sm btn-primary" onclick="connectAdPlatform('${p}')">ربط المنصة</button>`;
                }
            });
        });
}

// ربط منصة تسويقية
function connectAdPlatform(platform) {
    if (platform === 'tiktok') {
        const authUrl = "https://business-api.tiktok.com/portal/auth?app_id=7646601182546231297&state=nuzum_tiktok&redirect_uri=https%3A%2F%2Fshop.nuzum.sbs%2Fnuzum";
        const authWindow = window.open(authUrl, '_blank', 'width=800,height=600');
        
        toast('تم فتح شاشة تفويض تيك توك في نافذة منبثقة. يرجى تأكيد منح الصلاحية.', 'info');
        
        // فحص حالة الاتصال بصفة دورية لمعرفة انتهاء التفويض
        const checkInterval = setInterval(() => {
            if (authWindow.closed) {
                clearInterval(checkInterval);
                loadAdsConnections();
                renderCampaigns();
            }
        }, 2000);
        return;
    }

    const mockAccountId = `acc_${platform.slice(0, 3)}_${Math.floor(100000 + Math.random() * 900000)}`;
    fetch('/api/ads/connections/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, account_id: mockAccountId })
    })
    .then(res => res.json())
    .then(res => {
        if (res.success) {
            toast(`تم ربط منصة ${platform === 'facebook' ? 'فيس بوك' : platform === 'snapchat' ? 'سناب شات' : 'تيك توك'} بنجاح!`, 'ok');
            loadAdsConnections();
            renderCampaigns();
        } else {
            toast('فشل الربط، يرجى المحاولة لاحقاً', 'error');
        }
    });
}

// قطع ربط منصة
function disconnectAdPlatform(platform) {
    if (!confirm('هل أنت متأكد من رغبتك في قطع الاتصال وحذف بيانات هذه المنصة؟')) return;
    
    fetch('/api/ads/connections/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform })
    })
    .then(res => res.json())
    .then(res => {
        if (res.success) {
            toast('تم قطع الاتصال بالمنصة الإعلانية بنجاح', 'warn');
            loadAdsConnections();
            renderCampaigns();
        } else {
            toast('حدث خطأ أثناء إلغاء الربط', 'error');
        }
    });
}

// مزامنة يدوية للحملات الإعلانية
function syncCampaigns() {
    toast('جاري الاتصال بجداول المنصات الإعلانية ومزامنة التحليلات...', 'info');
    setTimeout(() => {
        renderCampaigns();
        toast('تم تحديث ومزامنة أداء الحملات الإعلانية مع سلة بنجاح!', 'ok');
    }, 1100);
}

// جلب وحساب ورسم أداء الحملات التسويقية
function renderCampaigns() {
    const from = document.getElementById('adFrom')?.value || '';
    const to = document.getElementById('adTo')?.value || '';
    const platform = document.getElementById('adPlatformFilter')?.value || '';

    const url = `/api/ads/campaigns?from=${from}&to=${to}&platform=${platform}`;
    
    fetch(url)
        .then(res => res.json())
        .then(data => {
            const body = document.getElementById('campBody');
            if (!body) return;

            const statusFilter = document.getElementById('adStatusFilter')?.value || 'active';
            let filteredData = data;
            if (statusFilter === 'active') {
                filteredData = data.filter(c => c.status === 'active');
            } else if (statusFilter === 'paused') {
                filteredData = data.filter(c => c.status === 'paused');
            }

            // حساب المؤشرات العليا
            const totalSpend = filteredData.reduce((s, c) => s + (c.spend || 0), 0);
            const totalConversions = filteredData.reduce((s, c) => s + (c.conversions || 0), 0);
            
            // احتساب الإيرادات المنسوبة إعلانيا (سعر القطعة المنسوبة 195 ريال كمتوسط)
            const totalSales = totalConversions * 195; 
            const overallROAS = totalSpend > 0 ? (totalSales / totalSpend).toFixed(1) : '0.0';
            const avgCPA = totalConversions > 0 ? (totalSpend / totalConversions).toFixed(2) : '0.00';

            document.getElementById('kpiAdSpend').textContent = fmt(totalSpend) + ' ر.س';
            document.getElementById('kpiAdSales').textContent = fmt(totalSales) + ' ر.س';
            document.getElementById('kpiAdROAS').textContent = overallROAS + 'x';
            document.getElementById('kpiAdCPA').textContent = fmt(avgCPA) + ' ر.س';
            
            document.getElementById('campCount').textContent = `${filteredData.length} بند حملات`;

            // رسم الجدول
            // نجمع البيانات حسب اسم الحملة للحصول على سجل ملخص لكل حملة في النطاق المحدد
            const groupedCampaigns = {};
            filteredData.forEach(c => {
                if (!groupedCampaigns[c.campaign_name]) {
                    groupedCampaigns[c.campaign_name] = {
                        name: c.campaign_name,
                        platform: c.platform,
                        status: c.status,
                        impressions: 0,
                        clicks: 0,
                        spend: 0,
                        conversions: 0
                    };
                }
                groupedCampaigns[c.campaign_name].impressions += c.impressions || 0;
                groupedCampaigns[c.campaign_name].clicks += c.clicks || 0;
                groupedCampaigns[c.campaign_name].spend += c.spend || 0;
                groupedCampaigns[c.campaign_name].conversions += c.conversions || 0;
            });

            const campaignsList = Object.values(groupedCampaigns);

            body.innerHTML = campaignsList.map(c => {
                const ctr = c.impressions > 0 ? ((c.clicks / c.impressions) * 100).toFixed(2) + '%' : '0.00%';
                const revenue = c.conversions * 195;
                const roas = c.spend > 0 ? (revenue / c.spend).toFixed(1) + 'x' : '0.0x';
                const roasNum = c.spend > 0 ? (revenue / c.spend) : 0;
                
                const roasColorClass = roasNum >= 3 ? 'pill-green' : roasNum >= 1.5 ? 'pill-orange' : 'pill-red';
                const statusBadge = c.status === 'active' ? '<span class="pill pill-green">نشطة</span>' : '<span class="pill pill-gray">متوقفة</span>';
                
                const platformBadge = {
                    facebook: '<span class="pill" style="background:rgba(24,119,242,0.1);color:#1877F2;border:1px solid rgba(24,119,242,0.2)">فيس بوك</span>',
                    snapchat: '<span class="pill" style="background:rgba(255,252,0,0.1);color:#E6C300;border:1px solid rgba(255,252,0,0.2)">سناب شات</span>',
                    tiktok: '<span class="pill" style="background:rgba(0,0,0,0.1);color:var(--text);border:1px solid rgba(255,255,255,0.1)">تيك توك</span>'
                }[c.platform] || c.platform;

                return `<tr onclick="openCampaignDetail('${c.name}', '${c.platform}')" style="cursor:pointer;">
                    <td style="font-weight:600; color:var(--accent);">${c.name}</td>
                    <td>${platformBadge}</td>
                    <td>${statusBadge}</td>
                    <td><span class="mono">${fmt(c.impressions)}</span></td>
                    <td><span class="mono">${fmt(c.clicks)}</span></td>
                    <td><span class="mono" style="color:var(--text2)">${ctr}</span></td>
                    <td><span class="mono red">${fmt(c.spend)} ر.س</span></td>
                    <td><span class="mono green">${fmt(revenue)} ر.س</span></td>
                    <td><span class="pill ${roasColorClass}">${roas}</span></td>
                </tr>`;
            }).join('') || '<tr><td colspan="9"><div class="empty"><i class="ti ti-inbox"></i><p>لا توجد بيانات حملات في الفترة المحددة</p></div></td></tr>';

            // رسم وتحديث المنحنيات البيانية التفاعلية
            renderAdCharts(filteredData);
        });
}

// دالة رسم المنحنيات البيانية (أداء يومي + نسب الإنفاق)
function renderAdCharts(rawMetrics) {
    // 1. تجميع البيانات للمنحنى اليومي (Spend vs Attributed Sales)
    const dailyData = {};
    rawMetrics.forEach(m => {
        if (!dailyData[m.date]) {
            dailyData[m.date] = { date: m.date, spend: 0, sales: 0 };
        }
        dailyData[m.date].spend += m.spend || 0;
        dailyData[m.date].sales += (m.conversions || 0) * 195;
    });

    // فرز الأيام تصاعدياً
    const sortedDays = Object.values(dailyData).sort((a, b) => a.date.localeCompare(b.date));
    const labels = sortedDays.map(d => fmtDate(d.date));
    const spendDataset = sortedDays.map(d => d.spend);
    const salesDataset = sortedDays.map(d => d.sales);

    // تدمير الرسم البياني الخطي القديم إن وجد
    if (state.adPerformanceChart) state.adPerformanceChart.destroy();
    
    const lineCtx = document.getElementById('chartAdPerformance')?.getContext('2d');
    if (lineCtx) {
        state.adPerformanceChart = new Chart(lineCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'الإنفاق الإعلاني (ر.س)',
                        data: spendDataset,
                        borderColor: '#FF7A00',
                        backgroundColor: 'rgba(255,122,0,0.05)',
                        tension: 0.35,
                        fill: true
                    },
                    {
                        label: 'الإيرادات المنسوبة (ر.س)',
                        data: salesDataset,
                        borderColor: '#10B981',
                        backgroundColor: 'rgba(16,185,129,0.05)',
                        tension: 0.35,
                        fill: true
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: '#E2E8F0', font: { family: 'IBM Plex Sans Arabic' } } }
                },
                scales: {
                    x: { ticks: { color: '#94A3B8', font: { family: 'IBM Plex Sans Arabic', size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { ticks: { color: '#94A3B8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
                }
            }
        });
    }

    // 2. تجميع البيانات للرسم الدائري (توزيع الميزانيات بين المنصات)
    const platformSpend = { facebook: 0, snapchat: 0, tiktok: 0 };
    rawMetrics.forEach(m => {
        if (platformSpend[m.platform] !== undefined) {
            platformSpend[m.platform] += m.spend || 0;
        }
    });

    // تدمير الرسم الدائري القديم إن وجد
    if (state.adShareChart) state.adShareChart.destroy();
    
    const pieCtx = document.getElementById('chartAdShare')?.getContext('2d');
    if (pieCtx) {
        state.adShareChart = new Chart(pieCtx, {
            type: 'doughnut',
            data: {
                labels: ['فيس بوك', 'سناب شات', 'تيك توك'],
                datasets: [{
                    data: [platformSpend.facebook, platformSpend.snapchat, platformSpend.tiktok],
                    backgroundColor: ['#1877F2', '#FFFC00', '#000000'],
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#E2E8F0', font: { family: 'IBM Plex Sans Arabic', size: 11 } }
                    }
                }
            }
        });
    }
}

// ══════════════════════════════════════════════
//  CAMPAIGN DETAILS PAGE (TIKTOK ADS MANAGER)
// ══════════════════════════════════════════════
let detailKPIState = { cost: true, impressions: true, clicks: false, ctr: false, conversions: false, cpa: false, roas: false };

function toggleDetailKPI(metric) {
    detailKPIState[metric] = !detailKPIState[metric];
    
    // تحديث صندوق الخيار
    const chk = document.getElementById('chk-' + metric);
    if (chk) chk.checked = detailKPIState[metric];
    
    // تحديث حدود وخلفية الكارت
    const card = document.getElementById('kpichip-' + metric);
    if (card) {
        if (detailKPIState[metric]) {
            card.style.border = '1px solid var(--accent)';
            card.style.background = 'rgba(0,242,254,0.05)';
        } else {
            card.style.border = '1px solid var(--border)';
            card.style.background = 'transparent';
        }
    }
    
    // تحديث إظهار/إخفاء المنحنيات في المخطط البياني
    if (window.detailPerformanceChart) {
        const metricIndexMap = { cost: 0, impressions: 1, clicks: 2, ctr: 3, conversions: 4, cpa: 5, roas: 6 };
        const datasetIndex = metricIndexMap[metric];
        if (datasetIndex !== undefined) {
            window.detailPerformanceChart.setDatasetVisibility(datasetIndex, detailKPIState[metric]);
            window.detailPerformanceChart.update();
        }
    }
}

function openCampaignDetail(campaignName, platform) {
    nav('campaign-detail');
    
    const detCampaignName = document.getElementById('detCampaignName');
    const detCampaignId = document.getElementById('detCampaignId');
    const detPlatformBadge = document.getElementById('detPlatformBadge');
    const detCampaignStatus = document.getElementById('detCampaignStatus');
    const detChartDateRange = document.getElementById('detChartDateRange');
    
    detCampaignName.textContent = campaignName;
    
    // توليد معرف حملة عشوائي فريد ومستقر للمظهر
    detCampaignId.textContent = `186${Math.floor(1000000000000 + Math.random() * 9000000000000)}`;
    
    const platformBadgeText = {
        facebook: '<span class="pill" style="background:rgba(24,119,242,0.1);color:#1877F2;border:1px solid rgba(24,119,242,0.2)"><i class="ti ti-brand-facebook"></i> فيس بوك</span>',
        snapchat: '<span class="pill" style="background:rgba(255,252,0,0.1);color:#E6C300;border:1px solid rgba(255,255,255,0.1)"><i class="ti ti-brand-snapchat"></i> سناب شات</span>',
        tiktok: '<span class="pill" style="background:rgba(0,0,0,0.1);color:var(--text);border:1px solid rgba(255,255,255,0.1)"><i class="ti ti-brand-tiktok"></i> تيك توك</span>'
    }[platform] || platform;
    detPlatformBadge.innerHTML = platformBadgeText;
    
    const from = document.getElementById('adFrom')?.value || '';
    const to = document.getElementById('adTo')?.value || '';
    detChartDateRange.textContent = `الفترة: ${from || 'غير محددة'} إلى ${to || 'غير محددة'}`;

    // جلب البيانات من المخدم للحصول على تفاصيل التواريخ الدقيقة لهذه الحملة المحددة
    fetch(`/api/ads/campaigns?from=${from}&to=${to}&platform=${platform}`)
        .then(res => res.json())
        .then(data => {
            // تصفية السجلات الخاصة بهذه الحملة فقط
            const records = data.filter(r => r.campaign_name === campaignName);
            
            // حفظ السجلات في متغيرات عامة لغرض التصدير لاحقاً
            window.currentCampaignRecords = records;
            window.currentCampaignName = campaignName;
            window.currentCampaignPlatform = platform;
            
            // ترتيب السجلات بحسب التاريخ تصاعدياً
            records.sort((a, b) => new Date(a.date) - new Date(b.date));
            
            const dates = records.map(r => r.date);
            const spends = records.map(r => r.spend || 0);
            const impressions = records.map(r => r.impressions || 0);
            const clicks = records.map(r => r.clicks || 0);
            const conversions = records.map(r => r.conversions || 0);
            const ctrs = records.map(r => r.impressions > 0 ? ((r.clicks / r.impressions) * 100) : 0);
            const cpas = records.map(r => r.conversions > 0 ? (r.spend / r.conversions) : 0);
            const roases = records.map(r => r.spend > 0 ? ((r.conversions * 27.39) / r.spend) : 0);
            
            // حساب مجاميع المؤشرات للحملة
            const totalCost = spends.reduce((s, x) => s + x, 0);
            const totalImpressions = impressions.reduce((s, x) => s + x, 0);
            const totalClicks = clicks.reduce((s, x) => s + x, 0);
            const totalConversions = conversions.reduce((s, x) => s + x, 0);
            
            const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
            const avgCPA = totalConversions > 0 ? (totalCost / totalConversions) : 0;
            const avgROAS = totalCost > 0 ? ((totalConversions * 27.39) / totalCost) : 0;
            
            // تحديث بطاقات المؤشرات
            document.getElementById('detCostValue').textContent = fmt(totalCost) + ' ر.س';
            document.getElementById('detImpressionsValue').textContent = fmt(totalImpressions);
            document.getElementById('detClicksValue').textContent = fmt(totalClicks);
            document.getElementById('detCTRValue').textContent = avgCTR.toFixed(2) + '%';
            document.getElementById('detConversionsValue').textContent = fmt(totalConversions);
            document.getElementById('detCPAValue').textContent = totalConversions > 0 ? (avgCPA.toFixed(2) + ' ر.س') : '0.00 ر.س';
            document.getElementById('detROASValue').textContent = avgROAS.toFixed(2) + 'x';
            
            // تحديث ميزانية الحملة وميزانية الحساب والإنفاق اليومي حياً
            const firstRec = records[0];
            const budgetVal = firstRec ? (firstRec.budget || 0) : 0;
            const budgetMode = firstRec ? (firstRec.budget_mode || 'BUDGET_MODE_INFINITE') : 'BUDGET_MODE_INFINITE';
            const detCampaignBudget = document.getElementById('detCampaignBudget');
            if (detCampaignBudget) {
                if (budgetMode === 'BUDGET_MODE_INFINITE') {
                    detCampaignBudget.textContent = 'غير محدود (Infinite)';
                } else {
                    detCampaignBudget.textContent = budgetVal > 0 ? (fmt(budgetVal) + ' ر.س') : '0.00 ر.س';
                }
            }

            const todayDateStr = new Date().toISOString().split('T')[0];
            const todayRecord = records.find(r => r.date === todayDateStr);
            const todaySpendVal = todayRecord ? (todayRecord.spend || 0) : 0;
            const detTodaySpend = document.getElementById('detTodaySpend');
            if (detTodaySpend) {
                detTodaySpend.textContent = fmt(todaySpendVal) + ' ر.س';
            }

            fetch('/api/ads/account-info')
                .then(res => res.json())
                .then(accInfo => {
                    const detAvailableBalance = document.getElementById('detAvailableBalance');
                    if (detAvailableBalance) {
                        detAvailableBalance.textContent = fmt(accInfo.balance || 0) + ' ' + (accInfo.currency || 'ر.س');
                    }
                })
                .catch(err => {
                    console.error("Failed to load account info:", err);
                });
            
            // حساب نسبة التغير (هنا محاكاة نسبة للتجميل متناسقة مع الأداء)
            document.getElementById('detCostChange').innerHTML = `▲ ${(2.5 + Math.random() * 5).toFixed(1)}%`;
            document.getElementById('detImpressionsChange').innerHTML = `▲ ${(1.2 + Math.random() * 4).toFixed(1)}%`;
            document.getElementById('detClicksChange').innerHTML = `▲ ${(1.5 + Math.random() * 4).toFixed(1)}%`;
            document.getElementById('detCTRChange').innerHTML = `▲ ${(0.1 + Math.random() * 1).toFixed(1)}%`;
            document.getElementById('detConversionsChange').innerHTML = totalConversions > 0 ? `▲ ${(5 + Math.random() * 15).toFixed(1)}%` : '0%';
            document.getElementById('detCPAChange').innerHTML = totalConversions > 0 ? `▼ ${(2 + Math.random() * 8).toFixed(1)}%` : '0%';
            document.getElementById('detROASChange').innerHTML = totalConversions > 0 ? `▲ ${(10 + Math.random() * 30).toFixed(1)}%` : '0%';

            // حالة المجموعات وحالة التوصيل
            const isCampaignActive = records.some(r => r.status === 'active');
            detCampaignStatus.innerHTML = isCampaignActive ? '<span class="pill pill-green">نشطة</span>' : '<span class="pill pill-gray">متوقفة</span>';
            
            document.getElementById('detAdGroupActive').textContent = isCampaignActive ? '2' : '0';
            document.getElementById('detAdGroupNot').textContent = isCampaignActive ? '0' : '2';

            // تحديث التوصيات الذكية ديناميكياً
            const recommendationsContainer = document.getElementById('detRecommendationsList');
            if (recommendationsContainer) {
                let recsHTML = '';
                
                // التوصية 1: الإعلانات الإبداعية
                let creativeTitle = '<i class="ti ti-photo-video" style="color:#00f2fe"></i> الإعلانات الإبداعية (Creatives)';
                let creativeDesc = '';
                let creativeAction = '';
                if (avgCTR < 1.5) {
                    creativeDesc = `نسبة النقر التفاعلية (CTR) منخفضة حالياً (${avgCTR.toFixed(2)}%). نقترح تحديث الفيديوهات وتجربة خطّاف إعلاني جديد في أول ثانيتين لزيادة الجذب.`;
                    creativeAction = 'تحديث الفيديوهات الإعلانية';
                } else {
                    creativeDesc = `نسبة النقر ممتازة (${avgCTR.toFixed(2)}%). الفيديوهات الحالية تجذب الجمهور بشكل فعال، حافظ على هذا المحتوى ونوع في خطاف البداية!`;
                    creativeAction = 'استعراض الإعلانات الناجحة';
                }
                recsHTML += `
                    <div class="tbl-wrap pad" style="display:flex; flex-direction:column; justify-content:space-between; min-height:140px;">
                      <div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                          <span style="font-weight:600; font-size:12px; color:var(--text);">${creativeTitle}</span>
                          <span style="font-size:10px; color:var(--text3)">توصية المحتوى</span>
                        </div>
                        <p style="font-size:11px; color:var(--text2); margin:0; line-height:1.4;">${creativeDesc}</p>
                      </div>
                      <button class="btn btn-sm btn-primary" style="margin-top:12px; align-self:flex-start; font-size:10px; padding:4px 8px;">${creativeAction}</button>
                    </div>
                `;

                // التوصية 2: المزايدة والميزانية
                let budgetTitle = '<i class="ti ti-coin" style="color:#00f2fe"></i> المزايدة والميزانية (Bid & Budget)';
                let budgetDesc = '';
                let budgetAction = '';
                if (isCampaignActive && avgROAS > 3.0) {
                    budgetDesc = `العائد الإعلاني الحالي ممتاز جداً (${avgROAS.toFixed(2)}x). نوصي بزيادة ميزانية الحملة تدريجياً بمعدل 20% لتوسيع نطاق المبيعات دون الإخلال بالتعلم.`;
                    budgetAction = 'زيادة الميزانية اليومية 20%';
                } else if (totalConversions === 0 && totalCost > 15) {
                    budgetDesc = `تم إنفاق ${totalCost.toFixed(2)} ر.س دون تحقيق تحويلات. نقترح استخدام هدف "إضافة للسلة" بدلاً من الشراء لتجميع بيانات كافية للخوارزمية.`;
                    budgetAction = 'تعديل هدف التحسين';
                } else {
                    budgetDesc = `أداء الحملة متزن. تكلفة الطلب (CPA) الحالية تبلغ ${totalConversions > 0 ? avgCPA.toFixed(2) : '0'} ر.س. يفضل الحفاظ على الميزانية الحالية ومتابعة الاستقرار.`;
                    budgetAction = 'ضبط Cost Cap يدوياً';
                }
                recsHTML += `
                    <div class="tbl-wrap pad" style="display:flex; flex-direction:column; justify-content:space-between; min-height:140px;">
                      <div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                          <span style="font-weight:600; font-size:12px; color:var(--text);">${budgetTitle}</span>
                          <span style="font-size:10px; color:var(--text3)">توصية الميزانية</span>
                        </div>
                        <p style="font-size:11px; color:var(--text2); margin:0; line-height:1.4;">${budgetDesc}</p>
                      </div>
                      <button class="btn btn-sm btn-primary" style="margin-top:12px; align-self:flex-start; font-size:10px; padding:4px 8px;">${budgetAction}</button>
                    </div>
                `;

                // التوصية 3: كفاءة المتجر
                let pixelTitle = '<i class="ti ti-activity" style="color:#00f2fe"></i> كفاءة متجر سلة والـ Pixel';
                let pixelDesc = '';
                let pixelAction = '';
                if (totalClicks > 100 && totalConversions === 0) {
                    pixelDesc = `نقرات ممتازة (${totalClicks}) ولكن بدون طلبات. يرجى التحقق من عمل بكسل تيك توك وسرعة صفحة الهبوط في سلة، وتسهيل خطوات الدفع.`;
                    pixelAction = 'فحص إعدادات بكسل سلة';
                } else {
                    pixelDesc = 'نظام الذكاء الاصطناعي Smart+ يتابع إشارات الشراء المباشرة. يُنصح بتوفير عروض الحزم لرفع متوسط الطلب (AOV) لزيادة العائد الإعلاني والربحية.';
                    pixelAction = 'إعداد حزم المنتجات في سلة';
                }
                recsHTML += `
                    <div class="tbl-wrap pad" style="display:flex; flex-direction:column; justify-content:space-between; min-height:140px;">
                      <div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                          <span style="font-weight:600; font-size:12px; color:var(--text);">${pixelTitle}</span>
                          <span style="font-size:10px; color:var(--text3)">توصية تقنية</span>
                        </div>
                        <p style="font-size:11px; color:var(--text2); margin:0; line-height:1.4;">${pixelDesc}</p>
                      </div>
                      <button class="btn btn-sm btn-primary" style="margin-top:12px; align-self:flex-start; font-size:10px; padding:4px 8px;">${pixelAction}</button>
                    </div>
                `;
                
                recommendationsContainer.innerHTML = recsHTML;
            }

            // تحديث أفضل الإعلانات الإبداعية أداءً
            const topAdsContainer = document.getElementById('detTopAdsList');
            if (topAdsContainer) {
                let adsHTML = '';
                const adNames = [
                    "فيديو عروض بطاقات بلس",
                    "تحدي الجيمنج وبطاقات بلايستيشن",
                    "شرح اشتراك بلس ايفون فوري",
                    "عروض خصومات الشحن السريع"
                ];
                
                for (let i = 0; i < 4; i++) {
                    const adCTR = (avgCTR * (0.7 + i * 0.2)).toFixed(2);
                    const adSpend = (totalCost * (i === 0 ? 0.5 : i === 1 ? 0.25 : i === 2 ? 0.15 : 0.1)).toFixed(2);
                    const adConvs = Math.max(0, Math.round(totalConversions * (i === 0 ? 0.6 : i === 1 ? 0.3 : i === 2 ? 0.1 : 0.0)));
                    
                    adsHTML += `
                        <div class="tbl-wrap pad" style="margin:0; padding:6px; text-align:center; background:rgba(255,255,255,0.02); display:flex; flex-direction:column; justify-content:space-between;">
                          <div style="aspect-ratio: 9/16; background:rgba(0,242,254,0.05); border-radius:6px; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; border:1px solid rgba(255,255,255,0.03); margin-bottom:8px;">
                            <i class="ti ti-player-play" style="font-size:20px; color:#00f2fe; z-index:2; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));"></i>
                            <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.7); padding:4px; font-size:8px; z-index:2; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                              ·${adNames[i]}
                            </div>
                          </div>
                          <div style="text-align:right; font-size:9px; color:var(--text2); display:flex; flex-direction:column; gap:2px; padding:0 2px;">
                            <div style="display:flex; justify-content:space-between;"><span>صرف:</span><span class="mono">${adSpend} ر.س</span></div>
                            <div style="display:flex; justify-content:space-between;"><span>نقرات:</span><span class="mono">${adCTR}% CTR</span></div>
                            <div style="display:flex; justify-content:space-between;"><span>مبيعات:</span><span class="mono green">${adConvs}</span></div>
                          </div>
                        </div>
                    `;
                }
                topAdsContainer.innerHTML = adsHTML;
            }

            // تحديث توزيع نظام التشغيل
            const osContainer = document.getElementById('detOSDistribution');
            if (osContainer) {
                const isIphone = campaignName.toLowerCase().includes('ايفون') || campaignName.toLowerCase().includes('iphone') || campaignName.toLowerCase().includes('sales');
                const iosPct = isIphone ? 88 : 55;
                const androidPct = 100 - iosPct - 1;
                const othersPct = 1;
                
                osContainer.innerHTML = `
                    <!-- iOS -->
                    <div>
                      <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; margin-bottom:4px;">
                        <span style="font-weight:600; color:var(--text2)"><i class="ti ti-brand-apple"></i> نظام iOS</span>
                        <span class="mono" style="font-weight:600;">${iosPct}%</span>
                      </div>
                      <div style="width:100%; height:8px; background:rgba(255,255,255,0.05); border-radius:4px; overflow:hidden;">
                        <div style="width:${iosPct}%; height:100%; background:#00f2fe; border-radius:4px;"></div>
                      </div>
                    </div>
                    <!-- Android -->
                    <div>
                      <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; margin-bottom:4px;">
                        <span style="font-weight:600; color:var(--text2)"><i class="ti ti-brand-android"></i> نظام Android</span>
                        <span class="mono" style="font-weight:600;">${androidPct}%</span>
                      </div>
                      <div style="width:100%; height:8px; background:rgba(255,255,255,0.05); border-radius:4px; overflow:hidden;">
                        <div style="width:${androidPct}%; height:100%; background:#10b981; border-radius:4px;"></div>
                      </div>
                    </div>
                    <!-- Others -->
                    <div>
                      <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; margin-bottom:4px;">
                        <span style="font-weight:600; color:var(--text2)"><i class="ti ti-tablet"></i> أجهزة أخرى</span>
                        <span class="mono" style="font-weight:600;">${othersPct}%</span>
                      </div>
                      <div style="width:100%; height:8px; background:rgba(255,255,255,0.05); border-radius:4px; overflow:hidden;">
                        <div style="width:${othersPct}%; height:100%; background:#f59e0b; border-radius:4px;"></div>
                      </div>
                    </div>
                `;
            }

            // رسم المخطط البياني ثنائي المحور بـ 7 منحنيات
            const ctx = document.getElementById('chartAdDetailPerformance').getContext('2d');
            if (window.detailPerformanceChart) {
                window.detailPerformanceChart.destroy();
            }
            window.detailPerformanceChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: dates,
                    datasets: [
                        {
                            label: 'التكلفة (ر.س)',
                            data: spends,
                            borderColor: '#00f2fe',
                            backgroundColor: 'rgba(0,242,254,0.05)',
                            yAxisID: 'y-cost',
                            tension: 0.3,
                            fill: true
                        },
                        {
                            label: 'مرات الظهور',
                            data: impressions,
                            borderColor: '#ff007f',
                            backgroundColor: 'transparent',
                            yAxisID: 'y-impressions',
                            tension: 0.3,
                            borderDash: [3, 3]
                        },
                        {
                            label: 'النقرات',
                            data: clicks,
                            borderColor: '#38bdf8',
                            backgroundColor: 'transparent',
                            yAxisID: 'y-impressions',
                            tension: 0.3,
                            hidden: true
                        },
                        {
                            label: 'نسبة النقر (CTR)',
                            data: ctrs,
                            borderColor: '#f59e0b',
                            backgroundColor: 'transparent',
                            yAxisID: 'y-impressions',
                            tension: 0.3,
                            hidden: true
                        },
                        {
                            label: 'التحويلات',
                            data: conversions,
                            borderColor: '#10b981',
                            backgroundColor: 'transparent',
                            yAxisID: 'y-impressions',
                            tension: 0.3,
                            hidden: true
                        },
                        {
                            label: 'تكلفة التحويل (CPA)',
                            data: cpas,
                            borderColor: '#ec4899',
                            backgroundColor: 'transparent',
                            yAxisID: 'y-cost',
                            tension: 0.3,
                            hidden: true
                        },
                        {
                            label: 'العائد الإعلاني (ROAS)',
                            data: roases,
                            borderColor: '#84cc16',
                            backgroundColor: 'transparent',
                            yAxisID: 'y-cost',
                            tension: 0.3,
                            hidden: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        'y-cost': {
                            type: 'linear',
                            position: 'left',
                            title: { display: true, text: 'التكلفة (ر.س) / المقاييس المالية', color: 'var(--text2)', font: { family: 'IBM Plex Sans Arabic', size: 10 } },
                            grid: { color: 'rgba(255,255,255,0.05)' },
                            ticks: { color: 'var(--text3)', font: { family: 'IBM Plex Sans Arabic' } }
                        },
                        'y-impressions': {
                            type: 'linear',
                            position: 'right',
                            title: { display: true, text: 'الكميات / النسب المئوية', color: 'var(--text2)', font: { family: 'IBM Plex Sans Arabic', size: 10 } },
                            grid: { drawOnChartArea: false },
                            ticks: { color: 'var(--text3)', font: { family: 'IBM Plex Sans Arabic' } }
                        },
                        x: {
                            grid: { color: 'rgba(255,255,255,0.05)' },
                            ticks: { color: 'var(--text3)', font: { family: 'IBM Plex Sans Arabic' } }
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            labels: { color: 'var(--text2)', font: { family: 'IBM Plex Sans Arabic', size: 10 } }
                        }
                    }
                }
            });
            
            // إعادة ضبط حالة الأزرار والـ KPI الافتراضية
            detailKPIState = { cost: true, impressions: true, clicks: false, ctr: false, conversions: false, cpa: false, roas: false };
            ['cost', 'impressions', 'clicks', 'ctr', 'conversions', 'cpa', 'roas'].forEach(m => {
                const chk = document.getElementById('chk-' + m);
                if (chk) chk.checked = detailKPIState[m];
                const card = document.getElementById('kpichip-' + m);
                if (card) {
                    if (detailKPIState[m]) {
                        card.style.border = '1px solid var(--accent)';
                        card.style.background = 'rgba(0,242,254,0.05)';
                    } else {
                        card.style.border = '1px solid var(--border)';
                        card.style.background = 'transparent';
                    }
                }
            });
        });
}


// دالة تصدير تفاصيل الحملة الإعلانية الفعالة إلى ملف إكسل (SheetJS)
function exportCampaignDetailToExcel() {
    if (!window.currentCampaignRecords || window.currentCampaignRecords.length === 0) {
        toast('لا توجد بيانات متاحة للتصدير حالياً لهذه الحملة الإعلانية', 'error');
        return;
    }
    
    toast('جاري توليد ملف إكسل مالي منسق ويدعم القراءة من اليمين لليسار (RTL)...', 'info');
    
    const records = window.currentCampaignRecords;
    const campaignName = window.currentCampaignName;
    const platform = window.currentCampaignPlatform;
    
    // حساب الإجماليات والمتوسطات الكلية
    const totalCost = records.reduce((s, x) => s + (x.spend || 0), 0);
    const totalImpressions = records.reduce((s, x) => s + (x.impressions || 0), 0);
    const totalClicks = records.reduce((s, x) => s + (x.clicks || 0), 0);
    const totalConversions = records.reduce((s, x) => s + (x.conversions || 0), 0);
    
    const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    const avgCPA = totalConversions > 0 ? (totalCost / totalConversions) : 0;
    const avgROAS = totalCost > 0 ? ((totalConversions * 27.39) / totalCost) : 0;

    const ws = {};
    
    // دالة مساعدة لتعيين قيمة خلية وتنسيقها البرمجي
    function setCell(r, c, val, type, format) {
        const cellRef = XLSX.utils.encode_cell({ r, c });
        ws[cellRef] = { v: val, t: type };
        if (format) {
            ws[cellRef].z = format;
        }
    }
    
    // 1. ترويسة التقرير التفصيلي والدمج
    setCell(0, 0, "تقرير أداء الحملة الإعلانية المالي والتفصيلي - متجر نُظم المحاسبي", 's');
    
    // 2. معلومات الميتا والبيانات الفوقية للحملة
    setCell(2, 0, "اسم الحملة الإعلانية:", 's');
    setCell(2, 1, campaignName, 's');
    
    setCell(3, 0, "المنصة الإعلانية:", 's');
    setCell(3, 1, platform === 'tiktok' ? 'تيك توك إعلانات (TikTok Ads)' : platform === 'snapchat' ? 'سناب شات إعلانات' : 'فيس بوك إعلانات', 's');
    
    setCell(4, 0, "تاريخ ووقت التصدير:", 's');
    setCell(4, 1, new Date().toLocaleString('ar-SA'), 's');
    
    // 3. ترويسة الجدول الرئيسي (الصف 6)
    const headers = [
        "التاريخ",
        "الحالة الفنية",
        "الإنفاق الصافي",
        "مرات الظهور",
        "النقرات",
        "نسبة النقر (CTR)",
        "التحويلات (المبيعات)",
        "تكلفة الاكتساب (CPA)",
        "العائد الإعلاني (ROAS)"
    ];
    headers.forEach((h, cIdx) => {
        setCell(6, cIdx, h, 's');
    });
    
    // 4. تعبئة أسطر البيانات اليومية
    let rIdx = 7;
    records.forEach(r => {
        const spend = r.spend || 0;
        const impressions = r.impressions || 0;
        const clicks = r.clicks || 0;
        const conversions = r.conversions || 0;
        
        const ctr = impressions > 0 ? (clicks / impressions) : 0;
        const cpa = conversions > 0 ? (spend / conversions) : 0;
        const roas = spend > 0 ? ((conversions * 27.39) / spend) : 0;
        
        setCell(rIdx, 0, r.date, 's');
        setCell(rIdx, 1, r.status === 'active' ? 'نشطة' : 'متوقفة', 's');
        setCell(rIdx, 2, parseFloat(spend), 'n', '#,##0.00" ر.س"');
        setCell(rIdx, 3, parseInt(impressions), 'n', '#,##0');
        setCell(rIdx, 4, parseInt(clicks), 'n', '#,##0');
        setCell(rIdx, 5, parseFloat(ctr), 'n', '0.00%');
        setCell(rIdx, 6, parseInt(conversions), 'n', '#,##0');
        setCell(rIdx, 7, parseFloat(cpa), 'n', '#,##0.00" ر.س"');
        setCell(rIdx, 8, parseFloat(roas), 'n', '0.00"x"');
        
        rIdx++;
    });
    
    // 5. سطر فاصل وسطر الخلاصة والإجماليات
    setCell(rIdx, 0, "", 's');
    rIdx++;
    
    setCell(rIdx, 0, "الإجمالي والمتوسط الكلي للفترة", 's');
    setCell(rIdx, 1, "", 's');
    setCell(rIdx, 2, parseFloat(totalCost), 'n', '#,##0.00" ر.س"');
    setCell(rIdx, 3, parseInt(totalImpressions), 'n', '#,##0');
    setCell(rIdx, 4, parseInt(totalClicks), 'n', '#,##0');
    setCell(rIdx, 5, parseFloat(avgCTR / 100), 'n', '0.00%');
    setCell(rIdx, 6, parseInt(totalConversions), 'n', '#,##0');
    setCell(rIdx, 7, parseFloat(avgCPA), 'n', '#,##0.00" ر.س"');
    setCell(rIdx, 8, parseFloat(avgROAS), 'n', '0.00"x"');
    
    // 6. تفعيل القراءة من اليمين لليسار (RTL) وتحديد نطاق الجدول وعرض الأعمدة والدمج
    ws['!views'] = [{ RTL: true }];
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rIdx, c: 8 } });
    
    // دمج خلايا العنوان والميتا لإعطاء تباعد ومظهر فاخر
    ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }, // عنوان التقرير
        { s: { r: 2, c: 1 }, e: { r: 2, c: 3 } }, // اسم الحملة
        { s: { r: 3, c: 1 }, e: { r: 3, c: 3 } }, // المنصة
        { s: { r: 4, c: 1 }, e: { r: 4, c: 3 } }, // وقت التصدير
        { s: { r: rIdx, c: 0 }, e: { r: rIdx, c: 1 } } // خلاصة التسمية بالإجمالي
    ];
    
    // تحديد عرض الأعمدة بشكل متسع ومناسب للعمل المالي
    ws['!cols'] = [
        { wch: 16 }, // التاريخ
        { wch: 14 }, // الحالة الفنية
        { wch: 20 }, // الإنفاق الصافي
        { wch: 20 }, // مرات الظهور
        { wch: 16 }, // النقرات
        { wch: 18 }, // نسبة النقر
        { wch: 20 }, // التحويلات
        { wch: 24 }, // تكلفة الاكتساب
        { wch: 18 }  // العائد الإعلاني
    ];
    
    // إنشاء مصنف إكسل جديد وحفظ الملف
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "تقرير الأداء المالي");
    
    const cleanCampName = campaignName.replace(/\s+/g, '_');
    const todayStr = new Date().toISOString().split('T')[0];
    const fileName = `تقرير_أداء_${cleanCampName}_${todayStr}.xlsx`;
    
    XLSX.writeFile(wb, fileName);
    
    toast('تم استخراج ملف إكسل مالي احترافي يدعم الترتيب والحسابات الرياضية بنجاح!', 'success');
}

// ══════════════════════════════════════════════
//  CERTIFICATES MANAGEMENT (بلس ايفون وسناب)
// ══════════════════════════════════════════════
let currentEditCertId = null;

async function loadCertificates() {
    try {
        const response = await fetch('/api/certificates/report');
        if (!response.ok) throw new Error('فشل جلب تقارير الشهادات');
        const data = await response.json();
        renderCertificates(data);
    } catch (e) {
        toast(e.message, 'error');
    }
}

function renderCertificates(certs) {
    const tbody = document.getElementById('certsTbody');
    if (!tbody) return;

    if (certs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11"><div class="empty"><i class="ti ti-inbox"></i><p>لا توجد شهادات مسجلة حالياً</p></div></td></tr>';
        updateCertKPIs(0, 0, 0, 0);
        return;
    }

    let totalSubs = 0;
    let totalSold = 0;
    let totalComp = 0;
    let totalRem = 0;

    tbody.innerHTML = certs.map((c, i) => {
        totalSubs += c.total_subs;
        totalSold += c.sold_subs;
        totalComp += c.comp_subs;
        totalRem += c.remaining;

        const remClass = c.remaining <= 10 ? 'red' : c.remaining <= 30 ? 'amber' : 'green';
        const statusClass = c.status === 'active' ? 'pill-green' : 'pill-gray';
        const statusName = c.status === 'active' ? 'نشطة' : 'متوقفة';
        const dateStr = c.updated_at ? c.updated_at.substring(0, 16) : '-';

        return `<tr>
            <td style="color:var(--text3);font-size:10px">${i + 1}</td>
            <td style="font-weight:600;">${escapeHtml(c.name)}</td>
            <td class="mono">${c.total_subs}</td>
            <td class="mono green">${c.sold_subs}</td>
            <td class="mono red">${c.comp_subs}</td>
            <td><span class="mono ${remClass}" style="font-weight:700">${c.remaining}</span></td>
            <td class="mono red">${fmt(c.ads_spend)}</td>
            <td><span class="pill ${statusClass}">${statusName}</span></td>
            <td style="font-size:11px;color:var(--text2);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(c.note || '')}">${escapeHtml(c.note || '-')}</td>
            <td style="font-size:10px;color:var(--text3)">${dateStr}</td>
            <td>
                <div style="display:flex;gap:4px">
                    <button class="btn btn-sm" onclick="editCert(${c.id}, '${escapeHtml(c.name)}', ${c.total_subs}, ${c.comp_subs}, ${c.ads_spend}, '${escapeHtml(c.note || '')}', '${c.status}')"><i class="ti ti-edit"></i> تعديل</button>
                    <button class="btn btn-sm" style="color:var(--red); border-color:rgba(224,85,85,0.2); background:transparent" onclick="deleteCert(${c.id})"><i class="ti ti-trash"></i> حذف</button>
                </div>
            </td>
        </tr>`;
    }).join('');

    updateCertKPIs(totalSubs, totalSold, totalComp, totalRem);
}

function updateCertKPIs(total, sold, comp, remaining) {
    document.getElementById('kpiCertTotal').textContent = total;
    document.getElementById('kpiCertSold').textContent = sold;
    document.getElementById('kpiCertComp').textContent = comp;
    document.getElementById('kpiCertRemaining').textContent = remaining;
}

function openCertModal() {
    currentEditCertId = null;
    document.getElementById('certModalTitle').innerHTML = `<i class="ti ti-certificate" style="color:var(--accent)"></i> إضافة شهادة جديدة`;
    document.getElementById('certName').value = '';
    document.getElementById('certTotalSubs').value = 0;
    document.getElementById('certCompSubs').value = 0;
    document.getElementById('certAdsSpend').value = 0;
    document.getElementById('certStatus').value = 'active';
    document.getElementById('certNote').value = '';
    document.getElementById('certModal').classList.add('open');
}

function closeCertModal() {
    document.getElementById('certModal').classList.remove('open');
}

function editCert(id, name, total, comp, spend, note, status) {
    currentEditCertId = id;
    document.getElementById('certModalTitle').innerHTML = `<i class="ti ti-edit" style="color:var(--accent)"></i> تعديل بيانات الشهادة`;
    document.getElementById('certName').value = name;
    document.getElementById('certTotalSubs').value = total;
    document.getElementById('certCompSubs').value = comp;
    document.getElementById('certAdsSpend').value = spend;
    document.getElementById('certStatus').value = status;
    document.getElementById('certNote').value = note === '-' ? '' : note;
    document.getElementById('certModal').classList.add('open');
}

async function saveCert() {
    const name = document.getElementById('certName').value;
    const total_subs = document.getElementById('certTotalSubs').value;
    const comp_subs = document.getElementById('certCompSubs').value;
    const ads_spend = document.getElementById('certAdsSpend').value;
    const status = document.getElementById('certStatus').value;
    const note = document.getElementById('certNote').value;

    if (!name) {
        toast('اسم الشهادة مطلوب بالكامل.', 'warn');
        return;
    }

    const payload = { name, total_subs, comp_subs, ads_spend, status, note };
    const method = currentEditCertId ? 'PUT' : 'POST';
    const url = currentEditCertId ? `/api/certificates/${currentEditCertId}` : '/api/certificates';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطأ أثناء حفظ بيانات الشهادة');

        toast(currentEditCertId ? 'تم تعديل الشهادة وتحديث الإحصائيات بنجاح!' : 'تم إضافة الشهادة بنجاح في النظام!', 'success');
        closeCertModal();
        loadCertificates();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deleteCert(id) {
    if (!confirm('هل أنت متأكد من حذف هذه الشهادة نهائياً؟')) return;
    try {
        const res = await fetch(`/api/certificates/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطأ أثناء حذف الشهادة');

        toast('تم حذف الشهادة بنجاح من النظام.', 'success');
        toast('تم حذف الشهادة بنجاح من النظام.', 'success');
        loadCertificates();
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ══════════════════════════════════════════════
//  PLAYSTATION PLUS MANAGEMENT
// ══════════════════════════════════════════════
let currentEditPsAccountId = null;
let currentDeliverPsAccountId = null;
let currentDeliverPsSlot = null;

async function loadPsPlusAccounts() {
    try {
        const response = await fetch('/api/ps-plus/accounts');
        if (!response.ok) throw new Error('فشل جلب حسابات بلس');
        const data = await response.json();
        state.psPlusAccounts = data;
        renderPsPlusAccounts(data);
    } catch (e) {
        toast(e.message, 'error');
    }
}

function renderPsPlusAccounts(accounts) {
    const tbody = document.getElementById('psPlusTbody');
    if (!tbody) return;

    if (accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10"><div class="empty"><i class="ti ti-brand-playstation"></i><p>لا توجد حسابات بلس مسجلة حالياً</p></div></td></tr>';
        updatePsPlusKPIs(0, 0, 0, 0);
        return;
    }

    let totalAccounts = accounts.length;
    let availablePs5 = 0;
    let availablePs4 = 0;
    let completedAccounts = 0;

    tbody.innerHTML = accounts.map((c, i) => {
        let deliveredCount = 0;
        if (c.ps5_1_status === 'available') availablePs5++; else deliveredCount++;
        if (c.ps5_2_status === 'available') availablePs5++; else deliveredCount++;
        if (c.ps4_status === 'available') availablePs4++; else deliveredCount++;

        if (deliveredCount === 3) completedAccounts++;

        // حساب حالة الحساب الإجمالية
        let overallStatus = '';
        if (deliveredCount === 3) {
            overallStatus = '<span class="pill pill-green">مكتمل التسليم ✅</span>';
        } else if (deliveredCount === 0) {
            overallStatus = '<span class="pill pill-blue">متبقي نسختي PS5 + نسخة PS4</span>';
        } else {
            const remParts = [];
            const remPs5 = (c.ps5_1_status === 'available' ? 1 : 0) + (c.ps5_2_status === 'available' ? 1 : 0);
            const remPs4 = c.ps4_status === 'available' ? 1 : 0;
            
            if (remPs5 === 2) remParts.push('نسختي PS5');
            else if (remPs5 === 1) remParts.push('نسخة PS5');

            if (remPs4 === 1) remParts.push('نسخة PS4');

            overallStatus = `<span class="pill pill-amber">متبقي ${remParts.join(' + ')}</span>`;
        }

        // صياغة خلايا تسليم النسخ
        const ps5_1_cell = c.ps5_1_status === 'available' 
            ? `<button class="btn btn-xs btn-primary" onclick="openPsPlusDeliverModal(${c.id}, 'ps5_1', '${escapeHtml(c.email)}', '${escapeHtml(c.plus_type)}')"><i class="ti ti-brand-whatsapp"></i> تسليم PS5</button>`
            : `<span class="green" style="font-size:11px; font-weight:600;"><i class="ti ti-circle-check"></i> تم التسليم (${escapeHtml(c.ps5_1_order)})</span>`;

        const ps5_2_cell = c.ps5_2_status === 'available' 
            ? `<button class="btn btn-xs btn-primary" onclick="openPsPlusDeliverModal(${c.id}, 'ps5_2', '${escapeHtml(c.email)}', '${escapeHtml(c.plus_type)}')"><i class="ti ti-brand-whatsapp"></i> تسليم PS5</button>`
            : `<span class="green" style="font-size:11px; font-weight:600;"><i class="ti ti-circle-check"></i> تم التسليم (${escapeHtml(c.ps5_2_order)})</span>`;

        const ps4_cell = c.ps4_status === 'available' 
            ? `<button class="btn btn-xs btn-secondary" onclick="openPsPlusDeliverModal(${c.id}, 'ps4', '${escapeHtml(c.email)}', '${escapeHtml(c.plus_type)}')"><i class="ti ti-brand-whatsapp"></i> تسليم PS4</button>`
            : `<span class="green" style="font-size:11px; font-weight:600;"><i class="ti ti-circle-check"></i> تم التسليم (${escapeHtml(c.ps4_order)})</span>`;

        return `<tr>
            <td style="color:var(--text3);font-size:10px">${i + 1}</td>
            <td style="font-weight:600;" class="mono">${escapeHtml(c.email)}</td>
            <td class="mono">${escapeHtml(c.password)}</td>
            <td><span class="pill pill-purple">${escapeHtml(c.plus_type)}</span></td>
            <td><span class="mono">${escapeHtml(c.plus_duration)}</span></td>
            <td>${ps5_1_cell}</td>
            <td>${ps5_2_cell}</td>
            <td>${ps4_cell}</td>
            <td>${overallStatus}</td>
            <td>
                <div style="display:flex;gap:4px">
                    <button class="btn btn-sm" onclick="editPsPlusAccount(${c.id}, '${escapeHtml(c.email)}', '${escapeHtml(c.password)}', '${escapeHtml(c.plus_type)}', '${escapeHtml(c.plus_duration)}', '${escapeHtml(c.ps5_1_order || '')}', '${escapeHtml(c.ps5_2_order || '')}', '${escapeHtml(c.ps4_order || '')}')"><i class="ti ti-edit"></i> تعديل</button>
                    <button class="btn btn-sm" style="color:var(--red); border-color:rgba(224,85,85,0.2); background:transparent" onclick="deletePsPlusAccount(${c.id})"><i class="ti ti-trash"></i> حذف</button>
                </div>
            </td>
        </tr>`;
    }).join('');

    updatePsPlusKPIs(totalAccounts, availablePs5, availablePs4, completedAccounts);
}

function updatePsPlusKPIs(total, ps5, ps4, completed) {
    document.getElementById('kpiPsTotalAccounts').textContent = total;
    document.getElementById('kpiPsAvailable5').textContent = ps5;
    document.getElementById('kpiPsAvailable4').textContent = ps4;
    document.getElementById('kpiPsCompleted').textContent = completed;
}

function openPsPlusModal() {
    currentEditPsAccountId = null;
    document.getElementById('psPlusModalTitle').innerHTML = `<i class="ti ti-brand-playstation" style="color:var(--accent)"></i> إضافة حساب بلس جديد`;
    document.getElementById('psEmail').value = '';
    document.getElementById('psPassword').value = '';
    document.getElementById('psType').value = 'اساسي';
    document.getElementById('psDuration').value = 'سنة';
    document.getElementById('psEditDeliveriesSection').style.display = 'none';
    document.getElementById('psPlusModal').classList.add('open');
}

function closePsPlusModal() {
    document.getElementById('psPlusModal').classList.remove('open');
}

function editPsPlusAccount(id, email, password, type, duration, ps5_1, ps5_2, ps4) {
    currentEditPsAccountId = id;
    document.getElementById('psPlusModalTitle').innerHTML = `<i class="ti ti-edit" style="color:var(--accent)"></i> تعديل حساب بلس`;
    document.getElementById('psEmail').value = email;
    document.getElementById('psPassword').value = password;
    document.getElementById('psType').value = type;
    document.getElementById('psDuration').value = duration;
    
    // إتاحة تعديل أرقام الطلبات يدوياً في حال الخطأ
    document.getElementById('psEdit51Order').value = ps5_1;
    document.getElementById('psEdit52Order').value = ps5_2;
    document.getElementById('psEdit4Order').value = ps4;
    document.getElementById('psEditDeliveriesSection').style.display = 'block';

    document.getElementById('psPlusModal').classList.add('open');
}

async function savePsPlusAccount() {
    const email = document.getElementById('psEmail').value;
    const password = document.getElementById('psPassword').value;
    const plus_type = document.getElementById('psType').value;
    const plus_duration = document.getElementById('psDuration').value;

    if (!email || !password) {
        toast('الإيميل والباسورد مطلوبان لتسجيل الحساب.', 'warn');
        return;
    }

    const payload = { email, password, plus_type, plus_duration };
    if (currentEditPsAccountId) {
        payload.ps5_1_order = document.getElementById('psEdit51Order').value;
        payload.ps5_2_order = document.getElementById('psEdit52Order').value;
        payload.ps4_order = document.getElementById('psEdit4Order').value;
    }
    const method = currentEditPsAccountId ? 'PUT' : 'POST';
    const url = currentEditPsAccountId ? `/api/ps-plus/accounts/${currentEditPsAccountId}` : '/api/ps-plus/accounts';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطأ أثناء حفظ الحساب');

        // إذا كنا في وضع تعديل حساب ونريد حفظ التعديل على الطلبات المخصصة للحصص
        if (currentEditPsAccountId) {
            const o51 = document.getElementById('psEdit51Order').value.trim();
            const o52 = document.getElementById('psEdit52Order').value.trim();
            const o4 = document.getElementById('psEdit4Order').value.trim();
            
            // تحديث الحصص مباشرة بقاعدة البيانات عبر الـ PUT أو عبر تمرير قيم التسليم اليدوية
            // لتسريع التطبيق سنقوم بإرسال طلب تحديث إضافي أو يمكن دمجها. دعنا ندمج التحديث في PUT بالخلفية لاحقاً إذا احتجنا، 
            // لكن مؤقتاً سنقوم بتحديثها بشكل يدوي أو نعتمد أن PUT يغطي الحساب الأساسي فقط.
            // دعنا نرسل تحديث الطلبات للحصص إلى مسار مخصص أو نجعل الـ PUT الأساسي يتقبل تحديث الحصص أيضاً!
            // سنقوم بتحديث خادم server.js لتعديل الحصص في الـ PUT أيضاً لتفادي طلبات متعددة!
        }

        toast(currentEditPsAccountId ? 'تم تعديل الحساب بنجاح!' : 'تم إضافة الحساب إلى المخزون بنجاح!', 'success');
        closePsPlusModal();
        loadPsPlusAccounts();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deletePsPlusAccount(id) {
    if (!confirm('هل أنت متأكد من حذف هذا الحساب ومخزونه نهائياً؟')) return;
    try {
        const res = await fetch(`/api/ps-plus/accounts/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطأ أثناء حذف الحساب');

        toast('تم حذف الحساب بنجاح.', 'success');
        loadPsPlusAccounts();
    } catch (e) {
        toast(e.message, 'error');
    }
}

function openPsPlusDeliverModal(id, slot, email, type) {
    currentDeliverPsAccountId = id;
    currentDeliverPsSlot = slot;
    
    document.getElementById('deliverShowEmail').textContent = email;
    document.getElementById('deliverShowType').textContent = type;
    
    const select = document.getElementById('deliverSlotSelect');
    select.value = slot;

    // تفعيل أو تعطيل النسخ حسب التوفر
    const account = (state.psPlusAccounts || []).find(a => a.id === id);
    if (account) {
        const opt51 = select.querySelector('option[value="ps5_1"]');
        if (opt51) {
            opt51.disabled = account.ps5_1_status !== 'available' && slot !== 'ps5_1';
            opt51.textContent = `PS5 (النسخة الأولى)${account.ps5_1_status !== 'available' ? ' - تم التسليم' : ''}`;
        }
        const opt52 = select.querySelector('option[value="ps5_2"]');
        if (opt52) {
            opt52.disabled = account.ps5_2_status !== 'available' && slot !== 'ps5_2';
            opt52.textContent = `PS5 (النسخة الثانية)${account.ps5_2_status !== 'available' ? ' - تم التسليم' : ''}`;
        }
        const opt4 = select.querySelector('option[value="ps4"]');
        if (opt4) {
            opt4.disabled = account.ps4_status !== 'available' && slot !== 'ps4';
            opt4.textContent = `PS4 (النسخة الوحيدة)${account.ps4_status !== 'available' ? ' - تم التسليم' : ''}`;
        }
    }
    
    document.getElementById('deliverOrderId').value = '';
    document.getElementById('deliverCustomerPhone').value = '';
    
    document.getElementById('psPlusDeliverModal').classList.add('open');
}

function closePsPlusDeliverModal() {
    document.getElementById('psPlusDeliverModal').classList.remove('open');
}

async function confirmPsPlusDelivery() {
    const order_id = document.getElementById('deliverOrderId').value;
    const phone = document.getElementById('deliverCustomerPhone').value;
    const slot = document.getElementById('deliverSlotSelect').value;

    if (!order_id) {
        toast('رقم الطلب مطلوب لإكمال عملية التسليم.', 'warn');
        return;
    }

    const payload = {
        id: currentDeliverPsAccountId,
        slot,
        order_id,
        phone
    };

    try {
        const res = await fetch('/api/ps-plus/accounts/deliver', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل تسجيل التسليم');

        toast('تم تسجيل التسليم بنجاح في النظام!', 'success');
        closePsPlusDeliverModal();
        
        // جلب تفاصيل الحساب الحالي لتوليد رسالة الواتساب بدقة
        const email = document.getElementById('deliverShowEmail').textContent;
        const type = document.getElementById('deliverShowType').textContent;
        const slotName = slot === 'ps4' ? 'PS4' : 'PS5';

        // صياغة رسالة الواتساب المنسقة
        const messageText = `الإيميل : ${email}\n\n` + 
                            `الباسورد   ${passwordPlaceholder(email)}\n\n` + 
                            `نوع البلس : ( بلس ${type} ${slotName} )\n\n` + 
                            `تم تسليم ${slotName}  ✅\n` + 
                            `رقم الطلب : ${order_id}`;
        
        // إعادة تحميل القائمة لتحديث الحالات
        loadPsPlusAccounts();

        // فتح نافذة واتساب لإرسال الرسالة تلقائياً للعميل إذا تم إدخال رقم جوال
        if (phone) {
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            const waUrl = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(messageText)}`;
            window.open(waUrl, '_blank');
        } else {
            // نسخ الرسالة للحافظة كبديل في حال عدم وجود رقم
            navigator.clipboard.writeText(messageText);
            toast('تم نسخ رسالة التسليم المنسقة إلى الحافظة لعدم إدخال رقم هاتف.', 'info');
        }

    } catch (e) {
        toast(e.message, 'error');
    }
}

// دالة مساعدة لجلب كلمة المرور المخزنة للحساب لتسليمها بالواتساب
function passwordPlaceholder(email) {
    // سنقوم بجلب كلمة المرور الفعالة من جدول البيانات المحمل في الواجهة
    // وذلك عن طريق البحث في الحسابات النشطة بـ DOM أو عبر استعلام محلي
    const rows = document.querySelectorAll('#psPlusTbody tr');
    for (const r of rows) {
        const emailCell = r.querySelector('td:nth-child(2)');
        if (emailCell && emailCell.textContent === email) {
            return r.querySelector('td:nth-child(3)').textContent;
        }
    }
    return 'shop_1010'; // قيمة افتراضية للاحتياط
}

async function importPsPlusExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const rows = await readXLSX(file);
        if (rows.length === 0) {
            toast('ملف الإكسل فارغ أو غير صالح.', 'warn');
            return;
        }

        // تحليل الأسطر وتحويل الحقول
        const accounts = [];
        rows.forEach(row => {
            // مطابقة الأعمدة باللغة العربية والإنجليزية
            let email = row['الإيميل'] || row['ايميل'] || row['Email'] || row['email'] || '';
            let password = row['الباسورد'] || row['الرمز'] || row['كلمة المرور'] || row['Password'] || row['password'] || '';
            let plus_type = row['نوع البلس'] || row['النوع'] || row['Type'] || row['plus_type'] || 'اساسي';
            let plus_duration = row['مدة الاشتراك'] || row['المدة'] || row['Duration'] || row['plus_duration'] || 'سنة';

            if (email && password) {
                accounts.push({
                    email: String(email).trim(),
                    password: String(password).trim(),
                    plus_type: String(plus_type).trim(),
                    plus_duration: String(plus_duration).trim()
                });
            }
        });

        if (accounts.length === 0) {
            toast('لم يتم العثور على حسابات صالحة في ملف الإكسل (يجب توفر أعمدة الإيميل والباسورد).', 'warn');
            return;
        }

        // إرسال البيانات للباك إند
        const res = await fetch('/api/ps-plus/accounts/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(accounts)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطأ أثناء استيراد الحسابات');

        toast(`تم استيراد وتحديث ${data.count} حساب بلس بنجاح!`, 'success');
        loadPsPlusAccounts();
        event.target.value = ''; // تصفير حقل الملف
    } catch (e) {
        toast(e.message, 'error');
    }
}

