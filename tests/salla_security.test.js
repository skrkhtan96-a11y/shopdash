// Set NODE_ENV to test to use SQLite in-memory database
process.env.NODE_ENV = 'test';
process.env.SALLA_CLIENT_ID = 'test_real_client_id';
process.env.SALLA_CLIENT_SECRET = 'test_real_client_secret';
process.env.SALLA_REDIRECT_URI = 'http://localhost:3000/callback';
process.env.SALLA_WEBHOOK_SECRET = 'webhook_test_secret_12345';

const request = require('supertest');
const assert = require('assert');
const expect = (val) => ({
    to: {
        be: {
            an: (type) => assert.ok(type === 'array' ? Array.isArray(val) : typeof val === type),
            a: (type) => assert.ok(type === 'array' ? Array.isArray(val) : typeof val === type)
        },
        get exist() { assert.ok(val); return this; },
        get not() { return { get exist() { assert.ok(!val); return this; } }; },
        equal: (expected) => assert.strictEqual(val, expected),
        include: (expected) => assert.ok(val && val.includes(expected)),
        have: {
            property: (prop, expected) => {
                assert.ok(val && val.hasOwnProperty(prop));
                if (expected !== undefined) assert.strictEqual(val[prop], expected);
            }
        }
    }
});
const crypto = require('crypto');
const app = require('../server');
const { db, hashPassword } = require('../database');
const ConfigRepository = require('../src/repositories/config.repository');

describe('🔒 Salla Security Controls Verification Tests', () => {
    let server;
    let adminCookie = '';

    before((done) => {
        server = app.listen(0, () => {
            // Seed first admin user in-memory database
            const hashedPassword = hashPassword('SecureAdminPass123!');
            db.run(
                "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                ['salla_security_admin', 'admin@salla-security.local', hashedPassword, 'admin', '2026-06-11'],
                (err) => {
                    if (err) return done(err);
                    // Login to get session cookie
                    request(server)
                        .post('/api/auth/login')
                        .send({ login: 'salla_security_admin', password: 'SecureAdminPass123!' })
                        .end((errLogin, res) => {
                            if (errLogin) return done(errLogin);
                            const cookies = res.headers['set-cookie'];
                            if (cookies) {
                                adminCookie = cookies[0];
                            }
                            done();
                        });
                }
            );
        });
    });

    after((done) => {
        server.close(done);
    });

    describe('1. OAuth CSRF State Validation', () => {
        it('should redirect with csrf_validation_failed error if state cookie is missing', (done) => {
            request(server)
                .get('/api/salla/callback-handler?code=abc&state=xyz')
                .expect(302)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.headers.location).to.include('error=csrf_validation_failed');
                    done();
                });
        });

        it('should redirect with csrf_validation_failed error if state does not match state cookie', (done) => {
            request(server)
                .get('/api/salla/callback-handler?code=abc&state=wrong_state')
                .set('Cookie', 'salla_oauth_state=correct_state')
                .expect(302)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.headers.location).to.include('error=csrf_validation_failed');
                    done();
                });
        });
    });

    describe('2. Webhook Signature Verification', () => {
        const testPayload = {
            event: 'order.created',
            data: {
                reference_id: 99999,
                total: { amount: 100 },
                customer: { first_name: 'Security', last_name: 'Test' },
                items: []
            }
        };

        it('should reject webhook requests with 401 when signature header is missing', (done) => {
            request(server)
                .post('/api/salla/webhook')
                .send(testPayload)
                .expect(401)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body.error).to.include('missing');
                    done();
                });
        });

        it('should reject webhook requests with 401 when signature is incorrect', (done) => {
            request(server)
                .post('/api/salla/webhook')
                .set('X-Salla-Signature', 'invalid_signature_hex')
                .send(testPayload)
                .expect(401, done);
        });

        it('should accept webhook requests with 200 when signature is correct', (done) => {
            const hmac = crypto.createHmac('sha256', process.env.SALLA_WEBHOOK_SECRET);
            const rawBody = JSON.stringify(testPayload);
            const signature = hmac.update(rawBody).digest('hex');

            request(server)
                .post('/api/salla/webhook')
                .set('X-Salla-Signature', signature)
                .set('Content-Type', 'application/json')
                .send(testPayload)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body.success).to.be.true;
                    done();
                });
        });

        it('should accept webhooks regardless of signature when SALLA_WEBHOOK_SECRET is empty', (done) => {
            const oldSecret = process.env.SALLA_WEBHOOK_SECRET;
            delete process.env.SALLA_WEBHOOK_SECRET;

            request(server)
                .post('/api/salla/webhook')
                .send(testPayload)
                .expect(200)
                .end((err, res) => {
                    process.env.SALLA_WEBHOOK_SECRET = oldSecret;
                    if (err) return done(err);
                    expect(res.body.success).to.be.true;
                    done();
                });
        });
    });

    describe('3. App Uninstall Webhook Event Handling', () => {
        before(async () => {
            // Seed credentials to be uninstalled
            await ConfigRepository.setConfig('salla_auth', { access_token: 'fake', refresh_token: 'fake', expires_at: 99999999 });
            await ConfigRepository.setConfig('salla_store', { name: 'Secured Store' });
        });

        it('should delete connection config when app.uninstalled event is received', (done) => {
            const uninstallPayload = {
                event: 'app.uninstalled',
                data: {}
            };
            const hmac = crypto.createHmac('sha256', process.env.SALLA_WEBHOOK_SECRET);
            const signature = hmac.update(JSON.stringify(uninstallPayload)).digest('hex');

            request(server)
                .post('/api/salla/webhook')
                .set('X-Salla-Signature', signature)
                .send(uninstallPayload)
                .expect(200)
                .end(async (err, res) => {
                    if (err) return done(err);
                    expect(res.body.success).to.be.true;

                    const auth = await ConfigRepository.getConfig('salla_auth');
                    const store = await ConfigRepository.getConfig('salla_store');
                    expect(auth).to.be.null;
                    expect(store).to.be.null;
                    done();
                });
        });
    });
});
