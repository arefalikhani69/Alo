import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  type Firestore
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  db,
  functionsInstance,
  handleFirestoreError,
  OperationType
} from './firebase';
import {
  Vehicle,
  Connector,
  FuseBox,
  WiringDiagram,
  MediaItem,
  Manufacturer,
  ECU,
  AppUserProfile,
  AppUserRole,
  AuditLogEntry
} from '../types';
import {
  SEED_MANUFACTURERS,
  SEED_VEHICLES,
  SEED_ECUS,
  SEED_CONNECTORS,
  SEED_FUSEBOXES,
  SEED_WIRING_DIAGRAMS
} from '../data/seedData';
import { storage } from './storage';
import { deduplicateMediaList } from '../utils/imageDeduplication';

export type TechnicalCollectionKey =
  | 'manufacturers'
  | 'vehicles'
  | 'ecus'
  | 'connectors'
  | 'fuseBoxes'
  | 'wiringDiagrams'
  | 'media';

export type SyncFailureCategory = 'permission_denied' | 'network_offline' | 'unknown';

export interface CollectionSyncDetail {
  collection: TechnicalCollectionKey;
  labelFa: string;
  status: 'synced' | 'failed';
  count: number;
  category?: SyncFailureCategory;
  error?: string;
}

export interface CloudSyncResult {
  success: boolean;
  partial: boolean;
  syncedCollections: string[];
  failedCollections: { collection: string; error: string; category?: SyncFailureCategory }[];
  collectionDetails: CollectionSyncDetail[];
  syncedAt: number;
  counts: {
    manufacturers: number;
    vehicles: number;
    ecus: number;
    connectors: number;
    fuseBoxes: number;
    wiringDiagrams: number;
    media: number;
  };
}

export const TECHNICAL_COLLECTION_LABELS_FA: Record<TechnicalCollectionKey, string> = {
  manufacturers: 'خودروسازان',
  vehicles: 'خودروها و موتورها',
  ecus: 'ECUها',
  connectors: 'سوکت‌ها و پین‌آوت‌ها',
  fuseBoxes: 'جعبه‌فیوزها و رله‌ها',
  wiringDiagrams: 'نقشه‌های سیم‌کشی',
  media: 'تصاویر و فایل‌ها'
};

function categorizeSyncError(err: unknown): { category: SyncFailureCategory; message: string } {
  const code = (err as { code?: string })?.code || '';
  const msg = err instanceof Error ? err.message : String(err || 'خطای همگام‌سازی');
  const lower = `${code} ${msg}`.toLowerCase();

  if (lower.includes('permission-denied') || lower.includes('insufficient permissions')) {
    return { category: 'permission_denied', message: msg };
  }
  if (
    lower.includes('unavailable') ||
    lower.includes('offline') ||
    lower.includes('network') ||
    lower.includes('failed to fetch') ||
    lower.includes('deadline-exceeded')
  ) {
    return { category: 'network_offline', message: msg };
  }
  return { category: 'unknown', message: msg };
}

/**
 * Recursively strips keys with `undefined` values from an object,
 * because Cloud Firestore setDoc/updateDoc strictly disallows `undefined`.
 */
export function sanitizeForFirestore<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }
  if (Array.isArray(data)) {
    return data
      .filter((item) => item !== undefined)
      .map((item) => sanitizeForFirestore(item)) as unknown as T;
  }
  if (typeof data === 'object' && !(data instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (value !== undefined) {
        result[key] = sanitizeForFirestore(value);
      }
    }
    return result as T;
  }
  return data;
}

export class OnlineStorageService {
  constructor(private readonly firestoreDb: Firestore = db) {}

