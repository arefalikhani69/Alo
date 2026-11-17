/**
 * AutoPin Pro - Client License Validation & Offline Lease Engine
 *
 * Enforces:
 * 1. 1-Year license duration validation.
 * 2. Hardware Keystore device binding (anti-cloning).
 * 3. Max 7-day offline usage with signed cryptographic lease token.
 * 4. Anti-Clock Tampering (prevents bypassing license by rewinding device clock).
 * 5. Monotonic timestamp verification.
 */

import {
  LicenseRecord,
  LicenseRequestRecord,
  OfflineLeaseToken,
  ClientLicenseValidationResult,
  LicenseDuration
} from '../types/license';
import { deviceKeystore } from './deviceKeystore';
import { verifyLeaseTokenSignature } from './licenseVerificationKey';
import { functionsInstance } from './firebase';
import { httpsCallable } from 'firebase/functions';

const STORAGE_KEYS = {
  ACTIVE_LICENSE: 'autopin_license_active_record_v1',
  OFFLINE_LEASE: 'autopin_license_offline_lease_v1',
  LAST_KNOWN_SERVER_TIME: 'autopin_license_last_server_time_v1',
  LAST_RECORDED_DEVICE_TIME: 'autopin_license_last_device_time_v1',
  REQUEST_TOKEN: 'autopin_license_pending_request_v1'
};

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 Days

export class LicenseService {
  private static instance: LicenseService;

  private constructor() {}

  public static getInstance(): LicenseService {
    if (!LicenseService.instance) {
      LicenseService.instance = new LicenseService();
    }
    return LicenseService.instance;
  }

