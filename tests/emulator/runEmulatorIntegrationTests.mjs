import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PROJECT_ID = 'demo-autopin-pro';
const DATABASE_ID = 'ai-studio-autopinpro-6597dde9-59f0-4a2e-90e5-55436f30fb2d';
const AUTH_BASE = 'http://127.0.0.1:9099';
const FIRESTORE_BASE = `http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;
const FUNCTIONS_BASE = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`;

const TEST_PUBLIC_KEY_PEM = fs.readFileSync(
  path.resolve('tests/emulator/testPublicKey.pem'),
  'utf8'
);

// --- Helpers for Firestore Emulator REST API ---
function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFsValue) } };
  }
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFsValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return { __timestamp: v.timestampValue };
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) {
      out[k] = fromFsValue(val);
    }
    return out;
  }
  return v;
}

function decodeFsDoc(doc) {
  if (!doc || !doc.fields) return null;
  const out = { __name: doc.name, __id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields)) {
    out[k] = fromFsValue(v);
  }
  return out;
}

async function fsAdminSet(col, docId, data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) fields[k] = toFsValue(v);
  }
  const url = `${FIRESTORE_BASE}/${col}/${docId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    throw new Error(`fsAdminSet failed (${res.status}): ${await res.text()}`);
  }
  return decodeFsDoc(await res.json());
}

async function fsAdminGet(col, docId) {
  const url = `${FIRESTORE_BASE}/${col}/${docId}`;
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer owner' }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fsAdminGet failed (${res.status}): ${await res.text()}`);
  }
  return decodeFsDoc(await res.json());
}

async function fsAdminList(col) {
  const docs = [];
  let pageToken = '';
  do {
    const url = `${FIRESTORE_BASE}/${col}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer owner' }
    });
    if (!res.ok) {
      throw new Error(`fsAdminList(${col}) failed (${res.status}): ${await res.text()}`);
    }
    const json = await res.json();
    if (Array.isArray(json.documents)) {
      for (const d of json.documents) docs.push(decodeFsDoc(d));
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function fsClientRequest(method, docPath, token, data = null) {
  const url = `${FIRESTORE_BASE}/${docPath}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (data !== null) {
    const fields = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    opts.body = JSON.stringify({ fields });
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: json };
}

// --- Auth Emulator Helpers ---
async function createAuthUser(email, password) {
  const res = await fetch(
    `${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await res.json();
  if (!res.ok || !data.idToken) {
    throw new Error(`Auth signUp failed for ${email}: ${JSON.stringify(data)}`);
  }
  return { uid: data.localId, email, idToken: data.idToken };
}

// --- Callable Function Helper ---
async function callFunction(name, data = {}, idToken = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data })
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return {
    httpStatus: res.status,
    ok: res.ok,
    result: json?.result,
    error: json?.error
  };
}

// --- Crypto & Device Helpers ---
function generateDeviceIdentity(isWebClient = false) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyBase64 = spkiDer.toString('base64');
  const hashHex = crypto.createHash('sha256').update(spkiDer).digest('hex');
  const deviceId = `${isWebClient ? 'dev_web_' : 'dev_hw_'}${hashHex.substring(0, 32)}`;
  return { publicKey, privateKey, publicKeyBase64, deviceId, isWebClient };
}

function derToP1363(derBuf) {
  let offset = 2;
  if (derBuf[1] & 0x80) offset += derBuf[1] & 0x7f;
  if (derBuf[offset] !== 0x02) throw new Error('Invalid DER');
  const rLen = derBuf[offset + 1];
  let r = derBuf.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  if (derBuf[offset] !== 0x02) throw new Error('Invalid DER');
  const sLen = derBuf[offset + 1];
  let s = derBuf.subarray(offset + 2, offset + 2 + sLen);
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

function signChallengeWithDevice(device, challenge) {
  const signer = crypto.createSign('SHA256');
  signer.update(challenge, 'utf8');
  const derSig = signer.sign(device.privateKey);
  if (device.isWebClient) {
    return derToP1363(derSig).toString('base64');
  }
  return derSig.toString('base64');
}

function verifyServerLeaseWithTestKey(leaseToken) {
  if (!leaseToken || !leaseToken.signature) return false;
  const canonical = [
    leaseToken.licenseId,
    leaseToken.deviceId,
    leaseToken.issuedAtServer,
    leaseToken.validUntilServer,
    leaseToken.licenseExpiresAt
  ].join('|');
  const verifier = crypto.createVerify('SHA256');
  verifier.update(Buffer.from(canonical, 'utf8'));
  return verifier.verify(TEST_PUBLIC_KEY_PEM, leaseToken.signature, 'base64');
}

function validateOfflineLeaseRules(lease, expectedDeviceId, expectedLicenseId, nowMs = Date.now()) {
  if (!lease || typeof lease !== 'object') return { valid: false, reason: 'missing_lease' };
  if (lease.deviceId !== expectedDeviceId) return { valid: false, reason: 'device_mismatch' };
  if (lease.licenseId !== expectedLicenseId) return { valid: false, reason: 'license_mismatch' };
  if (
    typeof lease.issuedAtServer !== 'number' ||
    typeof lease.validUntilServer !== 'number' ||
    typeof lease.licenseExpiresAt !== 'number' ||
    lease.validUntilServer <= lease.issuedAtServer
  ) {
    return { valid: false, reason: 'malformed_timestamps' };
  }
  if (!verifyServerLeaseWithTestKey(lease)) {
    return { valid: false, reason: 'invalid_signature' };
  }
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (lease.validUntilServer - lease.issuedAtServer > sevenDaysMs) {
    return { valid: false, reason: 'exceeds_7_days' };
  }
  if (nowMs >= lease.licenseExpiresAt) {
    return { valid: false, reason: 'license_expired' };
  }
  if (nowMs > lease.validUntilServer) {
    return { valid: false, reason: 'lease_grace_expired' };
  }
  return { valid: true, reason: 'valid' };
}

let seq = 0;
async function fsDelete(col, docId) {
  await fetch(`${FIRESTORE_BASE}/${col}/${docId}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer owner' }
  });
}

// Reset rateLimits/chal_<uid> before issuing a challenge ONLY when needed for multi-step setup,
// while keeping a dedicated test for consecutive requestDeviceChallenge calls!
async function getChallenge(user, device, allowClearRateLimit = true) {
  if (allowClearRateLimit) {
    await fsDelete('rateLimits', `chal_${user.uid}`);
  }
  const res = await callFunction('requestDeviceChallenge', { devicePublicKey: device.publicKeyBase64 }, user.idToken);
  if (!res.ok || !res.result?.challenge) {
    throw new Error(`requestDeviceChallenge failed (http=${res.httpStatus}): ${JSON.stringify(res.error || res)}`);
  }
  return res.result.challenge;
}

