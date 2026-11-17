import JSZip from 'jszip';
import {
  Vehicle,
  ECU,
  Connector,
  FuseBox,
  WiringDiagram,
  MediaItem,
  AppImage,
  Manufacturer
} from '../types';
import { storage } from './storage';
import { onlineStorage } from './onlineStorage';
import { deduplicateMediaList } from '../utils/imageDeduplication';

export const BACKUP_SCHEMA_VERSION = '2.2.0';
const LAST_BACKUP_STORAGE_KEY = 'autopin_last_backup_meta_v2';
const LOCAL_SNAPSHOTS_KEY = 'autopin_backup_snapshots_v1';

export type BackupType = 'full' | 'data_only' | 'images_only';

export interface BackupManifest {
  appName: 'AutoPin Pro';
  version: string;
  schemaVersion: string;
  backupType: BackupType;
  createdAt: string;
  createdAtTimestamp: number;
  authorEmail?: string;
  checksum: string;
  recordCounts: {
    manufacturers: number;
    vehicles: number;
    ecus: number;
    connectors: number;
    pins: number;
    fuseBoxes: number;
    fuses: number;
    relays: number;
    wiringDiagrams: number;
    mediaItems: number;
    appImages: number;
  };
  totalImagesCount: number;
  description: string;
}

export interface BackupDataPayload {
  manifest: BackupManifest;
  data: {
    manufacturers: Manufacturer[];
    vehicles: Vehicle[];
    ecus: ECU[];
    connectors: Connector[];
    fuseBoxes: FuseBox[];
    wiringDiagrams: WiringDiagram[];
    mediaItems: MediaItem[];
    appImages: AppImage[];
  };
  imagesData?: Record<string, string>; // imageId/filename -> dataUrl base64
}

export interface BackupIntegrityCheckResult {
  isValid: boolean;
  manifest: BackupManifest;
  warnings: string[];
  errors: string[];
  conflicts: {
    newVehicles: number;
    existingVehicles: number;
    newConnectors: number;
    existingConnectors: number;
    newFuseBoxes: number;
    existingFuseBoxes: number;
    newEcus: number;
    existingEcus: number;
  };
  payload: BackupDataPayload;
}

export interface LastBackupInfo {
  timestamp: number;
  formattedDate: string;
  backupType: BackupType;
  fileName: string;
  fileSizeBytes: number;
  recordCounts: BackupManifest['recordCounts'];
}

export interface LocalSnapshotItem {
  id: string;
  createdAt: number;
  formattedDate: string;
  description: string;
  recordCounts: BackupManifest['recordCounts'];
  jsonPayload: string;
}

function stableCanonicalStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => (item === undefined ? 'null' : stableCanonicalStringify(item))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${stableCanonicalStringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

function calculateLegacyChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `hash-${Math.abs(hash).toString(16)}`;
}

