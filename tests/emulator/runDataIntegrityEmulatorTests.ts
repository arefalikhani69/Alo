/**
 * AutoPin Pro - Data Integrity Firebase Emulator Integration Tests (Scenarios 1-7)
 *
 * Connects directly to Firebase Auth & Firestore Emulators (project: demo-autopin-pro)
 * with active `firestore.rules` enforcement, testing real OnlineStorageService + StorageService:
 *  1. Initial Cloud Sync for ECUs (normal user status filtering + admin full sync)
 *  2. Initial Cloud Sync for WiringDiagrams
 *  3. Initial Cloud Sync for MediaItems (preserving fileUrl, storagePath, entityId, vehicleId)
 *  4. Sync failure / unauthenticated offline handling (local cache preserved, zero wipe)
 *  5. Reconnect sync: zero duplicates + preserves newer local updatedAt edits
 *  6. Cascade delete ECU in Cloud & Local (dependent connectors, exclusive media, parent vehicle.ecuIds cleanup)
 *  7. Shared media URL & unrelated connector protection in Cloud & Local + cloud-error local rollback safety
 */

import '../helpers/mockBrowserStorage';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator
} from 'firebase/firestore';
import { storage } from '../../src/services/storage';
import { OnlineStorageService } from '../../src/services/onlineStorage';
import type {
  Manufacturer,
  Vehicle,
  ECU,
  Connector,
  FuseBox,
  WiringDiagram,
  MediaItem
} from '../../src/types';

const PROJECT_ID = 'demo-autopin-pro';
const DATABASE_ID = 'ai-studio-autopinpro-6597dde9-59f0-4a2e-90e5-55436f30fb2d';
const FIRESTORE_REST_BASE = `http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;
const FIRESTORE_CLEAR_URL = `http://127.0.0.1:8080/emulator/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;
const AUTH_CLEAR_URL = `http://127.0.0.1:9099/emulator/v1/projects/${PROJECT_ID}/accounts`;

// --- Firestore Emulator Admin REST helpers (bypasses rules for test setup/assertions) ---
function toFsValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFsValue) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFsValue(v: any): unknown {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) {
      out[k] = fromFsValue(val);
    }
    return out;
  }
  return v;
}

async function fsAdminSet(col: string, docId: string, data: Record<string, unknown>): Promise<void> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) fields[k] = toFsValue(v);
  }
  const res = await fetch(`${FIRESTORE_REST_BASE}/${col}/${docId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    throw new Error(`fsAdminSet(${col}/${docId}) failed (${res.status}): ${await res.text()}`);
  }
}

async function fsAdminGet(col: string, docId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${FIRESTORE_REST_BASE}/${col}/${docId}`, {
    headers: { Authorization: 'Bearer owner' }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fsAdminGet(${col}/${docId}) failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json.fields || {})) {
    out[k] = fromFsValue(v);
  }
  return out;
}

async function clearEmulators(): Promise<void> {
  const fsRes = await fetch(FIRESTORE_CLEAR_URL, { method: 'DELETE' });
  if (!fsRes.ok) {
    throw new Error(`Failed clearing Firestore emulator (${fsRes.status})`);
  }
  const authRes = await fetch(AUTH_CLEAR_URL, { method: 'DELETE' });
  if (!authRes.ok) {
    throw new Error(`Failed clearing Auth emulator (${authRes.status})`);
  }
}

function uniqueIds<T extends { id: string }>(arr: T[]): boolean {
  const seen = new Set(arr.map(x => x.id));
  return seen.size === arr.length;
}

