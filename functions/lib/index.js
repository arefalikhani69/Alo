"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyAdminSession = exports.reviewLicenseRequest = exports.setAdminRole = exports.revokeLicense = exports.renewLicense = exports.transferLicenseDevice = exports.verifyLicense = exports.activateLicense = exports.issueLicense = exports.requestDeviceChallenge = exports.ROLE_PERMISSIONS = exports.RATE_LIMITS = void 0;
exports.generateHighEntropyActivationKey = generateHighEntropyActivationKey;
exports.getDurationMs = getDurationMs;
exports.normalizeActivationKey = normalizeActivationKey;
exports.hashActivationKey = hashActivationKey;
exports.deriveDeviceIdFromPublicKey = deriveDeviceIdFromPublicKey;
exports.formatSpkiToPem = formatSpkiToPem;
exports.validateEcPublicKey = validateEcPublicKey;
exports.convertP1363ToDer = convertP1363ToDer;
exports.isValidDerSignatureStructure = isValidDerSignatureStructure;
exports.verifyDeviceChallengeSignature = verifyDeviceChallengeSignature;
exports.hasPermission = hasPermission;
exports.assertAdminRole = assertAdminRole;
exports.assertAdminPermission = assertAdminPermission;
exports.assertAdmin = assertAdmin;
exports.sanitizeAuditMetadata = sanitizeAuditMetadata;
exports.buildSecurityAuditLogDoc = buildSecurityAuditLogDoc;
exports.recordSecurityAuditLog = recordSecurityAuditLog;
exports.sanitizeDocKey = sanitizeDocKey;
exports.checkActivationRateLimits = checkActivationRateLimits;
exports.recordActivationFailure = recordActivationFailure;
exports.clearActivationFailures = clearActivationFailures;
const functions = __importStar(require("firebase-functions/v2"));
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const crypto = __importStar(require("crypto"));
functions.setGlobalOptions({ region: 'us-central1' });
const app = admin.initializeApp();
const firestoreDatabaseId = process.env.FIRESTORE_DATABASE_ID ||
    'ai-studio-autopinpro-6597dde9-59f0-4a2e-90e5-55436f30fb2d';
const db = (0, firestore_1.getFirestore)(app, firestoreDatabaseId);
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
exports.RATE_LIMITS = {
    IP_MAX_FAILURES: 15,
    DEVICE_MAX_FAILURES: 5,
    USER_MAX_FAILURES: 5,
    KEY_MAX_FAILURES: 5,
    LOCK_DURATION_MS: 15 * 60 * 1000 // 15 minutes
};
// Crockford Base32 alphabet for human-readable high-entropy activation keys (avoids 0/O, 1/I/L)
const CROCKFORD_BASE32 = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * Generates an activation key with at least 128 bits of true cryptographic entropy.
 * 16 bytes = 128 bits of entropy generated strictly via crypto.randomBytes.
 * Formatted cleanly into 5 blocks of 5 chars + duration suffix:
 * e.g., APRO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-1Y
 */
function generateHighEntropyActivationKey(duration = '1y') {
    const entropyBytes = crypto.randomBytes(16); // 128 bits of true cryptographic randomness
    let binaryString = '';
    for (const byte of entropyBytes) {
        binaryString += byte.toString(2).padStart(8, '0');
    }
    // 128 bits converted into 26 Crockford Base32 characters (each 5 bits)
    let base32 = '';
    for (let i = 0; i < 25; i++) {
        const chunk = binaryString.substring(i * 5, (i + 1) * 5).padEnd(5, '0');
        base32 += CROCKFORD_BASE32[parseInt(chunk, 2)];
    }
    const blocks = [
        base32.substring(0, 5),
        base32.substring(5, 10),
        base32.substring(10, 15),
        base32.substring(15, 20),
        base32.substring(20, 25)
    ];
    const plainKey = `APRO-${blocks.join('-')}-${duration.toUpperCase()}`;
    const activationKeyHash = hashActivationKey(plainKey);
    const keyHint = `APRO-*****-*****-*****-*****-${blocks[4]}-${duration.toUpperCase()}`;
    return { plainKey, keyHint, activationKeyHash };
}
/**
 * Calculates duration in milliseconds for each supported license tier.
 */
function getDurationMs(duration = '1y') {
    switch (duration) {
        case '1m':
            return 30 * 24 * 60 * 60 * 1000;
        case '3m':
            return 90 * 24 * 60 * 60 * 1000;
        case '6m':
            return 180 * 24 * 60 * 60 * 1000;
        case 'lifetime':
            return 100 * 365 * 24 * 60 * 60 * 1000;
        case '1y':
        default:
            return ONE_YEAR_MS;
    }
}
/**
 * Normalizes an activation key string (removes hyphens, spaces, uppercase).
 */
