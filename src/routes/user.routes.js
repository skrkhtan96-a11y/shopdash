const express = require('express');
const router = express.Router();
const UserRepository = require('../repositories/user.repository');
const { hashPassword } = require('../utils/crypto');
const { authenticateUser, requireRole } = require('../middlewares/auth');
const ConfigRepository = require('../repositories/config.repository');
const db = require('../config/db');

// Get all users
router.get('/', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    try {
        const users = await UserRepository.getAll();
        res.json(users);
    } catch (err) {
        next(err);
    }
});

// Create a new user
router.post('/', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    const { 
        username, email, password, role, can_add, can_edit, can_delete, can_deliver, 
        can_view_ps_details, can_view_games_details, can_view_external_sales,
        can_view_expenses, can_add_expenses, can_edit_expenses, can_delete_expenses,
        can_add_external_sales, can_edit_external_sales, can_delete_external_sales,
        can_view_campaigns, can_add_campaigns, can_edit_campaigns, can_delete_campaigns,
        can_view_certificates, can_add_certificates, can_edit_certificates, can_delete_certificates,
        can_view_ps, can_add_ps, can_edit_ps, can_delete_ps,
        can_view_games, can_add_games, can_edit_games, can_delete_games,
        can_view_salla_orders, can_view_salla_carts, can_view_salla_wallet, can_view_salla_products, can_edit_salla_products, can_view_salla_compare, can_view_salla_webhooks, can_edit_salla_webhooks,
        can_view_import, can_add_import, can_view_archive_tool, can_add_archive_tool, can_view_export, can_view_db_management, can_edit_db_management, can_view_activity_logs
    } = req.body;
    if (!username || !email || !password || !role) {
        return res.status(400).json({ error: 'يرجى تقديم كافة حقول البيانات للمستخدم الجديد.' });
    }

    try {
        const hashedPassword = hashPassword(password);
        const createdAt = new Date().toISOString().split('T')[0];

        const userId = await UserRepository.create({
            username,
            email,
            password: hashedPassword,
            role,
            can_add: can_add !== undefined ? (can_add ? 1 : 0) : 1,
            can_edit: can_edit !== undefined ? (can_edit ? 1 : 0) : 1,
            can_delete: can_delete !== undefined ? (can_delete ? 1 : 0) : 1,
            can_deliver: can_deliver !== undefined ? (can_deliver ? 1 : 0) : 1,
            can_view_ps_details: can_view_ps_details !== undefined ? (can_view_ps_details ? 1 : 0) : 1,
            can_view_games_details: can_view_games_details !== undefined ? (can_view_games_details ? 1 : 0) : 1,
            can_view_external_sales: can_view_external_sales !== undefined ? (can_view_external_sales ? 1 : 0) : 1,
            
            can_view_expenses: can_view_expenses !== undefined ? (can_view_expenses ? 1 : 0) : 1,
            can_add_expenses: can_add_expenses !== undefined ? (can_add_expenses ? 1 : 0) : 1,
            can_edit_expenses: can_edit_expenses !== undefined ? (can_edit_expenses ? 1 : 0) : 1,
            can_delete_expenses: can_delete_expenses !== undefined ? (can_delete_expenses ? 1 : 0) : 1,
            
            can_add_external_sales: can_add_external_sales !== undefined ? (can_add_external_sales ? 1 : 0) : 1,
            can_edit_external_sales: can_edit_external_sales !== undefined ? (can_edit_external_sales ? 1 : 0) : 1,
            can_delete_external_sales: can_delete_external_sales !== undefined ? (can_delete_external_sales ? 1 : 0) : 1,
            
            can_view_campaigns: can_view_campaigns !== undefined ? (can_view_campaigns ? 1 : 0) : 1,
            can_add_campaigns: can_add_campaigns !== undefined ? (can_add_campaigns ? 1 : 0) : 1,
            can_edit_campaigns: can_edit_campaigns !== undefined ? (can_edit_campaigns ? 1 : 0) : 1,
            can_delete_campaigns: can_delete_campaigns !== undefined ? (can_delete_campaigns ? 1 : 0) : 1,
            
            can_view_certificates: can_view_certificates !== undefined ? (can_view_certificates ? 1 : 0) : 1,
            can_add_certificates: can_add_certificates !== undefined ? (can_add_certificates ? 1 : 0) : 1,
            can_edit_certificates: can_edit_certificates !== undefined ? (can_edit_certificates ? 1 : 0) : 1,
            can_delete_certificates: can_delete_certificates !== undefined ? (can_delete_certificates ? 1 : 0) : 1,
            
            can_view_ps: can_view_ps !== undefined ? (can_view_ps ? 1 : 0) : 1,
            can_add_ps: can_add_ps !== undefined ? (can_add_ps ? 1 : 0) : 1,
            can_edit_ps: can_edit_ps !== undefined ? (can_edit_ps ? 1 : 0) : 1,
            can_delete_ps: can_delete_ps !== undefined ? (can_delete_ps ? 1 : 0) : 1,
            
            can_view_games: can_view_games !== undefined ? (can_view_games ? 1 : 0) : 1,
            can_add_games: can_add_games !== undefined ? (can_add_games ? 1 : 0) : 1,
            can_edit_games: can_edit_games !== undefined ? (can_edit_games ? 1 : 0) : 1,
            can_delete_games: can_delete_games !== undefined ? (can_delete_games ? 1 : 0) : 1,
            
            can_view_salla_orders: can_view_salla_orders !== undefined ? (can_view_salla_orders ? 1 : 0) : 1,
            can_view_salla_carts: can_view_salla_carts !== undefined ? (can_view_salla_carts ? 1 : 0) : 1,
            can_view_salla_wallet: can_view_salla_wallet !== undefined ? (can_view_salla_wallet ? 1 : 0) : 1,
            can_view_salla_products: can_view_salla_products !== undefined ? (can_view_salla_products ? 1 : 0) : 1,
            can_edit_salla_products: can_edit_salla_products !== undefined ? (can_edit_salla_products ? 1 : 0) : 1,
            can_view_salla_compare: can_view_salla_compare !== undefined ? (can_view_salla_compare ? 1 : 0) : 1,
            can_view_salla_webhooks: can_view_salla_webhooks !== undefined ? (can_view_salla_webhooks ? 1 : 0) : 1,
            can_edit_salla_webhooks: can_edit_salla_webhooks !== undefined ? (can_edit_salla_webhooks ? 1 : 0) : 1,
            
            can_view_import: can_view_import !== undefined ? (can_view_import ? 1 : 0) : 1,
            can_add_import: can_add_import !== undefined ? (can_add_import ? 1 : 0) : 1,
            can_view_archive_tool: can_view_archive_tool !== undefined ? (can_view_archive_tool ? 1 : 0) : 1,
            can_add_archive_tool: can_add_archive_tool !== undefined ? (can_add_archive_tool ? 1 : 0) : 1,
            can_view_export: can_view_export !== undefined ? (can_view_export ? 1 : 0) : 1,
            can_view_db_management: can_view_db_management !== undefined ? (can_view_db_management ? 1 : 0) : 1,
            can_edit_db_management: can_edit_db_management !== undefined ? (can_edit_db_management ? 1 : 0) : 1,
            can_view_activity_logs: can_view_activity_logs !== undefined ? (can_view_activity_logs ? 1 : 0) : 1,
            
            created_at: createdAt
        });

        await ConfigRepository.logActivity(
            req.user.username,
            'ADD',
            'users',
            `تم إضافة مستخدم جديد: ${username} برتبة ${role}`
        );

        res.json({ success: true, id: userId });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'اسم المستخدم أو البريد الإلكتروني مسجل مسبقاً.' });
        }
        next(err);
    }
});