async function main() {
  console.log('='.repeat(72));
  console.log(' AutoPin Pro - Data Integrity Firebase Emulator Integration Suite');
  console.log(` Project: ${PROJECT_ID} | DB: ${DATABASE_ID}`);
  console.log('='.repeat(72));

  await clearEmulators();

  const emuApp = initializeApp(
    {
      apiKey: 'demo-autopin-api-key',
      authDomain: `${PROJECT_ID}.firebaseapp.com`,
      projectId: PROJECT_ID
    },
    `emu-data-integrity-${Date.now()}`
  );
  const emuDb = getFirestore(emuApp, DATABASE_ID);
  connectFirestoreEmulator(emuDb, '127.0.0.1', 8080);
  const emuAuth = getAuth(emuApp);
  connectAuthEmulator(emuAuth, 'http://127.0.0.1:9099', { disableWarnings: true });

  const cloud = new OnlineStorageService(emuDb);

  // Create regular user and admin user in Auth Emulator + /admins collection
  const userCred = await createUserWithEmailAndPassword(emuAuth, 'tech-user@autopin.test', 'TestPass!123');
  const normalUid = userCred.user.uid;
  const adminCred = await createUserWithEmailAndPassword(emuAuth, 'super-admin@autopin.test', 'AdminPass!123');
  const adminUid = adminCred.user.uid;

  await fsAdminSet('admins', adminUid, {
    uid: adminUid,
    email: 'super-admin@autopin.test',
    role: 'admin',
    active: true
  });

  // Seed Firestore Emulator technical collections directly via admin REST
  const manCloud: Manufacturer = {
    id: 'man-cloud-peugeot',
    name: 'پژو ابری',
    englishName: 'Peugeot Cloud',
    country: 'فرانسه',
    logoText: 'PEUGEOT',
    category: 'european',
    status: 'published'
  };
  await fsAdminSet('manufacturers', manCloud.id, manCloud as unknown as Record<string, unknown>);

  const vehCloudPub: Vehicle = {
    id: 'veh-emu-pub',
    manufacturerId: 'man-cloud-peugeot',
    name: 'پژو ۲۰۷ پانوراما ابری',
    persianName: 'پژو ۲۰۷ پانوراما ابری',
    generation: '۱۴۰۲',
    modelYears: '1400 - 1403',
    electricalSystem: 'EcoMux CAN',
    description: 'خودروی همگام‌سازی‌شده از ابر',
    engines: [
      {
        id: 'eng-tu5p',
        vehicleId: 'veh-emu-pub',
        code: 'TU5P',
        name: 'TU5 Plus',
        fuelSystem: 'MPI',
        valves: 16,
        displacementCc: 1587
      }
    ],
    ecuIds: ['ecu-emu-pub', 'ecu-emu-draft'],
    status: 'published',
    createdAt: 1000,
    updatedAt: 5000
  };
  await fsAdminSet('vehicles', vehCloudPub.id, vehCloudPub as unknown as Record<string, unknown>);

  const ecuPub: ECU = {
    id: 'ecu-emu-pub',
    vehicleId: 'veh-emu-pub',
    brand: 'کروز',
    model: 'EZ1-Pub',
    hardwareVersion: 'HW-10',
    softwareVersion: 'SW-20',
    connectorCount: 2,
    description: 'ECU منتشرشده در ابر',
    status: 'published'
  };
  const ecuDraft: ECU = {
    id: 'ecu-emu-draft',
    vehicleId: 'veh-emu-pub',
    brand: 'بوش',
    model: 'ME17-Draft',
    hardwareVersion: 'HW-D',
    softwareVersion: 'SW-D',
    connectorCount: 2,
    description: 'ECU پیش‌نویس فقط برای ادمین',
    status: 'draft'
  };
  await fsAdminSet('ecus', ecuPub.id, ecuPub as unknown as Record<string, unknown>);
  await fsAdminSet('ecus', ecuDraft.id, ecuDraft as unknown as Record<string, unknown>);

  const connPub: Connector = {
    id: 'conn-emu-pub',
    vehicleId: 'veh-emu-pub',
    ecuId: 'ecu-emu-pub',
    name: 'سوکت ۴۸ پایه EZ1',
    codeName: 'CH48',
    category: 'ecu',
    pinCount: 48,
    rows: 4,
    cols: 12,
    shape: 'grid',
    socketColor: 'مشکی',
    socketColorHex: '#18181b',
    source: 'Emulator Seed',
    status: 'published',
    pins: [],
    createdAt: 1000,
    updatedAt: 5000
  };
  await fsAdminSet('connectors', connPub.id, connPub as unknown as Record<string, unknown>);

  const fbPub: FuseBox = {
    id: 'fb-emu-pub',
    vehicleId: 'veh-emu-pub',
    name: 'جعبه فیوز UBP ابری',
    location: 'engine',
    locationFa: 'محفظه موتور',
    source: 'Emulator Seed',
    status: 'published',
    fuses: [],
    relays: []
  };
  await fsAdminSet('fuseBoxes', fbPub.id, fbPub as unknown as Record<string, unknown>);

  const diagPub: WiringDiagram = {
    id: 'diag-emu-pub',
    vehicleId: 'veh-emu-pub',
    title: 'نقشه سیستم انژکتور EZ1 ابری',
    category: 'injection_ignition',
    categoryFa: 'سیستم انژکتور و جرقه',
    diagramImageUrl: 'https://storage.googleapis.com/demo-bucket/diag-emu-pub.png',
    description: 'نقشه سیم‌کشی موتور TU5P',
    source: 'Emulator Seed',
    status: 'published',
    createdAt: 5000
  };
  const diagDraft: WiringDiagram = {
    id: 'diag-emu-draft',
    vehicleId: 'veh-emu-pub',
    title: 'نقشه پیش‌نویس ABS',
    category: 'abs_esp',
    categoryFa: 'ABS/ESP',
    diagramImageUrl: 'https://storage.googleapis.com/demo-bucket/diag-draft.png',
    description: 'فقط برای ادمین',
    source: 'Emulator Seed',
    status: 'draft',
    createdAt: 5100
  };
  await fsAdminSet('wiringDiagrams', diagPub.id, diagPub as unknown as Record<string, unknown>);
  await fsAdminSet('wiringDiagrams', diagDraft.id, diagDraft as unknown as Record<string, unknown>);

  const mediaPub: MediaItem = {
    id: 'media-emu-pub',
    title: 'نمای سوکت EZ1 در ابر',
    description: 'تصویر واقعی دسته سیم',
    fileUrl: 'https://storage.googleapis.com/demo-bucket/media-emu-pub.jpg',
    storagePath: 'technical_media/conn-emu-pub/media-emu-pub.jpg',
    mimeType: 'image/jpeg',
    fileSize: 45120,
    entityType: 'connector',
    entityId: 'conn-emu-pub',
    vehicleId: 'veh-emu-pub',
    imageType: 'socket_front',
    status: 'published',
    createdAt: 5000
  };
  await fsAdminSet('media', mediaPub.id, mediaPub as unknown as Record<string, unknown>);

  try {
    // ------------------------------------------------------------------
    // Scenario 1, 2, 3 (Part A): Normal User Initial Sync from Emulator
    // ------------------------------------------------------------------
    storage.resetToFactory();
    await signInWithEmailAndPassword(emuAuth, 'tech-user@autopin.test', 'TestPass!123');
    assert.equal(emuAuth.currentUser?.uid, normalUid);

    const userSyncRes = await cloud.syncAllTechnicalData(false, storage);
    assert.equal(userSyncRes.success, true, `Expected user sync success, failed: ${JSON.stringify(userSyncRes.failedCollections)}`);
    assert.equal(userSyncRes.failedCollections.length, 0);

    // Scenario 1 (User): Published ECU synced, Draft ECU NOT synced
    const ecusAfterUser = storage.getECUs();
    assert.ok(ecusAfterUser.some(e => e.id === 'ecu-emu-pub'), 'Scenario 1: Published ECU must sync to user');
    assert.ok(!ecusAfterUser.some(e => e.id === 'ecu-emu-draft'), 'Scenario 1: Draft ECU must not sync to non-admin');

    // Scenario 2 (User): Published wiringDiagram synced, Draft excluded
    const diagsAfterUser = storage.getWiringDiagrams();
    const syncedDiag = diagsAfterUser.find(d => d.id === 'diag-emu-pub');
    assert.ok(syncedDiag, 'Scenario 2: Published wiringDiagram must sync');
    assert.equal(syncedDiag.diagramImageUrl, diagPub.diagramImageUrl);
    assert.ok(!diagsAfterUser.some(d => d.id === 'diag-emu-draft'), 'Scenario 2: Draft wiringDiagram must not sync to non-admin');

    // Scenario 3 (User): Media synced with fileUrl, storagePath, entityId, vehicleId intact
    const mediaAfterUser = storage.getMediaItems();
    const syncedMedia = mediaAfterUser.find(m => m.id === 'media-emu-pub');
    assert.ok(syncedMedia, 'Scenario 3: MediaItem must sync');
    assert.equal(syncedMedia.fileUrl, mediaPub.fileUrl);
    assert.equal(syncedMedia.storagePath, mediaPub.storagePath);
    assert.equal(syncedMedia.entityId, 'conn-emu-pub');
    assert.equal(syncedMedia.vehicleId, 'veh-emu-pub');
    console.log('[PASS] Scenarios 1, 2, 3 (Normal User): ECUs, wiringDiagrams & media synced cleanly per Firestore rules');

    // ------------------------------------------------------------------
    // Scenario 1 & 2 (Part B): Admin Full Sync (including drafts)
    // ------------------------------------------------------------------
    await signInWithEmailAndPassword(emuAuth, 'super-admin@autopin.test', 'AdminPass!123');
    assert.equal(emuAuth.currentUser?.uid, adminUid);

    const adminSyncRes = await cloud.syncAllTechnicalData(true, storage);
    assert.equal(adminSyncRes.success, true, `Expected admin sync success, failed: ${JSON.stringify(adminSyncRes.failedCollections)}`);
    assert.ok(storage.getECUs().some(e => e.id === 'ecu-emu-draft'), 'Scenario 1 (Admin): Draft ECU must sync for admin');
    assert.ok(storage.getWiringDiagrams().some(d => d.id === 'diag-emu-draft'), 'Scenario 2 (Admin): Draft diagram must sync for admin');
    assert.ok(storage.getManufacturers().some(m => m.id === 'man-cloud-peugeot'), 'Manufacturers must sync');
    assert.ok(storage.getConnectors().some(c => c.id === 'conn-emu-pub'), 'Connectors must sync');
    assert.ok(storage.getFuseBoxes().some(fb => fb.id === 'fb-emu-pub'), 'FuseBoxes must sync');
    console.log('[PASS] Scenarios 1 & 2 (Admin): Full 7-collection cloud sync succeeded');

    // ------------------------------------------------------------------
    // Scenario 4: Sync Failure / Offline Cache Preservation
    // ------------------------------------------------------------------
    const offlineVehicle: Vehicle = {
      id: 'veh-local-offline',
      manufacturerId: 'ikco',
      name: 'رانا پلاس آفلاین',
      persianName: 'رانا پلاس آفلاین',
      generation: 'S',
      modelYears: '1402',
      electricalSystem: 'CAN',
      description: 'ویرایش‌شده در حالت آفلاین',
      engines: [],
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const offlineEcu: ECU = {
      id: 'ecu-local-offline',
      vehicleId: 'veh-local-offline',
      brand: 'کروز',
      model: 'Local-Only-ECU',
      connectorCount: 2,
      status: 'draft'
    };
    storage.saveVehicle(offlineVehicle);
    storage.saveECU(offlineEcu);

    // Sign out so admin-level sync fails against Firestore rules (simulates auth/permission/network partial failure)
    await signOut(emuAuth);
    const failedSyncRes = await cloud.syncAllTechnicalData(true, storage);
    assert.equal(failedSyncRes.success, false, 'Scenario 4: Expected sync failure when unauthenticated for admin queries');
    assert.ok(failedSyncRes.failedCollections.length > 0, 'Scenario 4: Expected failedCollections to be recorded');

    assert.ok(storage.getVehicleById('veh-local-offline'), 'Scenario 4: Offline vehicle cache MUST remain intact');
    assert.ok(storage.getECUById('ecu-local-offline'), 'Scenario 4: Offline ECU cache MUST remain intact');
    assert.ok(storage.getVehicleById('veh-emu-pub'), 'Scenario 4: Previously synced cloud vehicle MUST remain cached');
    console.log('[PASS] Scenario 4: Sync failure preserves local offline records & cached cloud data');

    // ------------------------------------------------------------------
    // Scenario 5: Reconnect Sync (Zero Duplicates + Newer Local Wins)
    // ------------------------------------------------------------------
    await signInWithEmailAndPassword(emuAuth, 'super-admin@autopin.test', 'AdminPass!123');

    // Make local veh-emu-pub NEWER than cloud (5000 vs 9_999_999_999_999)
    const newerLocalEdit: Vehicle = {
      ...vehCloudPub,
      name: 'پژو ۲۰۷ ویرایش محلی جدیدتر',
      updatedAt: 9_999_999_999_999
    };
    storage.saveVehicle(newerLocalEdit);

    // Seed another record in cloud with NEWER updatedAt than local
    const staleLocalEcu: ECU & { updatedAt?: number } = {
      id: 'ecu-stale-local',
      vehicleId: 'veh-emu-pub',
      brand: 'بوش',
      model: 'Old-Local-Model',
      connectorCount: 1,
      status: 'published',
      updatedAt: 1000
    };
    storage.saveECU(staleLocalEcu);
    await fsAdminSet('ecus', 'ecu-stale-local', {
      ...staleLocalEcu,
      model: 'Updated-Cloud-Model',
      updatedAt: 90000
    });

    // Run reconnect sync twice to prove idempotency (zero duplicates)
    const reconnect1 = await cloud.syncAllTechnicalData(true, storage);
    const reconnect2 = await cloud.syncAllTechnicalData(true, storage);
    assert.equal(reconnect1.success, true);
    assert.equal(reconnect2.success, true);

    assert.equal(
      storage.getVehicleById('veh-emu-pub')?.name,
      'پژو ۲۰۷ ویرایش محلی جدیدتر',
      'Scenario 5: Newer local updatedAt MUST NOT be overwritten by older cloud record'
    );
    assert.equal(
      storage.getECUById('ecu-stale-local')?.model,
      'Updated-Cloud-Model',
      'Scenario 5: Older local record MUST update from newer cloud record'
    );
    assert.ok(uniqueIds(storage.getManufacturers()), 'Zero duplicate manufacturers');
    assert.ok(uniqueIds(storage.getVehicles()), 'Zero duplicate vehicles');
    assert.ok(uniqueIds(storage.getECUs()), 'Zero duplicate ECUs');
    assert.ok(uniqueIds(storage.getConnectors()), 'Zero duplicate connectors');
    assert.ok(uniqueIds(storage.getFuseBoxes()), 'Zero duplicate fuseBoxes');
    assert.ok(uniqueIds(storage.getWiringDiagrams()), 'Zero duplicate wiringDiagrams');
    assert.ok(uniqueIds(storage.getMediaItems()), 'Zero duplicate mediaItems');
    console.log('[PASS] Scenario 5: Reconnect sync preserves newer local edits & causes zero duplicates');

    // ------------------------------------------------------------------
    // Scenario 6 & 7: Cascade Delete ECU + Shared Media & Sibling Protection
    // ------------------------------------------------------------------
    storage.resetToFactory();

    const sharedUrl = 'https://cdn.autopin.test/shared-ecu-harness.jpg';
    const uniqueUrl = 'https://cdn.autopin.test/exclusive-ecu-target.jpg';

    const parentVeh: Vehicle = {
      id: 'veh-cas-parent',
      manufacturerId: 'ikco',
      name: 'سمند EF7 تست حذف آبشاری',
      persianName: 'سمند EF7 تست حذف آبشاری',
      generation: 'LX',
      modelYears: '1395',
      electricalSystem: 'ME7.4.9',
      description: 'خودروی والد',
      engines: [],
      ecuIds: ['ecu-cas-target', 'ecu-cas-sibling'],
      status: 'published',
      createdAt: Date.now()
    };
    const ecuTarget: ECU = {
      id: 'ecu-cas-target',
      vehicleId: 'veh-cas-parent',
      brand: 'بوش',
      model: 'ME7.4.9-Target',
      connectorCount: 1,
      imageUrl: uniqueUrl,
      status: 'published'
    };
    const ecuSibling: ECU = {
      id: 'ecu-cas-sibling',
      vehicleId: 'veh-cas-parent',
      brand: 'زیمنس',
      model: 'Sibling-Protected',
      connectorCount: 1,
      imageUrl: sharedUrl,
      status: 'published'
    };
    const connTarget: Connector = {
      id: 'conn-cas-target',
      vehicleId: 'veh-cas-parent',
      ecuId: 'ecu-cas-target',
      name: 'سوکت اختصاصی ECU هدف',
      codeName: 'C1-T',
      category: 'ecu',
      pinCount: 32,
      rows: 4,
      cols: 8,
      shape: 'grid',
      socketColor: 'خاکستری',
      socketColorHex: '#71717a',
      source: 'Test',
      status: 'published',
      pins: [],
      createdAt: Date.now()
    };
    const connSibling: Connector = {
      id: 'conn-cas-sibling',
      vehicleId: 'veh-cas-parent',
      ecuId: 'ecu-cas-sibling',
      name: 'سوکت ECU همسایه (محافظت‌شده)',
      codeName: 'C1-S',
      category: 'ecu',
      pinCount: 32,
      rows: 4,
      cols: 8,
      shape: 'grid',
      socketColor: 'مشکی',
      socketColorHex: '#18181b',
      realImageUrl: sharedUrl,
      source: 'Test',
      status: 'published',
      pins: [],
      createdAt: Date.now()
    };
    const connVehLevel: Connector = {
      id: 'conn-cas-veh-only',
      vehicleId: 'veh-cas-parent',
      name: 'سوکت سنسور خودرو (بدون ecuId)',
      codeName: 'SNS-1',
      category: 'sensor',
      pinCount: 4,
      rows: 1,
      cols: 4,
      shape: 'single_row',
      socketColor: 'سفید',
      socketColorHex: '#ffffff',
      source: 'Test',
      status: 'published',
      pins: [],
      createdAt: Date.now()
    };
    const mediaExclusive: MediaItem = {
      id: 'media-cas-exclusive',
      title: 'تصویر انحصاری سوکت هدف',
      fileUrl: uniqueUrl,
      entityType: 'connector',
      entityId: 'conn-cas-target',
      vehicleId: 'veh-cas-parent',
      imageType: 'socket_front',
      status: 'published',
      createdAt: Date.now()
    };
    const mediaShared: MediaItem = {
      id: 'media-cas-shared',
      title: 'تصویر مشترک بین ECUها',
      fileUrl: sharedUrl,
      entityType: 'connector',
      entityId: 'conn-cas-target',
      vehicleId: 'veh-cas-parent',
      imageType: 'socket_back',
      status: 'published',
      createdAt: Date.now()
    };

    // Persist in local AND Emulator
    storage.saveVehicle(parentVeh);
    storage.saveECU(ecuTarget);
    storage.saveECU(ecuSibling);
    storage.saveConnector(connTarget);
    storage.saveConnector(connSibling);
    storage.saveConnector(connVehLevel);
    storage.saveMediaItem(mediaExclusive);
    storage.saveMediaItem(mediaShared);

    await cloud.saveVehicle(parentVeh);
    await cloud.saveECU(ecuTarget);
    await cloud.saveECU(ecuSibling);
    await cloud.saveConnector(connTarget);
    await cloud.saveConnector(connSibling);
    await cloud.saveConnector(connVehLevel);
    await fsAdminSet('media', mediaExclusive.id, mediaExclusive as unknown as Record<string, unknown>);
    await fsAdminSet('media', mediaShared.id, mediaShared as unknown as Record<string, unknown>);

    // Verify cloud failure guard first (non-admin cannot trigger cloud cascade delete or wipe local)
    await signInWithEmailAndPassword(emuAuth, 'tech-user@autopin.test', 'TestPass!123');
    let deniedCaught = false;
    try {
      await cloud.cascadeDeleteEntity('ecu', 'ecu-cas-target', {
        syncToCloud: true,
        targetStorage: storage
      });
    } catch {
      deniedCaught = true;
    }
    assert.equal(deniedCaught, true, 'Non-admin cloud cascade delete must be rejected by Firestore rules');
    assert.ok(storage.getECUById('ecu-cas-target'), 'Local ECU must stay intact after denied cloud cascade delete');
    assert.ok(storage.getConnectorById('conn-cas-target'), 'Local connector must stay intact after denied cloud cascade delete');

    // Now sign in as Admin and perform real cascade delete
    await signInWithEmailAndPassword(emuAuth, 'super-admin@autopin.test', 'AdminPass!123');
    await cloud.cascadeDeleteEntity('ecu', 'ecu-cas-target', {
      syncToCloud: true,
      adminInfo: { uid: adminUid, email: 'super-admin@autopin.test' },
      targetStorage: storage
    });

    // Assert Scenario 6: Dependent entities deleted in BOTH Local & Firestore Emulator
    assert.equal(storage.getECUById('ecu-cas-target'), undefined, 'Local target ECU deleted');
    assert.equal(await fsAdminGet('ecus', 'ecu-cas-target'), null, 'Emulator target ECU deleted');

    assert.equal(storage.getConnectorById('conn-cas-target'), undefined, 'Local target connector deleted');
    assert.equal(await fsAdminGet('connectors', 'conn-cas-target'), null, 'Emulator target connector deleted');

    assert.equal(
      storage.getMediaItems().some(m => m.id === 'media-cas-exclusive'),
      false,
      'Local exclusive media deleted'
    );
    assert.equal(await fsAdminGet('media', 'media-cas-exclusive'), null, 'Emulator exclusive media deleted');

    // Assert parent vehicle ecuIds cleanup in BOTH Local & Firestore Emulator
    const localParent = storage.getVehicleById('veh-cas-parent');
    assert.ok(localParent, 'Parent vehicle must still exist locally');
    assert.deepEqual(localParent.ecuIds, ['ecu-cas-sibling'], 'Local parent vehicle.ecuIds cleaned up');

    const cloudParent = await fsAdminGet('vehicles', 'veh-cas-parent');
    assert.ok(cloudParent, 'Parent vehicle must still exist in Emulator');
    assert.deepEqual(cloudParent.ecuIds, ['ecu-cas-sibling'], 'Emulator parent vehicle.ecuIds cleaned up');
    console.log('[PASS] Scenario 6: Cascade delete ECU cleaned dependents & parent ecuIds in Local + Firestore Emulator');

    // Assert Scenario 7: Shared media & unrelated/sibling connectors preserved in BOTH Local & Firestore Emulator
    assert.ok(storage.getECUById('ecu-cas-sibling'), 'Local sibling ECU preserved');
    assert.ok(await fsAdminGet('ecus', 'ecu-cas-sibling'), 'Emulator sibling ECU preserved');

    assert.ok(storage.getConnectorById('conn-cas-sibling'), 'Local sibling connector preserved');
    assert.ok(await fsAdminGet('connectors', 'conn-cas-sibling'), 'Emulator sibling connector preserved');

    assert.ok(storage.getConnectorById('conn-cas-veh-only'), 'Local vehicle-level connector preserved');
    assert.ok(await fsAdminGet('connectors', 'conn-cas-veh-only'), 'Emulator vehicle-level connector preserved');

    assert.ok(
      storage.getMediaItems().some(m => m.id === 'media-cas-shared'),
      'Local shared media URL MUST be preserved because surviving conn-cas-sibling uses it'
    );
    assert.ok(
      await fsAdminGet('media', 'media-cas-shared'),
      'Emulator shared media URL MUST be preserved'
    );
    console.log('[PASS] Scenario 7: Cascade delete protects shared media URLs and unrelated connectors in Local + Emulator');

    // ------------------------------------------------------------------
    // Scenario 8: Unbootstrapped Master Account Sync Fix (Root Cause #1)
    // ------------------------------------------------------------------
    const unbootstrappedMasterCred = await createUserWithEmailAndPassword(
      emuAuth,
      'arefalikhani69@gmail.com',
      'MasterNoDocPass!123'
    );
    assert.ok(unbootstrappedMasterCred.user.uid);
    // Note: Intentionally NO /admins/{uid} doc exists for this account yet
    const oldBuggySync = await cloud.syncAllTechnicalData(true, storage);
    assert.equal(oldBuggySync.success, false, 'Old includeDrafts=true without /admins/{uid} must fail on rules');
    assert.equal(oldBuggySync.partial, true, 'Old includeDrafts=true triggers partial sync (only media readable)');
    assert.equal(oldBuggySync.failedCollections.length, 6, '6 protected collections reject unfiltered queries');

    // Fixed behavior: hasFirestoreAdminDoc=false passes includeDrafts=false
    const fixedUnbootstrappedSync = await cloud.syncAllTechnicalData(false, storage);
    assert.equal(
      fixedUnbootstrappedSync.success,
      true,
      `Fixed sync with hasFirestoreAdminDoc=false must succeed across all 7 collections: ${JSON.stringify(fixedUnbootstrappedSync.failedCollections)}`
    );
    assert.equal(fixedUnbootstrappedSync.partial, false, 'Fixed sync must NOT trigger partial sync warning');
    assert.equal(fixedUnbootstrappedSync.syncedCollections.length, 7, 'All 7 technical collections must succeed');
    assert.equal(fixedUnbootstrappedSync.collectionDetails.length, 7, 'All 7 collectionDetails entries populated');
    console.log('[PASS] Scenario 8: Unbootstrapped master email sync succeeds cleanly across all 7 collections without partial warning');

    // ------------------------------------------------------------------
    // Scenario 9: Bidirectional Push Sync + Non-Admin Write Protection
    // ------------------------------------------------------------------
    await signInWithEmailAndPassword(emuAuth, 'tech-user@autopin.test', 'TestPass!123');
    const unauthorizedPush = await cloud.syncLocalTechnicalDataToCloud(storage);
    assert.equal(unauthorizedPush.success, false, 'Non-admin push sync must be rejected by Firestore rules');
    assert.ok(
      unauthorizedPush.failedCollections.some(f => f.category === 'permission_denied'),
      'Unauthorized push failures must categorize as permission_denied'
    );

    await signInWithEmailAndPassword(emuAuth, 'super-admin@autopin.test', 'AdminPass!123');
    const adminPush = await cloud.syncLocalTechnicalDataToCloud(storage);
    assert.equal(
      adminPush.success,
      true,
      `Verified admin push across all 7 collections must succeed: ${JSON.stringify(adminPush.failedCollections)}`
    );
    assert.equal(adminPush.syncedCollections.length, 7);

    // Pull again after push -> zero duplicates
    const postPushPull = await cloud.syncAllTechnicalData(true, storage);
    assert.equal(postPushPull.success, true);
    assert.ok(uniqueIds(storage.getManufacturers()), 'Post-push manufacturers unique');
    assert.ok(uniqueIds(storage.getVehicles()), 'Post-push vehicles unique');
    assert.ok(uniqueIds(storage.getECUs()), 'Post-push ECUs unique');
    assert.ok(uniqueIds(storage.getConnectors()), 'Post-push connectors unique');
    assert.ok(uniqueIds(storage.getFuseBoxes()), 'Post-push fuseBoxes unique');
    assert.ok(uniqueIds(storage.getWiringDiagrams()), 'Post-push wiringDiagrams unique');
    assert.ok(uniqueIds(storage.getMediaItems()), 'Post-push media unique');
    console.log('[PASS] Scenario 9: Verified admin bidirectional 7-collection sync succeeds & non-admin push rejected');

    // ------------------------------------------------------------------
    // Scenario 10: ISO Timestamp Comparison & Vehicle Nested Engines Preservation
    // ------------------------------------------------------------------
    const futureVehLocal: Vehicle = {
      ...vehCloudPub,
      id: 'veh-ts-guard',
      name: 'خودرو ویرایش جدید محلی',
      persianName: 'خودرو ویرایش جدید محلی',
      updatedAt: Date.now() + 600_000
    };
    storage.saveVehicle(futureVehLocal);
    storage.mergeCloudVehicles([
      {
        ...futureVehLocal,
        name: 'نسخه قدیمی‌تر ابری ISO',
        updatedAt: new Date(Date.now() - 600_000).toISOString() as unknown as number
      }
    ]);
    assert.equal(
      storage.getVehicleById('veh-ts-guard')?.name,
      'خودرو ویرایش جدید محلی',
      'Newer local updatedAt must NOT be overwritten by older ISO string cloud updatedAt'
    );

    // Partial cloud vehicle with newer timestamp omits engines -> preserve existing engines
    storage.mergeCloudVehicles([
      {
        ...futureVehLocal,
        name: 'نام جدید ابری',
        engines: undefined as unknown as Vehicle['engines'],
        updatedAt: Date.now() + 1_200_000
      }
    ]);
    const mergedVeh = storage.getVehicleById('veh-ts-guard');
    assert.equal(mergedVeh?.name, 'نام جدید ابری', 'Newer cloud record updates scalar fields');
    assert.equal(mergedVeh?.engines.length, 1, 'Existing vehicle.engines preserved if cloud payload omits array');
    console.log('[PASS] Scenario 10: ISO timestamp comparison & Vehicle nested engines/ecuIds preservation verified');

    console.log('='.repeat(72));
    console.log(' ALL 10 FIREBASE EMULATOR DATA-INTEGRITY & SYNC SCENARIOS PASSED!');
    console.log('='.repeat(72));
  } finally {
    await signOut(emuAuth).catch(() => {});
    await deleteApp(emuApp);
  }
}

main().catch((err) => {
  console.error('EMULATOR DATA INTEGRITY TEST FAILED:', err);
  process.exit(1);
});
