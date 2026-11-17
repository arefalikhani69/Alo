/**
 * AutoPin Pro - Firebase App Check Infrastructure
 *
 * Configures:
 * 1. Android Native: Supports Play Integrity token bridging via AndroidSecurityBridge.getAppCheckToken
 *    without blocking sideloaded/unenforced APK builds when native Play Integrity is not yet attached.
 * 2. Web Production: Uses ReCaptchaV3Provider only when a valid public reCAPTCHA site key is configured.
 * 3. Web Development / Emulator: Cleanly separates Debug/Emulator testing from Production, supports
 *    env-provided VITE_FIREBASE_APPCHECK_DEBUG_TOKEN without any hardcoded tokens/secrets in code.
 * 4. Security Boundary: App Check Enforcement remains OFF in Cloud Functions until Staging verification finishes.
 */

import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  CustomProvider,
  AppCheck
} from 'firebase/app-check';
import { FirebaseApp, getApps, getApp } from 'firebase/app';
import firebaseConfig from '../../firebase-applet-config.json';

export type AppCheckMode =
  | 'android_play_integrity_bridge'
  | 'android_play_integrity_pending'
  | 'web_recaptcha_v3_prod'
  | 'web_recaptcha_v3_debug'
  | 'web_emulator_custom'
  | 'unconfigured_unenforced'
  | 'ssr_or_test_skipped';

let appCheckInstance: AppCheck | null = null;
let appCheckMode: AppCheckMode = 'unconfigured_unenforced';

export function getAppCheckStatus(): { initialized: boolean; mode: AppCheckMode } {
  return {
    initialized: Boolean(appCheckInstance),
    mode: appCheckMode
  };
}

export function initAppCheck(appInstance?: FirebaseApp): AppCheck | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    appCheckMode = 'ssr_or_test_skipped';
    return null;
  }
  if (appCheckInstance) return appCheckInstance;

  try {
    const app = appInstance || (!getApps().length ? undefined : getApp());
    if (!app) return null;

    const isNativeAndroid = Boolean(window.AndroidSecurityBridge);
    const isDev = Boolean(typeof import.meta !== 'undefined' && import.meta.env?.DEV);
    const siteKey = String(
      (typeof import.meta !== 'undefined' && import.meta.env?.VITE_RECAPTCHA_SITE_KEY) ||
        firebaseConfig.recaptchaSiteKey ||
        ''
    ).trim();

    // 1. Native Android Environment (Play Integrity)
    if (isNativeAndroid) {
      if (typeof window.AndroidSecurityBridge?.getAppCheckToken === 'function') {
        const androidBridge = window.AndroidSecurityBridge;
        appCheckInstance = initializeAppCheck(app, {
          provider: new CustomProvider({
            getToken: async () => {
              const token = await Promise.resolve(androidBridge.getAppCheckToken!());
              if (!token) {
                throw new Error('Empty Play Integrity App Check token');
              }
              return {
                token,
                expireTimeMillis: Date.now() + 50 * 60 * 1000
              };
            }
          }),
          isTokenAutoRefreshEnabled: true
        });
        appCheckMode = 'android_play_integrity_bridge';
        return appCheckInstance;
      }

      // Native Play Integrity SDK not yet bridged; defer cleanly while enforcement is OFF
      appCheckMode = 'android_play_integrity_pending';
      return null;
    }

    // 2. Development / Debug Mode (strictly gated by import.meta.env.DEV)
    if (isDev) {
      const envDebugToken =
        typeof import.meta !== 'undefined'
          ? String(import.meta.env?.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN || '').trim()
          : '';

      if (envDebugToken) {
        (globalThis as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
          envDebugToken === 'true' ? true : envDebugToken;
      }

      if (siteKey.length > 0) {
        appCheckInstance = initializeAppCheck(app, {
          provider: new ReCaptchaV3Provider(siteKey),
          isTokenAutoRefreshEnabled: true
        });
        appCheckMode = 'web_recaptcha_v3_debug';
        return appCheckInstance;
      }

      // Only issue synthetic test token when explicitly pointing at local Firebase Emulator Suite
      const isEmulatorMode =
        typeof import.meta !== 'undefined' &&
        import.meta.env?.VITE_USE_FIREBASE_EMULATORS === 'true';

      if (isEmulatorMode) {
        appCheckInstance = initializeAppCheck(app, {
          provider: new CustomProvider({
            getToken: async () => ({
              token: `emulator-${crypto.randomUUID()}`,
              expireTimeMillis: Date.now() + 60 * 60 * 1000
            })
          }),
          isTokenAutoRefreshEnabled: false
        });
        appCheckMode = 'web_emulator_custom';
        return appCheckInstance;
      }

      appCheckMode = 'unconfigured_unenforced';
      return null;
    }

    // 3. Web Production Mode (strictly NO debug tokens; ReCaptcha V3 only when siteKey is configured)
    if (siteKey.length > 0) {
      appCheckInstance = initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(siteKey),
        isTokenAutoRefreshEnabled: true
      });
      appCheckMode = 'web_recaptcha_v3_prod';
      return appCheckInstance;
    }

    appCheckMode = 'unconfigured_unenforced';
    return null;
  } catch (err) {
    // Non-fatal while enforcement is disabled so master admin and customer flows stay intact
    console.warn('Firebase App Check initialization was skipped or deferred:', err);
    return null;
  }
}
