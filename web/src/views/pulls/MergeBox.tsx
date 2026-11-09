/**
 * The conversation-tab merge box: mergeability state, merge-method selector
 * (merge / squash / rebase), optional commit message, and the merge action. It
 * surfaces branch-protection refusals (HTTP 403 `protected_ref` /
 * `review_required` / `required_checks_failing` / `branch_not_up_to_date` …) as
 * an inline banner, and expands the ConflictResolver when the PR is not
 * mergeable.
 */
import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { pullsApi, type MergeResponse } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import type { PullRequestDto } from "../../api/types.ts";
import { useSession } from "../../store/session.tsx";
import {
  Banner,
  Box,
  Button,
  Icons,
  Menu,
  Textarea,
  useToast,
  type MenuItem,
} from "../../ui/index.ts";
import { ConflictResolver } from "./ConflictResolver.tsx";

type Method = "merge" | "squash" | "rebase";

const METHOD_LABEL: Record<Method, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

function protectionDetail(err: ApiError): JSX.Element | null {
  const d = err.details ?? {};
  if (err.code === "review_required" && typeof d.required === "number") {
    return <>Requires {String(d.required)} approving review(s); has {String(d.approvals ?? 0)}.</>;
  }
  if (err.code === "required_checks_failing" && Array.isArray(d.contexts)) {
    return <>Waiting on checks: {(d.contexts as string[]).join(", ")}.</>;
  }
  if (err.code === "branch_not_up_to_date" && typeof d.behindBy === "number") {
    return <>The base branch is {String(d.behindBy)} commit(s) ahead — update the branch first.</>;
  }
  return null;
}

