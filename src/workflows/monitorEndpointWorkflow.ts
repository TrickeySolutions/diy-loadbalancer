import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

// Add debug logger utility
const DEBUG = false; // Toggle this to enable/disable verbose logging
const debug = {
    log: (...args: any[]) => DEBUG && console.log(...args),
    error: (...args: any[]) => DEBUG && console.error(...args),
    info: (...args: any[]) => console.log(...args), // Always log important info
};

interface EndpointMonitorParams {
    loadBalancerName: string;
    endpoint: string;
    probePath: string;
}

interface MonitorResult {
    endpoint: string;
    isHealthy: boolean;
    statusCode?: number;
    responseTime: number;
    timestamp: number;
    message?: string;
}

export class MonitorEndpointWorkflow extends WorkflowEntrypoint<Env, EndpointMonitorParams> {
    async run(event: WorkflowEvent<EndpointMonitorParams>, step: WorkflowStep): Promise<MonitorResult> {
        const { loadBalancerName, endpoint, probePath } = event.payload;
        
        debug.info(`Monitoring ${endpoint} for ${loadBalancerName}`);

        // Step 1: Test the endpoint
        const result = await step.do(
            'check-endpoint',
            {
                retries: {
                    limit: 2,
                    delay: '5 seconds',
                    backoff: 'exponential',
                },
            },
            async (): Promise<MonitorResult> => {
                debug.log(`Testing endpoint ${endpoint}`);
                const startTime = Date.now();
                
                try {
                    const response = await fetch(`http://${endpoint}${probePath}`);
                    const responseTime = Date.now() - startTime;
                    const isHealthy = response.status < 400;
                    
                    debug.log('Health check result:', {
                        endpoint,
                        status: response.status,
                        isHealthy,
                        responseTime
                    });
                    
                    return {
                        endpoint,
                        isHealthy,
                        statusCode: response.status,
                        responseTime,
                        timestamp: Date.now()
                    };
                } catch (error) {
                    debug.error('Health check failed:', error);
                    return {
                        endpoint,
                        isHealthy: false,
                        responseTime: Date.now() - startTime,
                        timestamp: Date.now(),
                        message: error instanceof Error ? error.message : 'Unknown error'
                    };
                }
            }
        );

        // Step 2: Update the load balancer's health status
        debug.log('Updating health status');
        await step.do(
            'update-health-status',
            {
                retries: {
                    limit: 3,
                    delay: '2 seconds',
                    backoff: 'exponential',
                },
            },
            async () => {
                const id = this.env.LOAD_BALANCER.idFromName(loadBalancerName);
                const loadBalancer = this.env.LOAD_BALANCER.get(id);
                
                const updateResponse = await loadBalancer.fetch(new Request('http://localhost/api/health-status/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        endpoint: result.endpoint,
                        loadBalancerName: event.payload.loadBalancerName,
                        isHealthy: result.isHealthy,
                        timestamp: Date.now()
                    })
                }));

                if (!updateResponse.ok) {
                    throw new Error(`Failed to update health status: ${await updateResponse.text()}`);
                }

                // Verify the update was successful
                const verifyResponse = await loadBalancer.fetch(new Request('http://localhost/api/health-status'));
                if (!verifyResponse.ok) {
                    throw new Error('Failed to verify health status update');
                }

                debug.log('Health status updated successfully');
            }
        );

        debug.info(`Health check complete for ${endpoint}: ${result.isHealthy ? 'healthy' : 'unhealthy'}`);
        return result;
    }
}

export default MonitorEndpointWorkflow; 