/**
 * The issue conversation screen: title (with inline edit), open/closed badge,
 * the issue body + comment timeline, an add-comment composer with close/reopen,
 * and a triage sidebar (assignees / labels / milestone editors). All writes go
 * through `issuesApi`; failures surface as toasts and the affected resource is
 * refetched so the UI reflects the server.
 */
import {
  batch,
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  Index,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { A } from "@solidjs/router";
import { issuesApi } from "../../api/issues.ts";
import { collaboratorsApi } from "../../api/admin.ts";
import { ApiError } from "../../api/client.ts";
import { useSession } from "../../store/session.tsx";
import {
  Avatar,
  Banner,
  Button,
  EmptyState,
  Icons,
  IconButton,
  LoadingBlock,
  Markdown,
  Menu,
  RelativeTime,
  Spinner,
  TextInput,
  useConfirmDialog,
  useToast,
} from "../../ui/index.ts";
import {
  IssueStateBadge,
  LabelChip,
  MarkdownEditor,
  principalName,
  TimelineComment,
} from "./parts.tsx";
import { AssigneeEditor, LabelEditor, MilestoneEditor } from "./pickers.tsx";
import { issuesExtraApi } from "./api-extra.ts";
import type { IssueCommentDto } from "../../api/types.ts";

export function IssueDetail(props: {
  owner: string;
  repo: string;
  number: number;
}): JSX.Element {
  const session = useSession();
  const toast = useToast();
  const { confirm } = useConfirmDialog();
  const base = () => `/${props.owner}/${props.repo}`;

  const issueKey = () =>
    [props.owner, props.repo, props.number] as [string, string, number];
  const [issueRes, { refetch: refetchIssue, mutate: mutateIssue }] = createResource(
    issueKey,
    ([o, r, n]) => issuesApi.get(o, r, n),
  );
  const issue = () => issueRes()?.issue;

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

  // Comment timeline (accumulated across "load more").
  const [comments, setComments] = createSignal<IssueCommentDto[]>([]);
  const [commentsCursor, setCommentsCursor] = createSignal<string | null>(null);
  const [commentsLoading, setCommentsLoading] = createSignal(false);
  const [commentsError, setCommentsError] = createSignal<string | null>(null);

  async function loadComments(reset: boolean): Promise<void> {
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      const cursor = reset ? null : commentsCursor();
      const pageData = await issuesApi.comments(props.owner, props.repo, props.number, {
        cursor,
      });
      batch(() => {
        setComments((prev) => (reset ? [...pageData.items] : [...prev, ...pageData.items]));
        setCommentsCursor(pageData.nextCursor);
      });
    } catch (err) {
      setCommentsError(err instanceof ApiError ? err.message : "Could not load comments.");
    } finally {
      setCommentsLoading(false);
    }
  }

  createEffect(() => {
    // Reload the timeline whenever the issue identity changes.
    props.owner;
    props.repo;
    props.number;
    setComments([]);
    setCommentsCursor(null);
    void loadComments(true);
  });

  // --- write helpers --------------------------------------------------------

  const [busy, setBusy] = createSignal(false);

  async function patchIssue(
    patch: Parameters<typeof issuesApi.update>[3],
    successMsg?: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const { issue: updated } = await issuesApi.update(
        props.owner,
        props.repo,
        props.number,
        patch,
      );
      mutateIssue({ issue: updated });
      if (successMsg) toast.success(successMsg);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed.");
      void refetchIssue();
      return false;
    } finally {
      setBusy(false);
    }
  }

  // --- title editing --------------------------------------------------------

  const [editingTitle, setEditingTitle] = createSignal(false);
  const [titleDraft, setTitleDraft] = createSignal("");
  const beginEditTitle = () => {
    setTitleDraft(issue()?.title ?? "");
    setEditingTitle(true);
  };
  const saveTitle = async () => {
    const t = titleDraft().trim();
    if (!t) return;
    if (await patchIssue({ title: t })) setEditingTitle(false);
  };

  // --- body editing ---------------------------------------------------------

  const [editingBody, setEditingBody] = createSignal(false);
  const [bodyDraft, setBodyDraft] = createSignal("");
  const beginEditBody = () => {
    setBodyDraft(issue()?.body ?? "");
    setEditingBody(true);
  };
  const saveBody = async () => {
    if (await patchIssue({ body: bodyDraft() })) setEditingBody(false);
  };

  // --- comment composer -----------------------------------------------------

  const [commentDraft, setCommentDraft] = createSignal("");

  async function submitComment(closeAfter?: "open" | "closed"): Promise<void> {
    const bodyText = commentDraft().trim();
    setBusy(true);
    try {
      if (bodyText) {
        const { comment } = await issuesApi.comment(
          props.owner,
          props.repo,
          props.number,
          bodyText,
        );
        setComments((prev) => [...prev, comment]);
        setCommentDraft("");
      }
      if (closeAfter) {
        await patchIssue({ state: closeAfter });
      } else if (bodyText) {
        void refetchIssue(); // refresh comment count
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add comment.");
    } finally {
      setBusy(false);
    }
  }

  const notFound = () =>
    issueRes.error instanceof ApiError && issueRes.error.isNotFound;

  return (
    <ErrorBoundary
      fallback={(err) => (
        <Banner tone="danger" title="Could not load this issue">
          {err instanceof ApiError ? err.message : "Unexpected error."}
        </Banner>
      )}
    >
      <Show
        when={!notFound()}
        fallback={
          <EmptyState
            icon={<Icons.Inbox class="h-8 w-8" />}
            title="Issue not found"
            description={`No issue #${props.number} exists in this repository.`}
            action={
              <A
                href={`${base()}/issues`}
                class="tg-focus rounded-md border border-border px-3 py-1.5 text-sm hover:bg-canvas-subtle"
              >
                Back to issues
              </A>
            }
          />
        }
      >
        <Suspense fallback={<LoadingBlock label="Loading issue…" />}>
          <Show when={issue()}>
            {(iss) => (
              <div>
                {/* Title row */}
                <div class="mb-3 border-b border-border pb-4">
                  <Show
                    when={!editingTitle()}
                    fallback={
                      <div class="flex flex-wrap items-center gap-2">
                        <TextInput
                          class="flex-1"
                          value={titleDraft()}
                          onInput={(e) => setTitleDraft(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveTitle();
                            if (e.key === "Escape") setEditingTitle(false);
                          }}
                        />
                        <Button variant="primary" disabled={busy() || !titleDraft().trim()} onClick={saveTitle}>
                          Save
                        </Button>
                        <Button onClick={() => setEditingTitle(false)}>Cancel</Button>
                      </div>
                    }
                  >
                    <div class="flex flex-wrap items-start gap-2">
                      <h1 class="min-w-0 flex-1 text-2xl font-semibold leading-tight text-fg">
                        {iss().title}{" "}
                        <span class="font-normal text-muted">#{iss().number}</span>
                      </h1>
                      <div class="flex items-center gap-2">
                        <Show when={session.authenticated()}>
                          <Button size="sm" onClick={beginEditTitle}>
                            <Icons.Edit class="h-3.5 w-3.5" /> Edit
                          </Button>
                          <A
                            href={`${base()}/issues/new`}
                            class="tg-focus inline-flex h-7 items-center gap-2 rounded-md border border-success-emphasis bg-success-emphasis px-2.5 text-xs font-medium text-white hover:brightness-110"
                          >
                            <Icons.Plus class="h-3.5 w-3.5" /> New issue
                          </A>
                        </Show>
                      </div>
                    </div>
                  </Show>

                  <div class="mt-3 flex flex-wrap items-center gap-3">
                    <IssueStateBadge state={iss().state} />
                    <span class="text-sm text-muted">
                      <span class="font-semibold text-fg">{principalName(iss().author)}</span>{" "}
                      opened this issue <RelativeTime epochMs={iss().createdAt} /> ·{" "}
                      {iss().commentCount} {iss().commentCount === 1 ? "comment" : "comments"}
                    </span>
                  </div>
                </div>

                {/* Two-column body */}
                <div class="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]">
                  {/* Timeline */}
                  <div class="min-w-0 space-y-4">
                    {/* Issue body */}
                    <Show
                      when={!editingBody()}
                      fallback={
                        <div class="ml-[52px] space-y-2">
                          <MarkdownEditor
                            value={bodyDraft()}
                            onInput={setBodyDraft}
                            placeholder="Leave a comment"
                          />
                          <div class="flex justify-end gap-2">
                            <Button onClick={() => setEditingBody(false)}>Cancel</Button>
                            <Button variant="primary" disabled={busy()} onClick={saveBody}>
                              Save
                            </Button>
                          </div>
                        </div>
                      }
                    >
                      <TimelineComment
                        author={iss().author}
                        createdAt={iss().createdAt}
                        edited={iss().updatedAt > iss().createdAt}
                        emphasis
                        headerActions={
                          <Show when={session.authenticated()}>
                            <IconButton aria-label="Edit issue description" size="sm" onClick={beginEditBody}>
                              <Icons.Edit class="h-4 w-4" />
                            </IconButton>
                          </Show>
                        }
                        body={iss().body}
                      />
                    </Show>

                    {/* Comments */}
                    <Show when={commentsError()}>
                      {(msg) => <Banner tone="danger">{msg()}</Banner>}
                    </Show>
                    <Index each={comments()}>
                      {(comment) => (
                        <CommentItem
                          owner={props.owner}
                          repo={props.repo}
                          comment={comment()}
                          canManage={session.authenticated()}
                          onChange={(updated) =>
                            setComments((prev) =>
                              prev.map((c) => (c.id === updated.id ? updated : c)),
                            )
                          }
                          onDelete={(id) => {
                            setComments((prev) => prev.filter((c) => c.id !== id));
                            void refetchIssue();
                          }}
                        />
                      )}
                    </Index>

                    <Show when={commentsLoading() && comments().length === 0}>
                      <div class="flex items-center gap-2 px-2 text-sm text-muted">
                        <Spinner /> Loading comments…
                      </div>
                    </Show>
                    <Show when={commentsCursor()}>
                      <div class="ml-[52px]">
                        <Button block disabled={commentsLoading()} onClick={() => void loadComments(false)}>
                          <Show when={commentsLoading()} fallback="Load more comments">
                            <Spinner /> Loading…
                          </Show>
                        </Button>
                      </div>
                    </Show>

                    {/* Composer */}
                    <div class="ml-[52px] border-t border-border pt-4">
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
                            Sign in to comment on this issue.
                          </Banner>
                        }
                      >
                        <h2 class="mb-2 text-sm font-semibold text-fg">Add a comment</h2>
                        <MarkdownEditor
                          value={commentDraft()}
                          onInput={setCommentDraft}
                          placeholder="Leave a comment"
                        />
                        <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
                          <Show
                            when={iss().state === "open"}
                            fallback={
                              <Button
                                disabled={busy()}
                                onClick={() => void submitComment("open")}
                              >
                                <Icons.Refresh class="h-4 w-4" />{" "}
                                {commentDraft().trim() ? "Reopen with comment" : "Reopen issue"}
                              </Button>
                            }
                          >
                            <Button
                              variant="danger"
                              disabled={busy()}
                              onClick={() => void submitComment("closed")}
                            >
                              <Icons.Check class="h-4 w-4" />{" "}
                              {commentDraft().trim() ? "Close with comment" : "Close issue"}
                            </Button>
                          </Show>
                          <Button
                            variant="primary"
                            disabled={busy() || !commentDraft().trim()}
                            onClick={() => void submitComment()}
                          >
                            Comment
                          </Button>
                        </div>
                      </Show>
                    </div>
                  </div>

                  {/* Sidebar */}
                  <aside class="space-y-5">
                    <SidebarSection>
                      <AssigneeEditor
                        candidates={(collaborators()?.items ?? []).map((c) => c.principal)}
                        loading={collaborators.loading}
                        selected={iss().assignees.map((a) => a.subject)}
                        disabled={!session.authenticated() || busy()}
                        allowManual
                        onApply={(subjects) =>
                          void patchIssue({ assignees: subjects }, "Assignees updated")
                        }
                      />
                      <Show
                        when={iss().assignees.length > 0}
                        fallback={<p class="text-sm text-muted">No one assigned</p>}
                      >
                        <ul class="space-y-1.5">
                          <Index each={iss().assignees}>
                            {(a) => (
                              <li class="flex items-center gap-2 text-sm">
                                <Avatar name={principalName(a())} size={20} />
                                <span class="text-fg">{principalName(a())}</span>
                              </li>
                            )}
                          </Index>
                        </ul>
                      </Show>
                    </SidebarSection>

                    <SidebarSection>
                      <LabelEditor
                        all={labels()?.items ?? []}
                        loading={labels.loading}
                        selected={iss().labels.map((l) => l.name)}
                        disabled={!session.authenticated() || busy()}
                        onApply={(names) => void patchIssue({ labels: names }, "Labels updated")}
                      />
                      <Show
                        when={iss().labels.length > 0}
                        fallback={<p class="text-sm text-muted">None yet</p>}
                      >
                        <div class="flex flex-wrap gap-1.5">
                          <Index each={iss().labels}>{(l) => <LabelChip label={l()} />}</Index>
                        </div>
                      </Show>
                    </SidebarSection>

                    <SidebarSection>
                      <MilestoneEditor
                        all={milestones()?.items ?? []}
                        loading={milestones.loading}
                        selected={iss().milestone?.number ?? null}
                        disabled={!session.authenticated() || busy()}
                        onApply={(m) => void patchIssue({ milestone: m }, "Milestone updated")}
                      />
                      <Show
                        when={iss().milestone}
                        fallback={<p class="text-sm text-muted">No milestone</p>}
                      >
                        {(m) => (
                          <span class="inline-flex items-center gap-1.5 text-sm text-fg">
                            <Icons.Tag class="h-3.5 w-3.5 text-muted" /> {m().title}
                          </span>
                        )}
                      </Show>
                    </SidebarSection>

                    <Show when={session.authenticated()}>
                      <div class="border-t border-border pt-4">
                        <button
                          type="button"
                          class="tg-focus flex items-center gap-2 text-sm text-danger hover:underline disabled:opacity-60"
                          disabled={busy()}
                          onClick={async () => {
                            const target = iss().state === "open" ? "closed" : "open";
                            const ok = await confirm({
                              title: target === "closed" ? "Close issue" : "Reopen issue",
                              message:
                                target === "closed"
                                  ? `Close issue #${iss().number}?`
                                  : `Reopen issue #${iss().number}?`,
                              confirmText: target === "closed" ? "Close" : "Reopen",
                              danger: target === "closed",
                            });
                            if (ok) {
                              await patchIssue(
                                { state: target },
                                target === "closed" ? "Issue closed" : "Issue reopened",
                              );
                            }
                          }}
                        >
                          <Show
                            when={iss().state === "open"}
                            fallback={<><Icons.Refresh class="h-4 w-4" /> Reopen issue</>}
                          >
                            <Icons.Check class="h-4 w-4" /> Close issue
                          </Show>
                        </button>
                      </div>
                    </Show>
                  </aside>
                </div>
              </div>
            )}
          </Show>
        </Suspense>
      </Show>
    </ErrorBoundary>
  );
}