  /**
   * Evaluates the current license status on the device.
   * Fail-Closed: ACTIVE_LICENSE alone NEVER proves validity; a cryptographically
   * signed OfflineLeaseToken within the max 7-day window is strictly mandatory.
   */
  public async validateCurrentLicense(): Promise<ClientLicenseValidationResult> {
    const currentDeviceId = await deviceKeystore.getDeviceId();
    const storedLicense = this.getStoredLicense();
    const storedLease = this.getStoredOfflineLease();

    if (!storedLicense) {
      return {
        isValid: false,
        status: 'no_license',
        messageFa: 'لایسنس فعالی برای این دستگاه یافت نشد. لطفاً کد فعال‌سازی را وارد نمایید.',
        currentDeviceId
      };
    }

    // 1. Device Binding Integrity Check (Anti-Cloning)
    if (storedLicense.boundDeviceId !== currentDeviceId) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'unbound_device',
        messageFa: 'این لایسنس به دستگاه دیگری متصل شده است و بر روی این سخت‌افزار معتبر نیست.',
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 2. Block / Revocation Check
    if (storedLicense.isBlocked || storedLicense.status === 'revoked' || storedLicense.status === 'suspended') {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'revoked',
        messageFa: storedLicense.blockReason || 'این لایسنس توسط پشتیبانی یا سیستم امنیتی مسدود شده است.',
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 3. Mandatory OfflineLeaseToken Check (Fail-Closed if OFFLINE_LEASE is missing)
    if (!storedLease) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'needs_online_check',
        messageFa: 'توکن مجوز آفلاین یافت نشد. لطفاً جهت بررسی آنلاین با سرور به اینترنت متصل شوید.',
        offlineDaysRemaining: 0,
        expiresAt: storedLicense.expiresAt,
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 4. OfflineLeaseToken Binding & Structural Integrity Check
    if (storedLease.deviceId !== currentDeviceId || storedLease.licenseId !== storedLicense.id) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'unbound_device',
        messageFa: 'توکن مجوز آفلاین به دستگاه یا لایسنس دیگری تعلق دارد.',
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    if (
      typeof storedLease.issuedAtServer !== 'number' ||
      typeof storedLease.validUntilServer !== 'number' ||
      typeof storedLease.licenseExpiresAt !== 'number' ||
      !Number.isFinite(storedLease.issuedAtServer) ||
      !Number.isFinite(storedLease.validUntilServer) ||
      !Number.isFinite(storedLease.licenseExpiresAt) ||
      storedLease.issuedAtServer <= 0 ||
      storedLease.validUntilServer <= storedLease.issuedAtServer ||
      storedLease.licenseExpiresAt <= 0 ||
      typeof storedLease.signature !== 'string' ||
      !storedLease.signature.trim()
    ) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'invalid_signature',
        messageFa: 'ساختار یا زمان‌بندی توکن مجوز آفلاین نامعتبر است. نیازمند بررسی آنلاین با سرور است.',
        offlineDaysRemaining: 0,
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 5. Cryptographic ECDSA P-256 Offline Lease Signature Verification (Anti-Tampering)
    const isSignatureValid = await verifyLeaseTokenSignature(
      storedLease.licenseId,
      storedLease.deviceId,
      storedLease.issuedAtServer,
      storedLease.validUntilServer,
      storedLease.licenseExpiresAt,
      storedLease.signature
    );

    if (!isSignatureValid) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'invalid_signature',
        messageFa: 'امضای دیجیتال مجوز آفلاین دستکاری شده یا نامعتبر است. دسترسی موقت لغو شد.',
        offlineDaysRemaining: 0,
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 6. Monotonic Clock Tampering Detection
    const now = Date.now();
    const lastKnownServerTime = this.getLastKnownServerTime();
    const lastRecordedDeviceTime = this.getLastRecordedDeviceTime();

    // A) Clock rewound to before signed server token issuance time
    if (now < storedLease.issuedAtServer - (5 * 60 * 1000)) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'clock_tampered',
        isClockTampered: true,
        messageFa: 'تاریخ یا ساعت گوشی عقب کشیده شده است. لطفاً تاریخ دستگاه را به حالت خودکار تنظیم کنید.',
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // B) Monotonic server time regression
    if (lastKnownServerTime > 0 && now < lastKnownServerTime - (5 * 60 * 1000)) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'clock_tampered',
        isClockTampered: true,
        messageFa: 'تاریخ یا ساعت گوشی تغییر یافته است. لطفاً تاریخ دستگاه را به حالت خودکار شبکه تنظیم کنید.',
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // C) Monotonic local device time regression
    if (lastRecordedDeviceTime > 0 && now < lastRecordedDeviceTime - (5 * 60 * 1000)) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'clock_tampered',
        isClockTampered: true,
        messageFa: 'دستکاری در ساعت آفلاین گوشی شناسایی شد. لطفاً به اینترنت متصل شوید.',
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 7. Authoritative Signed License Expiration & Max 7-Day Offline Lease Window
    const authoritativeExpiresAt =
      storedLicense.expiresAt > 0
        ? Math.min(storedLease.licenseExpiresAt, storedLicense.expiresAt)
        : storedLease.licenseExpiresAt;

    if (now >= authoritativeExpiresAt) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'expired',
        expiresAt: authoritativeExpiresAt,
        daysRemaining: 0,
        offlineDaysRemaining: 0,
        messageFa: 'اعتبار لایسنس شما به پایان رسیده است. جهت تمدید با پشتیبانی تماس بگیرید.',
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    const cappedValidUntil = Math.min(
      storedLease.validUntilServer,
      storedLease.issuedAtServer + MAX_OFFLINE_GRACE_MS
    );

    if (now > cappedValidUntil) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'needs_online_check',
        messageFa: 'مهلت ۷ روزه اعتبار آفلاین به پایان رسیده است. لطفاً جهت بررسی آنلاین، به اینترنت متصل شوید.',
        offlineDaysRemaining: 0,
        expiresAt: authoritativeExpiresAt,
        daysRemaining: Math.max(0, Math.ceil((authoritativeExpiresAt - now) / (24 * 60 * 60 * 1000))),
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // Update monotonic time checkpoints (never overwrite server clock with client Date.now())
    this.recordServerTime(storedLease.issuedAtServer);
    this.recordDeviceTime(now);

    const timeSinceIssued = Math.max(0, now - storedLease.issuedAtServer);
    const offlineRemainingMs = Math.max(0, cappedValidUntil - now);
    const offlineDaysRemaining = Math.max(0, Math.ceil(offlineRemainingMs / (24 * 60 * 60 * 1000)));
    const daysRemaining = Math.ceil((authoritativeExpiresAt - now) / (24 * 60 * 60 * 1000));

    return {
      isValid: true,
      licenseId: storedLicense.id,
      status: timeSinceIssued < (24 * 60 * 60 * 1000) ? 'valid_online' : 'valid_offline_grace',
      messageFa: `لایسنس معتبر است (${daysRemaining} روز اعتبار باقی‌مانده).`,
      expiresAt: authoritativeExpiresAt,
      daysRemaining,
      offlineDaysRemaining,
      boundDeviceId: storedLicense.boundDeviceId,
      currentDeviceId
    };
  }

  /**
   * Saves or updates authoritative license record locally.
   */
  public storeLicense(license: LicenseRecord, lease?: OfflineLeaseToken): void {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_LICENSE, JSON.stringify(license));
    if (lease) {
      localStorage.setItem(STORAGE_KEYS.OFFLINE_LEASE, JSON.stringify(lease));
    }
    if (license.lastOnlineCheckAt) {
      this.recordServerTime(license.lastOnlineCheckAt);
    }
  }

