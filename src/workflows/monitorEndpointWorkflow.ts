import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

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

export class MonitorEndpointWorkflow extends WorkflowEntrypoint<{
    LOAD_BALANCER: DurableObjectNamespace;
    LOAD_BALANCER_REGISTRY: DurableObjectNamespace;
}, EndpointMonitorParams> {
    async run(event: WorkflowEvent<EndpointMonitorParams>, step: WorkflowStep): Promise<MonitorResult> {
        const { loadBalancerName, endpoint, probePath } = event.payload;
        
        console.log('\n=== Starting Endpoint Monitor ===');
        console.log('Monitor details:', {
            loadBalancer: loadBalancerName,
            endpoint,
            probePath,
            workflowId: event.workflowId
        });

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
                console.log(`Testing endpoint ${endpoint}`);
                const startTime = Date.now();
                
                try {
                    const response = await fetch(`http://${endpoint}${probePath}`);
                    const responseTime = Date.now() - startTime;
                    const isHealthy = response.status < 400;
                    
                    console.log('Health check result:', {
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
                    console.error('Health check failed:', error);
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

        // After the health check
        console.log('Health check completed with result:', {
            endpoint: result.endpoint,
            isHealthy: result.isHealthy,
            statusCode: result.statusCode,
            responseTime: result.responseTime,
            timestamp: result.timestamp,
            message: result.message
        });

        // Step 2: Update the load balancer's health status
        console.log('\nUpdating load balancer health status');
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

                const updateResult = await updateResponse.json();
                console.log('Health status update response:', updateResult);

                // Add verification step
                console.log('\n=== Verifying Health Status Update ===');
                // Simulate the frontend request to verify the status
                const verifyResponse = await loadBalancer.fetch(new Request('http://localhost/api/health-status', {
                    method: 'GET',
                    headers: {
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache'
                    }
                }));

                const verifyStatus = await verifyResponse.json();
                console.log('Verification - Current DO health status:', JSON.stringify(verifyStatus, null, 2));

                // Also verify through the registry to see what the frontend would get
                const registryId = this.env.LOADBALANCER_REGISTRY.idFromName('default');
                const registry = this.env.LOADBALANCER_REGISTRY.get(registryId);
                const registryResponse = await registry.fetch(new Request('http://localhost/api/loadbalancers', {
                    headers: {
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache'
                    }
                }));

                const registryData = await registryResponse.json();
                console.log('Verification - What frontend would receive:', JSON.stringify(registryData, null, 2));
                console.log('=== Verification Complete ===\n');
            }
        );

        // Before sending the update
        console.log('Sending health status update with:', {
            endpoint: result.endpoint,
            isHealthy: result.isHealthy,
            timestamp: Date.now()
        });

        console.log('=== Endpoint Monitor Complete ===\n');
        return result;
    }
}

export default MonitorEndpointWorkflow; 