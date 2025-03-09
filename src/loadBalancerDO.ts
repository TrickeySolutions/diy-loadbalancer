import { LoadBalancerRegistryDO } from './loadBalancerRegistryDO'; // Import the registry

interface LoadBalancerConfig {
	name: string;
	hosts: string[];
	healthCheckConfig: {
		probeInterval: number; // in seconds
		probePath: string; // path to check
	};
}

interface HealthStatus {
	[host: string]: boolean;
}

export class LoadBalancerDO implements DurableObject {
	private ctx: DurableObjectState;
	private config: LoadBalancerConfig;
	private sessions: WebSocket[] = [];
	private healthCheckInterval: number | null = null;
	private env: any; // Add env property

	constructor(ctx: DurableObjectState, env: any) {
		this.ctx = ctx;
		this.env = env;
		this.config = {
			name: 'default',
			hosts: [],
			healthCheckConfig: {
				probeInterval: 30,
				probePath: '/'
			}
		};
	}

	async fetch(request: Request) {
		const url = new URL(request.url);

		if (request.headers.get("Upgrade") === "websocket") {
			const { 0: client, 1: server } = new WebSocketPair();
			
			// Accept the WebSocket connection
			server.accept();
			
			// Send initial empty health status
			server.send(JSON.stringify({
				type: 'initialHealthStatus',
				healthStatus: {}
			}));

			return new Response(null, {
				status: 101,
				webSocket: client
			});
		}

		if (request.method === 'POST' && url.pathname === '/api/loadbalancer') {
			const newConfig = await request.json() as LoadBalancerConfig;
			
			await this.ctx.storage.put('config', newConfig);
			this.config = newConfig;

			// Register with the registry
			const registryId = this.env.LOADBALANCER_REGISTRY.idFromName('default');
			const registry = this.env.LOADBALANCER_REGISTRY.get(registryId);
			
			try {
				await registry.fetch(new Request(`${url.origin}/api/loadbalancer/register`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({ 
						id: newConfig.name,
						config: newConfig
					})
				}));

				// Broadcast the config update to all connected clients
				this.broadcastConfigUpdate(newConfig);

				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (error) {
				console.error('Error registering load balancer:', error);
				return new Response(JSON.stringify({ 
					success: false, 
					error: 'Failed to register load balancer' 
				}), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}

		if (request.method === 'GET' && url.pathname === '/api/loadbalancer') {
			return new Response(JSON.stringify(this.config), { status: 200 });
		}

		return new Response('Not found', { status: 404 });
	}

	private async handleWebSocket(webSocket: WebSocket) {
		webSocket.accept();

		// Add to sessions
		this.sessions.push(webSocket);

		// Send initial health status
		const healthStatus = await this.checkHealth();
		webSocket.send(JSON.stringify({
			type: 'initialHealthStatus',
			healthStatus
		}));

		// Start health check interval if not already started
		if (!this.healthCheckInterval) {
			this.startHealthChecks();
		}

		// Handle WebSocket closure
		webSocket.addEventListener('close', () => {
			this.sessions = this.sessions.filter(ws => ws !== webSocket);
		});

		webSocket.addEventListener('error', () => {
			this.sessions = this.sessions.filter(ws => ws !== webSocket);
		});
	}

	private startHealthChecks() {
		// Check health every 30 seconds
		this.healthCheckInterval = setInterval(async () => {
			const healthStatus = await this.checkHealth();
			this.broadcastHealthStatus(healthStatus);
		}, this.config.healthCheckConfig.probeInterval * 1000) as unknown as number;
	}

	private async checkHealth(): Promise<HealthStatus> {
		const healthStatus: HealthStatus = {};
		for (const host of this.config.hosts) {
			try {
				const response = await fetch(`http://${host}${this.config.healthCheckConfig.probePath}`);
				healthStatus[host] = response.ok;
			} catch (error) {
				healthStatus[host] = false;
			}
		}
		return healthStatus;
	}

	private broadcastHealthStatus(healthStatus: HealthStatus) {
		const message = JSON.stringify({
			type: 'healthStatusUpdate',
			healthStatus
		});

		this.sessions = this.sessions.filter(ws => {
			try {
				ws.send(message);
				return true;
			} catch {
				return false;
			}
		});
	}

	private broadcastConfigUpdate(config: LoadBalancerConfig) {
		const message = JSON.stringify({
			type: 'configUpdate',
			config
		});

		this.sessions = this.sessions.filter(ws => {
			try {
				ws.send(message);
				return true;
			} catch {
				return false;
			}
		});
	}
} 