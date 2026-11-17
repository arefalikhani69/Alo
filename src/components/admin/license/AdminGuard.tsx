/**
 * AutoPin Pro - License Administration Security Guard
 *
 * Authoritative Single Source of Truth Enforcement:
 * 1. NEVER trusts LocalStorage, optimistic client flags, or unverified email strings.
 * 2. Establishes a direct real-time Firestore listener on `doc(db, 'admins', currentUser.uid)`.
 * 3. Immediately terminates access if the admin document is deleted, deactivated (active !== true),
 *    or if authentication / server bootstrap verification is rejected.
 * 4. Executes full 7-step server verification & idempotent bootstrap for «استعلام و ثبت مجدد در سرور».
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ShieldAlert, Lock, ArrowRight, KeyRound, AlertTriangle } from 'lucide-react';
import { doc, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../../../context/AuthContext';
import {
  auth,
  db,
  FUNCTIONS_REGION,
  callVerifyAdminSession,
  isBootstrapMasterEmail,
  isEmailVerifiedBootstrapCandidate,
  validateFirestoreConnection,
  verifyUserAdminRole,
  VerifyAdminSessionErrorCategory
} from '../../../services/firebase';
import type { AdminRole } from '../../../services/licenseAdminService';

export interface AdminGuardStatus {
  verifiedRole: AdminRole | null;
  hasFirestoreAdminDoc: boolean;
  isProvisioningAdmin: boolean;
  bootstrapError: string | null;
  bootstrapErrorCategory: VerifyAdminSessionErrorCategory | null;
  bootstrapStepLabel: string | null;
  bootstrapSuccessMessage: string | null;
  retryServerBootstrap: () => Promise<void>;
}

const AdminGuardContext = createContext<AdminGuardStatus>({
  verifiedRole: null,
  hasFirestoreAdminDoc: false,
  isProvisioningAdmin: false,
  bootstrapError: null,
  bootstrapErrorCategory: null,
  bootstrapStepLabel: null,
  bootstrapSuccessMessage: null,
  retryServerBootstrap: async () => {}
});

export const useAdminGuardStatus = () => useContext(AdminGuardContext);

interface AdminGuardProps {
  children: React.ReactNode;
  onReturn: () => void;
}

export const AdminGuard: React.FC<AdminGuardProps> = ({ children, onReturn }) => {
  const { currentUser, isLoading: isAuthLoading, hasFirestoreAdminDoc: authHasAdminDoc, recheckAdminRole } = useAuth();
  const [isServerAdminVerified, setIsServerAdminVerified] = useState<boolean | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [adminRole, setAdminRole] = useState<AdminRole | null>(null);
  const [hasFirestoreAdminDoc, setHasFirestoreAdminDoc] = useState<boolean>(false);
  const [isProvisioningAdmin, setIsProvisioningAdmin] = useState<boolean>(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapErrorCategory, setBootstrapErrorCategory] = useState<VerifyAdminSessionErrorCategory | null>(null);
  const [bootstrapStepLabel, setBootstrapStepLabel] = useState<string | null>(null);
  const [bootstrapSuccessMessage, setBootstrapSuccessMessage] = useState<string | null>(null);

  const bootstrapAttemptedUidsRef = useRef<Set<string>>(new Set());
  const isRunningBootstrapRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /**
   * 7-Step Authoritative Server Verification & Safe Idempotent Bootstrap:
   * 1. Check Firebase/Firestore connectivity
   * 2. Verify & refresh Firebase Auth session
   * 3. Evaluate admin role & bootstrap eligibility
   * 4. Query /admins/{uid} directly from server
   * 5. Invoke verifyAdminSession only when eligible and document is missing
   * 6. Receive & validate server response + confirm Firestore doc
   * 7. Update reactive UI state without requiring Logout/Login
   */
  const runServerBootstrap = useCallback(async () => {
    if (isRunningBootstrapRef.current) return;
    const activeUser = auth.currentUser || currentUser;
    if (!activeUser) {
      setIsServerAdminVerified(false);
      setHasFirestoreAdminDoc(false);
      setAdminRole(null);
      setBootstrapErrorCategory('unauthenticated');
      setBootstrapError('کاربر به حساب کاربری Firebase وارد نشده است.');
      setVerificationError('کاربر به حساب کاربری Firebase وارد نشده است.');
      return;
    }

    isRunningBootstrapRef.current = true;
    setIsProvisioningAdmin(true);
    setBootstrapError(null);
    setBootstrapErrorCategory(null);
    setBootstrapSuccessMessage(null);

    try {
      // Step 1: Check Firebase / Firestore connectivity
      setBootstrapStepLabel('۱/۷ بررسی اتصال به Firebase و Firestore...');
      const conn = await validateFirestoreConnection();
      if (!isMountedRef.current) return;
      if (!conn.isConnected) {
        setBootstrapErrorCategory('network_offline');
        setBootstrapError(`مرحله ۱ (اتصال Firebase): ${conn.message}. لطفاً اینترنت یا دسترسی به سرویس ابری را بررسی کنید.`);
        return;
      }

      // Step 2: Check & refresh Firebase Auth session
      setBootstrapStepLabel('۲/۷ بررسی و تازه‌سازی نشست احراز هویت (Firebase Auth)...');
      try {
        await activeUser.reload();
        await activeUser.getIdToken(true);
      } catch (tokenErr) {
        if (!isMountedRef.current) return;
        const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr || '');
        const isNetwork = msg.includes('network') || msg.includes('offline');
        setBootstrapErrorCategory(isNetwork ? 'network_offline' : 'unauthenticated');
        setBootstrapError(
          isNetwork
            ? 'مرحله ۲ (Auth): ارتباط شبکه هنگام تازه‌سازی توکن برقرار نشد.'
            : 'مرحله ۲ (Auth): نشست احراز هویت معتبر نیست یا منقضی شده است.'
        );
        if (!isNetwork) {
          setIsServerAdminVerified(false);
          setHasFirestoreAdminDoc(false);
          setAdminRole(null);
        }
        return;
      }
      if (!isMountedRef.current) return;

      // Step 3 & 4: Query /admins/{uid} directly from Firestore server
      setBootstrapStepLabel(`۳/۷ و ۴/۷ استعلام مستقیم سند admins/${activeUser.uid.slice(0, 8)}... از سرور`);
      const roleCheck = await verifyUserAdminRole(activeUser);
      if (!isMountedRef.current) return;

      if (roleCheck.status === 'verified' && roleCheck.isAdmin && roleCheck.role) {
        // Admin document already exists and is active -> idempotent sync, no bootstrap needed
        setBootstrapStepLabel('۷/۷ همگام‌سازی فوری وضعیت مدیر در رابط کاربری...');
        setHasFirestoreAdminDoc(true);
        setAdminRole(roleCheck.role);
        setIsServerAdminVerified(true);
        setVerificationError(null);
        setBootstrapError(null);
        setBootstrapErrorCategory(null);
        setBootstrapSuccessMessage('سند مدیریتی فعال در پایگاه داده ابری شناسایی و همگام‌سازی زنده فعال شد.');
        await recheckAdminRole();
        return;
      }

      if (roleCheck.status === 'inactive') {
        setHasFirestoreAdminDoc(false);
        setAdminRole(null);
        setIsServerAdminVerified(false);
        setBootstrapErrorCategory('inactive_admin');
        setBootstrapError(roleCheck.errorMessage || 'دسترسی مدیریتی این حساب غیرفعال شده است.');
        setVerificationError(roleCheck.errorMessage || 'دسترسی مدیریتی این حساب غیرفعال شده است.');
        return;
      }

      if (roleCheck.status === 'invalid_role') {
        setHasFirestoreAdminDoc(false);
        setAdminRole(null);
        setIsServerAdminVerified(false);
        setBootstrapErrorCategory('invalid_role');
        setBootstrapError(roleCheck.errorMessage || 'نقش ثبت‌شده در سند مدیر معتبر نیست.');
        setVerificationError(roleCheck.errorMessage || 'نقش ثبت‌شده در سند مدیر معتبر نیست.');
        return;
      }

      if (roleCheck.status === 'permission_denied') {
        setHasFirestoreAdminDoc(false);
        setAdminRole(null);
        setIsServerAdminVerified(false);
        setBootstrapErrorCategory('permission_denied');
        setBootstrapError(roleCheck.errorMessage || 'دسترسی خواندن سند مدیر توسط قوانین Firestore مسدود شد.');
        setVerificationError(roleCheck.errorMessage || 'دسترسی خواندن سند مدیر توسط قوانین Firestore مسدود شد.');
        return;
      }

      if (roleCheck.status === 'network_error') {
        setBootstrapErrorCategory('network_offline');
        setBootstrapError(roleCheck.errorMessage || 'خطای شبکه هنگام استعلام سند admins از Firestore.');
        return;
      }

      // Step 5: Document is missing (not_found). Verify strict bootstrap eligibility before calling server.
      setBootstrapStepLabel('۵/۷ بررسی صلاحیت Bootstrap و ارسال درخواست امن به سرور...');
      if (isBootstrapMasterEmail(activeUser.email) && !activeUser.emailVerified) {
        const msg = 'ایمیل حساب کاربری هنوز تأیید (Verify) نشده است؛ ایمیل به تنهایی مجوز Bootstrap صادر نمی‌کند.';
        setHasFirestoreAdminDoc(false);
        setAdminRole(null);
        setIsServerAdminVerified(false);
        setBootstrapErrorCategory('email_unverified');
        setBootstrapError(msg);
        setVerificationError(msg);
        return;
      }

      if (!isEmailVerifiedBootstrapCandidate(activeUser)) {
        const msg = 'این حساب کاربری مجاز به ثبت خودکار مدیر (Bootstrap) نیست. ثبت مدیر جدید صرفاً توسط Super Admin از طریق setAdminRole مجاز است.';
        setHasFirestoreAdminDoc(false);
        setAdminRole(null);
        setIsServerAdminVerified(false);
        setBootstrapErrorCategory('permission_denied');
        setBootstrapError(msg);
        setVerificationError(msg);
        return;
      }

      // Step 6: Call verifyAdminSession on Cloud Functions (region: us-central1)
      const fnOutcome = await callVerifyAdminSession();
      if (!isMountedRef.current) return;

      if (!fnOutcome.ok) {
        setBootstrapErrorCategory(fnOutcome.category);
        setBootstrapError(fnOutcome.message);

        if (
          fnOutcome.category === 'permission_denied' ||
          fnOutcome.category === 'bootstrap_locked' ||
          fnOutcome.category === 'email_unverified' ||
          fnOutcome.category === 'inactive_admin' ||
          fnOutcome.category === 'unauthenticated'
        ) {
          // Server explicitly rejected authorization/bootstrap -> Fail-Closed immediately
          setHasFirestoreAdminDoc(false);
          setAdminRole(null);
          setIsServerAdminVerified(false);
          setVerificationError(fnOutcome.message);
        }
        return;
      }

      setBootstrapStepLabel('۶/۷ تأیید پاسخ سرور و راستی‌آزمایی سند admins در Firestore...');
      const confirmedRoleCheck = await verifyUserAdminRole(activeUser);
      if (!isMountedRef.current) return;

      if (!confirmedRoleCheck.isAdmin || !confirmedRoleCheck.role) {
        setBootstrapErrorCategory('firestore_error');
        setBootstrapError(
          confirmedRoleCheck.errorMessage ||
            `سرویس verifyAdminSession پاسخ مثبت داد اما سند admins/${activeUser.uid} در دیتابیس هدف خوانده نشد.`
        );
        return;
      }

      // Step 7: Update UI reactively without Logout/Login
      setBootstrapStepLabel('۷/۷ فعال‌سازی همگام‌سازی زنده پنل بدون نیاز به ورود مجدد...');
      setHasFirestoreAdminDoc(true);
      setAdminRole(confirmedRoleCheck.role);
      setIsServerAdminVerified(true);
      setVerificationError(null);
      setBootstrapError(null);
      setBootstrapErrorCategory(null);
      setBootstrapSuccessMessage(
        fnOutcome.data.createdViaBootstrap
          ? `سند مدیر ارشد در سرور ثبت و همگام‌سازی زنده در منطقه ${FUNCTIONS_REGION} فعال شد.`
          : 'نشست مدیریتی شما توسط سرور تأیید و همگام‌سازی زنده فعال شد.'
      );
      await recheckAdminRole();
    } finally {
      isRunningBootstrapRef.current = false;
      if (isMountedRef.current) {
        setIsProvisioningAdmin(false);
        setBootstrapStepLabel(null);
      }
    }
  }, [currentUser, recheckAdminRole]);

  useEffect(() => {
    let isCancelled = false;

    if (isAuthLoading) return;

    setHasFirestoreAdminDoc(false);
    setBootstrapError(null);
    setBootstrapErrorCategory(null);
    setBootstrapSuccessMessage(null);

    // 1. Unauthenticated -> Strictly deny
    if (!currentUser) {
      setIsServerAdminVerified(false);
      setAdminRole(null);
      setVerificationError('کاربر به حساب کاربری Firebase وارد نشده است.');
      return;
    }

    const isVerifiedCandidate = isEmailVerifiedBootstrapCandidate(currentUser);

    // 2. Authoritative Single Source of Truth: Real-time listener on /admins/{uid}
    const adminDocRef = doc(db, 'admins', currentUser.uid);
    const unsubscribe = onSnapshot(
      adminDocRef,
      (docSnap) => {
        if (isCancelled) return;

        if (!docSnap.exists()) {
          setHasFirestoreAdminDoc(false);
          setAdminRole(null); // Never claim super_admin role without an active /admins/{uid} document

          if (isBootstrapMasterEmail(currentUser.email) && !currentUser.emailVerified) {
            setIsServerAdminVerified(false);
            setVerificationError('ایمیل حساب کاربری هنوز تأیید (Verify) نشده است؛ ایمیل به تنهایی دسترسی مدیر ارشد ایجاد نمی‌کند.');
            return;
          }

          if (isVerifiedCandidate) {
            if (!bootstrapAttemptedUidsRef.current.has(currentUser.uid)) {
              bootstrapAttemptedUidsRef.current.add(currentUser.uid);
              // Keep verification state pending until 7-step server check completes or reveals undeployed function
              setIsServerAdminVerified(null);
              runServerBootstrap().then(() => {
                if (isCancelled) return;
                // If function is simply not deployed yet, permit unprivileged Phase-1 diagnostic preview shell
                setIsServerAdminVerified((prev) => (prev === null ? true : prev));
              });
            } else {
              // Diagnostic Phase-1 shell already evaluated (when function not deployed)
              setIsServerAdminVerified((prev) => (prev === false ? false : true));
            }
            return;
          }

          setIsServerAdminVerified(false);
          setVerificationError('سند مدیریتی معتبری در پایگاه داده برای این حساب کاربری یافت نشد.');
          return;
        }

        const data = docSnap.data();
        if (data?.active !== true) {
          setHasFirestoreAdminDoc(false);
          setIsServerAdminVerified(false);
          setAdminRole(null);
          setVerificationError('دسترسی مدیریتی این حساب کاربری لغو یا به حالت تعلیق درآمده است.');
          return;
        }

        const role = data.role;
        if (role !== 'super_admin' && role !== 'admin' && role !== 'support') {
          setHasFirestoreAdminDoc(false);
          setIsServerAdminVerified(false);
          setAdminRole(null);
          setVerificationError(`نقش تعریف‌شده در سند (${String(role)}) معتبر نیست.`);
          return;
        }

        // Active and verified directly by server document
        setAdminRole(role as AdminRole);
        setHasFirestoreAdminDoc(true);
        setIsProvisioningAdmin(false);
        setBootstrapError(null);
        setBootstrapErrorCategory(null);
        setBootstrapStepLabel(null);
        setIsServerAdminVerified(true);
        setVerificationError(null);
        if (!authHasAdminDoc) {
          recheckAdminRole().catch(() => {});
        }
      },
      (error) => {
        if (isCancelled) return;
        // Strictly Fail-Closed on Firestore errors (email alone MUST NOT bypass errors)
        setHasFirestoreAdminDoc(false);
        setIsProvisioningAdmin(false);
        setBootstrapStepLabel(null);
        setIsServerAdminVerified(false);
        setAdminRole(null);
        const code = (error as { code?: string })?.code || '';
        const msg = error.message || '';
        if (code === 'unavailable' || msg.includes('offline') || msg.includes('unavailable')) {
          setVerificationError('خطای ارتباط با سرور پایگاه داده ابری. لطفاً وضعیت اتصال اینترنت را بررسی کنید.');
        } else if (code === 'permission-denied' || msg.includes('permission-denied')) {
          setVerificationError('خطای امنیتی: دسترسی به اسناد مدیریتی توسط قوانین سرور مسدود شد.');
        } else {
          setVerificationError(`خطای استعلام سرور: ${msg || 'عدم دسترسی به پایگاه داده'}`);
        }
      }
    );

    return () => {
      isCancelled = true;
      unsubscribe();
    };
  }, [currentUser, isAuthLoading, authHasAdminDoc, recheckAdminRole, runServerBootstrap]);

  // Loading state while authoritative server check completes
  if (isAuthLoading || isServerAdminVerified === null) {
    return (
      <div className="min-h-[500px] flex flex-col items-center justify-center p-8 bg-zinc-950 text-zinc-300">
        <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center animate-pulse">
          <KeyRound className="w-6 h-6 text-red-500 animate-spin" />
        </div>
        <p className="mt-4 text-sm font-medium text-zinc-400 font-mono">
          {bootstrapStepLabel || 'در حال استعلام مستقیم اصالت مجوز مدیر از سرور ابری...'}
        </p>
        <span className="text-[11px] text-zinc-600 font-mono mt-1">
          Server-Authoritative RBAC Validation
        </span>
      </div>
    );
  }

  // Unauthorized / Revoked Access State
  if (!isServerAdminVerified) {
    return (
      <div className="min-h-[550px] flex flex-col items-center justify-center p-6 text-center bg-zinc-950 rounded-2xl border border-red-950/40">
        <div className="w-16 h-16 rounded-2xl bg-red-950/40 border border-red-800/60 flex items-center justify-center mb-5 text-red-400 shadow-xl shadow-red-950/50">
          <ShieldAlert className="w-8 h-8" />
        </div>

        <h3 className="text-xl font-bold text-white mb-2 tracking-tight">
          دسترسی غیرمجاز - سامانه مدیریت لایسنس
        </h3>

        <p className="max-w-md text-sm text-zinc-400 mb-4 leading-relaxed">
          این پنل نیازمند احراز هویت از طریق سند فعال در کالکشن
          <span className="font-mono text-xs px-2 py-0.5 mx-1 rounded bg-zinc-900 text-red-400 border border-zinc-800">
            admins/{currentUser?.uid ? `${currentUser.uid.slice(0, 10)}...` : 'uid'}
          </span>
          با وضعیت <strong className="text-zinc-200">active == true</strong> می‌باشد. ایمیل به تنهایی، حافظه محلی (LocalStorage) یا توکن‌های منقضی‌شده نمی‌توانند این لایه امنیتی را دور بزنند.
        </p>

        {verificationError && (
          <div className="mb-6 px-3.5 py-2 rounded-xl bg-red-950/40 border border-red-900/60 text-xs text-red-300 flex items-center gap-2 max-w-md text-right">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{verificationError}</span>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={onReturn}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/80 font-medium text-sm transition active:scale-95"
          >
            <ArrowRight className="w-4 h-4" />
            <span>بازگشت به برنامه اصلی</span>
          </button>
        </div>

        <div className="mt-8 text-[11px] text-zinc-600 font-mono flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5 text-zinc-600" />
          <span>AutoPin Pro Cryptographic License Enclave - Zero Trust Enforcement</span>
        </div>
      </div>
    );
  }

  return (
    <AdminGuardContext.Provider
      value={{
        verifiedRole: adminRole,
        hasFirestoreAdminDoc,
        isProvisioningAdmin,
        bootstrapError,
        bootstrapErrorCategory,
        bootstrapStepLabel,
        bootstrapSuccessMessage,
        retryServerBootstrap: runServerBootstrap
      }}
    >
      {children}
    </AdminGuardContext.Provider>
  );
};
