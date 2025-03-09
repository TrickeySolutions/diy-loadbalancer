import { LoadBalancerRegistryDO } from './loadBalancerRegistryDO'; // Import the registry

interface LoadBalancerConfig {
	name: string;
	hosts: string[];
	healthCheckConfig: {
		probeInterval: number; // in seconds
		probePath: string; // path to check
	};
	expression: {
		hostname?: string;
		path?: string;
	};
}

interface HealthStatus {
	[host: string]: boolean;
}

interface LoadBalancerSnippet {
	code: string;
	name: string;
}

interface CloudflareEnv {
	CF_ACCOUNT_ID: string;
	CF_ZONE_ID: string;
	CF_API_TOKEN: string;
}

interface SnippetDeployment {
	success: boolean;
	error?: string;
	snippetId?: string;
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

		if (request.method === 'GET' && url.pathname === '/api/loadbalancer/snippet') {
			const name = url.searchParams.get('name');
			if (!name) {
				return new Response('Load balancer name is required', { status: 400 });
			}

			// Get the registry to fetch the config
			const registryId = this.env.LOADBALANCER_REGISTRY.idFromName('default');
			const registry = this.env.LOADBALANCER_REGISTRY.get(registryId);
			
			try {
				const response = await registry.fetch(new Request(`${url.origin}/api/loadbalancers`));
				const loadBalancers = await response.json();
				
				// Find the specific load balancer
				const config = loadBalancers.find((lb: LoadBalancerConfig) => lb.name === name);
				
				if (!config) {
					return new Response('Load balancer not found', { status: 404 });
				}

				const snippet = this.generateSnippet(config);
				return new Response(JSON.stringify(snippet), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (error) {
				console.error('Error generating snippet:', error);
				return new Response('Failed to generate snippet', { status: 500 });
			}
		}

		if (request.method === 'POST' && url.pathname === '/api/loadbalancer/deploy-snippet') {
			const name = url.searchParams.get('name');
			if (!name) {
				return new Response('Load balancer name is required', { status: 400 });
			}

			try {
				const config = await this.getLoadBalancerConfig(name);
				if (!config) {
					return new Response('Load balancer not found', { status: 404 });
				}

				const result = await this.deploySnippet(config);
				return new Response(JSON.stringify(result), {
					status: result.success ? 200 : 500,
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (error) {
				console.error('Error deploying snippet:', error);
				return new Response(JSON.stringify({
					success: false,
					error: 'Failed to deploy snippet'
				}), { status: 500 });
			}
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

	private generateSnippet(config: LoadBalancerConfig): LoadBalancerSnippet {
		const snippetCode = `
export default {
	async fetch(request, env, ctx) {
		// Define the available backend endpoints
		const healthyEndpoints = ${JSON.stringify(config.hosts, null, 2)};

		if (healthyEndpoints.length === 0) {
			return new Response("No available backend", { status: 503 });
		}

		// Get original request information
		const url = new URL(request.url);

		// Choose a backend (random selection)
		const selectedEndpoint = healthyEndpoints[Math.floor(Math.random() * healthyEndpoints.length)];
		console.log(\`Selected backend: \${selectedEndpoint}\`);

		// Create a new URL with the selected backend
		const newUrl = new URL(url.pathname + url.search, \`https://\${selectedEndpoint}\`);
		console.log(\`Routing request to: \${newUrl.toString()}\`);

		// Create a new request with all the original properties
		const newRequest = new Request(newUrl.toString(), {
			method: request.method,
			headers: request.headers,
			body: request.body,
			redirect: request.redirect
		});

		// Set the Host header to match the new backend
		newRequest.headers.set("Host", selectedEndpoint);

		// Fetch from the selected backend
		const response = await fetch(newRequest);
		
		// Clone the response so we can read and modify it
		const originalResponse = response.clone();
		
		// Create a new response with custom headers
		const modifiedResponse = new Response(originalResponse.body, {
			status: originalResponse.status,
			statusText: originalResponse.statusText,
			headers: originalResponse.headers
		});
		
		// Add custom headers
		modifiedResponse.headers.set("X-Load-Balancer", "${config.name}");
		modifiedResponse.headers.set("X-Backend-Server", selectedEndpoint);
		
		return modifiedResponse;
	}
};`.trim();

		return {
			name: config.name,
			code: snippetCode
		};
	}

	private async getLoadBalancerConfig(name: string): Promise<LoadBalancerConfig | null> {
		const registryId = this.env.LOADBALANCER_REGISTRY.idFromName('default');
		const registry = this.env.LOADBALANCER_REGISTRY.get(registryId);
		
		// Create a new request with the current origin
		const request = new Request('http://localhost/api/loadbalancers');
		const response = await registry.fetch(request);
		
		if (!response.ok) {
			throw new Error(`Failed to fetch load balancers: ${response.statusText}`);
		}
		
		const loadBalancers = await response.json();
		return loadBalancers.find((lb: LoadBalancerConfig) => lb.name === name) || null;
	}

	private sanitizeSnippetName(name: string): string {
		// Replace any character that isn't a-z, 0-9, or underscore with underscore
		return name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
	}

	private async deploySnippet(config: LoadBalancerConfig): Promise<SnippetDeployment> {
		if (!this.env.CF_ACCOUNT_ID || !this.env.CF_ZONE_ID || !this.env.CF_API_TOKEN) {
			return {
				success: false,
				error: 'Missing Cloudflare credentials. Please check environment variables.'
			};
		}

		const snippet = this.generateSnippet(config);
		const sanitizedName = this.sanitizeSnippetName(config.name);
		
		try {
			// First, check if the snippet exists
			const checkResponse = await fetch(
				`https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/snippets/${sanitizedName}`,
				{
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.env.CF_API_TOKEN}`
					}
				}
			);

			const method = checkResponse.status === 404 ? 'POST' : 'PUT';
			const endpoint = `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/snippets${method === 'PUT' ? '/' + sanitizedName : ''}`;

			// Create FormData for the snippet
			const formData = new FormData();
			const snippetBlob = new Blob([snippet.code], { type: 'application/javascript' });
			formData.append('files', snippetBlob, 'snippet.js');
			formData.append('metadata', JSON.stringify({
				name: sanitizedName,
				description: `Load balancer for ${config.name}`,
				enabled: true,
				main_module: 'snippet.js'
			}));

			// Deploy or update the snippet
			const snippetResponse = await fetch(endpoint, {
				method: method,
				headers: {
					'Authorization': `Bearer ${this.env.CF_API_TOKEN}`
				},
				body: formData
			});

			if (!snippetResponse.ok) {
				const errorText = await snippetResponse.text();
				let errorData;
				try {
					errorData = JSON.parse(errorText);
				} catch (e) {
					errorData = { errors: [{ message: errorText }] };
				}
				throw new Error(`Failed to deploy snippet: ${JSON.stringify(errorData)}`);
			}

			const snippetData = await snippetResponse.json();
			if (!snippetData.success) {
				throw new Error(`Failed to deploy snippet: ${JSON.stringify(snippetData.errors)}`);
			}

			// After successful snippet deployment, handle the rules
			const conditions = [];
			if (config.expression?.hostname) {
				conditions.push(`(http.host eq "${config.expression.hostname}")`);
			}
			if (config.expression?.path) {
				conditions.push(`(http.request.uri.path contains "${config.expression.path}")`);
			}

			const expression = conditions.length > 0 ? conditions.join(' and ') : 'true';

			// First, get all existing rules
			const getRulesResponse = await fetch(
				`https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/snippets/snippet_rules`,
				{
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.env.CF_API_TOKEN}`,
						'Content-Type': 'application/json'
					}
				}
			);

			if (!getRulesResponse.ok) {
				const errorText = await getRulesResponse.text();
				throw new Error(`Failed to fetch existing rules: ${errorText}`);
			}

			const existingRulesData = await getRulesResponse.json();
			console.log('Existing rules response:', existingRulesData);

			// Get existing rules, ensuring we don't lose them if result is null
			const existingRules = existingRulesData?.result || [];
			
			// Create our new rule
			const newRule = {
				description: `Rule for load balancer: ${config.name}`,
				enabled: true,
				expression: expression,
				snippet_name: sanitizedName
			};

			// If result was null, just add our new rule
			// If we have existing rules, update or add our rule while preserving others
			const updatedRules = existingRules.length > 0
				? existingRules
					.filter((rule: any) => rule.snippet_name !== sanitizedName)
					.concat([newRule])
				: [newRule];

			// Update rules
			const ruleResponse = await fetch(
				`https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/snippets/snippet_rules`,
				{
					method: 'PUT',
					headers: {
						'Authorization': `Bearer ${this.env.CF_API_TOKEN}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						rules: updatedRules
					})
				}
			);

			if (!ruleResponse.ok) {
				const errorText = await ruleResponse.text();
				let errorData;
				try {
					errorData = JSON.parse(errorText);
				} catch (e) {
					errorData = { errors: [{ message: errorText }] };
				}
				throw new Error(`Failed to create snippet rule: ${JSON.stringify(errorData)}`);
			}

			const ruleData = await ruleResponse.json();
			if (!ruleData.success) {
				throw new Error(`Failed to create snippet rule: ${JSON.stringify(ruleData.errors)}`);
			}

			return { 
				success: true, 
				snippetId: sanitizedName 
			};
		} catch (error) {
			console.error('Deployment error:', error);
			return { 
				success: false, 
				error: error instanceof Error ? error.message : 'Unknown error occurred' 
			};
		}
	}
} 