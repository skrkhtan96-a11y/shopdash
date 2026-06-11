const express = require('express');
const router = express.Router();
const multer = require('multer');
const driveService = require('../services/drive.service');

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
        
        const webViewLink = await driveService.uploadFile(fileBuffer, fileName, mimeType);
        
        res.json({ 
            success: true, 
            file_url: webViewLink 
        });
    } catch (err) {
        console.error('[UploadRoute] Error handling upload:', err.message);
        res.status(500).json({ error: 'فشل رفع الملف إلى جوجل درايف.', details: err.message });
    }
});

module.exports = router;
