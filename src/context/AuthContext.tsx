import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  auth,
  User,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  verifyUserAdminRole,
  validateFirestoreConnection,
  isBootstrapMasterEmail,
  isEmailVerifiedBootstrapCandidate,
  callVerifyAdminSession,
  AdminVerificationStatus,
  AdminVerificationResult
} from '../services/firebase';
import { AppUserProfile, AppUserRole } from '../types';
import { storage } from '../services/storage';
import { onlineStorage } from '../services/onlineStorage';

export type { AdminVerificationStatus, AdminVerificationResult };

interface AuthContextType {
  currentUser: User | null;
  userProfile: AppUserProfile | null;
  role: AppUserRole;
  isAdmin: boolean;
  hasFirestoreAdminDoc: boolean;
  firestoreAdminStatus: AdminVerificationStatus;
  firestoreAdminError: string | null;
  adminRole: 'super_admin' | 'admin' | 'support' | null;
  adminVerificationStatus: AdminVerificationStatus;
  adminVerificationError: string | null;
  isAdminLoading: boolean;
  isTechnician: boolean;
  isStandardUser: boolean;
  isActive: boolean;
  isLoading: boolean;
  isOnlineDbConnected: boolean;
  accountDisabledError: string | null;
  clearAccountError: () => void;
  loginWithGoogle: () => Promise<void>;
  loginWithEmail: (e: string, p: string) => Promise<void>;
  registerWithEmail: (e: string, p: string, displayName?: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  recheckAdminRole: () => Promise<AdminVerificationResult>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<AppUserProfile | null>(null);
  const [role, setRole] = useState<AppUserRole>('user');
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [hasFirestoreAdminDoc, setHasFirestoreAdminDoc] = useState<boolean>(false);
  const [firestoreAdminStatus, setFirestoreAdminStatus] = useState<AdminVerificationStatus>('unauthenticated');
  const [firestoreAdminError, setFirestoreAdminError] = useState<string | null>(null);
  const [adminRole, setAdminRole] = useState<'super_admin' | 'admin' | 'support' | null>(null);
  const [adminVerificationStatus, setAdminVerificationStatus] = useState<AdminVerificationStatus>('unauthenticated');
  const [adminVerificationError, setAdminVerificationError] = useState<string | null>(null);
  const [isAdminLoading, setIsAdminLoading] = useState<boolean>(true);
  const [isTechnician, setIsTechnician] = useState<boolean>(false);
  const [isStandardUser, setIsStandardUser] = useState<boolean>(true);
  const [isActive, setIsActive] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isOnlineDbConnected, setIsOnlineDbConnected] = useState<boolean>(false);
  const [accountDisabledError, setAccountDisabledError] = useState<string | null>(null);

  const applyProfile = useCallback((profile: AppUserProfile | null) => {
    setUserProfile(profile);
    if (!profile) {
      setRole('user');
      setIsAdmin(false);
      setAdminRole(null);
      setAdminVerificationStatus('unauthenticated');
      setAdminVerificationError(null);
      setIsAdminLoading(false);
      setIsTechnician(false);
      setIsStandardUser(true);
      setIsActive(true);
      return;
    }

    const currentRole = profile.role || 'user';
    setRole(currentRole);
    setIsAdmin(currentRole === 'admin');
    setIsTechnician(currentRole === 'technician');
    setIsStandardUser(currentRole === 'user');
    setIsActive(profile.isActive ?? true);
  }, []);

