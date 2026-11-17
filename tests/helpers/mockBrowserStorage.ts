/**
 * Test helper: installs in-memory localStorage & minimal window mock BEFORE importing
 * AutoPin Pro modules (storage.ts checks window.localStorage on module initialization).
 * Leaves `document` undefined so Firebase AppCheck SSR guard cleanly skips DOM checks.
 */

const memoryStore: Record<string, string> = {};

export const mockLocalStorage: Storage = {
  getItem: (key: string) => (Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null),
  setItem: (key: string, val: string) => {
    memoryStore[key] = String(val);
  },
  removeItem: (key: string) => {
    delete memoryStore[key];
  },
  clear: () => {
    for (const k of Object.keys(memoryStore)) {
      delete memoryStore[k];
    }
  },
  key: (i: number) => Object.keys(memoryStore)[i] ?? null,
  get length() {
    return Object.keys(memoryStore).length;
  }
};

(globalThis as Record<string, unknown>).localStorage = mockLocalStorage;
(globalThis as Record<string, unknown>).window = {
  localStorage: mockLocalStorage
};
