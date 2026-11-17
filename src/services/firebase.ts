import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  User,
  onAuthStateChanged
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  getDocFromServer
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject
} from 'firebase/storage';
import { getFunctions, httpsCallable, Functions } from 'firebase/functions';
import firebaseConfig from '../../firebase-applet-config.json';
import { initAppCheck } from './appCheck';

// Initialize Firebase App singleton
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// Initialize App Check safely (non-blocking while enforcement is disabled in staging)
initAppCheck(app);

export const FUNCTIONS_REGION = 'us-central1';

/* CRITICAL: The app will break without specifying firestoreDatabaseId */
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const functionsInstance: Functions = getFunctions(app, FUNCTIONS_REGION);
export const storageBucket = getStorage(app);
try {
  storageBucket.maxUploadRetryTime = 3000;
  storageBucket.maxOperationRetryTime = 3000;
} catch {
  // Ignore if property is readonly
}

// Configurable Master Admin email (configured via VITE_ADMIN_EMAIL or Phase 1 master admin email)
export const BOOTSTRAP_ADMIN_EMAIL: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADMIN_EMAIL) || 'arefalikhani69@gmail.com';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export type AdminVerificationStatus =
  | 'verified'
  | 'not_found'
  | 'inactive'
  | 'invalid_role'
  | 'email_unverified'
  | 'permission_denied'
  | 'network_error'
  | 'unauthenticated';

export interface AdminVerificationResult {
  isAdmin: boolean;
  role: 'super_admin' | 'admin' | 'support' | null;
  status: AdminVerificationStatus;
  errorMessage?: string;
}

export function isBootstrapMasterEmail(email?: string | null): boolean {
  if (!email || typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'arefalikhani69@gmail.com' ||
    Boolean(BOOTSTRAP_ADMIN_EMAIL && normalized === BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase())
  );
}

/**
 * Email string alone MUST NOT grant admin privileges.
 * A caller is only eligible as a one-time bootstrap candidate when their Firebase Auth
 * email is strictly verified (`emailVerified === true`) AND matches the configured master email.
 */
export function isEmailVerifiedBootstrapCandidate(user: User | null): boolean {
  if (!user) return false;
  return user.emailVerified === true && isBootstrapMasterEmail(user.email);
}

export type VerifyAdminSessionErrorCategory =
  | 'network_offline'
  | 'unauthenticated'
  | 'email_unverified'
  | 'inactive_admin'
  | 'invalid_role'
  | 'bootstrap_locked'
  | 'permission_denied'
  | 'function_not_deployed'
  | 'firestore_error'
  | 'unknown';

export interface VerifyAdminSessionResponse {
  verified: boolean;
  hasFirestoreAdminDoc: boolean;
  adminDocExists?: boolean;
  createdViaBootstrap?: boolean;
  uid: string;
  email: string;
  role: 'super_admin' | 'admin' | 'support';
  databaseId?: string;
  region?: string;
}

export type VerifyAdminSessionCallOutcome =
  | {
      ok: true;
      data: VerifyAdminSessionResponse;
    }
  | {
      ok: false;
      category: VerifyAdminSessionErrorCategory;
      code: string;
      message: string;
    };

