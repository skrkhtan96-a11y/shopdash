// Set NODE_ENV to test to ensure we load SQLite in-memory database
process.env.NODE_ENV = 'test';
process.env.MCP_TOKEN = 'mcp_test_token_999';
process.env.AI_API_TOKEN = 'ai_test_token_888';

const request = require('supertest');
const { expect } = require('chai');
const http = require('http');
const app = require('../server');
const { db, hashPassword } = require('../database');

describe('🔒 Security Remediation Verification Tests', () => {
    let server;
    let port;
    let adminCookie = '';

    // Start a test server on a random port to test SSE directly
    before((done) => {
        server = app.listen(0, () => {
            port = server.address().port;
            
            // Seed first admin user in-memory database
            const hashedPassword = hashPassword('SecureAdminPass123!');
            db.run(
                "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                ['system_admin', 'admin@system.local', hashedPassword, 'admin', '2026-06-11'],
                (err) => {
                    if (err) return done(err);
                    // Login to get session cookie
                    request(server)
                        .post('/api/auth/login')
                        .send({ login: 'system_admin', password: 'SecureAdminPass123!' })
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

    describe('1. MCP & AI Endpoint Authentication (C-4, C-5)', () => {
        
        it('should reject GET /mcp with 401 when token is missing', (done) => {
            request(server)
                .get('/mcp')
                .expect(401)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.have.property('error');
                    expect(res.body.error).to.include('Unauthorized. Invalid MCP token.');
                    done();
                });
        });

        it('should reject GET /mcp with 401 when token is incorrect', (done) => {
            request(server)
                .get('/mcp?token=wrong_token')
                .expect(401, done);
        });

        it('should accept GET /mcp and initiate SSE with 200 when token is correct', (done) => {
            const req = http.get(`http://localhost:${port}/mcp?token=mcp_test_token_999`, (res) => {
                expect(res.statusCode).to.equal(200);
                expect(res.headers['content-type']).to.include('text/event-stream');
                
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk.toString();
                    if (data.includes('event: endpoint')) {
                        expect(data).to.include('mcp_test_token_999');
                        req.destroy();
                        done();
                    }
                });
            });
            req.on('error', (err) => {
                if (err.code !== 'ECONNRESET' && err.message !== 'socket hang up') {
                    done(err);
                }
            });
        });

        it('should reject GET /api/ai/live-data with 401 when token is missing', (done) => {
            request(server)
                .get('/api/ai/live-data')
                .expect(401, done);
        });

        it('should reject GET /api/ai/live-data with 401 when token is incorrect', (done) => {
            request(server)
                .get('/api/ai/live-data?token=wrong_token')
                .expect(401, done);
        });

        it('should accept GET /api/ai/live-data with 200 when token is correct', (done) => {
            request(server)
                .get('/api/ai/live-data?token=ai_test_token_888')
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.have.property('store_name');
                    expect(res.body).to.have.property('financial_summary');
                    done();
                });
        });
    });

    describe('2. User Registration via Admin API Only', () => {

        it('should reject creating a user without active session', (done) => {
            request(server)
                .post('/api/users')
                .send({
                    username: 'employee_guest',
                    email: 'employee@system.local',
                    password: 'EmployeePass123!',
                    role: 'employee'
                })
                .expect(401, done);
        });

        it('should allow admin to create a new user via POST /api/users', (done) => {
            request(server)
                .post('/api/users')
                .set('Cookie', adminCookie)
                .send({
                    username: 'employee_authorized',
                    email: 'authorized_employee@system.local',
                    password: 'AuthorizedPass123!',
                    role: 'employee'
                })
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.have.property('success', true);
                    done();
                });
        });
    });

    describe('3. Sensitive Endpoints Access Control', () => {

        it('should reject POST /api/system/clear-all with 401 when unauthorized', (done) => {
            request(server)
                .post('/api/system/clear-all')
                .expect(401, done);
        });

        it('should reject POST /api/salla/clear-imports with 401 when unauthorized', (done) => {
            request(server)
                .post('/api/salla/clear-imports')
                .expect(401, done);
        });

        it('should reject POST /api/expenses with 401 when unauthorized', (done) => {
            request(server)
                .post('/api/expenses')
                .send({ desc: 'Test Expense', cat: 'cat1', amt: 100, date: '2026-06-11' })
                .expect(401, done);
        });

        it('should reject GET /api/salla/disconnect with 401 when unauthorized', (done) => {
            request(server)
                .get('/api/salla/disconnect')
                .expect(401, done);
        });

        it('should reject POST /api/products/adjustments/bulk with 401 when unauthorized', (done) => {
            request(server)
                .post('/api/products/adjustments/bulk')
                .send({ products: [] })
                .expect(401, done);
        });
    });

    describe('4. Centralized Error Handling & Stack Trace Hiding (L-3)', () => {

        it('should include error message and stack trace in non-production environments', (done) => {
            request(server)
                .get('/api/auth/test-error')
                .expect(500)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.have.property('error', 'Test internal database connection error');
                    expect(res.body).to.have.property('stack');
                    done();
                });
        });

        it('should hide stack trace and return a generic message in production environment', (done) => {
            process.env.NODE_ENV = 'production';
            
            request(server)
                .get('/api/auth/test-error')
                .expect(500)
                .end((err, res) => {
                    process.env.NODE_ENV = 'test';
                    
                    if (err) return done(err);
                    expect(res.body).to.have.property('error', 'حدث خطأ داخلي في الخادم.');
                    expect(res.body).to.not.have.property('stack');
                    done();
                });
        });
    });
});