export function MergeBox(props: {
  owner: string;
  repo: string;
  pr: PullRequestDto;
  onChanged: () => void;
}): JSX.Element {
  const session = useSession();
  const toast = useToast();
  const [method, setMethod] = createSignal<Method>("merge");
  const [message, setMessage] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [protection, setProtection] = createSignal<ApiError | null>(null);
  const [showResolver, setShowResolver] = createSignal(false);

  let live = true;
  onCleanup(() => { live = false; });
  const scope = () => JSON.stringify([props.owner, props.repo, props.pr.number, session.user()?.subject]);
  const [ack, setAck] = createSignal<{ scope: string; commitSha: string } | null>(null);
  createEffect(() => {
    scope();
    setAck(null); setBusy(false); setConfirming(false); setProtection(null); setShowResolver(false);
  });
  const pending = () => props.pr.mergePending?.commitSha ?? (ack()?.scope === scope() ? ack()?.commitSha : undefined);
  const accept = (result: MergeResponse) => {
    setAck(result.metadataPending ? { scope: scope(), commitSha: result.mergeCommit } : null);
    if (!result.metadataPending) {
      toast.success("Pull request merged.");
      setConfirming(false);
      setMessage("");
    }
    props.onChanged();
  };
  const updateStatus = async () => {
    if (busy()) return;
    const captured = scope();
    setBusy(true);
    try {
      const result = await pullsApi.reconcile(props.owner, props.repo, props.pr.number);
      if (live && captured === scope()) accept(result);
    } catch (err) {
      if (live && captured === scope()) toast.error(err instanceof ApiError ? err.message : "Failed to update merge status.");
    } finally { if (live && captured === scope()) setBusy(false); }
  };

  const dirty = () => props.pr.mergeable === "dirty";

  const doMerge = async () => {
    if (busy() || pending()) return;
    const captured = scope();
    setBusy(true);
    setProtection(null);
    try {
      const result = await pullsApi.merge(props.owner, props.repo, props.pr.number, {
        method: method(),
        commitMessage: message().trim() || undefined,
      });
      if (live && captured === scope()) accept(result);
    } catch (err) {
      if (!live || captured !== scope()) return;
      if (err instanceof ApiError && err.status === 403) {
        setProtection(err);
      } else {
        toast.error(err instanceof ApiError ? err.message : "Failed to merge.");
      }
    } finally {
      if (live && captured === scope()) setBusy(false);
    }
  };

  const methodItems: MenuItem[] = (["merge", "squash", "rebase"] as Method[]).map((m) => ({
    label: METHOD_LABEL[m],
    onSelect: () => setMethod(m),
  }));


  return (
    <Show when={!props.pr.merged} fallback={<Box class="p-4">
        <div class="flex items-center gap-2">
          <span class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-done-emphasis text-white">
            <Icons.GitMerge class="h-4 w-4" />
          </span>
          <div class="text-sm">
            <span class="font-semibold text-fg">Pull request merged.</span>{" "}
            <span class="text-muted">
              The changes were merged into <code class="font-mono">{props.pr.base.ref}</code>.
            </span>
          </div>
        </div>
      </Box>}>
    <Show when={props.pr.state !== "closed"} fallback={<Box class="p-4">
        <div class="flex items-center gap-2 text-sm">
          <span class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-danger-emphasis text-white">
            <Icons.X class="h-4 w-4" />
          </span>
          <span class="font-semibold text-fg">Closed with unmerged commits.</span>
        </div>
      </Box>}>
    <Box>
      <Show when={pending()} fallback={<>
      <div class="flex items-start gap-3 border-b border-border px-4 py-3">
        <Show
          when={!dirty()}
          fallback={
            <>
              <Icons.AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-attention" />
              <div class="text-sm">
                <div class="font-semibold text-fg">This branch has conflicts that must be resolved</div>
                <div class="text-muted">
                  Merging <code class="font-mono">{props.pr.head.ref}</code> into{" "}
                  <code class="font-mono">{props.pr.base.ref}</code> has conflicting files.
                </div>
              </div>
            </>
          }
        >
          <Icons.Check class="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div class="text-sm">
            <div class="font-semibold text-fg">
              <Show when={props.pr.mergeable === "unknown"} fallback={<>This branch has no conflicts with the base branch</>}>
                Checking mergeability…
              </Show>
            </div>
            <div class="text-muted">Merging can be performed automatically.</div>
          </div>
        </Show>
      </div>

      <div class="space-y-3 px-4 py-3">
        <Show when={protection()}>
          {(err) => (
            <Banner tone="warning" title={err().message}>
              {protectionDetail(err()) ?? "A branch protection rule blocked this merge."}
            </Banner>
          )}
        </Show>

        <Show
          when={session.authenticated()}
          fallback={<p class="text-sm text-muted">Sign in to merge this pull request.</p>}
        >
          <Show
            when={!dirty()}
            fallback={
              <div class="space-y-3">
                <Button variant="primary" onClick={() => setShowResolver((v) => !v)}>
                  <Icons.GitMerge class="h-4 w-4" />
                  {showResolver() ? "Hide conflict resolver" : "Resolve conflicts"}
                </Button>
                <Show when={showResolver()}>
                  <ConflictResolver
                    owner={props.owner}
                    repo={props.repo}
                    pr={props.pr}
                    onResolved={(result) => {
                      setShowResolver(false);
                      accept(result);
                    }}
                    onCancel={() => setShowResolver(false)}
                  />
                </Show>
              </div>
            }
          >
            <Show
              when={confirming()}
              fallback={
                <div class="flex flex-wrap items-center gap-2">
                  <Button variant="primary" onClick={() => setConfirming(true)}>
                    <Icons.GitMerge class="h-4 w-4" /> {METHOD_LABEL[method()]}
                  </Button>
                  <Menu
                    align="left"
                    triggerLabel="Choose a merge method"
                    trigger={
                      <span class="tg-focus inline-flex h-8 items-center gap-1 rounded-md border border-border bg-canvas-subtle px-2 text-sm text-fg hover:bg-canvas-inset">
                        <Icons.ChevronDown class="h-4 w-4" />
                      </span>
                    }
                    items={methodItems}
                  />
                </div>
              }
            >
              <div class="space-y-2">
                <Show when={method() !== "rebase"}>
                  <Textarea
                    rows={3}
                    placeholder="Optional commit message"
                    value={message()}
                    onInput={(e) => setMessage(e.currentTarget.value)}
                  />
                </Show>
                <div class="flex items-center gap-2">
                  <Button variant="primary" onClick={doMerge} disabled={busy()}>
                    {busy() ? "Merging…" : `Confirm ${method()}`}
                  </Button>
                  <Button onClick={() => setConfirming(false)} disabled={busy()}>Cancel</Button>
                  <span class="text-xs text-muted">{METHOD_LABEL[method()]}</span>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
      </>}>
        <div class="p-4 space-y-3">
          <Banner tone="warning" title="Merge committed; status update pending">
            The Git changes were applied at <code class="font-mono break-all">{pending()}</code>.
            Update the pull request status without merging again.
          </Banner>
          <Show when={session.authenticated()} fallback={<p class="text-sm text-muted">Sign in to update this merge's status.</p>}>
            <Button onClick={updateStatus} disabled={busy()}>{busy() ? "Updating status…" : "Update status"}</Button>
          </Show>
        </div>
      </Show>
    </Box>
    </Show>
    </Show>
  );
}