  // --- Manufacturers ---
  public async getManufacturers(includeDrafts = false, throwOnError = false): Promise<Manufacturer[]> {
    const path = 'manufacturers';
    try {
      const q = includeDrafts
        ? query(collection(this.firestoreDb, path))
        : query(collection(this.firestoreDb, path), where('status', 'in', ['published', 'verified']));

      const snap = await getDocs(q);
      const list: Manufacturer[] = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data() as Manufacturer);
      });
      return list;
    } catch (err) {
      if (throwOnError) throw err;
      console.warn('Failed to fetch manufacturers from Firestore, falling back to local:', err);
      return [];
    }
  }

  public async saveManufacturer(man: Manufacturer): Promise<void> {
    const path = `manufacturers/${man.id}`;
    try {
      const sanitized = sanitizeForFirestore({
        ...man,
        status: man.status || 'published',
        updatedAt: Date.now()
      });
      await setDoc(doc(this.firestoreDb, 'manufacturers', man.id), sanitized);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }

  // --- Vehicles ---
  public async getVehicles(includeDrafts = false, throwOnError = false): Promise<Vehicle[]> {
    const path = 'vehicles';
    try {
      const q = includeDrafts
        ? query(collection(this.firestoreDb, path))
        : query(collection(this.firestoreDb, path), where('status', 'in', ['published', 'verified']));

      const snap = await getDocs(q);
      const list: Vehicle[] = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data() as Vehicle);
      });
      return list;
    } catch (err) {
      if (throwOnError) throw err;
      console.warn('Failed to fetch vehicles from Firestore, falling back to local:', err);
      return [];
    }
  }

  public async saveVehicle(vehicle: Vehicle): Promise<void> {
    const path = `vehicles/${vehicle.id}`;
    try {
      const sanitized = sanitizeForFirestore({
        ...vehicle,
        status: vehicle.status || 'published',
        updatedAt: Date.now()
      });
      await setDoc(doc(this.firestoreDb, 'vehicles', vehicle.id), sanitized);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }

  public async deleteVehicle(id: string): Promise<void> {
    const path = `vehicles/${id}`;
    try {
      await deleteDoc(doc(this.firestoreDb, 'vehicles', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }

  // --- Connectors ---
  public async getConnectors(vehicleId?: string, includeDrafts = false, throwOnError = false): Promise<Connector[]> {
    const path = 'connectors';
    try {
      const q = includeDrafts
        ? query(collection(this.firestoreDb, path))
        : query(collection(this.firestoreDb, path), where('status', 'in', ['published', 'verified']));
      const snap = await getDocs(q);
      let list: Connector[] = [];
      snap.forEach(docSnap => {
        const item = docSnap.data() as Connector;
        list.push(item);
      });

      if (!includeDrafts) {
        list = list.filter(c => c.status === 'published' || c.status === 'verified');
      }

      if (vehicleId) {
        list = list.filter(c => c.vehicleId === vehicleId);
      }
      return list;
    } catch (err) {
      if (throwOnError) throw err;
      console.warn('Failed to fetch connectors from Firestore:', err);
      return [];
    }
  }

  public async saveConnector(connector: Connector): Promise<void> {
    const path = `connectors/${connector.id}`;
    try {
      const sanitized = sanitizeForFirestore({
        ...connector,
        status: connector.status || 'published',
        updatedAt: Date.now()
      });
      await setDoc(doc(this.firestoreDb, 'connectors', connector.id), sanitized);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }

  public async deleteConnector(id: string): Promise<void> {
    const path = `connectors/${id}`;
    try {
      await deleteDoc(doc(this.firestoreDb, 'connectors', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }

  // --- FuseBoxes ---
  public async getFuseBoxes(vehicleId?: string, includeDrafts = false, throwOnError = false): Promise<FuseBox[]> {
    const path = 'fuseBoxes';
    try {
      const q = includeDrafts
        ? query(collection(this.firestoreDb, path))
        : query(collection(this.firestoreDb, path), where('status', 'in', ['published', 'verified']));
      const snap = await getDocs(q);
      let list: FuseBox[] = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data() as FuseBox);
      });

      if (!includeDrafts) {
        list = list.filter(fb => fb.status === 'published' || fb.status === 'verified');
      }
      if (vehicleId) {
        list = list.filter(fb => fb.vehicleId === vehicleId);
      }
      return list;
    } catch (err) {
      if (throwOnError) throw err;
      console.warn('Failed to fetch fuse boxes from Firestore:', err);
      return [];
    }
  }

  public async saveFuseBox(fuseBox: FuseBox): Promise<void> {
    const path = `fuseBoxes/${fuseBox.id}`;
    try {
      const sanitized = sanitizeForFirestore({
        ...fuseBox,
        status: fuseBox.status || 'published',
        updatedAt: Date.now()
      });
      await setDoc(doc(this.firestoreDb, 'fuseBoxes', fuseBox.id), sanitized);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }

  public async deleteFuseBox(id: string): Promise<void> {
    const path = `fuseBoxes/${id}`;
    try {
      await deleteDoc(doc(this.firestoreDb, 'fuseBoxes', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }

  // --- Wiring Diagrams ---
  public async getWiringDiagrams(vehicleId?: string, includeDrafts = false, throwOnError = false): Promise<WiringDiagram[]> {
    const path = 'wiringDiagrams';
    try {
      const q = includeDrafts
        ? query(collection(this.firestoreDb, path))
        : query(collection(this.firestoreDb, path), where('status', 'in', ['published', 'verified']));
      const snap = await getDocs(q);
      let list: WiringDiagram[] = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data() as WiringDiagram);
      });
      if (!includeDrafts) {
        list = list.filter(d => d.status === 'published' || d.status === 'verified');
      }
      if (vehicleId) {
        list = list.filter(d => d.vehicleId === vehicleId);
      }
      return list;
    } catch (err) {
      if (throwOnError) throw err;
      console.warn('Failed to fetch wiring diagrams from Firestore:', err);
      return [];
    }
  }

  public async saveWiringDiagram(diagram: WiringDiagram): Promise<void> {
    const path = `wiringDiagrams/${diagram.id}`;
    try {
      const sanitized = sanitizeForFirestore({
        ...diagram,
        status: diagram.status || 'published',
        updatedAt: Date.now()
      });
      await setDoc(doc(this.firestoreDb, 'wiringDiagrams', diagram.id), sanitized);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }

  public async deleteWiringDiagram(id: string): Promise<void> {
    const path = `wiringDiagrams/${id}`;
    try {
      await deleteDoc(doc(this.firestoreDb, 'wiringDiagrams', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }

  // --- ECUs ---
  public async getECUs(vehicleId?: string, includeDrafts = false, throwOnError = false): Promise<ECU[]> {
    const path = 'ecus';
    try {
      const q = includeDrafts
        ? query(collection(this.firestoreDb, path))
        : query(collection(this.firestoreDb, path), where('status', 'in', ['published', 'verified']));
      const snap = await getDocs(q);
      let list: ECU[] = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data() as ECU);
      });
      if (!includeDrafts) {
        list = list.filter(e => e.status === 'published' || e.status === 'verified');
      }
      if (vehicleId) {
        list = list.filter(e => e.vehicleId === vehicleId);
      }
      return list;
    } catch (err) {
      if (throwOnError) throw err;
      console.warn('Failed to fetch ECUs from Firestore:', err);
      return [];
    }
  }

  public async saveECU(ecu: ECU): Promise<void> {
    const path = `ecus/${ecu.id}`;
    try {
      const sanitized = sanitizeForFirestore({
        ...ecu,
        status: ecu.status || 'published',
        updatedAt: Date.now()
      });
      await setDoc(doc(this.firestoreDb, 'ecus', ecu.id), sanitized);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }

  public async deleteECU(id: string): Promise<void> {
    const path = `ecus/${id}`;
    try {
      await deleteDoc(doc(this.firestoreDb, 'ecus', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }

  // --- Media & Photos ---
  public async getMediaCloud(entityId?: string, includeDrafts = false): Promise<MediaItem[]> {
    const path = 'media';
    const snap = await getDocs(collection(this.firestoreDb, path));
    let cloudList: MediaItem[] = [];
    snap.forEach(docSnap => {
      cloudList.push(docSnap.data() as MediaItem);
    });
    if (!includeDrafts) {
      cloudList = cloudList.filter(m => m.status === 'published' || m.status === 'verified' || !m.status);
    }
    if (entityId) {
      cloudList = cloudList.filter(m => m.entityId === entityId);
    }
    return deduplicateMediaList(cloudList);
  }

  public async getMedia(entityId?: string, includeDrafts = false): Promise<MediaItem[]> {
    const localMedia = storage.getMediaItems(entityId);
    try {
      const filteredCloud = await this.getMediaCloud(entityId, includeDrafts);
      // Merge local and cloud media using content-based canonical deduplication
      const combined = [...localMedia, ...filteredCloud];
      return deduplicateMediaList(combined);
    } catch (err) {
      console.warn('Error fetching media from firestore (using local cache):', err);
      return deduplicateMediaList(localMedia);
    }
  }

  public async saveMedia(media: MediaItem): Promise<void> {
    // 1. Always persist to localStorage first so it survives reloads & offline usage
    storage.saveMediaItem(media);

    // 2. Persist to Firestore if online
    const path = `media/${media.id}`;
    try {
      const sanitized = sanitizeForFirestore({
        ...media,
        description: media.description || '',
        source: media.source || '',
        status: media.status || 'published',
        createdAt: media.createdAt || Date.now(),
        updatedAt: Date.now()
      });
      await setDoc(doc(this.firestoreDb, 'media', media.id), sanitized);
    } catch (err) {
      console.warn('Firestore saveMedia error, persisted in local storage:', err);
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }

  public async deleteMedia(id: string): Promise<void> {
    const path = `media/${id}`;
    try {
      await deleteDoc(doc(this.firestoreDb, 'media', id));
      storage.deleteMediaItem(id);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }

  // --- Full Technical Initial & Reconnect Sync ---
  public async syncAllTechnicalData(
    includeDrafts: boolean,
    targetStorage: typeof storage = storage
  ): Promise<CloudSyncResult> {
    const entries: { key: TechnicalCollectionKey; run: () => Promise<unknown[]> }[] = [
      { key: 'manufacturers', run: () => this.getManufacturers(includeDrafts, true) },
      { key: 'vehicles', run: () => this.getVehicles(includeDrafts, true) },
      { key: 'ecus', run: () => this.getECUs(undefined, includeDrafts, true) },
      { key: 'connectors', run: () => this.getConnectors(undefined, includeDrafts, true) },
      { key: 'fuseBoxes', run: () => this.getFuseBoxes(undefined, includeDrafts, true) },
      { key: 'wiringDiagrams', run: () => this.getWiringDiagrams(undefined, includeDrafts, true) },
      { key: 'media', run: () => this.getMediaCloud(undefined, includeDrafts) }
    ];

    const settled = await Promise.allSettled(entries.map(item => item.run()));

    const syncedCollections: string[] = [];
    const failedCollections: { collection: string; error: string; category?: SyncFailureCategory }[] = [];
    const collectionDetails: CollectionSyncDetail[] = [];
    const counts: CloudSyncResult['counts'] = {
      manufacturers: 0,
      vehicles: 0,
      ecus: 0,
      connectors: 0,
      fuseBoxes: 0,
      wiringDiagrams: 0,
      media: 0
    };

    settled.forEach((result, index) => {
      const colName = entries[index].key;
      const labelFa = TECHNICAL_COLLECTION_LABELS_FA[colName];

      if (result.status === 'fulfilled') {
        const list = result.value;
        counts[colName] = list.length;
        syncedCollections.push(colName);
        collectionDetails.push({
          collection: colName,
          labelFa,
          status: 'synced',
          count: list.length
        });

        if (colName === 'manufacturers') targetStorage.mergeCloudManufacturers(list as Manufacturer[]);
        else if (colName === 'vehicles') targetStorage.mergeCloudVehicles(list as Vehicle[]);
        else if (colName === 'ecus') targetStorage.mergeCloudECUs(list as ECU[]);
        else if (colName === 'connectors') targetStorage.mergeCloudConnectors(list as Connector[]);
        else if (colName === 'fuseBoxes') targetStorage.mergeCloudFuseBoxes(list as FuseBox[]);
        else if (colName === 'wiringDiagrams') targetStorage.mergeCloudWiringDiagrams(list as WiringDiagram[]);
        else if (colName === 'media') targetStorage.mergeCloudMediaItems(list as MediaItem[]);
      } else {
        const { category, message } = categorizeSyncError(result.reason);
        failedCollections.push({ collection: colName, error: message, category });
        collectionDetails.push({
          collection: colName,
          labelFa,
          status: 'failed',
          count: 0,
          category,
          error: message
        });
      }
    });

    return {
      success: failedCollections.length === 0,
      partial: syncedCollections.length > 0 && failedCollections.length > 0,
      syncedCollections,
      failedCollections,
      collectionDetails,
      syncedAt: Date.now(),
      counts
    };
  }

  /**
   * Pushes local technical records across all 7 collections to Cloud Firestore.
   * Requires verified active /admins/{uid} document on the server.
   * Uses Promise.allSettled per collection so one failing collection never drops others.
   */
  public async syncLocalTechnicalDataToCloud(
    targetStorage: typeof storage = storage
  ): Promise<CloudSyncResult> {
    const pushItems = async <T extends { id: string }>(
      colName: string,
      items: T[],
      transform?: (item: T) => Record<string, unknown>
    ): Promise<number> => {
      let pushed = 0;
      for (const item of items) {
        if (!item?.id) continue;
        const payload = sanitizeForFirestore(
          transform
            ? transform(item)
            : {
                ...item,
                status: (item as { status?: string }).status || 'published',
                updatedAt: (item as { updatedAt?: number }).updatedAt || Date.now()
              }
        );
        await setDoc(doc(this.firestoreDb, colName, item.id), payload, { merge: true });
        pushed++;
      }
      return pushed;
    };

    const tasks: { key: TechnicalCollectionKey; run: () => Promise<number> }[] = [
      { key: 'manufacturers', run: () => pushItems('manufacturers', targetStorage.getManufacturers()) },
      { key: 'vehicles', run: () => pushItems('vehicles', targetStorage.getVehicles()) },
      { key: 'ecus', run: () => pushItems('ecus', targetStorage.getECUs()) },
      { key: 'connectors', run: () => pushItems('connectors', targetStorage.getConnectors()) },
      { key: 'fuseBoxes', run: () => pushItems('fuseBoxes', targetStorage.getFuseBoxes()) },
      { key: 'wiringDiagrams', run: () => pushItems('wiringDiagrams', targetStorage.getWiringDiagrams()) },
      {
        key: 'media',
        run: () =>
          pushItems('media', targetStorage.getMediaItems(), (m) => ({
            ...m,
            description: m.description || '',
            source: m.source || '',
            status: m.status || 'published',
            createdAt: m.createdAt || Date.now(),
            updatedAt: (m as MediaItem & { updatedAt?: number }).updatedAt || Date.now()
          }))
      }
    ];

    const settled = await Promise.allSettled(tasks.map((t) => t.run()));
    const syncedCollections: string[] = [];
    const failedCollections: { collection: string; error: string; category?: SyncFailureCategory }[] = [];
    const collectionDetails: CollectionSyncDetail[] = [];
    const counts: CloudSyncResult['counts'] = {
      manufacturers: 0,
      vehicles: 0,
      ecus: 0,
      connectors: 0,
      fuseBoxes: 0,
      wiringDiagrams: 0,
      media: 0
    };

    settled.forEach((res, idx) => {
      const colName = tasks[idx].key;
      const labelFa = TECHNICAL_COLLECTION_LABELS_FA[colName];
      if (res.status === 'fulfilled') {
        counts[colName] = res.value;
        syncedCollections.push(colName);
        collectionDetails.push({
          collection: colName,
          labelFa,
          status: 'synced',
          count: res.value
        });
      } else {
        const { category, message } = categorizeSyncError(res.reason);
        failedCollections.push({ collection: colName, error: message, category });
        collectionDetails.push({
          collection: colName,
          labelFa,
          status: 'failed',
          count: 0,
          category,
          error: message
        });
      }
    });

    return {
      success: failedCollections.length === 0,
      partial: syncedCollections.length > 0 && failedCollections.length > 0,
      syncedCollections,
      failedCollections,
      collectionDetails,
      syncedAt: Date.now(),
      counts
    };
  }

  // --- Cascade Delete (Cloud-first children-first + Atomic Local Rollback Guard) ---
  public async cascadeDeleteEntity(
    type: 'vehicle' | 'ecu' | 'connector' | 'fusebox' | 'diagram',
    id: string,
    options: {
      syncToCloud: boolean;
      adminInfo?: { uid?: string; email?: string };
      targetStorage?: typeof storage;
    }
  ) {
    const targetStorage = options.targetStorage || storage;
    const plan = targetStorage.getCascadeDeletePlan(type, id);
    const snapshot = targetStorage.captureTechnicalDataSnapshot();

    if (options.syncToCloud) {
      const ecuIdSet = new Set(plan.ecuIds);

      for (const mediaId of plan.mediaIds) {
        try {
          await deleteDoc(doc(this.firestoreDb, 'media', mediaId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `media/${mediaId}`);
        }
      }

      for (const diagId of plan.diagramIds) {
        try {
          await deleteDoc(doc(this.firestoreDb, 'wiringDiagrams', diagId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `wiringDiagrams/${diagId}`);
        }
      }

      for (const fbId of plan.fuseBoxIds) {
        try {
          await deleteDoc(doc(this.firestoreDb, 'fuseBoxes', fbId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `fuseBoxes/${fbId}`);
        }
      }

      for (const connId of plan.connectorIds) {
        try {
          await deleteDoc(doc(this.firestoreDb, 'connectors', connId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `connectors/${connId}`);
        }
      }

      for (const ecuId of plan.ecuIds) {
        try {
          await deleteDoc(doc(this.firestoreDb, 'ecus', ecuId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `ecus/${ecuId}`);
        }
      }

      for (const vehId of plan.affectedVehicleIdsForEcuCleanup) {
        const veh = targetStorage.getVehicleById(vehId);
        if (veh && Array.isArray(veh.ecuIds)) {
          const cleanedVehicle = sanitizeForFirestore({
            ...veh,
            ecuIds: veh.ecuIds.filter(eid => !ecuIdSet.has(eid)),
            status: veh.status || 'published',
            updatedAt: Date.now()
          });
          try {
            await setDoc(doc(this.firestoreDb, 'vehicles', vehId), cleanedVehicle, { merge: true });
          } catch (err) {
            handleFirestoreError(err, OperationType.WRITE, `vehicles/${vehId}`);
          }
        }
      }

      for (const vehId of plan.vehicleIds) {
        try {
          await deleteDoc(doc(this.firestoreDb, 'vehicles', vehId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `vehicles/${vehId}`);
        }
      }
    }

    try {
      return targetStorage.executeLocalCascadeDelete(type, id, options.adminInfo);
    } catch (localErr) {
      targetStorage.restoreTechnicalDataSnapshot(snapshot);
      throw localErr;
    }
  }

  // Seed initial automotive database to Firestore
  public async seedInitialDataToFirestore(): Promise<{ count: number }> {
    let count = 0;

    // 1. Manufacturers
    for (const man of SEED_MANUFACTURERS) {
      await setDoc(doc(this.firestoreDb, 'manufacturers', man.id), sanitizeForFirestore({
        ...man,
        status: 'published',
        createdAt: new Date().toISOString()
      }));
      count++;
    }

    // 2. Vehicles
    for (const veh of SEED_VEHICLES) {
      await setDoc(doc(this.firestoreDb, 'vehicles', veh.id), sanitizeForFirestore({
        ...veh,
        status: 'published',
        createdAt: new Date().toISOString()
      }));
      count++;
    }

    // 3. ECUs
    for (const ecu of SEED_ECUS) {
      await setDoc(doc(this.firestoreDb, 'ecus', ecu.id), sanitizeForFirestore({
        ...ecu,
        status: ecu.status || 'published',
        createdAt: new Date().toISOString()
      }));
      count++;
    }

    // 4. Connectors
    for (const conn of SEED_CONNECTORS) {
      await setDoc(doc(this.firestoreDb, 'connectors', conn.id), sanitizeForFirestore({
        ...conn,
        status: 'published',
        createdAt: new Date().toISOString()
      }));
      count++;
    }

    // 5. FuseBoxes
    for (const fb of SEED_FUSEBOXES) {
      await setDoc(doc(this.firestoreDb, 'fuseBoxes', fb.id), sanitizeForFirestore({
        ...fb,
        status: 'published',
        createdAt: new Date().toISOString()
      }));
      count++;
    }

    // 6. Diagrams
    for (const diag of SEED_WIRING_DIAGRAMS) {
      await setDoc(doc(this.firestoreDb, 'wiringDiagrams', diag.id), sanitizeForFirestore({
        ...diag,
        status: 'published',
        createdAt: new Date().toISOString()
      }));
      count++;
    }

    return { count };
  }

  // --- Users & RBAC (Online Firestore) ---
  public async getUsers(): Promise<AppUserProfile[]> {
    const path = 'users';
    try {
      const snap = await getDocs(collection(this.firestoreDb, path));
      const list: AppUserProfile[] = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data() as AppUserProfile);
      });
      return list;
    } catch (err) {
      console.warn('Failed to fetch users from Firestore, using local users:', err);
      return storage.getUsers();
    }
  }

  public async saveUser(user: AppUserProfile): Promise<void> {
    try {
      const sanitized = sanitizeForFirestore({
        ...user,
        uid: user.uid || user.id,
        accountStatus: user.accountStatus || (user.isActive === false ? 'suspended' : 'active'),
        updatedAt: user.updatedAt || Date.now()
      });
      await setDoc(doc(this.firestoreDb, 'users', user.id), sanitized, { merge: true });
    } catch (err) {
      console.warn('Firestore saveUser error, falling back to local storage:', err);
      storage.saveUser(user);
    }
  }

  public async updateUserRole(
    id: string,
    role: AppUserRole,
    previousRole?: AppUserRole
  ): Promise<void> {
    await setDoc(doc(this.firestoreDb, 'users', id), { role, updatedAt: Date.now() }, { merge: true });

    // Never attempt direct client writes to `/admins/{uid}` (strictly blocked by firestore.rules).
    // Changes involving admin privilege must go through the server-authoritative `setAdminRole` callable.
    if (role === 'admin' || previousRole === 'admin') {
      const u = storage.getUserById(id);
      const setAdminRoleFn = httpsCallable(functionsInstance, 'setAdminRole');
      await setAdminRoleFn({
        targetUid: id,
        targetEmail: (u?.email || '').toLowerCase(),
        role: 'admin',
        active: role === 'admin'
      });
    }
  }

  public async toggleUserStatus(id: string, isActive: boolean): Promise<void> {
    try {
      await setDoc(doc(this.firestoreDb, 'users', id), { isActive }, { merge: true });
    } catch (err) {
      console.warn('Firestore toggleUserStatus error:', err);
    }
  }

  // --- Audit Logs (گزارش فعالیت‌های مدیریتی در Firestore) ---
  public async saveAuditLog(entry: AuditLogEntry): Promise<void> {
    try {
      const sanitized = sanitizeForFirestore(entry);
      await setDoc(doc(this.firestoreDb, 'audit_logs', entry.id), sanitized);
    } catch (err) {
      console.warn('Firestore saveAuditLog warning (stored locally):', err);
    }
  }

  public async getAuditLogs(): Promise<AuditLogEntry[]> {
    try {
      const q = query(collection(this.firestoreDb, 'audit_logs'), orderBy('timestamp', 'desc'));
      const snap = await getDocs(q);
      const list: AuditLogEntry[] = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data() as AuditLogEntry);
      });
      return list;
    } catch (err) {
      console.warn('Firestore getAuditLogs error, falling back to local audit logs:', err);
      return storage.getAuditLogs();
    }
  }
}

export const onlineStorage = new OnlineStorageService();
