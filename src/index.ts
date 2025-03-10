import { LoadBalancerDO } from './loadBalancerDO';
import { LoadBalancerRegistryDO } from './loadBalancerRegistryDO';
import { DeploySnippetWorkflow } from './workflows/deploySnippetWorkflow';
import { MonitorEndpointWorkflow } from './workflows/monitorEndpointWorkflow';

export interface Env {
	LOAD_BALANCER: DurableObjectNamespace;
	ASSETS: DurableObjectNamespace & { fetch: (request: Request) => Promise<Response> };
	LOADBALANCER_REGISTRY: DurableObjectNamespace;
	DEPLOY_SNIPPET_WORKFLOW: any;
}

// Export all required classes
export { 
	LoadBalancerDO, 
	LoadBalancerRegistryDO
};

// Export the workflow class directly
export { DeploySnippetWorkflow };

export { MonitorEndpointWorkflow };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Debug endpoint to check LoadBalancerDO health status directly
		if (url.pathname === '/api/debug/health-status') {
			// Get the load balancer name from query parameter
			const name = url.searchParams.get('name') || 'default';
			const id = env.LOAD_BALANCER.idFromName(name);
			const loadBalancer = env.LOAD_BALANCER.get(id);
			return loadBalancer.fetch(request);
		}

		// Debug endpoint to see what LoadBalancerRegistryDO has
		if (url.pathname === '/api/debug/registry-status') {
			const id = env.LOADBALANCER_REGISTRY.idFromName('default');
			const registry = env.LOADBALANCER_REGISTRY.get(id);
			
			const response = await registry.fetch(new Request('http://localhost/api/loadbalancers'));
			const data = await response.json();
			
			return new Response(JSON.stringify({
				registryData: data
			}, null, 2), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Serve the index.html file for the root URL
		if (url.pathname === '/') {
			try {
				return env.ASSETS.fetch(request);
			} catch (error) {
				console.error('Error serving assets:', error);
				return new Response('<!DOCTYPE html><html><body><h1>Load Balancer Dashboard</h1><p>Error loading assets.</p></body></html>', {
					headers: { 'Content-Type': 'text/html' },
					status: 500
				});
			}
		}

		// Handle WebSocket connections for real-time updates
		if (url.pathname === '/api/ws') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected WebSocket', { status: 400 });
			}

			const id = env.LOAD_BALANCER.idFromName('default'); // Example ID
			const loadBalancer = env.LOAD_BALANCER.get(id);
			return loadBalancer.fetch(request);
		}

		// Handle other API endpoints
		if (url.pathname === '/api/loadbalancer') {
			// Create a new load balancer instance
			const id = env.LOAD_BALANCER.idFromName('default');
			const loadBalancer = env.LOAD_BALANCER.get(id);
			return loadBalancer.fetch(request);
		}

		if (url.pathname === "/api/loadbalancers") {
			const registryId = env.LOADBALANCER_REGISTRY.idFromName("default");
			const registry = env.LOADBALANCER_REGISTRY.get(registryId);
			return registry.fetch(request);
		}

		// Handle delete requests
		if (url.pathname.startsWith('/api/loadbalancer/') && request.method === 'DELETE') {
			const name = decodeURIComponent(url.pathname.split('/').pop()!);
			
			// First delete from registry
			const registryId = env.LOADBALANCER_REGISTRY.idFromName('default');
			const registry = env.LOADBALANCER_REGISTRY.get(registryId);
			const registryResponse = await registry.fetch(request);
			
			if (registryResponse.ok) {
				// Then delete from load balancer DO
				const id = env.LOAD_BALANCER.idFromName(name);
				const loadBalancer = env.LOAD_BALANCER.get(id);
				return loadBalancer.fetch(new Request('http://localhost/api/loadbalancer/delete', {
					method: 'DELETE'
				}));
			}
			
			return registryResponse;
		}

		// Handle snippet requests
		if (url.pathname === '/api/loadbalancer/snippet') {
			const id = env.LOAD_BALANCER.idFromName('default');
			const loadBalancer = env.LOAD_BALANCER.get(id);
			return loadBalancer.fetch(request);
		}

		// Handle deploy snippet requests
		if (url.pathname === '/api/loadbalancer/deploy-snippet') {
			const id = env.LOAD_BALANCER.idFromName('default');
			const loadBalancer = env.LOAD_BALANCER.get(id);
			return loadBalancer.fetch(request);
		}

		// Handle workflow status checks
		if (url.pathname.startsWith('/api/workflow-status/')) {
			const id = env.LOAD_BALANCER.idFromName('default');
			const loadBalancer = env.LOAD_BALANCER.get(id);
			return loadBalancer.fetch(request);
		}

		// Handle other routes (e.g., API endpoints)
		return new Response('API endpoint not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;