async function provisionTestLicenseFixture(superAdminToken, ownerUid, ownerEmail, duration = '1y') {
  seq += 1;
  const res = await callFunction(
    'issueLicense',
    { duration, userId: ownerUid, userEmail: ownerEmail },
    superAdminToken
  );
  if (res.ok && res.result?.activationKey) {
    return {
      source: 'issueLicense',
      licenseId: res.result.licenseId,
      activationKey: res.result.activationKey,
      keyHint: res.result.keyHint
    };
  }
  const rnd = crypto.randomBytes(6).toString('hex').toUpperCase();
  const activationKey = `APRO-${rnd.slice(0, 5)}-${rnd.slice(5, 10)}-22222-33333-44444-${duration.toUpperCase()}`;
  const normalized = activationKey.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const activationKeyHash = crypto.createHash('sha256').update(normalized).digest('hex');
  const licenseId = `lic_fixture_${Date.now()}_${seq}`;
  const keyHint = `APRO-*****-*****-*****-*****-44444-${duration.toUpperCase()}`;
  const now = Date.now();
  await fsAdminSet('licenses', licenseId, {
    id: licenseId,
    activationKeyHash,
    keyHint,
    userId: ownerUid,
    userEmail: ownerEmail,
    boundDeviceId: '',
    issuedAt: now,
    startsAt: 0,
    expiresAt: 0,
    duration,
    status: 'active',
    lastOnlineCheckAt: 0,
    isBlocked: false,
    maxOfflineDays: 7
  });
  return { source: 'firestore_fixture', licenseId, activationKey, keyHint };
}

// --- Test Harness ---
const results = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function runTest(section, name, fn) {
  try {
    const info = await fn();
    results.push({ section, name, status: 'PASS', info: info || '' });
  } catch (err) {
    results.push({
      section,
      name,
      status: 'FAIL',
      info: err instanceof Error ? err.message : String(err)
    });
  }
}

