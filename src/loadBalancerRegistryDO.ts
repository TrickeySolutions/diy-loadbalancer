export class LoadBalancerRegistryDO implements DurableObject {
	private ctx: DurableObjectState;

	constructor(ctx: DurableObjectState) {
		this.ctx = ctx;
	}

	async fetch(request: Request) {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/api/loadbalancer/register') {
			const data = await request.json() as { id: string; config: any };
			
			// Get existing load balancers
			const loadBalancers = await this.ctx.storage.get('loadbalancers') || {};
			
			// Store the full config
			loadBalancers[data.id] = data.config;
			await this.ctx.storage.put('loadbalancers', loadBalancers);
			
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (request.method === 'DELETE' && url.pathname.startsWith('/api/loadbalancer/')) {
			const id = url.pathname.split('/').pop();
			const loadBalancers = await this.ctx.storage.get('loadbalancers') || {};
			
			delete loadBalancers[id];
			await this.ctx.storage.put('loadbalancers', loadBalancers);
			
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (request.method === 'GET' && url.pathname === '/api/loadbalancers') {
			const loadBalancers = await this.ctx.storage.get('loadbalancers') || {};
			// Convert to array format
			const loadBalancerArray = Object.entries(loadBalancers).map(([name, config]) => ({
				name,
				...config
			}));
			
			return new Response(JSON.stringify(loadBalancerArray), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response('Not found', { status: 404 });
	}
}