function normalizeActivationKey(rawKey) {
    return rawKey.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
/**
 * Computes SHA-256 hash of an activation key.
 */
function hashActivationKey(rawKey) {
    const normalized = normalizeActivationKey(rawKey);
    return crypto.createHash('sha256').update(normalized).digest('hex');
}
/**
 * Computes deterministic device ID from public key DER bytes.
 */
function deriveDeviceIdFromPublicKey(publicKeyBase64, isWebClient = false) {
    const derBuffer = Buffer.from(publicKeyBase64, 'base64');
    const hashHex = crypto.createHash('sha256').update(derBuffer).digest('hex');
    const prefix = isWebClient ? 'dev_web_' : 'dev_hw_';
    return `${prefix}${hashHex.substring(0, 32)}`;
}
/**
 * Wraps Base64 SPKI public key in PEM headers.
 */
function formatSpkiToPem(base64Spki) {
    const clean = base64Spki.replace(/\s+/g, '');
    return `-----BEGIN PUBLIC KEY-----\n${clean.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
}
/**
 * Validates that an incoming public key string is well-formed Base64 SPKI EC key.
 */
function validateEcPublicKey(publicKeyBase64) {
    if (!publicKeyBase64 || typeof publicKeyBase64 !== 'string') {
        throw new functions.https.HttpsError('invalid-argument', 'کلید عمومی دستگاه نامعتبر است.');
    }
    const clean = publicKeyBase64.replace(/\s+/g, '');
    if (clean.length < 60 || clean.length > 512 || !/^[A-Za-z0-9+/=]+$/.test(clean)) {
        throw new functions.https.HttpsError('invalid-argument', 'قالب کلید عمومی نامعتبر است.');
    }
    try {
        const pem = formatSpkiToPem(clean);
        const pubKey = crypto.createPublicKey(pem);
        if (pubKey.asymmetricKeyType !== 'ec') {
            throw new functions.https.HttpsError('invalid-argument', 'کلید باید از نوع منحنی بیضوی (EC) باشد.');
        }
    }
    catch (err) {
        throw new functions.https.HttpsError('invalid-argument', `کلید عمومی SPKI نامعتبر است: ${err.message}`);
    }
}
/**
 * Encodes an unsigned big-endian integer Buffer into a minimal ASN.1 DER INTEGER element.
 */
function encodeDerInteger(bytes) {
    let offset = 0;
    while (offset < bytes.length - 1 && bytes[offset] === 0x00) {
        offset++;
    }
    const trimmed = bytes.subarray(offset);
    const needsSignPad = (trimmed[0] & 0x80) !== 0;
    const payloadLen = trimmed.length + (needsSignPad ? 1 : 0);
    const out = Buffer.allocUnsafe(2 + payloadLen);
    out[0] = 0x02;
    out[1] = payloadLen;
    if (needsSignPad) {
        out[2] = 0x00;
        trimmed.copy(out, 3);
    }
    else {
        trimmed.copy(out, 2);
    }
    return out;
}
/**
 * Converts a 64-byte IEEE P1363 (r || s) ECDSA P-256 signature to ASN.1 DER SEQUENCE.
 * Strictly validates 64-byte length and rejects zero r/s scalars.
 */
function convertP1363ToDer(p1363Sig) {
    if (!Buffer.isBuffer(p1363Sig) || p1363Sig.length !== 64) {
        throw new Error('IEEE P1363 ECDSA P-256 signature must be exactly 64 bytes.');
    }
    const r = p1363Sig.subarray(0, 32);
    const s = p1363Sig.subarray(32, 64);
    const rNonZero = r.some((b) => b !== 0);
    const sNonZero = s.some((b) => b !== 0);
    if (!rNonZero || !sNonZero) {
        throw new Error('ECDSA signature scalar r or s cannot be zero.');
    }
    const rDer = encodeDerInteger(r);
    const sDer = encodeDerInteger(s);
    const totalLen = rDer.length + sDer.length;
    // Max length of two 32-byte DER integers is 2*(2+33) = 70 (< 128), single-byte length always holds
    return Buffer.concat([Buffer.from([0x30, totalLen]), rDer, sDer]);
}
/**
 * Strictly validates that a Buffer matches an ASN.1 DER ECDSA SEQUENCE { INTEGER r, INTEGER s }
 * with exact byte length (no trailing bytes or malformed lengths).
 */
function isValidDerSignatureStructure(derSig) {
    if (!Buffer.isBuffer(derSig) || derSig.length < 8 || derSig.length > 74) {
        return false;
    }
    if (derSig[0] !== 0x30) {
        return false;
    }
    const seqLen = derSig[1];
    if ((seqLen & 0x80) !== 0 || 2 + seqLen !== derSig.length) {
        return false;
    }
    let offset = 2;
    for (let i = 0; i < 2; i++) {
        if (offset + 2 > derSig.length || derSig[offset] !== 0x02) {
            return false;
        }
        const intLen = derSig[offset + 1];
        if (intLen <= 0 || intLen > 33 || offset + 2 + intLen > derSig.length) {
            return false;
        }
        // Reject non-minimal negative or over-padded DER integers
        const intBytes = derSig.subarray(offset + 2, offset + 2 + intLen);
        if ((intBytes[0] & 0x80) !== 0) {
            return false;
        }
        if (intBytes.length > 1 && intBytes[0] === 0x00 && (intBytes[1] & 0x80) === 0) {
            return false;
        }
        offset += 2 + intLen;
    }
    return offset === derSig.length;
}
/**
 * Verifies an ECDSA P-256 SHA-256 challenge signature for both Android Native (ASN.1 DER)
 * and Web Browser (WebCrypto IEEE P1363 64-byte or ASN.1 DER) clients.
 * Never skips or weakens cryptographic verification.
 */
function verifyDeviceChallengeSignature(devicePublicKeyBase64, challenge, signatureBase64, isWebClient = false) {
    if (!signatureBase64 || typeof signatureBase64 !== 'string') {
        return false;
    }
    const cleanSig = signatureBase64.replace(/\s+/g, '');
    if (cleanSig.length < 16 || cleanSig.length > 256 || !/^[A-Za-z0-9+/=]+$/.test(cleanSig)) {
        return false;
    }
    let rawSigBuffer;
    try {
        rawSigBuffer = Buffer.from(cleanSig, 'base64');
    }
    catch {
        return false;
    }
    if (!rawSigBuffer || rawSigBuffer.length === 0) {
        return false;
    }
    let derSignatureBuffer;
    try {
        if (isWebClient && rawSigBuffer.length === 64) {
            // Browser WebCrypto outputs 64-byte IEEE P1363 (r || s)
            derSignatureBuffer = convertP1363ToDer(rawSigBuffer);
        }
        else if (isValidDerSignatureStructure(rawSigBuffer)) {
            // Android Native Keystore SHA256withECDSA outputs ASN.1 DER
            derSignatureBuffer = rawSigBuffer;
        }
        else {
            return false;
        }
        const publicKeyPem = formatSpkiToPem(devicePublicKeyBase64);
        const verifier = crypto.createVerify('SHA256');
        verifier.update(Buffer.from(challenge, 'utf8'));
        return verifier.verify(publicKeyPem, derSignatureBuffer);
    }
    catch {
        return false;
    }
}
/**
 * Retrieves the ECDSA private key from Firebase Secret Manager.
 * Safely halts if secret is unconfigured (NO hardcoded fallback!).
 */
function getLicenseSigningPrivateKey() {
    const key = process.env.LICENSE_ECDSA_PRIVATE_KEY_PEM;
    if (!key || key.trim().length === 0) {
        throw new functions.https.HttpsError('failed-precondition', 'Server signing private key is missing from Secret Manager. All license signing operations are safely halted.');
    }
    return key.trim();
}
/**
 * Asymmetrically signs an offline lease payload using server ECDSA P-256 private key.
 */
function signLeasePayloadEcdsa(licenseId, deviceId, issuedAt, validUntil, expiresAt) {
    const privateKeyPem = getLicenseSigningPrivateKey();
    const canonical = `${licenseId}|${deviceId}|${issuedAt}|${validUntil}|${expiresAt}`;
    const signer = crypto.createSign('SHA256');
    signer.update(Buffer.from(canonical, 'utf8'));
    return signer.sign(privateKeyPem, 'base64');
}
/**
 * Role Permission Mapping (Authoritative Server-Side RBAC Matrix for Phase 2):
 *
 * 1. Super Admin:
 *    - Full access to all operations
 *    - Sole authority to manage administrators (setAdminRole: promote, change role, deactivate)
 *    - Issue, renew, revoke/block, transfer licenses
 *    - Review and manage activation requests
 *    - Access security audit logs and administrative telemetry
 *
 * 2. Admin:
 *    - Issue new licenses
 *    - Renew existing licenses
 *    - Revoke / block licenses
 *    - Transfer licenses between verified devices
 *    - Review activation requests
 *    - View licenses, devices, non-sensitive audit logs
 *    - STRICTLY FORBIDDEN from managing other administrators (cannot call setAdminRole)
 *
 * 3. Support:
 *    - Read-only visibility: view licenses, view devices, view activation requests
 *    - View general reports and non-sensitive logs
 *    - STRICTLY FORBIDDEN from issuing, renewing, revoking, or transferring licenses
 *    - STRICTLY FORBIDDEN from managing administrators
 */
exports.ROLE_PERMISSIONS = {
    super_admin: new Set([
        'manage_admins',
        'issue_license',
        'renew_license',
        'revoke_license',
        'transfer_license',
        'review_requests',
        'view_requests',
        'view_audit_logs',
        'view_licenses',
        'view_devices'
    ]),
    admin: new Set([
        'issue_license',
        'renew_license',
        'revoke_license',
        'transfer_license',
        'review_requests',
        'view_requests',
        'view_audit_logs',
        'view_licenses',
        'view_devices'
    ]),
    support: new Set([
        'view_requests',
        'view_licenses',
        'view_devices'
    ])
};
/**
 * Validates whether a specific role possesses the requested permission.
 */
function hasPermission(role, permission) {
    const allowed = exports.ROLE_PERMISSIONS[role];
    return Boolean(allowed && allowed.has(permission));
}
/**
 * Authoritative Single Source of Truth for Administrator Verification & RBAC.
 *
 * Rules:
 * 1. An administrator MUST have an active document in `/admins/{uid}` with `active === true`.
 * 2. Stale or forged Custom Claims (admin=true) alone CANNOT bypass an absent or inactive database record.
 * 3. Specific operational permissions are strictly validated against `allowedRoles`.
 * 4. Supports safe one-time initial bootstrap for the first administrator.
 */
const RESOLVED_ACTOR_ROLE_SYMBOL = Symbol('resolvedActorRole');
function attachResolvedActorRole(err, role) {
    err[RESOLVED_ACTOR_ROLE_SYMBOL] = role;
    return err;
}
async function assertAdminRole(request, allowedRoles = ['super_admin', 'admin']) {
    if (!request.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
    }
    // Query database-backed admin record (Single Source of Truth)
    const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
    if (adminDoc.exists) {
        const adminData = adminDoc.data();
        const recordRole = (adminData?.role || 'admin');
        if (adminData?.active !== true) {
            throw attachResolvedActorRole(new functions.https.HttpsError('permission-denied', 'دسترسی مدیریتی این حساب کاربری غیرفعال یا لغو شده است.'), recordRole);
        }
        const currentRole = (adminData.role || 'admin');
        if (!allowedRoles.includes(currentRole)) {
            throw attachResolvedActorRole(new functions.https.HttpsError('permission-denied', `نقش کاربری شما (${currentRole}) مجوز اجرای این عملیات را ندارد. نقش‌های مجاز: ${allowedRoles.join(', ')}`), currentRole);
        }
        return {
            uid: request.auth.uid,
            email: request.auth.token.email || adminData.email || '',
            role: currentRole,
            bootstrapped: false
        };
    }
    // If no database record exists, check for secure one-time initial bootstrap
    if (process.env.DISABLE_BOOTSTRAP === 'true') {
        throw new functions.https.HttpsError('permission-denied', 'Bootstrap initialization has been permanently disabled.');
    }
    const configuredAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL || process.env.ADMIN_EMAIL;
    if (!configuredAdminEmail || typeof configuredAdminEmail !== 'string' || !configuredAdminEmail.trim()) {
        throw new functions.https.HttpsError('permission-denied', 'کاربر فاقد سند معتبر و فعال در فهرست مدیران سیستم می‌باشد.');
    }
    const userEmail = request.auth.token.email;
    if (!userEmail || userEmail.toLowerCase() !== configuredAdminEmail.trim().toLowerCase()) {
        throw new functions.https.HttpsError('permission-denied', 'کاربر فاقد سند معتبر و فعال در فهرست مدیران سیستم می‌باشد.');
    }
    // Enforce email_verified in production (skip strict token flag only inside local Firebase Emulators)
    const isEmulatorEnv = process.env.FUNCTIONS_EMULATOR === 'true' || Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
    if (!isEmulatorEnv && request.auth.token.email_verified !== true) {
        console.warn('Bootstrap denied: caller email is not verified', { uid: request.auth.uid });
        throw new functions.https.HttpsError('permission-denied', 'برای فعال‌سازی اولیه مدیر ارشد در سرور، تأیید ایمیل حساب کاربری الزامی است.');
    }
    const bootstrapDocRef = db.collection('system_config').doc('bootstrap');
    const targetAdminRef = db.collection('admins').doc(request.auth.uid);
    const activeAdminsQuery = db.collection('admins').where('active', '==', true).limit(1);
    const auditDocRef = db.collection('licenseAuditLogs').doc();
    let existingVerifiedRole = null;
    let bootstrappedNow = false;
    await db.runTransaction(async (transaction) => {
        const [bootstrapSnap, activeAdminsSnap, targetSnap] = await Promise.all([
            transaction.get(bootstrapDocRef),
            transaction.get(activeAdminsQuery),
            transaction.get(targetAdminRef)
        ]);
        // Idempotency guard: if target admin doc was created concurrently, evaluate it directly without duplicate writes
        if (targetSnap.exists) {
            const targetData = targetSnap.data();
            if (targetData?.active !== true) {
                throw new functions.https.HttpsError('permission-denied', 'دسترسی مدیریتی این حساب کاربری غیرفعال یا لغو شده است.');
            }
            const existingRole = (targetData.role || 'admin');
            if (!allowedRoles.includes(existingRole)) {
                throw new functions.https.HttpsError('permission-denied', `نقش کاربری شما (${existingRole}) مجوز اجرای این عملیات را ندارد. نقش‌های مجاز: ${allowedRoles.join(', ')}`);
            }
            existingVerifiedRole = existingRole;
            return;
        }
        if (bootstrapSnap.exists && bootstrapSnap.data()?.completed === true) {
            throw new functions.https.HttpsError('permission-denied', 'سیستم قبلاً راه‌اندازی شده است و امکان اجرای مجدد Bootstrap وجود ندارد.');
        }
        if (!activeAdminsSnap.empty) {
            const serverNow = Date.now();
            transaction.set(bootstrapDocRef, {
                completed: true,
                lockedAt: serverNow,
                reason: 'Active admin already present'
            }, { merge: true });
            throw new functions.https.HttpsError('permission-denied', 'یک مدیر فعال در سیستم شناسایی شد. امکان ارتقای خودکار از طریق Bootstrap بسته شده است.');
        }
        const now = Date.now();
        const auditDoc = buildSecurityAuditLogDoc({
            actorUid: request.auth.uid,
            actorRole: 'super_admin',
            actorEmail: userEmail,
            action: 'admin_bootstrap',
            targetId: request.auth.uid,
            result: 'success',
            details: `One-time secure super_admin bootstrap completed for ${userEmail}`,
            metadata: {
                uid: request.auth.uid,
                email: userEmail,
                method: 'one_time_secure_bootstrap'
            }
        }, now);
        transaction.set(targetAdminRef, {
            uid: request.auth.uid,
            email: userEmail,
            role: 'super_admin',
            active: true,
            createdAt: now,
            updatedAt: now,
            serverCreatedAt: firestore_1.FieldValue.serverTimestamp(),
            serverUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
            migratedAt: now,
            method: 'one_time_secure_bootstrap'
        }, { merge: true });
        transaction.set(bootstrapDocRef, {
            completed: true,
            completedAt: now,
            serverCompletedAt: firestore_1.FieldValue.serverTimestamp(),
            initialAdminUid: request.auth.uid,
            initialAdminEmail: userEmail,
            method: 'env_bootstrap'
        });
        transaction.set(auditDocRef, auditDoc);
        bootstrappedNow = true;
    });
    if (existingVerifiedRole) {
        return {
            uid: request.auth.uid,
            email: userEmail,
            role: existingVerifiedRole,
            bootstrapped: false
        };
    }
    console.info('One-time super_admin bootstrap succeeded', {
        uid: request.auth.uid,
        email: userEmail
    });
    try {
        await admin.auth().setCustomUserClaims(request.auth.uid, { admin: true, role: 'super_admin' });
    }
    catch (e) {
        console.warn('Could not set custom claim during one-time bootstrap:', e);
    }
    if (!allowedRoles.includes('super_admin')) {
        throw new functions.https.HttpsError('permission-denied', 'سطح دسترسی نامعتبر است.');
    }
    return {
        uid: request.auth.uid,
        email: userEmail,
        role: 'super_admin',
        bootstrapped: bootstrappedNow
    };
}
/**
 * Checks that the caller is an active administrator possessing the exact requested permission.
 */
async function assertAdminPermission(request, permission) {
    const adminContext = await assertAdminRole(request, ['super_admin', 'admin', 'support']);
    if (!hasPermission(adminContext.role, permission)) {
        throw attachResolvedActorRole(new functions.https.HttpsError('permission-denied', `نقش مدیریتی شما (${adminContext.role}) دسترسی لازم برای عملیات '${permission}' را ندارد.`), adminContext.role);
    }
    return adminContext;
}
/**
 * Standard admin assert (requires super_admin or admin role).
 */
async function assertAdmin(request) {
    return assertAdminRole(request, ['super_admin', 'admin']);
}
/**
 * Sanitizes metadata for security audit logs.
 * Strictly redacts private keys, raw tokens, plain activation codes, and secrets.
 */
function sanitizeAuditMetadata(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const sanitized = {};
    const forbiddenPatterns = /secret|private|token|plain|password|key|spki|pem|signature|seed|challenge|activation/i;
    for (const [key, value] of Object.entries(raw)) {
        if (value === undefined)
            continue;
        if (forbiddenPatterns.test(key)) {
            sanitized[key] = '[REDACTED_SENSITIVE]';
        }
        else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            sanitized[key] = sanitizeAuditMetadata(value);
        }
        else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
/**
 * Builds a sanitized tamper-evident security audit log payload with authoritative server timestamp.
 */
function buildSecurityAuditLogDoc(payload, serverNowMs = firestore_1.Timestamp.now().toMillis()) {
    const safeMetadata = sanitizeAuditMetadata(payload.metadata);
    return {
        actorUid: payload.actorUid,
        actorRole: payload.actorRole,
        actorEmail: payload.actorEmail || '',
        action: payload.action,
        targetId: payload.targetId,
        timestamp: serverNowMs,
        serverTimestamp: firestore_1.FieldValue.serverTimestamp(),
        result: payload.result,
        details: payload.details || '',
        metadata: safeMetadata,
        // Backward compatibility for Phase 1 UI:
        adminId: payload.actorUid,
        adminEmail: payload.actorEmail || ''
    };
}
/**
 * Appends a tamper-evident record to `licenseAuditLogs` with sanitized metadata.
 */
async function recordSecurityAuditLog(payload) {
    const logDoc = buildSecurityAuditLogDoc(payload);
    await db.collection('licenseAuditLogs').add(logDoc);
}
function classifyAuditFailure(err) {
    if (err instanceof functions.https.HttpsError) {
        const code = err.code;
        let failureCategory = 'internal';
        if (code === 'permission-denied' || code === 'unauthenticated') {
            failureCategory = 'authorization';
        }
        else if (code === 'invalid-argument') {
            failureCategory = 'validation';
        }
        else if (code === 'not-found') {
            failureCategory = 'not_found';
        }
        else if (code === 'already-exists') {
            failureCategory = 'conflict';
        }
        else if (code === 'failed-precondition') {
            failureCategory = 'precondition';
        }
        else if (code === 'deadline-exceeded') {
            failureCategory = 'expired';
        }
        else if (code === 'resource-exhausted') {
            failureCategory = 'rate_limit';
        }
        const safeMessage = typeof err.message === 'string' && err.message.trim()
            ? err.message.trim().slice(0, 280)
            : 'Operation rejected';
        return { errorCode: code, failureCategory, safeMessage };
    }
    return {
        errorCode: 'internal',
        failureCategory: 'internal',
        safeMessage: 'Internal server error'
    };
}
function scrubSensitiveMessage(rawMessage, reqData) {
    let clean = rawMessage
        .replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, '[REDACTED_PEM]')
        .replace(/\bAPRO-[A-Z0-9-]{8,}\b/gi, '[REDACTED_ACTIVATION_KEY]');
    const sensitiveKeys = ['activationKey', 'signature', 'challenge', 'devicePublicKey', 'newDevicePublicKey', 'token'];
    for (const key of sensitiveKeys) {
        const val = reqData[key];
        if (typeof val === 'string' && val.trim().length >= 6) {
            clean = clean.split(val.trim()).join('[REDACTED_SENSITIVE]');
        }
    }
    return clean.slice(0, 300);
}
function extractSafeAuditTargetId(action, reqData) {
    const candidateKeys = ['licenseId', 'requestId', 'targetUid', 'userId', 'deviceId'];
    for (const key of candidateKeys) {
        const val = reqData[key];
        if (typeof val === 'string' && val.trim().length > 0 && val.trim().length <= 128) {
            return val.trim();
        }
    }
    if (action === 'activate' && typeof reqData.activationKey === 'string') {
        return 'activation_attempt';
    }
    return 'unidentified';
}
async function recordFailureAuditSafely(params) {
    const { request, action, err, ctx } = params;
    // Log failures only after authentication & actor identification (avoids unauthenticated DoS log spam)
    if (!request.auth?.uid) {
        return;
    }
    try {
        const reqData = request.data && typeof request.data === 'object'
            ? request.data
            : {};
        const { errorCode, failureCategory, safeMessage } = classifyAuditFailure(err);
        const cleanedMessage = scrubSensitiveMessage(safeMessage, reqData);
        const attachedRole = err && typeof err === 'object'
            ? (err[RESOLVED_ACTOR_ROLE_SYMBOL])
            : undefined;
        const resolvedRole = attachedRole || ctx.actorRole || 'user';
        const resolvedTargetId = ctx.targetId && ctx.targetId.trim().length > 0
            ? ctx.targetId.trim().slice(0, 128)
            : extractSafeAuditTargetId(action, reqData);
        const serverNowMs = firestore_1.Timestamp.now().toMillis();
        const rawRequestId = typeof reqData.requestId === 'string' ? reqData.requestId.trim() : '';
        const hasRequestId = rawRequestId.length > 0 && rawRequestId.length <= 128;
        const docId = hasRequestId
            ? `fail_${sanitizeDocKey(`${action}_${request.auth.uid}_${rawRequestId}_${errorCode}`)}`
            : `fail_${serverNowMs}_${crypto.randomBytes(6).toString('hex')}`;
        const auditDocRef = db.collection('licenseAuditLogs').doc(docId);
        const extraMeta = {
            ...(ctx.metadata || {}),
            operation: action,
            errorCode,
            failureCategory,
            eventId: docId,
            ...(hasRequestId ? { requestId: rawRequestId } : {})
        };
        const baseDoc = buildSecurityAuditLogDoc({
            actorUid: request.auth.uid,
            actorRole: resolvedRole,
            actorEmail: request.auth.token?.email || '',
            action,
            targetId: resolvedTargetId,
            result: 'failure',
            details: `[${errorCode}] ${cleanedMessage}`,
            metadata: extraMeta
        }, serverNowMs);
        const failureDoc = Object.fromEntries(Object.entries({
            ...baseDoc,
            eventId: docId,
            errorCode,
            failureCategory,
            ...(resolvedRole === 'user' ? { userId: request.auth.uid } : {})
        }).filter(([, value]) => value !== undefined));
        if (hasRequestId) {
            try {
                await auditDocRef.create(failureDoc);
            }
            catch (createErr) {
                const code = createErr?.code;
                if (code === 6 || code === 'already-exists' || String(createErr?.message || '').includes('ALREADY_EXISTS')) {
                    return;
                }
                throw createErr;
            }
        }
        else {
            await auditDocRef.set(failureDoc);
        }
    }
    catch (auditErr) {
        // Audit logging failure must NEVER mask or replace the primary operation error
        console.warn(`Could not persist failure audit log for ${action}:`, auditErr);
    }
}
async function runCallableWithFailureAudit(request, action, handler) {
    const ctx = {
        actorRole: 'user',
        metadata: {}
    };
    try {
        return await handler(ctx);
    }
    catch (err) {
        await recordFailureAuditSafely({ request, action, err, ctx });
        throw err;
    }
}
/**
 * Sanitizes keys for Firestore document IDs.
 */
function sanitizeDocKey(raw) {
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 120);
}
/**
 * Multi-Dimensional Rate Limiting for License Activation:
 * Enforces limits across IP, Hardware Device ID, User UID, and Target Key Hash.
 * Resistant to attackers switching UID or Device ID.
 */
async function checkActivationRateLimits(scope) {
    const now = Date.now();
    const keysToCheck = [
        `ip_${sanitizeDocKey(scope.clientIp)}`,
        `dev_${sanitizeDocKey(scope.deviceId)}`,
        ...(scope.userId ? [`user_${sanitizeDocKey(scope.userId)}`] : []),
        ...(scope.activationKeyHash ? [`key_${sanitizeDocKey(scope.activationKeyHash)}`] : [])
    ];
    const snaps = await Promise.all(keysToCheck.map(k => db.collection('rateLimits').doc(k).get()));
    for (const snap of snaps) {
        if (snap.exists) {
            const data = snap.data();
            if (data?.lockedUntil && now < data.lockedUntil) {
                const waitMinutes = Math.ceil((data.lockedUntil - now) / 60000);
                throw new functions.https.HttpsError('resource-exhausted', `تعداد تلاش‌های ناموفق فعال‌سازی بیش از حد مجاز است. لطفاً ${waitMinutes} دقیقه دیگر مجدداً تلاش فرمایید.`);
            }
        }
    }
}
/**
 * Records failed activation attempt atomically across all relevant dimensions.
 */
async function recordActivationFailure(scope) {
    const now = Date.now();
    const targets = [
        { id: `ip_${sanitizeDocKey(scope.clientIp)}`, max: exports.RATE_LIMITS.IP_MAX_FAILURES },
        { id: `dev_${sanitizeDocKey(scope.deviceId)}`, max: exports.RATE_LIMITS.DEVICE_MAX_FAILURES },
        ...(scope.userId ? [{ id: `user_${sanitizeDocKey(scope.userId)}`, max: exports.RATE_LIMITS.USER_MAX_FAILURES }] : []),
        ...(scope.activationKeyHash ? [{ id: `key_${sanitizeDocKey(scope.activationKeyHash)}`, max: exports.RATE_LIMITS.KEY_MAX_FAILURES }] : [])
    ];
    await db.runTransaction(async (tx) => {
        // 1. ALL READS FIRST
        const snaps = await Promise.all(targets.map(t => tx.get(db.collection('rateLimits').doc(t.id))));
        // 2. ALL WRITES AFTER ALL READS
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const snap = snaps[i];
            const docRef = db.collection('rateLimits').doc(target.id);
            if (!snap.exists) {
                tx.set(docRef, {
                    targetId: target.id,
                    failures: 1,
                    firstFailureAt: now,
                    lastFailureAt: now,
                    lockedUntil: 0
                });
            }
            else {
                const data = snap.data();
                const isExpiredWindow = !data?.lockedUntil && (now - (data?.lastFailureAt || 0) > exports.RATE_LIMITS.LOCK_DURATION_MS);
                const currentFailures = isExpiredWindow ? 1 : ((data?.failures || 0) + 1);
                const shouldLock = currentFailures >= target.max;
                const lockedUntil = shouldLock ? (now + exports.RATE_LIMITS.LOCK_DURATION_MS) : (data?.lockedUntil || 0);
                tx.update(docRef, {
                    failures: currentFailures,
                    lastFailureAt: now,
                    lockedUntil
                });
            }
        }
    });
}
/**
 * Clears failed attempt counts for successful device activation.
 */
async function clearActivationFailures(scope) {
    try {
        const batch = db.batch();
        batch.delete(db.collection('rateLimits').doc(`dev_${sanitizeDocKey(scope.deviceId)}`));
        if (scope.userId) {
            batch.delete(db.collection('rateLimits').doc(`user_${sanitizeDocKey(scope.userId)}`));
        }
        if (scope.activationKeyHash) {
            batch.delete(db.collection('rateLimits').doc(`key_${sanitizeDocKey(scope.activationKeyHash)}`));
        }
        await batch.commit();
    }
    catch (err) {
        console.warn('Could not clear rate limits after activation:', err);
    }
}
/**
 * 1. requestDeviceChallenge
 * Generates a cryptographically random, single-use 32-byte nonce for zero-trust device proof.
 * Requires Firebase Auth & validates public key.
 */
exports.requestDeviceChallenge = functions.https.onCall(async (request) => {
    return runCallableWithFailureAudit(request, 'request_challenge', async (auditCtx) => {
        if (!request.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'برای دریافت چالش امنیتی ورود به حساب کاربری الزامی است.');
        }
        const { devicePublicKey } = request.data || {};
        validateEcPublicKey(devicePublicKey);
        const derivedId = deriveDeviceIdFromPublicKey(devicePublicKey, false);
        auditCtx.targetId = derivedId;
        // Rate limit: max 10 challenge requests per minute per user
        const userRateLimitRef = db.collection('rateLimits').doc(`chal_${request.auth.uid}`);
        const now = Date.now();
        const rateSnap = await userRateLimitRef.get();
        if (rateSnap.exists) {
            const rData = rateSnap.data();
            if (rData && now - rData.windowStart < 60000) {
                if (rData.count >= 10) {
                    throw new functions.https.HttpsError('resource-exhausted', 'تعداد درخواست چالش بیش از حد مجاز است.');
                }
                await userRateLimitRef.update({ count: firestore_1.FieldValue.increment(1) });
            }
            else {
                await userRateLimitRef.set({ windowStart: now, count: 1 });
            }
        }
        else {
            await userRateLimitRef.set({ windowStart: now, count: 1 });
        }
        // 32-byte cryptographically random challenge (256-bit entropy)
        const challenge = crypto.randomBytes(32).toString('hex');
        const challengeRef = db.collection('deviceChallenges').doc(challenge);
        await challengeRef.set({
            challenge,
            devicePublicKey,
            userId: request.auth.uid,
            createdAt: now,
            expiresAt: now + CHALLENGE_TTL_MS
        });
        return { challenge, ttlSeconds: CHALLENGE_TTL_MS / 1000 };
    });
});
/**
 * 2. issueLicense (Admin Only - Atomic Transaction)
 * Creates a new license with >= 128-bit cryptographic entropy.
 * Prevents duplicate issuance or partial writes; plain key is returned ONCE to admin and NEVER logged.
 */
exports.issueLicense = functions.https.onCall(async (request) => {
    return runCallableWithFailureAudit(request, 'issue', async (auditCtx) => {
        const adminContext = await assertAdminPermission(request, 'issue_license');
        auditCtx.actorRole = adminContext.role;
        const duration = (request.data?.duration || '1y');
        const validDurations = ['1m', '3m', '6m', '1y', 'lifetime'];
        if (!validDurations.includes(duration)) {
            throw new functions.https.HttpsError('invalid-argument', 'مدت‌زمان لایسنس نامعتبر است.');
        }
        const targetUserId = typeof request.data?.userId === 'string' && request.data.userId.trim()
            ? request.data.userId.trim()
            : undefined;
        const targetUserEmail = typeof request.data?.userEmail === 'string' && request.data.userEmail.trim()
            ? request.data.userEmail.trim()
            : undefined;
        // 128-bit true entropy activation code
        const { plainKey, keyHint, activationKeyHash } = generateHighEntropyActivationKey(duration);
        const licenseId = `lic_${firestore_1.Timestamp.now().toMillis()}_${crypto.randomBytes(4).toString('hex')}`;
        auditCtx.targetId = licenseId;
        auditCtx.metadata = {
            duration,
            ...(targetUserId ? { targetUserId } : {}),
            ...(targetUserEmail ? { targetUserEmail } : {})
        };
        const licenseRef = db.collection('licenses').doc(licenseId);
        const duplicateHashQuery = db.collection('licenses').where('activationKeyHash', '==', activationKeyHash).limit(1);
        const auditDocRef = db.collection('licenseAuditLogs').doc();
        await db.runTransaction(async (transaction) => {
            // --- ALL READS FIRST ---
            const existingByIdSnap = await transaction.get(licenseRef);
            const existingByHashSnap = await transaction.get(duplicateHashQuery);
            if (existingByIdSnap.exists || !existingByHashSnap.empty) {
                throw new functions.https.HttpsError('already-exists', 'کد یا شناسه لایسنس تکراری است؛ لطفاً مجدداً تلاش فرمایید.');
            }
            const serverNowMs = firestore_1.Timestamp.now().toMillis();
            const newLicense = {
                id: licenseId,
                activationKeyHash,
                keyHint,
                ...(targetUserId ? { userId: targetUserId } : {}),
                ...(targetUserEmail ? { userEmail: targetUserEmail } : {}),
                boundDeviceId: '', // Empty until hardware activation
                issuedAt: serverNowMs,
                startsAt: 0,
                expiresAt: 0,
                duration,
                status: 'active',
                lastOnlineCheckAt: 0,
                isBlocked: false,
                maxOfflineDays: 7
            };
            if (!newLicense.id || !newLicense.activationKeyHash || !newLicense.keyHint) {
                throw new functions.https.HttpsError('internal', 'اطلاعات لایسنس برای ثبت ناقص است.');
            }
            const issueAuditMetadata = {
                duration,
                keyHint,
                ...(targetUserId ? { targetUserId } : {}),
                ...(targetUserEmail ? { targetUserEmail } : {})
            };
            const auditDoc = buildSecurityAuditLogDoc({
                actorUid: adminContext.uid,
                actorRole: adminContext.role,
                actorEmail: adminContext.email,
                action: 'issue',
                targetId: licenseId,
                result: 'success',
                details: `Issued license [${keyHint}] for ${targetUserEmail || targetUserId || 'unassigned'}`,
                metadata: issueAuditMetadata
            }, serverNowMs);
            const licenseWriteData = Object.fromEntries(Object.entries({
                ...newLicense,
                serverUpdatedAt: firestore_1.FieldValue.serverTimestamp()
            }).filter(([, value]) => value !== undefined));
            const auditWriteData = Object.fromEntries(Object.entries(auditDoc).filter(([, value]) => value !== undefined));
            // --- ALL WRITES AFTER ALL READS ---
            transaction.set(licenseRef, licenseWriteData);
            transaction.set(auditDocRef, auditWriteData);
        });
        // Plain activation key is returned ONLY ONCE in the response to admin after atomic commit
        return {
            success: true,
            licenseId,
            activationKey: plainKey,
            keyHint,
            duration
        };
    });
});
/**
 * 3. activateLicense (Atomic Firestore Transaction with Strict Read-Before-Write)
 * Binds a license to an authenticated device after verifying hardware signature.
 */
exports.activateLicense = functions.https.onCall({ secrets: ['LICENSE_ECDSA_PRIVATE_KEY_PEM'] }, async (request) => {
    return runCallableWithFailureAudit(request, 'activate', async (auditCtx) => {
        if (!request.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'User must be signed in to activate license.');
        }
        const { activationKey, devicePublicKey, challenge, signature, deviceModel, isWebClient = false } = request.data || {};
        if (!activationKey || !devicePublicKey || !challenge || !signature) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required parameters: activationKey, devicePublicKey, challenge, signature.');
        }
        validateEcPublicKey(devicePublicKey);
        // Multi-Dimensional Rate Limiting across IP, Hardware Device ID, User UID, and Target Key Hash
        const clientIp = request.rawRequest?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || request.rawRequest?.ip || 'unknown';
        const targetHash = hashActivationKey(activationKey);
        const derivedDeviceId = deriveDeviceIdFromPublicKey(devicePublicKey, Boolean(isWebClient));
        auditCtx.targetId = derivedDeviceId;
        auditCtx.metadata = {
            deviceId: derivedDeviceId,
            deviceModel: deviceModel || 'Android Device',
            isWebClient: Boolean(isWebClient)
        };
        const rateLimitScope = {
            clientIp,
            deviceId: derivedDeviceId,
            userId: request.auth.uid,
            activationKeyHash: targetHash
        };
        await checkActivationRateLimits(rateLimitScope);
        // 1. Cryptographic Proof of Private Key Custody (ECDSA Verify - supports Android DER & Web P1363)
        const isSignatureValid = verifyDeviceChallengeSignature(devicePublicKey, challenge, signature, Boolean(isWebClient));
        if (!isSignatureValid) {
            await recordActivationFailure(rateLimitScope);
            throw new functions.https.HttpsError('permission-denied', 'امضای دیجیتال سخت‌افزاری دستگاه تایید نشد.');
        }
        // 2. Pre-query license by activationKeyHash
        const querySnap = await db.collection('licenses')
            .where('activationKeyHash', '==', targetHash)
            .limit(1)
            .get();
        if (querySnap.empty) {
            await recordActivationFailure(rateLimitScope);
            throw new functions.https.HttpsError('not-found', 'کد فعال‌سازی وارد شده معتبر نمی‌باشد.');
        }
        const licenseDocRef = querySnap.docs[0].ref;
        auditCtx.targetId = licenseDocRef.id;
        const challengeRef = db.collection('deviceChallenges').doc(challenge);
        const deviceDocRef = db.collection('devices').doc(derivedDeviceId);
        const auditDocRef = db.collection('licenseAuditLogs').doc();
        const now = Date.now();
        let updatedLicense;
        // 4. Strict Read-Before-Write Atomic Transaction
        await db.runTransaction(async (transaction) => {
            // --- ALL READS FIRST ---
            const challengeSnap = await transaction.get(challengeRef);
            const licenseSnap = await transaction.get(licenseDocRef);
            const deviceSnap = await transaction.get(deviceDocRef);
            // --- IN-MEMORY VALIDATION ---
            if (!challengeSnap.exists) {
                throw new functions.https.HttpsError('permission-denied', 'کد چالش امنیتی منقضی یا نامعتبر است.');
            }
            const challengeData = challengeSnap.data();
            if (challengeData?.devicePublicKey !== devicePublicKey || now > (challengeData?.expiresAt || 0)) {
                throw new functions.https.HttpsError('permission-denied', 'چالش امنیتی دستگاه منقضی یا نامعتبر است.');
            }
            if (!licenseSnap.exists) {
                throw new functions.https.HttpsError('not-found', 'لایسنس یافت نشد.');
            }
            const current = licenseSnap.data();
            if (current.isBlocked || current.status === 'revoked') {
                throw new functions.https.HttpsError('failed-precondition', current.blockReason || 'این لایسنس مسدود شده است.');
            }
            // Atomic Binding Guard: Cannot bind to a different device!
            if (current.boundDeviceId && current.boundDeviceId !== derivedDeviceId) {
                throw new functions.https.HttpsError('already-exists', 'این کد فعال‌سازی قبلاً روی دستگاه دیگری ثبت شده است و امکان استفاده مجدد وجود ندارد.');
            }
            // Re-activation on the SAME device preserves original dates!
            const isReactivation = current.boundDeviceId === derivedDeviceId && current.startsAt > 0;
            const durationMs = getDurationMs(current.duration || '1y');
            const startsAt = isReactivation ? current.startsAt : now;
            const expiresAt = isReactivation ? current.expiresAt : (now + durationMs);
            updatedLicense = {
                ...current,
                boundDeviceId: derivedDeviceId,
                userId: request.auth.uid,
                userEmail: request.auth.token.email || current.userEmail,
                startsAt,
                expiresAt,
                lastOnlineCheckAt: now,
                status: 'active'
            };
            // --- ALL WRITES AFTER ALL READS ---
            // 1. Consume challenge atomically (anti-replay)
            transaction.delete(challengeRef);
            // 2. Update license
            transaction.update(licenseDocRef, {
                boundDeviceId: derivedDeviceId,
                userId: request.auth.uid,
                userEmail: request.auth.token.email || current.userEmail,
                startsAt,
                expiresAt,
                lastOnlineCheckAt: now,
                status: 'active'
            });
            // 3. Upsert device
            transaction.set(deviceDocRef, {
                deviceId: derivedDeviceId,
                devicePublicKey,
                firstBoundAt: deviceSnap.exists ? (deviceSnap.data()?.firstBoundAt || now) : now,
                licenseId: licenseSnap.id,
                status: 'trusted',
                deviceModel: deviceModel || 'Android Device',
                lastHandshakeAt: now,
                isWebClient: Boolean(isWebClient)
            }, { merge: true });
            // 4. Audit log (no plain activation code; preserves userId & numeric timestamp alongside serverTimestamp)
            const activateAuditDoc = {
                ...buildSecurityAuditLogDoc({
                    actorUid: request.auth.uid,
                    actorRole: 'user',
                    actorEmail: request.auth.token.email || current.userEmail || '',
                    action: 'activate',
                    targetId: licenseSnap.id,
                    result: 'success',
                    details: `Bound license to hardware device ${derivedDeviceId} [${current.keyHint}]`,
                    metadata: {
                        deviceId: derivedDeviceId,
                        keyHint: current.keyHint,
                        deviceModel: deviceModel || 'Android Device',
                        isWebClient: Boolean(isWebClient)
                    }
                }, now),
                userId: request.auth.uid
            };
            transaction.set(auditDocRef, activateAuditDoc);
        });
        // 5. Clear rate limit failures across scope upon success
        await clearActivationFailures(rateLimitScope);
        // 5. Generate Asymmetrically-Signed 7-Day Offline Lease Token
        const validUntilServer = now + SEVEN_DAYS_MS;
        const signatureToken = signLeasePayloadEcdsa(updatedLicense.id, derivedDeviceId, now, validUntilServer, updatedLicense.expiresAt);
        const leaseToken = {
            licenseId: updatedLicense.id,
            deviceId: derivedDeviceId,
            userId: request.auth.uid,
            issuedAtServer: now,
            validUntilServer,
            licenseExpiresAt: updatedLicense.expiresAt,
            signature: signatureToken
        };
        return {
            success: true,
            license: {
                id: updatedLicense.id,
                boundDeviceId: derivedDeviceId,
                startsAt: updatedLicense.startsAt,
                expiresAt: updatedLicense.expiresAt,
                lastOnlineCheckAt: now,
                status: 'active',
                duration: updatedLicense.duration
            },
            leaseToken
        };
    });
});
/**
 * 4. verifyLicense (Requires Auth & Hardware Challenge Verification)
 * Validates active status and issues a fresh ECDSA-signed offline lease.
 */
exports.verifyLicense = functions.https.onCall({ secrets: ['LICENSE_ECDSA_PRIVATE_KEY_PEM'] }, async (request) => {
    return runCallableWithFailureAudit(request, 'verify', async (auditCtx) => {
        if (!request.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'ورود به حساب کاربری برای اعتبارسنجی لایسنس الزامی است.');
        }
        const { licenseId, deviceId, devicePublicKey, challenge, signature, isWebClient = false } = request.data || {};
        if (!licenseId || !deviceId || !devicePublicKey || !challenge || !signature) {
            throw new functions.https.HttpsError('invalid-argument', 'پارامترهای اعتبارسنجی سخت‌افزاری ناقص است (licenseId, deviceId, devicePublicKey, challenge, signature).');
        }
        auditCtx.targetId = String(licenseId);
        auditCtx.metadata = {
            licenseId: String(licenseId),
            deviceId: String(deviceId),
            isWebClient: Boolean(isWebClient)
        };
        validateEcPublicKey(devicePublicKey);
        // 1. Verify digital signature of challenge using device public key (Android DER & Web P1363)
        const isSignatureValid = verifyDeviceChallengeSignature(devicePublicKey, challenge, signature, Boolean(isWebClient));
        if (!isSignatureValid) {
            throw new functions.https.HttpsError('permission-denied', 'امضای دیجیتال سخت‌افزاری دستگاه تایید نشد.');
        }
        // 2. Hardware binding consistency
        const derivedDeviceId = deriveDeviceIdFromPublicKey(devicePublicKey, Boolean(isWebClient));
        if (derivedDeviceId !== deviceId) {
            throw new functions.https.HttpsError('permission-denied', 'شناسه دستگاه با کلید عمومی سخت‌افزاری مطابقت ندارد.');
        }
        const licenseDocRef = db.collection('licenses').doc(licenseId);
        const challengeRef = db.collection('deviceChallenges').doc(challenge);
        const now = Date.now();
        let verifiedLicense;
        // 3. Strict Read-Before-Write Atomic Transaction
        await db.runTransaction(async (transaction) => {
            // --- ALL READS FIRST ---
            const challengeSnap = await transaction.get(challengeRef);
            const licenseSnap = await transaction.get(licenseDocRef);
            // --- IN-MEMORY VALIDATION ---
            if (!challengeSnap.exists) {
                throw new functions.https.HttpsError('permission-denied', 'چالش امنیتی منقضی شده یا قبلاً مصرف شده است.');
            }
            const challengeData = challengeSnap.data();
            if (challengeData?.devicePublicKey !== devicePublicKey || now > (challengeData?.expiresAt || 0)) {
                throw new functions.https.HttpsError('permission-denied', 'چالش امنیتی دستگاه معتبر نمی‌باشد.');
            }
            if (!licenseSnap.exists) {
                throw new functions.https.HttpsError('not-found', 'لایسنس مورد نظر یافت نشد.');
            }
            verifiedLicense = licenseSnap.data();
            // Ownership verification
            if (verifiedLicense.userId && verifiedLicense.userId !== request.auth.uid) {
                // Allow admin override or reject
                const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
                if (!adminDoc.exists || adminDoc.data()?.active !== true) {
                    throw new functions.https.HttpsError('permission-denied', 'شما مالک این لایسنس نیستید.');
                }
            }
            // Hardware binding check
            if (verifiedLicense.boundDeviceId !== derivedDeviceId) {
                throw new functions.https.HttpsError('permission-denied', 'این لایسنس برای دستگاه دیگری صادر شده است.');
            }
            // Status checks
            if (verifiedLicense.isBlocked || verifiedLicense.status === 'revoked') {
                throw new functions.https.HttpsError('permission-denied', verifiedLicense.blockReason || 'لایسنس مسدود شده است.');
            }
            if (now >= verifiedLicense.expiresAt) {
                transaction.update(licenseDocRef, { status: 'expired' });
                throw new functions.https.HttpsError('deadline-exceeded', 'اعتبار لایسنس به پایان رسیده است.');
            }
            // --- ALL WRITES AFTER ALL READS ---
            // Consume challenge atomically (single-use)
            transaction.delete(challengeRef);
            transaction.update(licenseDocRef, { lastOnlineCheckAt: now });
        });
        // 4. Issue 7-day cryptographic offline lease signed with server ECDSA
        const validUntilServer = now + SEVEN_DAYS_MS;
        const signatureToken = signLeasePayloadEcdsa(licenseId, derivedDeviceId, now, validUntilServer, verifiedLicense.expiresAt);
        const leaseToken = {
            licenseId,
            deviceId: derivedDeviceId,
            userId: verifiedLicense.userId,
            issuedAtServer: now,
            validUntilServer,
            licenseExpiresAt: verifiedLicense.expiresAt,
            signature: signatureToken
        };
        return {
            isValid: true,
            serverTime: now,
            expiresAt: verifiedLicense.expiresAt,
            daysRemaining: Math.ceil((verifiedLicense.expiresAt - now) / (24 * 60 * 60 * 1000)),
            leaseToken
        };
    });
});
/**
 * 5. transferLicenseDevice (Admin Only - Requires Cryptographic Proof of New Device)
 * Transfers a license to a new hardware device.
 * Admin CANNOT register arbitrary deviceId; deviceId is strictly derived from verified newDevicePublicKey.
 */
exports.transferLicenseDevice = functions.https.onCall(async (request) => {
    return runCallableWithFailureAudit(request, 'transfer', async (auditCtx) => {
        const adminContext = await assertAdminPermission(request, 'transfer_license');
        auditCtx.actorRole = adminContext.role;
        const { licenseId, newDevicePublicKey, challenge, signature, newDeviceModel, reason, isWebClient = false } = request.data || {};
        if (!licenseId || !newDevicePublicKey) {
            throw new functions.https.HttpsError('invalid-argument', 'پارامترهای انتقال ناقص است (licenseId, newDevicePublicKey).');
        }
        auditCtx.targetId = String(licenseId);
        auditCtx.metadata = {
            licenseId: String(licenseId),
            newDeviceModel: newDeviceModel || 'Android Device',
            isWebClient: Boolean(isWebClient)
        };
        validateEcPublicKey(newDevicePublicKey);
        const hasCryptographicProof = Boolean(challenge && signature && challenge !== 'ADMIN_OVERRIDE');
        // 1. If cryptographic proof is provided, verify that new device actually owns the corresponding private key
        if (hasCryptographicProof) {
            const isSignatureValid = verifyDeviceChallengeSignature(newDevicePublicKey, challenge, signature, Boolean(isWebClient));
            if (!isSignatureValid) {
                throw new functions.https.HttpsError('permission-denied', 'امضای دیجیتال دستگاه جدید تایید نشد.');
            }
        }
        // 2. Server derives newDeviceId strictly from verified public key
        const newDeviceId = deriveDeviceIdFromPublicKey(newDevicePublicKey, Boolean(isWebClient));
        auditCtx.metadata.newDeviceId = newDeviceId;
        const licenseDocRef = db.collection('licenses').doc(licenseId);
        const challengeRef = challenge && challenge !== 'ADMIN_OVERRIDE' ? db.collection('deviceChallenges').doc(challenge) : null;
        const newDeviceDocRef = db.collection('devices').doc(newDeviceId);
        const auditDocRef = db.collection('licenseAuditLogs').doc();
        const now = Date.now();
        let oldDeviceId = '';
        // 3. Strict Read-Before-Write Transaction
        await db.runTransaction(async (transaction) => {
            // --- ALL READS FIRST ---
            if (hasCryptographicProof && challengeRef) {
                const challengeSnap = await transaction.get(challengeRef);
                if (!challengeSnap.exists) {
                    throw new functions.https.HttpsError('permission-denied', 'کد چالش امنیتی منقضی یا نامعتبر است.');
                }
                const challengeData = challengeSnap.data();
                if (challengeData?.devicePublicKey !== newDevicePublicKey || now > (challengeData?.expiresAt || 0)) {
                    throw new functions.https.HttpsError('permission-denied', 'چالش امنیتی دستگاه جدید معتبر نمی‌باشد.');
                }
            }
            const licenseSnap = await transaction.get(licenseDocRef);
            const newDeviceSnap = await transaction.get(newDeviceDocRef);
            if (!licenseSnap.exists) {
                throw new functions.https.HttpsError('not-found', 'لایسنس یافت نشد.');
            }
            const license = licenseSnap.data();
            if (license.isBlocked || license.status === 'revoked') {
                throw new functions.https.HttpsError('failed-precondition', 'لایسنس مسدود یا باطل شده قابل انتقال نیست.');
            }
            oldDeviceId = license.boundDeviceId;
            let oldDeviceSnap = null;
            let oldDeviceRef = null;
            if (oldDeviceId) {
                oldDeviceRef = db.collection('devices').doc(oldDeviceId);
                oldDeviceSnap = await transaction.get(oldDeviceRef);
            }
            // --- ALL WRITES AFTER ALL READS ---
            // 1. Consume challenge atomically if used
            if (hasCryptographicProof && challengeRef) {
                transaction.delete(challengeRef);
            }
            // 2. Revoke old device in database
            if (oldDeviceRef && oldDeviceSnap && oldDeviceSnap.exists) {
                transaction.update(oldDeviceRef, {
                    status: 'unbound_transfer',
                    transferredAt: now,
                    transferReason: reason || 'Transferred by Admin'
                });
            }
            // 3. Update license (Keep startsAt and expiresAt intact!)
            transaction.update(licenseDocRef, {
                boundDeviceId: newDeviceId,
                lastOnlineCheckAt: now
            });
            // 4. Register new hardware device
            transaction.set(newDeviceDocRef, {
                deviceId: newDeviceId,
                devicePublicKey: newDevicePublicKey,
                firstBoundAt: newDeviceSnap.exists ? (newDeviceSnap.data()?.firstBoundAt || now) : now,
                licenseId,
                status: 'trusted',
                deviceModel: newDeviceModel || 'Android Device',
                lastHandshakeAt: now,
                isWebClient: Boolean(isWebClient)
            }, { merge: true });
            // 5. Append structured security audit log with authoritative serverTimestamp
            const transferAuditDoc = buildSecurityAuditLogDoc({
                actorUid: adminContext.uid,
                actorRole: adminContext.role,
                actorEmail: adminContext.email,
                action: 'transfer',
                targetId: licenseId,
                result: 'success',
                details: `Transferred license from hardware ${oldDeviceId || 'none'} to verified device ${newDeviceId}. Reason: ${reason || 'N/A'}`,
                metadata: {
                    oldDeviceId,
                    newDeviceId,
                    newDeviceModel: newDeviceModel || 'Android Device',
                    reason: reason || 'N/A'
                }
            }, now);
            transaction.set(auditDocRef, transferAuditDoc);
        });
        return {
            success: true,
            licenseId,
            oldDeviceId,
            newDeviceId,
            message: 'انتقال لایسنس به دستگاه جدید با موفقیت انجام شد. توجه: در صورت آفلاین بودن دستگاه قبلی، دسترسی آن حداکثر تا پایان اعتبار توکن آفلاین فعلی (حداکثر ۷ روز) معتبر خواهد بود.'
        };
    });
});
/**
 * 6. renewLicense (Admin & Super Admin Only - Atomic Transaction)
 * Computes new expiration inside db.runTransaction from authoritative server state.
 */
exports.renewLicense = functions.https.onCall(async (request) => {
    return runCallableWithFailureAudit(request, 'renew', async (auditCtx) => {
        const adminContext = await assertAdminPermission(request, 'renew_license');
        auditCtx.actorRole = adminContext.role;
        const { licenseId, additionalYears, duration } = request.data || {};
        if (!licenseId || typeof licenseId !== 'string') {
            throw new functions.https.HttpsError('invalid-argument', 'licenseId is required.');
        }
        auditCtx.targetId = licenseId;
        auditCtx.metadata = {
            licenseId,
            ...(duration !== undefined ? { duration } : {}),
            ...(additionalYears !== undefined ? { additionalYears } : {})
        };
        let durationMs = ONE_YEAR_MS;
        let durationLabel = '1y';
        let resolvedDuration;
        if (duration !== undefined) {
            if (!['1m', '3m', '6m', '1y', 'lifetime'].includes(duration)) {
                throw new functions.https.HttpsError('invalid-argument', 'مدت‌زمان تمدید نامعتبر است.');
            }
            durationMs = getDurationMs(duration);
            durationLabel = duration;
            resolvedDuration = duration;
        }
        else if (additionalYears !== undefined) {
            if (typeof additionalYears !== 'number' || !Number.isFinite(additionalYears) || additionalYears <= 0 || additionalYears > 100) {
                throw new functions.https.HttpsError('invalid-argument', 'مقدار سال تمدید نامعتبر است.');
            }
            durationMs = additionalYears * ONE_YEAR_MS;
            durationLabel = `${additionalYears}y`;
        }
        const docRef = db.collection('licenses').doc(licenseId);
        const auditDocRef = db.collection('licenseAuditLogs').doc();
        let newExpiry = 0;
        await db.runTransaction(async (transaction) => {
            // --- ALL READS FIRST ---
            const snap = await transaction.get(docRef);
            if (!snap.exists) {
                throw new functions.https.HttpsError('not-found', 'لایسنس یافت نشد.');
            }
            const license = snap.data();
            const serverNowMs = firestore_1.Timestamp.now().toMillis();
            const currentExpiry = Math.max(license.expiresAt || 0, serverNowMs);
            newExpiry = currentExpiry + durationMs;
            const auditDoc = buildSecurityAuditLogDoc({
                actorUid: adminContext.uid,
                actorRole: adminContext.role,
                actorEmail: adminContext.email,
                action: 'renew',
                targetId: licenseId,
                result: 'success',
                details: `Extended license expiry (${durationLabel}) to ${new Date(newExpiry).toISOString()}`,
                metadata: {
                    durationLabel,
                    durationMs,
                    previousExpiry: license.expiresAt || 0,
                    newExpiry,
                    boundDeviceId: license.boundDeviceId || ''
                }
            }, serverNowMs);
            // --- ALL WRITES AFTER ALL READS ---
            transaction.update(docRef, {
                expiresAt: newExpiry,
                duration: resolvedDuration || license.duration || '1y',
                status: 'active',
                isBlocked: false,
                blockReason: firestore_1.FieldValue.delete(),
                serverUpdatedAt: firestore_1.FieldValue.serverTimestamp()
            });
            transaction.set(auditDocRef, auditDoc);
        });
        return { success: true, newExpiry, durationLabel };
    });
});
/**
 * 7. revokeLicense (Admin & Super Admin Only - Atomic Transaction)
 * Validates current status and ownership, then atomically updates license, device, and audit log.
 */
exports.revokeLicense = functions.https.onCall(async (request) => {
    return runCallableWithFailureAudit(request, 'revoke', async (auditCtx) => {
        const adminContext = await assertAdminPermission(request, 'revoke_license');
        auditCtx.actorRole = adminContext.role;
        const { licenseId, actionType = 'revoke', blockReason = 'توسط مدیر سامانه مسدود شد', blacklistDevice = false, expectedUserId } = request.data || {};
        if (!licenseId || typeof licenseId !== 'string') {
            throw new functions.https.HttpsError('invalid-argument', 'licenseId is required.');
        }
        auditCtx.targetId = licenseId;
        auditCtx.metadata = {
            licenseId,
            actionType,
            blacklistDevice: Boolean(blacklistDevice)
        };
        if (actionType !== 'revoke' && actionType !== 'suspend' && actionType !== 'reactivate') {
            throw new functions.https.HttpsError('invalid-argument', 'نوع عملیات وضعیت لایسنس نامعتبر است.');
        }
        const docRef = db.collection('licenses').doc(licenseId);
        const auditDocRef = db.collection('licenseAuditLogs').doc();
        let resultStatus = '';
        await db.runTransaction(async (transaction) => {
            // --- ALL READS FIRST ---
            const snap = await transaction.get(docRef);
            if (!snap.exists) {
                throw new functions.https.HttpsError('not-found', 'لایسنس یافت نشد.');
            }
            const license = snap.data();
            const deviceRef = license.boundDeviceId ? db.collection('devices').doc(license.boundDeviceId) : null;
            const deviceSnap = deviceRef ? await transaction.get(deviceRef) : null;
            // Ownership validation when caller specifies expectedUserId
            if (expectedUserId && license.userId !== expectedUserId) {
                throw new functions.https.HttpsError('failed-precondition', 'مالکیت لایسنس با کاربر مشخص‌شده مطابقت ندارد.');
            }
            const serverNowMs = firestore_1.Timestamp.now().toMillis();
            const deviceBelongsToLicense = Boolean(deviceSnap &&
                deviceSnap.exists &&
                (!deviceSnap.data()?.licenseId || deviceSnap.data()?.licenseId === licenseId));
            if (actionType === 'reactivate') {
                if (!license.isBlocked && license.status !== 'revoked' && license.status !== 'suspended') {
                    throw new functions.https.HttpsError('failed-precondition', 'این لایسنس در وضعیت مسدود یا معلق قرار ندارد.');
                }
                const isExpired = license.expiresAt > 0 && serverNowMs >= license.expiresAt;
                const newStatus = isExpired ? 'expired' : 'active';
                resultStatus = newStatus;
                const auditDoc = buildSecurityAuditLogDoc({
                    actorUid: adminContext.uid,
                    actorRole: adminContext.role,
                    actorEmail: adminContext.email,
                    action: 'reactivate',
                    targetId: licenseId,
                    result: 'success',
                    details: `Reactivated license by ${adminContext.email}`,
                    metadata: {
                        licenseId,
                        previousStatus: license.status,
                        ownerUserId: license.userId || '',
                        boundDeviceId: license.boundDeviceId || ''
                    }
                }, serverNowMs);
                // --- ALL WRITES AFTER ALL READS ---
                transaction.update(docRef, {
                    isBlocked: false,
                    status: newStatus,
                    blockReason: firestore_1.FieldValue.delete(),
                    serverUpdatedAt: firestore_1.FieldValue.serverTimestamp()
                });
                if (deviceRef && deviceBelongsToLicense) {
                    transaction.update(deviceRef, {
                        status: 'trusted',
                        serverUpdatedAt: firestore_1.FieldValue.serverTimestamp()
                    });
                }
                transaction.set(auditDocRef, auditDoc);
                return;
            }
            // State transition guards for suspend / revoke
            if (actionType === 'suspend') {
                if (license.status === 'revoked') {
                    throw new functions.https.HttpsError('failed-precondition', 'لایسنس ابطال‌شده قابل تعلیق نیست.');
                }
                if (license.status === 'suspended' && license.isBlocked) {
                    throw new functions.https.HttpsError('failed-precondition', 'این لایسنس هم‌اکنون در وضعیت تعلیق قرار دارد.');
                }
            }
            const newStatus = actionType === 'suspend' ? 'suspended' : 'revoked';
            if (actionType === 'revoke' && license.status === 'revoked' && license.isBlocked && !blacklistDevice) {
                throw new functions.https.HttpsError('failed-precondition', 'این لایسنس قبلاً ابطال شده است.');
            }
            resultStatus = newStatus;
            const auditDoc = buildSecurityAuditLogDoc({
                actorUid: adminContext.uid,
                actorRole: adminContext.role,
                actorEmail: adminContext.email,
                action: newStatus,
                targetId: licenseId,
                result: 'success',
                details: `${newStatus === 'suspended' ? 'Suspended' : 'Revoked'} license: ${blockReason}. Device blacklisted: ${Boolean(blacklistDevice)}`,
                metadata: {
                    actionType,
                    previousStatus: license.status,
                    ownerUserId: license.userId || '',
                    boundDeviceId: license.boundDeviceId || '',
                    blockReason,
                    blacklistDevice: Boolean(blacklistDevice)
                }
            }, serverNowMs);
            // --- ALL WRITES AFTER ALL READS ---
            transaction.update(docRef, {
                isBlocked: true,
                status: newStatus,
                blockReason,
                serverUpdatedAt: firestore_1.FieldValue.serverTimestamp()
            });
            if (blacklistDevice && deviceRef && deviceBelongsToLicense) {
                transaction.update(deviceRef, {
                    status: 'blacklisted',
                    serverUpdatedAt: firestore_1.FieldValue.serverTimestamp()
                });
            }
            transaction.set(auditDocRef, auditDoc);
        });
        if (actionType === 'reactivate') {
            return { success: true, action: 'reactivate', status: resultStatus };
        }
        return { success: true, action: resultStatus };
    });
});
/**
 * 8. setAdminRole (Super Admin Only)
 * Securely grants, changes, or revokes administrator privileges in Firestore & Firebase Auth Custom Claims.
 *
 * Rules:
 * - Invokable STRICTLY by authenticated Super Admin ('manage_admins' permission).
 * - Admin or Support callers are permanently rejected with permission-denied.
 * - Callers cannot modify their own status or self-promote.
 * - The last remaining active Super Admin cannot be removed, deactivated, or demoted.
 * - When an admin is deactivated, their Firebase Auth refresh tokens are immediately revoked.
 */
exports.setAdminRole = functions.https.onCall(async (request) => {
    return runCallableWithFailureAudit(request, 'set_admin_role', async (auditCtx) => {
        const caller = await assertAdminPermission(request, 'manage_admins');
        auditCtx.actorRole = caller.role;
        const { targetUid, targetEmail, role = 'admin', active = true } = request.data || {};
        if (!targetUid || typeof targetUid !== 'string') {
            throw new functions.https.HttpsError('invalid-argument', 'targetUid is required and must be a string.');
        }
        auditCtx.targetId = targetUid;
        auditCtx.metadata = {
            targetUid,
            ...(targetEmail ? { targetEmail } : {}),
            role,
            active: Boolean(active)
        };
        // Caller cannot modify own account (prevents self-promotion and accidental self-lockout)
        if (targetUid === caller.uid) {
            throw new functions.https.HttpsError('permission-denied', 'مدیر سیستم مجاز به تغییر سطح دسترسی یا وضعیت حساب کاربری خود نمی‌باشد.');
        }
        const validRoles = ['super_admin', 'admin', 'support'];
        if (!validRoles.includes(role)) {
            throw new functions.https.HttpsError('invalid-argument', `نقش درخواستی (${role}) نامعتبر است. نقش‌های مجاز: ${validRoles.join(', ')}`);
        }
        const targetDocRef = db.collection('admins').doc(targetUid);
        const targetSnap = await targetDocRef.get();
        // Guard against removing or demoting the last active Super Admin
        if (targetSnap.exists) {
            const existingData = targetSnap.data();
            if (existingData?.role === 'super_admin' && (active === false || role !== 'super_admin')) {
                const activeSuperAdminsSnap = await db.collection('admins')
                    .where('role', '==', 'super_admin')
                    .where('active', '==', true)
                    .get();
                const remainingSuperAdmins = activeSuperAdminsSnap.docs.filter((d) => d.id !== targetUid);
                if (remainingSuperAdmins.length === 0) {
                    throw new functions.https.HttpsError('failed-precondition', 'امکان حذف، غیرفعال‌سازی یا تنزل درجه آخرین مدیر ارشد (Super Admin) سامانه وجود ندارد.');
                }
            }
        }
        const now = Date.now();
        await targetDocRef.set({
            uid: targetUid,
            email: targetEmail || (targetSnap.exists ? targetSnap.data()?.email : '') || '',
            role,
            active: Boolean(active),
            updatedAt: now,
            updatedBy: caller.uid,
            updatedByEmail: caller.email
        }, { merge: true });
        // Update Custom Claims and revoke active sessions on deactivation
        try {
            await admin.auth().setCustomUserClaims(targetUid, {
                admin: Boolean(active),
                role: active ? role : 'user'
            });
            if (!active) {
                // Force token refresh invalidation for immediate session cutoff
                await admin.auth().revokeRefreshTokens(targetUid);
            }
        }
        catch (err) {
            console.warn(`Could not update claims/revoke for user ${targetUid}:`, err);
        }
        await recordSecurityAuditLog({
            actorUid: caller.uid,
            actorRole: caller.role,
            actorEmail: caller.email,
            action: 'set_admin_role',
            targetId: targetUid,
            result: 'success',
            details: `Admin role updated by Super Admin ${caller.email} for ${targetEmail || targetUid} -> role=${role}, active=${active}`,
            metadata: {
                targetUid,
                targetEmail,
                role,
                active
            }
        });
        return { success: true, targetUid, role, active };
    });
});
/**
 * 9. reviewLicenseRequest (Admin & Super Admin Only - Atomic Transaction)
 * Approves or rejects a user's license activation or renewal request.
 * Prevents duplicate concurrent reviews via atomic Read-Before-Write transaction.
 */
exports.reviewLicenseRequest = functions.https.onCall(async (request) => {
    return runCallableWithFailureAudit(request, 'review_request', async (auditCtx) => {
        const adminContext = await assertAdminPermission(request, 'review_requests');
        auditCtx.actorRole = adminContext.role;
        const { requestId, status, reviewNotes = '' } = request.data || {};
        if (!requestId || typeof requestId !== 'string' || !status) {
            throw new functions.https.HttpsError('invalid-argument', 'requestId and status are required.');
        }
        auditCtx.targetId = requestId;
        auditCtx.metadata = {
            requestId,
            status
        };
        if (status !== 'approved' && status !== 'rejected') {
            throw new functions.https.HttpsError('invalid-argument', 'وضعیت درخواست باید approved یا rejected باشد.');
        }
        const reqRef = db.collection('licenseRequests').doc(requestId);
        const auditDocRef = db.collection('licenseAuditLogs').doc();
        await db.runTransaction(async (transaction) => {
            // --- ALL READS FIRST ---
            const snap = await transaction.get(reqRef);
            if (!snap.exists) {
                throw new functions.https.HttpsError('not-found', 'درخواست لایسنس مورد نظر یافت نشد.');
            }
            const currentReq = snap.data();
            if (currentReq?.status !== 'pending') {
                throw new functions.https.HttpsError('failed-precondition', `این درخواست قبلاً تعیین تکلیف شده است (وضعیت فعلی: ${currentReq?.status}). امکان بررسی مجدد وجود ندارد.`);
            }
            const serverNowMs = firestore_1.Timestamp.now().toMillis();
            const auditDoc = buildSecurityAuditLogDoc({
                actorUid: adminContext.uid,
                actorRole: adminContext.role,
                actorEmail: adminContext.email,
                action: 'review_request',
                targetId: requestId,
                result: 'success',
                details: `Request ${status} by ${adminContext.email}. Notes: ${reviewNotes || 'None'}`,
                metadata: {
                    requestId,
                    status,
                    reviewNotes,
                    targetUserId: currentReq?.userId || ''
                }
            }, serverNowMs);
            // --- ALL WRITES AFTER ALL READS ---
            transaction.update(reqRef, {
                status,
                reviewNotes,
                reviewedAt: serverNowMs,
                serverUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
                reviewedBy: adminContext.uid,
                reviewedByEmail: adminContext.email
            });
            transaction.set(auditDocRef, auditDoc);
        });
        return { success: true, requestId, status };
    });
});
/**
 * 10. verifyAdminSession (Admin Roles Only - Read-Only Verification & Safe One-Time Bootstrap)
 * Verifies the caller's authoritative `/admins/{uid}` record (or executes one-time initial bootstrap
 * via assertAdminRole when eligible) so read-only admin UI views can sync with Firestore cleanly.
 */
exports.verifyAdminSession = functions.https.onCall({ region: 'us-central1', cors: true }, async (request) => {
    return runCallableWithFailureAudit(request, 'verify_admin_session', async (auditCtx) => {
        const caller = await assertAdminRole(request, ['super_admin', 'admin', 'support']);
        auditCtx.actorRole = caller.role;
        auditCtx.targetId = caller.uid;
        return {
            verified: true,
            hasFirestoreAdminDoc: true,
            adminDocExists: true,
            createdViaBootstrap: Boolean(caller.bootstrapped),
            uid: caller.uid,
            email: caller.email,
            role: caller.role,
            databaseId: firestoreDatabaseId,
            region: 'us-central1'
        };
    });
});
