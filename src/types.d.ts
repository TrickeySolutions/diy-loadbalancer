interface DurableObject {
    fetch(request: Request): Promise<Response>;
}

interface DurableObjectState {
    storage: DurableObjectStorage;
}

interface DurableObjectStorage {
    get(key: string): Promise<any>;
    put(key: string, value: any): Promise<void>;
    delete(key: string): Promise<boolean>;
} 