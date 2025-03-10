import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

interface SnippetResponse {
  code: string;
  name: string;
}

interface CloudflareResponse {
  success: boolean;
  result: any;
  errors: any[];
}

type Env = {
  LOAD_BALANCER: DurableObjectNamespace;
  LOADBALANCER_REGISTRY: DurableObjectNamespace;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_API_TOKEN: string;
};

type DeployParams = {
  loadBalancerName: string;
  config: {
    expression?: {
      hostname?: string;
      path?: string;
    };
  };
};

export class DeploySnippetWorkflow extends WorkflowEntrypoint<Env, DeployParams> {
  async run(event: WorkflowEvent<DeployParams>, step: WorkflowStep): Promise<{ success: boolean; snippetId: string }> {
    try {
      const { loadBalancerName, config } = event.payload;
      const sanitizedName = this.sanitizeSnippetName(loadBalancerName);

      // Get LoadBalancer instance for broadcasting status
      const id = this.env.LOAD_BALANCER.idFromName('default');
      const loadBalancer = this.env.LOAD_BALANCER.get(id);

      const broadcastStatus = async (currentStep: string) => {
        await loadBalancer.fetch(new Request('http://localhost/api/broadcast-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workflowId: event.workflowId,
            loadBalancerName: loadBalancerName,
            completed: false,
            success: false,
            currentStep
          })
        }));
      };

      // Step 1: Check if snippet exists
      await broadcastStatus('Checking if snippet exists...');
      const snippetExists = await step.do(
        'check-snippet-exists',
        {
          retries: {
            limit: 3,
            delay: '5 seconds',
            backoff: 'exponential',
          },
        },
        async (): Promise<boolean> => {
          console.log('Checking if snippet exists:', sanitizedName);
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/snippets/${sanitizedName}`,
            {
              headers: {
                'Authorization': `Bearer ${this.env.CF_API_TOKEN}`
              }
            }
          );
          const exists = response.status !== 404;
          console.log('Snippet exists:', exists);
          return exists;
        }
      );

      console.log('Step 1 complete. Snippet exists:', snippetExists);
      console.log('Starting Step 2: Generate and deploy snippet');

      // Step 2: Generate and deploy snippet
      await broadcastStatus('Deploying snippet...');
      const snippetDeployment = await step.do(
        'deploy-snippet',
        {
          retries: {
            limit: 5,
            delay: '10 seconds',
            backoff: 'exponential',
          },
        },
        async (): Promise<CloudflareResponse> => {
          try {
            console.log('Step 2: Starting snippet deployment');
            const method = snippetExists ? 'PUT' : 'POST';
            const endpoint = `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/snippets${
              method === 'PUT' ? '/' + sanitizedName : ''
            }`;
            console.log('Step 2: Using endpoint:', endpoint);

            console.log('Step 2: Getting LoadBalancer instance');
            const id = this.env.LOAD_BALANCER.idFromName('default');
            const loadBalancer = this.env.LOAD_BALANCER.get(id);

            console.log('Step 2: Fetching snippet code');
            const snippetResponse = await loadBalancer.fetch(
              new Request(`http://localhost/api/loadbalancer/generate-snippet?name=${loadBalancerName}`)
            );
            
            if (!snippetResponse.ok) {
              const errorText = await snippetResponse.text();
              console.error('Step 2: Failed to generate snippet:', errorText);
              throw new Error(`Failed to generate snippet: ${errorText}`);
            }

            const snippet = await snippetResponse.json() as SnippetResponse;
            console.log('Step 2: Got snippet code');

            console.log('Step 2: Preparing FormData');
            const formData = new FormData();
            const snippetBlob = new Blob([snippet.code], { type: 'application/javascript' });
            formData.append('files', snippetBlob, 'snippet.js');
            formData.append('metadata', JSON.stringify({
              name: sanitizedName,
              description: `Load balancer for ${loadBalancerName}`,
              enabled: true,
              main_module: 'snippet.js'
            }));

            console.log('Step 2: Sending request to Cloudflare');
            const response = await fetch(endpoint, {
              method,
              headers: {
                'Authorization': `Bearer ${this.env.CF_API_TOKEN}`
              },
              body: formData
            });

            if (!response.ok) {
              const errorText = await response.text();
              console.error('Step 2: Failed to deploy snippet:', errorText);
              throw new Error(`Failed to deploy snippet: ${errorText}`);
            }

            const result = await response.json();
            console.log('Step 2: Deployment successful:', result);
            return result;
          } catch (error) {
            console.error('Step 2: Error in deployment:', error);
            throw error; // Re-throw to trigger retry
          }
        }
      );

      console.log('Step 2 complete. Result:', snippetDeployment);
      console.log('Starting Step 3: Update rules');
      console.log('Config for rules:', config);

      // Step 3: Update rules
      await broadcastStatus('Updating routing rules...');
      const rulesUpdate = await step.do(
        'update-rules',
        {
          retries: {
            limit: 3,
            delay: '5 seconds',
            backoff: 'exponential',
          },
        },
        async (): Promise<CloudflareResponse> => {
          try {
            console.log('Step 3: Building expression');
            const conditions = [];
            if (config.expression?.hostname) {
              conditions.push(`(http.host eq "${config.expression.hostname}")`);
            }
            if (config.expression?.path) {
              conditions.push(`(http.request.uri.path contains "${config.expression.path}")`);
            }
            const expression = conditions.length > 0 ? conditions.join(' and ') : 'true';
            console.log('Step 3: Built expression:', expression);

            console.log('Step 3: Fetching existing rules');
            const getRulesResponse = await fetch(
              `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/snippets/snippet_rules`,
              {
                headers: {
                  'Authorization': `Bearer ${this.env.CF_API_TOKEN}`
                }
              }
            );

            if (!getRulesResponse.ok) {
              const errorText = await getRulesResponse.text();
              console.error('Step 3: Failed to fetch rules:', errorText);
              throw new Error(`Failed to fetch rules: ${errorText}`);
            }

            const existingRulesData = await getRulesResponse.json() as CloudflareResponse;
            console.log('Step 3: Existing rules:', existingRulesData);
            const existingRules = existingRulesData.result || [];

            const newRule = {
              description: `Rule for load balancer: ${loadBalancerName}`,
              enabled: true,
              expression: expression,
              snippet_name: sanitizedName
            };
            console.log('Step 3: New rule:', newRule);

            const updatedRules = existingRules
              .filter((rule: any) => rule.snippet_name !== sanitizedName)
              .concat([newRule]);
            console.log('Step 3: Updated rules:', updatedRules);

            console.log('Step 3: Sending rules update');
            const ruleResponse = await fetch(
              `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/snippets/snippet_rules`,
              {
                method: 'PUT',
                headers: {
                  'Authorization': `Bearer ${this.env.CF_API_TOKEN}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ rules: updatedRules })
              }
            );

            if (!ruleResponse.ok) {
              const errorText = await ruleResponse.text();
              console.error('Step 3: Failed to update rules:', errorText);
              throw new Error(`Failed to update rules: ${errorText}`);
            }

            const result = await ruleResponse.json();
            console.log('Step 3: Rules update successful:', result);
            return result;
          } catch (error) {
            console.error('Step 3: Error in rules update:', error);
            throw error; // Re-throw to trigger retry
          }
        }
      );

      console.log('Step 3 complete. Rules update result:', rulesUpdate);
      console.log('Workflow completed successfully');

      // Broadcast completion
      await loadBalancer.fetch(new Request('http://localhost/api/broadcast-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: event.workflowId,
          loadBalancerName: loadBalancerName,
          completed: true,
          success: true,
          currentStep: 'Deployment complete'
        })
      }));

      return {
        success: true,
        snippetId: sanitizedName
      };
    } catch (error) {
      // Broadcast error
      const id = this.env.LOAD_BALANCER.idFromName('default');
      const loadBalancer = this.env.LOAD_BALANCER.get(id);
      await loadBalancer.fetch(new Request('http://localhost/api/broadcast-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: event.workflowId,
          loadBalancerName: loadBalancerName,
          completed: true,
          success: false,
          currentStep: 'Failed',
          error: error instanceof Error ? error.message : String(error)
        })
      }));

      console.error('Workflow failed:', error);
      console.error('Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error; // This will mark the workflow as failed
    }
  }

  private sanitizeSnippetName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  }
}

export default DeploySnippetWorkflow; 