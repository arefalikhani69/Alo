/**
 * AutoPin Pro - Client Device Cryptographic Identity Provider
 *
 * Interfaces with:
 * 1. Native Android Keystore via AndroidSecurityBridge (in Android APK)
 * 2. Web Crypto API (SubtleCrypto ECDSA P-256 non-extractable key) in browser/preview
 *
 * Provides tamper-proof deviceId and challenge signing.
 */

import type { AndroidSecurityBridgeInterface } from './androidSecurity';

const WEB_KEYSTORE_DB_NAME = 'autopin_pro_web_keystore_v1';
const WEB_KEYSTORE_STORE_NAME = 'device_keys';
const WEB_KEYPAIR_RECORD_KEY = 'ecdsa_p256_identity_v1';
const WEB_DEVICE_ID_KEY = 'autopin_pro_device_hw_id_v1';

export class DeviceKeystoreClient {
  private static instance: DeviceKeystoreClient;
  private cachedDeviceId: string | null = null;
  private cachedPublicKey: string | null = null;
  private webCryptoPair: CryptoKeyPair | null = null;
  private webPairInitPromise: Promise<CryptoKeyPair> | null = null;

  private constructor() {}

  public static getInstance(): DeviceKeystoreClient {
    if (!DeviceKeystoreClient.instance) {
      DeviceKeystoreClient.instance = new DeviceKeystoreClient();
    }
    return DeviceKeystoreClient.instance;
  }

  /**
   * Checks if the app is executing inside the native Android container (WebView / APK).
   */
  public isNativeAndroidEnvironment(): boolean {
    if (typeof window === 'undefined') return false;
    const isBridgePresent = Boolean(window.AndroidSecurityBridge);
    const isCustomApkUA = typeof navigator !== 'undefined' && /ir\.autopin\.pro/i.test(navigator.userAgent);
    return isBridgePresent || isCustomApkUA;
  }

  /**
   * Checks if native Android Keystore bridge is present.
   */
  public isNativeKeystoreAvailable(): boolean {
    return Boolean(
      typeof window !== 'undefined' &&
      window.AndroidSecurityBridge &&
      typeof window.AndroidSecurityBridge.getHardwareDeviceId === 'function'
    );
  }

  /**
   * Retrieves deterministic hardware device ID (SHA-256 fingerprint).
   * In Android Native mode, strictly enforces hardware Keystore with zero software fallback.
   */
  public async getDeviceId(): Promise<string> {
    if (this.cachedDeviceId) {
      return this.cachedDeviceId;
    }

    if (this.isNativeAndroidEnvironment()) {
      if (this.isNativeKeystoreAvailable()) {
        const nativeId = window.AndroidSecurityBridge!.getHardwareDeviceId!();
        if (nativeId && nativeId.startsWith('dev_hw_')) {
          this.cachedDeviceId = nativeId;
          return nativeId;
        }
        throw new Error('ماژول سخت‌افزاری Android Keystore در دسترس نیست یا اعتبارسنجی آن ناموفق بود.');
      }
      throw new Error('خطای امنیتی: برنامه در محیط اندروید نیتیو اجرا شده است اما ماژول سخت‌افزاری Android Keystore در دسترس نیست. استفاده از شبیه‌ساز نرم‌افزاری در اندروید مجاز نمی‌باشد.');
    }

    // Web Crypto (non-extractable IndexedDB CryptoKey) for browser preview ONLY
    this.cachedDeviceId = await this.getOrCreateWebDeviceId();
    return this.cachedDeviceId;
  }

  /**
   * Retrieves Base64 encoded public key.
   * In Android Native mode, strictly enforces hardware Keystore with zero software fallback.
   */
  public async getDevicePublicKey(): Promise<string> {
    if (this.cachedPublicKey) {
      return this.cachedPublicKey;
    }

    if (this.isNativeAndroidEnvironment()) {
      if (this.isNativeKeystoreAvailable()) {
        const nativeKey = window.AndroidSecurityBridge!.getDevicePublicKeyBase64!();
        if (nativeKey) {
          this.cachedPublicKey = nativeKey;
          return nativeKey;
        }
        throw new Error('کلید عمومی سخت‌افزاری دستگاه در Android Keystore در دسترس نیست.');
      }
      throw new Error('خطای امنیتی: کلید سخت‌افزاری دستگاه در محیط اندروید در دسترس نیست.');
    }

    // Web Crypto (non-extractable IndexedDB CryptoKey) for browser preview ONLY
    const pair = await this.getOrCreateWebCryptoPair();
    const exported = await crypto.subtle.exportKey('spki', pair.publicKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    this.cachedPublicKey = b64;
    return b64;
  }

  /**
   * Signs a server-provided challenge to prove physical device custody.
   * In Android Native mode, strictly enforces hardware Keystore with zero software fallback.
   */
  public async signChallenge(challenge: string): Promise<string> {
    if (this.isNativeAndroidEnvironment()) {
      if (this.isNativeKeystoreAvailable()) {
        const sig = window.AndroidSecurityBridge!.signDeviceChallenge!(challenge);
        if (sig) return sig;
        throw new Error('امضای دیجیتال چالش با کلید سخت‌افزاری ناموفق بود.');
      }
      throw new Error('خطای امنیتی: امضای چالش امنیتی در اندروید باید منحصراً با سخت‌افزار Keystore انجام شود.');
    }

    // Web Crypto ECDSA signature (IEEE P1363 format, 64 bytes) for browser preview ONLY
    const pair = await this.getOrCreateWebCryptoPair();
    const enc = new TextEncoder();
    const data = enc.encode(challenge);
    const signature = await crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' }
      },
      pair.privateKey,
      data
    );

    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  /**
   * Returns human-readable device model string.
   */
  public getDeviceModelInfo(): string {
    if (this.isNativeKeystoreAvailable()) {
      return window.AndroidSecurityBridge!.getDeviceModelInfo!() || 'Android Device';
    }
    return typeof navigator !== 'undefined' ? navigator.userAgent : 'Web Client';
  }

