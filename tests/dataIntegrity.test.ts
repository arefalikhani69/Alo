/**
 * AutoPin Pro - Data Integrity Unit & Integration Verification Suite (Scenarios 8-15)
 *
 * Covers:
 *  8.  ZIP & JSON Backup export -> inspectAndValidateBackupFile -> Restore (preserving appImages & mediaItems & relations)
 *  9.  Rejection of corrupt JSON, corrupt ZIP, tampered checksum, and tampered ZIP image entries (zero DB mutation)
 * 10.  Restore 'merge' mode across all 8 collections (add new, update matched, preserve unrelated, zero duplicates)
 * 11.  Restore 'overwrite' mode (replace collections, remove stale, prune orphan favorites/recents, protect entities on images_only)
 * 12.  Bulk Excel/CSV import (XLSX parsed): valid ECU-to-vehicle & Socket-to-ECU (ecuId + vehicleId) mapping
 * 13.  Rejection of invalid ECU/Vehicle/Image references in validateBulkData (no vehicles[0] fallback)
 * 14.  Bulk duplicateStrategy ('skip' vs 'update') preserving existing IDs, pins/wireHex/grid, engines, intra-file deduplication
 * 15.  Snapshot rollback preserving previous DB state on Bulk Import failure & Backup Restore failure
 */

import './helpers/mockBrowserStorage';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { storage } from '../src/services/storage';
import { backupService, BACKUP_SCHEMA_VERSION } from '../src/services/backupService';
import {
  BULK_SCHEMAS,
  extractSheetData,
  matchHeaderToColumn,
  validateBulkData,
  executeBulkImportCommit
} from '../src/utils/bulkDataEngine';
import type {
  Vehicle,
  ECU,
  Connector,
  FuseBox,
  WiringDiagram,
  MediaItem,
  AppImage
} from '../src/types';

function makeFileFromBlob(blob: Blob, name: string, type: string): File {
  return new File([blob], name, { type });
}

function makeFileFromText(text: string, name: string, type = 'application/json'): File {
  return new File([text], name, { type });
}

function snapshotComparable(): string {
  return JSON.stringify(storage.captureTechnicalDataSnapshot());
}