  const resolveAdminAccessForUser = useCallback(async (user: User): Promise<{
    adminResult: AdminVerificationResult;
    isPanelAccessible: boolean;
    role: 'super_admin' | 'admin' | 'support' | null;
    verificationStatus: AdminVerificationStatus;
    verificationError: string | null;
  }> => {
    let adminResult = await verifyUserAdminRole(user);

    if (adminResult.isAdmin) {
      return {
        adminResult,
        isPanelAccessible: true,
        role: adminResult.role,
        verificationStatus: 'verified',
        verificationError: null
      };
    }

    if (
      adminResult.status === 'inactive' ||
      adminResult.status === 'invalid_role' ||
      adminResult.status === 'permission_denied' ||
      adminResult.status === 'network_error'
    ) {
      return {
        adminResult,
        isPanelAccessible: false,
        role: null,
        verificationStatus: adminResult.status,
        verificationError: adminResult.errorMessage || null
      };
    }

    // status === 'not_found'
    if (isBootstrapMasterEmail(user.email)) {
      if (!user.emailVerified) {
        const unverifiedRes: AdminVerificationResult = {
          isAdmin: false,
          role: null,
          status: 'email_unverified',
          errorMessage: 'ایمیل حساب کاربری هنوز تأیید (Verify) نشده است. ایمیل به تنهایی مجوز دسترسی مدیریتی ایجاد نمی‌کند.'
        };
        return {
          adminResult: unverifiedRes,
          isPanelAccessible: false,
          role: null,
          verificationStatus: 'email_unverified',
          verificationError: unverifiedRes.errorMessage || null
        };
      }

      if (isEmailVerifiedBootstrapCandidate(user)) {
        const fnOutcome = await callVerifyAdminSession();
        if (fnOutcome.ok) {
          adminResult = await verifyUserAdminRole(user);
          if (adminResult.isAdmin) {
            return {
              adminResult,
              isPanelAccessible: true,
              role: adminResult.role,
              verificationStatus: 'verified',
              verificationError: null
            };
          }
          return {
            adminResult,
            isPanelAccessible: false,
            role: null,
            verificationStatus: adminResult.status,
            verificationError: adminResult.errorMessage || 'سند مدیر پس از تأیید سرور در Firestore یافت نشد.'
          };
        }

        if (fnOutcome.category === 'function_not_deployed') {
          // Diagnostic Phase-1 preview only: never grant super_admin role or verified status without admins/{uid}
          return {
            adminResult,
            isPanelAccessible: true,
            role: null,
            verificationStatus: 'not_found',
            verificationError: fnOutcome.message
          };
        }

        if (fnOutcome.category === 'network_offline') {
          return {
            adminResult: {
              isAdmin: false,
              role: null,
              status: 'network_error',
              errorMessage: fnOutcome.message
            },
            isPanelAccessible: false,
            role: null,
            verificationStatus: 'network_error',
            verificationError: fnOutcome.message
          };
        }

        const mappedStatus: AdminVerificationStatus =
          fnOutcome.category === 'email_unverified'
            ? 'email_unverified'
            : fnOutcome.category === 'inactive_admin'
            ? 'inactive'
            : fnOutcome.category === 'unauthenticated'
            ? 'unauthenticated'
            : 'permission_denied';

        return {
          adminResult: {
            isAdmin: false,
            role: null,
            status: mappedStatus,
            errorMessage: fnOutcome.message
          },
          isPanelAccessible: false,
          role: null,
          verificationStatus: mappedStatus,
          verificationError: fnOutcome.message
        };
      }
    }

    return {
      adminResult,
      isPanelAccessible: false,
      role: null,
      verificationStatus: adminResult.status,
      verificationError: null
    };
  }, []);

  const syncUserAndPermissions = useCallback(async (user: User) => {
    setIsAdminLoading(true);

    // 1. Sync in local storage
    const localProfile = storage.syncUserOnAuth({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL
    });

    // 2. Verify Admin role via authoritative Firestore check + eligible server verifyAdminSession
    const resolved = await resolveAdminAccessForUser(user);

    // Guard against race conditions if user switched or signed out during async check
    if (auth.currentUser?.uid !== user.uid) {
      return;
    }

    // Track real Firestore /admins/{uid} status separately from diagnostic preview
    setHasFirestoreAdminDoc(resolved.adminResult.isAdmin);
    setFirestoreAdminStatus(resolved.adminResult.status);
    setFirestoreAdminError(resolved.adminResult.errorMessage || null);

    // 3. If online, sync user profile to Firestore complying with strict self-create/update rules
    try {
      const cloudProfileToSave: AppUserProfile = {
        ...localProfile,
        role: resolved.adminResult.isAdmin ? 'admin' : 'user'
      };
      await onlineStorage.saveUser(cloudProfileToSave);
    } catch {
      // ignore
    }

    setAdminVerificationStatus(resolved.verificationStatus);
    setAdminRole(resolved.role);
    setAdminVerificationError(resolved.verificationError);
    setIsAdminLoading(false);

    const finalRole: AppUserRole = resolved.isPanelAccessible
      ? 'admin'
      : (localProfile.role === 'technician' ? 'technician' : 'user');

    const consolidatedProfile: AppUserProfile = {
      ...localProfile,
      role: finalRole
    };

    // Check account status
    if (consolidatedProfile.isActive === false) {
      setAccountDisabledError('حساب کاربری شما توسط مدیر سیستم به حالت تعلیق درآمده است. لطفاً جهت بررسی با مدیر تماس حاصل فرمایید.');
      await signOut(auth);
      setCurrentUser(null);
      setHasFirestoreAdminDoc(false);
      setFirestoreAdminStatus('unauthenticated');
      setFirestoreAdminError(null);
      applyProfile(null);
      return;
    }

    setAccountDisabledError(null);
    setCurrentUser(user);
    applyProfile(consolidatedProfile);
  }, [applyProfile, resolveAdminAccessForUser]);

