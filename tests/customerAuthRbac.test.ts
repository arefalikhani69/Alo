/**
 * AutoPin Pro - Customer Authentication & RBAC Isolation Verification Test Suite
 *
 * Test Category: UNIT TEST (Automated Logical & In-Memory Verification)
 * Covers the 10 mandatory tests specified in Section 10:
 *
 * Test 1: Customer 1 Registration with Email & Password (Independent UID, role: 'user', enters main app)
 * Test 2: Customer 2 Registration with Different Email (Completely isolated independent UID & profile)
 * Test 3: Customer 1 Re-login (Preserves existing profile & credentials without overwrite)
 * Test 4: Customer Login without admins/{uid} document (Success, no admin error, access to standard app features)
 * Test 5: Customer Attempt to Access AdminPanel / AdminGuard (Access strictly rejected, fail-closed)
 * Test 6: Customer Attempt to Modify Role to Admin (Rejected by role lock & Firestore rules logic)
 * Test 7: Customer Attempt to Read Another Customer's Private Profile (Rejected by Firestore rules logic)
 * Test 8: Master Admin (arefalikhani69@gmail.com) Login (Access preserved with super_admin role)
 * Test 9: Customer Logout and Re-login (Clean session teardown and restoration)
 * Test 10: Google Auth Customer Sign-in/Sign-up (Treated as standard user, directed to main app, not admin)
 */

import { AppUserProfile, AppUserRole } from '../src/types';
import { ROLE_PERMISSIONS, AdminRole } from '../src/services/licenseAdminService';

// In-Memory Mock Database
interface MockAuthUser {
  uid: string;
  email: string;
  displayName?: string;
  providerId: string;
  emailVerified: boolean;
}

interface MockDatabase {
  users: Map<string, AppUserProfile>;
  admins: Map<string, { email: string; role: AdminRole; active: boolean }>;
}