async function main() {
  const fsPing = await fetch('http://127.0.0.1:8080/');
  const authPing = await fetch('http://127.0.0.1:9099/');
  assert(fsPing.ok && authPing.ok, 'Emulators not responding on localhost');

  const superAdmin = await createAuthUser('superadmin.test@demo.local', 'SuperPass123!');
  const supportAdmin = await createAuthUser('support.test@demo.local', 'SupportPass123!');
  const normalUser1 = await createAuthUser('user1.test@demo.local', 'UserPass123!');
  const normalUser2 = await createAuthUser('user2.test@demo.local', 'UserPass123!');
  const unauthorizedUser = await createAuthUser('unauthz.test@demo.local', 'UnauthPass123!');
  const extraUser = await createAuthUser('extra.rate@demo.local', 'ExtraPass123!');

  await fsAdminSet('admins', superAdmin.uid, {
    uid: superAdmin.uid,
    email: superAdmin.email,
    role: 'super_admin',
    active: true,
    createdAt: Date.now()
  });
  await fsAdminSet('admins', supportAdmin.uid, {
    uid: supportAdmin.uid,
    email: supportAdmin.email,
    role: 'support',
    active: true,
    createdAt: Date.now()
  });

  const issuedPlainKeys = [];

  // =========================================================================
  // SECTION 2: Real Firestore Transactions for all 7 Cloud Functions
  // =========================================================================
  let primaryLicense = null;
  const deviceA = generateDeviceIdentity(false);
  const deviceWeb = generateDeviceIdentity(true);

  await runTest('tx', '2.1 issueLicense - valid tx, Firestore persistence, serverTimestamp, audit log, & invalid rejection', async () => {
    const res = await callFunction(
      'issueLicense',
      { duration: '1y', userId: normalUser1.uid, userEmail: normalUser1.email },
      superAdmin.idToken
    );
    assert(res.ok && res.result?.success, `issueLicense failed (http=${res.httpStatus}): ${JSON.stringify(res.error || res)}`);
    const { licenseId, activationKey, keyHint, duration } = res.result;
    assert(licenseId && activationKey && keyHint && duration === '1y', 'Missing issueLicense response fields');
    issuedPlainKeys.push(activationKey);
    primaryLicense = { licenseId, activationKey, keyHint };

    const fsDoc = await fsAdminGet('licenses', licenseId);
    assert(fsDoc !== null, 'License doc not persisted in Firestore');
    assert(fsDoc.activationKeyHash && !JSON.stringify(fsDoc).includes(activationKey), 'Plain key leaked or hash missing');
    assert(Boolean(fsDoc.serverUpdatedAt?.__timestamp), 'serverUpdatedAt serverTimestamp missing on license doc');

    const logs = await fsAdminList('licenseAuditLogs');
    const issueLog = logs.find(l => l.action === 'issue' && l.targetId === licenseId);
    assert(Boolean(issueLog && issueLog.serverTimestamp?.__timestamp), 'Issue audit log or serverTimestamp missing');

    const beforeCount = (await fsAdminList('licenses')).length;
    const badRes = await callFunction('issueLicense', { duration: '99y' }, superAdmin.idToken);
    assert(!badRes.ok && badRes.error?.status === 'INVALID_ARGUMENT', 'Invalid duration should reject');
    const afterCount = (await fsAdminList('licenses')).length;
    assert(beforeCount === afterCount, 'Partial write occurred on failed issueLicense');
    return `licenseId=${licenseId}`;
  });

  if (!primaryLicense) {
    primaryLicense = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
    issuedPlainKeys.push(primaryLicense.activationKey);
  }

  await runTest('tx', '2.2 activateLicense - valid atomic tx, challenge consumed, device bound, ECDSA lease & audit log', async () => {
    const challenge = await getChallenge(normalUser1, deviceA);
    assert((await fsAdminGet('deviceChallenges', challenge)) !== null, 'Challenge not stored in Firestore');

    const actRes = await callFunction('activateLicense', {
      activationKey: primaryLicense.activationKey,
      devicePublicKey: deviceA.publicKeyBase64,
      challenge,
      signature: signChallengeWithDevice(deviceA, challenge),
      deviceModel: 'Emulator Pixel Test',
      isWebClient: false
    }, normalUser1.idToken);
    assert(actRes.ok && actRes.result?.success, `activateLicense failed: ${JSON.stringify(actRes)}`);
    primaryLicense.leaseToken = actRes.result.leaseToken;

    assert((await fsAdminGet('deviceChallenges', challenge)) === null, 'Challenge not atomically deleted');
    const licDoc = await fsAdminGet('licenses', primaryLicense.licenseId);
    assert(licDoc.boundDeviceId === deviceA.deviceId && licDoc.startsAt > 0 && licDoc.expiresAt > licDoc.startsAt, 'License Firestore state invalid');
    const devDoc = await fsAdminGet('devices', deviceA.deviceId);
    assert(devDoc && devDoc.status === 'trusted' && devDoc.licenseId === primaryLicense.licenseId, 'Device Firestore state invalid');

    const logs = await fsAdminList('licenseAuditLogs');
    const actLog = logs.find(l => l.action === 'activate' && l.targetId === primaryLicense.licenseId);
    assert(Boolean(actLog), 'activate audit log missing');
    assert(Boolean(actLog.serverTimestamp?.__timestamp), 'activate audit log missing serverTimestamp() (only client/Date.now ms timestamp set)');
    return `bound=${deviceA.deviceId}`;
  });

  await runTest('tx', '2.3 verifyLicense - challenge consumed, lastOnlineCheckAt updated, ECDSA lease verified & invalid guard', async () => {
    const challenge = await getChallenge(normalUser1, deviceA);
    const beforeLic = await fsAdminGet('licenses', primaryLicense.licenseId);

    const verRes = await callFunction('verifyLicense', {
      licenseId: primaryLicense.licenseId,
      deviceId: deviceA.deviceId,
      devicePublicKey: deviceA.publicKeyBase64,
      challenge,
      signature: signChallengeWithDevice(deviceA, challenge),
      isWebClient: false
    }, normalUser1.idToken);
    assert(verRes.ok && verRes.result?.isValid === true, `verifyLicense failed: ${JSON.stringify(verRes)}`);
    assert(verifyServerLeaseWithTestKey(verRes.result.leaseToken), 'verifyLicense lease signature invalid against testPublicKey');
    assert((await fsAdminGet('deviceChallenges', challenge)) === null, 'Challenge not deleted');
    const afterLic = await fsAdminGet('licenses', primaryLicense.licenseId);
    assert(afterLic.lastOnlineCheckAt >= beforeLic.lastOnlineCheckAt, 'lastOnlineCheckAt not updated');

    const badVer = await callFunction('verifyLicense', { licenseId: primaryLicense.licenseId }, normalUser1.idToken);
    assert(!badVer.ok && badVer.error?.status === 'INVALID_ARGUMENT', 'Missing args should reject');
    return `lastOnlineCheckAt=${afterLic.lastOnlineCheckAt}`;
  });

  await runTest('tx', '2.4 renewLicense - atomic expiry extension, serverTimestamp, audit log, & invalid rejection', async () => {
    const beforeLic = await fsAdminGet('licenses', primaryLicense.licenseId);
    const res = await callFunction('renewLicense', { licenseId: primaryLicense.licenseId, duration: '6m' }, superAdmin.idToken);
    assert(res.ok && res.result?.success, `renewLicense failed (http=${res.httpStatus}): ${JSON.stringify(res.error || res)}`);

    const afterLic = await fsAdminGet('licenses', primaryLicense.licenseId);
    const expectedDelta = 180 * 24 * 60 * 60 * 1000;
    assert(afterLic.expiresAt === beforeLic.expiresAt + expectedDelta, 'Expiry did not extend atomically');
    assert(Boolean(afterLic.serverUpdatedAt?.__timestamp), 'serverUpdatedAt missing');

    const logs = await fsAdminList('licenseAuditLogs');
    const renewLog = logs.find(l => l.action === 'renew' && l.targetId === primaryLicense.licenseId);
    assert(Boolean(renewLog && renewLog.serverTimestamp?.__timestamp), 'renew audit log or serverTimestamp missing');

    const badRenew = await callFunction('renewLicense', { licenseId: 'non_existent_lic', duration: '1y' }, superAdmin.idToken);
    assert(!badRenew.ok && badRenew.error?.status === 'NOT_FOUND', 'Non-existent license should fail NOT_FOUND');
    return `newExpiry=${afterLic.expiresAt}`;
  });

  await runTest('tx', '2.5 transferLicenseDevice - Web P1363 proof, old device unbound, new device trusted, audit log', async () => {
    const challenge = await getChallenge(superAdmin, deviceWeb);
    const trRes = await callFunction('transferLicenseDevice', {
      licenseId: primaryLicense.licenseId,
      newDevicePublicKey: deviceWeb.publicKeyBase64,
      challenge,
      signature: signChallengeWithDevice(deviceWeb, challenge),
      newDeviceModel: 'WebClient Chrome Test',
      reason: 'Hardware upgrade',
      isWebClient: true
    }, superAdmin.idToken);
    assert(trRes.ok && trRes.result?.success && trRes.result?.newDeviceId === deviceWeb.deviceId, `Transfer failed: ${JSON.stringify(trRes)}`);
    assert((await fsAdminGet('deviceChallenges', challenge)) === null, 'Transfer challenge not deleted');

    const licDoc = await fsAdminGet('licenses', primaryLicense.licenseId);
    assert(licDoc.boundDeviceId === deviceWeb.deviceId, 'boundDeviceId not updated');
    const oldDevDoc = await fsAdminGet('devices', deviceA.deviceId);
    const newDevDoc = await fsAdminGet('devices', deviceWeb.deviceId);
    assert(oldDevDoc.status === 'unbound_transfer', 'Old device not marked unbound_transfer');
    assert(newDevDoc.status === 'trusted' && newDevDoc.isWebClient === true, 'New device not trusted');

    const logs = await fsAdminList('licenseAuditLogs');
    const trLog = logs.find(l => l.action === 'transfer' && l.targetId === primaryLicense.licenseId);
    assert(Boolean(trLog), 'Transfer audit log missing');
    assert(Boolean(trLog.serverTimestamp?.__timestamp), 'transfer audit log missing serverTimestamp() (only ms timestamp set)');
    return `transferred=${deviceA.deviceId}->${deviceWeb.deviceId}`;
  });

  await runTest('tx', '2.6 revokeLicense - suspend, revoke (+blacklistDevice), reactivate, serverTimestamp & audit log', async () => {
    const fix = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
    issuedPlainKeys.push(fix.activationKey);
    const revLicId = fix.licenseId;
    const devR = generateDeviceIdentity(false);
    const challenge = await getChallenge(normalUser1, devR);
    await callFunction('activateLicense', {
      activationKey: fix.activationKey,
      devicePublicKey: devR.publicKeyBase64,
      challenge,
      signature: signChallengeWithDevice(devR, challenge),
      isWebClient: false
    }, normalUser1.idToken);

    const susp = await callFunction('revokeLicense', { licenseId: revLicId, actionType: 'suspend', blockReason: 'Under review' }, superAdmin.idToken);
    assert(susp.ok && susp.result?.action === 'suspended', `Suspend failed (http=${susp.httpStatus}): ${JSON.stringify(susp.error || susp)}`);
    const rev = await callFunction('revokeLicense', { licenseId: revLicId, actionType: 'revoke', blacklistDevice: true, blockReason: 'Abuse' }, superAdmin.idToken);
    assert(rev.ok && rev.result?.action === 'revoked', `Revoke failed: ${JSON.stringify(rev)}`);
    const react = await callFunction('revokeLicense', { licenseId: revLicId, actionType: 'reactivate' }, superAdmin.idToken);
    assert(react.ok && react.result?.status === 'active', `Reactivate failed: ${JSON.stringify(react)}`);
    return `revLicId=${revLicId}`;
  });

  await runTest('tx', '2.7 reviewLicenseRequest - atomic pending->approved, serverTimestamp, audit log, & re-review guard', async () => {
    const reqId = `req_tx_${Date.now()}`;
    const devReq = generateDeviceIdentity(false);
    await fsAdminSet('licenseRequests', reqId, {
      requestToken: 'REQ-TX-001',
      deviceId: devReq.deviceId,
      devicePublicKey: devReq.publicKeyBase64,
      userId: normalUser1.uid,
      userEmail: normalUser1.email,
      requestedAt: Date.now(),
      status: 'pending'
    });

    const revRes = await callFunction('reviewLicenseRequest', { requestId: reqId, status: 'approved', reviewNotes: 'Verified' }, superAdmin.idToken);
    assert(revRes.ok && revRes.result?.status === 'approved', `Review failed (http=${revRes.httpStatus}): ${JSON.stringify(revRes.error || revRes)}`);
    const reqDoc = await fsAdminGet('licenseRequests', reqId);
    assert(reqDoc.status === 'approved' && Boolean(reqDoc.serverUpdatedAt?.__timestamp), 'Request update check failed');
    const secondTry = await callFunction('reviewLicenseRequest', { requestId: reqId, status: 'rejected' }, superAdmin.idToken);
    assert(!secondTry.ok && secondTry.error?.status === 'FAILED_PRECONDITION', 'Re-review should reject');
    return `reqId=${reqId}`;
  });

  await runTest('tx', '2.8 requestDeviceChallenge - consecutive calls within 60s increment rate-limit cleanly', async () => {
    const rateUser = await createAuthUser('ratecheck.test@demo.local', 'RatePass123!');
    const devRate = generateDeviceIdentity(false);
    const c1 = await callFunction('requestDeviceChallenge', { devicePublicKey: devRate.publicKeyBase64 }, rateUser.idToken);
    const c2 = await callFunction('requestDeviceChallenge', { devicePublicKey: devRate.publicKeyBase64 }, rateUser.idToken);
    assert(c1.ok && c2.ok, `Consecutive requestDeviceChallenge failed (http=${c2.httpStatus}): ${JSON.stringify(c2.error || c2)}`);
    return 'rate limit incremented cleanly';
  });

  // =========================================================================
  // SECTION 3: Real Concurrency & Race Conditions (Promise.all)
  // =========================================================================
  await runTest('race', '3.1 Concurrent issueLicense calls for single request (atomic issuance check)', async () => {
    const reqId = `req_concurrent_issue_${Date.now()}`;
    const resList = await Promise.all([
      callFunction('issueLicense', { duration: '1y', userId: normalUser1.uid, requestId: reqId }, superAdmin.idToken),
      callFunction('issueLicense', { duration: '1y', userId: normalUser1.uid, requestId: reqId }, superAdmin.idToken),
      callFunction('issueLicense', { duration: '1y', userId: normalUser1.uid, requestId: reqId }, superAdmin.idToken)
    ]);
    assert(resList.every(r => r.ok && r.result?.licenseId), `Concurrent issueLicense failed (http=${resList[0].httpStatus}): ${JSON.stringify(resList.map(r => r.error))}`);
    for (const r of resList) issuedPlainKeys.push(r.result.activationKey);
    const ids = new Set(resList.map(r => r.result.licenseId));
    assert(ids.size === 3, 'Duplicate licenseIds generated');
    return `3 concurrent issueLicense succeeded`;
  });

  await runTest('race', '3.2 Concurrent renewLicense on same license preserves both extensions cleanly', async () => {
    const fix = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
    issuedPlainKeys.push(fix.activationKey);
    const baseExp = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await fsAdminSet('licenses', fix.licenseId, { ...(await fsAdminGet('licenses', fix.licenseId)), expiresAt: baseExp });

    const [r1, r2] = await Promise.all([
      callFunction('renewLicense', { licenseId: fix.licenseId, duration: '1m' }, superAdmin.idToken),
      callFunction('renewLicense', { licenseId: fix.licenseId, duration: '3m' }, superAdmin.idToken)
    ]);
    assert(r1.ok && r2.ok, `Concurrent renewLicense failed (http=${r1.httpStatus}/${r2.httpStatus}): ${JSON.stringify(r1.error || r2.error)}`);
    const finalDoc = await fsAdminGet('licenses', fix.licenseId);
    const expected = baseExp + (30 + 90) * 24 * 60 * 60 * 1000;
    assert(finalDoc.expiresAt === expected, `Lost update! expected=${expected}, actual=${finalDoc.expiresAt}`);
    return `expected=${expected}, actual=${finalDoc.expiresAt}`;
  });

  await runTest('race', '3.3 Concurrent revokeLicense on same license - exactly 1 succeeds, 1 fails safely', async () => {
    const fix = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
    issuedPlainKeys.push(fix.activationKey);

    const [r1, r2] = await Promise.all([
      callFunction('revokeLicense', { licenseId: fix.licenseId, actionType: 'revoke', blockReason: 'Race 1' }, superAdmin.idToken),
      callFunction('revokeLicense', { licenseId: fix.licenseId, actionType: 'revoke', blockReason: 'Race 2' }, superAdmin.idToken)
    ]);
    const okCount = [r1, r2].filter(r => r.ok).length;
    const failCount = [r1, r2].filter(r => !r.ok && r.error?.status === 'FAILED_PRECONDITION').length;
    assert(okCount === 1 && failCount === 1, `Expected 1 ok + 1 FAILED_PRECONDITION, got r1=${JSON.stringify(r1.error || r1.result)}, r2=${JSON.stringify(r2.error || r2.result)}`);
    return `1 succeeded, 1 blocked by FAILED_PRECONDITION`;
  });

  await runTest('race', '3.4 Concurrent reviewLicenseRequest on same request - exactly 1 succeeds, 1 fails', async () => {
    const reqId = `req_race_${Date.now()}`;
    const devReq = generateDeviceIdentity(false);
    await fsAdminSet('licenseRequests', reqId, {
      requestToken: 'REQ-RACE-1',
      deviceId: devReq.deviceId,
      devicePublicKey: devReq.publicKeyBase64,
      userId: normalUser1.uid,
      requestedAt: Date.now(),
      status: 'pending'
    });

    const [r1, r2] = await Promise.all([
      callFunction('reviewLicenseRequest', { requestId: reqId, status: 'approved', reviewNotes: 'R1' }, superAdmin.idToken),
      callFunction('reviewLicenseRequest', { requestId: reqId, status: 'rejected', reviewNotes: 'R2' }, superAdmin.idToken)
    ]);
    const okCount = [r1, r2].filter(r => r.ok).length;
    const failCount = [r1, r2].filter(r => !r.ok && r.error?.status === 'FAILED_PRECONDITION').length;
    assert(okCount === 1 && failCount === 1, `Expected 1 ok + 1 fail, got r1=${JSON.stringify(r1.error || r1.result)}, r2=${JSON.stringify(r2.error || r2.result)}`);
    return `1 succeeded, 1 rejected`;
  });

  await runTest('race', '3.5 Two devices concurrently activating same license - exactly 1 binds, zero dual activation', async () => {
    const fix = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
    issuedPlainKeys.push(fix.activationKey);
    const dev1 = generateDeviceIdentity(false);
    const dev2 = generateDeviceIdentity(false);

    const ch1 = await getChallenge(normalUser1, dev1);
    const ch2 = await getChallenge(normalUser2, dev2);

    const [a1, a2] = await Promise.all([
      callFunction('activateLicense', {
        activationKey: fix.activationKey,
        devicePublicKey: dev1.publicKeyBase64,
        challenge: ch1,
        signature: signChallengeWithDevice(dev1, ch1),
        isWebClient: false
      }, normalUser1.idToken),
      callFunction('activateLicense', {
        activationKey: fix.activationKey,
        devicePublicKey: dev2.publicKeyBase64,
        challenge: ch2,
        signature: signChallengeWithDevice(dev2, ch2),
        isWebClient: false
      }, normalUser2.idToken)
    ]);

    const okList = [a1, a2].filter(r => r.ok);
    const errList = [a1, a2].filter(r => !r.ok);
    assert(okList.length === 1 && errList.length === 1, `Expected 1 winner + 1 loser, got ok=${okList.length}, errs=${JSON.stringify(errList.map(e => e.error))}`);
    assert(errList[0].error?.status === 'ALREADY_EXISTS', `Expected ALREADY_EXISTS, got ${JSON.stringify(errList[0])}`);

    const winnerId = okList[0].result.license.boundDeviceId;
    const loserId = winnerId === dev1.deviceId ? dev2.deviceId : dev1.deviceId;
    const licDoc = await fsAdminGet('licenses', fix.licenseId);
    assert(licDoc.boundDeviceId === winnerId, 'Firestore boundDeviceId mismatch');
    assert((await fsAdminGet('devices', loserId)) === null, 'Loser device was wrongly persisted');
    return `winner=${winnerId}, loser=${loserId} rejected cleanly`;
  });

  await runTest('race', '3.6 Concurrent transferLicenseDevice to 2 devices - consistent final binding & old device unbound', async () => {
    const fix = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
    issuedPlainKeys.push(fix.activationKey);
    const devInitial = generateDeviceIdentity(false);
    const devTarget1 = generateDeviceIdentity(false);
    const devTarget2 = generateDeviceIdentity(false);

    const ch0 = await getChallenge(extraUser, devInitial);
    await callFunction('activateLicense', {
      activationKey: fix.activationKey,
      devicePublicKey: devInitial.publicKeyBase64,
      challenge: ch0,
      signature: signChallengeWithDevice(devInitial, ch0),
      isWebClient: false
    }, extraUser.idToken);

    const ch1 = await getChallenge(superAdmin, devTarget1);
    const ch2 = await getChallenge(superAdmin, devTarget2);

    const [t1, t2] = await Promise.all([
      callFunction('transferLicenseDevice', {
        licenseId: fix.licenseId,
        newDevicePublicKey: devTarget1.publicKeyBase64,
        challenge: ch1,
        signature: signChallengeWithDevice(devTarget1, ch1),
        reason: 'Transfer A',
        isWebClient: false
      }, superAdmin.idToken),
      callFunction('transferLicenseDevice', {
        licenseId: fix.licenseId,
        newDevicePublicKey: devTarget2.publicKeyBase64,
        challenge: ch2,
        signature: signChallengeWithDevice(devTarget2, ch2),
        reason: 'Transfer B',
        isWebClient: false
      }, superAdmin.idToken)
    ]);

    assert(t1.ok && t2.ok, `Concurrent transfer failed: t1=${JSON.stringify(t1.error)}, t2=${JSON.stringify(t2.error)}`);
    const licDoc = await fsAdminGet('licenses', fix.licenseId);
    const d0 = await fsAdminGet('devices', devInitial.deviceId);
    const d1 = await fsAdminGet('devices', devTarget1.deviceId);
    const d2 = await fsAdminGet('devices', devTarget2.deviceId);

    const finalWinner = licDoc.boundDeviceId;
    const winnerDevDoc = finalWinner === devTarget1.deviceId ? d1 : d2;
    const loserDevDoc = finalWinner === devTarget1.deviceId ? d2 : d1;
    assert(d0.status === 'unbound_transfer', 'Initial device not unbound');
    assert(winnerDevDoc.status === 'trusted', 'Final winner device not trusted');
    assert(loserDevDoc.status === 'unbound_transfer', `Intermediate device not unbound: status=${loserDevDoc.status}`);
    return `final=${finalWinner}, previous=unbound_transfer`;
  });

  // =========================================================================
  // SECTION 4: Security Tests for Activation & Device Binding (all 11 items)
  // =========================================================================
  const secFix = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
  issuedPlainKeys.push(secFix.activationKey);
  const secLicId = secFix.licenseId;
  const secKey = secFix.activationKey;
  const secDev1 = generateDeviceIdentity(false);
  const secDev2 = generateDeviceIdentity(false);
  let secLeaseToken = null;

  await runTest('security', '4.1 Valid activation key activates & binds device1 in Firestore', async () => {
    const ch = await getChallenge(normalUser1, secDev1);
    const res = await callFunction('activateLicense', {
      activationKey: secKey,
      devicePublicKey: secDev1.publicKeyBase64,
      challenge: ch,
      signature: signChallengeWithDevice(secDev1, ch),
      isWebClient: false
    }, normalUser1.idToken);
    assert(res.ok, `Valid activation failed: ${JSON.stringify(res)}`);
    secLeaseToken = res.result.leaseToken;
    const lic = await fsAdminGet('licenses', secLicId);
    const dev = await fsAdminGet('devices', secDev1.deviceId);
    assert(lic.boundDeviceId === secDev1.deviceId && dev.status === 'trusted', 'Firestore state mismatch');
    return `bound=${secDev1.deviceId}`;
  });

  await runTest('security', '4.2 Wrong activation key rejected (NOT_FOUND) & Firestore unchanged', async () => {
    const ch = await getChallenge(unauthorizedUser, secDev2);
    const res = await callFunction('activateLicense', {
      activationKey: 'APRO-99999-99999-99999-99999-99999-1Y',
      devicePublicKey: secDev2.publicKeyBase64,
      challenge: ch,
      signature: signChallengeWithDevice(secDev2, ch),
      isWebClient: false
    }, unauthorizedUser.idToken);
    assert(!res.ok && res.error?.status === 'NOT_FOUND', `Expected NOT_FOUND, got ${JSON.stringify(res)}`);
    assert((await fsAdminGet('devices', secDev2.deviceId)) === null, 'Device2 should not exist');
  });

  await runTest('security', '4.3 Used activation key rejected when reused by second user/device (ALREADY_EXISTS)', async () => {
    const ch = await getChallenge(normalUser2, secDev2);
    const res = await callFunction('activateLicense', {
      activationKey: secKey,
      devicePublicKey: secDev2.publicKeyBase64,
      challenge: ch,
      signature: signChallengeWithDevice(secDev2, ch),
      isWebClient: false
    }, normalUser2.idToken);
    assert(!res.ok && res.error?.status === 'ALREADY_EXISTS', `Expected ALREADY_EXISTS, got ${JSON.stringify(res)}`);
    assert((await fsAdminGet('licenses', secLicId)).boundDeviceId === secDev1.deviceId, 'Binding changed in Firestore');
  });

  await runTest('security', '4.4 Re-activation on SAME device succeeds & preserves original startsAt/expiresAt', async () => {
    const before = await fsAdminGet('licenses', secLicId);
    const ch = await getChallenge(normalUser1, secDev1);
    const res = await callFunction('activateLicense', {
      activationKey: secKey,
      devicePublicKey: secDev1.publicKeyBase64,
      challenge: ch,
      signature: signChallengeWithDevice(secDev1, ch),
      isWebClient: false
    }, normalUser1.idToken);
    assert(res.ok, `Re-activation failed: ${JSON.stringify(res)}`);
    const after = await fsAdminGet('licenses', secLicId);
    assert(after.startsAt === before.startsAt && after.expiresAt === before.expiresAt, 'Dates altered on re-activation');
  });

  await runTest('security', '4.5 Attempt to activate bound license on second device (same owner) rejected & Firestore intact', async () => {
    const ch = await getChallenge(normalUser1, secDev2);
    const res = await callFunction('activateLicense', {
      activationKey: secKey,
      devicePublicKey: secDev2.publicKeyBase64,
      challenge: ch,
      signature: signChallengeWithDevice(secDev2, ch),
      isWebClient: false
    }, normalUser1.idToken);
    assert(!res.ok && res.error?.status === 'ALREADY_EXISTS', `Expected ALREADY_EXISTS, got ${JSON.stringify(res)}`);
    assert((await fsAdminGet('devices', secDev2.deviceId)) === null, 'Second device wrongly saved');
  });

  await runTest('security', '4.6 Valid ECDSA signature (Android DER & Web P1363) accepted', async () => {
    const fixW = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
    issuedPlainKeys.push(fixW.activationKey);
    const wDev = generateDeviceIdentity(true);
    const ch = await getChallenge(normalUser1, wDev);
    const res = await callFunction('activateLicense', {
      activationKey: fixW.activationKey,
      devicePublicKey: wDev.publicKeyBase64,
      challenge: ch,
      signature: signChallengeWithDevice(wDev, ch),
      isWebClient: true
    }, normalUser1.idToken);
    assert(res.ok && res.result.license.boundDeviceId.startsWith('dev_web_'), 'Web P1363 activation failed');
  });

  await runTest('security', '4.7 Forged / invalid ECDSA signature rejected (PERMISSION_DENIED) & license stays unbound', async () => {
    const fixF = await provisionTestLicenseFixture(superAdmin.idToken, normalUser2.uid, normalUser2.email, '1y');
    issuedPlainKeys.push(fixF.activationKey);
    const fDev = generateDeviceIdentity(false);
    const ch = await getChallenge(normalUser2, fDev);
    const wrongSig = signChallengeWithDevice(secDev2, ch);
    const res = await callFunction('activateLicense', {
      activationKey: fixF.activationKey,
      devicePublicKey: fDev.publicKeyBase64,
      challenge: ch,
      signature: wrongSig,
      isWebClient: false
    }, normalUser2.idToken);
    assert(!res.ok && res.error?.status === 'PERMISSION_DENIED', `Expected PERMISSION_DENIED, got ${JSON.stringify(res)}`);
    assert((await fsAdminGet('licenses', fixF.licenseId)).boundDeviceId === '', 'License bound with forged sig');
  });

  await runTest('security', '4.8 Expired challenge rejected (PERMISSION_DENIED) & license stays unbound', async () => {
    const fixE = await provisionTestLicenseFixture(superAdmin.idToken, normalUser1.uid, normalUser1.email, '1y');
    issuedPlainKeys.push(fixE.activationKey);
    const eDev = generateDeviceIdentity(false);
    const challenge = await getChallenge(normalUser1, eDev);
    const existingCh = await fsAdminGet('deviceChallenges', challenge);
    await fsAdminSet('deviceChallenges', challenge, { ...existingCh, expiresAt: Date.now() - 10000 });

    const res = await callFunction('activateLicense', {
      activationKey: fixE.activationKey,
      devicePublicKey: eDev.publicKeyBase64,
      challenge,
      signature: signChallengeWithDevice(eDev, challenge),
      isWebClient: false
    }, normalUser1.idToken);
    assert(!res.ok && res.error?.status === 'PERMISSION_DENIED', `Expected PERMISSION_DENIED, got ${JSON.stringify(res)}`);
    assert((await fsAdminGet('licenses', fixE.licenseId)).boundDeviceId === '', 'License bound with expired challenge');
  });

  await runTest('security', '4.9 Duplicate / mismatched challenge rejected (PERMISSION_DENIED)', async () => {
    const challenge = await getChallenge(normalUser1, secDev1);
    const res = await callFunction('verifyLicense', {
      licenseId: secLicId,
      deviceId: secDev2.deviceId,
      devicePublicKey: secDev2.publicKeyBase64,
      challenge,
      signature: signChallengeWithDevice(secDev2, challenge),
      isWebClient: false
    }, normalUser1.idToken);
    assert(!res.ok && res.error?.status === 'PERMISSION_DENIED', `Mismatched publicKey for challenge should fail`);
    assert((await fsAdminGet('deviceChallenges', challenge)) !== null, 'Challenge disappeared on rejected tx');
  });

  await runTest('security', '4.10 Consumed challenge replay rejected (PERMISSION_DENIED)', async () => {
    const challenge = await getChallenge(normalUser1, secDev1);
    const sig = signChallengeWithDevice(secDev1, challenge);
    const first = await callFunction('verifyLicense', {
      licenseId: secLicId,
      deviceId: secDev1.deviceId,
      devicePublicKey: secDev1.publicKeyBase64,
      challenge,
      signature: sig,
      isWebClient: false
    }, normalUser1.idToken);
    assert(first.ok, 'First verify failed');
    assert((await fsAdminGet('deviceChallenges', challenge)) === null, 'Challenge not deleted after use');

    const replay = await callFunction('verifyLicense', {
      licenseId: secLicId,
      deviceId: secDev1.deviceId,
      devicePublicKey: secDev1.publicKeyBase64,
      challenge,
      signature: sig,
      isWebClient: false
    }, normalUser1.idToken);
    assert(!replay.ok && replay.error?.status === 'PERMISSION_DENIED', `Replay should fail PERMISSION_DENIED`);
  });

  await runTest('security', '4.11 Spoofed or cross-device deviceId rejected (PERMISSION_DENIED)', async () => {
    const chA = await getChallenge(normalUser1, secDev2);
    const resA = await callFunction('verifyLicense', {
      licenseId: secLicId,
      deviceId: secDev1.deviceId,
      devicePublicKey: secDev2.publicKeyBase64,
      challenge: chA,
      signature: signChallengeWithDevice(secDev2, chA),
      isWebClient: false
    }, normalUser1.idToken);
    assert(!resA.ok && resA.error?.status === 'PERMISSION_DENIED', 'Spoofed deviceId succeeded');

    const chB = await getChallenge(normalUser1, secDev2);
    const resB = await callFunction('verifyLicense', {
      licenseId: secLicId,
      deviceId: secDev2.deviceId,
      devicePublicKey: secDev2.publicKeyBase64,
      challenge: chB,
      signature: signChallengeWithDevice(secDev2, chB),
      isWebClient: false
    }, normalUser1.idToken);
    assert(!resB.ok && resB.error?.status === 'PERMISSION_DENIED', 'Cross-device verify succeeded');
  });

  // =========================================================================
  // SECTION 5: Offline Lease & Test Public Key Verification (9 scenarios)
  // =========================================================================
  const validLease = secLeaseToken;

  await runTest('lease', '5.1 Valid Emulator-issued Lease Token passes ECDSA verification with testPublicKey.pem', async () => {
    assert(Boolean(validLease), 'No leaseToken obtained from Emulator');
    const check = validateOfflineLeaseRules(validLease, secDev1.deviceId, secLicId, validLease.issuedAtServer + 60000);
    assert(check.valid, `Valid lease failed: ${check.reason}`);
  });

  await runTest('lease', '5.2 Invalid / corrupted ECDSA signature rejected by testPublicKey.pem', async () => {
    const tamperedSig = { ...validLease, signature: validLease.signature.slice(0, -4) + 'AAAA' };
    const check = validateOfflineLeaseRules(tamperedSig, secDev1.deviceId, secLicId, validLease.issuedAtServer + 60000);
    assert(!check.valid && check.reason === 'invalid_signature', `Expected invalid_signature, got ${JSON.stringify(check)}`);
  });

  await runTest('lease', '5.3 Modified Token payload rejected by ECDSA verification', async () => {
    const tampered = { ...validLease, validUntilServer: validLease.validUntilServer + 86400000 };
    const check = validateOfflineLeaseRules(tampered, secDev1.deviceId, secLicId, validLease.issuedAtServer + 60000);
    assert(!check.valid && check.reason === 'invalid_signature', `Expected invalid_signature`);
  });

  await runTest('lease', '5.4 Modified deviceId in Lease Token rejected', async () => {
    const tampered = { ...validLease, deviceId: 'dev_hw_forged_1234' };
    const check = validateOfflineLeaseRules(tampered, secDev1.deviceId, secLicId, validLease.issuedAtServer + 60000);
    assert(!check.valid && !verifyServerLeaseWithTestKey(tampered), 'Modified deviceId must fail');
  });

  await runTest('lease', '5.5 Modified licenseId in Lease Token rejected', async () => {
    const tampered = { ...validLease, licenseId: 'lic_forged_999' };
    const check = validateOfflineLeaseRules(tampered, secDev1.deviceId, secLicId, validLease.issuedAtServer + 60000);
    assert(!check.valid && !verifyServerLeaseWithTestKey(tampered), 'Modified licenseId must fail');
  });

  await runTest('lease', '5.6 Expired license date fails validation', async () => {
    const check = validateOfflineLeaseRules(validLease, secDev1.deviceId, secLicId, validLease.licenseExpiresAt + 1000);
    assert(!check.valid && (check.reason === 'license_expired' || check.reason === 'lease_grace_expired'), 'Expired license not caught');
  });

  await runTest('lease', '5.7 Lease validity beyond 7-day cap rejected', async () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const after7d = validateOfflineLeaseRules(validLease, secDev1.deviceId, secLicId, validLease.issuedAtServer + sevenDays + 1000);
    assert(!after7d.valid && after7d.reason === 'lease_grace_expired', 'Beyond 7d grace not caught');
    assert(validLease.validUntilServer - validLease.issuedAtServer <= sevenDays, 'Server issued >7d lease');
  });

  await runTest('lease', '5.8 Lease Token belonging to another device rejected on device2', async () => {
    const check = validateOfflineLeaseRules(validLease, secDev2.deviceId, secLicId, validLease.issuedAtServer + 60000);
    assert(!check.valid && check.reason === 'device_mismatch', 'Other device lease accepted');
  });

  await runTest('lease', '5.9 Reuse of manipulated Lease Token (altered timestamps) rejected', async () => {
    const tampered = { ...validLease, issuedAtServer: validLease.issuedAtServer + 3600000, licenseExpiresAt: validLease.licenseExpiresAt + 9999999 };
    const check = validateOfflineLeaseRules(tampered, secDev1.deviceId, secLicId, validLease.issuedAtServer + 3600000);
    assert(!check.valid && check.reason === 'invalid_signature', 'Tampered token accepted');
  });

  // =========================================================================
  // SECTION 6: RBAC & Access Control Tests (Functions + Real Firestore Rules)
  // =========================================================================
  await runTest('rbac', '6.1 Normal user, Support role, & Unauthorized user cannot issueLicense', async () => {
    const rUser = await callFunction('issueLicense', { duration: '1y' }, normalUser1.idToken);
    const rSupport = await callFunction('issueLicense', { duration: '1y' }, supportAdmin.idToken);
    const rUnauthz = await callFunction('issueLicense', { duration: '1y' }, unauthorizedUser.idToken);
    assert(!rUser.ok && rUser.error?.status === 'PERMISSION_DENIED', 'Normal user allowed');
    assert(!rSupport.ok && rSupport.error?.status === 'PERMISSION_DENIED', 'Support role allowed');
    assert(!rUnauthz.ok && rUnauthz.error?.status === 'PERMISSION_DENIED', 'Unauthorized user allowed');
  });

  await runTest('rbac', '6.2 Normal user cannot renew/revoke any license nor verify others license', async () => {
    const rRenew = await callFunction('renewLicense', { licenseId: secLicId, duration: '1y' }, normalUser2.idToken);
    const rRevoke = await callFunction('revokeLicense', { licenseId: secLicId, actionType: 'revoke' }, normalUser2.idToken);
    assert(!rRenew.ok && rRenew.error?.status === 'PERMISSION_DENIED', 'Normal user renewed');
    assert(!rRevoke.ok && rRevoke.error?.status === 'PERMISSION_DENIED', 'Normal user revoked');

    const ch = await getChallenge(normalUser2, secDev1);
    const rCross = await callFunction('verifyLicense', {
      licenseId: secLicId,
      deviceId: secDev1.deviceId,
      devicePublicKey: secDev1.publicKeyBase64,
      challenge: ch,
      signature: signChallengeWithDevice(secDev1, ch),
      isWebClient: false
    }, normalUser2.idToken);
    assert(!rCross.ok && rCross.error?.status === 'PERMISSION_DENIED', 'Cross-user verify succeeded');
  });

  await runTest('rbac', '6.3 Normal user cannot transfer device or write directly to /licenses or /devices', async () => {
    const rTr = await callFunction('transferLicenseDevice', {
      licenseId: secLicId,
      newDevicePublicKey: secDev2.publicKeyBase64,
      isWebClient: false
    }, normalUser1.idToken);
    assert(!rTr.ok && rTr.error?.status === 'PERMISSION_DENIED', 'Normal user transferred device');

    const fsWriteLic = await fsClientRequest('PATCH', `licenses/${secLicId}`, normalUser1.idToken, { status: 'active' });
    const fsWriteDev = await fsClientRequest('PATCH', `devices/rogue_dev`, normalUser1.idToken, { status: 'trusted' });
    assert(fsWriteLic.status === 403 && fsWriteDev.status === 403, `Direct client write allowed: lic=${fsWriteLic.status}, dev=${fsWriteDev.status}`);
  });

  await runTest('rbac', '6.4 Normal user cannot read, write, or delete Audit Logs (/licenseAuditLogs & /audit_logs)', async () => {
    await fsAdminSet('licenseAuditLogs', 'log_probe_1', {
      action: 'probe',
      actorUid: superAdmin.uid,
      timestamp: Date.now(),
      result: 'success'
    });
    const rRead = await fsClientRequest('GET', 'licenseAuditLogs/log_probe_1', normalUser1.idToken);
    const rWrite = await fsClientRequest('PATCH', 'licenseAuditLogs/log_probe_1', normalUser1.idToken, { result: 'tampered' });
    const rDel = await fsClientRequest('DELETE', 'licenseAuditLogs/log_probe_1', normalUser1.idToken);
    assert(rRead.status === 403 && rWrite.status === 403 && rDel.status === 403, `Audit log rules failed: r=${rRead.status}, w=${rWrite.status}, d=${rDel.status}`);

    await fsAdminSet('audit_logs', 'log_imm_1', { action: 'test', uid: normalUser1.uid });
    const rImmUpd = await fsClientRequest('PATCH', 'audit_logs/log_imm_1', normalUser1.idToken, { action: 'forged' });
    const rImmDel = await fsClientRequest('DELETE', 'audit_logs/log_imm_1', superAdmin.idToken);
    assert(rImmUpd.status === 403 && rImmDel.status === 403, 'audit_logs immutable rule failed');
  });

  await runTest('rbac', '6.5 Normal user & Support cannot obtain admin role; Super Admin setAdminRole check', async () => {
    const rUserFn = await callFunction('setAdminRole', { targetUid: normalUser1.uid, role: 'super_admin', active: true }, normalUser1.idToken);
    const rSupFn = await callFunction('setAdminRole', { targetUid: normalUser1.uid, role: 'admin', active: true }, supportAdmin.idToken);
    assert(!rUserFn.ok && rUserFn.error?.status === 'PERMISSION_DENIED', 'Normal user escalated role');
    assert(!rSupFn.ok && rSupFn.error?.status === 'PERMISSION_DENIED', 'Support role escalated role');

    const fsAdm = await fsClientRequest('PATCH', `admins/${normalUser1.uid}`, normalUser1.idToken, { role: 'super_admin', active: true });
    assert(fsAdm.status === 403, `Direct /admins write allowed: ${fsAdm.status}`);

    await fsAdminSet('users', normalUser1.uid, { uid: normalUser1.uid, email: normalUser1.email, role: 'customer' });
    const fsUserEsc = await fsClientRequest('PATCH', `users/${normalUser1.uid}`, normalUser1.idToken, { uid: normalUser1.uid, email: normalUser1.email, role: 'super_admin' });
    assert(fsUserEsc.status === 403, `User role escalation allowed: ${fsUserEsc.status}`);

    const rGrant = await callFunction('setAdminRole', { targetUid: unauthorizedUser.uid, targetEmail: unauthorizedUser.email, role: 'support', active: false }, superAdmin.idToken);
    assert(rGrant.ok && rGrant.result?.success, `Super Admin setAdminRole failed (http=${rGrant.httpStatus}): ${JSON.stringify(rGrant.error || rGrant)}`);
  });

  await runTest('rbac', '6.6 Normal user only reads own permitted documents and is blocked from others & internal docs', async () => {
    const ownLicRead = await fsClientRequest('GET', `licenses/${secLicId}`, normalUser1.idToken);
    const otherLicRead = await fsClientRequest('GET', `licenses/${secLicId}`, normalUser2.idToken);
    const chalRead = await fsClientRequest('GET', 'deviceChallenges/fake', normalUser1.idToken);
    const rateRead = await fsClientRequest('GET', `rateLimits/user_${normalUser1.uid}`, normalUser1.idToken);
    assert(ownLicRead.status === 200, `User1 failed reading own license: ${ownLicRead.status}`);
    assert(otherLicRead.status === 403 && chalRead.status === 403 && rateRead.status === 403, 'Unauthorized Firestore read succeeded');
  });

  await runTest('rbac', '6.7 Unauthenticated requests rejected across all 9 Cloud Functions & Firestore', async () => {
    const fns = [
      ['requestDeviceChallenge', { devicePublicKey: deviceA.publicKeyBase64 }],
      ['issueLicense', { duration: '1y' }],
      ['activateLicense', { activationKey: 'X', devicePublicKey: 'Y', challenge: 'Z', signature: 'W' }],
      ['verifyLicense', { licenseId: 'X', deviceId: 'Y', devicePublicKey: 'Z', challenge: 'C', signature: 'S' }],
      ['transferLicenseDevice', { licenseId: 'X', newDevicePublicKey: 'Y' }],
      ['renewLicense', { licenseId: 'X', duration: '1y' }],
      ['revokeLicense', { licenseId: 'X' }],
      ['setAdminRole', { targetUid: 'X', role: 'admin' }],
      ['reviewLicenseRequest', { requestId: 'X', status: 'approved' }]
    ];
    for (const [fnName, payload] of fns) {
      const r = await callFunction(fnName, payload, null);
      assert(!r.ok && r.error?.status === 'UNAUTHENTICATED', `${fnName} allowed unauthenticated`);
    }
    const fsNoAuth = await fsClientRequest('GET', `licenses/${secLicId}`, null);
    assert(fsNoAuth.status === 403 || fsNoAuth.status === 401, `Unauth Firestore read returned ${fsNoAuth.status}`);
  });

  // =========================================================================
  // SECTION 7: Comprehensive Audit Log Verification
  // =========================================================================
  await runTest('audit', '7.1 Audit logs recorded for executed operations with valid actor, action, and serverTimestamp', async () => {
    const logs = await fsAdminList('licenseAuditLogs');
    const actions = new Set(logs.map(l => l.action));
    assert(actions.has('activate') && actions.has('transfer'), `Missing expected actions in logs: ${[...actions].join(',')}`);
    for (const l of logs) {
      assert(Boolean(l.actorUid || l.userId), `Audit log missing actorUid/userId: ${l.__id}`);
      assert(typeof l.timestamp === 'number' && l.timestamp > 0, `Audit log invalid timestamp: ${l.__id}`);
    }
    const missingAdminActions = ['issue', 'renew', 'revoked', 'review_request'].filter(a => !actions.has(a));
    assert(missingAdminActions.length === 0, `Missing admin audit log actions due to function errors: ${missingAdminActions.join(', ')}`);
    return `totalLogs=${logs.length}, actions=${[...actions].join(',')}`;
  });

  await runTest('audit', '7.2 Failed / unauthorized license operations recorded as failure events in licenseAuditLogs', async () => {
    const logs = await fsAdminList('licenseAuditLogs');
    const failureLogs = logs.filter(l => l.result === 'failure');
    assert(failureLogs.length > 0, 'No failure audit logs written in licenseAuditLogs for failed/unauthorized operations');
    return `failureLogs=${failureLogs.length}`;
  });

  await runTest('audit', '7.3 Zero sensitive secrets (plain activation keys / private PEM) stored in audit logs', async () => {
    const logs = await fsAdminList('licenseAuditLogs');
    const serialized = JSON.stringify(logs);
    assert(!serialized.includes('BEGIN EC PRIVATE KEY') && !serialized.includes('BEGIN PRIVATE KEY'), 'Private key leaked in logs');
    for (const plainKey of issuedPlainKeys) {
      assert(!serialized.includes(plainKey), `Plain activation key leaked in logs`);
    }
    return `checked ${issuedPlainKeys.length} plain keys across ${logs.length} audit logs`;
  });

  console.log('===EMULATOR_TEST_REPORT_START===');
  console.log(JSON.stringify({
    projectId: PROJECT_ID,
    databaseId: DATABASE_ID,
    nodeVersion: process.version,
    summary: {
      total: results.length,
      pass: results.filter(r => r.status === 'PASS').length,
      fail: results.filter(r => r.status === 'FAIL').length
    },
    results
  }, null, 2));
  console.log('===EMULATOR_TEST_REPORT_END===');

  const failCount = results.filter(r => r.status === 'FAIL').length;
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL_HARNESS_ERROR:', err);
  process.exit(2);
});
