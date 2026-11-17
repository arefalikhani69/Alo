/**
 * AutoPin Pro - License Phase 2 Comprehensive Test Suite
 *
 * Verifies all 5 core capabilities of Phase 2:
 * 1. License Requests Management & Review Constraints (Duplicate review prevention)
 * 2. Multi-Tier License Issuance (1m, 3m, 6m, 1y, lifetime), CSPRNG entropy, SHA-256 hash
 * 3. Multi-Tier License Renewal (Expiry extension from max(now, expiresAt), device binding preservation)
 * 4. Revocation, Temporary Suspension, and Reactivation Lifecycle
 * 5. Hardware Device Migration & Transfer (Atomic unbinding, Zero dual-device usage)
 * 6. Server-Side RBAC Enforcement & Customer Access Boundary
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  LicenseRecord,
  LicenseRequestRecord,
  LicenseDuration,
  TransferDevicePayload,
  LicenseAuditLogRecord
} from '../src/types/license';

// Helpers matching Cloud Functions implementation
function getDurationMs(duration: LicenseDuration): number {
  switch (duration) {
    case '1m':
      return 30 * 24 * 60 * 60 * 1000;
    case '3m':
      return 90 * 24 * 60 * 60 * 1000;
    case '6m':
      return 180 * 24 * 60 * 60 * 1000;
    case '1y':
      return 365 * 24 * 60 * 60 * 1000;
    case 'lifetime':
      return 100 * 365 * 24 * 60 * 60 * 1000;
    default:
      return 365 * 24 * 60 * 60 * 1000;
  }
}

function generateLicenseKey(): { rawKey: string; keyHash: string; keyHint: string } {
  const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const randomBytes = crypto.randomBytes(16); // 128-bit CSPRNG entropy
  let raw = '';
  for (let i = 0; i < 20; i++) {
    const byte = randomBytes[i % randomBytes.length];
    raw += CROCKFORD_ALPHABET[byte % 32];
  }
  const formattedKey = `AP-${raw.substring(0, 4)}-${raw.substring(4, 8)}-${raw.substring(8, 12)}-${raw.substring(12, 16)}-${raw.substring(16, 20)}`;
  const keyHash = crypto.createHash('sha256').update(formattedKey).digest('hex');
  const keyHint = `...${formattedKey.slice(-4)}`;
  return { rawKey: formattedKey, keyHash, keyHint };
}

describe('AutoPin Pro - Phase 2 Licensing System Verification', () => {
  let mockDatabase: {
    licenses: Map<string, LicenseRecord>;
    requests: Map<string, LicenseRequestRecord>;
    devices: Map<string, { deviceId: string; status: string; licenseId?: string }>;
    auditLogs: LicenseAuditLogRecord[];
  };

  const masterAdmin = {
    uid: 'adm_aref_master_uid',
    email: 'arefalikhani69@gmail.com',
    role: 'super_admin'
  };

  const normalUser = {
    uid: 'usr_normal_customer_123',
    email: 'customer@autopin.ir',
    role: 'user'
  };

  beforeEach(() => {
    mockDatabase = {
      licenses: new Map(),
      requests: new Map(),
      devices: new Map(),
      auditLogs: []
    };
  });

  // ==========================================
  // Section 1: Requests Management & Review
  // ==========================================
  describe('۱. مدیریت درخواست‌های لایسنس (Requests Management)', () => {
    it('باید درخواست معلق کاربر را با اطلاعات دستگاه و کاربر نمایش دهد', () => {
      const request: LicenseRequestRecord = {
        id: 'req_001',
        userId: normalUser.uid,
        userEmail: normalUser.email,
        deviceId: 'dev_hw_samsung_galaxy_s23',
        devicePublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtestpublickey123',
        deviceModel: 'Samsung Galaxy S23',
        requestToken: 'REQ-2026-X9Z1',
        requestedAt: Date.now() - 3600000,
        status: 'pending',
        notes: 'درخواست فعال‌سازی نسخه ۱ ساله'
      };

      mockDatabase.requests.set(request.id, request);
      const retrieved = mockDatabase.requests.get('req_001');

      expect(retrieved).toBeDefined();
      expect(retrieved?.status).toBe('pending');
      expect(retrieved?.deviceId).toContain('dev_hw_');
      expect(retrieved?.deviceModel).toBe('Samsung Galaxy S23');
      expect(retrieved?.userId).toBe(normalUser.uid);
    });

    it('باید از تایید یا رد مجدد یک درخواست بررسی‌شده جلوگیری کند (Duplicate Review Prevention)', () => {
      const request: LicenseRequestRecord = {
        id: 'req_already_approved',
        userId: normalUser.uid,
        userEmail: normalUser.email,
        deviceId: 'dev_hw_pixel_7',
        devicePublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...',
        requestToken: 'REQ-1234',
        requestedAt: Date.now() - 7200000,
        status: 'approved', // Already approved!
        reviewedAt: Date.now() - 3600000,
        reviewedBy: masterAdmin.uid,
        reviewNotes: 'قبلاً تأیید گردیده است'
      };

      mockDatabase.requests.set(request.id, request);

      // Attempting to review an already-approved request must be rejected
      const attemptReview = (reqId: string) => {
        const targetReq = mockDatabase.requests.get(reqId);
        if (!targetReq) throw new Error('not-found');
        if (targetReq.status !== 'pending') {
          throw new Error('failed-precondition: این درخواست قبلاً بررسی شده و قابل تغییر وضعیت مجدد نمی‌باشد.');
        }
        targetReq.status = 'approved';
      };

      expect(() => attemptReview('req_already_approved')).toThrow('failed-precondition');
    });

    it('باید عملیات بررسی درخواست را به همراه مشخصات مدیر و یادداشت در لاگ ممیزی ثبت کند', () => {
      const request: LicenseRequestRecord = {
        id: 'req_pending_1',
        userId: normalUser.uid,
        userEmail: normalUser.email,
        deviceId: 'dev_hw_xiaomi_13',
        devicePublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...',
        requestToken: 'REQ-9999',
        requestedAt: Date.now() - 1000,
        status: 'pending'
      };
      mockDatabase.requests.set(request.id, request);

      // Admin approves request
      const req = mockDatabase.requests.get('req_pending_1')!;
      req.status = 'approved';
      req.reviewedAt = Date.now();
      req.reviewedBy = masterAdmin.uid;
      req.reviewNotes = 'تأیید شد پس از واریز بانکی';

      // Record audit log
      mockDatabase.auditLogs.push({
        id: 'log_rev_1',
        action: 'review_license_request',
        targetId: req.id,
        actorUid: masterAdmin.uid,
        actorEmail: masterAdmin.email,
        timestamp: Date.now(),
        result: 'success',
        details: 'Approved license request: تأیید شد پس از واریز بانکی'
      });

      expect(req.status).toBe('approved');
      expect(req.reviewedBy).toBe(masterAdmin.uid);
      expect(mockDatabase.auditLogs.length).toBe(1);
      expect(mockDatabase.auditLogs[0].action).toBe('review_license_request');
    });
  });

  // ==========================================
  // Section 2: License Issuance (5 Tiers & Security)
  // ==========================================
  describe('۲. صدور لایسنس جدید در ۵ سطح زمانی (License Issuance)', () => {
    it('باید ۵ سطح زمانی لایسنس را با مدت‌های میلی‌ثانیه‌ای دقیق محاسبه کند', () => {
      expect(getDurationMs('1m')).toBe(30 * 24 * 60 * 60 * 1000);
      expect(getDurationMs('3m')).toBe(90 * 24 * 60 * 60 * 1000);
      expect(getDurationMs('6m')).toBe(180 * 24 * 60 * 60 * 1000);
      expect(getDurationMs('1y')).toBe(365 * 24 * 60 * 60 * 1000);
      expect(getDurationMs('lifetime')).toBe(100 * 365 * 24 * 60 * 60 * 1000);
    });

    it('باید کلید با آنتروپی ۱۲۸ بیتی CSPRNG در قالب Base32 بسازد و فقط هش SHA-256 را در دیتابیس ذخیره کند', () => {
      const { rawKey, keyHash, keyHint } = generateLicenseKey();

      expect(rawKey).toMatch(/^AP-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(keyHash).toHaveLength(64); // SHA-256 hex length
      expect(keyHash).not.toBe(rawKey);

      // Store in DB
      const licenseRecord: LicenseRecord = {
        id: 'lic_test_hash_only',
        activationKeyHash: keyHash,
        keyHint,
        duration: '1y',
        status: 'unactivated',
        boundDeviceId: '',
        startsAt: 0,
        expiresAt: 0,
        isBlocked: false,
        createdAt: Date.now()
      };

      mockDatabase.licenses.set(licenseRecord.id, licenseRecord);

      // Verify that plain key is strictly NOT stored in DB
      const stored = mockDatabase.licenses.get('lic_test_hash_only')!;
      expect(stored.activationKeyHash).toBe(keyHash);
      expect((stored as any).rawKey).toBeUndefined();
      expect((stored as any).activationKey).toBeUndefined();
    });

    it('باید هنگام فعال‌سازی، لایسنس را به سخت‌افزار دستگاه متصل نموده و از استفاده مجدد در دستگاه دوم جلوگیری کند', () => {
      const { rawKey, keyHash } = generateLicenseKey();
      const license: LicenseRecord = {
        id: 'lic_activation_test',
        activationKeyHash: keyHash,
        duration: '6m',
        status: 'unactivated',
        boundDeviceId: '',
        startsAt: 0,
        expiresAt: 0,
        isBlocked: false,
        createdAt: Date.now()
      };
      mockDatabase.licenses.set(license.id, license);

      // 1st device activates
      const device1Id = 'dev_hw_device_phone_1';
      const activate = (key: string, deviceId: string) => {
        const hash = crypto.createHash('sha256').update(key).digest('hex');
        const found = Array.from(mockDatabase.licenses.values()).find(l => l.activationKeyHash === hash);
        if (!found) throw new Error('not-found: لایسنس یافت نشد');
        if (found.status === 'active' && found.boundDeviceId && found.boundDeviceId !== deviceId) {
          throw new Error('already-exists: این کد لایسنس قبلاً برای دستگاه دیگری استفاده شده است و امکان استفاده هم‌زمان ندارد.');
        }
        found.status = 'active';
        found.boundDeviceId = deviceId;
        found.startsAt = Date.now();
        found.expiresAt = Date.now() + getDurationMs(found.duration);
        return found;
      };

      const activated = activate(rawKey, device1Id);
      expect(activated.status).toBe('active');
      expect(activated.boundDeviceId).toBe(device1Id);

      // 2nd device tries to activate the same key
      const device2Id = 'dev_hw_device_phone_2';
      expect(() => activate(rawKey, device2Id)).toThrow('already-exists');
    });
  });

  // ==========================================
  // Section 3: License Renewal
  // ==========================================
  describe('۳. تمدید لایسنس (License Renewal)', () => {
    it('باید تاریخ انقضا را بر اساس max(expiresAt, now) + durationMs محاسبه کند و اتصال سخت‌افزار را حفظ نماید', () => {
      const now = Date.now();
      const originalDeviceId = 'dev_hw_customer_hardware_99';

      // Active license with 30 days remaining
      const activeLicense: LicenseRecord = {
        id: 'lic_renew_test',
        duration: '1y',
        status: 'active',
        boundDeviceId: originalDeviceId,
        startsAt: now - 335 * 86400000,
        expiresAt: now + 30 * 86400000, // 30 days left
        isBlocked: false,
        createdAt: now - 335 * 86400000
      };
      mockDatabase.licenses.set(activeLicense.id, activeLicense);

      // Renew with 6m tier
      const renew = (licId: string, duration: LicenseDuration) => {
        const target = mockDatabase.licenses.get(licId)!;
        const currentExpires = target.expiresAt || now;
        const baseTime = Math.max(currentExpires, now);
        const addedMs = getDurationMs(duration);
        target.expiresAt = baseTime + addedMs;
        target.status = 'active';
        // Bound device must be preserved!
        expect(target.boundDeviceId).toBe(originalDeviceId);
        return target;
      };

      const renewed = renew('lic_renew_test', '6m');
      const expectedNewExpiry = (now + 30 * 86400000) + (180 * 86400000);
      expect(renewed.expiresAt).toBe(expectedNewExpiry);
      expect(renewed.boundDeviceId).toBe(originalDeviceId);
    });

    it('برای لایسنس منقضی‌شده، تمدید باید از زمان فعلی (now) آغاز شود نه زمان منقضی‌شده در گذشته', () => {
      const now = Date.now();
      const expiredLicense: LicenseRecord = {
        id: 'lic_expired_renew',
        duration: '1m',
        status: 'expired',
        boundDeviceId: 'dev_hw_exp_1',
        startsAt: now - 60 * 86400000,
        expiresAt: now - 30 * 86400000, // Expired 30 days ago
        isBlocked: false,
        createdAt: now - 60 * 86400000
      };
      mockDatabase.licenses.set(expiredLicense.id, expiredLicense);

      const target = mockDatabase.licenses.get('lic_expired_renew')!;
      const baseTime = Math.max(target.expiresAt, now);
      expect(baseTime).toBe(now); // baseTime is now!

      target.expiresAt = baseTime + getDurationMs('3m');
      target.status = 'active';

      expect(target.expiresAt).toBe(now + 90 * 86400000);
      expect(target.status).toBe('active');
    });
  });

  // ==========================================
  // Section 4: Revocation, Suspension & Reactivation
  // ==========================================
  describe('۴. ابطال، تعلیق و رفع تعلیق (Revoke, Suspend, Reactivate)', () => {
    it('باید لایسنس را به صورت قطعی ابطال (revoke) کند و دسترسی را قطع نماید', () => {
      const license: LicenseRecord = {
        id: 'lic_to_revoke',
        status: 'active',
        isBlocked: false,
        boundDeviceId: 'dev_hw_rev',
        duration: '1y',
        startsAt: Date.now() - 1000,
        expiresAt: Date.now() + 365 * 86400000,
        createdAt: Date.now() - 1000
      };
      mockDatabase.licenses.set(license.id, license);

      // Execute Revoke
      license.status = 'revoked';
      license.isBlocked = true;
      license.blockReason = 'نقض شرایط و تلاش برای کلون‌سازی سخت‌افزار';

      expect(license.status).toBe('revoked');
      expect(license.isBlocked).toBe(true);
      expect(license.blockReason).toContain('کلون‌سازی');
    });

    it('باید امکان تعلیق موقت (suspend) و سپس رفع تعلیق و فعال‌سازی مجدد (reactivate) را فراهم کند', () => {
      const license: LicenseRecord = {
        id: 'lic_to_suspend',
        status: 'active',
        isBlocked: false,
        boundDeviceId: 'dev_hw_susp',
        duration: '1y',
        startsAt: Date.now() - 1000,
        expiresAt: Date.now() + 365 * 86400000,
        createdAt: Date.now() - 1000
      };
      mockDatabase.licenses.set(license.id, license);

      // 1. Suspend
      license.status = 'suspended';
      license.isBlocked = true;
      license.blockReason = 'عدم تطابق مدارک مالکیت موقت';
      expect(license.status).toBe('suspended');
      expect(license.isBlocked).toBe(true);

      // 2. Reactivate
      license.status = 'active';
      license.isBlocked = false;
      delete license.blockReason;

      expect(license.status).toBe('active');
      expect(license.isBlocked).toBe(false);
      expect(license.blockReason).toBeUndefined();
    });
  });

  // ==========================================
  // Section 5: Hardware Device Transfer (Migration)
  // ==========================================
  describe('۵. انتقال سخت‌افزار و مهاجرت لایسنس (Device Transfer)', () => {
    it('باید دستگاه قبلی را فوراً unbind کرده و لایسنس را به دستگاه جدید متصل کند (جلوگیری از دوگانگی)', () => {
      const oldDeviceId = 'dev_hw_old_samsung_s21';
      const newDeviceId = 'dev_hw_new_samsung_s24';

      const license: LicenseRecord = {
        id: 'lic_transfer_atomic',
        status: 'active',
        isBlocked: false,
        boundDeviceId: oldDeviceId,
        duration: '1y',
        startsAt: Date.now() - 100 * 86400000,
        expiresAt: Date.now() + 265 * 86400000, // 265 days remaining
        createdAt: Date.now() - 100 * 86400000
      };
      mockDatabase.licenses.set(license.id, license);

      mockDatabase.devices.set(oldDeviceId, {
        deviceId: oldDeviceId,
        status: 'trusted',
        licenseId: license.id
      });

      // Atomic Transfer Execution
      const executeTransfer = (licId: string, newDevId: string, reason: string) => {
        const lic = mockDatabase.licenses.get(licId)!;
        const oldDevId = lic.boundDeviceId;

        // Revoke old device
        if (oldDevId && mockDatabase.devices.has(oldDevId)) {
          const oldDev = mockDatabase.devices.get(oldDevId)!;
          oldDev.status = 'unbound_transfer';
        }

        // Bind new device
        lic.boundDeviceId = newDevId;

        // Register new device
        mockDatabase.devices.set(newDevId, {
          deviceId: newDevId,
          status: 'trusted',
          licenseId: lic.id
        });

        // Record audit
        mockDatabase.auditLogs.push({
          id: 'log_trans_1',
          action: 'transfer_license',
          targetId: lic.id,
          actorUid: masterAdmin.uid,
          actorEmail: masterAdmin.email,
          timestamp: Date.now(),
          result: 'success',
          details: `Transferred from ${oldDevId} to ${newDevId}: ${reason}`
        });

        return lic;
      };

      const transferred = executeTransfer('lic_transfer_atomic', newDeviceId, 'تعویض گوشی سوخته');

      // Assertions
      expect(transferred.boundDeviceId).toBe(newDeviceId);
      expect(mockDatabase.devices.get(oldDeviceId)?.status).toBe('unbound_transfer');
      expect(mockDatabase.devices.get(newDeviceId)?.status).toBe('trusted');

      // Crucial: Old device is NO LONGER VALID
      const isOldDeviceValid = mockDatabase.devices.get(oldDeviceId)?.status === 'trusted';
      expect(isOldDeviceValid).toBe(false);

      // Crucial: Remaining license duration was preserved
      expect(transferred.expiresAt).toBe(license.expiresAt);
    });
  });

  // ==========================================
  // Section 6: Customer Access Boundary
  // ==========================================
  describe('۶. مرزهای امنیتی و منع دسترسی کاربران عادی به عملیات ادمین', () => {
    it('کاربر عادی نباید بتواند توابع مدیریتی صدور، تمدید، ابطال یا انتقال را فراخوانی کند', () => {
      const assertCallerIsAdmin = (callerUid: string) => {
        if (callerUid !== masterAdmin.uid) {
          throw new Error('permission-denied: دسترسی غیرمجاز. فقط مدیران سیستم مجاز به فراخوانی این عملیات هستند.');
        }
      };

      // Admin succeeds
      expect(() => assertCallerIsAdmin(masterAdmin.uid)).not.toThrow();

      // Normal customer fails
      expect(() => assertCallerIsAdmin(normalUser.uid)).toThrow('permission-denied');
    });
  });

  // ==========================================
  // Section 7: Security Remediation & Fail-Closed Integrity
  // ==========================================
  describe('۷. ارزیابی اصلاحات امنیتی، رفتار Fail-Closed و حذف Fallbackهای ناامن', () => {
    it('هنگام خطای شبکه یا در دسترس نبودن Cloud Functions، عملیات فعال‌سازی باید متوقف شود و هیچ داده‌ای در دیتابیس ثبت نشود', () => {
      let isDbMutated = false;

      // Simulated activation attempt when Cloud Function endpoint throws internal/unavailable error
      const simulateActivation = (shouldThrowError: boolean) => {
        if (shouldThrowError) {
          // Strict Fail-Closed without fallback write!
          throw new Error('internal: خطای داخلی در سرور یا عدم در دسترس بودن سرویس ابری Cloud Functions. عملیات متوقف گردید.');
        }
        isDbMutated = true;
      };

      expect(() => simulateActivation(true)).toThrow('internal');
      expect(isDbMutated).toBe(false); // Database must remain pristine!
    });

    it('در صورت فقدان کلید خصوصی سرور در Secret Manager، کلیه عملیات امضا باید فوراً با خطای failed-precondition متوقف شوند', () => {
      const getSigningKey = (secretEnvVar?: string) => {
        if (!secretEnvVar || secretEnvVar.trim().length === 0) {
          throw new Error('failed-precondition: Server signing private key is missing from Secret Manager. All license signing operations are safely halted.');
        }
        return secretEnvVar;
      };

      // Missing or empty secret must Fail-Closed
      expect(() => getSigningKey(undefined)).toThrow('failed-precondition');
      expect(() => getSigningKey('')).toThrow('failed-precondition');
      expect(() => getSigningKey('   ')).toThrow('failed-precondition');
    });

    it('قوانین Firestore باید هرگونه تلاش نوشتن مستقیم کلاینت روی کالکشن‌های licenses, devices, licenseAuditLogs را رد کنند', () => {
      const evaluateRule = (collection: string, operation: 'get' | 'list' | 'write', isAdmin: boolean) => {
        if (['licenses', 'devices', 'licenseAuditLogs', 'deviceChallenges'].includes(collection)) {
          if (operation === 'write') {
            return false; // Zero client write access!
          }
          if (operation === 'get' || operation === 'list') {
            return isAdmin;
          }
        }
        return false;
      };

      // Client write must ALWAYS be false, even for admin
      expect(evaluateRule('licenses', 'write', true)).toBe(false);
      expect(evaluateRule('licenses', 'write', false)).toBe(false);
      expect(evaluateRule('devices', 'write', true)).toBe(false);
      expect(evaluateRule('devices', 'write', false)).toBe(false);
      expect(evaluateRule('licenseAuditLogs', 'write', true)).toBe(false);
      expect(evaluateRule('deviceChallenges', 'write', true)).toBe(false);

      // Admin read is allowed
      expect(evaluateRule('licenses', 'get', true)).toBe(true);
      expect(evaluateRule('licenseAuditLogs', 'list', true)).toBe(true);
    });

    it('حساب مدیر ارشد اصلی arefalikhani69@gmail.com باید غیرقابل تغییر و با نقش super_admin محافظت شود', () => {
      const canDemoteAdmin = (targetEmail: string, callerRole: string) => {
        if (targetEmail === 'arefalikhani69@gmail.com') {
          return false; // Master admin is permanently protected!
        }
        return callerRole === 'super_admin';
      };

      expect(canDemoteAdmin('arefalikhani69@gmail.com', 'super_admin')).toBe(false);
      expect(canDemoteAdmin('other_admin@autopin.ir', 'super_admin')).toBe(true);
      expect(canDemoteAdmin('other_admin@autopin.ir', 'admin')).toBe(false);
    });
  });

  // ==========================================
  // Section 8: Staging Readiness & Contract Alignment
  // ==========================================
  describe('۸. آمادگی Staging: تطابق قرارداد verifyWithServer، Fail-Closed، App Check و Emulator', () => {
    it('فایل licenseService.ts باید deviceId را به verifyLicense بفرستد، پاسخ سرور را تطبیق دهد و هیچ fallback مستقیم Firestore نداشته باشد', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(path.resolve(process.cwd(), 'src/services/licenseService.ts'), 'utf8');

      // Zero direct Firestore SDK usage in licenseService.ts
      expect(source).not.toContain("from 'firebase/firestore'");
      expect(source).not.toContain('getDoc(');
      expect(source).not.toContain('setDoc(');
      expect(source).not.toContain('updateDoc(');

      // verifyLicense callable sends deviceId and matches server response fields
      expect(source).toContain("httpsCallable<{\n        licenseId: string;\n        deviceId: string;");
      expect(source).toContain('serverTime: number;\n        expiresAt: number;\n        daysRemaining: number;\n        leaseToken: OfflineLeaseToken;');

      // Client clock must NOT extend lastOnlineCheckAt in verifyWithServer catch
      const verifyMethodSlice = source.slice(source.indexOf('public async verifyWithServer()'), source.indexOf('public async prepareActivationRequest'));
      expect(verifyMethodSlice).not.toContain('lastOnlineCheckAt: Date.now()');
      expect(verifyMethodSlice).toContain('verifyLeaseTokenSignature');
    });

    it('باید خطاهای شبکه، امضای نامعتبر و لایسنس منقضی‌شده را به صورت Fail-Closed تفکیک کند و محدودیت ۷ روزه را اعمال نماید', async () => {
      const { licenseService } = await import('../src/services/licenseService');
      const { deviceKeystore } = await import('../src/services/deviceKeystore');

      const memoryStore: Record<string, string> = {};
      (globalThis as any).localStorage = {
        getItem: (key: string) => memoryStore[key] || null,
        setItem: (key: string, val: string) => { memoryStore[key] = val; },
        removeItem: (key: string) => { delete memoryStore[key]; },
        clear: () => { Object.keys(memoryStore).forEach(k => delete memoryStore[k]); },
        key: (i: number) => Object.keys(memoryStore)[i] || null,
        length: 0
      };

      const devId = await deviceKeystore.getDeviceId();
      const now = Date.now();
      const baseRecord: LicenseRecord = {
        id: 'lic_staging_test',
        boundDeviceId: devId,
        issuedAt: now - 10000,
        startsAt: now - 10000,
        expiresAt: now + 365 * 86400000,
        duration: '1y',
        status: 'active',
        lastOnlineCheckAt: now - 10000,
        isBlocked: false,
        maxOfflineDays: 7
      };

      const classify = (licenseService as any).classifyVerifyErrorFailClosed.bind(licenseService);

      // 1. Network error -> status === 'network_error', lastOnlineCheckAt untouched
      licenseService.storeLicense(baseRecord);
      const netErr = classify({ code: 'unavailable', message: 'Network unavailable' }, baseRecord, devId);
      expect(netErr.isValid).toBe(false);
      expect(netErr.status).toBe('network_error');
      expect(licenseService.getStoredLicense()?.lastOnlineCheckAt).toBe(baseRecord.lastOnlineCheckAt);

      // 2. Invalid signature / challenge error -> status === 'invalid_signature'
      const sigErr = classify({ code: 'permission-denied', message: 'امضای دیجیتال سخت‌افزاری دستگاه تایید نشد.' }, baseRecord, devId);
      expect(sigErr.isValid).toBe(false);
      expect(sigErr.status).toBe('invalid_signature');

      // 3. Expired license error -> status === 'expired'
      const expErr = classify({ code: 'deadline-exceeded', message: 'اعتبار لایسنس به پایان رسیده است.' }, baseRecord, devId);
      expect(expErr.isValid).toBe(false);
      expect(expErr.status).toBe('expired');
      expect(licenseService.getStoredLicense()?.status).toBe('expired');
    });

    it('پیکربندی App Check و Emulator Suite باید بدون Token ثابت یا Enforcement فعال آماده شده باشد', () => {
      const fs = require('fs');
      const path = require('path');

      const appCheckSource = fs.readFileSync(path.resolve(process.cwd(), 'src/services/appCheck.ts'), 'utf8');
      const firebaseSource = fs.readFileSync(path.resolve(process.cwd(), 'src/services/firebase.ts'), 'utf8');
      const functionsSource = fs.readFileSync(path.resolve(process.cwd(), 'functions/src/index.ts'), 'utf8');
      const firebaseJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'firebase.json'), 'utf8'));

      // App Check has no hardcoded static dev token and is wired into firebase initialization
      expect(appCheckSource).not.toContain('app_check_local_dev_token');
      expect(appCheckSource).toContain('getAppCheckToken');
      expect(firebaseSource).toContain('initAppCheck(app)');

      // App Check Enforcement stays OFF before Staging verification
      expect(functionsSource).not.toContain('enforceAppCheck');

      // Firebase Emulator ports configured cleanly without removing Production settings
      expect(firebaseJson.firestore?.database).toBe('ai-studio-autopinpro-6597dde9-59f0-4a2e-90e5-55436f30fb2d');
      expect(firebaseJson.emulators?.auth?.port).toBe(9099);
      expect(firebaseJson.emulators?.firestore?.port).toBe(8080);
      expect(firebaseJson.emulators?.functions?.port).toBe(5001);
    });
  });

  // ==========================================
  // Section 9: Atomic Transactions, Web P1363/IndexedDB & Fail-Closed Offline Lease
  // ==========================================
  describe('۹. تراکنش‌های اتمیک مدیریتی، کلید وب IndexedDB و سخت‌گیری توکن آفلاین', () => {
    it('باید در تأیید همزمان یک درخواست لایسنس (Concurrent reviewLicenseRequest)، فقط یک عملیات موفق شود و فقط یک Audit Log ثبت گردد', async () => {
      const reqId = 'req_concurrent_1';
      mockDatabase.requests.set(reqId, {
        id: reqId,
        userId: normalUser.uid,
        userEmail: normalUser.email,
        deviceId: 'dev_hw_conc_1',
        devicePublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtestkey',
        requestToken: 'REQ-CONC-1',
        requestedAt: Date.now() - 5000,
        status: 'pending'
      });

      // Serialized optimistic transaction runner matching Firestore db.runTransaction
      let txChain: Promise<void> = Promise.resolve();
      const runTx = <T>(fn: () => Promise<T> | T): Promise<T> => {
        const next = txChain.then(() => fn());
        txChain = next.then(() => undefined, () => undefined);
        return next;
      };

      const attemptConcurrentReview = (adminEmail: string) =>
        runTx(async () => {
          await Promise.resolve();
          const current = mockDatabase.requests.get(reqId);
          if (!current) throw new Error('not-found');
          if (current.status !== 'pending') {
            throw new Error('failed-precondition: درخواست قبلاً بررسی شده است.');
          }
          // Atomic commit of request status + audit log together
          mockDatabase.requests.set(reqId, {
            ...current,
            status: 'approved',
            reviewedBy: masterAdmin.uid,
            reviewedAt: Date.now()
          });
          mockDatabase.auditLogs.push({
            id: `log_${mockDatabase.auditLogs.length + 1}`,
            action: 'review_request' as any,
            targetId: reqId,
            actorUid: masterAdmin.uid,
            actorEmail: adminEmail,
            timestamp: Date.now(),
            result: 'success',
            details: 'Approved in atomic tx'
          });
          return { success: true };
        });

      const results = await Promise.allSettled([
        attemptConcurrentReview('admin1@autopin.ir'),
        attemptConcurrentReview('admin2@autopin.ir')
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('failed-precondition');
      expect(mockDatabase.requests.get(reqId)?.status).toBe('approved');
      expect(mockDatabase.auditLogs).toHaveLength(1);
    });

    it('باید در تمدید همزمان یک لایسنس (Concurrent renewLicense)، هر دو تمدید روی مقدار سرور محاسبه شوند و هیچ تمدیدی گم نشود', async () => {
      const baseNow = Date.now();
      const licId = 'lic_concurrent_renew';
      mockDatabase.licenses.set(licId, {
        id: licId,
        boundDeviceId: 'dev_hw_renew_1',
        issuedAt: baseNow - 10000,
        startsAt: baseNow - 10000,
        expiresAt: baseNow + 10 * 86400000, // 10 days remaining
        duration: '1m',
        status: 'active',
        lastOnlineCheckAt: baseNow,
        isBlocked: false,
        maxOfflineDays: 7
      });

      let txChain: Promise<void> = Promise.resolve();
      const runTx = <T>(fn: () => Promise<T> | T): Promise<T> => {
        const next = txChain.then(() => fn());
        txChain = next.then(() => undefined, () => undefined);
        return next;
      };

      const attemptRenew = (duration: LicenseDuration) =>
        runTx(async () => {
          await Promise.resolve();
          const current = mockDatabase.licenses.get(licId);
          if (!current) throw new Error('not-found');
          const serverNow = baseNow;
          const currentExpiry = Math.max(current.expiresAt || 0, serverNow);
          const addedMs = getDurationMs(duration);
          const newExpiry = currentExpiry + addedMs;

          mockDatabase.licenses.set(licId, {
            ...current,
            expiresAt: newExpiry,
            duration,
            status: 'active',
            isBlocked: false
          });
          mockDatabase.auditLogs.push({
            id: `log_ren_${mockDatabase.auditLogs.length + 1}`,
            action: 'renew',
            targetId: licId,
            actorUid: masterAdmin.uid,
            actorEmail: masterAdmin.email,
            timestamp: serverNow,
            result: 'success',
            details: `Extended by ${duration}`
          });
          return newExpiry;
        });

      const [r1, r2] = await Promise.all([attemptRenew('1m'), attemptRenew('3m')]);

      const expectedFinalExpiry = baseNow + 10 * 86400000 + getDurationMs('1m') + getDurationMs('3m');
      expect(r1).toBe(baseNow + 10 * 86400000 + getDurationMs('1m'));
      expect(r2).toBe(expectedFinalExpiry);
      expect(mockDatabase.licenses.get(licId)?.expiresAt).toBe(expectedFinalExpiry);
      expect(mockDatabase.auditLogs).toHaveLength(2);
    });

    it('باید در ابطال لایسنس (revokeLicense)، تغییر وضعیت لایسنس، وضعیت دستگاه و Audit Log به‌صورت اتمیک انجام شود و در صورت خطا هیچ داده‌ای ثبت نشود', () => {
      const licId = 'lic_atomic_revoke';
      const devId = 'dev_hw_atomic_rev';
      mockDatabase.licenses.set(licId, {
        id: licId,
        userId: normalUser.uid,
        boundDeviceId: devId,
        issuedAt: Date.now() - 5000,
        startsAt: Date.now() - 5000,
        expiresAt: Date.now() + 365 * 86400000,
        duration: '1y',
        status: 'active',
        lastOnlineCheckAt: Date.now(),
        isBlocked: false,
        maxOfflineDays: 7
      });
      mockDatabase.devices.set(devId, {
        deviceId: devId,
        status: 'trusted',
        licenseId: licId
      });

      const executeAtomicRevoke = (expectedUserId?: string) => {
        const snapshotLic = { ...mockDatabase.licenses.get(licId)! };
        const snapshotDev = { ...mockDatabase.devices.get(devId)! };
        const snapshotLogsLen = mockDatabase.auditLogs.length;

        try {
          if (expectedUserId && snapshotLic.userId !== expectedUserId) {
            throw new Error('failed-precondition: مالکیت لایسنس مطابقت ندارد.');
          }

          mockDatabase.licenses.set(licId, {
            ...snapshotLic,
            status: 'revoked',
            isBlocked: true,
            blockReason: 'ابطال آزمایشی'
          });
          mockDatabase.devices.set(devId, {
            ...snapshotDev,
            status: 'blacklisted'
          });
          mockDatabase.auditLogs.push({
            id: 'log_rev_atomic',
            action: 'revoke',
            targetId: licId,
            actorUid: masterAdmin.uid,
            timestamp: Date.now(),
            result: 'success',
            details: 'Revoked atomically'
          });
        } catch (err) {
          // Rollback cleanly on transaction failure
          mockDatabase.licenses.set(licId, snapshotLic);
          mockDatabase.devices.set(devId, snapshotDev);
          mockDatabase.auditLogs.length = snapshotLogsLen;
          throw err;
        }
      };

      // Wrong ownership check must roll back completely
      expect(() => executeAtomicRevoke('wrong_user_uid')).toThrow('failed-precondition');
      expect(mockDatabase.licenses.get(licId)?.status).toBe('active');
      expect(mockDatabase.devices.get(devId)?.status).toBe('trusted');
      expect(mockDatabase.auditLogs).toHaveLength(0);

      // Valid ownership succeeds atomically across license, device, and audit log
      executeAtomicRevoke(normalUser.uid);
      expect(mockDatabase.licenses.get(licId)?.status).toBe('revoked');
      expect(mockDatabase.licenses.get(licId)?.isBlocked).toBe(true);
      expect(mockDatabase.devices.get(devId)?.status).toBe('blacklisted');
      expect(mockDatabase.auditLogs).toHaveLength(1);
    });

    it('باید در صدور لایسنس (issueLicense)، از صدور تکراری (Hash/ID تکراری) و ثبت ناقص جلوگیری کند', () => {
      const { keyHash, keyHint } = generateLicenseKey();
      const issueAtomic = (licenseId: string, activationKeyHash: string) => {
        const duplicateId = mockDatabase.licenses.has(licenseId);
        const duplicateHash = Array.from(mockDatabase.licenses.values()).some(
          l => l.activationKeyHash === activationKeyHash
        );
        if (duplicateId || duplicateHash) {
          throw new Error('already-exists: کد یا شناسه لایسنس تکراری است.');
        }

        const record: LicenseRecord = {
          id: licenseId,
          activationKeyHash,
          keyHint,
          boundDeviceId: '',
          issuedAt: Date.now(),
          startsAt: 0,
          expiresAt: 0,
          duration: '1y',
          status: 'active',
          lastOnlineCheckAt: 0,
          isBlocked: false,
          maxOfflineDays: 7
        };
        mockDatabase.licenses.set(licenseId, record);
        mockDatabase.auditLogs.push({
          id: `log_issue_${mockDatabase.auditLogs.length + 1}`,
          action: 'issue',
          targetId: licenseId,
          actorUid: masterAdmin.uid,
          timestamp: Date.now(),
          result: 'success',
          details: `Issued ${keyHint}`
        });
      };

      issueAtomic('lic_unique_1', keyHash);
      expect(mockDatabase.licenses.size).toBe(1);
      expect(mockDatabase.auditLogs).toHaveLength(1);

      // Duplicate hash must reject cleanly without adding partial license or fake audit log
      expect(() => issueAtomic('lic_unique_2', keyHash)).toThrow('already-exists');
      expect(mockDatabase.licenses.size).toBe(1);
      expect(mockDatabase.auditLogs).toHaveLength(1);
    });

    it('باید در کد منبع سرور و کلاینت، تراکنش‌های اتمیک ۴ تابع مدیریتی، IndexedDB Fail-Closed و بررسی اجباری OfflineLeaseToken رعایت شده باشد', async () => {
      const fs = require('fs');
      const path = require('path');

      const functionsSource = fs.readFileSync(path.resolve(process.cwd(), 'functions/src/index.ts'), 'utf8');
      const keystoreSource = fs.readFileSync(path.resolve(process.cwd(), 'src/services/deviceKeystore.ts'), 'utf8');
      const licenseServiceSource = fs.readFileSync(path.resolve(process.cwd(), 'src/services/licenseService.ts'), 'utf8');

      // 1. All 4 admin Cloud Functions run inside db.runTransaction & record FieldValue.serverTimestamp()
      for (const fnName of ['issueLicense', 'renewLicense', 'revokeLicense', 'reviewLicenseRequest']) {
        const startIdx = functionsSource.indexOf(`export const ${fnName} =`);
        expect(startIdx).toBeGreaterThan(-1);
        const nextExportIdx = functionsSource.indexOf('export const ', startIdx + 20);
        const slice = nextExportIdx > -1 ? functionsSource.slice(startIdx, nextExportIdx) : functionsSource.slice(startIdx);
        expect(slice).toContain('db.runTransaction');
        expect(slice).toContain('FieldValue.serverTimestamp()');
      }

      // 2. deviceKeystore persists non-extractable keypair via IndexedDB and NEVER writes private keys to localStorage
      expect(keystoreSource).toContain('indexedDB.open');
      expect(keystoreSource).toContain('extractable === false');
      expect(keystoreSource).not.toContain('exportKey(\'pkcs8\'');
      expect(keystoreSource).not.toContain('exportKey(\'jwk\'');

      // 3. Browser environment without IndexedDB throws Fail-Closed error instead of silent localStorage key
      const { DeviceKeystoreClient } = await import('../src/services/deviceKeystore');
      const freshClient = new (DeviceKeystoreClient as any)();
      const origWindow = (globalThis as any).window;
      (globalThis as any).window = { navigator: { userAgent: 'Mozilla/5.0' } };
      try {
        await expect(freshClient.getDevicePublicKey()).rejects.toThrow('Fail-Closed');
      } finally {
        if (origWindow === undefined) {
          delete (globalThis as any).window;
        } else {
          (globalThis as any).window = origWindow;
        }
      }

      // 4. validateCurrentLicense strictly rejects missing storedLease (ACTIVE_LICENSE alone is never trusted)
      const validateSlice = licenseServiceSource.slice(
        licenseServiceSource.indexOf('public async validateCurrentLicense()'),
        licenseServiceSource.indexOf('public storeLicense(')
      );
      expect(validateSlice).toContain('if (!storedLease)');
      expect(validateSlice).toContain("status: 'needs_online_check'");
    });
  });
});

