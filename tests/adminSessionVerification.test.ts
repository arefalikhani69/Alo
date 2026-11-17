/**
 * AutoPin Pro - Admin Session & Bootstrap Verification Unit Tests
 *
 * Tests real exported helpers from src/services/firebase.ts to ensure:
 * 1. Email alone never satisfies bootstrap candidate eligibility without emailVerified === true.
 * 2. Error classification accurately distinguishes offline/network, unauthenticated,
 *    email_unverified, inactive_admin, bootstrap_locked, permission_denied, and function_not_deployed.
 * 3. Region is explicitly pinned to 'us-central1'.
 */

import {
  FUNCTIONS_REGION,
  isBootstrapMasterEmail,
  isEmailVerifiedBootstrapCandidate,
  classifyVerifyAdminSessionError,
  type User
} from '../src/services/firebase';

interface CheckResult {
  name: string;
  passed: boolean;
  details: string;
}

function makeMockUser(overrides: Partial<User>): User {
  return {
    uid: 'uid_test_1',
    email: 'user@example.com',
    emailVerified: false,
    ...overrides
  } as User;
}

export function runAdminSessionVerificationTests(): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. Region pinned to us-central1
  results.push({
    name: 'Cloud Functions region pinned to us-central1',
    passed: FUNCTIONS_REGION === 'us-central1',
    details: `FUNCTIONS_REGION=${FUNCTIONS_REGION}`
  });

  // 2. Master email normalization check
  results.push({
    name: 'Bootstrap master email normalizes case and whitespace',
    passed:
      isBootstrapMasterEmail('  AREFALIKHANI69@GMAIL.COM ') === true &&
      isBootstrapMasterEmail('other@gmail.com') === false &&
      isBootstrapMasterEmail(null) === false,
    details: 'Case-insensitive exact master email matching verified'
  });

  // 3. Unverified master email MUST be rejected as bootstrap candidate
  const unverifiedMaster = makeMockUser({
    email: 'arefalikhani69@gmail.com',
    emailVerified: false
  });
  results.push({
    name: 'Unverified master email cannot be bootstrap candidate',
    passed: isEmailVerifiedBootstrapCandidate(unverifiedMaster) === false,
    details: 'emailVerified=false denied even when email matches master'
  });

  // 4. Verified non-master email MUST be rejected as bootstrap candidate
  const verifiedNormal = makeMockUser({
    email: 'random.admin@gmail.com',
    emailVerified: true
  });
  results.push({
    name: 'Verified non-master email cannot be bootstrap candidate',
    passed: isEmailVerifiedBootstrapCandidate(verifiedNormal) === false,
    details: 'Non-master verified account denied bootstrap eligibility'
  });

  // 5. Verified master email is eligible candidate
  const verifiedMaster = makeMockUser({
    email: 'arefalikhani69@gmail.com',
    emailVerified: true
  });
  results.push({
    name: 'Verified master email passes bootstrap pre-check',
    passed: isEmailVerifiedBootstrapCandidate(verifiedMaster) === true,
    details: 'Requires both emailVerified === true and master email match'
  });

  // 6. Error classification matrix
  const offlineErr = classifyVerifyAdminSessionError(new Error('network timeout'), false);
  const unavailableErr = classifyVerifyAdminSessionError({ code: 'functions/unavailable', message: 'Service unavailable' }, true);
  const unauthErr = classifyVerifyAdminSessionError({ code: 'functions/unauthenticated', message: 'Unauthenticated' }, true);
  const emailUnverifiedErr = classifyVerifyAdminSessionError(
    { code: 'functions/permission-denied', message: 'برای فعال‌سازی اولیه مدیر ارشد در سرور، تأیید ایمیل حساب کاربری الزامی است.' },
    true
  );
  const inactiveErr = classifyVerifyAdminSessionError(
    { code: 'functions/permission-denied', message: 'دسترسی مدیریتی این حساب کاربری غیرفعال یا لغو شده است.' },
    true
  );
  const bootstrapLockedErr = classifyVerifyAdminSessionError(
    { code: 'functions/permission-denied', message: 'سیستم قبلاً راه‌اندازی شده است و امکان اجرای مجدد Bootstrap وجود ندارد.' },
    true
  );
  const genericDeniedErr = classifyVerifyAdminSessionError(
    { code: 'functions/permission-denied', message: 'کاربر فاقد سند معتبر و فعال در فهرست مدیران سیستم می‌باشد.' },
    true
  );
  const notDeployedErr = classifyVerifyAdminSessionError(
    { code: 'functions/not-found', message: 'Function not found' },
    true
  );
  const cors404Err = classifyVerifyAdminSessionError(
    new Error('Failed to fetch: CORS preflight 404'),
    true
  );

  const matrixOk =
    offlineErr.category === 'network_offline' &&
    unavailableErr.category === 'network_offline' &&
    unauthErr.category === 'unauthenticated' &&
    emailUnverifiedErr.category === 'email_unverified' &&
    inactiveErr.category === 'inactive_admin' &&
    bootstrapLockedErr.category === 'bootstrap_locked' &&
    genericDeniedErr.category === 'permission_denied' &&
    notDeployedErr.category === 'function_not_deployed' &&
    cors404Err.category === 'function_not_deployed';

  results.push({
    name: 'Server error classification distinguishes offline, auth, policy, and undeployed states',
    passed: matrixOk,
    details: JSON.stringify({
      offline: offlineErr.category,
      unavailable: unavailableErr.category,
      unauth: unauthErr.category,
      emailUnverified: emailUnverifiedErr.category,
      inactive: inactiveErr.category,
      bootstrapLocked: bootstrapLockedErr.category,
      genericDenied: genericDeniedErr.category,
      notDeployed: notDeployedErr.category,
      cors404: cors404Err.category
    })
  });

  return results;
}

if (process.argv[1]?.endsWith('adminSessionVerification.test.ts')) {
  const results = runAdminSessionVerificationTests();
  let passed = 0;
  for (const r of results) {
    console.log(`${r.passed ? '✅' : '❌'} ${r.name}`);
    console.log(`   └─ ${r.details}`);
    if (r.passed) passed++;
  }
  console.log(`\nSummary: ${passed}/${results.length} passed`);
  if (passed !== results.length) {
    process.exit(1);
  }
}
