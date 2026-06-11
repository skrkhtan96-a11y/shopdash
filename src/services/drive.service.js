const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class DriveService {
    constructor() {
        this.drive = null;
        this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        this.credentialsFile = process.env.GOOGLE_CREDENTIALS_FILE || 'planar-momentum-484019-c2-74c0a1ece07b.json';
        this.init();
    }

    init() {
        try {
            const keyPath = path.isAbsolute(this.credentialsFile)
                ? this.credentialsFile
                : path.join(process.cwd(), this.credentialsFile);

            if (!fs.existsSync(keyPath)) {
                console.warn(`[DriveService] Warning: Google credentials file not found at ${keyPath}. Direct uploads will be disabled.`);
                return;
            }

            const auth = new google.auth.GoogleAuth({
                keyFile: keyPath,
                scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
            });

            this.drive = google.drive({ version: 'v3', auth });
            console.log('[DriveService] Google Drive client successfully initialized.');
        } catch (error) {
            console.error('[DriveService] Error initializing Google Drive client:', error.message);
        }
    }

    /**
     * Upload a file buffer directly to the specified Google Drive folder.
     * @param {Buffer} fileBuffer The file buffer
     * @param {string} fileName The name to save the file as
     * @param {string} mimeType The mime type (e.g. image/jpeg, application/pdf)
     * @returns {Promise<string>} The public web view URL of the uploaded file
     */
    async uploadFile(fileBuffer, fileName, mimeType) {
        if (!this.drive) {
            throw new Error('Google Drive client is not initialized. Please verify your credentials.');
        }

        if (!this.folderId) {
            throw new Error('GOOGLE_DRIVE_FOLDER_ID environment variable is missing.');
        }

        try {
            // Read buffer stream helper
            const { Readable } = require('stream');
            const bufferStream = new Readable();
            bufferStream.push(fileBuffer);
            bufferStream.push(null);

            const fileMetadata = {
                name: fileName,
                parents: [this.folderId],
            };

            const media = {
                mimeType: mimeType,
                body: bufferStream,
            };

            const response = await this.drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id, webViewLink, webContentLink',
            });

            const fileId = response.data.id;
            console.log(`[DriveService] File successfully uploaded to Google Drive. ID: ${fileId}`);

            // Make file readable to anyone with the link (optional but recommended for viewing inside dashboard)
            try {
                await this.drive.permissions.create({
                    fileId: fileId,
                    requestBody: {
                        role: 'reader',
                        type: 'anyone',
                    },
                });
            } catch (permErr) {
                console.warn('[DriveService] Warning: Could not share file publicly, it might still require manual share permissions:', permErr.message);
            }

            // Return webViewLink or webContentLink
            return response.data.webViewLink;
        } catch (error) {
            console.error('[DriveService] Error uploading file to Google Drive:', error.message);
            throw error;
        }
    }
}

module.exports = new DriveService();
