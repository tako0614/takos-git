/**
 * Label + milestone management dialogs, reached from the issue-list toolbar.
 * These cover the repo-label and milestone CRUD the frozen `issuesApi` does not
 * expose; they call `issuesExtraApi` (thin wrappers over the shared low-level
 * `api` client — no hand-rolled fetch). The server enforces the maintainer
 * floor, so a non-maintainer sees the controls but gets a toast on 403.
 */
import {
  createEffect,
  createSignal,
  Index,
  Show,
  type JSX,
} from "solid-js";
import { issuesApi } from "../../api/issues.ts";
import { ApiError } from "../../api/client.ts";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  Icons,
  IconButton,
  LoadingBlock,
  StateLabel,
  TextInput,
  Textarea,
  useConfirmDialog,
  useToast,
} from "../../ui/index.ts";
import { LabelChip } from "./parts.tsx";
import { issuesExtraApi } from "./api-extra.ts";
import type { LabelDto, MilestoneDto } from "../../api/types.ts";

const SWATCHES = [
  "d73a4a", "e99695", "fbca04", "0e8a16", "1d76db",
  "0052cc", "5319e7", "b60205", "bfdadc", "c5def5", "d4c5f9", "cccccc",
];

const isHex6 = (v: string) => /^[0-9a-fA-F]{6}$/.test(v.replace(/^#/, ""));

/** Manage the repository's labels (create / rename / recolor / delete). */
export function LabelManager(props: {
  owner: string;
  repo: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const toast = useToast();
  const { confirm } = useConfirmDialog();
  const [labels, setLabels] = createSignal<LabelDto[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // create form
  const [newName, setNewName] = createSignal("");
  const [newColor, setNewColor] = createSignal(SWATCHES[0]);
  const [newDesc, setNewDesc] = createSignal("");
  // inline edit
  const [editName, setEditName] = createSignal<string | null>(null);
  const [draftName, setDraftName] = createSignal("");
  const [draftColor, setDraftColor] = createSignal("");
  const [draftDesc, setDraftDesc] = createSignal("");

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await issuesApi.labels(props.owner, props.repo);
      setLabels([...page.items]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load labels.");
    } finally {
      setLoading(false);
    }
  };
  createEffect(() => {
    if (props.open) void reload();
  });

  const create = async () => {
    const name = newName().trim();
    if (!name || !isHex6(newColor())) return;
    setBusy(true);
    try {
      await issuesExtraApi.createLabel(props.owner, props.repo, {
        name,
        color: newColor().replace(/^#/, ""),
        description: newDesc().trim() || null,
      });
      setNewName("");
      setNewDesc("");
      setNewColor(SWATCHES[0]);
      await reload();
      props.onChanged();
      toast.success("Label created");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create label.");
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (l: LabelDto) => {
    setEditName(l.name);
    setDraftName(l.name);
    setDraftColor(l.color.replace(/^#/, ""));
    setDraftDesc(l.description ?? "");
  };
  const saveEdit = async (original: string) => {
    if (!draftName().trim() || !isHex6(draftColor())) return;
    setBusy(true);
    try {
      await issuesExtraApi.updateLabel(props.owner, props.repo, original, {
        name: draftName().trim(),
        color: draftColor().replace(/^#/, ""),
        description: draftDesc().trim() || null,
      });
      setEditName(null);
      await reload();
      props.onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update label.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (l: LabelDto) => {
    const ok = await confirm({
      title: "Delete label",
      message: `Delete “${l.name}”? It will be removed from all issues.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await issuesExtraApi.deleteLabel(props.owner, props.repo, l.name);
      await reload();
      props.onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete label.");
    } finally {
      setBusy(false);
    }
  };

  const previewColor = () => (isHex6(newColor()) ? `#${newColor().replace(/^#/, "")}` : "#8b949e");

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Manage labels" size="lg">
      <div class="space-y-4">
        {/* Create */}
        <div class="rounded-md border border-border p-3">
          <div class="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Icons.Plus class="h-4 w-4" /> New label
          </div>
          <div class="flex flex-wrap items-end gap-2">
            <label class="flex-1">
              <span class="mb-1 block text-xs text-muted">Name</span>
              <TextInput value={newName()} placeholder="Label name" onInput={(e) => setNewName(e.currentTarget.value)} />
            </label>
            <label>
              <span class="mb-1 block text-xs text-muted">Color</span>
              <div class="flex items-center gap-2">
                <span class="inline-block h-6 w-6 shrink-0 rounded border border-border" style={{ background: previewColor() }} />
                <TextInput class="w-28" value={newColor()} onInput={(e) => setNewColor(e.currentTarget.value)} />
              </div>
            </label>
          </div>
          <div class="mt-2 flex flex-wrap gap-1">
            <Index each={SWATCHES}>
              {(hex) => (
                <button
                  type="button"
                  aria-label={`Use color ${hex()}`}
                  class="h-5 w-5 rounded-full border border-border"
                  style={{ background: `#${hex()}` }}
                  onClick={() => setNewColor(hex())}
                />
              )}
            </Index>
          </div>
          <div class="mt-2 flex items-end gap-2">
            <label class="flex-1">
              <span class="mb-1 block text-xs text-muted">Description (optional)</span>
              <TextInput value={newDesc()} onInput={(e) => setNewDesc(e.currentTarget.value)} />
            </label>
            <Button variant="primary" disabled={busy() || !newName().trim() || !isHex6(newColor())} onClick={create}>
              Create
            </Button>
          </div>
          <div class="mt-2">
            <span class="text-xs text-muted">Preview: </span>
            <LabelChip label={{ name: newName().trim() || "label", color: newColor(), description: newDesc() || null, createdAt: 0 }} />
          </div>
        </div>

        {/* List */}
        <Show when={error()}>{(msg) => <Banner tone="danger">{msg()}</Banner>}</Show>
        <Show when={!loading()} fallback={<LoadingBlock label="Loading labels…" />}>
          <Show
            when={labels().length > 0}
            fallback={<EmptyState icon={<Icons.Tag class="h-7 w-7" />} title="No labels yet" description="Create the first label above." />}
          >
            <ul class="divide-y divide-border rounded-md border border-border">
              <Index each={labels()}>
                {(label) => (
                  <li class="p-3">
                    <Show
                      when={editName() === label().name}
                      fallback={
                        <div class="flex items-center gap-3">
                          <LabelChip label={label()} />
                          <span class="min-w-0 flex-1 truncate text-sm text-muted">{label().description}</span>
                          <Button size="sm" onClick={() => beginEdit(label())}>
                            <Icons.Edit class="h-3.5 w-3.5" /> Edit
                          </Button>
                          <IconButton aria-label={`Delete ${label().name}`} onClick={() => void remove(label())}>
                            <Icons.Trash class="h-4 w-4 text-danger" />
                          </IconButton>
                        </div>
                      }
                    >
                      <div class="space-y-2">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="inline-block h-6 w-6 shrink-0 rounded border border-border" style={{ background: isHex6(draftColor()) ? `#${draftColor().replace(/^#/, "")}` : "#8b949e" }} />
                          <TextInput class="w-40" value={draftName()} onInput={(e) => setDraftName(e.currentTarget.value)} />
                          <TextInput class="w-28" value={draftColor()} onInput={(e) => setDraftColor(e.currentTarget.value)} />
                          <TextInput class="min-w-[10rem] flex-1" placeholder="Description" value={draftDesc()} onInput={(e) => setDraftDesc(e.currentTarget.value)} />
                        </div>
                        <div class="flex justify-end gap-2">
                          <Button size="sm" onClick={() => setEditName(null)}>Cancel</Button>
                          <Button size="sm" variant="primary" disabled={busy() || !draftName().trim() || !isHex6(draftColor())} onClick={() => void saveEdit(label().name)}>
                            Save
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </li>
                )}
              </Index>
            </ul>
          </Show>
        </Show>
      </div>
    </Dialog>
  );
}

/** Manage the repository's milestones (create / edit / close / delete). */
export function MilestoneManager(props: {
  owner: string;
  repo: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const toast = useToast();
  const { confirm } = useConfirmDialog();
  const [milestones, setMilestones] = createSignal<MilestoneDto[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const [newTitle, setNewTitle] = createSignal("");
  const [newDesc, setNewDesc] = createSignal("");
  const [newDue, setNewDue] = createSignal("");

  const [editNumber, setEditNumber] = createSignal<number | null>(null);
  const [draftTitle, setDraftTitle] = createSignal("");
  const [draftDesc, setDraftDesc] = createSignal("");
  const [draftDue, setDraftDue] = createSignal("");

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await issuesApi.milestones(props.owner, props.repo);
      setMilestones([...page.items]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load milestones.");
    } finally {
      setLoading(false);
    }
  };
  createEffect(() => {
    if (props.open) void reload();
  });

  const dueMs = (v: string): number | null => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };
  const toDateInput = (ms: number | null): string =>
    ms == null ? "" : new Date(ms).toISOString().slice(0, 10);

  const create = async () => {
    const title = newTitle().trim();
    if (!title) return;
    setBusy(true);
    try {
      await issuesExtraApi.createMilestone(props.owner, props.repo, {
        title,
        description: newDesc().trim() || null,
        dueOn: dueMs(newDue()),
      });
      setNewTitle("");
      setNewDesc("");
      setNewDue("");
      await reload();
      props.onChanged();
      toast.success("Milestone created");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create milestone.");
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (m: MilestoneDto) => {
    setEditNumber(m.number);
    setDraftTitle(m.title);
    setDraftDesc(m.description ?? "");
    setDraftDue(toDateInput(m.dueOn));
  };
  const saveEdit = async (number: number) => {
    if (!draftTitle().trim()) return;
    setBusy(true);
    try {
      await issuesExtraApi.updateMilestone(props.owner, props.repo, number, {
        title: draftTitle().trim(),
        description: draftDesc().trim() || null,
        dueOn: dueMs(draftDue()),
      });
      setEditNumber(null);
      await reload();
      props.onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update milestone.");
    } finally {
      setBusy(false);
    }
  };
  const toggleState = async (m: MilestoneDto) => {
    setBusy(true);
    try {
      await issuesExtraApi.updateMilestone(props.owner, props.repo, m.number, {
        state: m.state === "open" ? "closed" : "open",
      });
      await reload();
      props.onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update milestone.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (m: MilestoneDto) => {
    const ok = await confirm({
      title: "Delete milestone",
      message: `Delete milestone “${m.title}”?`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await issuesExtraApi.deleteMilestone(props.owner, props.repo, m.number);
      await reload();
      props.onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete milestone.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Manage milestones" size="lg">
      <div class="space-y-4">
        <div class="rounded-md border border-border p-3">
          <div class="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Icons.Plus class="h-4 w-4" /> New milestone
          </div>
          <div class="space-y-2">
            <TextInput value={newTitle()} placeholder="Title" onInput={(e) => setNewTitle(e.currentTarget.value)} />
            <Textarea value={newDesc()} placeholder="Description (optional)" rows={2} onInput={(e) => setNewDesc(e.currentTarget.value)} />
            <div class="flex flex-wrap items-end gap-2">
              <label>
                <span class="mb-1 block text-xs text-muted">Due date (optional)</span>
                <TextInput type="date" value={newDue()} onInput={(e) => setNewDue(e.currentTarget.value)} />
              </label>
              <Button class="ml-auto" variant="primary" disabled={busy() || !newTitle().trim()} onClick={create}>
                Create
              </Button>
            </div>
          </div>
        </div>

        <Show when={error()}>{(msg) => <Banner tone="danger">{msg()}</Banner>}</Show>
        <Show when={!loading()} fallback={<LoadingBlock label="Loading milestones…" />}>
          <Show
            when={milestones().length > 0}
            fallback={<EmptyState icon={<Icons.Tag class="h-7 w-7" />} title="No milestones yet" description="Create the first milestone above." />}
          >
            <ul class="divide-y divide-border rounded-md border border-border">
              <Index each={milestones()}>
                {(m) => (
                  <li class="p-3">
                    <Show
                      when={editNumber() === m().number}
                      fallback={
                        <div class="flex flex-wrap items-center gap-3">
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <span class="font-semibold text-fg">{m().title}</span>
                              <StateLabel state={m().state} />
                            </div>
                            <div class="mt-0.5 text-xs text-muted">
                              {m().openIssues} open · {m().closedIssues} closed
                              <Show when={m().dueOn}>
                                {" "}· due {toDateInput(m().dueOn)}
                              </Show>
                            </div>
                          </div>
                          <Button size="sm" onClick={() => beginEdit(m())}>
                            <Icons.Edit class="h-3.5 w-3.5" /> Edit
                          </Button>
                          <Button size="sm" onClick={() => void toggleState(m())} disabled={busy()}>
                            {m().state === "open" ? "Close" : "Reopen"}
                          </Button>
                          <IconButton aria-label={`Delete ${m().title}`} onClick={() => void remove(m())}>
                            <Icons.Trash class="h-4 w-4 text-danger" />
                          </IconButton>
                        </div>
                      }
                    >
                      <div class="space-y-2">
                        <TextInput value={draftTitle()} onInput={(e) => setDraftTitle(e.currentTarget.value)} />
                        <Textarea value={draftDesc()} placeholder="Description" rows={2} onInput={(e) => setDraftDesc(e.currentTarget.value)} />
                        <div class="flex flex-wrap items-end gap-2">
                          <label>
                            <span class="mb-1 block text-xs text-muted">Due date</span>
                            <TextInput type="date" value={draftDue()} onInput={(e) => setDraftDue(e.currentTarget.value)} />
                          </label>
                          <div class="ml-auto flex gap-2">
                            <Button size="sm" onClick={() => setEditNumber(null)}>Cancel</Button>
                            <Button size="sm" variant="primary" disabled={busy() || !draftTitle().trim()} onClick={() => void saveEdit(m().number)}>
                              Save
                            </Button>
                          </div>
                        </div>
                      </div>
                    </Show>
                  </li>
                )}
              </Index>
            </ul>
          </Show>
        </Show>
      </div>
    </Dialog>
  );
}
