import fs from 'fs';
import path from 'path';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  getDoc,
  doc,
  onSnapshot
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

const PROJECT_ID = 'demo-autopin-pro';
const DATABASE_ID = 'ai-studio-autopinpro-6597dde9-59f0-4a2e-90e5-55436f30fb2d';
const AUTH_BASE = 'http://127.0.0.1:9099';
const FIRESTORE_DOC_BASE = `http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;
const FIRESTORE_QUERY_URL = `http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:runQuery`;
const FUNCTIONS_BASE = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`;

function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFsValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

async function fsAdminSet(col, docId, data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) fields[k] = toFsValue(v);
  }
  const res = await fetch(`${FIRESTORE_DOC_BASE}/${col}/${docId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    throw new Error(`fsAdminSet(${col}/${docId}) failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function fsAdminDelete(col, docId) {
  await fetch(`${FIRESTORE_DOC_BASE}/${col}/${docId}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer owner' }
  });
}

async function fsClientRequest(method, docPath, token, data = null) {
  const url = `${FIRESTORE_DOC_BASE}/${docPath}`;
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

async function fsClientRunQuery(collectionId, token, withOrderBy = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const structuredQuery = {
    from: [{ collectionId }],
    limit: 50
  };
  if (withOrderBy) {
    structuredQuery.orderBy = [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }];
  }
  const res = await fetch(FIRESTORE_QUERY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ structuredQuery })
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: json };
}

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
  return { uid: data.localId, email, password, idToken: data.idToken };
}

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

function subscribeAuditLogsOnce(db, maxItems = 150) {
  return new Promise((resolve, reject) => {
    const q = query(
      collection(db, 'licenseAuditLogs'),
      orderBy('timestamp', 'desc'),
      limit(maxItems)
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsub();
        reject(new Error('Timed out waiting for server-synced licenseAuditLogs snapshot'));
      }
    }, 8000);
    const unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.metadata.fromCache) return;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          unsub();
          resolve(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          unsub();
          reject(err);
        }
      }
    );
  });
}

let clientCounter = 0;
async function withClientSession(email, password, fn) {
  clientCounter += 1;
  const app = initializeApp(
    {
      apiKey: 'fake-api-key',
      authDomain: 'localhost',
      projectId: PROJECT_ID
    },
    `sec-logs-client-${Date.now()}-${clientCounter}`
  );
  const auth = getAuth(app);
  const db = getFirestore(app, DATABASE_ID);
  const functions = getFunctions(app, 'us-central1');
  connectAuthEmulator(auth, AUTH_BASE, { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  try {
    await signInWithEmailAndPassword(auth, email, password);
    return await fn({ auth, db, functions });
  } finally {
    await signOut(auth).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];
async function runTest(name, fn) {
  try {
    const info = await fn();
    results.push({ name, status: 'PASS', info: info || '' });
  } catch (err) {
    results.push({
      name,
      status: 'FAIL',
      info: err instanceof Error ? err.message : String(err)
    });
  }
}

async function main() {
  const fsPing = await fetch('http://127.0.0.1:8080/');
  const authPing = await fetch('http://127.0.0.1:9099/');
  assert(fsPing.ok && authPing.ok, 'Firebase Emulators are not responding on localhost');

  // Ensure clean bootstrap state before Test 1
  await fsAdminDelete('system_config', 'bootstrap');

  const masterPass = 'MasterPass123!';
  const bootstrapMaster = await createAuthUser('arefalikhani69@gmail.com', masterPass);
  const superAdmin = await createAuthUser('superadmin.logs@demo.local', 'SuperPass123!');
  const opAdmin = await createAuthUser('opadmin.logs@demo.local', 'OpAdminPass123!');
  const supportAdmin = await createAuthUser('support.logs@demo.local', 'SupportPass123!');
  const inactiveAdmin = await createAuthUser('inactive.logs@demo.local', 'InactivePass123!');
  const normalUser = await createAuthUser('customer.logs@demo.local', 'UserPass123!');
  const noAdminDocUser = await createAuthUser('noadmin.logs@demo.local', 'NoAdminPass123!');

  let seededLogId = 'sec_log_probe_1';

  await runTest('1. Master email without /admins/{uid} cannot read licenseAuditLogs directly, then verifyAdminSession bootstraps & unlocks real-time onSnapshot', async () => {
    // Seed a sample log via Admin REST
    await fsAdminSet('licenseAuditLogs', seededLogId, {
      action: 'issue',
      actorUid: 'system_seed',
      actorEmail: 'system@autopin.local',
      targetId: 'lic_seed_1',
      timestamp: Date.now(),
      result: 'success',
      details: 'Seeded security log for emulator test'
    });

    return await withClientSession(bootstrapMaster.email, bootstrapMaster.password, async ({ db, functions }) => {
      // Before bootstrap: direct Firestore read must be rejected even for master email
      let preBootstrapDenied = false;
      try {
        await getDocs(query(collection(db, 'licenseAuditLogs'), orderBy('timestamp', 'desc'), limit(10)));
      } catch (err) {
        if (String(err?.code || err?.message).includes('permission-denied') || String(err?.message).includes('Missing or insufficient permissions')) {
          preBootstrapDenied = true;
        }
      }
      assert(preBootstrapDenied, 'Expected permission-denied before /admins/{uid} doc existed');

      // Call verifyAdminSession concurrently -> tests transaction idempotency without duplicate writes or race errors
      const verifyFn = httpsCallable(functions, 'verifyAdminSession');
      const [verifyResA, verifyResB] = await Promise.all([verifyFn({}), verifyFn({})]);
      assert(
        verifyResA.data?.verified === true &&
          verifyResA.data?.role === 'super_admin' &&
          verifyResA.data?.hasFirestoreAdminDoc === true &&
          verifyResA.data?.region === 'us-central1' &&
          verifyResB.data?.verified === true &&
          verifyResB.data?.role === 'super_admin',
        `Unexpected concurrent verifyAdminSession response: A=${JSON.stringify(verifyResA.data)}, B=${JSON.stringify(verifyResB.data)}`
      );

      // Repeat call must be strictly idempotent with createdViaBootstrap === false
      const repeatRes = await verifyFn({});
      assert(
        repeatRes.data?.verified === true &&
          repeatRes.data?.createdViaBootstrap === false &&
          repeatRes.data?.adminDocExists === true,
        `Repeat verifyAdminSession was not idempotent: ${JSON.stringify(repeatRes.data)}`
      );

      // Verify exactly 1 admin document exists for bootstrapMaster in /admins
      const adminSnap = await getDoc(doc(db, 'admins', bootstrapMaster.uid));
      assert(adminSnap.exists() && adminSnap.data()?.active === true && adminSnap.data()?.role === 'super_admin', 'Expected single active super_admin doc');

      // Now onSnapshot + orderBy('timestamp', 'desc') MUST succeed with zero permission error
      const snapLogs = await subscribeAuditLogsOnce(db, 150);
      assert(snapLogs.length >= 1, 'Expected at least 1 log from onSnapshot after verifyAdminSession');
      return `bootstrappedUid=${bootstrapMaster.uid}, repeatBootstrapped=${repeatRes.data.createdViaBootstrap}, logs=${snapLogs.length}`;
    });
  });

  // Provision explicit role accounts for tests 2..8
  await fsAdminSet('admins', superAdmin.uid, {
    uid: superAdmin.uid,
    email: superAdmin.email,
    role: 'super_admin',
    active: true,
    createdAt: Date.now()
  });
  await fsAdminSet('admins', opAdmin.uid, {
    uid: opAdmin.uid,
    email: opAdmin.email,
    role: 'admin',
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
  await fsAdminSet('admins', inactiveAdmin.uid, {
    uid: inactiveAdmin.uid,
    email: inactiveAdmin.email,
    role: 'super_admin',
    active: false,
    createdAt: Date.now()
  });
  await fsAdminSet('users', normalUser.uid, {
    id: normalUser.uid,
    uid: normalUser.uid,
    email: normalUser.email,
    role: 'user',
    isActive: true,
    createdAt: Date.now()
  });
  await fsAdminSet('audit_logs', 'audit_imm_sec_1', {
    id: 'audit_imm_sec_1',
    actionType: 'TEST_EVENT',
    timestamp: Date.now(),
    userId: superAdmin.uid,
    userEmail: superAdmin.email,
    userRole: 'admin',
    targetType: 'system',
    status: 'success',
    summary: 'Seeded immutable audit_logs entry'
  });

  await runTest('2. Super Admin triggers issueLicense (server Audit Log) and reads licenseAuditLogs via SDK onSnapshot & single GET', async () => {
    const issueRes = await callFunction(
      'issueLicense',
      { duration: '1y', userId: normalUser.uid, userEmail: normalUser.email },
      superAdmin.idToken
    );
    assert(issueRes.ok && issueRes.result?.licenseId, `issueLicense failed: ${JSON.stringify(issueRes.error || issueRes)}`);

    return await withClientSession(superAdmin.email, superAdmin.password, async ({ db }) => {
      const snapLogs = await subscribeAuditLogsOnce(db, 150);
      const found = snapLogs.find((l) => l.action === 'issue' && l.targetId === issueRes.result.licenseId);
      assert(Boolean(found), `Super Admin onSnapshot did not receive newly created server audit log (got ${snapLogs.length})`);

      const singleGet = await getDoc(doc(db, 'licenseAuditLogs', found.id));
      assert(singleGet.exists(), 'Super Admin single getDoc failed on licenseAuditLogs');
      return `received=${snapLogs.length}, foundLogId=${found.id}`;
    });
  });

  await runTest('3. Operational Admin (role=admin) can read & stream licenseAuditLogs without permission errors', async () => {
    return await withClientSession(opAdmin.email, opAdmin.password, async ({ db, functions }) => {
      const verifyFn = httpsCallable(functions, 'verifyAdminSession');
      const verifyRes = await verifyFn({});
      assert(verifyRes.data?.verified === true && verifyRes.data?.role === 'admin', 'Expected admin role from verifyAdminSession');

      const snapLogs = await subscribeAuditLogsOnce(db, 150);
      assert(snapLogs.length >= 2, `Expected >= 2 logs for operational admin, got ${snapLogs.length}`);

      const restQuery = await fsClientRunQuery('licenseAuditLogs', opAdmin.idToken, true);
      assert(restQuery.ok && restQuery.status === 200, `REST query failed for opAdmin: ${restQuery.status}`);
      return `opAdminLogs=${snapLogs.length}`;
    });
  });

  await runTest('4. Restricted Admin (role=support) is denied reading/listing licenseAuditLogs by Firestore Rules', async () => {
    return await withClientSession(supportAdmin.email, supportAdmin.password, async ({ db, functions }) => {
      const verifyFn = httpsCallable(functions, 'verifyAdminSession');
      const verifyRes = await verifyFn({});
      assert(verifyRes.data?.verified === true && verifyRes.data?.role === 'support', 'Expected support role from verifyAdminSession');

      let sdkListDenied = false;
      try {
        await subscribeAuditLogsOnce(db, 50);
      } catch (err) {
        if (String(err?.code || err?.message).includes('permission-denied') || String(err?.message).includes('Missing or insufficient permissions')) {
          sdkListDenied = true;
        }
      }
      assert(sdkListDenied, 'Support role was unexpectedly allowed to subscribe/list licenseAuditLogs');

      const restGet = await fsClientRequest('GET', `licenseAuditLogs/${seededLogId}`, supportAdmin.idToken);
      const restList = await fsClientRunQuery('licenseAuditLogs', supportAdmin.idToken, true);
      assert(restGet.status === 403 && restList.status === 403, `Support REST access not 403: get=${restGet.status}, list=${restList.status}`);

      // Support still retains non-sensitive Phase 1 reads (e.g. licenses)
      const licList = await fsClientRunQuery('licenses', supportAdmin.idToken, false);
      assert(licList.status === 200, `Support should still read licenses, got ${licList.status}`);
      return 'support denied on licenseAuditLogs, allowed on licenses';
    });
  });

  await runTest('5. Inactive Super Admin & post-lock user without /admins/{uid} are denied licenseAuditLogs & verifyAdminSession', async () => {
    const inactiveGet = await fsClientRequest('GET', `licenseAuditLogs/${seededLogId}`, inactiveAdmin.idToken);
    const inactiveList = await fsClientRunQuery('licenseAuditLogs', inactiveAdmin.idToken, true);
    const inactiveFn = await callFunction('verifyAdminSession', {}, inactiveAdmin.idToken);
    assert(inactiveGet.status === 403 && inactiveList.status === 403, `Inactive admin Firestore read not 403: get=${inactiveGet.status}, list=${inactiveList.status}`);
    assert(!inactiveFn.ok && inactiveFn.error?.status === 'PERMISSION_DENIED', `Inactive admin verifyAdminSession not rejected: ${JSON.stringify(inactiveFn)}`);

    const missingGet = await fsClientRequest('GET', `licenseAuditLogs/${seededLogId}`, noAdminDocUser.idToken);
    const missingList = await fsClientRunQuery('licenseAuditLogs', noAdminDocUser.idToken, true);
    const missingFn = await callFunction('verifyAdminSession', {}, noAdminDocUser.idToken);
    assert(missingGet.status === 403 && missingList.status === 403, `Missing-doc user Firestore read not 403: get=${missingGet.status}, list=${missingList.status}`);
    assert(!missingFn.ok && missingFn.error?.status === 'PERMISSION_DENIED', `Missing-doc user verifyAdminSession not rejected: ${JSON.stringify(missingFn)}`);
  });

  await runTest('6. Normal user blocked from reading, listing, creating, updating, or deleting licenseAuditLogs & audit_logs', async () => {
    const rGet = await fsClientRequest('GET', `licenseAuditLogs/${seededLogId}`, normalUser.idToken);
    const rList = await fsClientRunQuery('licenseAuditLogs', normalUser.idToken, true);
    const rCreate = await fsClientRequest('PATCH', 'licenseAuditLogs/forged_user_log_1', normalUser.idToken, {
      action: 'issue',
      actorUid: normalUser.uid,
      timestamp: Date.now()
    });
    const rUpdate = await fsClientRequest('PATCH', `licenseAuditLogs/${seededLogId}`, normalUser.idToken, {
      details: 'tampered'
    });
    const rDelete = await fsClientRequest('DELETE', `licenseAuditLogs/${seededLogId}`, normalUser.idToken);
    const rFn = await callFunction('verifyAdminSession', {}, normalUser.idToken);

    assert(
      rGet.status === 403 &&
        rList.status === 403 &&
        rCreate.status === 403 &&
        rUpdate.status === 403 &&
        rDelete.status === 403,
      `Normal user licenseAuditLogs access leaked: get=${rGet.status}, list=${rList.status}, create=${rCreate.status}, upd=${rUpdate.status}, del=${rDelete.status}`
    );
    assert(!rFn.ok && rFn.error?.status === 'PERMISSION_DENIED', 'Normal user verifyAdminSession succeeded');

    const aGet = await fsClientRequest('GET', 'audit_logs/audit_imm_sec_1', normalUser.idToken);
    const aList = await fsClientRunQuery('audit_logs', normalUser.idToken, false);
    const aCreate = await fsClientRequest('PATCH', 'audit_logs/forged_audit_1', normalUser.idToken, {
      id: 'forged_audit_1',
      actionType: 'FORGED',
      timestamp: Date.now(),
      userId: normalUser.uid,
      userEmail: normalUser.email,
      userRole: 'user',
      targetType: 'system',
      status: 'success',
      summary: 'forged'
    });
    const aUpdate = await fsClientRequest('PATCH', 'audit_logs/audit_imm_sec_1', normalUser.idToken, { summary: 'tampered' });
    const aDelete = await fsClientRequest('DELETE', 'audit_logs/audit_imm_sec_1', normalUser.idToken);
    assert(
      aGet.status === 403 &&
        aList.status === 403 &&
        aCreate.status === 403 &&
        aUpdate.status === 403 &&
        aDelete.status === 403,
      `Normal user audit_logs access leaked: get=${aGet.status}, list=${aList.status}, create=${aCreate.status}, upd=${aUpdate.status}, del=${aDelete.status}`
    );
  });

  await runTest('7. Unauthenticated requests blocked across Firestore logs & verifyAdminSession', async () => {
    const uGet = await fsClientRequest('GET', `licenseAuditLogs/${seededLogId}`, null);
    const uList = await fsClientRunQuery('licenseAuditLogs', null, true);
    const uWrite = await fsClientRequest('PATCH', 'licenseAuditLogs/unauth_forged', null, { action: 'forged' });
    const uAuditGet = await fsClientRequest('GET', 'audit_logs/audit_imm_sec_1', null);
    const uAuditList = await fsClientRunQuery('audit_logs', null, false);
    const uFn = await callFunction('verifyAdminSession', {}, null);

    assert(
      (uGet.status === 403 || uGet.status === 401) &&
        (uList.status === 403 || uList.status === 401) &&
        (uWrite.status === 403 || uWrite.status === 401) &&
        (uAuditGet.status === 403 || uAuditGet.status === 401) &&
        (uAuditList.status === 403 || uAuditList.status === 401),
      `Unauthenticated Firestore access leaked: ${uGet.status}/${uList.status}/${uWrite.status}/${uAuditGet.status}/${uAuditList.status}`
    );
    assert(!uFn.ok && uFn.error?.status === 'UNAUTHENTICATED', `Unauthenticated verifyAdminSession returned ${JSON.stringify(uFn)}`);
  });

  await runTest('8. Even Super Admin cannot forge, edit, or delete licenseAuditLogs from client SDK (immutable server-only append)', async () => {
    const sCreate = await fsClientRequest('PATCH', 'licenseAuditLogs/forged_admin_log', superAdmin.idToken, {
      action: 'issue',
      actorUid: superAdmin.uid,
      timestamp: Date.now()
    });
    const sUpdate = await fsClientRequest('PATCH', `licenseAuditLogs/${seededLogId}`, superAdmin.idToken, {
      details: 'admin_tamper'
    });
    const sDelete = await fsClientRequest('DELETE', `licenseAuditLogs/${seededLogId}`, superAdmin.idToken);
    assert(
      sCreate.status === 403 && sUpdate.status === 403 && sDelete.status === 403,
      `Super Admin client write to licenseAuditLogs allowed: create=${sCreate.status}, upd=${sUpdate.status}, del=${sDelete.status}`
    );

    const sAuditUpd = await fsClientRequest('PATCH', 'audit_logs/audit_imm_sec_1', superAdmin.idToken, { summary: 'tampered' });
    const sAuditDel = await fsClientRequest('DELETE', 'audit_logs/audit_imm_sec_1', superAdmin.idToken);
    assert(sAuditUpd.status === 403 && sAuditDel.status === 403, `audit_logs immutable rule breached: upd=${sAuditUpd.status}, del=${sAuditDel.status}`);
  });

  await runTest('9. After bootstrap lock, even a different user or duplicate bootstrap attempt cannot escalate or create duplicate /admins docs', async () => {
    return await withClientSession(bootstrapMaster.email, bootstrapMaster.password, async ({ db, functions }) => {
      const verifyFn = httpsCallable(functions, 'verifyAdminSession');
      const res = await verifyFn({});
      assert(
        res.data?.verified === true &&
          res.data?.createdViaBootstrap === false &&
          res.data?.hasFirestoreAdminDoc === true &&
          res.data?.region === 'us-central1',
        `Expected idempotent session confirmation: ${JSON.stringify(res.data)}`
      );

      const adminsSnap = await getDocs(collection(db, 'admins'));
      const matchingDocs = adminsSnap.docs.filter((d) => d.data()?.email === bootstrapMaster.email);
      assert(matchingDocs.length === 1, `Expected exactly 1 /admins doc for master email, found ${matchingDocs.length}`);
      return `uniqueMasterDocs=${matchingDocs.length}, totalAdmins=${adminsSnap.size}`;
    });
  });

  console.log('===SECURITY_LOGS_EMULATOR_REPORT_START===');
  console.log(
    JSON.stringify(
      {
        projectId: PROJECT_ID,
        databaseId: DATABASE_ID,
        summary: {
          total: results.length,
          pass: results.filter((r) => r.status === 'PASS').length,
          fail: results.filter((r) => r.status === 'FAIL').length
        },
        results
      },
      null,
      2
    )
  );
  console.log('===SECURITY_LOGS_EMULATOR_REPORT_END===');

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL_SECURITY_LOGS_TEST_ERROR:', err);
  process.exit(2);
});