export function classifyVerifyAdminSessionError(
  err: unknown,
  isNavigatorOnline: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true
): { category: VerifyAdminSessionErrorCategory; code: string; message: string } {
  const code = String((err as { code?: unknown })?.code || '').toLowerCase();
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message?: unknown }).message || '')
      : String(err || '');
  const msg = rawMessage.normalize('NFC');
  const msgLower = msg.toLowerCase();

  if (
    !isNavigatorOnline ||
    code.includes('unavailable') ||
    code.includes('deadline-exceeded') ||
    msgLower.includes('offline') ||
    msgLower.includes('err_internet_disconnected') ||
    msgLower.includes('econnrefused')
  ) {
    return {
      category: 'network_offline',
      code: code || 'unavailable',
      message: 'ارتباط با سرورهای Firebase برقرار نیست یا اتصال اینترنت قطع شده است.'
    };
  }

  if (code.includes('unauthenticated') || msgLower.includes('unauthenticated')) {
    return {
      category: 'unauthenticated',
      code: code || 'unauthenticated',
      message: 'نشست احراز هویت معتبر برای ارتباط با Cloud Functions یافت نشد. لطفاً مجدداً وارد شوید.'
    };
  }

  if (code.includes('permission-denied') || msgLower.includes('permission-denied')) {
    if (msg.includes('تأیید ایمیل') || msg.includes('تایید ایمیل') || msgLower.includes('verified')) {
      return {
        category: 'email_unverified',
        code: code || 'permission-denied',
        message: 'ایمیل حساب کاربری تأیید نشده است؛ ایمیل تأییدنشده مجاز به Bootstrap در سرور نیست.'
      };
    }
    if (msg.includes('غیرفعال') || msg.includes('لغو')) {
      return {
        category: 'inactive_admin',
        code: code || 'permission-denied',
        message: 'دسترسی مدیریتی این حساب در پایگاه داده ابری غیرفعال یا لغو شده است.'
      };
    }
    if (
      msg.includes('Bootstrap') ||
      msg.includes('راه‌اندازی شده') ||
      msg.includes('مدیر فعال') ||
      msgLower.includes('bootstrap')
    ) {
      return {
        category: 'bootstrap_locked',
        code: code || 'permission-denied',
        message: msg || 'قفل Bootstrap در سرور قبلاً فعال شده است و امکان ارتقای خودکار وجود ندارد.'
      };
    }
    return {
      category: 'permission_denied',
      code: code || 'permission-denied',
      message: msg || 'درخواست تأیید یا ثبت سند مدیر توسط قوانین امنیتی سرور رد شد.'
    };
  }

  if (code.includes('failed-precondition') || msgLower.includes('failed-precondition')) {
    return {
      category: 'bootstrap_locked',
      code: code || 'failed-precondition',
      message: msg || 'پیش‌شرط امنیتی سرور برای ثبت سند مدیر برقرار نیست.'
    };
  }

  if (
    code.includes('not-found') ||
    code.includes('internal') ||
    msgLower.includes('failed to fetch') ||
    msgLower.includes('cors') ||
    msgLower.includes('networkerror') ||
    msgLower.includes('404')
  ) {
    return {
      category: 'function_not_deployed',
      code: code || 'not-found',
      message: `سرویس ابری verifyAdminSession در منطقه ${FUNCTIONS_REGION} در دسترس نیست یا هنوز روی پروژه Firebase مستقر (Deploy) نشده است.`
    };
  }

  return {
    category: 'unknown',
    code: code || 'unknown',
    message: msg || 'خطای نامشخص در ارتباط با سرویس سرور برای بررسی سند مدیر.'
  };
}

export async function callVerifyAdminSession(): Promise<VerifyAdminSessionCallOutcome> {
  try {
    const verifyFn = httpsCallable<Record<string, never>, VerifyAdminSessionResponse>(
      functionsInstance,
      'verifyAdminSession'
    );
    const res = await verifyFn({});
    if (!res?.data?.verified || !res?.data?.role) {
      return {
        ok: false,
        category: 'unknown',
        code: 'invalid-response',
        message: 'پاسخ نامعتبر از سرویس سرور verifyAdminSession دریافت شد.'
      };
    }
    return {
      ok: true,
      data: res.data
    };
  } catch (err) {
    const classified = classifyVerifyAdminSessionError(err);
    return {
      ok: false,
      category: classified.category,
      code: classified.code,
      message: classified.message
    };
  }
}

