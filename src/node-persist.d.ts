declare module 'node-persist' {
  interface StorageOptions {
    dir: string;
    stringify?: (obj: any) => string;
    parse?: (str: string) => any;
  }

  interface Storage {
    init(options: StorageOptions): Promise<void>;
    setItem(key: string, value: any): Promise<void>;
    getItem(key: string): Promise<any>;
    removeItem(key: string): Promise<void>;
    keys(): Promise<string[]>;
  }

  const storage: Storage;
  export default storage;
}