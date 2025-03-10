import { LoadBalancerRegistryDO } from './loadBalancerRegistryDO';
import { DeploySnippetWorkflow } from './workflows/deploySnippetWorkflow';

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
	workflowId?: string;
}

// Add new type for WebSocket messages
interface WebSocketMessage {
	type: 'initialHealthStatus' | 'healthStatusUpdate' | 'configUpdate' | 'workflowStatus';
	healthStatus?: HealthStatus;
	config?: LoadBalancerConfig;
	workflowStatus?: {
		workflowId: string;
		loadBalancerName: string;
		completed: boolean;
		success: boolean;
		currentStep?: string;
		error?: string;
	};
}

export class LoadBalancerDO implements DurableObject {
	private ctx: DurableObjectState;
	private config: LoadBalancerConfig;
	private sessions: WebSocket[] = [];
	private healthCheckInterval: number | null = null;
	private env: any; // Add env property
	private activeWorkflows: Map<string, {
		workflowId: string;
		loadBalancerName: string;
		currentStep: string;
	}> = new Map();

	constructor(ctx: DurableObjectState, env: any) {
		this.ctx = ctx;
		this.env = env;
		this.config = {
			name: 'default',
			hosts: [],
			healthCheckConfig: {
				probeInterval: 30,
				probePath: '/'
			},
			expression: {}
		};
	}

	async fetch(request: Request) {
		const url = new URL(request.url);

		if (request.headers.get("Upgrade") === "websocket") {
			const { 0: client, 1: server } = new WebSocketPair();
			
			// Accept the WebSocket connection
			server.accept();
			
			// Add to sessions array
			this.sessions.push(server);
			
			// Send initial empty health status
			server.send(JSON.stringify({
				type: 'initialHealthStatus',
				healthStatus: {}
			}));

			// Handle WebSocket closure
			server.addEventListener('close', () => {
				this.sessions = this.sessions.filter(ws => ws !== server);
			});

			server.addEventListener('error', () => {
				this.sessions = this.sessions.filter(ws => ws !== server);
			});

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

		if (url.pathname === '/api/loadbalancer/generate-snippet') {
			return this.handleGenerateSnippet(request);
		}

		if (url.pathname.startsWith('/api/workflow-status/')) {
			return this.handleWorkflowStatus(request);
		}

		if (url.pathname === '/api/broadcast-status' && request.method === 'POST') {
			const status = await request.json();
			this.broadcastWorkflowStatus(status);
			return new Response(JSON.stringify({ success: true }));
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

		try {
			console.log('Starting deployment workflow for:', config.name);
			console.log('Workflow binding:', this.env.DEPLOY_SNIPPET_WORKFLOW);
			
			// Create a new workflow instance
			const instance = await this.env.DEPLOY_SNIPPET_WORKFLOW.create({
				params: {
					loadBalancerName: config.name,
					config: config
				}
			});

			console.log('Workflow instance created:', instance);
			console.log('Workflow ID:', instance.id);

			// Track the new workflow
			await this.trackWorkflow(instance.id, config.name);

			return {
				success: true,
				workflowId: instance.id
			};
		} catch (error) {
			console.error('Error starting deployment workflow:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred'
			};
		}
	}

	private async handleGenerateSnippet(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get('name');
		if (!name) {
			return new Response('Load balancer name is required', { status: 400 });
		}

		const config = await this.getLoadBalancerConfig(name);
		if (!config) {
			return new Response('Load balancer not found', { status: 404 });
		}

		const snippet = this.generateSnippet(config);
		return new Response(JSON.stringify(snippet), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Update the workflow status handler
	async handleWorkflowStatus(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const workflowId = url.pathname.split('/workflow-status/')[1];
		
		if (!workflowId) {
			return new Response('Workflow ID is required', { status: 400 });
		}

		try {
			console.log('Getting workflow instance for ID:', workflowId);
			const instance = await this.env.DEPLOY_SNIPPET_WORKFLOW.get(workflowId);
			console.log('Got workflow instance:', instance);
			
			console.log('Getting workflow status');
			const status = await instance.status();
			console.log('Raw workflow status:', status);

			if (status.completed) {
				await this.updateWorkflowStatus(workflowId, 'Complete', true);
			} else {
				await this.updateWorkflowStatus(workflowId, status.currentStep || 'Processing');
			}

			return new Response(JSON.stringify(status), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			console.error('Error getting workflow status:', error);
			return new Response(JSON.stringify({
				error: 'Failed to get workflow status',
				details: error instanceof Error ? error.message : 'Unknown error'
			}), { status: 500 });
		}
	}

	private broadcastWorkflowStatus(status: any) {
		console.log('Broadcasting workflow status:', status);
		
		const workflowStatus = {
			workflowId: status.workflowId,
			loadBalancerName: status.loadBalancerName || 'unknown',
			completed: status.completed || false,
			success: status.success || false,
			currentStep: status.currentStep || 'Processing',
			error: status.error
		};

		const message: WebSocketMessage = {
			type: 'workflowStatus',
			workflowStatus
		};

		this.sessions = this.sessions.filter(ws => {
			try {
				ws.send(JSON.stringify(message));
				return true;
			} catch (error) {
				console.error('Failed to send WebSocket message:', error);
				return false;
			}
		});
	}

	// Simplify trackWorkflow
	private async trackWorkflow(workflowId: string, loadBalancerName: string) {
		this.activeWorkflows.set(loadBalancerName, {
			workflowId,
			loadBalancerName,
			currentStep: 'Starting deployment'
		});
		await this.ctx.storage.put('activeWorkflows', Object.fromEntries(this.activeWorkflows));
		this.broadcastWorkflowUpdate(loadBalancerName);
	}

	// Add method to update workflow status
	private async updateWorkflowStatus(workflowId: string, currentStep: string, completed = false) {
		// Find the workflow by ID
		const entry = Array.from(this.activeWorkflows.entries())
			.find(([_, w]) => w.workflowId === workflowId);
		
		if (!entry) return;
		
		const [loadBalancerName, workflow] = entry;
		
		if (completed) {
			this.activeWorkflows.delete(loadBalancerName);
		} else {
			workflow.currentStep = currentStep;
			this.activeWorkflows.set(loadBalancerName, workflow);
		}
		
		await this.ctx.storage.put('activeWorkflows', Object.fromEntries(this.activeWorkflows));
		this.broadcastWorkflowUpdate(loadBalancerName);
	}

	// Simplify broadcastWorkflowUpdate
	private broadcastWorkflowUpdate(loadBalancerName: string) {
		const workflow = this.activeWorkflows.get(loadBalancerName);
		const message: WebSocketMessage = {
			type: 'workflowStatus',
			workflowStatus: workflow ? {
				workflowId: workflow.workflowId,
				loadBalancerName,
				currentStep: workflow.currentStep,
				completed: false,
				success: false
			} : {
				workflowId: 'completed',
				loadBalancerName,
				completed: true,
				success: true
			}
		};

		this.sessions.forEach(ws => {
			try {
				ws.send(JSON.stringify(message));
			} catch (error) {
				console.error('Error sending workflow update:', error);
			}
		});
	}
} 