  public getStoredLicense(): LicenseRecord | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_LICENSE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  public getStoredOfflineLease(): OfflineLeaseToken | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.OFFLINE_LEASE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  public clearLicense(): void {
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_LICENSE);
    localStorage.removeItem(STORAGE_KEYS.OFFLINE_LEASE);
  }

  private getLastKnownServerTime(): number {
    const raw = localStorage.getItem(STORAGE_KEYS.LAST_KNOWN_SERVER_TIME);
    return raw ? parseInt(raw, 10) : 0;
  }

  public recordServerTime(serverTimeMs: number): void {
    const current = this.getLastKnownServerTime();
    if (serverTimeMs > current) {
      localStorage.setItem(STORAGE_KEYS.LAST_KNOWN_SERVER_TIME, serverTimeMs.toString());
    }
  }

  private getLastRecordedDeviceTime(): number {
    const raw = localStorage.getItem(STORAGE_KEYS.LAST_RECORDED_DEVICE_TIME);
    return raw ? parseInt(raw, 10) : 0;
  }

  public recordDeviceTime(deviceTimeMs: number): void {
    const current = this.getLastRecordedDeviceTime();
    if (deviceTimeMs > current) {
      localStorage.setItem(STORAGE_KEYS.LAST_RECORDED_DEVICE_TIME, deviceTimeMs.toString());
    }
  }

  /**
   * Translates Firebase Functions errors into user-friendly Persian error messages.
   */
  public mapFirebaseErrorToFa(err: any): string {
    const code = (err?.code || '').toLowerCase();
    const message = (err?.message || '').toLowerCase();
    const rawMessage = err?.message || '';

    if (code.includes('resource-exhausted') || message.includes('resource-exhausted') || message.includes('تلاش')) {
      return 'تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً ۱۵ دقیقه دیگر مجدداً تلاش کنید.';
    }
    if (code.includes('not-found') || message.includes('not-found') || rawMessage.includes('معتبر نمی‌باشد')) {
      return 'کد لایسنس نامعتبر است یا در سیستم یافت نشد.';
    }
    if (code.includes('already-exists') || message.includes('already-exists') || rawMessage.includes('دستگاه دیگری')) {
      return 'این کد لایسنس قبلاً برای دستگاه دیگری استفاده شده است و امکان استفاده هم‌زمان ندارد.';
    }
    if (code.includes('permission-denied') || message.includes('permission-denied')) {
      if (rawMessage.includes('امضای دیجیتال')) {
        return 'امضای دیجیتال یا احراز هویت سخت‌افزاری دستگاه مورد تایید سرور قرار نگرفت.';
      }
      return 'دسترسی غیرمجاز است یا درخواست شما هنوز توسط مدیر تأیید نشده است.';
    }
    if (code.includes('failed-precondition') || message.includes('failed-precondition')) {
      return 'این لایسنس مسدود یا منقضی شده است.';
    }
    if (code.includes('deadline-exceeded') || message.includes('deadline-exceeded')) {
      return 'تاریخ انقضای لایسنس به پایان رسیده است.';
    }
    if (code.includes('internal') || message.includes('internal')) {
      return 'خطای داخلی در سرور یا عدم در دسترس بودن سرویس ابری Cloud Functions. عملیات متوقف گردید.';
    }
    if (code.includes('unavailable') || code.includes('network') || message.includes('network') || message.includes('fetch')) {
      return 'خطای شبکه و عدم ارتباط با سرور. لطفاً اتصال اینترنت خود را بررسی کنید.';
    }
    if (code.includes('unauthenticated')) {
      return 'لطفاً ابتدا وارد حساب کاربری خود شوید.';
    }

    // If message is in Persian without long English words, return it
    if (rawMessage && !/[a-zA-Z]{4,}/.test(rawMessage)) {
      return rawMessage;
    }

    return 'خطایی در ارتباط با سرور رخ داده است. لطفاً مجدداً تلاش کنید.';
  }

  /**
   * End-to-End Online Activation via Firebase Cloud Functions.
   * Zero-Trust Hardware Challenge-Response Handshake:
   * 1. Requests fresh 32-byte nonce from server
   * 2. Signs nonce via Android Keystore hardware private key
   * 3. Sends rawKey + signature + devicePublicKey to activateLicense
   * 4. Receives 7-day signed offline lease and stores it locally.
   */
  public async activateWithServer(rawActivationKey: string): Promise<ClientLicenseValidationResult> {
    try {
      const deviceId = await deviceKeystore.getDeviceId();
      const devicePublicKey = await deviceKeystore.getDevicePublicKey();
      const deviceModel = deviceKeystore.getDeviceModelInfo();
      const isWebClient = !deviceKeystore.isNativeAndroidEnvironment();

      // Step 1: Request single-use challenge from server
      const requestChallengeFn = httpsCallable<{
        deviceId: string;
        devicePublicKey: string;
        isWebClient: boolean;
      }, { challenge: string; ttlSeconds: number }>(functionsInstance, 'requestDeviceChallenge');

      const challengeRes = await requestChallengeFn({
        deviceId,
        devicePublicKey,
        isWebClient
      });

      const { challenge } = challengeRes.data;

      // Step 2: Sign challenge using hardware Keystore
      const signature = await deviceKeystore.signChallenge(challenge);

      // Step 3: Call activateLicense
      const activateLicenseFn = httpsCallable<{
        activationKey: string;
        devicePublicKey: string;
        challenge: string;
        signature: string;
        deviceModel: string;
        isWebClient: boolean;
      }, {
        success: boolean;
        license: LicenseRecord;
        leaseToken: OfflineLeaseToken;
      }>(functionsInstance, 'activateLicense');

      const activationRes = await activateLicenseFn({
        activationKey: rawActivationKey,
        devicePublicKey,
        challenge,
        signature,
        deviceModel,
        isWebClient
      });

      const { license, leaseToken } = activationRes.data;

      if (
        !license ||
        !leaseToken ||
        leaseToken.licenseId !== license.id ||
        leaseToken.deviceId !== deviceId ||
        !leaseToken.signature
      ) {
        return {
          isValid: false,
          status: 'invalid_signature',
          messageFa: 'پاسخ یا توکن فعال‌سازی دریافتی از سرور نامعتبر است.',
          currentDeviceId: deviceId
        };
      }

      const isLeaseSignatureValid = await verifyLeaseTokenSignature(
        leaseToken.licenseId,
        leaseToken.deviceId,
        leaseToken.issuedAtServer,
        leaseToken.validUntilServer,
        leaseToken.licenseExpiresAt,
        leaseToken.signature
      );

      if (!isLeaseSignatureValid) {
        return {
          isValid: false,
          licenseId: license.id,
          status: 'invalid_signature',
          messageFa: 'امضای دیجیتال توکن مجوز آفلاین سرور معتبر نیست.',
          currentDeviceId: deviceId
        };
      }

      const cappedLeaseToken: OfflineLeaseToken = {
        ...leaseToken,
        validUntilServer: Math.min(
          leaseToken.validUntilServer,
          leaseToken.issuedAtServer + MAX_OFFLINE_GRACE_MS
        )
      };

      // Step 4: Persist authoritative records locally
      this.storeLicense(license, cappedLeaseToken);
      this.recordServerTime(cappedLeaseToken.issuedAtServer);

      return await this.validateCurrentLicense();
    } catch (err: any) {
      console.error('Cloud Function activation failed (Fail-Closed):', err);
      const errorMsg = this.mapFirebaseErrorToFa(err);
      const code = String(err?.code || '').toLowerCase();
      const message = String(err?.message || '').toLowerCase();
      const isTransportError =
        code.includes('unavailable') ||
        code.includes('network') ||
        code.includes('internal') ||
        code.includes('deadline-exceeded') ||
        message.includes('network') ||
        message.includes('fetch');
      return {
        isValid: false,
        status: isTransportError ? 'network_error' : 'invalid_signature',
        messageFa: errorMsg,
        currentDeviceId: await deviceKeystore.getDeviceId().catch(() => 'unknown')
      };
    }
  }

  /**
   * Translates duration string to milliseconds.
   */
  public getDurationMs(duration: LicenseDuration): number {
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

  /**
   * Online Handshake & Offline Lease Renewal via Firebase Cloud Functions.
   * Keeps the 7-day offline rolling window fresh whenever connected to the internet.
   * Strictly Fail-Closed: zero direct Firestore fallback and zero client-clock renewal.
   */
  public async verifyWithServer(): Promise<ClientLicenseValidationResult> {
    const storedLicense = this.getStoredLicense();
    if (!storedLicense) {
      return {
        isValid: false,
        status: 'no_license',
        messageFa: 'هیچ لایسنسی برای استعلام آنلاین یافت نشد.',
        currentDeviceId: await deviceKeystore.getDeviceId().catch(() => 'unknown')
      };
    }

    let deviceId = 'unknown';
    try {
      deviceId = await deviceKeystore.getDeviceId();
      const devicePublicKey = await deviceKeystore.getDevicePublicKey();
      const isWebClient = !deviceKeystore.isNativeAndroidEnvironment();

      // Step 1: Request single-use challenge
      const requestChallengeFn = httpsCallable<{
        deviceId: string;
        devicePublicKey: string;
        isWebClient: boolean;
      }, { challenge: string; ttlSeconds: number }>(functionsInstance, 'requestDeviceChallenge');

      const challengeRes = await requestChallengeFn({
        deviceId,
        devicePublicKey,
        isWebClient
      });

      const { challenge } = challengeRes.data;
      if (!challenge) {
        return {
          isValid: false,
          licenseId: storedLicense.id,
          status: 'invalid_signature',
          messageFa: 'پاسخ چالش امنیتی سرور معتبر نیست.',
          boundDeviceId: storedLicense.boundDeviceId,
          currentDeviceId: deviceId
        };
      }

      // Step 2: Hardware Keystore signature
      const signature = await deviceKeystore.signChallenge(challenge);

      // Step 3: Call verifyLicense (exact server contract including deviceId)
      const verifyLicenseFn = httpsCallable<{
        licenseId: string;
        deviceId: string;
        devicePublicKey: string;
        challenge: string;
        signature: string;
        isWebClient: boolean;
      }, {
        isValid: boolean;
        serverTime: number;
        expiresAt: number;
        daysRemaining: number;
        leaseToken: OfflineLeaseToken;
      }>(functionsInstance, 'verifyLicense');

      const verifyRes = await verifyLicenseFn({
        licenseId: storedLicense.id,
        deviceId,
        devicePublicKey,
        challenge,
        signature,
        isWebClient
      });

      const data = verifyRes.data;
      const leaseToken = data?.leaseToken;

      if (
        !data?.isValid ||
        typeof data.serverTime !== 'number' ||
        typeof data.expiresAt !== 'number' ||
        !leaseToken ||
        leaseToken.licenseId !== storedLicense.id ||
        leaseToken.deviceId !== deviceId ||
        !leaseToken.signature
      ) {
        return {
          isValid: false,
          licenseId: storedLicense.id,
          status: 'invalid_signature',
          messageFa: 'پاسخ یا توکن اعتبارسنجی سرور نامعتبر است.',
          boundDeviceId: storedLicense.boundDeviceId,
          currentDeviceId: deviceId
        };
      }

      // Step 4: Verify server ECDSA signature & enforce 7-day max offline cap locally
      const isLeaseSignatureValid = await verifyLeaseTokenSignature(
        leaseToken.licenseId,
        leaseToken.deviceId,
        leaseToken.issuedAtServer,
        leaseToken.validUntilServer,
        leaseToken.licenseExpiresAt,
        leaseToken.signature
      );

      if (!isLeaseSignatureValid) {
        return {
          isValid: false,
          licenseId: storedLicense.id,
          status: 'invalid_signature',
          messageFa: 'امضای دیجیتال توکن مجوز آفلاین سرور معتبر نیست.',
          boundDeviceId: storedLicense.boundDeviceId,
          currentDeviceId: deviceId
        };
      }

      const cappedLeaseToken: OfflineLeaseToken = {
        ...leaseToken,
        validUntilServer: Math.min(
          leaseToken.validUntilServer,
          leaseToken.issuedAtServer + MAX_OFFLINE_GRACE_MS
        )
      };

      const updatedLicense: LicenseRecord = {
        ...storedLicense,
        boundDeviceId: deviceId,
        expiresAt: data.expiresAt,
        lastOnlineCheckAt: data.serverTime,
        status: 'active',
        isBlocked: false
      };
      delete updatedLicense.blockReason;

      this.storeLicense(updatedLicense, cappedLeaseToken);
      this.recordServerTime(data.serverTime);

      return await this.validateCurrentLicense();
    } catch (err: any) {
      return this.classifyVerifyErrorFailClosed(err, storedLicense, deviceId);
    }
  }

  /**
   * Classifies server verification errors strictly Fail-Closed without any Firestore fallback
   * or client-clock lease extension.
   */
  private classifyVerifyErrorFailClosed(
    err: any,
    storedLicense: LicenseRecord,
    currentDeviceId: string
  ): ClientLicenseValidationResult {
    const code = String(err?.code || '').toLowerCase();
    const message = String(err?.message || '').toLowerCase();
    const rawMessage = String(err?.message || '');
    const mappedMessage = this.mapFirebaseErrorToFa(err);

    // 1. Expired license reported by server
    if (
      code.includes('deadline-exceeded') ||
      message.includes('deadline-exceeded') ||
      rawMessage.includes('به پایان رسیده')
    ) {
      const expiredRecord: LicenseRecord = {
        ...storedLicense,
        status: 'expired'
      };
      this.storeLicense(expiredRecord);
      localStorage.removeItem(STORAGE_KEYS.OFFLINE_LEASE);
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'expired',
        messageFa: mappedMessage,
        expiresAt: storedLicense.expiresAt,
        daysRemaining: 0,
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 2. Revoked / Blocked license reported by server
    if (
      code.includes('failed-precondition') ||
      message.includes('failed-precondition') ||
      rawMessage.includes('مسدود شده')
    ) {
      const revokedRecord: LicenseRecord = {
        ...storedLicense,
        status: 'revoked',
        isBlocked: true,
        blockReason: rawMessage || mappedMessage
      };
      this.storeLicense(revokedRecord);
      localStorage.removeItem(STORAGE_KEYS.OFFLINE_LEASE);
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'revoked',
        messageFa: mappedMessage,
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 3. Hardware binding / ownership mismatch
    if (
      rawMessage.includes('دستگاه دیگری') ||
      rawMessage.includes('شناسه دستگاه') ||
      rawMessage.includes('مالک این لایسنس')
    ) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'unbound_device',
        messageFa: mappedMessage,
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 4. Invalid signature / challenge / invalid hardware proof
    if (
      code.includes('permission-denied') ||
      code.includes('invalid-argument') ||
      code.includes('not-found') ||
      rawMessage.includes('امضای دیجیتال') ||
      rawMessage.includes('چالش امنیتی')
    ) {
      return {
        isValid: false,
        licenseId: storedLicense.id,
        status: 'invalid_signature',
        messageFa: mappedMessage,
        boundDeviceId: storedLicense.boundDeviceId,
        currentDeviceId
      };
    }

    // 5. Network / Server / Auth transport failure (NEVER extends local lease)
    return {
      isValid: false,
      licenseId: storedLicense.id,
      status: 'network_error',
      messageFa: mappedMessage,
      expiresAt: storedLicense.expiresAt,
      boundDeviceId: storedLicense.boundDeviceId,
      currentDeviceId
    };
  }

  /**
   * Generates formatted activation request payload with hardware Keystore binding.
   */
  public async prepareActivationRequest(userEmail?: string, notes?: string): Promise<Omit<LicenseRequestRecord, 'id'>> {
    const deviceId = await deviceKeystore.getDeviceId();
    const devicePublicKey = await deviceKeystore.getDevicePublicKey();
    const deviceModel = deviceKeystore.getDeviceModelInfo();

    const requestToken = `REQ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    return {
      requestToken,
      deviceId,
      devicePublicKey,
      requestedAt: Date.now(),
      status: 'pending',
      userEmail,
      deviceModel,
      notes
    };
  }
}

export const licenseService = LicenseService.getInstance();