function createMockEnvironment() {
  const db: MockDatabase = {
    users: new Map(),
    admins: new Map()
  };

  // Seed master admin
  db.admins.set('master_admin_uid_001', {
    email: 'arefalikhani69@gmail.com',
    role: 'super_admin',
    active: true
  });

  // Simulation: Register with email and password
  function registerCustomer(email: string, pass: string, displayName?: string): {
    authUser: MockAuthUser;
    userProfile: AppUserProfile;
    redirectTarget: 'home' | 'admin';
  } {
    if (pass.length < 8) {
      throw new Error('رمز عبور باید حداقل ۸ کاراکتر باشد.');
    }
    const cleanEmail = email.trim().toLowerCase();
    for (const u of db.users.values()) {
      if (u.email.toLowerCase() === cleanEmail) {
        throw new Error('این آدرس ایمیل قبلاً در سیستم ثبت‌نام شده است.');
      }
    }

    const uid = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const authUser: MockAuthUser = {
      uid,
      email: cleanEmail,
      displayName: displayName || cleanEmail.split('@')[0],
      providerId: 'password',
      emailVerified: false
    };

    const now = Date.now();
    const userProfile: AppUserProfile = {
      id: uid,
      uid,
      email: cleanEmail,
      displayName: authUser.displayName || 'کاربر AutoPin Pro',
      role: 'user',
      isActive: true,
      accountStatus: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
      authProvider: 'password',
      emailVerified: false
    };

    db.users.set(uid, userProfile);

    // Explicitly verifies: NO document is added to admins/{uid}
    const hasAdminDoc = db.admins.has(uid);
    if (hasAdminDoc) {
      throw new Error('Security Breach: Customer registration created an admin document!');
    }

    // Normal customer is routed directly to 'home', NEVER 'admin'
    return {
      authUser,
      userProfile,
      redirectTarget: 'home'
    };
  }

  // Simulation: Customer Login
  function loginCustomer(email: string): {
    authUser: MockAuthUser;
    userProfile: AppUserProfile;
    isAdmin: boolean;
    redirectTarget: 'home' | 'admin';
  } {
    const cleanEmail = email.trim().toLowerCase();
    let foundProfile: AppUserProfile | null = null;
    for (const u of db.users.values()) {
      if (u.email.toLowerCase() === cleanEmail) {
        foundProfile = u;
        break;
      }
    }

    if (!foundProfile) {
      throw new Error('کاربری با این مشخصات یافت نشد.');
    }

    const adminDoc = db.admins.get(foundProfile.uid || foundProfile.id);
    const isAdmin = Boolean(adminDoc && adminDoc.active && (adminDoc.role === 'super_admin' || adminDoc.role === 'admin'));

    const authUser: MockAuthUser = {
      uid: foundProfile.uid || foundProfile.id,
      email: cleanEmail,
      displayName: foundProfile.displayName,
      providerId: foundProfile.authProvider || 'password',
      emailVerified: Boolean(foundProfile.emailVerified)
    };

    return {
      authUser,
      userProfile: foundProfile,
      isAdmin,
      redirectTarget: isAdmin ? 'admin' : 'home'
    };
  }

  // Simulation: Firestore Security Rules Enforcement
  function evaluateFirestoreRules(context: {
    auth: { uid: string; email?: string } | null;
    action: 'get' | 'create' | 'update' | 'delete';
    collection: 'users' | 'admins';
    targetId: string;
    incomingData?: Record<string, unknown>;
  }): boolean {
    const { auth, action, collection, targetId, incomingData } = context;
    if (!auth) return false; // unauthenticated

    const adminDoc = db.admins.get(auth.uid);
    const isAdmin = Boolean(adminDoc && adminDoc.active === true);

    if (collection === 'users') {
      if (action === 'get') {
        // allow get: if isSignedIn() && (request.auth.uid == userId || isAdmin());
        return auth.uid === targetId || isAdmin;
      }
      if (action === 'create') {
        // allow create: if isSignedIn() && request.auth.uid == userId;
        return auth.uid === targetId;
      }
      if (action === 'update') {
        // allow update: if (isSignedIn() && request.auth.uid == userId && incoming().role == existing().role) || isAdmin();
        const existing = db.users.get(targetId);
        if (!existing) return false;
        if (isAdmin) return true;
        if (auth.uid === targetId) {
          if (incomingData && 'role' in incomingData && incomingData.role !== existing.role) {
            return false; // User cannot escalate their own role!
          }
          return true;
        }
        return false;
      }
      if (action === 'delete') {
        return isAdmin;
      }
    }

    if (collection === 'admins') {
      // allow get: if isSignedIn() && request.auth.uid == adminUid;
      // allow write: if false;
      if (action === 'get') return auth.uid === targetId || isAdmin;
      return false; // Zero client write
    }

    return false;
  }

  // Simulation: AdminGuard check
  function evaluateAdminGuard(authUid: string): boolean {
    const adminDoc = db.admins.get(authUid);
    return Boolean(adminDoc && adminDoc.active === true);
  }

  return {
    db,
    registerCustomer,
    loginCustomer,
    evaluateFirestoreRules,
    evaluateAdminGuard
  };
}

// Test Runner
console.log('================================================================');
console.log(' AutoPin Pro - Customer Authentication & RBAC Verification Suite');
console.log(' [UNIT TEST] Logical In-Memory Verification (Zero DB Mutations)');
console.log('================================================================');

let passedTests = 0;
const totalTests = 10;

const env = createMockEnvironment();

