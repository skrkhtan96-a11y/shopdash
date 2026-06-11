const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateMcp } = require('../middlewares/auth');
const SallaService = require('../services/salla.service');

const mcpSessions = new Map();
const syncSallaOrdersToLocal = SallaService.syncOrders;

// --- Claude AI Live Data Endpoint ---
router.get('/live-data', async (req, res) => {
    const token = req.query.token;
    const expectedToken = process.env.AI_API_TOKEN || 'claude_ai_secret_123';
    if (token !== expectedToken) {
        return res.status(401).json({ error: 'غير مصرح بالدخول. رمز الأمان خاطئ.' });
    }
    
    try {
        db.all("SELECT * FROM expenses", [], (errExp, expenses) => {
            if (errExp) return res.status(500).json({ error: errExp.message });
            
            db.all("SELECT * FROM salla_imported_orders", [], (errSales, sales) => {
                if (errSales) return res.status(500).json({ error: errSales.message });
                
                db.all("SELECT * FROM product_adjustments", [], (errAdj, adjustments) => {
                    if (errAdj) return res.status(500).json({ error: errAdj.message });
                    
                    db.all("SELECT * FROM salla_imported_wallet", [], (errWallet, wallet) => {
                        if (errWallet) return res.status(500).json({ error: errWallet.message });
                        
                        db.all("SELECT * FROM ads_campaign_metrics", [], (errAds, ads) => {
                            if (errAds) return res.status(500).json({ error: errAds.message });
                            
                            const totalExpenses = expenses.reduce((s, e) => s + (e.amt || 0), 0);
                            const totalRevenue = sales.reduce((s, o) => s + (o.amount || 0), 0);
                            const netProfit = totalRevenue - totalExpenses;
                            
                            const map = {};
                            sales.forEach(o => {
                                const name = (o.product_name || 'غير معروف').trim();
                                if (!map[name]) {
                                    map[name] = { name, sold: 0, revenue: 0, purchased: 0, cost: 0, stock: 0 };
                                }
                                map[name].sold += o.quantity || 1;
                                map[name].revenue += o.amount || 0;
                            });
                            
                            expenses.forEach(e => {
                                if (e.cat === 'شراء منتجات' && e.product_name) {
                                    const name = e.product_name.trim();
                                    if (!map[name]) {
                                        map[name] = { name, sold: 0, revenue: 0, purchased: 0, cost: 0, stock: 0 };
                                    }
                                    map[name].purchased += e.quantity || 0;
                                    if (e.purchase_price) map[name].cost = e.purchase_price;
                                }
                            });
                            
                            adjustments.forEach(a => {
                                const name = (a.product_name || '').trim();
                                if (!map[name]) {
                                    map[name] = { name, sold: 0, revenue: 0, purchased: 0, cost: 0, stock: 0 };
                                }
                                if (a.cost > 0) map[name].cost = a.cost;
                            });
                            
                            const inventory = Object.values(map).map(p => {
                                const adj = adjustments.find(a => a.product_name === p.name) || { stock_offset: 0 };
                                const stock = p.purchased - p.sold + adj.stock_offset;
                                return {
                                    product_name: p.name,
                                    quantity_purchased: p.purchased,
                                    quantity_sold: p.sold,
                                    remaining_stock: stock,
                                    unit_cost_sar: p.cost,
                                    total_revenue_sar: p.revenue
                                };
                            });

                            const totalAdSpend = ads.reduce((s, a) => s + (a.spend || 0), 0);
                            const totalAdConversions = ads.reduce((s, a) => s + (a.conversions || 0), 0);
                            
                            res.json({
                                store_name: "شوب ستور - لوحة تحكم المحاسبة الذكية",
                                financial_summary: {
                                    total_revenue_sar: totalRevenue,
                                    total_expenses_sar: totalExpenses,
                                    total_ad_spend_sar: totalAdSpend,
                                    net_profit_sar: netProfit,
                                    wallet_total_operations: wallet.length
                                },
                                recent_orders_count: sales.length,
                                inventory_status: inventory,
                                ads_summary: {
                                    total_ad_spend_sar: totalAdSpend,
                                    total_conversions: totalAdConversions,
                                    campaigns_count: ads.length,
                                    campaigns_list: ads.map(a => ({
                                        campaign_id: a.campaign_id,
                                        campaign_name: a.campaign_name,
                                        platform: a.platform,
                                        status: a.status,
                                        spend_sar: a.spend,
                                        clicks: a.clicks,
                                        impressions: a.impressions,
                                        conversions: a.conversions,
                                        date: a.date
                                    }))
                                },
                                expenses_breakdown: expenses.map(e => ({
                                    description: e.desc,
                                    category: e.cat,
                                    amount_sar: e.amt,
                                    date: e.date,
                                    notes: e.note
                                  }))
                            });
                        });
                    });
                });
            });
        });
    } catch (err) {
        res.status(500).json({ error: 'فشل تجميع البيانات للذكاء الاصطناعي', details: err.message });
    }
});