// Update a user (handles both password and profile updates)
router.put('/:id', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    const { id } = req.params;
    const { 
        role, username, email, password, can_add, can_edit, can_delete, can_deliver, 
        can_view_ps_details, can_view_games_details, can_view_external_sales,
        can_view_expenses, can_add_expenses, can_edit_expenses, can_delete_expenses,
        can_add_external_sales, can_edit_external_sales, can_delete_external_sales,
        can_view_campaigns, can_add_campaigns, can_edit_campaigns, can_delete_campaigns,
        can_view_certificates, can_add_certificates, can_edit_certificates, can_delete_certificates,
        can_view_ps, can_add_ps, can_edit_ps, can_delete_ps,
        can_view_games, can_add_games, can_edit_games, can_delete_games,
        can_view_salla_orders, can_view_salla_carts, can_view_salla_wallet, can_view_salla_products, can_edit_salla_products, can_view_salla_compare, can_view_salla_webhooks, can_edit_salla_webhooks,
        can_view_import, can_add_import, can_view_archive_tool, can_add_archive_tool, can_view_export, can_view_db_management, can_edit_db_management, can_view_activity_logs
    } = req.body;
    
    if (!role) {
        return res.status(400).json({ error: 'يرجى تحديد دور المستخدم.' });
    }
    
    const cAdd = can_add !== undefined ? (can_add ? 1 : 0) : 1;
    const cEdit = can_edit !== undefined ? (can_edit ? 1 : 0) : 1;
    const cDelete = can_delete !== undefined ? (can_delete ? 1 : 0) : 1;
    const cDeliver = can_deliver !== undefined ? (can_deliver ? 1 : 0) : 1;
    const cViewPsDetails = can_view_ps_details !== undefined ? (can_view_ps_details ? 1 : 0) : 1;
    const cViewGamesDetails = can_view_games_details !== undefined ? (can_view_games_details ? 1 : 0) : 1;
    const cViewExternalSales = can_view_external_sales !== undefined ? (can_view_external_sales ? 1 : 0) : 1;

    const cViewExpenses = can_view_expenses !== undefined ? (can_view_expenses ? 1 : 0) : 1;
    const cAddExpenses = can_add_expenses !== undefined ? (can_add_expenses ? 1 : 0) : 1;
    const cEditExpenses = can_edit_expenses !== undefined ? (can_edit_expenses ? 1 : 0) : 1;
    const cDeleteExpenses = can_delete_expenses !== undefined ? (can_delete_expenses ? 1 : 0) : 1;

    const cAddExternalSales = can_add_external_sales !== undefined ? (can_add_external_sales ? 1 : 0) : 1;
    const cEditExternalSales = can_edit_external_sales !== undefined ? (can_edit_external_sales ? 1 : 0) : 1;
    const cDeleteExternalSales = can_delete_external_sales !== undefined ? (can_delete_external_sales ? 1 : 0) : 1;

    const cViewCampaigns = can_view_campaigns !== undefined ? (can_view_campaigns ? 1 : 0) : 1;
    const cAddCampaigns = can_add_campaigns !== undefined ? (can_add_campaigns ? 1 : 0) : 1;
    const cEditCampaigns = can_edit_campaigns !== undefined ? (can_edit_campaigns ? 1 : 0) : 1;
    const cDeleteCampaigns = can_delete_campaigns !== undefined ? (can_delete_campaigns ? 1 : 0) : 1;

    const cViewCertificates = can_view_certificates !== undefined ? (can_view_certificates ? 1 : 0) : 1;
    const cAddCertificates = can_add_certificates !== undefined ? (can_add_certificates ? 1 : 0) : 1;
    const cEditCertificates = can_edit_certificates !== undefined ? (can_edit_certificates ? 1 : 0) : 1;
    const cDeleteCertificates = can_delete_certificates !== undefined ? (can_delete_certificates ? 1 : 0) : 1;

    const cViewPs = can_view_ps !== undefined ? (can_view_ps ? 1 : 0) : 1;
    const cAddPs = can_add_ps !== undefined ? (can_add_ps ? 1 : 0) : 1;
    const cEditPs = can_edit_ps !== undefined ? (can_edit_ps ? 1 : 0) : 1;
    const cDeletePs = can_delete_ps !== undefined ? (can_delete_ps ? 1 : 0) : 1;

    const cViewGames = can_view_games !== undefined ? (can_view_games ? 1 : 0) : 1;
    const cAddGames = can_add_games !== undefined ? (can_add_games ? 1 : 0) : 1;
    const cEditGames = can_edit_games !== undefined ? (can_edit_games ? 1 : 0) : 1;
    const cDeleteGames = can_delete_games !== undefined ? (can_delete_games ? 1 : 0) : 1;

    const cViewSallaOrders = can_view_salla_orders !== undefined ? (can_view_salla_orders ? 1 : 0) : 1;
    const cViewSallaCarts = can_view_salla_carts !== undefined ? (can_view_salla_carts ? 1 : 0) : 1;
    const cViewSallaWallet = can_view_salla_wallet !== undefined ? (can_view_salla_wallet ? 1 : 0) : 1;
    const cViewSallaProducts = can_view_salla_products !== undefined ? (can_view_salla_products ? 1 : 0) : 1;
    const cEditSallaProducts = can_edit_salla_products !== undefined ? (can_edit_salla_products ? 1 : 0) : 1;
    const cViewSallaCompare = can_view_salla_compare !== undefined ? (can_view_salla_compare ? 1 : 0) : 1;
    const cViewSallaWebhooks = can_view_salla_webhooks !== undefined ? (can_view_salla_webhooks ? 1 : 0) : 1;
    const cEditSallaWebhooks = can_edit_salla_webhooks !== undefined ? (can_edit_salla_webhooks ? 1 : 0) : 1;

    const cViewImport = can_view_import !== undefined ? (can_view_import ? 1 : 0) : 1;
    const cAddImport = can_add_import !== undefined ? (can_add_import ? 1 : 0) : 1;
    const cViewArchiveTool = can_view_archive_tool !== undefined ? (can_view_archive_tool ? 1 : 0) : 1;
    const cAddArchiveTool = can_add_archive_tool !== undefined ? (can_add_archive_tool ? 1 : 0) : 1;
    const cViewExport = can_view_export !== undefined ? (can_view_export ? 1 : 0) : 1;
    const cViewDbManagement = can_view_db_management !== undefined ? (can_view_db_management ? 1 : 0) : 1;
    const cEditDbManagement = can_edit_db_management !== undefined ? (can_edit_db_management ? 1 : 0) : 1;
    const cViewActivityLogs = can_view_activity_logs !== undefined ? (can_view_activity_logs ? 1 : 0) : 1;

    try {
        if (password) {
            const hashedPassword = hashPassword(password);
            db.run(
                `UPDATE users SET role = ?, username = ?, email = ?, password = ?, can_add = ?, can_edit = ?, can_delete = ?, can_deliver = ?, can_view_ps_details = ?, can_view_games_details = ?, can_view_external_sales = ?,
                    can_view_expenses = ?, can_add_expenses = ?, can_edit_expenses = ?, can_delete_expenses = ?,
                    can_add_external_sales = ?, can_edit_external_sales = ?, can_delete_external_sales = ?,
                    can_view_campaigns = ?, can_add_campaigns = ?, can_edit_campaigns = ?, can_delete_campaigns = ?,
                    can_view_certificates = ?, can_add_certificates = ?, can_edit_certificates = ?, can_delete_certificates = ?,
                    can_view_ps = ?, can_add_ps = ?, can_edit_ps = ?, can_delete_ps = ?,
                    can_view_games = ?, can_add_games = ?, can_edit_games = ?, can_delete_games = ?,
                    can_view_salla_orders = ?, can_view_salla_carts = ?, can_view_salla_wallet = ?, can_view_salla_products = ?, can_edit_salla_products = ?, can_view_salla_compare = ?, can_view_salla_webhooks = ?, can_edit_salla_webhooks = ?,
                    can_view_import = ?, can_add_import = ?, can_view_archive_tool = ?, can_add_archive_tool = ?, can_view_export = ?, can_view_db_management = ?, can_edit_db_management = ?, can_view_activity_logs = ?
                 WHERE id = ?`,
                [role, username.trim(), email.trim().toLowerCase(), hashedPassword, cAdd, cEdit, cDelete, cDeliver, cViewPsDetails, cViewGamesDetails, cViewExternalSales,
                    cViewExpenses, cAddExpenses, cEditExpenses, cDeleteExpenses,
                    cAddExternalSales, cEditExternalSales, cDeleteExternalSales,
                    cViewCampaigns, cAddCampaigns, cEditCampaigns, cDeleteCampaigns,
                    cViewCertificates, cAddCertificates, cEditCertificates, cDeleteCertificates,
                    cViewPs, cAddPs, cEditPs, cDeletePs,
                    cViewGames, cAddGames, cEditGames, cDeleteGames,
                    cViewSallaOrders, cViewSallaCarts, cViewSallaWallet, cViewSallaProducts, cEditSallaProducts, cViewSallaCompare, cViewSallaWebhooks, cEditSallaWebhooks,
                    cViewImport, cAddImport, cViewArchiveTool, cAddArchiveTool, cViewExport, cViewDbManagement, cEditDbManagement, cViewActivityLogs,
                    id],
                async function(err) {
                    if (err) return next(err);
                    await ConfigRepository.logActivity(req.user.username, 'UPDATE', 'users', `تم تحديث بيانات المستخدم: ${username} برتبة ${role}`);
                    res.json({ success: true });
                }
            );
        } else {
            db.run(
                `UPDATE users SET role = ?, username = ?, email = ?, can_add = ?, can_edit = ?, can_delete = ?, can_deliver = ?, can_view_ps_details = ?, can_view_games_details = ?, can_view_external_sales = ?,
                    can_view_expenses = ?, can_add_expenses = ?, can_edit_expenses = ?, can_delete_expenses = ?,
                    can_add_external_sales = ?, can_edit_external_sales = ?, can_delete_external_sales = ?,
                    can_view_campaigns = ?, can_add_campaigns = ?, can_edit_campaigns = ?, can_delete_campaigns = ?,
                    can_view_certificates = ?, can_add_certificates = ?, can_edit_certificates = ?, can_delete_certificates = ?,
                    can_view_ps = ?, can_add_ps = ?, can_edit_ps = ?, can_delete_ps = ?,
                    can_view_games = ?, can_add_games = ?, can_edit_games = ?, can_delete_games = ?,
                    can_view_salla_orders = ?, can_view_salla_carts = ?, can_view_salla_wallet = ?, can_view_salla_products = ?, can_edit_salla_products = ?, can_view_salla_compare = ?, can_view_salla_webhooks = ?, can_edit_salla_webhooks = ?,
                    can_view_import = ?, can_add_import = ?, can_view_archive_tool = ?, can_add_archive_tool = ?, can_view_export = ?, can_view_db_management = ?, can_edit_db_management = ?, can_view_activity_logs = ?
                 WHERE id = ?`,
                [role, username.trim(), email.trim().toLowerCase(), cAdd, cEdit, cDelete, cDeliver, cViewPsDetails, cViewGamesDetails, cViewExternalSales,
                    cViewExpenses, cAddExpenses, cEditExpenses, cDeleteExpenses,
                    cAddExternalSales, cEditExternalSales, cDeleteExternalSales,
                    cViewCampaigns, cAddCampaigns, cEditCampaigns, cDeleteCampaigns,
                    cViewCertificates, cAddCertificates, cEditCertificates, cDeleteCertificates,
                    cViewPs, cAddPs, cEditPs, cDeletePs,
                    cViewGames, cAddGames, cEditGames, cDeleteGames,
                    cViewSallaOrders, cViewSallaCarts, cViewSallaWallet, cViewSallaProducts, cEditSallaProducts, cViewSallaCompare, cViewSallaWebhooks, cEditSallaWebhooks,
                    cViewImport, cAddImport, cViewArchiveTool, cAddArchiveTool, cViewExport, cViewDbManagement, cEditDbManagement, cViewActivityLogs,
                    id],
                async function(err) {
                    if (err) return next(err);
                    await ConfigRepository.logActivity(req.user.username, 'UPDATE', 'users', `تم تحديث بيانات المستخدم: ${username} برتبة ${role}`);
                    res.json({ success: true });
                }
            );
        }
    } catch (err) {
        next(err);
    }
});

// Delete a user
router.delete('/:id', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
        return res.status(400).json({ error: 'لا يمكنك حذف حسابك الشخصي النشط حالياً.' });
    }

    try {
        const targetUser = await UserRepository.getById(id);
        if (!targetUser) {
            return res.status(404).json({ error: 'المستخدم غير موجود.' });
        }

        await UserRepository.delete(id);

        await ConfigRepository.logActivity(
            req.user.username,
            'DELETE',
            'users',
            `تم حذف المستخدم: ${targetUser.username} (معرف: ${id})`
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