export function computePayloadChecksum(data: BackupDataPayload['data']): string {
  const normalized = {
    manufacturers: Array.isArray(data.manufacturers) ? data.manufacturers : [],
    vehicles: Array.isArray(data.vehicles) ? data.vehicles : [],
    ecus: Array.isArray(data.ecus) ? data.ecus : [],
    connectors: Array.isArray(data.connectors) ? data.connectors : [],
    fuseBoxes: Array.isArray(data.fuseBoxes) ? data.fuseBoxes : [],
    wiringDiagrams: Array.isArray(data.wiringDiagrams) ? data.wiringDiagrams : [],
    mediaItems: Array.isArray(data.mediaItems) ? data.mediaItems : [],
    appImages: Array.isArray(data.appImages) ? data.appImages : []
  };
  const canonical = stableCanonicalStringify(normalized);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 = ((h2 << 5) - h2 + c) | 0;
  }
  return `chk-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function deduplicateById<T extends { id?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (item && item.id && !seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}

function parseDataUrlParts(dataUrl: string): { mimeSubType: string; ext: string; base64: string } | null {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/s);
  if (!match) return null;
  const sub = match[1].toLowerCase();
  const ext = sub === 'png' ? 'png' : sub === 'webp' ? 'webp' : sub === 'gif' ? 'gif' : 'jpg';
  return { mimeSubType: sub, ext, base64: match[2] };
}

function extractBase64Body(dataUrl?: string): string | null {
  if (!dataUrl || !dataUrl.startsWith('data:image')) return null;
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1).trim() : null;
}

class BackupService {
  /**
   * Reads information about the last created backup.
   */
  public getLastBackupInfo(): LastBackupInfo | null {
    try {
      const data = localStorage.getItem(LAST_BACKUP_STORAGE_KEY);
      if (!data) return null;
      return JSON.parse(data) as LastBackupInfo;
    } catch {
      return null;
    }
  }

  /**
   * Saves information about the latest backup.
   */
  private saveLastBackupInfo(info: LastBackupInfo): void {
    try {
      localStorage.setItem(LAST_BACKUP_STORAGE_KEY, JSON.stringify(info));
    } catch (err) {
      console.warn('Failed to save last backup metadata:', err);
    }
  }

  /**
   * Retrieves automatic pre-restore safety snapshots.
   */
  public getLocalSnapshots(): LocalSnapshotItem[] {
    try {
      const data = localStorage.getItem(LOCAL_SNAPSHOTS_KEY);
      if (!data) return [];
      return JSON.parse(data) as LocalSnapshotItem[];
    } catch {
      return [];
    }
  }

  /**
   * Saves a safety snapshot of current data before overwriting.
   */
  public createSafetySnapshot(description = 'پیش از بازیابی اطلاعات'): LocalSnapshotItem {
    const currentPayload = this.collectCurrentData('full', 'سیستم خودکار امنیتی');
    const item: LocalSnapshotItem = {
      id: `snap-${Date.now()}`,
      createdAt: Date.now(),
      formattedDate: new Intl.DateTimeFormat('fa-IR', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date()),
      description,
      recordCounts: currentPayload.manifest.recordCounts,
      jsonPayload: JSON.stringify(currentPayload)
    };

    const snapshots = this.getLocalSnapshots();
    const updated = [item, ...snapshots].slice(0, 5);
    localStorage.setItem(LOCAL_SNAPSHOTS_KEY, JSON.stringify(updated));
    return item;
  }

  /**
   * Gathers all technical entities safely from storage without sensitive keys.
   */
  public collectCurrentData(type: BackupType = 'full', authorEmail?: string): BackupDataPayload {
    const allManufacturers = deduplicateById(storage.getManufacturers());
    const allVehicles = deduplicateById(storage.getVehicles());
    const allEcus = deduplicateById(storage.getECUs());
    const allConnectors = deduplicateById(storage.getConnectors());
    const allFuseBoxes = deduplicateById(storage.getFuseBoxes());
    const allWiringDiagrams = deduplicateById(storage.getWiringDiagrams());
    const allMediaItems = deduplicateMediaList(storage.getMediaItems());
    const allAppImages = deduplicateById(storage.getImages());

    // Filter data FIRST based on backup type so counts and checksum accurately match the archived payload
    const data: BackupDataPayload['data'] = {
      manufacturers: type === 'images_only' ? [] : allManufacturers,
      vehicles: type === 'images_only' ? [] : allVehicles,
      ecus: type === 'images_only' ? [] : allEcus,
      connectors: type === 'images_only' ? [] : allConnectors,
      fuseBoxes: type === 'images_only' ? [] : allFuseBoxes,
      wiringDiagrams: allWiringDiagrams,
      mediaItems: allMediaItems,
      appImages: allAppImages
    };

    let pinsCount = 0;
    data.connectors.forEach(c => {
      pinsCount += c.pins?.length || 0;
    });

    let fusesCount = 0;
    let relaysCount = 0;
    data.fuseBoxes.forEach(fb => {
      fusesCount += fb.fuses?.length || 0;
      relaysCount += fb.relays?.length || 0;
    });

    const recordCounts: BackupManifest['recordCounts'] = {
      manufacturers: data.manufacturers.length,
      vehicles: data.vehicles.length,
      ecus: data.ecus.length,
      connectors: data.connectors.length,
      pins: pinsCount,
      fuseBoxes: data.fuseBoxes.length,
      fuses: fusesCount,
      relays: relaysCount,
      wiringDiagrams: data.wiringDiagrams.length,
      mediaItems: data.mediaItems.length,
      appImages: data.appImages.length
    };

    const now = new Date();
    const checksum = computePayloadChecksum(data);

    const manifest: BackupManifest = {
      appName: 'AutoPin Pro',
      version: '1.0.0',
      schemaVersion: BACKUP_SCHEMA_VERSION,
      backupType: type,
      createdAt: now.toISOString(),
      createdAtTimestamp: now.getTime(),
      authorEmail: authorEmail ? authorEmail.trim() : undefined,
      checksum,
      recordCounts,
      totalImagesCount: data.mediaItems.length + data.wiringDiagrams.length + data.appImages.length,
      description: 'پشتیبان اطلاعات فنی AutoPin Pro شامل اطلاعات تخصصی خودروها، ECU، سوکت‌ها، جعبه‌فیوزها و تصاویر'
    };

    return {
      manifest,
      data
    };
  }

  /**
   * Generates a packaged ZIP file containing structured JSON, media files, and manifest.
   */
  public async generateZipBackup(
    type: BackupType = 'full',
    authorEmail?: string,
    onProgress?: (progressPct: number, stageName: string) => void
  ): Promise<{ blob: Blob; fileName: string; sizeBytes: number; manifest: BackupManifest }> {
    onProgress?.(5, 'در حال گردآوری اطلاعات پایگاه داده...');
    const payload = this.collectCurrentData(type, authorEmail);

    const zip = new JSZip();
    onProgress?.(20, 'در حال سازمان‌دهی ساختار فایل پشتیبان...');

    // 1. Add manifest
    zip.file('manifest.json', JSON.stringify(payload.manifest, null, 2));

    // 2. Add technical report
    const faDate = new Intl.DateTimeFormat('fa-IR', {
      dateStyle: 'full',
      timeStyle: 'medium'
    }).format(new Date());

    const reportContent = `=====================================================
گزارش رسمی تهیه نسخه پشتیبان بانک اطلاعاتی AutoPin Pro
=====================================================
تاریخ ایجاد: ${faDate}
شناسه اعتبارسنجی: ${payload.manifest.checksum}
نسخه ساختار داده: ${payload.manifest.schemaVersion}
نوع نسخه: ${type === 'full' ? 'پشتیبان کامل (داده‌ها + تصاویر)' : type === 'data_only' ? 'پشتیبان سبک (فقط داده‌های فنی)' : 'پشتیبان تصاویر و نقشه‌ها'}
تهیه‌کننده: ${payload.manifest.authorEmail || 'مدیر سیستم'}