// --- MCP SSE Stream Initialization handler ---
const handleMcpStream = (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
    });
    
    const sessionId = Math.random().toString(36).substring(2, 15);
    console.log(`[MCP] New Claude AI session established: ${sessionId}`);
    
    mcpSessions.set(sessionId, res);
    
    const token = req.query.token || '';
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    res.write(`event: endpoint\ndata: https://shop.nuzum.sbs/api/mcp?sessionId=${sessionId}${tokenParam}\n\n`);
    
    req.on('close', () => {
        console.log(`[MCP] Claude session closed: ${sessionId}`);
        mcpSessions.delete(sessionId);
    });
};

// --- MCP Message Handler (JSON-RPC) ---
const handleMcpMessage = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');

    const { sessionId } = req.query;
    const message = req.body;
    const { jsonrpc, id, method, params } = message;
    
    console.log(`[MCP] Request from Claude [Session ${sessionId || 'Sync-Direct'}]:`, method);
    
    let result = null;
    let error = null;
    
    if (method === 'initialize') {
        result = {
            protocolVersion: '2024-11-05',
            capabilities: {
                tools: {}
            },
            serverInfo: {
                name: 'shopdashboard-mcp',
                version: '1.1.0'
            }
        };
    } else if (method === 'tools/list') {
        result = {
            tools: [
                {
                    name: 'get_financial_summary',
                    description: 'جلب الملخص المالي الكامل للمتجر من مبيعات سلة والمصروفات وصافي الأرباح والعمليات المالية',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'get_inventory_status',
                    description: 'جلب جرد المخزون وحالته الفعلية والقطع المشتراة والمباعة وتكلفة القطع وإيراداتها المالية لكل منتج',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'get_expenses_list',
                    description: 'جلب قائمة المصروفات الكاملة المسجلة بالنظام (تشمل الرواتب، التسويق، شراء المنتجات، الفترات للاشتراكات وغيرها)',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'trigger_salla_sync',
                    description: 'طلب بدء مزامنة مبيعات فورية وجلب أحدث طلبات متجر سلة الفعلي إلى قاعدة البيانات المحلية',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'adjust_product_inventory',
                    description: 'تعديل وتحديث لوحة المخزون وجرد منتج معين يدوياً (تعديل رصيد التسوية/الجرد، سعر تكلفة الشراء، وسعر البيع)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            product_name: {
                                type: 'string',
                                description: 'اسم المنتج المراد تعديل بيانات مخزونه وجرده يدوياً'
                            },
                            stock_offset: {
                                type: 'number',
                                description: 'رصيد التسوية أو الجرد الافتتاحي للمخزون (مثال: +10 لزيادة المخزون يدوياً أو -5 لتسجيل عجز)'
                            },
                            cost: {
                                type: 'number',
                                description: 'سعر تكلفة الشراء المخصصة للقطعة الواحدة'
                            },
                            price: {
                                type: 'number',
                                description: 'سعر البيع المقدر أو المخصص للقطعة الواحدة'
                            }
                        },
                        required: ['product_name']
                    }
                },
                {
                    name: 'get_campaigns_metrics',
                    description: 'جلب إحصاءات حملات التسويق الإعلانية النشطة والسابقة (فيس بوك، سناب شات، تيك توك) وتفاصيل أدائها مثل الإنفاق، الظهور، الضغطات، المبيعات المنسوبة، والـ ROAS لكل حملة على حدة',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                }
            ]
        };
    } else if (method === 'tools/call') {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        
        try {
            const toolResult = await handleToolCall(toolName, toolArgs);
            const response = {
                jsonrpc: '2.0',
                id,
                result: toolResult
            };
            
            if (sessionId) {
                const sseRes = mcpSessions.get(sessionId);
                if (sseRes) {
                    sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
                }
            }
            
            return res.status(200).json(response);
        } catch (err) {
            const response = {
                jsonrpc: '2.0',
                id,
                error: { code: -32603, message: err.message }
            };
            if (sessionId) {
                const sseRes = mcpSessions.get(sessionId);
                if (sseRes) {
                    sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
                }
            }
            return res.status(200).json(response);
        }
    } else {
        error = { code: -32601, message: `Method not found: ${method}` };
    }
    
    const response = {
        jsonrpc: '2.0',
        id
    };
    if (result) response.result = result;
    if (error) response.error = error;
    
    res.status(200).json(response);
    
    if (sessionId) {
        const sseRes = mcpSessions.get(sessionId);
        if (sseRes) {
            sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        }
    }
};