async function runTests() {
  console.log('='.repeat(72));
  console.log(' AutoPin Pro - Backup/Restore & Bulk Import Integrity Suite');
  console.log('='.repeat(72));

  // =====================================================================
  // Scenario 8: ZIP + JSON Export -> Validate -> Restore (incl appImages & mediaItems)
  // =====================================================================
  storage.resetToFactory();

  const samplePngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sampleDataUrl = `data:image/png;base64,${samplePngBase64}`;

  const customVeh: Vehicle = {
    id: 'veh-bak-207',
    manufacturerId: 'ikco',
    name: 'پژو ۲۰۷ بکاپ',
    persianName: 'پژو ۲۰۷ بکاپ',
    generation: 'TU5P',
    modelYears: '1401-1403',
    electricalSystem: 'EcoMux',
    description: 'خودرو جهت تست بکاپ',
    engines: [
      {
        id: 'eng-bak-tu5',
        vehicleId: 'veh-bak-207',
        code: 'TU5-BAK',
        name: 'TU5 Backup Engine',
        fuelSystem: 'MPI',
        valves: 16,
        displacementCc: 1587
      }
    ],
    ecuIds: ['ecu-bak-ez1'],
    status: 'published',
    createdAt: 10000
  };
  const customEcu: ECU = {
    id: 'ecu-bak-ez1',
    vehicleId: 'veh-bak-207',
    brand: 'کروز',
    model: 'EZ1-BAK',
    connectorCount: 1,
    status: 'published'
  };
  const customConn: Connector = {
    id: 'conn-bak-1',
    vehicleId: 'veh-bak-207',
    ecuId: 'ecu-bak-ez1',
    name: 'سوکت بکاپ ۱',
    codeName: 'CB-1',
    category: 'ecu',
    pinCount: 16,
    rows: 2,
    cols: 8,
    shape: 'double_row',
    socketColor: 'آبی',
    socketColorHex: '#2563eb',
    source: 'Test',
    status: 'published',
    pins: [
      {
        id: 'pin-bak-1',
        connectorId: 'conn-bak-1',
        pinNumber: 'A1',
        wireColor: 'قرمز',
        wireHex: '#ef4444',
        functionName: 'تغذیه +12V',
        signalType: '12V_BAT',
        voltageRange: '12V'
      }
    ],
    createdAt: 10000
  };
  const customFb: FuseBox = {
    id: 'fb-bak-1',
    vehicleId: 'veh-bak-207',
    name: 'جعبه فیوز بکاپ',
    location: 'engine',
    locationFa: 'محفظه موتور',
    source: 'Test',
    status: 'published',
    fuses: [],
    relays: []
  };
  const customDiag: WiringDiagram = {
    id: 'diag-bak-1',
    vehicleId: 'veh-bak-207',
    title: 'نقشه بکاپ EZ1',
    category: 'injection_ignition',
    categoryFa: 'انژکتور و جرقه',
    diagramImageUrl: sampleDataUrl,
    description: 'نقشه تست بکاپ',
    source: 'Test',
    status: 'published',
    createdAt: 10000
  };
  const customMedia: MediaItem = {
    id: 'media-bak-1',
    title: 'عکس واقعی سوکت بکاپ',
    fileUrl: sampleDataUrl,
    entityType: 'connector',
    entityId: 'conn-bak-1',
    vehicleId: 'veh-bak-207',
    imageType: 'socket_front',
    status: 'published',
    createdAt: 10000
  };
  const customAppImg: AppImage = {
    id: 'appimg-bak-1',
    title: 'تصویر داخلی برنامه',
    dataUrl: sampleDataUrl,
    category: 'connector',
    linkedEntityId: 'conn-bak-1',
    createdAt: 10000
  };

  storage.saveVehicle(customVeh);
  storage.saveECU(customEcu);
  storage.saveConnector(customConn);
  storage.saveFuseBox(customFb);
  storage.saveWiringDiagram(customDiag);
  storage.saveMediaItem(customMedia);
  storage.saveImage(customAppImg);

  const zipExport = await backupService.generateZipBackup('full', 'admin@autopin.ir');
  assert.equal(zipExport.manifest.schemaVersion, BACKUP_SCHEMA_VERSION);
  assert.equal(zipExport.manifest.recordCounts.appImages, 1);
  assert.equal(zipExport.manifest.recordCounts.mediaItems, 1);

  const jsonExport = backupService.generateJsonBackup('full', 'admin@autopin.ir');
  assert.equal(jsonExport.manifest.schemaVersion, BACKUP_SCHEMA_VERSION);

  // Clear to factory before inspecting & restoring
  storage.resetToFactory();
  assert.equal(storage.getVehicleById('veh-bak-207'), undefined);
  assert.equal(storage.getImages().length, 0);

  const zipFile = makeFileFromBlob(zipExport.blob, zipExport.fileName, 'application/zip');
  const inspectZipRes = await backupService.inspectAndValidateBackupFile(zipFile);
  assert.equal(inspectZipRes.isValid, true, `ZIP inspect errors: ${inspectZipRes.errors.join('; ')}`);
  assert.equal(inspectZipRes.errors.length, 0);

  const restoreZipRes = await backupService.executeRestore(inspectZipRes.payload, 'overwrite', true, false);
  assert.equal(restoreZipRes.success, true);
  assert.ok(storage.getVehicleById('veh-bak-207'), 'Restored vehicle exists');
  assert.equal(storage.getECUById('ecu-bak-ez1')?.vehicleId, 'veh-bak-207', 'ECU relation preserved');
  assert.equal(storage.getConnectorById('conn-bak-1')?.ecuId, 'ecu-bak-ez1', 'Connector ecuId relation preserved');
  assert.equal(storage.getConnectorById('conn-bak-1')?.pins.length, 1, 'Connector pins preserved');
  assert.equal(storage.getFuseBoxById('fb-bak-1')?.vehicleId, 'veh-bak-207', 'FuseBox relation preserved');
  assert.equal(storage.getWiringDiagrams().find(d => d.id === 'diag-bak-1')?.diagramImageUrl, sampleDataUrl);
  assert.equal(storage.getMediaItems().find(m => m.id === 'media-bak-1')?.fileUrl, sampleDataUrl);
  assert.equal(storage.getImages().find(img => img.id === 'appimg-bak-1')?.dataUrl, sampleDataUrl);

  // Also test JSON backup round-trip
  storage.resetToFactory();
  const jsonFile = makeFileFromText(jsonExport.jsonStr, jsonExport.fileName);
  const inspectJsonRes = await backupService.inspectAndValidateBackupFile(jsonFile);
  assert.equal(inspectJsonRes.isValid, true, `JSON inspect errors: ${inspectJsonRes.errors.join('; ')}`);
  await backupService.executeRestore(inspectJsonRes.payload, 'merge', true, false);
  assert.ok(storage.getVehicleById('veh-bak-207'), 'JSON restore recovered vehicle');
  assert.ok(storage.getImages().some(i => i.id === 'appimg-bak-1'), 'JSON restore recovered appImages');
  console.log('[PASS] Scenario 8: ZIP & JSON backup export/inspect/restore preserved all 8 collections & images');

  // =====================================================================
  // Scenario 9: Reject corrupt JSON, corrupt ZIP, tampered checksum & tampered ZIP image
  // =====================================================================
  const baselineBeforeTamper = snapshotComparable();

  // 9a. Corrupt JSON
  const corruptJsonFile = makeFileFromText('{ "manifest": broken_json ', 'bad.json');
  const badJsonInspect = await backupService.inspectAndValidateBackupFile(corruptJsonFile);
  assert.equal(badJsonInspect.isValid, false, 'Corrupt JSON must be rejected');
  assert.ok(badJsonInspect.errors.length > 0);

  // 9b. Corrupt ZIP
  const corruptZipFile = makeFileFromBlob(new Blob([new Uint8Array([0x50, 0x4b, 0x00, 0x99, 0x11])]), 'bad.zip', 'application/zip');
  const badZipInspect = await backupService.inspectAndValidateBackupFile(corruptZipFile);
  assert.equal(badZipInspect.isValid, false, 'Corrupt ZIP must be rejected');
  assert.ok(badZipInspect.errors.length > 0);

  // 9c. Tampered checksum in JSON payload
  const tamperedPayload = JSON.parse(jsonExport.jsonStr);
  tamperedPayload.data.vehicles[0].name = 'HACKED_NAME';
  const tamperedJsonFile = makeFileFromText(JSON.stringify(tamperedPayload), 'tampered.json');
  const tamperedInspect = await backupService.inspectAndValidateBackupFile(tamperedJsonFile);
  assert.equal(tamperedInspect.isValid, false, 'Tampered JSON data must fail checksum verification');
  assert.ok(tamperedInspect.errors.some(e => e.includes('Checksum') || e.includes('دستکاری')));

  // Direct executeRestore attempt on tampered payload must ALSO throw before mutating DB!
  let tamperedRestoreThrew = false;
  try {
    await backupService.executeRestore(tamperedPayload, 'overwrite', true, false);
  } catch {
    tamperedRestoreThrew = true;
  }
  assert.equal(tamperedRestoreThrew, true, 'executeRestore MUST reject tampered checksum upfront');

  // 9d. Tampered image file inside valid ZIP while keeping manifest.json untouched
  const zipToTamper = await JSZip.loadAsync(await zipExport.blob.arrayBuffer());
  const otherPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR42mNk+M9QzwAEjDAGACcBA/+8H6lVAAAAAElFTkSuQmCC';
  zipToTamper.file('images/app_img_appimg-bak-1.png', otherPngBase64, { base64: true });
  const tamperedZipBlob = await zipToTamper.generateAsync({ type: 'blob' });
  const tamperedZipFile = makeFileFromBlob(tamperedZipBlob, 'tampered-image.zip', 'application/zip');
  const tamperedZipInspect = await backupService.inspectAndValidateBackupFile(tamperedZipFile);
  assert.equal(tamperedZipInspect.isValid, false, 'Tampered image binary in ZIP MUST fail checksum integrity check');

  assert.equal(snapshotComparable(), baselineBeforeTamper, 'Scenario 9: Rejected backups MUST NOT mutate current DB');
  console.log('[PASS] Scenario 9: Corrupt JSON/ZIP, tampered checksum & tampered ZIP image rejected with zero DB mutation');

  // =====================================================================
  // Scenario 10: Restore MERGE mode (add new, update matched, preserve unrelated, zero duplicates)
  // =====================================================================
  storage.resetToFactory();
  const unrelatedVeh: Vehicle = {
    id: 'veh-unrelated-local',
    manufacturerId: 'saipa',
    name: 'کوییک لوکال دست‌نخورده',
    persianName: 'کوییک لوکال دست‌نخورده',
    generation: 'R',
    modelYears: '1400',
    electricalSystem: 'CAN',
    description: 'باید در Merge باقی بماند',
    engines: [],
    status: 'published',
    createdAt: 5000
  };
  storage.saveVehicle(unrelatedVeh);
  storage.saveImage({ ...customAppImg, title: 'عنوان قدیمی' });

  // Use jsonExport (which has veh-bak-207 + updated appimg-bak-1 title 'تصویر داخلی برنامه')
  const mergeInspect = await backupService.inspectAndValidateBackupFile(
    makeFileFromText(jsonExport.jsonStr, 'merge.json')
  );
  assert.equal(mergeInspect.isValid, true);
  const mergeRes = await backupService.executeRestore(mergeInspect.payload, 'merge', true, false);
  assert.equal(mergeRes.success, true);

  assert.ok(storage.getVehicleById('veh-unrelated-local'), 'Scenario 10: Unrelated local vehicle preserved in merge');
  assert.ok(storage.getVehicleById('veh-bak-207'), 'Scenario 10: Backup vehicle added in merge');
  const mergedAppImgs = storage.getImages().filter(i => i.id === 'appimg-bak-1');
  assert.equal(mergedAppImgs.length, 1, 'Scenario 10: Zero duplicate appImages in merge');
  assert.equal(mergedAppImgs[0].title, 'تصویر داخلی برنامه', 'Scenario 10: Matched appImage updated in merge');
  console.log('[PASS] Scenario 10: Restore MERGE adds new, updates matched, preserves unrelated & produces zero duplicates');

  // =====================================================================
  // Scenario 11: Restore OVERWRITE mode + orphan favorites pruning + images_only scope protection
  // =====================================================================
  // Add stale vehicle + favorite + recent targeting stale vehicle
  const staleVeh: Vehicle = {
    id: 'veh-stale-remove-me',
    manufacturerId: 'ikco',
    name: 'خودروی قدیمی حذفی',
    persianName: 'خودروی قدیمی حذفی',
    generation: '1',
    modelYears: '1390',
    electricalSystem: 'STD',
    description: '',
    engines: [],
    status: 'published',
    createdAt: 5000
  };
  storage.saveVehicle(staleVeh);
  storage.toggleFavorite({
    type: 'vehicle',
    itemId: 'veh-stale-remove-me',
    title: 'علاقه‌مندی منقضی',
    subtitle: 'باید پاک شود'
  });
  storage.addRecentVehicle('veh-stale-remove-me');
  storage.addRecentVehicle('veh-bak-207');

  const overwriteInspect = await backupService.inspectAndValidateBackupFile(
    makeFileFromText(jsonExport.jsonStr, 'overwrite.json')
  );
  await backupService.executeRestore(overwriteInspect.payload, 'overwrite', true, false);

  assert.equal(storage.getVehicleById('veh-stale-remove-me'), undefined, 'Scenario 11: Stale vehicle removed in overwrite');
  assert.equal(
    storage.getFavorites().some(f => f.itemId === 'veh-stale-remove-me'),
    false,
    'Scenario 11: Orphan favorite pruned on full overwrite'
  );
  assert.equal(
    storage.getRecentVehicles().some(r => r.vehicleId === 'veh-stale-remove-me'),
    false,
    'Scenario 11: Orphan recent vehicle pruned on full overwrite'
  );
  assert.ok(
    storage.getRecentVehicles().some(r => r.vehicleId === 'veh-bak-207'),
    'Scenario 11: Valid recent vehicle preserved'
  );

  // Test images_only overwrite protects vehicles/ECUs/connectors/fuseBoxes!
  const imgOnlyBackup = backupService.generateJsonBackup('images_only', 'admin@autopin.ir');
  assert.equal(imgOnlyBackup.manifest.recordCounts.vehicles, 0);
  // Save another vehicle locally AFTER images_only snapshot was generated
  storage.saveVehicle(staleVeh);
  const imgOnlyInspect = await backupService.inspectAndValidateBackupFile(
    makeFileFromText(imgOnlyBackup.jsonStr, 'images-only.json')
  );
  assert.equal(imgOnlyInspect.isValid, true);
  await backupService.executeRestore(imgOnlyInspect.payload, 'overwrite', true, false);
  assert.ok(
    storage.getVehicleById('veh-stale-remove-me'),
    'Scenario 11: images_only overwrite MUST preserve vehicles/ECUs/connectors/fuseBoxes!'
  );
  assert.ok(storage.getVehicleById('veh-bak-207'));
  console.log('[PASS] Scenario 11: Overwrite removes stale & prunes orphans, while images_only protects non-image collections');

  // =====================================================================
  // Scenario 12: Bulk Excel/CSV import (XLSX) with valid ECU & Connector parent mapping
  // =====================================================================
  storage.resetToFactory();

  // Build real XLSX workbook in memory for ECUs (explicit vehicleId + compatibleEngineCodes)
  const ecuSheetRows = [
    ['manufacturer', 'ecuName', 'vehicleId', 'compatibleEngineCodes', 'hardwareVersion', 'softwareVersion', 'notes'],
    ['زیمنس', 'SIM2K-250-TEST', 'renault-tondar', '', 'HW-R90', 'SW-9.1', 'تست نگاشت با vehicleId'],
    ['کروز', 'CROUSE-M13-ENG', '', 'M13', 'HW-M13', 'SW-2.0', 'تست نگاشت با کد موتور']
  ];
  const ecuWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(ecuWb, XLSX.utils.aoa_to_sheet(ecuSheetRows), 'ECUs');
  const ecuBuf = XLSX.write(ecuWb, { type: 'array', bookType: 'xlsx' });
  const parsedEcuWb = XLSX.read(ecuBuf, { type: 'array' });
  const { headers: ecuHeaders, rawRows: ecuRawRows } = extractSheetData(parsedEcuWb, 'ECUs');
  const ecuColMap: Record<string, string> = {};
  ecuHeaders.forEach((h, idx) => {
    const key = matchHeaderToColumn(h, BULK_SCHEMAS.ecus);
    if (key) ecuColMap[String(idx)] = key;
  });

  const ecuVal = validateBulkData('ecus', ecuHeaders, ecuColMap, ecuRawRows);
  assert.equal(ecuVal.validCount, 2, `Expected 2 valid ECUs, errors: ${JSON.stringify(ecuVal.errors)} deps: ${JSON.stringify(ecuVal.missingDependencies)}`);
  assert.equal(ecuVal.invalidCount, 0);

  const ecuCommit = await executeBulkImportCommit({
    entityType: 'ecus',
    rows: ecuVal.parsedValidRows,
    duplicateStrategy: 'skip',
    isAdmin: true,
    isOnlineDbConnected: false
  });
  assert.equal(ecuCommit.added, 2);
  assert.equal(ecuCommit.failed, 0);

  const importedEcu1 = storage.getECUs().find(e => e.model === 'SIM2K-250-TEST');
  const importedEcu2 = storage.getECUs().find(e => e.model === 'CROUSE-M13-ENG');
  assert.equal(importedEcu1?.vehicleId, 'renault-tondar', 'Scenario 12: ECU mapped to renault-tondar (NOT vehicles[0] peugeot-206)');
  assert.equal(importedEcu2?.vehicleId, 'pride-tiba', 'Scenario 12: ECU mapped via unique engineCode M13 to pride-tiba');

  // Now import Connectors: row 1 attached to importedEcu1, row 2 attached directly to vehicle pars-samand
  const connSheetRows = [
    ['connectorId', 'ecuId', 'connectorName', 'connectorType', 'pinCount', 'viewOrientation'],
    ['conn-bulk-ecu1', importedEcu1!.id, 'سوکت تندر SIM2K', 'ecu', 48, 'مشکی'],
    ['conn-bulk-veh1', 'pars-samand', 'سوکت سنسور مپ سمند', 'sensor', 4, 'خاکستری']
  ];
  const connWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(connWb, XLSX.utils.aoa_to_sheet(connSheetRows), 'Connectors');
  const connCsv = XLSX.utils.sheet_to_csv(connWb.Sheets['Connectors']);
  const parsedConnWb = XLSX.read(connCsv, { type: 'string' });
  const { headers: connHeaders, rawRows: connRawRows } = extractSheetData(parsedConnWb, parsedConnWb.SheetNames[0]);
  const connColMap: Record<string, string> = {};
  connHeaders.forEach((h, idx) => {
    const key = matchHeaderToColumn(h, BULK_SCHEMAS.connectors);
    if (key) connColMap[String(idx)] = key;
  });

  const connVal = validateBulkData('connectors', connHeaders, connColMap, connRawRows);
  assert.equal(connVal.validCount, 2);
  const connCommit = await executeBulkImportCommit({
    entityType: 'connectors',
    rows: connVal.parsedValidRows,
    duplicateStrategy: 'skip',
    isAdmin: true,
    isOnlineDbConnected: false
  });
  assert.equal(connCommit.added, 2);

  const cEcu = storage.getConnectorById('conn-bulk-ecu1');
  const cVeh = storage.getConnectorById('conn-bulk-veh1');
  assert.equal(cEcu?.ecuId, importedEcu1!.id, 'Scenario 12: Connector ecuId MUST be populated');
  assert.equal(cEcu?.vehicleId, 'renault-tondar', 'Scenario 12: Connector vehicleId MUST come from parent ECU');
  assert.equal(cVeh?.ecuId, undefined, 'Scenario 12: Vehicle-level connector keeps ecuId undefined');
  assert.equal(cVeh?.vehicleId, 'pars-samand', 'Scenario 12: Vehicle-level connector maps to pars-samand');
  console.log('[PASS] Scenario 12: XLSX ECU import & CSV Connector import resolved ecuId and vehicleId accurately');

  // =====================================================================
  // Scenario 13: Rejecting invalid ECU / Vehicle / Image parent references
  // =====================================================================
  const invalidEcuRows = [
    ['زیمنس', 'BAD-ECU-1', 'nonexistent-veh-id', '', 'HW', 'SW', ''],
    ['بوش', 'BAD-ECU-2', '', '', 'HW', 'SW', ''],
    ['بوش', 'BAD-ECU-3', '', 'NONEXISTENT_ENG', 'HW', 'SW', '']
  ];
  const invalidEcuVal = validateBulkData('ecus', ecuHeaders, ecuColMap, invalidEcuRows);
  assert.equal(invalidEcuVal.validCount, 0, 'Scenario 13: All invalid-parent ECUs MUST be rejected');
  assert.equal(invalidEcuVal.invalidCount, 3);
  assert.equal(invalidEcuVal.missingDependencyCount, 3);

  const invalidConnRows = [
    ['conn-bad-1', 'nonexistent-ecu-or-veh', 'سوکت نامعتبر', 'ecu', 32, 'مشکی'],
    ['conn-bad-2', '', 'سوکت بدون والد', 'ecu', 32, 'مشکی']
  ];
  const invalidConnVal = validateBulkData('connectors', connHeaders, connColMap, invalidConnRows);
  assert.equal(invalidConnVal.validCount, 0, 'Scenario 13: Connectors with missing/invalid ecuId MUST NOT pass validation');
  assert.equal(invalidConnVal.invalidCount, 2);
  assert.equal(invalidConnVal.missingDependencyCount, 2);

  const imgHeaders = ['recordId', 'vehicleId', 'relatedItemType', 'relatedItemId', 'imageType', 'title'];
  const imgColMap: Record<string, string> = { '0': 'recordId', '1': 'vehicleId', '2': 'relatedItemType', '3': 'relatedItemId', '4': 'imageType', '5': 'title' };
  const invalidImgVal = validateBulkData('images', imgHeaders, imgColMap, [
    ['img-bad-type', 'peugeot-206', 'invalid_entity_type', 'peugeot-206', 'real_part', 'بد تایپ']
  ]);
  assert.equal(invalidImgVal.validCount, 0, 'Scenario 13: Unknown relatedItemType MUST be rejected');
  console.log('[PASS] Scenario 13: Invalid ECU, Connector, and Image references rejected without vehicles[0] fallback');

  // =====================================================================
  // Scenario 14: duplicateStrategy ('skip' vs 'update') + child & grid preservation + intra-file dedup
  // =====================================================================
  // Seed a rich connector with pin metadata & custom visual grid
  const richConn: Connector = {
    id: 'conn-rich-dup',
    vehicleId: 'peugeot-206',
    ecuId: 'ecu-bosch-me744',
    name: 'سوکت غنی اولیه',
    codeName: 'CH-RICH',
    category: 'ecu',
    pinCount: 32,
    rows: 6,
    cols: 6,
    shape: 'double_row',
    socketColor: 'قهوه‌ای',
    socketColorHex: '#92400e',
    realImageUrl: 'https://cdn.autopin.test/rich-socket.jpg',
    source: 'Original Source',
    status: 'published',
    pins: [
      {
        id: 'pin-rich-a1',
        connectorId: 'conn-rich-dup',
        pinNumber: 'A1',
        pinName: 'INJ_1',
        row: 2,
        col: 5,
        wireColor: 'زرد',
        wireHex: '#eab308',
        wireStripeHex: '#000000',
        dutyCategory: 'انژکتور و سوخت',
        pulseType: 'پالس منفی انژکتور',
        functionName: 'عملکرد اولیه A1',
        signalType: 'PWM_PULSE',
        voltageRange: '12V'
      }
    ],
    createdAt: 424242
  };
  storage.saveConnector(richConn);

  // 14a. SKIP strategy: includes DB duplicate + intra-file duplicate for a new connector
  const dupConnRows = [
    ['conn-rich-dup', 'ecu-bosch-me744', 'نام تغییریافته که باید رد شود', 'ecu', 48, 'سبز'],
    ['conn-intra-new', 'ecu-bosch-me744', 'سوکت جدید داخل فایل', 'ecu', 16, 'آبی'],
    ['conn-intra-new', 'ecu-bosch-me744', 'تکرار ردیف دوم داخل همان فایل', 'ecu', 24, 'قرمز']
  ];
  const skipConnVal = validateBulkData('connectors', connHeaders, connColMap, dupConnRows);
  assert.equal(skipConnVal.duplicateCount, 2, 'Scenario 14: Must detect both DB duplicate and intra-file duplicate');

  const skipCommit = await executeBulkImportCommit({
    entityType: 'connectors',
    rows: skipConnVal.parsedValidRows,
    duplicateStrategy: 'skip',
    isAdmin: true,
    isOnlineDbConnected: false
  });
  assert.equal(skipCommit.added, 1);
  assert.equal(skipCommit.skipped, 2);
  assert.equal(skipCommit.updated, 0);
  assert.equal(storage.getConnectorById('conn-rich-dup')?.name, 'سوکت غنی اولیه', 'SKIP preserved existing record');
  assert.equal(storage.getConnectorById('conn-intra-new')?.pinCount, 16, 'SKIP kept first row of intra-file duplicate');

  // 14b. UPDATE strategy on connectors preserves pins, visual grid, realImageUrl, createdAt, ecuId
  const updateConnVal = validateBulkData('connectors', connHeaders, connColMap, [
    ['conn-rich-dup', 'ecu-bosch-me744', 'سوکت غنی به‌روزرسانی‌شده', 'ecu', 32, 'قهوه‌ای متالیک']
  ]);
  const updateCommit = await executeBulkImportCommit({
    entityType: 'connectors',
    rows: updateConnVal.parsedValidRows,
    duplicateStrategy: 'update',
    isAdmin: true,
    isOnlineDbConnected: false
  });
  assert.equal(updateCommit.updated, 1);
  const updatedRichConn = storage.getConnectorById('conn-rich-dup')!;
  assert.equal(updatedRichConn.name, 'سوکت غنی به‌روزرسانی‌شده');
  assert.equal(updatedRichConn.rows, 6, 'UPDATE preserved visual rows');
  assert.equal(updatedRichConn.cols, 6, 'UPDATE preserved visual cols');
  assert.equal(updatedRichConn.shape, 'double_row', 'UPDATE preserved shape');
  assert.equal(updatedRichConn.realImageUrl, 'https://cdn.autopin.test/rich-socket.jpg', 'UPDATE preserved image');
  assert.equal(updatedRichConn.createdAt, 424242, 'UPDATE preserved createdAt');
  assert.equal(updatedRichConn.pins.length, 1, 'UPDATE preserved existing pins');

  // 14c. UPDATE strategy on pins preserves pin.id, wireHex, wireStripeHex, row, col, pinName, dutyCategory, pulseType
  const pinHeaders = ['connectorId', 'pinNumber', 'wireColor', 'pinFunction', 'signalType', 'voltage', 'notes'];
  const pinColMap: Record<string, string> = {
    '0': 'connectorId', '1': 'pinNumber', '2': 'wireColor', '3': 'pinFunction', '4': 'signalType', '5': 'voltage', '6': 'notes'
  };
  const pinUpdateVal = validateBulkData('pins', pinHeaders, pinColMap, [
    ['conn-rich-dup', 'A1', 'زرد با خط مشکی', 'عملکرد جدید A1', 'PWM_PULSE', '12.5V', 'تست با اسیلوسکوپ']
  ]);
  assert.equal(pinUpdateVal.duplicateCount, 1);
  const pinUpdateCommit = await executeBulkImportCommit({
    entityType: 'pins',
    rows: pinUpdateVal.parsedValidRows,
    duplicateStrategy: 'update',
    isAdmin: true,
    isOnlineDbConnected: false
  });
  assert.equal(pinUpdateCommit.updated, 1);
  const updatedPin = storage.getConnectorById('conn-rich-dup')!.pins[0];
  assert.equal(updatedPin.id, 'pin-rich-a1', 'UPDATE preserved pin ID');
  assert.equal(updatedPin.wireHex, '#eab308', 'UPDATE preserved wireHex');
  assert.equal(updatedPin.wireStripeHex, '#000000', 'UPDATE preserved wireStripeHex');
  assert.equal(updatedPin.row, 2, 'UPDATE preserved grid row');
  assert.equal(updatedPin.col, 5, 'UPDATE preserved grid col');
  assert.equal(updatedPin.pinName, 'INJ_1', 'UPDATE preserved pinName');
  assert.equal(updatedPin.dutyCategory, 'انژکتور و سوخت', 'UPDATE preserved dutyCategory');
  assert.equal(updatedPin.pulseType, 'پالس منفی انژکتور', 'UPDATE preserved pulseType');
  assert.equal(updatedPin.functionName, 'عملکرد جدید A1');

  // 14d. UPDATE strategy on vehicles merges engines without wiping existing engines
  const vehBefore = storage.getVehicleById('peugeot-206')!;
  const origEnginesCount = vehBefore.engines.length;
  const vehHeaders = ['manufacturer', 'vehicleName', 'model', 'engineCode', 'notes'];
  const vehColMap: Record<string, string> = { '0': 'manufacturer', '1': 'vehicleName', '2': 'model', '3': 'engineCode', '4': 'notes' };
  const vehUpdateVal = validateBulkData('vehicles', vehHeaders, vehColMap, [
    ['ikco', vehBefore.name, 'فرانسه', 'NEW_ENGINE_CODE', 'توضیحات جدید']
  ]);
  assert.equal(vehUpdateVal.duplicateCount, 1);
  await executeBulkImportCommit({
    entityType: 'vehicles',
    rows: vehUpdateVal.parsedValidRows,
    duplicateStrategy: 'update',
    isAdmin: true,
    isOnlineDbConnected: false
  });
  const vehAfter = storage.getVehicleById('peugeot-206')!;
  assert.equal(vehAfter.engines.length, origEnginesCount + 1, 'UPDATE merged new engine without wiping existing engines');
  assert.equal(vehAfter.createdAt, vehBefore.createdAt, 'UPDATE preserved vehicle createdAt');
  console.log('[PASS] Scenario 14: duplicateStrategy (skip/update) preserved IDs, pins/wireHex/grid, engines & detected intra-file duplicates');

  // =====================================================================
  // Scenario 15: Pre-error state preservation on Bulk Import failure & Backup Restore mid-failure
  // =====================================================================
  const stateBeforeErrors = snapshotComparable();

  // 15a. Bulk Import with failing cloud persistence rolls back failed row cleanly
  const failingCloudMock = {
    saveVehicle: async () => {
      throw new Error('Simulated cloud write failure');
    },
    saveECU: async () => {
      throw new Error('Simulated ECU cloud write failure');
    },
    saveConnector: async () => {
      throw new Error('Simulated Connector cloud write failure');
    },
    saveFuseBox: async () => {
      throw new Error('Simulated FuseBox cloud write failure');
    },
    saveMedia: async () => {
      throw new Error('Simulated Media cloud write failure');
    }
  };

  const ecuErrCommit = await executeBulkImportCommit({
    entityType: 'ecus',
    rows: [
      {
        manufacturer: 'بوش',
        ecuName: 'FAILED-ROLLBACK-ECU',
        vehicleId: 'peugeot-206',
        hardwareVersion: 'HW-ERR'
      }
    ],
    duplicateStrategy: 'update',
    isAdmin: true,
    isOnlineDbConnected: true,
    targetOnlineStorage: failingCloudMock
  });
  assert.equal(ecuErrCommit.failed, 1);
  assert.equal(ecuErrCommit.added, 0);
  assert.equal(
    storage.getECUs().some(e => e.model === 'FAILED-ROLLBACK-ECU'),
    false,
    'Scenario 15: Failed cloud write MUST NOT leave partial/orphaned local ECU'
  );
  assert.equal(snapshotComparable(), stateBeforeErrors, 'Scenario 15: DB state preserved identically after failed bulk import');

  // 15b. Restore mid-failure rolls back via rollbackSnapshot cleanly
  // Trigger a failure inside executeRestore when payload contains an invalid backup structure OR online sync fails
  const fullSnap = backupService.generateJsonBackup('full', 'admin@autopin.ir');
  const parsedSnap = JSON.parse(fullSnap.jsonStr);
  // Modify parsedSnap + recalculate valid checksum so precheck passes, then force error via invalid local condition?
  // Better: test with onlineStorage failure during executeRestore(overwrite, isAdmin=true, isOnlineDbConnected=true)
  // because onlineStorage points to unconfigured/failing Firestore in Node -> saveManufacturer/delete fails or let's pass a stub?
  // Wait: if overwrite runs online sync with failing network (or we monkey-patch onlineStorage.saveManufacturer cleanly in test scope):
  const { onlineStorage } = await import('../src/services/onlineStorage');
  const origSaveMan = onlineStorage.saveManufacturer.bind(onlineStorage);
  const origDelVeh = onlineStorage.deleteVehicle.bind(onlineStorage);
  onlineStorage.deleteVehicle = async () => {
    throw new Error('Simulated mid-restore cloud delete failure');
  };
  onlineStorage.saveManufacturer = async () => {
    throw new Error('Simulated mid-restore cloud save failure');
  };
  try {
    // Modify local DB right before restore so we can verify overwrite rollback actually restores pre-restore state!
    storage.saveVehicle({
      ...staleVeh,
      id: 'veh-must-survive-rollback',
      name: 'خودروی قبل از ریستور ناموفق'
    });
    const beforeFailedRestore = snapshotComparable();

    let restoreFailed = false;
    try {
      await backupService.executeRestore(parsedSnap, 'overwrite', true, true);
    } catch {
      restoreFailed = true;
    }
    assert.equal(restoreFailed, true, 'Scenario 15: Expected mid-restore error to reject');
    assert.equal(
      snapshotComparable(),
      beforeFailedRestore,
      'Scenario 15: Full DB snapshot MUST roll back identically when restore fails mid-way'
    );
  } finally {
    onlineStorage.deleteVehicle = origDelVeh;
    onlineStorage.saveManufacturer = origSaveMan;
  }

  console.log('[PASS] Scenario 15: Previous DB state preserved identically via snapshot rollback on Bulk Import & Restore failures');
  console.log('='.repeat(72));
  console.log(' ALL 8 BACKUP/RESTORE & BULK IMPORT SCENARIOS (8-15) PASSED!');
  console.log('='.repeat(72));
}

runTests().catch((err) => {
  console.error('DATA INTEGRITY TEST SUITE FAILED:', err);
  process.exit(1);
});