آمار رکوردهای ثبت‌شده:
- تعداد خودروها: ${payload.manifest.recordCounts.vehicles}
- تعداد ECUها: ${payload.manifest.recordCounts.ecus}
- تعداد سوکت‌ها: ${payload.manifest.recordCounts.connectors}
- تعداد کل پایه‌ها (پین‌ها): ${payload.manifest.recordCounts.pins}
- تعداد جعبه‌فیوزها: ${payload.manifest.recordCounts.fuseBoxes}
- تعداد فیوزها: ${payload.manifest.recordCounts.fuses}
- تعداد رله‌ها: ${payload.manifest.recordCounts.relays}
- تعداد نقشه‌های سیم‌کشی: ${payload.manifest.recordCounts.wiringDiagrams}
- تعداد تصاویر و مستندات فنی: ${payload.manifest.recordCounts.mediaItems}
- تعداد تصاویر داخلی برنامه: ${payload.manifest.recordCounts.appImages}
=====================================================
نکته امنیتی: اطلاعات ورود، رمزهای عبور و توکن‌ها در این فایل وارد نشده‌اند.
`;
    zip.file('backup_report.txt', reportContent);

    // 3. Database folder
    const dbFolder = zip.folder('database');
    if (dbFolder) {
      dbFolder.file('manufacturers.json', JSON.stringify(payload.data.manufacturers, null, 2));
      dbFolder.file('vehicles.json', JSON.stringify(payload.data.vehicles, null, 2));
      dbFolder.file('ecus.json', JSON.stringify(payload.data.ecus, null, 2));
      dbFolder.file('connectors.json', JSON.stringify(payload.data.connectors, null, 2));
      dbFolder.file('fuseBoxes.json', JSON.stringify(payload.data.fuseBoxes, null, 2));
      dbFolder.file('wiringDiagrams.json', JSON.stringify(payload.data.wiringDiagrams, null, 2));
      dbFolder.file('mediaItems.json', JSON.stringify(payload.data.mediaItems, null, 2));
      dbFolder.file('appImages.json', JSON.stringify(payload.data.appImages, null, 2));
    }

    // 4. Images folder (If full or images_only)
    if (type !== 'data_only') {
      onProgress?.(45, 'در حال پردازش و فشرده‌سازی فایل‌های تصویری...');
      const imagesFolder = zip.folder('images');
      if (imagesFolder) {
        let imgIdx = 0;
        const totalImgs = payload.data.mediaItems.length + payload.data.appImages.length;

        for (const media of payload.data.mediaItems) {
          if (media.fileUrl && media.fileUrl.startsWith('data:image')) {
            const parts = parseDataUrlParts(media.fileUrl);
            if (parts) {
              try {
                imagesFolder.file(`media_${media.id}.${parts.ext}`, parts.base64, { base64: true });
              } catch (err) {
                console.warn('Error archiving media item:', media.id, err);
              }
            }
          }
          imgIdx++;
          if (totalImgs > 0 && imgIdx % 5 === 0) {
            const pct = 45 + Math.round((imgIdx / totalImgs) * 35);
            onProgress?.(pct, `در حال بسته‌بندی تصویر ${imgIdx} از ${totalImgs}...`);
          }
        }

        for (const appImg of payload.data.appImages) {
          if (appImg.dataUrl && appImg.dataUrl.startsWith('data:image')) {
            const parts = parseDataUrlParts(appImg.dataUrl);
            if (parts) {
              try {
                imagesFolder.file(`app_img_${appImg.id}.${parts.ext}`, parts.base64, { base64: true });
              } catch (err) {
                console.warn('Error archiving app image:', appImg.id, err);
              }
            }
          }
        }
      }
    }

    onProgress?.(85, 'در حال تولید نهایی فایل فشرده ZIP...');

    const blob = await zip.generateAsync(
      {
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      },
      (metadata) => {
        const pct = 85 + Math.round((metadata.percent / 100) * 12);
        onProgress?.(pct, `در حال فشرده‌سازی نهایی: ${Math.round(metadata.percent)}%`);
      }
    );

    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `AutoPinPro-Backup-${type}-${dateStr}.zip`;

    this.saveLastBackupInfo({
      timestamp: Date.now(),
      formattedDate: faDate,
      backupType: type,
      fileName,
      fileSizeBytes: blob.size,
      recordCounts: payload.manifest.recordCounts
    });

    onProgress?.(100, 'فایل پشتیبان با موفقیت ساخته شد.');
    return {
      blob,
      fileName,
      sizeBytes: blob.size,
      manifest: payload.manifest
    };
  }

  /**
   * Generates a lightweight single JSON file.
   */
  public generateJsonBackup(
    type: BackupType = 'data_only',
    authorEmail?: string
  ): { jsonStr: string; fileName: string; sizeBytes: number; manifest: BackupManifest } {
    const payload = this.collectCurrentData(type, authorEmail);
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `AutoPinPro-Backup-${dateStr}.json`;

    const faDate = new Intl.DateTimeFormat('fa-IR', {
      dateStyle: 'full',
      timeStyle: 'medium'
    }).format(new Date());

    this.saveLastBackupInfo({
      timestamp: Date.now(),
      formattedDate: faDate,
      backupType: type,
      fileName,
      fileSizeBytes: blob.size,
      recordCounts: payload.manifest.recordCounts
    });

    return {
      jsonStr,
      fileName,
      sizeBytes: blob.size,
      manifest: payload.manifest
    };
  }

  private verifyManifestAndChecksum(
    payload: BackupDataPayload,
    isLegacyFlatJson: boolean
  ): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const manifest = payload.manifest;

    if (!manifest || typeof manifest !== 'object') {
      errors.push('فایل مانیفست (manifest) معتبر نیست.');
      return { errors, warnings };
    }

    if (manifest.appName && manifest.appName !== 'AutoPin Pro') {
      warnings.push('نام برنامه در فایل پشتیبان با AutoPin Pro یکسان نیست.');
    }

    const validTypes: BackupType[] = ['full', 'data_only', 'images_only'];
    if (!validTypes.includes(manifest.backupType)) {
      errors.push('نوع بسته پشتیبان (backupType) در مانیفست نامعتبر است.');
    }

    if (!payload.data || typeof payload.data !== 'object') {
      errors.push('بخش داده‌های (data) فایل پشتیبان وجود ندارد یا خراب است.');
      return { errors, warnings };
    }

    const collectionKeys: (keyof BackupDataPayload['data'])[] = [
      'manufacturers',
      'vehicles',
      'ecus',
      'connectors',
      'fuseBoxes',
      'wiringDiagrams',
      'mediaItems',
      'appImages'
    ];

    for (const key of collectionKeys) {
      const val = payload.data[key];
      if (val !== undefined && !Array.isArray(val)) {
        errors.push(`ساختار آرایه «${key}» در فایل پشتیبان خراب است.`);
      }
    }

    if (errors.length > 0) {
      return { errors, warnings };
    }

    // Schema field validation on entities
    if (payload.data.vehicles.some(v => !v || typeof v !== 'object' || !v.id || !(v.name || v.persianName))) {
      errors.push('برخی از رکوردهای خودرو در فایل پشتیبان فاقد شناسه یکتا یا نام معتبر هستند.');
    }
    if (payload.data.ecus.some(e => !e || typeof e !== 'object' || !e.id || !e.model)) {
      errors.push('برخی از رکوردهای ECU در فایل پشتیبان فاقد شناسه یا مدل معتبر هستند.');
    }
    if (payload.data.connectors.some(c => !c || typeof c !== 'object' || !c.id || !c.name)) {
      errors.push('برخی از سوکت‌ها در فایل پشتیبان فاقد عنوان یا شناسه معتبر هستند.');
    }
    if (payload.data.fuseBoxes.some(fb => !fb || typeof fb !== 'object' || !fb.id || !fb.name)) {
      errors.push('برخی از جعبه‌فیوزها در فایل پشتیبان فاقد عنوان یا شناسه معتبر هستند.');
    }
    if (payload.data.mediaItems.some(m => !m || typeof m !== 'object' || !m.id || (!m.fileUrl && !m.title))) {
      errors.push('برخی از مستندات تصویری در فایل پشتیبان ساختار نامعتبر دارند.');
    }
    if (payload.data.appImages.some(img => !img || typeof img !== 'object' || !img.id || !img.dataUrl)) {
      errors.push('برخی از تصاویر داخلی برنامه (appImages) ساختار نامعتبر دارند.');
    }

    // Strict Checksum Verification
    if (isLegacyFlatJson) {
      return { errors, warnings };
    }

    const declaredChecksum = (manifest.checksum || '').trim();
    if (!declaredChecksum || declaredChecksum === 'legacy-import') {
      errors.push('فایل پشتیبان فاقد کد اعتبارسنجی یکپارچگی (Checksum) معتبر است.');
      return { errors, warnings };
    }

    const expectedV220 = computePayloadChecksum(payload.data);
    if (declaredChecksum !== expectedV220) {
      let legacy210Valid = false;
      if (manifest.schemaVersion === '2.1.0') {
        const legacy210Raw = JSON.stringify({
          vehicles: payload.data.vehicles,
          connectors: payload.data.connectors,
          fuseBoxes: payload.data.fuseBoxes,
          ecus: payload.data.ecus
        });
        if (declaredChecksum === calculateLegacyChecksum(legacy210Raw)) {
          legacy210Valid = true;
        }
      }

      if (!legacy210Valid) {
        errors.push('کد اعتبارسنجی (Checksum) فایل پشتیبان مطابقت ندارد؛ فایل دستکاری شده یا آسیب دیده است.');
      }
    }

    return { errors, warnings };
  }

  /**
   * Pre-inspects and validates an uploaded backup file (either ZIP or JSON).
   */
  public async inspectAndValidateBackupFile(file: File): Promise<BackupIntegrityCheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    const isZip = file.name.toLowerCase().endsWith('.zip') || file.type.includes('zip');
    let payload: BackupDataPayload | null = null;
    let isLegacyFlatJson = false;

    if (isZip) {
      try {
        const zip = await JSZip.loadAsync(file);

        const manifestFile = zip.file('manifest.json');
        if (!manifestFile) {
          errors.push('فایل مانیفست (manifest.json) در بسته پشتیبان یافت نشد.');
        } else {
          const manifestJson = await manifestFile.async('text');
          const parsedManifest = JSON.parse(manifestJson) as BackupManifest;

          const readJsonFromZip = async <T>(path: string, required: boolean, fallback: T): Promise<T> => {
            const f = zip.file(path);
            if (!f) {
              if (required) {
                errors.push(`فایل ضروری ${path} در بسته پشتیبان یافت نشد.`);
              }
              return fallback;
            }
            try {
              const text = await f.async('text');
              return JSON.parse(text) as T;
            } catch {
              errors.push(`فایل ${path} خراب است و قابل بازخوانی نیست.`);
              return fallback;
            }
          };

          const manufacturers = await readJsonFromZip<Manufacturer[]>('database/manufacturers.json', false, []);
          const vehicles = await readJsonFromZip<Vehicle[]>('database/vehicles.json', true, []);
          const ecus = await readJsonFromZip<ECU[]>('database/ecus.json', true, []);
          const connectors = await readJsonFromZip<Connector[]>('database/connectors.json', true, []);
          const fuseBoxes = await readJsonFromZip<FuseBox[]>('database/fuseBoxes.json', true, []);
          const wiringDiagrams = await readJsonFromZip<WiringDiagram[]>('database/wiringDiagrams.json', false, []);
          const mediaItems = await readJsonFromZip<MediaItem[]>('database/mediaItems.json', false, []);
          const appImages = await readJsonFromZip<AppImage[]>('database/appImages.json', false, []);

          // Rehydrate & verify images present in images/ folder
          const imgFiles = zip.file(/^images\//);
          if (imgFiles.length > 0 && Array.isArray(mediaItems) && Array.isArray(appImages)) {
            for (const imgFile of imgFiles) {
              if (!imgFile.dir) {
                const base64 = (await imgFile.async('base64')).trim();
                const lowerName = imgFile.name.toLowerCase();
                const mime = lowerName.endsWith('.png')
                  ? 'png'
                  : lowerName.endsWith('.webp')
                  ? 'webp'
                  : lowerName.endsWith('.gif')
                  ? 'gif'
                  : 'jpeg';
                const reconstructedUrl = `data:image/${mime};base64,${base64}`;

                const mediaIdMatch = imgFile.name.match(/^images\/media_(.+)\.[^.]+$/);
                if (mediaIdMatch) {
                  const mediaId = mediaIdMatch[1];
                  const m = mediaItems.find(item => item && item.id === mediaId);
                  if (m) {
                    const existingBody = extractBase64Body(m.fileUrl);
                    if (!existingBody || existingBody !== base64) {
                      m.fileUrl = reconstructedUrl;
                    }
                  }
                  continue;
                }

                const appImgMatch = imgFile.name.match(/^images\/app_img_(.+)\.[^.]+$/);
                if (appImgMatch) {
                  const appImgId = appImgMatch[1];
                  const appImg = appImages.find(item => item && item.id === appImgId);
                  if (appImg) {
                    const existingBody = extractBase64Body(appImg.dataUrl);
                    if (!existingBody || existingBody !== base64) {
                      appImg.dataUrl = reconstructedUrl;
                    }
                  }
                }
              }
            }
          }

          payload = {
            manifest: parsedManifest,
            data: {
              manufacturers: Array.isArray(manufacturers) ? manufacturers : (manufacturers as any),
              vehicles: Array.isArray(vehicles) ? vehicles : (vehicles as any),
              ecus: Array.isArray(ecus) ? ecus : (ecus as any),
              connectors: Array.isArray(connectors) ? connectors : (connectors as any),
              fuseBoxes: Array.isArray(fuseBoxes) ? fuseBoxes : (fuseBoxes as any),
              wiringDiagrams: Array.isArray(wiringDiagrams) ? wiringDiagrams : (wiringDiagrams as any),
              mediaItems: Array.isArray(mediaItems) ? mediaItems : (mediaItems as any),
              appImages: Array.isArray(appImages) ? appImages : (appImages as any)
            }
          };
        }
      } catch (err: unknown) {
        errors.push(`خطا در باز کردن فایل فشرده ZIP: ${err instanceof Error ? err.message : 'فرمت نامعتبر'}`);
      }
    } else {
      // JSON File
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);

        if (parsed && typeof parsed === 'object' && parsed.manifest && parsed.data) {
          const d = parsed.data;
          payload = {
            manifest: parsed.manifest,
            data: {
              manufacturers: d.manufacturers ?? [],
              vehicles: d.vehicles ?? [],
              ecus: d.ecus ?? [],
              connectors: d.connectors ?? [],
              fuseBoxes: d.fuseBoxes ?? [],
              wiringDiagrams: d.wiringDiagrams ?? [],
              mediaItems: d.mediaItems ?? [],
              appImages: d.appImages ?? []
            }
          };
        } else if (
          parsed &&
          typeof parsed === 'object' &&
          (Array.isArray(parsed.vehicles) || Array.isArray(parsed.connectors) || Array.isArray(parsed.fuseboxes) || Array.isArray(parsed.fuseBoxes))
        ) {
          isLegacyFlatJson = true;
          const v = parsed.vehicles || [];
          const c = parsed.connectors || [];
          const fb = parsed.fuseboxes || parsed.fuseBoxes || [];
          const e = parsed.ecus || [];

          warnings.push('این فایل از قالب نسخه قبلی برنامه (Legacy JSON) است و به ساختار جدید تبدیل خواهد شد.');

          payload = {
            manifest: {
              appName: 'AutoPin Pro',
              version: '1.0.0',
              schemaVersion: '1.0.0',
              backupType: 'data_only',
              createdAt: parsed.exportedAt || new Date().toISOString(),
              createdAtTimestamp: Date.now(),
              checksum: 'legacy-import',
              recordCounts: {
                manufacturers: (parsed.manufacturers || []).length,
                vehicles: v.length,
                ecus: e.length,
                connectors: c.length,
                pins: 0,
                fuseBoxes: fb.length,
                fuses: 0,
                relays: 0,
                wiringDiagrams: (parsed.diagrams || []).length,
                mediaItems: 0,
                appImages: (parsed.images || []).length
              },
              totalImagesCount: (parsed.images || []).length,
              description: 'ورود اطلاعات از نسخه قبلی'
            },
            data: {
              manufacturers: parsed.manufacturers || [],
              vehicles: v,
              ecus: e,
              connectors: c,
              fuseBoxes: fb,
              wiringDiagrams: parsed.diagrams || [],
              mediaItems: [],
              appImages: parsed.images || []
            }
          };
        } else {
          errors.push('ساختار فایل JSON با استانداردهای AutoPin Pro مطابقت ندارد.');
        }
      } catch (err: unknown) {
        errors.push(`خطا در پردازش فایل JSON: ${err instanceof Error ? err.message : 'فرمت نامعتبر'}`);
      }
    }

    if (!payload) {
      return {
        isValid: false,
        manifest: {
          appName: 'AutoPin Pro',
          version: '1.0.0',
          schemaVersion: BACKUP_SCHEMA_VERSION,
          backupType: 'data_only',
          createdAt: new Date().toISOString(),
          createdAtTimestamp: Date.now(),
          checksum: '',
          recordCounts: {
            manufacturers: 0,
            vehicles: 0,
            ecus: 0,
            connectors: 0,
            pins: 0,
            fuseBoxes: 0,
            fuses: 0,
            relays: 0,
            wiringDiagrams: 0,
            mediaItems: 0,
            appImages: 0
          },
          totalImagesCount: 0,
          description: 'فایل نامعتبر'
        },
        warnings,
        errors,
        conflicts: {
          newVehicles: 0,
          existingVehicles: 0,
          newConnectors: 0,
          existingConnectors: 0,
          newFuseBoxes: 0,
          existingFuseBoxes: 0,
          newEcus: 0,
          existingEcus: 0
        },
        payload: {
          manifest: {} as BackupManifest,
          data: {
            manufacturers: [],
            vehicles: [],
            ecus: [],
            connectors: [],
            fuseBoxes: [],
            wiringDiagrams: [],
            mediaItems: [],
            appImages: []
          }
        }
      };
    }

    const integrity = this.verifyManifestAndChecksum(payload, isLegacyFlatJson);
    errors.push(...integrity.errors);
    warnings.push(...integrity.warnings);

    // Deep Integrity & Relational Conflict Calculation (safe against invalid non-array fields)
    const currentVehicles = storage.getVehicles();
    const currentConnectors = storage.getConnectors();
    const currentFuseBoxes = storage.getFuseBoxes();
    const currentEcus = storage.getECUs();

    let newVeh = 0;
    let existVeh = 0;
    if (Array.isArray(payload.data.vehicles)) {
      payload.data.vehicles.forEach(v => {
        if (!v) return;
        const vName = (v.name || '').toLowerCase();
        if (currentVehicles.some(cv => cv.id === v.id || (vName && (cv.name || '').toLowerCase() === vName))) {
          existVeh++;
        } else {
          newVeh++;
        }
      });
    }

    let newConn = 0;
    let existConn = 0;
    if (Array.isArray(payload.data.connectors)) {
      payload.data.connectors.forEach(c => {
        if (!c) return;
        if (currentConnectors.some(cc => cc.id === c.id)) {
          existConn++;
        } else {
          newConn++;
        }
      });
    }

    let newFb = 0;
    let existFb = 0;
    if (Array.isArray(payload.data.fuseBoxes)) {
      payload.data.fuseBoxes.forEach(fb => {
        if (!fb) return;
        if (currentFuseBoxes.some(cfb => cfb.id === fb.id)) {
          existFb++;
        } else {
          newFb++;
        }
      });
    }

    let newE = 0;
    let existE = 0;
    if (Array.isArray(payload.data.ecus)) {
      payload.data.ecus.forEach(e => {
        if (!e) return;
        if (currentEcus.some(ce => ce.id === e.id)) {
          existE++;
        } else {
          newE++;
        }
      });
    }

    return {
      isValid: errors.length === 0,
      manifest: payload.manifest,
      warnings,
      errors,
      conflicts: {
        newVehicles: newVeh,
        existingVehicles: existVeh,
        newConnectors: newConn,
        existingConnectors: existConn,
        newFuseBoxes: newFb,
        existingFuseBoxes: existFb,
        newEcus: newE,
        existingEcus: existE
      },
      payload
    };
  }

  /**
   * Executes the restoration process either as Smart Merge or Complete Overwrite,
   * with strict pre-mutation integrity check and rollback on error.
   */
  public async executeRestore(
    payload: BackupDataPayload,
    mode: 'merge' | 'overwrite',
    isAdmin: boolean,
    isOnlineDbConnected: boolean,
    onProgress?: (progressPct: number, statusText: string) => void
  ): Promise<{
    success: boolean;
    summary: string;
    stats: {
      added: number;
      updated: number;
      skipped: number;
    };
  }> {
    // Re-verify integrity before mutating anything
    const isLegacyFlat = payload?.manifest?.schemaVersion === '1.0.0' && payload?.manifest?.checksum === 'legacy-import';
    const precheck = this.verifyManifestAndChecksum(payload, isLegacyFlat);
    if (precheck.errors.length > 0) {
      throw new Error(precheck.errors[0]);
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;

    const scope: 'full' | 'images_only' = payload.manifest.backupType === 'images_only' ? 'images_only' : 'full';
    const rollbackSnapshot = storage.captureTechnicalDataSnapshot();

    // If overwrite mode, automatically create safety snapshot first before any mutations
    if (mode === 'overwrite') {
      onProgress?.(5, 'در حال تهیه نسخه پشتیبان اضطراری پیش از جایگزینی کامل...');
      this.createSafetySnapshot('پشتیبان خودکار پیش از جایگزینی کامل اطلاعات');
    }

    onProgress?.(15, 'در حال آماده‌سازی و یکتاسازی داده‌های پشتیبان...');

    const incomingRaw = payload.data;
    const dedupData: BackupDataPayload['data'] = {
      manufacturers: scope === 'images_only' ? [] : deduplicateById(incomingRaw.manufacturers || []),
      vehicles: scope === 'images_only' ? [] : deduplicateById(incomingRaw.vehicles || []),
      ecus: scope === 'images_only' ? [] : deduplicateById(incomingRaw.ecus || []),
      connectors: scope === 'images_only' ? [] : deduplicateById(incomingRaw.connectors || []),
      fuseBoxes: scope === 'images_only' ? [] : deduplicateById(incomingRaw.fuseBoxes || []),
      wiringDiagrams: deduplicateById(incomingRaw.wiringDiagrams || []),
      mediaItems: deduplicateMediaList(incomingRaw.mediaItems || []),
      appImages: deduplicateById(incomingRaw.appImages || [])
    };

    try {
      if (mode === 'overwrite') {
        const prevManIds = new Set(rollbackSnapshot.manufacturers.map(x => x.id));
        const prevVehIds = new Set(rollbackSnapshot.vehicles.map(x => x.id));
        const prevEcuIds = new Set(rollbackSnapshot.ecus.map(x => x.id));
        const prevConnIds = new Set(rollbackSnapshot.connectors.map(x => x.id));
        const prevFbIds = new Set(rollbackSnapshot.fuseBoxes.map(x => x.id));
        const prevDiagIds = new Set(rollbackSnapshot.wiringDiagrams.map(x => x.id));
        const prevMediaIds = new Set(rollbackSnapshot.mediaItems.map(x => x.id));
        const prevAppImgIds = new Set(rollbackSnapshot.appImages.map(x => x.id));

        const countSetDiff = <T extends { id: string }>(items: T[], prevIds: Set<string>) => {
          for (const item of items) {
            if (prevIds.has(item.id)) updated++;
            else added++;
          }
        };

        if (scope === 'full') {
          countSetDiff(dedupData.manufacturers, prevManIds);
          countSetDiff(dedupData.vehicles, prevVehIds);
          countSetDiff(dedupData.ecus, prevEcuIds);
          countSetDiff(dedupData.connectors, prevConnIds);
          countSetDiff(dedupData.fuseBoxes, prevFbIds);
        }
        countSetDiff(dedupData.wiringDiagrams, prevDiagIds);
        countSetDiff(dedupData.mediaItems, prevMediaIds);
        countSetDiff(dedupData.appImages, prevAppImgIds);

        onProgress?.(45, 'در حال جایگزینی کامل جداول محلی...');
        storage.replaceCollectionsForRestore(dedupData, scope);

        if (isAdmin && isOnlineDbConnected) {
          onProgress?.(70, 'در حال همگام‌سازی جایگزینی کامل با سرور ابری...');
          const newDiagIds = new Set(dedupData.wiringDiagrams.map(x => x.id));
          const newMediaIds = new Set(dedupData.mediaItems.map(x => x.id));

          if (scope === 'full') {
            const newVehIds = new Set(dedupData.vehicles.map(x => x.id));
            const newEcuIds = new Set(dedupData.ecus.map(x => x.id));
            const newConnIds = new Set(dedupData.connectors.map(x => x.id));
            const newFbIds = new Set(dedupData.fuseBoxes.map(x => x.id));

            for (const oldFb of rollbackSnapshot.fuseBoxes) {
              if (!newFbIds.has(oldFb.id)) {
                await onlineStorage.deleteFuseBox(oldFb.id);
              }
            }
            for (const oldConn of rollbackSnapshot.connectors) {
              if (!newConnIds.has(oldConn.id)) {
                await onlineStorage.deleteConnector(oldConn.id);
              }
            }
            for (const oldEcu of rollbackSnapshot.ecus) {
              if (!newEcuIds.has(oldEcu.id)) {
                await onlineStorage.deleteECU(oldEcu.id);
              }
            }
            for (const oldVeh of rollbackSnapshot.vehicles) {
              if (!newVehIds.has(oldVeh.id)) {
                await onlineStorage.deleteVehicle(oldVeh.id);
              }
            }
          }

          for (const oldDiag of rollbackSnapshot.wiringDiagrams) {
            if (!newDiagIds.has(oldDiag.id)) {
              await onlineStorage.deleteWiringDiagram(oldDiag.id);
            }
          }
          for (const oldMedia of rollbackSnapshot.mediaItems) {
            if (!newMediaIds.has(oldMedia.id)) {
              await onlineStorage.deleteMedia(oldMedia.id);
            }
          }

          if (scope === 'full') {
            for (const m of dedupData.manufacturers) await onlineStorage.saveManufacturer(m);
            for (const v of dedupData.vehicles) await onlineStorage.saveVehicle(v);
            for (const e of dedupData.ecus) await onlineStorage.saveECU(e);
            for (const c of dedupData.connectors) await onlineStorage.saveConnector(c);
            for (const fb of dedupData.fuseBoxes) await onlineStorage.saveFuseBox(fb);
          }
          for (const diag of dedupData.wiringDiagrams) await onlineStorage.saveWiringDiagram(diag);
          for (const media of dedupData.mediaItems) await onlineStorage.saveMedia(media);
        }
      } else {
        // SMART MERGE MODE: Add new records & update matched IDs, keep unrelated local data untouched
        const existingManIds = new Set(storage.getManufacturers().map(x => x.id));
        if (dedupData.manufacturers.length > 0) {
          for (const m of dedupData.manufacturers) {
            storage.saveManufacturer(m);
            if (isAdmin && isOnlineDbConnected) {
              await onlineStorage.saveManufacturer(m);
            }
            if (existingManIds.has(m.id)) updated++;
            else {
              existingManIds.add(m.id);
              added++;
            }
          }
        }

        if (dedupData.vehicles.length > 0) {
          onProgress?.(30, 'در حال ادغام خودروها و مشخصات موتورها...');
          const existingVehIds = new Set(storage.getVehicles().map(v => v.id));
          for (const veh of dedupData.vehicles) {
            const exists = existingVehIds.has(veh.id);
            storage.saveVehicle(veh);
            if (isAdmin && isOnlineDbConnected) {
              await onlineStorage.saveVehicle(veh);
            }
            if (exists) updated++;
            else {
              existingVehIds.add(veh.id);
              added++;
            }
          }
        }

        if (dedupData.ecus.length > 0) {
          onProgress?.(48, 'در حال ادغام اطلاعات ECUها...');
          const existingEcuIds = new Set(storage.getECUs().map(e => e.id));
          for (const ecu of dedupData.ecus) {
            const exists = existingEcuIds.has(ecu.id);
            storage.saveECU(ecu);
            if (isAdmin && isOnlineDbConnected) {
              await onlineStorage.saveECU(ecu);
            }
            if (exists) updated++;
            else {
              existingEcuIds.add(ecu.id);
              added++;
            }
          }
        }

        if (dedupData.connectors.length > 0) {
          onProgress?.(65, 'در حال ادغام سوکت‌ها و نقشه‌های پین‌اوت...');
          const existingConnIds = new Set(storage.getConnectors().map(c => c.id));
          for (const conn of dedupData.connectors) {
            const exists = existingConnIds.has(conn.id);
            storage.saveConnector(conn);
            if (isAdmin && isOnlineDbConnected) {
              await onlineStorage.saveConnector(conn);
            }
            if (exists) updated++;
            else {
              existingConnIds.add(conn.id);
              added++;
            }
          }
        }

        if (dedupData.fuseBoxes.length > 0) {
          onProgress?.(80, 'در حال ادغام جعبه‌فیوزها، فیوزها و رله‌ها...');
          const existingFbIds = new Set(storage.getFuseBoxes().map(f => f.id));
          for (const fb of dedupData.fuseBoxes) {
            const exists = existingFbIds.has(fb.id);
            storage.saveFuseBox(fb);
            if (isAdmin && isOnlineDbConnected) {
              await onlineStorage.saveFuseBox(fb);
            }
            if (exists) updated++;
            else {
              existingFbIds.add(fb.id);
              added++;
            }
          }
        }

        if (dedupData.wiringDiagrams.length > 0) {
          onProgress?.(88, 'در حال ادغام نقشه‌های سیم‌کشی...');
          const existingDiagIds = new Set(storage.getWiringDiagrams().map(d => d.id));
          for (const diag of dedupData.wiringDiagrams) {
            const exists = existingDiagIds.has(diag.id);
            storage.saveWiringDiagram(diag);
            if (isAdmin && isOnlineDbConnected) {
              await onlineStorage.saveWiringDiagram(diag);
            }
            if (exists) updated++;
            else {
              existingDiagIds.add(diag.id);
              added++;
            }
          }
        }

        if (dedupData.mediaItems.length > 0) {
          onProgress?.(94, 'در حال ادغام تصاویر و مستندات فنی...');
          const existingMediaIds = new Set(storage.getMediaItems().map(m => m.id));
          for (const media of dedupData.mediaItems) {
            const exists = existingMediaIds.has(media.id);
            storage.saveMediaItem(media);
            if (isAdmin && isOnlineDbConnected) {
              await onlineStorage.saveMedia(media);
            }
            if (exists) updated++;
            else {
              existingMediaIds.add(media.id);
              added++;
            }
          }
        }

        if (dedupData.appImages.length > 0) {
          onProgress?.(97, 'در حال بازیابی تصاویر داخلی برنامه...');
          const existingImgIds = new Set(storage.getImages().map(img => img.id));
          for (const appImg of dedupData.appImages) {
            const exists = existingImgIds.has(appImg.id);
            storage.saveImage(appImg);
            if (exists) updated++;
            else {
              existingImgIds.add(appImg.id);
              added++;
            }
          }
        }
      }
    } catch (restoreErr) {
      storage.restoreTechnicalDataSnapshot(rollbackSnapshot);
      throw restoreErr;
    }

    onProgress?.(100, 'بازیابی اطلاعات با موفقیت به پایان رسید.');

    return {
      success: true,
      summary: `عملیات بازیابی با موفقیت انجام شد: ${added} رکورد جدید اضافه شد، ${updated} رکورد به‌روزرسانی شد${skipped > 0 ? ` و ${skipped} مورد رد شد` : ''}.`,
      stats: { added, updated, skipped }
    };
  }
}

export const backupService = new BackupService();