async function handleToolCall(name, args) {
    return new Promise((resolve, reject) => {
        if (name === 'get_financial_summary') {
            db.all("SELECT * FROM expenses", [], (errExp, expenses) => {
                if (errExp) return reject(errExp);
                db.all("SELECT * FROM salla_imported_orders", [], (errSales, sales) => {
                    if (errSales) return reject(errSales);
                    db.all("SELECT * FROM salla_imported_wallet", [], (errWallet, wallet) => {
                        if (errWallet) return reject(errWallet);
                        db.all("SELECT * FROM ads_campaign_metrics", [], (errAds, ads) => {
                            if (errAds) return reject(errAds);
                            
                            const totalExpenses = expenses.reduce((s, e) => s + (e.amt || 0), 0);
                            const totalRevenue = sales.reduce((s, o) => s + (o.amount || 0), 0);
                            const totalAdSpend = ads ? ads.reduce((s, a) => s + (a.spend || 0), 0) : 0;
                            const netProfit = totalRevenue - totalExpenses;
                            
                            resolve({
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            store_name: "شوب ستور - لوحة تحكم المحاسبة الذكية",
                                            total_revenue_sar: totalRevenue,
                                            total_expenses_sar: totalExpenses,
                                            total_ad_spend_sar: totalAdSpend,
                                            net_profit_sar: netProfit,
                                            wallet_total_operations: wallet.length,
                                            orders_count: sales.length,
                                            campaigns_count: ads ? ads.length : 0
                                        }, null, 2)
                                    }
                                ]
                            });
                        });
                    });
                });
            });
        } else if (name === 'get_inventory_status') {
            db.all("SELECT * FROM expenses", [], (errExp, expenses) => {
                if (errExp) return reject(errExp);
                db.all("SELECT * FROM salla_imported_orders", [], (errSales, sales) => {
                    if (errSales) return reject(errSales);
                    db.all("SELECT * FROM product_adjustments", [], (errAdj, adjustments) => {
                        if (errAdj) return reject(errAdj);
                        
                        const map = {};
                        sales.forEach(o => {
                            const prodName = (o.product_name || 'غير معروف').trim();
                            if (!map[prodName]) {
                                map[prodName] = { name: prodName, sold: 0, revenue: 0, purchased: 0, cost: 0 };
                            }
                            map[prodName].sold += o.quantity || 1;
                            map[prodName].revenue += o.amount || 0;
                        });
                        
                        expenses.forEach(e => {
                            if (e.cat === 'شراء منتجات' && e.product_name) {
                                const prodName = e.product_name.trim();
                                if (!map[prodName]) {
                                    map[prodName] = { name: prodName, sold: 0, revenue: 0, purchased: 0, cost: 0 };
                                }
                                map[prodName].purchased += e.quantity || 0;
                                if (e.purchase_price) map[prodName].cost = e.purchase_price;
                            }
                        });
                        
                        adjustments.forEach(a => {
                            const prodName = (a.product_name || '').trim();
                            if (!map[prodName]) {
                                map[prodName] = { name: prodName, sold: 0, revenue: 0, purchased: 0, cost: 0 };
                            }
                            if (a.cost > 0) map[prodName].cost = a.cost;
                        });
                        
                        const inventory = Object.values(map).map(p => {
                            const adj = adjustments.find(a => a.product_name === p.name) || { stock_offset: 0 };
                            const stock = p.purchased - p.sold + adj.stock_offset;
                            return {
                                product_name: p.name,
                                quantity_purchased: p.purchased,
                                quantity_sold: p.sold,
                                remaining_stock: stock,
                                unit_cost_sar: p.cost,
                                total_revenue_sar: p.revenue
                            };
                        });
                        
                        resolve({
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify(inventory, null, 2)
                                }
                            ]
                        });
                    });
                });
            });
        } else if (name === 'get_campaigns_metrics') {
            db.all("SELECT * FROM ads_campaign_metrics ORDER BY date DESC", [], (err, rows) => {
                if (err) return reject(err);
                resolve({
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(rows, null, 2)
                        }
                    ]
                });
            });
        } else if (name === 'get_expenses_list') {
            db.all("SELECT * FROM expenses ORDER BY date DESC", [], (err, rows) => {
                if (err) return reject(err);
                resolve({
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(rows.map(e => ({
                                desc: e.desc,
                                cat: e.cat,
                                amt: e.amt,
                                date: e.date,
                                note: e.note,
                                product_name: e.product_name,
                                quantity: e.quantity,
                                period: e.period
                            })), null, 2)
                        }
                    ]
                });
            });
        } else if (name === 'trigger_salla_sync') {
            syncSallaOrdersToLocal(true)
                .then(count => {
                    resolve({
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({ success: true, message: `تمت المزامنة بنجاح: تم سحب ومزامنة ${count} سجل مبيعات من سلة` })
                            }
                        ]
                    });
                })
                .catch(err => {
                    if (err.message === 'SALLA_NOT_CONNECTED') {
                        resolve({
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: false,
                                        error: "متجر سلة غير متصل باللوحة حالياً عبر الـ OAuth في خادم الويب (SQLite empty config).",
                                        solution: "يجب على التاجر الدخول إلى لوحة التحكم بالمتصفح (https://shop.nuzum.sbs) ونقر شارة '🔌 اضغط لربط سلة (OAuth)' في الشريط العلوي لتسجيل الدخول الفعلي وتفويض التطبيق بسحب مبيعاته. بعد إتمام هذه الخطوة، ستعمل المزامنة المباشرة وتسحب كافة الطلبات تلقائياً."
                                    }, null, 2)
                                }
                            ]
                        });
                    } else {
                        reject(err);
                    }
                });
        } else if (name === 'adjust_product_inventory') {
            const { product_name, stock_offset, cost, price } = args;
            if (!product_name) {
                return reject(new Error('product_name is required'));
            }
            
            db.get("SELECT * FROM product_adjustments WHERE product_name = ?", [product_name.trim()], (err, row) => {
                if (err) return reject(err);
                
                const finalOffset = stock_offset !== undefined ? parseInt(stock_offset) : (row ? row.stock_offset : 0);
                const finalCost = cost !== undefined ? parseFloat(cost) : (row ? row.cost : 0);
                const finalPrice = price !== undefined ? parseFloat(price) : (row ? row.price : 0);
                
                db.run(
                    "INSERT INTO product_adjustments (product_name, stock_offset, cost, price) VALUES (?, ?, ?, ?) ON CONFLICT(product_name) DO UPDATE SET stock_offset = ?, cost = ?, price = ?",
                    [product_name.trim(), finalOffset, finalCost, finalPrice, finalOffset, finalCost, finalPrice],
                    function(errRun) {
                        if (errRun) return reject(errRun);
                        resolve({
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: true,
                                        message: `تم تحديث بيانات ومخزون المنتج "${product_name}" بنجاح في قاعدة البيانات ولوحة المخزون!`,
                                        product_name,
                                        stock_offset: finalOffset,
                                        cost: finalCost,
                                        price: finalPrice
                                    }, null, 2)
                                }
                            ]
                        });
                    }
                );
            });
        } else {
            reject(new Error(`Unknown tool: ${name}`));
        }
    });
}

module.exports = {
    router,
    handleMcpStream,
    handleMcpMessage
};
