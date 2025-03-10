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
		console.log('=== Initializing Health Checks for Existing Load Balancers ===');
		const loadBalancers: LoadBalancerRegistry = await this.ctx.storage.get('loadbalancers') || {};
		
		for (const [name, config] of Object.entries(loadBalancers)) {
			if (!config) continue;
			
			console.log(`Initializing health checks for ${name}`);
			try {
				// Get the LoadBalancerDO instance
				const id = this.env.LOAD_BALANCER.idFromName(name);
				const loadBalancer = this.env.LOAD_BALANCER.get(id);
				
				// Initialize the load balancer with its config
				await loadBalancer.fetch(new Request('http://localhost/api/loadbalancer', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(config)
				}));
				
				console.log(`Health checks initialized for ${name}`);
			} catch (error) {
				console.error(`Failed to initialize health checks for ${name}:`, error);
			}
		}
		console.log('=== Health Checks Initialization Complete ===');
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
				console.log('\n=== Frontend Request for Load Balancers ===');
				const loadBalancers: LoadBalancerRegistry = await this.ctx.storage.get('loadbalancers') || {};
				
				// Convert to array format and include health status
				const loadBalancerPromises = Object.entries(loadBalancers)
					.filter(([_, config]) => config)
					.map(async ([name, config]: [string, any]) => {
						console.log(`\nProcessing load balancer: ${name}`);
						
						// Get health status from this specific load balancer's DO instance
						const id = this.env.LOAD_BALANCER.idFromName(name);
						const loadBalancer = this.env.LOAD_BALANCER.get(id);
						const healthStatusResponse = await loadBalancer.fetch(new Request('http://localhost/api/health-status'));
						const healthStatus = await healthStatusResponse.json();
						
						console.log('Received health status:', healthStatus);
						
						// Create a health status object just for this load balancer's hosts
						const lbHealthStatus = {};
						
						if (config.hosts) {
							config.hosts.forEach(host => {
								// Access the nested structure correctly
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
						
						console.log(`Health status for ${name}:`, lbHealthStatus);
						
						return {
							name,
							...config,
							healthStatus: lbHealthStatus
						};
					});
				
				// Wait for all load balancers to be processed
				const loadBalancerArray = await Promise.all(loadBalancerPromises);
				console.log('Final load balancer array:', loadBalancerArray);
				
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