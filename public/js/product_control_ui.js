/**
 * Product Control Center (مركز التحكم بالمنتج) - Frontend Module
 * Single Source of Truth: Backend APIs (/api/product-control)
 * Zero business logic or financial calculations in JS.
 */

window.ProductControlUI = (function() {
    'use strict';

    // State for Products List Page (#page-product-control)
    const listState = {
        page: 1,
        limit: 15,
        q: '',
        status: 'all',
        from: '',
        to: '',
        shortcut: 'all',
        loading: false,
        data: [],
        pagination: { total: 0, count: 0, per_page: 15, current_page: 1, total_pages: 1 }
    };

    // State for Product Detail Page (#page-product-control-detail)
    const detailState = {
        productId: null,
        product: null,
        activeTab: 'overview',
        from: '',
        to: '',
        shortcut: 'all',
        loading: false,
        tabs: {
            sales: { page: 1, limit: 10, data: [], pagination: {} },
            purchases: { page: 1, limit: 10, data: [], pagination: {} },
            inventory: { page: 1, limit: 10, data: [], pagination: {} },
            expenses: { page: 1, limit: 10, data: [], pagination: {} },
            timeline: { page: 1, limit: 15, data: [], pagination: {} }
        }
    };

    // Helper: Number formatting
    function fmtSAR(amount) {
        if (amount === null || amount === undefined || isNaN(amount)) return null;
        return new Intl.NumberFormat('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' ر.س';
    }

    function fmtInt(num) {
        if (num === null || num === undefined || isNaN(num)) return '0';
        return new Intl.NumberFormat('ar-SA').format(num);
    }

    function fmtDate(dateStr) {
        if (!dateStr) return '—';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            return d.toLocaleString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return dateStr;
        }
    }

    // Helper: Date range shortcuts
    function getDateShortcutRange(shortcut) {
        const today = new Date();
        const formatDate = (d) => d.toISOString().split('T')[0];
        
        let from = '';
        let to = formatDate(today);

        if (shortcut === 'today') {
            from = to;
        } else if (shortcut === '7days') {
            const d = new Date(today);
            d.setDate(d.getDate() - 6);
            from = formatDate(d);
        } else if (shortcut === '30days') {
            const d = new Date(today);
            d.setDate(d.getDate() - 29);
            from = formatDate(d);
        } else if (shortcut === 'this_month') {
            const d = new Date(today.getFullYear(), today.getMonth(), 1);
            from = formatDate(d);
        } else if (shortcut === 'all') {
            from = '';
            to = '';
        }
        return { from, to };
    }

    // Helper: Status badge translation
    function getStatusBadge(status) {
        const badges = {
            'normal': '<span class="pill pill-green"><i class="ti ti-check"></i> عادي</span>',
            'needs_inventory': '<span class="pill pill-amber"><i class="ti ti-alert-circle"></i> يحتاج جرد</span>',
            'low_stock': '<span class="pill pill-amber"><i class="ti ti-box"></i> مخزون منخفض</span>',
            'out_of_stock': '<span class="pill pill-red"><i class="ti ti-x"></i> نفذ المخزون</span>',
            'reorder_needed': '<span class="pill pill-cyan"><i class="ti ti-refresh"></i> يلزم إعادة طلب</span>',
            'purchase_stopped': '<span class="pill pill-red"><i class="ti ti-barrier-block"></i> موقوف للشراء</span>',
            'under_review': '<span class="pill pill-amber"><i class="ti ti-search"></i> تحت المراجعة</span>'
        };
        return badges[status] || `<span class="pill pill-light">${status || '—'}</span>`;
    }

    // Helper: API response error handler
    async function handleApiResponse(response) {
        if (response.status === 401) {
            if (window.toast) window.toast('انتهت الجلسة. يرجى إعادة تسجيل الدخول.', 'err');
            setTimeout(() => { window.location.href = 'login.html'; }, 1500);
            throw new Error('UNAUTHORIZED');
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const errCode = data.code || `HTTP_${response.status}`;
            const errMsg = data.error || data.message || 'حدث خطأ أثناء التواصل مع السيرفر';
            if (response.status === 403) {
                if (window.toast) window.toast('ليس لديك صلاحية لتنفيذ هذا الإجراء.', 'err');
            } else {
                if (window.toast) window.toast(errMsg, 'err');
            }
            const err = new Error(errMsg);
            err.code = errCode;
            err.status = response.status;
            err.details = data.details;
            throw err;
        }
        return data;
    }

    // =========================================================================
    // PAGE 1: PRODUCTS MONITORING LIST (#page-product-control)
    // =========================================================================

    async function loadProductsList(page = 1) {
        listState.page = page;
        listState.loading = true;

        const tbody = document.getElementById('pcTableBody');
        const loadingEl = document.getElementById('pcTableLoading');
        const emptyEl = document.getElementById('pcTableEmpty');
        const errorEl = document.getElementById('pcTableError');

        if (loadingEl) loadingEl.style.display = 'flex';
        if (tbody) tbody.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';

        const searchEl = document.getElementById('pcSearch');
        const statusEl = document.getElementById('pcStatusFilter');
        const fromEl = document.getElementById('pcFilterFrom');
        const toEl = document.getElementById('pcFilterTo');

        if (searchEl) listState.q = searchEl.value.trim();
        if (statusEl) listState.status = statusEl.value;
        if (fromEl) listState.from = fromEl.value;
        if (toEl) listState.to = toEl.value;

        try {
            let url = `/api/product-control/catalog`;
            const params = [];
            if (listState.q) params.push(`search=${encodeURIComponent(listState.q)}`);
            if (listState.status && listState.status !== 'all') params.push(`status=${encodeURIComponent(listState.status)}`);
            if (params.length > 0) url += `?${params.join('&')}`;

            const res = await fetch(url);
            const resData = await handleApiResponse(res);

            listState.data = resData.data || [];
            listState.loading = false;

            renderProductsListTable();
            renderProductsListKPIs();

            if (loadingEl) loadingEl.style.display = 'none';

            if (listState.data.length === 0) {
                if (emptyEl) emptyEl.style.display = 'flex';
            } else {
                if (tbody) tbody.style.display = '';
            }
        } catch (err) {
            listState.loading = false;
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) {
                errorEl.style.display = 'block';
                errorEl.textContent = `فشل تحميل الكتالوج: ${err.message}`;
            }
        }
    }

    function renderProductsListKPIs() {
        const totalItems = listState.data.length;
        const familiesCount = listState.data.filter(item => item.type === 'FAMILY').length;
        const standalonesCount = listState.data.filter(item => item.type === 'STANDALONE').length;

        const kpiTotal = document.getElementById('pcKpiTotal');
        const kpiNeedsInv = document.getElementById('pcKpiNeedsInv');
        const kpiLowStock = document.getElementById('pcKpiLowStock');
        const kpiWarnings = document.getElementById('pcKpiWarnings');

        if (kpiTotal) kpiTotal.textContent = fmtInt(totalItems);
        if (kpiNeedsInv) kpiNeedsInv.textContent = fmtInt(familiesCount) + ' عائلات';
        if (kpiLowStock) kpiLowStock.textContent = fmtInt(standalonesCount) + ' مستقلة';
        if (kpiWarnings) kpiWarnings.textContent = '0';
    }

    function renderProductsListTable() {
        const tbody = document.getElementById('pcTableBody');
        if (!tbody) return;

        tbody.innerHTML = listState.data.map(item => {
            if (item.type === 'FAMILY') {
                const totalStock = (item.variants || []).reduce((acc, v) => acc + (v.quantity || 0), 0);
                const durationBadges = '<span class="pill pill-cyan">شهري</span> <span class="pill pill-cyan">3 أشهر</span> <span class="pill pill-cyan">سنوي</span>';
                
                return `
                    <tr style="background: rgba(45, 125, 210, 0.04);">
                        <td>
                            <div style="font-weight:700; color:var(--accent); font-size:13.5px; display:flex; align-items:center; gap:6px;">
                                <i class="ti ti-folders" style="font-size:16px;"></i> ${item.product_name}
                            </div>
                            <div style="font-size:10.5px; color:var(--text3); margin-top:2px;">عائلة منتجات تشمل 3 مدد اشتراك</div>
                        </td>
                        <td class="mono">
                            <span style="font-weight:600;">${item.family_code || item.sku}</span><br>
                            <div style="margin-top:2px;">${durationBadges}</div>
                        </td>
                        <td>${getStatusBadge(item.status)}</td>
                        <td class="mono">
                            <strong style="color:var(--accent); font-size:14px;">${fmtInt(totalStock)}</strong> <span style="font-size:10px; color:var(--text3);">(مجموع المدد)</span>
                        </td>
                        <td style="font-size:11px;">مقسم بالمدد</td>
                        <td style="font-size:11px;">مقسم بالمدد</td>
                        <td class="mono">—</td>
                        <td class="mono green" style="font-weight:600;">تجميعي</td>
                        <td class="mono red">—</td>
                        <td class="mono red">—</td>
                        <td><span class="pill pill-green"><i class="ti ti-check"></i> عائلة مفعلة</span></td>
                        <td>
                            <button class="btn btn-sm btn-primary" onclick="ProductControlUI.openFamilyDetail(${item.id})">
                                <i class="ti ti-folders"></i> تفاصيل العائلة
                            </button>
                        </td>
                    </tr>
                `;
            } else {
                // STANDALONE product
                const currentQty = fmtInt(item.quantity);
                const warningHtml = item.variance_warning 
                    ? `<span class="pill pill-amber"><i class="ti ti-alert-triangle"></i> فارق</span>` 
                    : `<span class="pill pill-green"><i class="ti ti-check"></i> مطابق</span>`;

                return `
                    <tr>
                        <td>
                            <div style="font-weight:600; color:var(--text);">${item.product_name || 'منتج مستقل'}</div>
                            <div style="font-size:10px; color:var(--text3);">منتج مستقل (Standalone)</div>
                        </td>
                        <td class="mono">${item.sku || '<span style="color:var(--text3)">بدون SKU</span>'}</td>
                        <td>${getStatusBadge(item.current_control_status || item.status)}</td>
                        <td class="mono">
                            <strong style="color:var(--text);">${currentQty}</strong>
                        </td>
                        <td style="font-size:11px;">${item.last_inventory_count_at ? fmtDate(item.last_inventory_count_at) : '—'}</td>
                        <td style="font-size:11px;">${item.last_purchase_at ? fmtDate(item.last_purchase_at) : '—'}</td>
                        <td class="mono">${fmtInt(item.sales_qty_since_last_purchase || 0)}</td>
                        <td class="mono green" style="font-weight:600;">${fmtSAR(item.price_sar) || '—'}</td>
                        <td class="mono red">—</td>
                        <td class="mono red">—</td>
                        <td>${warningHtml}</td>
                        <td>
                            <button class="btn btn-sm btn-outline-primary" onclick="ProductControlUI.openProductDetail(${item.id})">
                                <i class="ti ti-eye"></i> التفاصيل
                            </button>
                        </td>
                    </tr>
                `;
            }
        }).join('');
    }

    function renderProductsListPagination() {
        const el = document.getElementById('pcPagination');
        if (!el) return;
        el.style.display = 'none';
    }

    function setListShortcut(shortcut) {
        listState.shortcut = shortcut;
        const range = getDateShortcutRange(shortcut);
        listState.from = range.from;
        listState.to = range.to;

        const fromInput = document.getElementById('pcFilterFrom');
        const toInput = document.getElementById('pcFilterTo');
        if (fromInput) fromInput.value = range.from;
        if (toInput) toInput.value = range.to;

        document.querySelectorAll('.pc-shortcut-btn').forEach(btn => {
            if (btn.dataset.shortcut === shortcut) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        loadProductsList(1);
    }

    // =========================================================================
    // PAGE 2: PRODUCT DETAIL DASHBOARD & FAMILY DASHBOARD (#page-product-control-detail)
    // =========================================================================

    async function openFamilyDetail(familyId, duration = 'all') {
        detailState.isFamily = true;
        detailState.familyId = familyId;
        detailState.duration = duration || 'all';
        detailState.activeTab = 'overview';
        if (window.nav) window.nav('product-control-detail');
        await loadFamilyDetail();
    }

    async function selectFamilyDuration(durationCode) {
        detailState.duration = durationCode;
        loadFamilyDetail();
    }

    async function loadFamilyDetail() {
        detailState.loading = true;

        const loadingEl = document.getElementById('pcdLoading');
        const contentEl = document.getElementById('pcdContent');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (contentEl) contentEl.style.display = 'none';

        try {
            let url = `/api/product-control/families/${detailState.familyId}/details?duration=${detailState.duration}`;
            if (detailState.from) url += `&from=${encodeURIComponent(detailState.from)}`;
            if (detailState.to) url += `&to=${encodeURIComponent(detailState.to)}`;

            const res = await fetch(url);
            const resData = await handleApiResponse(res);
            const data = resData.data;

            detailState.familyData = data;
            detailState.loading = false;

            renderFamilyDetailHeader(data);

            if (data.selected_duration === 'ALL') {
                renderFamilyDetailAggregatedMetrics(data);
            } else if (data.selected_variant) {
                detailState.productId = data.selected_variant.variant_id;
                detailState.productData = data.selected_variant.detail;
                detailState.product = data.selected_variant.detail.product;

                const breakSec = document.getElementById('pcdDurationBreakdownSection');
                if (breakSec) breakSec.style.display = 'none';

                renderProductDetailOverviewKPIs();
            }

            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl) contentEl.style.display = 'block';

            switchTab(detailState.activeTab);
        } catch (err) {
            detailState.loading = false;
            if (loadingEl) loadingEl.style.display = 'none';
            if (window.toast) window.toast(`فشل جلب تفاصيل العائلة: ${err.message}`, 'err');
        }
    }

    function renderFamilyDetailHeader(data) {
        const f = data.family || {};
        const titleEl = document.getElementById('pcdTitle');
        const skuEl = document.getElementById('pcdSku');
        const sallaIdEl = document.getElementById('pcdSallaId');
        const badgeEl = document.getElementById('pcdStatusBadge');
        const durBar = document.getElementById('pcdDurationSelectorBar');

        if (titleEl) titleEl.textContent = f.family_name || 'عائلة المنتجات';
        if (skuEl) skuEl.textContent = `رمز العائلة: ${f.family_code || '—'}`;
        if (sallaIdEl) sallaIdEl.textContent = `منصة: ${f.platform} | باقة: ${f.tier}`;
        if (badgeEl) badgeEl.innerHTML = getStatusBadge(f.status || 'normal');

        if (durBar) {
            durBar.style.display = 'flex';
            const buttons = durBar.querySelectorAll('.pcd-duration-btn');
            const targetDur = (data.selected_duration || 'all').toLowerCase();
            buttons.forEach(btn => {
                if (btn.dataset.duration === targetDur) {
                    btn.classList.add('active', 'btn-primary');
                    btn.classList.remove('btn-outline-secondary');
                } else {
                    btn.classList.remove('active', 'btn-primary');
                    btn.classList.add('btn-outline-secondary');
                }
            });
        }
    }

    function renderFamilyDetailAggregatedMetrics(data) {
        const m = data.summary_metrics || {};
        const isIncomplete = m.is_incomplete_cogs;

        const noticeEl = document.getElementById('pcdCogsNotice');
        if (noticeEl) {
            noticeEl.style.display = isIncomplete ? 'flex' : 'none';
        }

        const elExpectedStock = document.getElementById('pcdKpiExpectedStock');
        const elLastInventory = document.getElementById('pcdKpiLastInventory');
        const elVariance = document.getElementById('pcdKpiVariance');
        const elLastPurchase = document.getElementById('pcdKpiLastPurchase');
        const elSalesSincePurchase = document.getElementById('pcdKpiSalesSincePurchase');
        const elSalesSinceInv = document.getElementById('pcdKpiSalesSinceInv');

        if (elExpectedStock) elExpectedStock.textContent = `${fmtInt(m.total_stock)} قطعة (مجموع العائلة)`;
        if (elLastInventory) elLastInventory.textContent = 'محدد بكل مدة';
        if (elVariance) elVariance.innerHTML = '<span class="green"><i class="ti ti-check"></i> تفصيلي بالمدد</span>';
        if (elLastPurchase) elLastPurchase.textContent = `${fmtSAR(m.total_purchases_sar)}`;
        if (elSalesSincePurchase) elSalesSincePurchase.textContent = `${fmtInt(m.total_units_sold)} قطعة مباعة`;
        if (elSalesSinceInv) elSalesSinceInv.textContent = `${fmtInt(m.total_units_sold)} قطعة`;

        const elRevenue = document.getElementById('pcdKpiRevenue');
        const elPurchases = document.getElementById('pcdKpiPurchases');
        const elCogs = document.getElementById('pcdKpiCogs');
        const elGrossProfit = document.getElementById('pcdKpiGrossProfit');
        const elAdExpense = document.getElementById('pcdKpiAdExpense');
        const elOtherExpense = document.getElementById('pcdKpiOtherExpense');
        const elNetProfit = document.getElementById('pcdKpiNetProfit');

        if (elRevenue) elRevenue.textContent = fmtSAR(m.total_revenue_sar) || '0.00 ر.س';
        if (elPurchases) elPurchases.textContent = fmtSAR(m.total_purchases_sar) || '0.00 ر.س';
        if (elCogs) elCogs.innerHTML = isIncomplete ? '<span class="text-amber">غير مكتمل</span>' : fmtSAR(m.total_cogs_sar);
        if (elGrossProfit) elGrossProfit.innerHTML = isIncomplete ? '<span class="text-amber">غير مكتمل</span>' : fmtSAR(m.gross_profit_sar);
        if (elAdExpense) elAdExpense.textContent = fmtSAR(m.advertising_expenses_sar) || '0.00 ر.س';
        if (elOtherExpense) elOtherExpense.textContent = fmtSAR(m.other_expenses_sar) || '0.00 ر.س';
        if (elNetProfit) elNetProfit.innerHTML = isIncomplete ? '<span class="text-amber">غير مكتمل</span>' : fmtSAR(m.net_profit_sar);

        const breakSec = document.getElementById('pcdDurationBreakdownSection');
        const breakBody = document.getElementById('pcdDurationBreakdownBody');
        if (breakSec && breakBody) {
            breakSec.style.display = 'block';
            breakBody.innerHTML = (data.breakdown || []).map(b => `
                <tr>
                    <td><span class="pill pill-cyan">${b.duration_label}</span></td>
                    <td style="font-weight:600;">${b.product_name}</td>
                    <td class="mono"><strong>${fmtInt(b.stock)}</strong></td>
                    <td class="mono">${fmtSAR(b.unit_cost_sar) || '—'}</td>
                    <td class="mono">${fmtSAR(b.unit_price_sar) || '—'}</td>
                    <td class="mono">${fmtInt(b.sold_count)}</td>
                    <td class="mono green">${fmtSAR(b.revenue_sar)}</td>
                    <td>${b.cogs_status === 'UNAVAILABLE' ? '<span class="pill pill-amber">غير موثق</span>' : '<span class="pill pill-green">مكتمل</span>'}</td>
                    <td class="mono green" style="font-weight:600;">${b.cogs_status === 'UNAVAILABLE' ? '—' : fmtSAR(b.net_profit_sar)}</td>
                    <td>${getStatusBadge(b.control_status)}</td>
                </tr>
            `).join('');
        }
    }

    async function openProductDetail(productId) {
        detailState.isFamily = false;
        detailState.productId = productId;
        detailState.activeTab = 'overview';
        const durBar = document.getElementById('pcdDurationSelectorBar');
        if (durBar) durBar.style.display = 'none';
        const breakSec = document.getElementById('pcdDurationBreakdownSection');
        if (breakSec) breakSec.style.display = 'none';

        if (window.nav) window.nav('product-control-detail');
        await loadProductDetail();
    }

    async function loadProductDetail() {
        if (!detailState.productId) {
            const storedId = sessionStorage.getItem('detail_product_id');
            if (storedId) {
                detailState.productId = parseInt(storedId, 10);
            } else {
                try {
                    const resList = await fetch('/api/product-control/catalog');
                    const listData = await handleApiResponse(resList);
                    const firstProd = listData.data && listData.data[0];
                    if (firstProd && firstProd.id) {
                        if (firstProd.type === 'FAMILY') {
                            openFamilyDetail(firstProd.id);
                            return;
                        }
                        detailState.productId = firstProd.id;
                    } else {
                        if (window.nav) window.nav('product-control');
                        return;
                    }
                } catch (e) {
                    if (window.nav) window.nav('product-control');
                    return;
                }
            }
        }
        if (detailState.productId) {
            sessionStorage.setItem('detail_product_id', detailState.productId);
        }
        detailState.loading = true;

        const loadingEl = document.getElementById('pcdLoading');
        const contentEl = document.getElementById('pcdContent');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (contentEl) contentEl.style.display = 'none';

        try {
            let url = `/api/product-control/products/${detailState.productId}`;
            const params = [];
            if (detailState.from) params.push(`from=${encodeURIComponent(detailState.from)}`);
            if (detailState.to) params.push(`to=${encodeURIComponent(detailState.to)}`);
            if (params.length > 0) url += `?${params.join('&')}`;

            const res = await fetch(url);
            const productData = await handleApiResponse(res);

            detailState.productData = productData;
            detailState.product = productData.product || productData.data?.product || productData;
            detailState.loading = false;

            renderProductDetailHeader();
            renderProductDetailOverviewKPIs();

            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl) contentEl.style.display = 'block';

            switchTab(detailState.activeTab);
        } catch (err) {
            detailState.loading = false;
            if (loadingEl) loadingEl.style.display = 'none';
            if (window.toast) window.toast(`فشل جلب تفاصيل المنتج: ${err.message}`, 'err');
        }
    }

    function renderProductDetailHeader() {
        const details = detailState.productData || {};
        const p = details.product || detailState.product || {};
        if (!p || (!p.id && !p.product_name)) return;

        const titleEl = document.getElementById('pcdTitle');
        const skuEl = document.getElementById('pcdSku');
        const sallaIdEl = document.getElementById('pcdSallaId');
        const badgeEl = document.getElementById('pcdStatusBadge');

        if (titleEl) titleEl.textContent = p.product_name || 'منتج';
        if (skuEl) skuEl.textContent = p.sku ? `SKU: ${p.sku}` : 'بدون SKU';
        if (sallaIdEl) sallaIdEl.textContent = p.salla_product_id ? `Salla ID: ${p.salla_product_id}` : '';
        if (badgeEl) badgeEl.innerHTML = getStatusBadge(p.current_control_status || p.status);
    }

    function renderProductDetailOverviewKPIs() {
        const details = detailState.productData || {};
        const p = details.product || detailState.product || {};
        const m = details.metrics || {};

        const cogsUnavailable = details.cogs_status === 'UNAVAILABLE';

        // Render COGS Notice Banner
        const noticeEl = document.getElementById('pcdCogsNotice');
        if (noticeEl) {
            noticeEl.style.display = cogsUnavailable ? 'flex' : 'none';
        }

        // Summary Cards
        const elExpectedStock = document.getElementById('pcdKpiExpectedStock');
        const elLastInventory = document.getElementById('pcdKpiLastInventory');
        const elVariance = document.getElementById('pcdKpiVariance');
        const elLastPurchase = document.getElementById('pcdKpiLastPurchase');
        const elSalesSincePurchase = document.getElementById('pcdKpiSalesSincePurchase');
        const elSalesSinceInv = document.getElementById('pcdKpiSalesSinceInv');

        const currentQty = m.actual_stock !== undefined ? m.actual_stock : (p.quantity || 0);
        const expectedQty = m.current_expected_stock !== undefined ? m.current_expected_stock : (p.expected_stock || 0);

        if (elExpectedStock) elExpectedStock.textContent = `${fmtInt(currentQty)} / ${fmtInt(expectedQty)} قطعة`;

        const lastInv = m.last_inventory;
        if (elLastInventory) {
            elLastInventory.textContent = lastInv ? `${fmtInt(lastInv.actual_qty)} (${fmtDate(lastInv.inventory_at)})` : 'لم يتم الجرد بعد';
        }
        if (elVariance) {
            const v = lastInv ? lastInv.variance : 0;
            elVariance.innerHTML = v === 0 
                ? '<span class="green"><i class="ti ti-check"></i> 0 (مطابق)</span>' 
                : `<span class="red"><i class="ti ti-alert-triangle"></i> ${v} (فارق)</span>`;
        }

        const lastPur = m.last_purchase;
        if (elLastPurchase) {
            elLastPurchase.textContent = lastPur ? `${fmtInt(lastPur.quantity)} قطعة @ ${fmtSAR(lastPur.unit_cost_sar) || '—'}` : 'لا يوجد شراء سابق';
        }
        if (elSalesSincePurchase) elSalesSincePurchase.textContent = `${fmtInt(m.sold_since_last_purchase || 0)} قطعة`;
        if (elSalesSinceInv) elSalesSinceInv.textContent = `${fmtInt(m.sold_since_last_inventory || 0)} قطعة`;

        // Financial Cards
        const elRevenue = document.getElementById('pcdKpiRevenue');
        const elPurchases = document.getElementById('pcdKpiPurchases');
        const elCogs = document.getElementById('pcdKpiCogs');
        const elGrossProfit = document.getElementById('pcdKpiGrossProfit');
        const elAdExpense = document.getElementById('pcdKpiAdExpense');
        const elOtherExpense = document.getElementById('pcdKpiOtherExpense');
        const elNetProfit = document.getElementById('pcdKpiNetProfit');

        const purchasesList = (details.history && details.history.purchases) || [];
        const totalPurAmount = purchasesList.reduce((acc, item) => acc + (item.total_amount_halalas || 0), 0) / 100;

        const salesMovements = (details.history && details.history.stock_movements) || [];
        const totalSalesAmount = salesMovements
            .filter(mov => mov.movement_type === 'SALE')
            .reduce((acc, mov) => acc + Math.abs(mov.quantity) * (p.price_sar || 0), 0);

        if (elRevenue) elRevenue.textContent = fmtSAR(totalSalesAmount) || '0.00 ر.س';
        if (elPurchases) elPurchases.textContent = fmtSAR(totalPurAmount) || '0.00 ر.س';

        if (elCogs) {
            elCogs.innerHTML = cogsUnavailable 
                ? '<span class="text-amber"><i class="ti ti-help"></i> تكلفة البضاعة المباعة غير مكتملة</span>' 
                : fmtSAR(details.unit_cogs_sar) || '0.00 ر.س';
        }
        if (elGrossProfit) {
            elGrossProfit.innerHTML = cogsUnavailable 
                ? '<span class="text-amber"><i class="ti ti-help"></i> غير مكتمل محاسبيًا</span>' 
                : fmtSAR(details.gross_profit_sar) || '0.00 ر.س';
        }

        const expAllocations = (details.history && details.history.expense_allocations) || [];
        const adExp = expAllocations.filter(a => a.allocation_type === 'ADVERTISING').reduce((acc, a) => acc + (a.allocated_amount_halalas || 0), 0) / 100;
        const otherExp = expAllocations.filter(a => a.allocation_type === 'OTHER').reduce((acc, a) => acc + (a.allocated_amount_halalas || 0), 0) / 100;

        if (elAdExpense) elAdExpense.textContent = fmtSAR(adExp) || '0.00 ر.س';
        if (elOtherExpense) elOtherExpense.textContent = fmtSAR(otherExp) || '0.00 ر.س';

        if (elNetProfit) {
            elNetProfit.innerHTML = cogsUnavailable 
                ? '<span class="text-amber"><i class="ti ti-help"></i> غير مكتمل محاسبيًا</span>' 
                : fmtSAR(details.net_profit_sar) || '0.00 ر.س';
        }
    }

    function setDetailShortcut(shortcut) {
        detailState.shortcut = shortcut;
        const range = getDateShortcutRange(shortcut);
        detailState.from = range.from;
        detailState.to = range.to;

        const fromInput = document.getElementById('pcdFilterFrom');
        const toInput = document.getElementById('pcdFilterTo');
        if (fromInput) fromInput.value = range.from;
        if (toInput) toInput.value = range.to;

        document.querySelectorAll('.pcd-shortcut-btn').forEach(btn => {
            if (btn.dataset.shortcut === shortcut) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        loadProductDetail();
    }

    // =========================================================================
    // TABS MANAGEMENT & RENDERING
    // =========================================================================

    function switchTab(tabName) {
        detailState.activeTab = tabName;

        document.querySelectorAll('.pcd-tab-btn').forEach(btn => {
            if (btn.dataset.tab === tabName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        document.querySelectorAll('.pcd-tab-content').forEach(pane => {
            if (pane.id === `pcdTab_${tabName}`) {
                pane.style.display = 'block';
            } else {
                pane.style.display = 'none';
            }
        });

        // Trigger tab specific loader
        if (tabName === 'sales') loadTabSales(1);
        if (tabName === 'purchases') loadTabPurchases(1);
        if (tabName === 'inventory') loadTabInventory(1);
        if (tabName === 'expenses') loadTabExpenses(1);
        if (tabName === 'profitability') renderTabProfitability();
        if (tabName === 'timeline') loadTabTimeline(1);
    }

    // 1. Sales Tab
    async function loadTabSales(page = 1) {
        if (!detailState.productId) return;
        const tab = detailState.tabs.sales;
        tab.page = page;

        const tbody = document.getElementById('pcdSalesBody');
        const loadingEl = document.getElementById('pcdSalesLoading');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (tbody) tbody.style.display = 'none';

        try {
            let url = `/api/product-control/products/${detailState.productId}/sales?page=${tab.page}&limit=${tab.limit}`;
            if (detailState.from) url += `&from=${encodeURIComponent(detailState.from)}`;
            if (detailState.to) url += `&to=${encodeURIComponent(detailState.to)}`;

            const res = await fetch(url);
            const resData = await handleApiResponse(res);

            tab.data = resData.data || [];
            tab.pagination = resData.pagination || {};

            if (loadingEl) loadingEl.style.display = 'none';
            if (tbody) tbody.style.display = '';

            tbody.innerHTML = tab.data.map(s => `
                <tr>
                    <td class="mono"><strong>#${s.salla_order_reference_id}</strong></td>
                    <td style="font-size:11px;">${fmtDate(s.sale_at)}</td>
                    <td class="mono">${fmtInt(s.quantity)}</td>
                    <td class="mono green">${fmtSAR(s.total_sar)}</td>
                    <td><span class="pill pill-green">${s.order_status || 'مكتمل'}</span></td>
                </tr>
            `).join('');

            if (tab.data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text3); padding:20px;">لا توجد مبيعات في هذه الفترة</td></tr>`;
            }

            renderTabPagination('pcdSalesPagination', tab.pagination, (p) => loadTabSales(p));
        } catch (err) {
            if (loadingEl) loadingEl.style.display = 'none';
        }
    }

    // 2. Purchases Tab
    async function loadTabPurchases(page = 1) {
        if (!detailState.productId) return;
        const tab = detailState.tabs.purchases;
        tab.page = page;

        const tbody = document.getElementById('pcdPurchasesBody');
        const loadingEl = document.getElementById('pcdPurchasesLoading');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (tbody) tbody.style.display = 'none';

        try {
            let url = `/api/product-control/products/${detailState.productId}/purchases?page=${tab.page}&limit=${tab.limit}`;
            if (detailState.from) url += `&from=${encodeURIComponent(detailState.from)}`;
            if (detailState.to) url += `&to=${encodeURIComponent(detailState.to)}`;

            const res = await fetch(url);
            const resData = await handleApiResponse(res);

            tab.data = resData.data || [];
            tab.pagination = resData.pagination || {};

            if (loadingEl) loadingEl.style.display = 'none';
            if (tbody) tbody.style.display = '';

            tbody.innerHTML = tab.data.map(p => `
                <tr>
                    <td class="mono">#${p.purchase_id}</td>
                    <td>${p.supplier_name || 'مورد غير محدد'}</td>
                    <td style="font-size:11px;">${fmtDate(p.purchase_at)}</td>
                    <td class="mono">${fmtInt(p.quantity)}</td>
                    <td class="mono">${fmtSAR(p.unit_cost_sar)}</td>
                    <td class="mono blue" style="font-weight:600;">${fmtSAR(p.total_cost_sar)}</td>
                </tr>
            `).join('');

            if (tab.data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text3); padding:20px;">لا توجد عمليات شراء في هذه الفترة</td></tr>`;
            }

            renderTabPagination('pcdPurchasesPagination', tab.pagination, (p) => loadTabPurchases(p));
        } catch (err) {
            if (loadingEl) loadingEl.style.display = 'none';
        }
    }

    // 3. Inventory Counts Tab
    async function loadTabInventory(page = 1) {
        if (!detailState.productId) return;
        const tab = detailState.tabs.inventory;
        tab.page = page;

        const tbody = document.getElementById('pcdInventoryBody');
        const loadingEl = document.getElementById('pcdInventoryLoading');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (tbody) tbody.style.display = 'none';

        try {
            let url = `/api/product-control/products/${detailState.productId}/inventory-counts?page=${tab.page}&limit=${tab.limit}`;
            if (detailState.from) url += `&from=${encodeURIComponent(detailState.from)}`;
            if (detailState.to) url += `&to=${encodeURIComponent(detailState.to)}`;

            const res = await fetch(url);
            const resData = await handleApiResponse(res);

            tab.data = resData.data || [];
            tab.pagination = resData.pagination || {};

            if (loadingEl) loadingEl.style.display = 'none';
            if (tbody) tbody.style.display = '';

            tbody.innerHTML = tab.data.map(inv => {
                const v = inv.variance_qty || 0;
                const vBadge = v === 0 
                    ? '<span class="pill pill-green">0 (مطابق)</span>' 
                    : `<span class="pill pill-red">${v > 0 ? '+' : ''}${v}</span>`;

                return `
                    <tr>
                        <td style="font-size:11px;">${fmtDate(inv.counted_at)}</td>
                        <td class="mono"><strong>${fmtInt(inv.actual_qty)}</strong></td>
                        <td class="mono">${fmtInt(inv.expected_qty_at_count)}</td>
                        <td>${vBadge}</td>
                        <td>${inv.notes || '—'}</td>
                        <td style="font-size:11px;">${inv.created_by_username || 'النظام'}</td>
                    </tr>
                `;
            }).join('');

            if (tab.data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text3); padding:20px;">لا يوجد سجل جرد تاريخي لهذا المنتج</td></tr>`;
            }

            renderTabPagination('pcdInventoryPagination', tab.pagination, (p) => loadTabInventory(p));
        } catch (err) {
            if (loadingEl) loadingEl.style.display = 'none';
        }
    }

    // 4. Expenses Allocation Tab
    async function loadTabExpenses(page = 1) {
        if (!detailState.productId) return;
        const tab = detailState.tabs.expenses;
        tab.page = page;

        const tbody = document.getElementById('pcdExpensesBody');
        const loadingEl = document.getElementById('pcdExpensesLoading');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (tbody) tbody.style.display = 'none';

        try {
            let url = `/api/product-control/products/${detailState.productId}/expenses?page=${tab.page}&limit=${tab.limit}`;
            if (detailState.from) url += `&from=${encodeURIComponent(detailState.from)}`;
            if (detailState.to) url += `&to=${encodeURIComponent(detailState.to)}`;

            const res = await fetch(url);
            const resData = await handleApiResponse(res);

            tab.data = resData.data || [];
            tab.pagination = resData.pagination || {};

            if (loadingEl) loadingEl.style.display = 'none';
            if (tbody) tbody.style.display = '';

            tbody.innerHTML = tab.data.map(e => `
                <tr>
                    <td>
                        <span class="pill ${e.allocation_type === 'ADVERTISING' ? 'pill-cyan' : 'pill-amber'}">
                            ${e.allocation_type === 'ADVERTISING' ? 'تسويق / إعلانات' : 'مصروفات أخرى'}
                        </span>
                    </td>
                    <td>${e.desc || e.platform_name || 'مصروف'}</td>
                    <td class="mono">${fmtSAR(e.original_expense_amt_sar)}</td>
                    <td class="mono red" style="font-weight:600;">${fmtSAR(e.allocated_amt_sar)}</td>
                    <td class="mono">${fmtSAR(e.remaining_amt_sar)}</td>
                    <td style="font-size:11px;">${e.period || '—'}</td>
                </tr>
            `).join('');

            if (tab.data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text3); padding:20px;">لا توجد مصروفات مخصصة لهذا المنتج في هذه الفترة</td></tr>`;
            }

            renderTabPagination('pcdExpensesPagination', tab.pagination, (p) => loadTabExpenses(p));
        } catch (err) {
            if (loadingEl) loadingEl.style.display = 'none';
        }
    }

    // 5. Profitability Breakdown Tab
    function renderTabProfitability() {
        const p = detailState.product;
        if (!p) return;

        const container = document.getElementById('pcdProfitabilityContainer');
        if (!container) return;

        const cogsUnavailable = p.cogs_status === 'UNAVAILABLE';

        container.innerHTML = `
            <div class="tbl-wrap" style="padding:16px; background:rgba(17, 21, 32, 0.6); border:1px solid var(--border);">
                <h4 style="margin-bottom:16px; color:var(--accent); font-size:14px; font-weight:700;">
                    <i class="ti ti-calculator"></i> قائمة تحليل الربحية وتكاليف المنتج
                </h4>

                ${cogsUnavailable ? `
                    <div class="alert alert-amber mb-3" style="font-size:12px;">
                        <i class="ti ti-alert-triangle"></i> <strong>حالة تكلفة البضاعة المباعة (COGS): غير مكتملة محاسبيًا</strong><br>
                        لم يتم تعيين تكلفة شراء أصلية أو جرد موثق لهذا المنتج، وبالتالي لا يتم عرض أرقام افتراضية أو صفرية مؤكدة للأرباح حتى استكمال المدخلات.
                    </div>
                ` : ''}

                <table style="width:100%; border-collapse:collapse; font-size:13px;">
                    <tbody>
                        <tr style="border-bottom:1px solid var(--border2);">
                            <td style="padding:10px 0; font-weight:600;">(+) إجمالي المبيعات (Revenue)</td>
                            <td class="mono green" style="text-align:left; font-weight:700; font-size:14px;">${fmtSAR(p.total_sales_sar) || '0.00 ر.س'}</td>
                        </tr>
                        <tr style="border-bottom:1px solid var(--border2);">
                            <td style="padding:10px 0; color:var(--text2);">(-) تكلفة البضاعة المباعة (COGS)</td>
                            <td class="mono red" style="text-align:left; font-weight:600;">
                                ${cogsUnavailable ? '<span class="text-amber"><i class="ti ti-help"></i> غير مكتمل</span>' : fmtSAR(p.total_cogs_sar)}
                            </td>
                        </tr>
                        <tr style="border-bottom:2px solid var(--accent); background:rgba(255,255,255,0.02);">
                            <td style="padding:12px 0; font-weight:700; color:var(--text);">(=) إجمالي الربح (Gross Profit)</td>
                            <td class="mono" style="text-align:left; font-weight:700; font-size:15px;">
                                ${cogsUnavailable ? '<span class="text-amber"><i class="ti ti-help"></i> غير مكتمل</span>' : fmtSAR(p.gross_profit_sar)}
                            </td>
                        </tr>
                        <tr style="border-bottom:1px solid var(--border2);">
                            <td style="padding:10px 0; color:var(--text2);">(-) المصروفات الإعلانية الموزعة (Ad Expense)</td>
                            <td class="mono red" style="text-align:left;">${fmtSAR(p.allocated_ad_expense_sar) || '0.00 ر.س'}</td>
                        </tr>
                        <tr style="border-bottom:1px solid var(--border2);">
                            <td style="padding:10px 0; color:var(--text2);">(-) المصروفات الأخرى الموزعة (Other Expenses)</td>
                            <td class="mono red" style="text-align:left;">${fmtSAR(p.allocated_other_expense_sar) || '0.00 ر.س'}</td>
                        </tr>
                        <tr style="background:rgba(61, 186, 126, 0.05); font-weight:700;">
                            <td style="padding:14px 0; font-size:15px; color:var(--green);">(=) صافي الربح النهائي (Net Profit)</td>
                            <td class="mono green" style="text-align:left; font-weight:700; font-size:17px;">
                                ${cogsUnavailable ? '<span class="text-amber"><i class="ti ti-help"></i> غير مكتمل</span>' : fmtSAR(p.net_profit_sar)}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        `;
    }

    // 6. Timeline Events Tab
    async function loadTabTimeline(page = 1) {
        if (!detailState.productId) return;
        const tab = detailState.tabs.timeline;
        tab.page = page;

        const container = document.getElementById('pcdTimelineContainer');
        const loadingEl = document.getElementById('pcdTimelineLoading');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (container) container.style.display = 'none';

        try {
            let url = `/api/product-control/products/${detailState.productId}/timeline?page=${tab.page}&limit=${tab.limit}`;
            if (detailState.from) url += `&from=${encodeURIComponent(detailState.from)}`;
            if (detailState.to) url += `&to=${encodeURIComponent(detailState.to)}`;

            const res = await fetch(url);
            const resData = await handleApiResponse(res);

            tab.data = resData.data || [];
            tab.pagination = resData.pagination || {};

            if (loadingEl) loadingEl.style.display = 'none';
            if (container) container.style.display = 'block';

            container.innerHTML = tab.data.map(ev => {
                let details = '';
                try {
                    const parsed = JSON.parse(ev.details_json || '{}');
                    details = Object.entries(parsed).map(([k, v]) => `<strong>${k}:</strong> ${v}`).join(' | ');
                } catch (e) {
                    details = ev.details_json || '';
                }

                const iconMap = {
                    'INVENTORY': '<i class="ti ti-clipboard-check text-amber"></i>',
                    'PURCHASE': '<i class="ti ti-shopping-cart text-blue"></i>',
                    'SALE': '<i class="ti ti-cash text-green"></i>',
                    'RETURN': '<i class="ti ti-rotate-clockwise text-red"></i>',
                    'EXPENSE': '<i class="ti ti-receipt text-red"></i>',
                    'STATUS': '<i class="ti ti-tag text-purple"></i>'
                };

                return `
                    <div style="display:flex; gap:12px; padding:12px 0; border-bottom:1px solid var(--border2); align-items:flex-start;">
                        <div style="font-size:18px; margin-top:2px;">${iconMap[ev.event_type] || '<i class="ti ti-circle-dot"></i>'}</div>
                        <div style="flex:1;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <strong style="font-size:13px; color:var(--text);">${ev.title || ev.event_type}</strong>
                                <span style="font-size:10px; color:var(--text3);">${fmtDate(ev.event_at)}</span>
                            </div>
                            <div style="font-size:11px; color:var(--text2); margin-top:4px;">${details}</div>
                            <div style="font-size:10px; color:var(--text3); margin-top:2px;">بواسطة: ${ev.created_by || 'النظام'}</div>
                        </div>
                    </div>
                `;
            }).join('');

            if (tab.data.length === 0) {
                container.innerHTML = `<div style="text-align:center; color:var(--text3); padding:20px;">لا يوجد سجل زمني أحداث لهذه الفترة</div>`;
            }

            renderTabPagination('pcdTimelinePagination', tab.pagination, (p) => loadTabTimeline(p));
        } catch (err) {
            if (loadingEl) loadingEl.style.display = 'none';
        }
    }

    function renderTabPagination(containerId, pagination, callback) {
        const el = document.getElementById(containerId);
        if (!el) return;

        if (!pagination || !pagination.total_pages || pagination.total_pages <= 1) {
            el.style.display = 'none';
            return;
        }
        el.style.display = 'flex';

        const cur = pagination.current_page || 1;
        const totalP = pagination.total_pages || 1;

        el.innerHTML = `
            <button class="btn btn-sm btn-outline-secondary" ${cur <= 1 ? 'disabled' : ''} onclick="(${callback.toString()})(${cur - 1})">
                <i class="ti ti-chevron-right"></i> السابق
            </button>
            <span style="font-size:11px; color:var(--text2);">صفحة ${cur} من ${totalP}</span>
            <button class="btn btn-sm btn-outline-secondary" ${cur >= totalP ? 'disabled' : ''} onclick="(${callback.toString()})(${cur + 1})">
                التالي <i class="ti ti-chevron-left"></i>
            </button>
        `;
    }

    // =========================================================================
    // MODALS & ACTIONS (Inventory, Pre-purchase Invoice, Expense Allocation)
    // =========================================================================

    // 1. Add Inventory Count Modal
    function openAddInventoryModal() {
        if (!detailState.productId) return;
        const m = document.getElementById('pcAddInventoryModal');
        if (!m) return;

        document.getElementById('pcInvActualQty').value = '';
        document.getElementById('pcInvCountedAt').value = new Date().toISOString().substring(0, 16);
        document.getElementById('pcInvNotes').value = '';

        m.classList.add('open');
    }

    function closeAddInventoryModal() {
        const m = document.getElementById('pcAddInventoryModal');
        if (m) m.classList.remove('open');
    }

    async function submitAddInventory() {
        const actualQty = parseInt(document.getElementById('pcInvActualQty').value);
        const countedAt = document.getElementById('pcInvCountedAt').value;
        const notes = document.getElementById('pcInvNotes').value.trim();

        if (isNaN(actualQty) || actualQty < 0) {
            if (window.toast) window.toast('يرجى تقديم كمية فعلية صالحة والجرد لا يكون بالسالب.', 'warn');
            return;
        }

        try {
            const res = await fetch('/api/product-control/inventory-counts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    product_id: detailState.productId,
                    actual_qty: actualQty,
                    counted_at: countedAt,
                    notes: notes
                })
            });

            await handleApiResponse(res);

            if (window.toast) window.toast('تم تسجيل عملية الجرد بنجاح!', 'ok');
            closeAddInventoryModal();

            // Refresh Product Details & Lists
            await loadProductDetail();
            await loadProductsList(listState.page);
        } catch (err) {
            // Handled in handleApiResponse
        }
    }

    // 2. Add Purchase Invoice Modal (Pre-purchase check & Multi-item form)
    async function openAddPurchaseModal() {
        if (!detailState.productId) return;
        const m = document.getElementById('pcAddPurchaseModal');
        if (!m) return;

        // Run Pre-purchase Check
        const checkEl = document.getElementById('pcPrePurchaseCheckResult');
        const submitBtn = document.getElementById('pcSubmitPurchaseBtn');
        if (checkEl) checkEl.innerHTML = '<div style="font-size:11px; color:var(--text3);"><i class="ti ti-reload spinner"></i> جاري تفقد جاهزية المنتج لشراء جديد...</div>';
        if (submitBtn) submitBtn.disabled = true;

        m.classList.add('open');

        try {
            const res = await fetch(`/api/product-control/pre-purchase-check?product_id=${detailState.productId}`);
            const checkData = await handleApiResponse(res);

            if (!checkData.allowed) {
                const blocking = (checkData.blocking_reasons || []).map(r => `<li>${r}</li>`).join('');
                const hasInventoryReason = (checkData.blocking_reasons || []).some(r => r.includes('جرد'));
                const inventoryBtnHtml = hasInventoryReason ? `
                    <div style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.1); padding-top:8px;">
                        <button type="button" class="btn btn-xs btn-amber" style="display:inline-flex; align-items:center; gap:6px; font-weight:600;" onclick="ProductControlUI.closeAddPurchaseModal(); ProductControlUI.openAddInventoryModal();">
                            <i class="ti ti-clipboard-check"></i> إجراء جرد افتتاحي للمنتج الآن (فك حظر الشراء)
                        </button>
                    </div>
                ` : '';

                if (checkEl) {
                    checkEl.innerHTML = `
                        <div class="alert alert-red" style="font-size:11.5px; margin-bottom:12px;">
                            <i class="ti ti-barrier-block"></i> <strong>الشراء ممنوع حاليًا للمنتج لتطبيق قواعد ضبط الجودة:</strong>
                            <ul style="margin:4px 0 0 16px; padding:0;">${blocking}</ul>
                            ${inventoryBtnHtml}
                        </div>
                    `;
                }
                if (submitBtn) submitBtn.disabled = true;
            } else {
                let warningHtml = '';
                if (checkData.warnings && checkData.warnings.length > 0) {
                    const warnList = checkData.warnings.map(w => `<li>${w}</li>`).join('');
                    warningHtml = `
                        <div class="alert alert-amber" style="font-size:11.5px; margin-bottom:12px;">
                            <i class="ti ti-alert-triangle"></i> <strong>تنبيهات إدارية قبل الشراء:</strong>
                            <ul style="margin:4px 0 0 16px; padding:0;">${warnList}</ul>
                        </div>
                    `;
                } else {
                    warningHtml = `
                        <div class="alert alert-green" style="font-size:11.5px; margin-bottom:12px;">
                            <i class="ti ti-check"></i> <strong>جاهزية الإنتاج والشراء مؤكدة للمنتج.</strong>
                        </div>
                    `;
                }
                if (checkEl) checkEl.innerHTML = warningHtml;
                if (submitBtn) submitBtn.disabled = false;
            }
        } catch (err) {
            if (checkEl) checkEl.innerHTML = `<div class="alert alert-red" style="font-size:11.5px;">فشل تفقد الجاهزية: ${err.message}</div>`;
        }

        // Reset Form Inputs
        document.getElementById('pcPurchSupplier').value = '';
        document.getElementById('pcPurchDate').value = new Date().toISOString().substring(0, 16);
        
        // Populate Product Items Row
        const itemsContainer = document.getElementById('pcPurchItemsContainer');
        if (itemsContainer) {
            itemsContainer.innerHTML = `
                <div class="purch-item-row" style="display:grid; grid-template-columns: 2fr 1fr 1fr; gap:8px; margin-bottom:8px;">
                    <input type="text" value="${detailState.product ? detailState.product.product_name : ''}" readonly style="background:var(--bg3);">
                    <input type="number" class="pc-purch-qty" placeholder="الكمية" min="1" value="1">
                    <input type="number" step="0.01" class="pc-purch-cost" placeholder="سعر الوحدة ر.س" min="0">
                </div>
            `;
        }
    }

    function closeAddPurchaseModal() {
        const m = document.getElementById('pcAddPurchaseModal');
        if (m) m.classList.remove('open');
    }

    async function submitAddPurchase() {
        const supplier = document.getElementById('pcPurchSupplier').value.trim();
        const purchaseAt = document.getElementById('pcPurchDate').value;
        const qty = parseInt(document.querySelector('.pc-purch-qty')?.value);
        const unitCost = parseFloat(document.querySelector('.pc-purch-cost')?.value);

        if (isNaN(qty) || qty <= 0 || isNaN(unitCost) || unitCost < 0) {
            if (window.toast) window.toast('يرجى كتابة كمية وسعر وحدة صحيحين.', 'warn');
            return;
        }

        try {
            const res = await fetch('/api/product-control/purchases', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    supplier_name: supplier || 'مورد محلي',
                    purchase_at: purchaseAt,
                    items: [
                        {
                            product_id: detailState.productId,
                            quantity: qty,
                            unit_cost_sar: unitCost
                        }
                    ]
                })
            });

            await handleApiResponse(res);

            if (window.toast) window.toast('تم تسجيل فاتورة الشراء وتحديث متوسط التكلفة WAC بنجاح!', 'ok');
            closeAddPurchaseModal();

            // Refresh Details & List
            await loadProductDetail();
            await loadProductsList(listState.page);
        } catch (err) {
            // Handled
        }
    }

    // 3. Allocate Expense Modal
    async function openAllocateExpenseModal() {
        if (!detailState.productId) return;
        const m = document.getElementById('pcAllocateExpenseModal');
        if (!m) return;

        const sel = document.getElementById('pcAllocExpenseSel');
        if (sel) sel.innerHTML = '<option value="">جاري تحميل المصروفات المتوفرة...</option>';

        m.classList.add('open');

        try {
            const res = await fetch('/api/expenses');
            const expenses = await res.json();

            if (sel) {
                if (!expenses || expenses.length === 0) {
                    sel.innerHTML = '<option value="">لا توجد مصروفات مسجلة للنظام</option>';
                } else {
                    sel.innerHTML = expenses.map(e => `
                        <option value="${e.id}">#${e.id} - ${e.desc || e.cat} (${fmtSAR(e.amt)}) - ${e.date}</option>
                    `).join('');
                }
            }
        } catch (err) {
            if (sel) sel.innerHTML = '<option value="">فشل جلب المصروفات</option>';
        }

        document.getElementById('pcAllocAmount').value = '';
    }

    function closeAllocateExpenseModal() {
        const m = document.getElementById('pcAllocateExpenseModal');
        if (m) m.classList.remove('open');
    }

    async function submitAllocateExpense() {
        const expenseId = parseInt(document.getElementById('pcAllocExpenseSel').value);
        const allocType = document.getElementById('pcAllocTypeSel').value;
        const amount = parseFloat(document.getElementById('pcAllocAmount').value);

        if (!expenseId || isNaN(amount) || amount <= 0) {
            if (window.toast) window.toast('يرجى اختيار مصروف وإدخال مبلغ تخصيص صالح.', 'warn');
            return;
        }

        try {
            const res = await fetch('/api/product-control/expenses/allocate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    expense_id: expenseId,
                    product_id: detailState.productId,
                    amount_sar: amount,
                    allocation_type: allocType
                })
            });

            await handleApiResponse(res);

            if (window.toast) window.toast('تم تخصيص المصروف للمنتج بنجاح!', 'ok');
            closeAllocateExpenseModal();

            // Refresh Details
            await loadProductDetail();
        } catch (err) {
            // Handled
        }
    }

    // =========================================================================
    // MODAL: CREATE MANUAL PRODUCT
    // =========================================================================

    function openCreateProductModal() {
        const modal = document.getElementById('pcCreateProductModal');
        if (modal) modal.classList.add('open');

        const nameEl = document.getElementById('pcNewProductName');
        const skuEl = document.getElementById('pcNewProductSku');
        const sallaIdEl = document.getElementById('pcNewSallaId');
        const qtyEl = document.getElementById('pcNewOpeningQty');
        const costEl = document.getElementById('pcNewCost');
        const priceEl = document.getElementById('pcNewPrice');
        const statusEl = document.getElementById('pcNewStatus');

        if (nameEl) nameEl.value = '';
        if (skuEl) skuEl.value = '';
        if (sallaIdEl) sallaIdEl.value = '';
        if (qtyEl) qtyEl.value = '0';
        if (costEl) costEl.value = '';
        if (priceEl) priceEl.value = '';
        if (statusEl) statusEl.value = 'normal';
    }

    function closeCreateProductModal() {
        const modal = document.getElementById('pcCreateProductModal');
        if (modal) modal.classList.remove('open');
    }

    async function submitCreateProduct() {
        const nameEl = document.getElementById('pcNewProductName');
        const skuEl = document.getElementById('pcNewProductSku');
        const sallaIdEl = document.getElementById('pcNewSallaId');
        const qtyEl = document.getElementById('pcNewOpeningQty');
        const costEl = document.getElementById('pcNewCost');
        const priceEl = document.getElementById('pcNewPrice');
        const statusEl = document.getElementById('pcNewStatus');

        const product_name = nameEl ? nameEl.value.trim() : '';
        if (!product_name) {
            if (window.toast) window.toast('اسم المنتج مطلوب.', 'warn');
            return;
        }

        const payload = {
            product_name,
            sku: skuEl ? skuEl.value.trim() : '',
            salla_product_id: sallaIdEl ? sallaIdEl.value.trim() : '',
            opening_quantity: qtyEl ? parseInt(qtyEl.value, 10) || 0 : 0,
            cost: costEl ? parseFloat(costEl.value) || 0 : 0,
            price: priceEl ? parseFloat(priceEl.value) || 0 : 0,
            status: statusEl ? statusEl.value : 'normal'
        };

        try {
            const res = await fetch('/api/product-control/products', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const resData = await handleApiResponse(res);
            if (resData.success) {
                if (window.toast) window.toast(resData.message || 'تم إضافة المنتج بنجاح!', 'ok');
                closeCreateProductModal();
                loadProductsList(1);
            }
        } catch (err) {
            console.error('Create product error:', err);
        }
    }

    // Export public methods
    return {
        loadProductsList,
        setListShortcut,
        openFamilyDetail,
        selectFamilyDuration,
        openProductDetail,
        loadProductDetail,
        setDetailShortcut,
        switchTab,
        loadTabSales,
        loadTabPurchases,
        loadTabInventory,
        loadTabExpenses,
        loadTabTimeline,
        openAddInventoryModal,
        closeAddInventoryModal,
        submitAddInventory,
        openAddPurchaseModal,
        closeAddPurchaseModal,
        submitAddPurchase,
        openAllocateExpenseModal,
        closeAllocateExpenseModal,
        submitAllocateExpense,
        openCreateProductModal,
        closeCreateProductModal,
        submitCreateProduct
    };
})();