/** A titled sidebar block separated by a divider. */
function SidebarSection(props: { children: JSX.Element }): JSX.Element {
  return <section class="space-y-2 border-b border-border pb-4 last:border-b-0">{props.children}</section>;
}

/**
 * A single timeline comment with author/maintainer edit + delete. Editing and
 * deleting go through `issuesExtraApi` (comment endpoints the frozen `issuesApi`
 * does not expose yet — see the integrator note). The server enforces the
 * author|maintainer floor; a 403 surfaces as a toast.
 */
function CommentItem(props: {
  owner: string;
  repo: string;
  comment: IssueCommentDto;
  canManage: boolean;
  onChange: (updated: IssueCommentDto) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const toast = useToast();
  const { confirm } = useConfirmDialog();
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const begin = () => {
    setDraft(props.comment.body);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      const { comment } = await issuesExtraApi.editComment(
        props.owner,
        props.repo,
        props.comment.id,
        draft(),
      );
      props.onChange(comment);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save comment.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: "Delete comment",
      message: "Delete this comment? This cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await issuesExtraApi.deleteComment(props.owner, props.repo, props.comment.id);
      props.onDelete(props.comment.id);
      toast.success("Comment deleted");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete comment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <TimelineComment
      author={props.comment.author}
      createdAt={props.comment.createdAt}
      edited={props.comment.updatedAt > props.comment.createdAt}
      headerActions={
        <Show when={props.canManage && !editing()}>
          <Menu
            align="right"
            triggerLabel="Comment actions"
            trigger={<Icons.MoreHorizontal class="h-4 w-4 text-muted" />}
            items={[
              { label: "Edit", onSelect: begin },
              { label: "Delete", onSelect: () => void remove(), danger: true, separated: true },
            ]}
          />
        </Show>
      }
    >
      <Show when={editing()} fallback={<Markdown source={props.comment.body} />}>
        <div class="space-y-2">
          <MarkdownEditor value={draft()} onInput={setDraft} disabled={busy()} />
          <div class="flex justify-end gap-2">
            <Button onClick={() => setEditing(false)} disabled={busy()}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={busy() || !draft().trim()}>
              Update comment
            </Button>
          </div>
        </div>
      </Show>
    </TimelineComment>
  );
}
