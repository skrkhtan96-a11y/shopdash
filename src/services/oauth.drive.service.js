const { google } = require('googleapis');
const db = require('../config/db');

class OAuthDriveService {
    constructor() {
        this.oauth2Client = null;
        this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        this.init();
    }

    init() {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'https://shop.nuzum.sbs/api/upload/google-callback';

        if (clientId && clientSecret) {
            this.oauth2Client = new google.auth.OAuth2(
                clientId,
                clientSecret,
                redirectUri
            );
            console.log('[OAuthDriveService] OAuth2 Client successfully initialized.');
        } else {
            console.warn('[OAuthDriveService] Warning: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing from environment.');
        }
    }

    getAuthUrl() {
        if (!this.oauth2Client) {
            this.init();
        }
        if (!this.oauth2Client) {
            throw new Error('Google OAuth credentials not configured.');
        }
        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive']
        });
    }

    async setCredentialsFromCode(code) {
        if (!this.oauth2Client) this.init();
        const { tokens } = await this.oauth2Client.getToken(code);
        this.oauth2Client.setCredentials(tokens);

        // Save tokens in database
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("INSERT OR REPLACE INTO google_config (key, value) VALUES (?, ?)", ['access_token', tokens.access_token || '']);
                if (tokens.refresh_token) {
                    db.run("INSERT OR REPLACE INTO google_config (key, value) VALUES (?, ?)", ['refresh_token', tokens.refresh_token]);
                }
                if (tokens.expiry_date) {
                    db.run("INSERT OR REPLACE INTO google_config (key, value) VALUES (?, ?)", ['expiry_date', String(tokens.expiry_date)]);
                }
                resolve(tokens);
            });
        });
    }

    async getAuthorizedDriveClient() {
        if (!this.oauth2Client) this.init();
        
        // Load credentials from DB
        const credentials = await new Promise((resolve) => {
            db.all("SELECT key, value FROM google_config", [], (err, rows) => {
                if (err || !rows) return resolve({});
                const config = {};
                rows.forEach(r => config[r.key] = r.value);
                resolve(config);
            });
        });

        if (!credentials.access_token) {
            return null; // Not connected yet
        }

        const client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );

        client.setCredentials({
            access_token: credentials.access_token,
            refresh_token: credentials.refresh_token,
            expiry_date: credentials.expiry_date ? parseInt(credentials.expiry_date) : null
        });

        // Listen for token updates (automatic refreshes)
        client.on('tokens', (tokens) => {
            db.serialize(() => {
                if (tokens.access_token) {
                    db.run("INSERT OR REPLACE INTO google_config (key, value) VALUES (?, ?)", ['access_token', tokens.access_token]);
                }
                if (tokens.refresh_token) {
                    db.run("INSERT OR REPLACE INTO google_config (key, value) VALUES (?, ?)", ['refresh_token', tokens.refresh_token]);
                }
                if (tokens.expiry_date) {
                    db.run("INSERT OR REPLACE INTO google_config (key, value) VALUES (?, ?)", ['expiry_date', String(tokens.expiry_date)]);
                }
            });
        });

        return google.drive({ version: 'v3', auth: client });
    }

    async uploadFile(fileBuffer, fileName, mimeType) {
        // Fallback to service account upload if OAuth is not connected
        const drive = await this.getAuthorizedDriveClient();
        if (!drive) {
            console.log('[OAuthDriveService] OAuth token missing. Falling back to Service Account upload.');
            const serviceAccountDrive = require('./drive.service');
            return serviceAccountDrive.uploadFile(fileBuffer, fileName, mimeType);
        }

        if (!this.folderId) {
            throw new Error('GOOGLE_DRIVE_FOLDER_ID environment variable is missing.');
        }

        const { Readable } = require('stream');
        const bufferStream = new Readable();
        bufferStream.push(fileBuffer);
        bufferStream.push(null);

        const response = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [this.folderId]
            },
            media: {
                mimeType: mimeType,
                body: bufferStream
            },
            fields: 'id, webViewLink'
        });

        const fileId = response.data.id;
        
        try {
            await drive.permissions.create({
                fileId: fileId,
                requestBody: {
                    role: 'reader',
                    type: 'anyone',
                }
            });
        } catch (permErr) {
            console.warn('[OAuthDriveService] Warning: Could not share file publicly:', permErr.message);
        }

        return response.data.webViewLink;
    }

    async getConnectionStatus() {
        const drive = await this.getAuthorizedDriveClient();
        return drive !== null;
    }

    async disconnect() {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM google_config", [], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

module.exports = new OAuthDriveService();
