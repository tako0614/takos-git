/**
 * The new-issue form: a title, a Write/Preview Markdown body, and an optional
 * triage sidebar (labels / assignees / milestone) that reuses the same editors
 * as the detail page. On submit it POSTs through `issuesApi.create` and routes
 * to the created issue.
 */
import {
  createResource,
  createSignal,
  onCleanup,
  Index,
  Show,
  type JSX,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { issuesApi } from "../../api/issues.ts";
import { collaboratorsApi } from "../../api/admin.ts";
import { ApiError } from "../../api/client.ts";
import { useSession } from "../../store/session.tsx";
import {
  Avatar,
  Banner,
  Button,
  Field,
  Icons,
  TextInput,
  useConfirmDialog,
  useToast,
} from "../../ui/index.ts";
import { LabelChip, MarkdownEditor } from "./parts.tsx";
import { AssigneeEditor, LabelEditor, MilestoneEditor } from "./pickers.tsx";
import { createIssueSubmission, type IssueSubmission } from "./issue-submission.ts";

export function NewIssueForm(props: { owner: string; repo: string; repositoryId: string; recoveryScope: string }): JSX.Element {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const scope = { owner: props.owner, repo: props.repo };
  const base = () => `/${scope.owner}/${scope.repo}`;
  let retired = false;
  onCleanup(() => { retired = true; });

  const submission = createIssueSubmission(undefined, props.repositoryId && props.recoveryScope
    ? { storage: () => sessionStorage, scope: props.recoveryScope, repositoryId: props.repositoryId } : undefined);
  const restored = submission.restoredForm();
  const [title, setTitle] = createSignal(restored?.input.title ?? "");
  const [body, setBody] = createSignal(restored?.input.body ?? "");
  const [labelNames, setLabelNames] = createSignal<string[]>([...(restored?.input.labels ?? [])]);
  const [assigneeSubjects, setAssigneeSubjects] = createSignal<string[]>([...(restored?.input.assignees ?? [])]);
  const [milestone, setMilestone] = createSignal<number | null>(restored?.input.milestone ?? null);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [created, setCreated] = createSignal<number | null>(null);
  let revision = restored?.revision ?? 0;
  const saveDraft = () => submission.saveDraft({ title: title(), body: body(), labels: labelNames(), assignees: assigneeSubjects(), milestone: milestone() ?? undefined }, revision);
  const changeTitle = (value: string) => { revision++; setTitle(value); saveDraft(); };
  const changeBody = (value: string) => { revision++; setBody(value); saveDraft(); };
  const changeLabels = (value: string[]) => { revision++; setLabelNames(value); saveDraft(); };
  const changeAssignees = (value: string[]) => { revision++; setAssigneeSubjects(value); saveDraft(); };
  const changeMilestone = (value: number | null) => { revision++; setMilestone(value); saveDraft(); };

  const repoKey = () => [scope.owner, scope.repo] as const;
  const [labels] = createResource(repoKey, ([o, r]) => issuesApi.labels(o, r));
  const [milestones] = createResource(repoKey, ([o, r]) => issuesApi.milestones(o, r));
  const [collaborators] = createResource(repoKey, async ([o, r]) => {
    try {
      return await collaboratorsApi.list(o, r);
    } catch {
      return { items: [] as never[], nextCursor: null };
    }
  });

  const selectedLabels = () =>
    (labels()?.items ?? []).filter((l) => labelNames().includes(l.name));
  const selectedMilestone = () =>
    (milestones()?.items ?? []).find((m) => m.number === milestone()) ?? null;
  const unlistedLabels = () => labels.loading || labels.error || !labels.latest ? []
    : labelNames().filter(name => !labels.latest!.items.some(label => label.name === name));
  const unlistedMilestone = () => milestone() !== null && !milestones.loading && !milestones.error && !!milestones.latest
    && !milestones.latest.items.some(item => item.number === milestone());

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (retired || submitting() || submission.state()) return;
    const t = title().trim();
    if (!t) {
      setError("A title is required.");
      return;
    }
    try {
      const attempt = submission.begin({
        title: t,
        body: body().trim() ? body() : undefined,
        labels: labelNames().length ? labelNames() : undefined,
        assignees: assigneeSubjects().length ? assigneeSubjects() : undefined,
        milestone: milestone() ?? undefined,
      }, revision);
      if (attempt) { setCreated(null); await send(attempt); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prepare this submission.");
    }
  }

  async function send(attempt: IssueSubmission): Promise<void> {
    setSubmitting(true); setError(null);
    try {
      const { issue } = await issuesApi.create(scope.owner, scope.repo, attempt.input, attempt.idempotencyKey);
      if (retired || !submission.acknowledge(attempt)) return;
      if (revision === attempt.revision) {
        toast.success(`Created issue #${issue.number}`);
        navigate(`${base()}/issues/${issue.number}`);
      } else {
        setCreated(issue.number);
      }
    } catch (err) {
      if (retired) return;
      submission.fail(attempt, err);
      setError(err instanceof ApiError ? err.message : "We could not confirm the creation result.");
    } finally {
      if (!retired) setSubmitting(false);
    }
  }

  async function retry(attempt: IssueSubmission): Promise<void> {
    const ok = await confirm({ title: "Retry the original Issue?", message: `Recover the creation result for “${attempt.input.title}”. Your newer edits will stay in this form.`, confirmText: "Retry original" });
    if (ok && !retired && !submitting() && submission.retry(attempt)) await send(attempt);
  }

  return (
    <div>
      <div class="mb-4 flex items-center gap-3">
        <Avatar name={session.user()?.name || session.user()?.subject || "you"} size={40} />
        <div>
          <h1 class="text-xl font-semibold text-fg">Create new issue</h1>
          <p class="text-sm text-muted">
            in <A href={base()} class="text-accent hover:underline">{props.owner}/{props.repo}</A>
          </p>
        </div>
      </div>

      <Show
        when={session.authenticated()}
        fallback={
          <Banner
            tone="info"
            action={
              <Button size="sm" variant="primary" onClick={() => session.signIn()}>
                Sign in
              </Button>
            }
          >
            You need to sign in to open an issue.
          </Banner>
        }
      >
        <form onSubmit={submit} class="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]">
          <div class="min-w-0 space-y-4">
            <Field label="Title" required for="issue-title">
              <TextInput
                id="issue-title"
                value={title()}
                placeholder="Title"
                onInput={(e) => changeTitle(e.currentTarget.value)}
              />
            </Field>

            <Field label="Description" for="issue-body">
              <MarkdownEditor
                id="issue-body"
                value={body()}
                onInput={changeBody}
                placeholder="Leave a comment"
                rows={10}
              />
            </Field>

            <Show when={submission.unknown()}>
              {(attempt) => (
                <Banner tone="warning" title="Creation result unknown">
                  <p>{submission.storageError() ?? error()} Retry the original submission for “{attempt().input.title}” to recover its result.</p>
                  <Button type="button" size="sm" class="mt-2" onClick={() => void retry(attempt())}>Retry original creation</Button>
                </Banner>
              )}
            </Show>
            <Show when={created()}>
              {(number) => <Banner tone="success">Issue <A class="text-accent hover:underline" href={`${base()}/issues/${number()}`}>#{number()}</A> was created. Your newer edits remain in this draft.</Banner>}
            </Show>
            <Show when={!submission.unknown() && (submission.storageError() ?? error())}>
              {(msg) => <Banner tone="danger">{msg()}</Banner>}
            </Show>

            <div class="flex items-center justify-end gap-2 border-t border-border pt-4">
              <A
                href={`${base()}/issues`}
                class="tg-focus rounded-md border border-border px-3 py-1.5 text-sm hover:bg-canvas-subtle"
              >
                Cancel
              </A>
              <Button
                type="submit"
                variant="primary"
                disabled={submitting() || !!submission.state() || !title().trim()}
              >
                <Icons.Check class="h-4 w-4" /> Submit new issue
              </Button>
            </div>
          </div>

          <aside class="space-y-5">
            <section class="space-y-2 border-b border-border pb-4">
              <LabelEditor
                all={labels()?.items ?? []}
                loading={labels.loading}
                selected={labelNames()}
                onApply={changeLabels}
              />
              <Show
                when={selectedLabels().length > 0}
                fallback={<Show when={labelNames().length === 0}><p class="text-sm text-muted">None yet</p></Show>}
              >
                <div class="flex flex-wrap gap-1.5">
                  <Index each={selectedLabels()}>{(l) => <LabelChip label={l()} />}</Index>
                </div>
              </Show>
              <Index each={unlistedLabels()}>{name => <div class="text-sm text-muted">
                Saved label “{name()}” is not in the loaded choices.
                <Button type="button" size="sm" onClick={() => changeLabels(labelNames().filter(value => value !== name()))}>Remove saved label</Button>
              </div>}</Index>
            </section>

            <section class="space-y-2 border-b border-border pb-4">
              <AssigneeEditor
                candidates={(collaborators()?.items ?? []).map((c) => c.principal)}
                loading={collaborators.loading}
                selected={assigneeSubjects()}
                allowManual
                onApply={changeAssignees}
              />
              <Show
                when={assigneeSubjects().length > 0}
                fallback={<p class="text-sm text-muted">No one assigned</p>}
              >
                <ul class="space-y-1.5">
                  <Index each={assigneeSubjects()}>
                    {(s) => (
                      <li class="flex items-center gap-2 text-sm">
                        <Avatar name={s()} size={20} />
                        <span class="text-fg">{s()}</span>
                      </li>
                    )}
                  </Index>
                </ul>
              </Show>
            </section>

            <section class="space-y-2">
              <MilestoneEditor
                all={milestones()?.items ?? []}
                loading={milestones.loading}
                selected={milestone()}
                onApply={changeMilestone}
              />
              <Show when={unlistedMilestone()}><div class="text-sm text-muted">
                Saved milestone #{milestone()} is not in the loaded choices.
                <Button type="button" size="sm" onClick={() => changeMilestone(null)}>Clear saved milestone</Button>
              </div></Show>
              <Show
                when={selectedMilestone()}
                fallback={<Show when={milestone() === null}><p class="text-sm text-muted">No milestone</p></Show>}
              >
                {(m) => (
                  <span class="inline-flex items-center gap-1.5 text-sm text-fg">
                    <Icons.Tag class="h-3.5 w-3.5 text-muted" /> {m().title}
                  </span>
                )}
              </Show>
            </section>
          </aside>
        </form>
      </Show>
    </div>
  );
}
