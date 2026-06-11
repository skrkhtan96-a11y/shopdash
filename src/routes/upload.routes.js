const express = require('express');
const router = express.Router();
const multer = require('multer');
const oauthDriveService = require('../services/oauth.drive.service');
const { authenticateUser } = require('../middlewares/auth');

// Multer in-memory storage for handling file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // Limit files to 10MB
    }
});

// Endpoint to upload a file directly to Google Drive
router.post('/upload', upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'لم يتم رفع أي ملف.' });
        }

        const fileName = `receipt_${Date.now()}_${req.file.originalname}`;
        const fileBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;

        console.log(`[UploadRoute] Starting upload for: ${fileName} (${req.file.size} bytes)`);
        
        const webViewLink = await oauthDriveService.uploadFile(fileBuffer, fileName, mimeType);
        
        res.json({ 
            success: true, 
            file_url: webViewLink 
        });
    } catch (err) {
        console.error('[UploadRoute] Error handling upload:', err.message);
        res.status(500).json({ error: 'فشل رفع الملف إلى جوجل درايف.', details: err.message });
    }
});

// --- GOOGLE OAUTH2 FLOW ---

// Redirect to Google auth screen
router.get('/google-auth', authenticateUser, (req, res) => {
    try {
        const url = oauthDriveService.getAuthUrl();
        res.redirect(url);
    } catch (e) {
        console.error('[GoogleAuth] Error generating url:', e.message);
        res.status(500).send('خطأ في إعدادات Google Client ID.');
    }
});

// Google OAuth callback
router.get('/google-callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.redirect('/?google_auth=error');
    }

    try {
        await oauthDriveService.setCredentialsFromCode(code);
        res.redirect('/?google_auth=success');
    } catch (e) {
        console.error('[GoogleAuth] Callback error:', e.message);
        res.redirect('/?google_auth=error');
    }
});

// Get drive status
router.get('/google-status', authenticateUser, async (req, res) => {
    try {
        const connected = await oauthDriveService.getConnectionStatus();
        res.json({ connected });
    } catch (e) {
        res.json({ connected: false });
    }
});

// Disconnect drive
router.post('/google-disconnect', authenticateUser, async (req, res) => {
    try {
        await oauthDriveService.disconnect();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
