/**
 * The new-issue form: a title, a Write/Preview Markdown body, and an optional
 * triage sidebar (labels / assignees / milestone) that reuses the same editors
 * as the detail page. On submit it POSTs through `issuesApi.create` and routes
 * to the created issue.
 */
import {
  createResource,
  createSignal,
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
  useToast,
} from "../../ui/index.ts";
import { LabelChip, MarkdownEditor } from "./parts.tsx";
import { AssigneeEditor, LabelEditor, MilestoneEditor } from "./pickers.tsx";

export function NewIssueForm(props: { owner: string; repo: string }): JSX.Element {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const base = () => `/${props.owner}/${props.repo}`;

  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [labelNames, setLabelNames] = createSignal<string[]>([]);
  const [assigneeSubjects, setAssigneeSubjects] = createSignal<string[]>([]);
  const [milestone, setMilestone] = createSignal<number | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const repoKey = () => [props.owner, props.repo] as const;
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

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    const t = title().trim();
    if (!t) {
      setError("A title is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { issue } = await issuesApi.create(props.owner, props.repo, {
        title: t,
        body: body().trim() ? body() : undefined,
        labels: labelNames().length ? labelNames() : undefined,
        assignees: assigneeSubjects().length ? assigneeSubjects() : undefined,
        milestone: milestone() ?? undefined,
      });
      toast.success(`Opened issue #${issue.number}`);
      navigate(`${base()}/issues/${issue.number}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the issue.");
    } finally {
      setSubmitting(false);
    }
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
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
            </Field>

            <Field label="Description" for="issue-body">
              <MarkdownEditor
                id="issue-body"
                value={body()}
                onInput={setBody}
                placeholder="Leave a comment"
                rows={10}
              />
            </Field>

            <Show when={error()}>
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
                disabled={submitting() || !title().trim()}
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
                onApply={setLabelNames}
              />
              <Show
                when={selectedLabels().length > 0}
                fallback={<p class="text-sm text-muted">None yet</p>}
              >
                <div class="flex flex-wrap gap-1.5">
                  <Index each={selectedLabels()}>{(l) => <LabelChip label={l()} />}</Index>
                </div>
              </Show>
            </section>

            <section class="space-y-2 border-b border-border pb-4">
              <AssigneeEditor
                candidates={(collaborators()?.items ?? []).map((c) => c.principal)}
                loading={collaborators.loading}
                selected={assigneeSubjects()}
                allowManual
                onApply={setAssigneeSubjects}
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
                onApply={setMilestone}
              />
              <Show
                when={selectedMilestone()}
                fallback={<p class="text-sm text-muted">No milestone</p>}
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