  // --- Web Crypto Non-Extractable IndexedDB Helpers ---
  private async getOrCreateWebDeviceId(): Promise<string> {
    const pair = await this.getOrCreateWebCryptoPair();
    const exported = await crypto.subtle.exportKey('spki', pair.publicKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', exported);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
    const derivedId = `dev_web_${hex}`;

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(WEB_DEVICE_ID_KEY, derivedId);
    }

    return derivedId;
  }

  private isValidNonExtractablePair(candidate: unknown): candidate is CryptoKeyPair {
    const pair = candidate as Partial<CryptoKeyPair> | null;
    return Boolean(
      pair &&
      pair.publicKey &&
      pair.privateKey &&
      pair.publicKey.type === 'public' &&
      pair.privateKey.type === 'private' &&
      pair.privateKey.extractable === false &&
      pair.privateKey.algorithm?.name === 'ECDSA' &&
      pair.publicKey.algorithm?.name === 'ECDSA'
    );
  }

  private openWebKeystoreDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB در این مرورگر در دسترس نیست.'));
        return;
      }

      const req = indexedDB.open(WEB_KEYSTORE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(WEB_KEYSTORE_STORE_NAME)) {
          db.createObjectStore(WEB_KEYSTORE_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('خطا در باز کردن پایگاه‌داده امن IndexedDB.'));
      req.onblocked = () => reject(new Error('دسترسی به پایگاه‌داده امن IndexedDB مسدود شده است.'));
    });
  }

  private async readPairFromIndexedDb(db: IDBDatabase): Promise<CryptoKeyPair | null> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WEB_KEYSTORE_STORE_NAME, 'readonly');
      const store = tx.objectStore(WEB_KEYSTORE_STORE_NAME);
      const req = store.get(WEB_KEYPAIR_RECORD_KEY);
      req.onsuccess = () => {
        const result = req.result;
        resolve(this.isValidNonExtractablePair(result) ? result : null);
      };
      req.onerror = () => reject(req.error || new Error('خطا در خواندن کلید دستگاه از IndexedDB.'));
    });
  }

  private async writePairToIndexedDb(db: IDBDatabase, pair: CryptoKeyPair): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WEB_KEYSTORE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(WEB_KEYSTORE_STORE_NAME);
      store.put(pair, WEB_KEYPAIR_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('خطا در ذخیره‌سازی کلید غیرقابل‌استخراج در IndexedDB.'));
      tx.onabort = () => reject(tx.error || new Error('تراکنش ذخیره‌سازی کلید در IndexedDB لغو شد.'));
    });
  }

  private async getOrCreateWebCryptoPair(): Promise<CryptoKeyPair> {
    if (this.webCryptoPair) return this.webCryptoPair;
    if (this.webPairInitPromise) return this.webPairInitPromise;

    this.webPairInitPromise = (async () => {
      const isBrowserContext = typeof window !== 'undefined';

      // Node.js unit test runner (non-browser, no IndexedDB) -> in-memory non-extractable keypair ONLY
      if (!isBrowserContext && typeof indexedDB === 'undefined') {
        const pair = await crypto.subtle.generateKey(
          {
            name: 'ECDSA',
            namedCurve: 'P-256'
          },
          false,
          ['sign', 'verify']
        );
        this.webCryptoPair = pair;
        return pair;
      }

      // Browser environment: strictly require IndexedDB persistence for non-extractable CryptoKeyPair (Fail-Closed)
      let db: IDBDatabase | null = null;
      try {
        db = await this.openWebKeystoreDb();
        const existingPair = await this.readPairFromIndexedDb(db);
        if (existingPair) {
          this.webCryptoPair = existingPair;
          return existingPair;
        }

        const newPair = await crypto.subtle.generateKey(
          {
            name: 'ECDSA',
            namedCurve: 'P-256'
          },
          false, // non-extractable private key (never exported, never stored in localStorage)
          ['sign', 'verify']
        );

        await this.writePairToIndexedDb(db, newPair);
        this.webCryptoPair = newPair;
        return newPair;
      } catch (err: any) {
        throw new Error(
          `خطای امنیتی کلید وب (Fail-Closed): امکان نگهداری امن کلید غیرقابل‌استخراج در IndexedDB وجود ندارد (${err?.message || 'IndexedDB unavailable'}).`
        );
      } finally {
        db?.close();
        this.webPairInitPromise = null;
      }
    })();

    return this.webPairInitPromise;
  }
}

export const deviceKeystore = DeviceKeystoreClient.getInstance();
