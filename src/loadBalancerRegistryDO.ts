interface LoadBalancerRegistry {
	[key: string]: any;
}

export class LoadBalancerRegistryDO implements DurableObject {
	private ctx: DurableObjectState;
	private env: any;

	constructor(ctx: DurableObjectState, env: any) {
		this.ctx = ctx;
		this.env = env;
		// Initialize health checks for existing load balancers
		this.initializeHealthChecks().catch(error => {
			console.error('Failed to initialize health checks:', error);
		});
	}

	private async initializeHealthChecks() {
		console.log('Initializing health checks for existing load balancers');
		const loadBalancers: LoadBalancerRegistry = await this.ctx.storage.get('loadbalancers') || {};
		
		for (const [name, config] of Object.entries(loadBalancers)) {
			if (!config) continue;
			
			try {
				const id = this.env.LOAD_BALANCER.idFromName(name);
				const loadBalancer = this.env.LOAD_BALANCER.get(id);
				
				await loadBalancer.fetch(new Request('http://localhost/api/loadbalancer', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(config)
				}));
			} catch (error) {
				console.error(`Failed to initialize health checks for ${name}:`, error);
			}
		}
	}

	async fetch(request: Request) {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/api/loadbalancer/register') {
			const data = await request.json() as { id: string; config: any };
			
			// Get existing load balancers
			const loadBalancers: LoadBalancerRegistry = await this.ctx.storage.get('loadbalancers') || {};
			
			// Store the full config
			loadBalancers[data.id] = data.config;
			await this.ctx.storage.put('loadbalancers', loadBalancers);
			
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (request.method === 'DELETE' && url.pathname.startsWith('/api/loadbalancer/')) {
			const name = decodeURIComponent(url.pathname.split('/').pop()!);
			
			// Get existing load balancers
			const loadBalancers: LoadBalancerRegistry = await this.ctx.storage.get('loadbalancers') || {};
			
			// First clean up the LoadBalancerDO instance
			const id = this.env.LOAD_BALANCER.idFromName(name);
			const loadBalancer = this.env.LOAD_BALANCER.get(id);
			await loadBalancer.fetch(new Request('http://localhost/api/loadbalancer/delete', {
				method: 'DELETE'
			}));

			// Then delete from registry
			delete loadBalancers[name];
			await this.ctx.storage.put('loadbalancers', loadBalancers);

			// Get updated list for response
			const updatedList = Object.entries(loadBalancers)
				.filter(([_, config]) => config)
				.map(([name, config]) => ({
					name,
					...config
				}));

			// Broadcast the update to all connected clients via default LoadBalancerDO
			const defaultLB = this.env.LOAD_BALANCER.get(
				this.env.LOAD_BALANCER.idFromName('default')
			);
			await defaultLB.fetch(new Request('http://localhost/api/broadcast-update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ loadBalancers: updatedList })
			}));

			return new Response(JSON.stringify({ 
				success: true,
				loadBalancers: updatedList 
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (request.method === 'GET' && url.pathname === '/api/loadbalancers') {
			try {
				const loadBalancers: LoadBalancerRegistry = await this.ctx.storage.get('loadbalancers') || {};
				
				const loadBalancerPromises = Object.entries(loadBalancers)
					.filter(([_, config]) => config)
					.map(async ([name, config]: [string, any]) => {
						const id = this.env.LOAD_BALANCER.idFromName(name);
						const loadBalancer = this.env.LOAD_BALANCER.get(id);
						const healthStatusResponse = await loadBalancer.fetch(new Request('http://localhost/api/health-status'));
						const healthStatus = await healthStatusResponse.json();
						
						const lbHealthStatus = {};
						
						if (config.hosts) {
							config.hosts.forEach(host => {
								const status = healthStatus[name]?.[host];
								if (status) {
									lbHealthStatus[host] = {
										isHealthy: status.isHealthy === true,
										lastChecked: Number(status.lastChecked),
										nextCheck: Number(status.nextCheck),
										workflowId: status.workflowId
									};
								}
							});
						}
						
						return {
							name,
							...config,
							healthStatus: lbHealthStatus
						};
					});
				
				const loadBalancerArray = await Promise.all(loadBalancerPromises);
				
				return new Response(JSON.stringify(loadBalancerArray), {
					status: 200,
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': 'no-cache',
						'Pragma': 'no-cache'
					}
				});
			} catch (error) {
				console.error('Error in /api/loadbalancers:', error);
				return new Response(JSON.stringify({ error: 'Internal server error' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}

		return new Response('Not found', { status: 404 });
	}
}