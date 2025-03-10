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
        const testResult = await step.do(
            'test-endpoint',
            {
                retries: {
                    limit: 2,
                    delay: '5 seconds',
                    backoff: 'exponential',
                },
            },
            async (): Promise<MonitorResult> => {
                console.log(`\nTesting endpoint ${endpoint}`);
                console.log(`URL: http://${endpoint}${probePath}`);
                const startTime = Date.now();
                
                try {
                    const response = await fetch(`http://${endpoint}${probePath}`, {
                        method: 'GET',
                        headers: {
                            'User-Agent': 'DIY-LoadBalancer-HealthCheck/1.0',
                        },
                    });

                    const responseTime = Date.now() - startTime;
                    const isHealthy = response.status < 400;
                    const message = isHealthy 
                        ? `Healthy (${response.status})`
                        : `Unhealthy - Status: ${response.status}`;

                    console.log('Health check result:', {
                        endpoint,
                        status: response.status,
                        isHealthy,
                        responseTime: `${responseTime}ms`,
                        message
                    });

                    return {
                        endpoint,
                        isHealthy,
                        statusCode: response.status,
                        responseTime,
                        timestamp: Date.now(),
                        message
                    };
                } catch (error) {
                    const responseTime = Date.now() - startTime;
                    const message = error instanceof Error 
                        ? `Unhealthy - ${error.message}`
                        : 'Unhealthy - Connection failed';
                    
                    console.log('Health check result:', {
                        endpoint,
                        isHealthy: false,
                        responseTime: `${responseTime}ms`,
                        message
                    });

                    return {
                        endpoint,
                        isHealthy: false,
                        responseTime,
                        timestamp: Date.now(),
                        message
                    };
                }
            }
        );

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
                
                await loadBalancer.fetch(new Request('http://localhost/api/health-status/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        endpoint: testResult.endpoint,
                        isHealthy: testResult.isHealthy,
                        timestamp: testResult.timestamp
                    })
                }));
                console.log('Health status updated successfully');
            }
        );

        console.log('=== Endpoint Monitor Complete ===\n');
        return testResult;
    }
}

export default MonitorEndpointWorkflow; 