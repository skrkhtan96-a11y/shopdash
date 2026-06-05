const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, 'public', 'js', 'app.js');
let appContent = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');

// 1. Replace PS5_PRICING_CATALOG and handleProductPricingChange
const oldCatalogAndHandler = `const PS5_PRICING_CATALOG = {
    essential: {
        'شهري': { purchase: 34, selling: 23 },
        '3 أشهر': { purchase: 87, selling: 50 },
        'سنة': { purchase: 245, selling: 135 }
    },
    extra: {
        'شهري': { purchase: 52, selling: 37 },
        '3 أشهر': { purchase: 143, selling: 85 },
        'سنة': { purchase: 406, selling: 195 }
    },
    premium: {
        'شهري': { purchase: 61, selling: 48 },
        '3 أشهر': { purchase: 166, selling: 115 },
        'سنة': { purchase: 469, selling: 265 }
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
        
        if (elQty && (!elQty.value || elQty.value === '0')) elQty.value = '1';
        if (elPurchase) elPurchase.value = pricing.purchase.toString();
        if (elSelling) elSelling.value = pricing.selling.toString();
        
        recalcPurchaseAmt();
    }
}`;

const newCatalogAndHandler = `const PS5_PRICING_CATALOG = {
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
}`;

// 2. Replace stock split logic in renderProducts()
const oldStockSplit = `                if (isPs5Plus) {
                    // 3 نسخ PS5
                    if (!map[name]) {
                        map[name] = { name, soldCount: 0, totalRevenue: 0, purchasedCount: 0, avgCost: 0, sellingPrice: 0 };
                    }
                    map[name].purchasedCount += qty * 2;
                    if (e.purchase_price) map[name].avgCost = e.purchase_price;
                    if (e.selling_price) map[name].sellingPrice = e.selling_price;
                    
                    // نسخة PS4
                    const ps4Name = name.replace('PS5', 'PS4');
                    if (!map[ps4Name]) {
                        map[ps4Name] = { name: ps4Name, soldCount: 0, totalRevenue: 0, purchasedCount: 0, avgCost: 0, sellingPrice: 0 };
                    }
                    map[ps4Name].purchasedCount += qty * 1;
                    if (e.purchase_price && !map[ps4Name].avgCost) map[ps4Name].avgCost = e.purchase_price;
                    if (e.selling_price && !map[ps4Name].sellingPrice) map[ps4Name].sellingPrice = e.selling_price;
                }`;

const newStockSplit = `                if (isPs5Plus) {
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
                }`;

// 3. Replace stock split logic in openProductAdjustmentModal()
const oldModalSplit = `                if (isPs5Plus) {
                    if (name === productName) {
                        purchased += qty * 2;
                    } else if (name.replace('PS5', 'PS4') === productName) {
                        purchased += qty * 1;
                    }
                }`;

const newModalSplit = `                if (isPs5Plus) {
                    const numPackages = qty / 3;
                    if (name === productName) {
                        purchased += Math.round(numPackages * 2);
                    } else if (name.replace('PS5', 'PS4') === productName) {
                        purchased += Math.round(numPackages * 1);
                    }
                }`;

// 4. Replace profit calculation in updateExpensesDashboard()
const oldProfitCalc = `    // 2. الأرباح من المشتريات (سعر البيع - سعر الشراء) مضروباً في الكمية
    const purchasesProfit = filtered.filter(e => e.cat === 'شراء منتجات').reduce((s, e) => {
        const qty = parseInt(e.quantity) || 1;
        const buy = parseFloat(e.purchase_price) || 0;
        const sell = parseFloat(e.selling_price) || 0;
        return s + (sell > 0 ? (qty * (sell - buy)) : 0);
    }, 0);`;

const newProfitCalc = `    // 2. الأرباح من المشتريات (سعر البيع - سعر الشراء) مضروباً في الكمية
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
    }, 0);`;

let updated = appContent;

if (updated.includes(oldCatalogAndHandler)) {
    updated = updated.replace(oldCatalogAndHandler, newCatalogAndHandler);
    console.log("Replaced Pricing Catalog and handler.");
} else {
    console.error("ERROR: Pricing Catalog not found!");
}

if (updated.includes(oldStockSplit)) {
    updated = updated.replace(oldStockSplit, newStockSplit);
    console.log("Replaced Stock Split inside renderProducts.");
} else {
    console.error("ERROR: Stock Split in renderProducts not found!");
}

if (updated.includes(oldModalSplit)) {
    updated = updated.replace(oldModalSplit, newModalSplit);
    console.log("Replaced Stock Split inside Modal.");
} else {
    console.error("ERROR: Stock Split in Modal not found!");
}

if (updated.includes(oldProfitCalc)) {
    updated = updated.replace(oldProfitCalc, newProfitCalc);
    console.log("Replaced Profit calculation in Dashboard.");
} else {
    console.error("ERROR: Profit Calculation in Dashboard not found!");
}

fs.writeFileSync(appJsPath, updated, 'utf8');
console.log("SUCCESS: app.js successfully updated for quantity default and exact calculation!");
