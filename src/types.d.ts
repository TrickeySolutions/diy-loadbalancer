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

interface WorkflowNamespace {
    create(params: any): Promise<{ id: string }>;
    get(id: string): Promise<any>;
}

interface Env {
    DEPLOY_SNIPPET_WORKFLOW: WorkflowNamespace;
}

declare module 'cloudflare:workers' {
    export interface WorkflowEvent<T> {
        payload: T;
        workflowId: string;
    }

    export interface WorkflowStep {
        do<T>(
            name: string,
            options: {
                retries?: {
                    limit: number;
                    delay: string;
                    backoff: 'exponential' | 'linear';
                };
            },
            fn: () => Promise<T>
        ): Promise<T>;
    }

    export class WorkflowEntrypoint<E, P> {
        env: E;
        run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<any>;
    }
} 