  useEffect(() => {
    // Initialize storage seed database on startup
    storage.initDatabase();

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          await user.getIdToken();
          await syncUserAndPermissions(user);
        } catch (tokenErr: unknown) {
          console.warn('Auth token verification notice:', tokenErr);
          const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
          if (msg.includes('token-service-api') || msg.includes('auth/') || msg.includes('Fetching auth token failed')) {
            try {
              await signOut(auth);
            } catch {
              // ignore
            }
            setCurrentUser(null);
            applyProfile(null);
          } else {
            setCurrentUser(user);
            await syncUserAndPermissions(user);
          }
        }
      } else {
        setCurrentUser(null);
        setHasFirestoreAdminDoc(false);
        setFirestoreAdminStatus('unauthenticated');
        setFirestoreAdminError(null);
        applyProfile(null);
      }
      setIsLoading(false);

      validateFirestoreConnection()
        .then(res => setIsOnlineDbConnected(res.isConnected))
        .catch(() => setIsOnlineDbConnected(false));
    });

    return () => unsubscribe();
  }, [applyProfile, syncUserAndPermissions]);

  const refreshProfile = async () => {
    if (currentUser) {
      await syncUserAndPermissions(currentUser);
    }
  };

  const clearAccountError = () => {
    setAccountDisabledError(null);
  };

  const loginWithGoogle = async () => {
    try {
      setAccountDisabledError(null);
      const provider = new GoogleAuthProvider();
      const res = await signInWithPopup(auth, provider);
      if (res.user) {
        await syncUserAndPermissions(res.user);
        storage.recordAuditLog({
          actionType: 'auth_login',
          userId: res.user.uid,
          userEmail: res.user.email || 'google-user',
          userRole: isEmailVerifiedBootstrapCandidate(res.user) ? 'admin' : 'user',
          targetType: 'auth',
          targetTitle: 'ورود با حساب گوگل',
          status: 'success',
          summary: `ورود موفق کاربر «${res.user.email}» با حساب گوگل`
        });
      }
    } catch (err) {
      storage.recordAuditLog({
        actionType: 'auth_login',
        userId: 'anonymous',
        userEmail: 'google-auth',
        userRole: 'user',
        targetType: 'auth',
        targetTitle: 'ورود با گوگل',
        status: 'failure',
        summary: 'تلاش ناموفق برای ورود با حساب گوگل'
      });
      console.error('Google Sign-In failed:', err);
      throw err;
    }
  };

  const loginWithEmail = async (email: string, pass: string) => {
    try {
      setAccountDisabledError(null);
      const res = await signInWithEmailAndPassword(auth, email, pass);
      if (res.user) {
        await syncUserAndPermissions(res.user);
        storage.recordAuditLog({
          actionType: 'auth_login',
          userId: res.user.uid,
          userEmail: res.user.email || email,
          userRole: isEmailVerifiedBootstrapCandidate(res.user) ? 'admin' : 'user',
          targetType: 'auth',
          targetTitle: 'ورود با ایمیل و رمز عبور',
          status: 'success',
          summary: `ورود موفق کاربر با ایمیل «${res.user.email || email}»`
        });
      }
    } catch (err) {
      storage.recordAuditLog({
        actionType: 'auth_login',
        userId: 'anonymous',
        userEmail: email,
        userRole: 'user',
        targetType: 'auth',
        targetTitle: 'ورود با ایمیل',
        status: 'failure',
        summary: `تلاش ناموفق برای ورود به سیستم با ایمیل «${email}»`
      });
      console.error('Email Sign-In failed:', err);
      throw err;
    }
  };

  const registerWithEmail = async (email: string, pass: string, displayName?: string) => {
    try {
      setAccountDisabledError(null);
      if (pass.length < 8) {
        throw new Error('رمز عبور باید حداقل ۸ کاراکتر باشد.');
      }
      const res = await createUserWithEmailAndPassword(auth, email.trim(), pass);
      if (res.user) {
        const now = Date.now();
        const name = displayName?.trim() || email.split('@')[0] || 'کاربر AutoPin Pro';
        const profile: AppUserProfile = {
          id: res.user.uid,
          uid: res.user.uid,
          email: (res.user.email || email).toLowerCase(),
          displayName: name,
          role: 'user',
          isActive: true,
          accountStatus: 'active',
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
          authProvider: 'password',
          emailVerified: Boolean(res.user.emailVerified)
        };
        storage.saveUser(profile);
        try {
          await onlineStorage.saveUser(profile);
        } catch {
          // ignore
        }
        await syncUserAndPermissions(res.user);
        storage.recordAuditLog({
          actionType: 'auth_login',
          userId: res.user.uid,
          userEmail: res.user.email || email,
          userRole: 'user',
          targetType: 'auth',
          targetTitle: 'ثبت‌نام کاربر جدید',
          status: 'success',
          summary: `ثبت‌نام و ورود کاربر جدید با ایمیل «${email}»`
        });
      }
    } catch (err) {
      console.error('Registration failed:', err);
      throw err;
    }
  };

  const resetPassword = async (email: string): Promise<void> => {
    setAccountDisabledError(null);
    if (!email || !email.trim()) {
      throw new Error('لطفاً آدرس ایمیل خود را وارد فرمایید.');
    }
    await sendPasswordResetEmail(auth, email.trim());
  };

  const recheckAdminRole = useCallback(async (): Promise<AdminVerificationResult> => {
    const activeUser = auth.currentUser || currentUser;
    if (!activeUser) {
      const res: AdminVerificationResult = {
        isAdmin: false,
        role: null,
        status: 'unauthenticated',
        errorMessage: 'کاربر وارد سیستم نشده است.'
      };
      setHasFirestoreAdminDoc(false);
      setFirestoreAdminStatus('unauthenticated');
      setFirestoreAdminError(res.errorMessage || null);
      setAdminVerificationStatus('unauthenticated');
      setAdminRole(null);
      setIsAdmin(false);
      return res;
    }
    setIsAdminLoading(true);
    const resolved = await resolveAdminAccessForUser(activeUser);

    setHasFirestoreAdminDoc(resolved.adminResult.isAdmin);
    setFirestoreAdminStatus(resolved.adminResult.status);
    setFirestoreAdminError(resolved.adminResult.errorMessage || null);

    setAdminVerificationStatus(resolved.verificationStatus);
    setAdminRole(resolved.role);
    setAdminVerificationError(resolved.verificationError);
    setIsAdminLoading(false);

    if (resolved.isPanelAccessible) {
      setIsAdmin(true);
      setRole('admin');
      setUserProfile(prev => (prev ? { ...prev, role: resolved.adminResult.isAdmin ? 'admin' : prev.role } : prev));
    } else {
      setIsAdmin(false);
      setUserProfile(prev => {
        const fallbackRole: AppUserRole = prev?.role === 'technician' ? 'technician' : 'user';
        setRole(fallbackRole);
        return prev ? { ...prev, role: fallbackRole } : prev;
      });
    }
    return resolved.adminResult;
  }, [currentUser, resolveAdminAccessForUser]);

  const logout = async () => {
    if (currentUser) {
      storage.recordAuditLog({
        actionType: 'auth_logout',
        userId: currentUser.uid,
        userEmail: currentUser.email || 'unknown',
        userRole: role,
        targetType: 'auth',
        targetTitle: 'خروج از حساب کاربری',
        status: 'success',
        summary: `خروج کاربر «${currentUser.email || currentUser.uid}» از سامانه`
      });
    }
    setCurrentUser(null);
    applyProfile(null);
    setHasFirestoreAdminDoc(false);
    setFirestoreAdminStatus('unauthenticated');
    setFirestoreAdminError(null);
    setAdminRole(null);
    setAdminVerificationStatus('unauthenticated');
    setAdminVerificationError(null);
    setIsAdmin(false);
    setAccountDisabledError(null);
    try {
      await signOut(auth);
    } catch {
      // ignore
    }
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        userProfile,
        role,
        isAdmin,
        hasFirestoreAdminDoc,
        firestoreAdminStatus,
        firestoreAdminError,
        adminRole,
        adminVerificationStatus,
        adminVerificationError,
        isAdminLoading,
        isTechnician,
        isStandardUser,
        isActive,
        isLoading,
        isOnlineDbConnected,
        accountDisabledError,
        clearAccountError,
        loginWithGoogle,
        loginWithEmail,
        registerWithEmail,
        resetPassword,
        logout,
        refreshProfile,
        recheckAdminRole
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
};
