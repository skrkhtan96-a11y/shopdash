const crypto = require('crypto');

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const iterations = 310000;
    const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
    return `${iterations}:${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    if (!storedPassword) return false;
    const parts = storedPassword.split(':');
    let iterations = 1000;
    let salt, hash;
    if (parts.length === 3) {
        iterations = parseInt(parts[0], 10);
        salt = parts[1];
        hash = parts[2];
    } else {
        salt = parts[0];
        hash = parts[1];
    }
    
    try {
        const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
    } catch (e) {
        return false;
    }
}

module.exports = {
    hashPassword,
    verifyPassword
};
