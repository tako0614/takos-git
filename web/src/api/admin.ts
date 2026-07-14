/**
 * Repo administration clients: collaborators, branch protection, webhooks. Back
 * the Settings sub-tabs. All require owner/admin per the route table §4.2–§4.10.
 */
import { api, getPage, repoPath, type Page } from "./client.ts";
import type {
  BranchProtectionRuleDto,
  CollaboratorDto,
  WebhookDeliveryDto,
  WebhookDto,
} from "./types.ts";
import type { Role } from "./contract.ts";

export const collaboratorsApi = {
  list(owner: string, repo: string, signal?: AbortSignal): Promise<Page<CollaboratorDto>> {
    return getPage<CollaboratorDto>(`${repoPath(owner, repo)}/collaborators`, "collaborators", {}, signal);
  },
  set(owner: string, repo: string, principal: string, role: Role): Promise<void> {
    return api.put(`${repoPath(owner, repo)}/collaborators/${encodeURIComponent(principal)}`, { role });
  },
  remove(owner: string, repo: string, principal: string): Promise<void> {
    return api.del(`${repoPath(owner, repo)}/collaborators/${encodeURIComponent(principal)}`);
  },
};

export const branchProtectionApi = {
  list(owner: string, repo: string, signal?: AbortSignal): Promise<Page<BranchProtectionRuleDto>> {
    return getPage<BranchProtectionRuleDto>(`${repoPath(owner, repo)}/branch-protection`, "rules", {}, signal);
  },
  get(owner: string, repo: string, pattern: string, signal?: AbortSignal): Promise<{ rule: BranchProtectionRuleDto }> {
    return api.get(`${repoPath(owner, repo)}/branch-protection/${encodeURIComponent(pattern)}`, undefined, signal);
  },
  put(owner: string, repo: string, pattern: string, rule: Partial<BranchProtectionRuleDto>): Promise<{ rule: BranchProtectionRuleDto }> {
    return api.put(`${repoPath(owner, repo)}/branch-protection/${encodeURIComponent(pattern)}`, rule);
  },
  remove(owner: string, repo: string, pattern: string): Promise<void> {
    return api.del(`${repoPath(owner, repo)}/branch-protection/${encodeURIComponent(pattern)}`);
  },
};

export const webhooksApi = {
  list(owner: string, repo: string, signal?: AbortSignal): Promise<Page<WebhookDto>> {
    return getPage<WebhookDto>(`${repoPath(owner, repo)}/hooks`, "hooks", {}, signal);
  },
  get(owner: string, repo: string, id: string, signal?: AbortSignal): Promise<{ hook: WebhookDto }> {
    return api.get(`${repoPath(owner, repo)}/hooks/${encodeURIComponent(id)}`, undefined, signal);
  },
  create(owner: string, repo: string, input: { url: string; secret?: string; events: string[]; active?: boolean }): Promise<{ hook: WebhookDto }> {
    return api.post(`${repoPath(owner, repo)}/hooks`, input);
  },
  update(owner: string, repo: string, id: string, patch: Partial<{ url: string; secret: string; events: string[]; active: boolean }>): Promise<{ hook: WebhookDto }> {
    return api.patch(`${repoPath(owner, repo)}/hooks/${encodeURIComponent(id)}`, patch);
  },
  remove(owner: string, repo: string, id: string): Promise<void> {
    return api.del(`${repoPath(owner, repo)}/hooks/${encodeURIComponent(id)}`);
  },
  ping(owner: string, repo: string, id: string): Promise<void> {
    return api.post(`${repoPath(owner, repo)}/hooks/${encodeURIComponent(id)}/pings`);
  },
  deliveries(owner: string, repo: string, id: string, signal?: AbortSignal): Promise<Page<WebhookDeliveryDto>> {
    return getPage<WebhookDeliveryDto>(`${repoPath(owner, repo)}/hooks/${encodeURIComponent(id)}/deliveries`, "deliveries", {}, signal);
  },
};
