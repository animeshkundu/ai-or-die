(function () {
  const DB_NAME = 'cc-web-client-storage';
  const STORE_NAME = 'kv';
  const CRITICAL_KEYS = [
    'cc-web-settings',
    'cc-web-command-clips',
    'cc-web-sessions-cache-v1',
    'cc-web-storage-persist-requested'
  ];

  class ClientStorage {
    constructor() {
      this._db = null;
      this._initPromise = null;
      this._memory = new Map();
    }

    async init() {
      if (!this._initPromise) {
        this._initPromise = this._initInternal();
      }
      return this._initPromise;
    }

    async _initInternal() {
      this._db = await this._openDb();
      for (const key of CRITICAL_KEYS) {
        await this.hydrateKey(key);
      }
    }

    async _openDb() {
      if (typeof indexedDB === 'undefined') return null;
      return new Promise((resolve) => {
        try {
          const request = indexedDB.open(DB_NAME, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              db.createObjectStore(STORE_NAME);
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
    }

    _safeLocalGet(key) {
      try {
        return localStorage.getItem(key);
      } catch (_) {
        return null;
      }
    }

    _safeLocalSet(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (_) {
        // Best-effort only.
      }
    }

    _safeLocalRemove(key) {
      try {
        localStorage.removeItem(key);
      } catch (_) {
        // Best-effort only.
      }
    }

    async _idbGet(key) {
      if (!this._db) return null;
      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const request = store.get(key);
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
    }

    async _idbSet(key, value) {
      if (!this._db) return;
      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }

    async _idbDelete(key) {
      if (!this._db) return;
      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }

    async hydrateKey(key) {
      const localValue = this._safeLocalGet(key);
      if (localValue !== null) {
        this._memory.set(key, localValue);
        await this._idbSet(key, localValue);
        return localValue;
      }

      const persistedValue = await this._idbGet(key);
      if (persistedValue !== null && persistedValue !== undefined) {
        const value = String(persistedValue);
        this._memory.set(key, value);
        this._safeLocalSet(key, value);
        return value;
      }

      this._memory.delete(key);
      return null;
    }

    getItem(key) {
      const localValue = this._safeLocalGet(key);
      if (localValue !== null) {
        this._memory.set(key, localValue);
        return localValue;
      }
      if (this._memory.has(key)) {
        return this._memory.get(key);
      }
      return null;
    }

    setItem(key, value) {
      const normalized = String(value);
      this._memory.set(key, normalized);
      this._safeLocalSet(key, normalized);
      this._idbSet(key, normalized);
    }

    removeItem(key) {
      this._memory.delete(key);
      this._safeLocalRemove(key);
      this._idbDelete(key);
    }

    getJson(key, fallback) {
      const raw = this.getItem(key);
      if (!raw) return fallback;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    }

    setJson(key, value) {
      this.setItem(key, JSON.stringify(value));
    }

    getSettings() {
      const settings = this.getJson('cc-web-settings', {});
      return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    }

    setSettings(settings) {
      this.setJson('cc-web-settings', settings && typeof settings === 'object' ? settings : {});
    }

    getCommandClips() {
      const clips = this.getJson('cc-web-command-clips', []);
      return Array.isArray(clips) ? clips : [];
    }

    setCommandClips(clips) {
      this.setJson('cc-web-command-clips', Array.isArray(clips) ? clips : []);
    }

    getSessionCache() {
      const sessions = this.getJson('cc-web-sessions-cache-v1', []);
      return Array.isArray(sessions) ? sessions : [];
    }

    setSessionCache(sessions) {
      this.setJson('cc-web-sessions-cache-v1', Array.isArray(sessions) ? sessions : []);
    }
  }

  window.clientStorage = new ClientStorage();
})();