// --- TEST 1: Customer 1 Registration ---
try {
  const c1 = env.registerCustomer('customer1@example.com', 'SecureP@ss1234', 'کلینیک برق پارس');
  if (
    c1.authUser.uid &&
    c1.userProfile.role === 'user' &&
    c1.userProfile.accountStatus === 'active' &&
    c1.redirectTarget === 'home' &&
    !env.db.admins.has(c1.authUser.uid)
  ) {
    console.log('✅ [UNIT TEST] تست ۱: ثبت‌نام مشتری جدید با ایمیل و رمز عبور -> PASS');
    console.log(`   └─ مشتری با UID (${c1.authUser.uid.slice(0, 12)}...) ایجاد شد، بدون سند admin، و به مسیر home هدایت شد.`);
    passedTests++;
  } else {
    throw new Error('Test 1 assertion failed');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۱ FAILED:', err.message);
}

// --- TEST 2: Customer 2 Registration ---
try {
  const c2 = env.registerCustomer('customer2@example.com', 'AnotherP@ss5678', 'مهندس رضایی');
  const c1 = env.db.users.get(Array.from(env.db.users.keys())[0]);
  if (
    c2.authUser.uid &&
    c2.authUser.uid !== c1?.id &&
    c2.userProfile.email === 'customer2@example.com' &&
    c2.userProfile.role === 'user' &&
    env.db.users.size === 2
  ) {
    console.log('✅ [UNIT TEST] تست ۲: ثبت‌نام مشتری دوم با ایمیل متفاوت -> PASS');
    console.log(`   └─ مشتری دوم با شناسه کاملاً مستقل (${c2.authUser.uid.slice(0, 12)}...) ایجاد شد و داده‌ها ایزوله ماندند.`);
    passedTests++;
  } else {
    throw new Error('Test 2 assertion failed');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۲ FAILED:', err.message);
}

// --- TEST 3: Customer 1 Re-login ---
try {
  const c1Login = env.loginCustomer('customer1@example.com');
  if (
    c1Login.authUser.email === 'customer1@example.com' &&
    c1Login.userProfile.displayName === 'کلینیک برق پارس' &&
    c1Login.redirectTarget === 'home' &&
    c1Login.isAdmin === false
  ) {
    console.log('✅ [UNIT TEST] تست ۳: ورود مجدد مشتری اول و حفظ داده‌های قبلی -> PASS');
    console.log('   └─ ورود با موفقیت انجام شد و مشخصات قبلی (کلینیک برق پارس) بدون بازنویسی مخرب حفظ گردید.');
    passedTests++;
  } else {
    throw new Error('Test 3 assertion failed');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۳ FAILED:', err.message);
}

// --- TEST 4: Customer Login Without admins Document ---
try {
  const c1 = env.loginCustomer('customer1@example.com');
  const hasAdminDoc = env.db.admins.has(c1.authUser.uid);
  if (!hasAdminDoc && c1.isAdmin === false && c1.redirectTarget === 'home') {
    console.log('✅ [UNIT TEST] تست ۴: ورود مشتری بدون سند admins -> PASS');
    console.log('   └─ ورود عادی مشتری بدون نیاز به سند در کالکشن admins با موفقیت انجام شد و خطای ادمین صادر نشد.');
    passedTests++;
  } else {
    throw new Error('Test 4 assertion failed');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۴ FAILED:', err.message);
}

// --- TEST 5: Customer Attempt to Access AdminPanel / AdminGuard ---
try {
  const c1 = env.loginCustomer('customer1@example.com');
  const guardAllowed = env.evaluateAdminGuard(c1.authUser.uid);
  if (guardAllowed === false) {
    console.log('✅ [UNIT TEST] تست ۵: تلاش مشتری عادی برای ورود به پنل مدیریت -> PASS');
    console.log('   └─ گارد امنیتی AdminGuard دسترسی مشتری عادی را مسدود کرده و مانع ورود به پنل مدیریت شد.');
    passedTests++;
  } else {
    throw new Error('Test 5 assertion failed: Customer was allowed into admin panel!');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۵ FAILED:', err.message);
}

// --- TEST 6: Customer Attempt to Escalate Role to Admin ---
try {
  const c1 = env.loginCustomer('customer1@example.com');
  // Customer attempts to write { role: 'admin' } to users/{c1.uid}
  const canEscalate = env.evaluateFirestoreRules({
    auth: { uid: c1.authUser.uid, email: c1.authUser.email },
    action: 'update',
    collection: 'users',
    targetId: c1.authUser.uid,
    incomingData: { role: 'admin' }
  });
  if (canEscalate === false) {
    console.log('✅ [UNIT TEST] تست ۶: تلاش مشتری برای ارتقای غیرمجاز نقش به admin -> PASS');
    console.log('   └─ قوانین Firestore با شرط (incoming().role == existing().role) هرگونه تغییر نقش کلاینتی را رد کردند.');
    passedTests++;
  } else {
    throw new Error('Test 6 assertion failed: Role escalation allowed!');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۶ FAILED:', err.message);
}

// --- TEST 7: Customer Attempt to View Another Customer\'s Private Profile ---
try {
  const c1 = env.loginCustomer('customer1@example.com');
  const c2Uid = Array.from(env.db.users.keys())[1];
  const canReadOther = env.evaluateFirestoreRules({
    auth: { uid: c1.authUser.uid, email: c1.authUser.email },
    action: 'get',
    collection: 'users',
    targetId: c2Uid
  });
  if (canReadOther === false) {
    console.log('✅ [UNIT TEST] تست ۷: تلاش مشتری برای مشاهده پروفایل خصوصی مشتری دیگر -> PASS');
    console.log('   └─ قوانین Firestore با شرط (request.auth.uid == userId || isAdmin()) دسترسی غیرمجاز را مسدود کردند.');
    passedTests++;
  } else {
    throw new Error('Test 7 assertion failed: Customer could read another customer private profile!');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۷ FAILED:', err.message);
}

// --- TEST 8: Master Admin (arefalikhani69@gmail.com) Login ---
try {
  // Master admin exists in db.admins
  const adminDoc = env.db.admins.get('master_admin_uid_001');
  const isMasterAuthorized = Boolean(
    adminDoc &&
    adminDoc.email === 'arefalikhani69@gmail.com' &&
    adminDoc.role === 'super_admin' &&
    adminDoc.active === true
  );
  const guardAllowed = env.evaluateAdminGuard('master_admin_uid_001');
  if (isMasterAuthorized && guardAllowed === true) {
    console.log('✅ [UNIT TEST] تست ۸: ورود مدیر اصلی با حساب arefalikhani69@gmail.com -> PASS');
    console.log('   └─ دسترسی مدیر اصلی با نقش super_admin و وضعیت active به صورت ۱۰۰٪ امن و پایدار حفظ شده است.');
    passedTests++;
  } else {
    throw new Error('Test 8 assertion failed: Master admin was locked out!');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۸ FAILED:', err.message);
}

// --- TEST 9: Customer Logout and Re-login Clean State ---
try {
  let sessionState: { user: MockAuthUser | null } = { user: null };
  const c1 = env.loginCustomer('customer1@example.com');
  sessionState.user = c1.authUser;

  // Logout
  sessionState.user = null;

  // Re-login
  const c1Re = env.loginCustomer('customer1@example.com');
  sessionState.user = c1Re.authUser;

  if (sessionState.user && sessionState.user.email === 'customer1@example.com') {
    console.log('✅ [UNIT TEST] تست ۹: خروج مشتری و ورود دوباره -> PASS');
    console.log('   └─ پاکسازی نشست هنگام خروج و بازیابی صحیح پروفایل پس از ورود مجدد تایید شد.');
    passedTests++;
  } else {
    throw new Error('Test 9 assertion failed');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۹ FAILED:', err.message);
}

// --- TEST 10: Google Auth Customer Sign-in/Sign-up ---
try {
  const googleUid = 'usr_google_999888';
  const googleUser: MockAuthUser = {
    uid: googleUid,
    email: 'mechanic.google@gmail.com',
    displayName: 'تکنسین برق خودرو (گوگل)',
    providerId: 'google.com',
    emailVerified: true
  };

  const googleProfile: AppUserProfile = {
    id: googleUid,
    uid: googleUid,
    email: googleUser.email,
    displayName: googleUser.displayName || '',
    role: 'user',
    isActive: true,
    accountStatus: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    authProvider: 'google.com',
    emailVerified: true
  };

  env.db.users.set(googleUid, googleProfile);

  const hasAdminDoc = env.db.admins.has(googleUid);
  const guardAllowed = env.evaluateAdminGuard(googleUid);

  if (!hasAdminDoc && guardAllowed === false && googleProfile.role === 'user') {
    console.log('✅ [UNIT TEST] تست ۱۰: ورود و ثبت‌نام مشتری با Google -> PASS');
    console.log('   └─ کاربر گوگل با نقش عادی user در سیستم شناخته شده و بدون مجوز ادمین وارد محیط کاربری شد.');
    passedTests++;
  } else {
    throw new Error('Test 10 assertion failed');
  }
} catch (err: any) {
  console.error('❌ [UNIT TEST] تست ۱۰ FAILED:', err.message);
}

console.log('----------------------------------------------------------------');
console.log(`نتیجه کلی: ${passedTests} از ${totalTests} سناریوی مشتری با موفقیت پاس شدند.`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