// Check if user has admin privileges directly from authoritative server document
export async function verifyUserAdminRole(user: User | null): Promise<AdminVerificationResult> {
  if (!user) {
    return {
      isAdmin: false,
      role: null,
      status: 'unauthenticated',
      errorMessage: 'کاربر به حساب کاربری Firebase وارد نشده است.'
    };
  }

  try {
    // Read directly from server to bypass stale local cache and guarantee real-time verification
    const adminSnap = await getDocFromServer(doc(db, 'admins', user.uid));
    if (!adminSnap.exists()) {
      return {
        isAdmin: false,
        role: null,
        status: 'not_found',
        errorMessage: 'سند مدیریت برای این حساب کاربری در پایگاه داده ثبت نشده است.'
      };
    }

    const data = adminSnap.data();
    if (data?.active !== true) {
      return {
        isAdmin: false,
        role: null,
        status: 'inactive',
        errorMessage: 'دسترسی مدیریتی این حساب کاربری غیرفعال یا به حالت تعلیق درآمده است.'
      };
    }

    const docRole = data?.role;
    if (docRole !== 'super_admin' && docRole !== 'admin' && docRole !== 'support') {
      return {
        isAdmin: false,
        role: null,
        status: 'invalid_role',
        errorMessage: `نقش تعریف‌شده در سند (${docRole}) برای پنل مدیریت معتبر نیست.`
      };
    }

    return {
      isAdmin: true,
      role: docRole,
      status: 'verified'
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorCode = (err as { code?: string })?.code || '';

    // Check for permission denied
    if (
      errorCode === 'permission-denied' ||
      errorMsg.includes('permission-denied') ||
      errorMsg.includes('insufficient permissions')
    ) {
      return {
        isAdmin: false,
        role: null,
        status: 'permission_denied',
        errorMessage: 'خطای امنیتی پایگاه داده: دسترسی به اسناد مدیریتی توسط قوانین سرور مسدود شد.'
      };
    }

    // Check for offline / network errors (strictly Fail-Closed; never trust stale offline cache for admin auth)
    if (
      errorCode === 'unavailable' ||
      errorMsg.includes('offline') ||
      errorMsg.includes('unavailable') ||
      errorMsg.includes('Failed to get document because the client is offline')
    ) {
      return {
        isAdmin: false,
        role: null,
        status: 'network_error',
        errorMessage: 'عدم برقراری ارتباط با سرور پایگاه داده ابری. لطفاً وضعیت اتصال اینترنت را بررسی کنید.'
      };
    }

    return {
      isAdmin: false,
      role: null,
      status: 'permission_denied',
      errorMessage: `خطا در استعلام سند مدیر: ${errorMsg}`
    };
  }
}

// Test connection on boot
export async function validateFirestoreConnection(): Promise<{ isConnected: boolean; message: string }> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { isConnected: true, message: 'اتصال پایگاه داده آنلاین برقرار است' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('offline') ||
      msg.includes('token-service-api') ||
      msg.includes('Fetching auth token failed') ||
      msg.includes('Could not reach Cloud Firestore backend') ||
      msg.includes('unavailable') ||
      msg.includes('deadline-exceeded')
    ) {
      if (msg.includes('token-service-api') || msg.includes('Fetching auth token failed')) {
        try {
          await signOut(auth);
        } catch {
          // ignore
        }
      }
      return { isConnected: false, message: 'کلاینت در حالت آفلاین است' };
    }
    // Only if it's permission-denied without token errors, network handshake succeeded
    if (msg.includes('permission-denied') || msg.includes('Missing or insufficient permissions')) {
      return { isConnected: true, message: 'سرویس آنلاین در دسترس است' };
    }
    return { isConnected: false, message: 'سرویس در دسترس نیست' };
  }
}

// Upload file to Cloud Storage with clean path structure and fast fallback timeout
export async function uploadToFirebaseStorage(
  file: File | Blob,
  path: string,
  timeoutMs = 12000
): Promise<string> {
  const uploadTask = async () => {
    const storageRef = ref(storageBucket, path);
    const snapshot = await uploadBytes(storageRef, file, {
      contentType: file.type || 'image/jpeg'
    });
    return await getDownloadURL(snapshot.ref);
  };

  const timeoutTask = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Storage operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([uploadTask(), timeoutTask]);
  } catch (error) {
    console.warn('Cloud Storage upload failed or timed out:', error);
    throw error;
  }
}

export {
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged
};
export type { User };
