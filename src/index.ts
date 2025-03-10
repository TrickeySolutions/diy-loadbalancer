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
			const registryId = env.LOADBALANCER_REGISTRY.idFromName('default');
			const registry = env.LOADBALANCER_REGISTRY.get(registryId);
			return registry.fetch(request);
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