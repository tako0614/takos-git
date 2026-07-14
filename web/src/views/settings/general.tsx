/**
 * Settings → General: description, default branch, visibility, archive, and the
 * danger zone (rename/transfer/delete). Backed by `reposApi.update` /
 * `reposApi.remove`; refreshes the shell's repo detail via `useRepo().refetch`.
 */
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";
import { useRepo } from "../../app/RepoLayout.tsx";
import { reposApi } from "../../api/repos.ts";
import type { Visibility } from "../../api/contract.ts";
import {
  Banner,
  Button,
  Dialog,
  Field,
  Icons,
  Select,
  TextInput,
  Textarea,
  useToast,
} from "../../ui/index.ts";
import {
  AdminGate,
  ComingSoon,
  DangerRow,
  describeError,
  SettingsSection,
} from "./shared.tsx";

const VISIBILITIES: readonly { value: Visibility; label: string; hint: string }[] = [
  { value: "public", label: "Public", hint: "Anyone can see this repository." },
  { value: "internal", label: "Internal", hint: "Visible to any signed-in member." },
  { value: "private", label: "Private", hint: "Only you and invited collaborators." },
];

export function GeneralSettingsView(): JSX.Element {
  const repo = useRepo();
  const toast = useToast();

  const detail = () => repo.detail();
  const archived = () => detail()?.isArchived ?? false;

  // --- description ----------------------------------------------------------
  const [description, setDescription] = createSignal(detail()?.description ?? "");
  const [descDirty, setDescDirty] = createSignal(false);
  const [savingDesc, setSavingDesc] = createSignal(false);
  // Re-seed the field from freshly-loaded detail while the user hasn't edited it.
  createEffect(() => {
    const current = detail()?.description ?? "";
    if (!descDirty()) setDescription(current);
  });

  async function saveDescription(e: Event): Promise<void> {
    e.preventDefault();
    setSavingDesc(true);
    try {
      await reposApi.update(repo.owner(), repo.repo(), { description: description() });
      setDescDirty(false);
      repo.refetch();
      toast.success("Description updated.");
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSavingDesc(false);
    }
  }

  // --- default branch -------------------------------------------------------
  const [branchData] = createResource(
    () => [repo.owner(), repo.repo()] as const,
    ([o, r]) => reposApi.branches(o, r),
  );
  const [branchChoice, setBranchChoice] = createSignal<string>("");
  const [savingBranch, setSavingBranch] = createSignal(false);
  const currentDefault = (): string => branchChoice() || detail()?.defaultBranch || "";

  async function saveDefaultBranch(): Promise<void> {
    const next = currentDefault();
    if (!next || next === detail()?.defaultBranch) return;
    setSavingBranch(true);
    try {
      await reposApi.update(repo.owner(), repo.repo(), { defaultBranch: next });
      repo.refetch();
      toast.success(`Default branch set to ${next}.`);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSavingBranch(false);
    }
  }

  // --- danger zone: visibility ---------------------------------------------
  const [visOpen, setVisOpen] = createSignal(false);
  const [visChoice, setVisChoice] = createSignal<Visibility>("private");
  const [savingVis, setSavingVis] = createSignal(false);

  function openVisibility(): void {
    setVisChoice(detail()?.visibility ?? "private");
    setVisOpen(true);
  }
  async function saveVisibility(): Promise<void> {
    setSavingVis(true);
    try {
      await reposApi.update(repo.owner(), repo.repo(), { visibility: visChoice() });
      repo.refetch();
      toast.success(`Visibility changed to ${visChoice()}.`);
      setVisOpen(false);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSavingVis(false);
    }
  }

  // --- danger zone: archive -------------------------------------------------
  const [togglingArchive, setTogglingArchive] = createSignal(false);
  async function toggleArchive(): Promise<void> {
    const next = !archived();
    setTogglingArchive(true);
    try {
      await reposApi.update(repo.owner(), repo.repo(), { isArchived: next });
      repo.refetch();
      toast.success(next ? "Repository archived." : "Repository unarchived.");
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setTogglingArchive(false);
    }
  }

  // --- danger zone: delete --------------------------------------------------
  const [delOpen, setDelOpen] = createSignal(false);
  const [delConfirm, setDelConfirm] = createSignal("");
  const [deleting, setDeleting] = createSignal(false);
  const fullName = (): string => detail()?.fullName ?? `${repo.owner()}/${repo.repo()}`;

  async function deleteRepo(): Promise<void> {
    if (delConfirm() !== fullName()) return;
    setDeleting(true);
    try {
      await reposApi.remove(repo.owner(), repo.repo());
      toast.success("Repository deleted.");
      if (typeof location !== "undefined") location.href = "/";
    } catch (err) {
      toast.error(describeError(err));
      setDeleting(false);
    }
  }

  return (
    <AdminGate>
      <div class="space-y-6">
        <Show when={archived()}>
          <Banner tone="warning" title="This repository is archived">
            It is read-only. Unarchive it from the danger zone below to make changes.
          </Banner>
        </Show>

        {/* Repository name (rename is not yet a contract capability). */}
        <SettingsSection title="Repository name" icon={<Icons.GitBranch class="h-4 w-4 text-muted" />}>
          <div class="flex flex-wrap items-end gap-3">
            <Field label="Name" class="min-w-[240px] flex-1" for="repo-name">
              <TextInput id="repo-name" value={repo.repo()} readonly disabled />
            </Field>
            <div class="pb-1.5">
              <Button disabled title="Renaming is not available yet">Rename</Button>
            </div>
          </div>
          <p class="mt-2 flex items-center gap-2 text-xs text-muted">
            <ComingSoon>Renaming needs server support</ComingSoon>
            Renaming a repository will be enabled in a later release.
          </p>
        </SettingsSection>

        {/* Description */}
        <SettingsSection
          title="Description"
          description="A short summary shown on the repository home and in listings."
          icon={<Icons.FileText class="h-4 w-4 text-muted" />}
        >
          <form onSubmit={saveDescription} class="space-y-3">
            <Textarea
              aria-label="Repository description"
              rows={3}
              maxLength={1024}
              disabled={archived() || savingDesc()}
              value={description()}
              onInput={(e) => {
                setDescDirty(true);
                setDescription(e.currentTarget.value);
              }}
              placeholder="Describe this repository…"
            />
            <div class="flex justify-end">
              <Button type="submit" variant="primary" disabled={archived() || savingDesc() || !descDirty()}>
                <Show when={savingDesc()} fallback={<Icons.Check class="h-4 w-4" />}>
                  <Icons.Loader class="h-4 w-4 animate-spin" />
                </Show>
                Save
              </Button>
            </div>
          </form>
        </SettingsSection>

        {/* Default branch */}
        <SettingsSection
          title="Default branch"
          description="The base branch for new pull requests and the branch shown by default."
          icon={<Icons.GitMerge class="h-4 w-4 text-muted" />}
        >
          <div class="flex flex-wrap items-end gap-3">
            <Field label="Branch" class="min-w-[240px] flex-1" for="default-branch">
              <Select
                id="default-branch"
                disabled={archived() || savingBranch() || branchData.loading}
                value={currentDefault()}
                onChange={(e) => setBranchChoice(e.currentTarget.value)}
              >
                <Show
                  when={(branchData()?.branches.length ?? 0) > 0}
                  fallback={<option value={detail()?.defaultBranch ?? ""}>{detail()?.defaultBranch ?? "—"}</option>}
                >
                  <For each={branchData()?.branches ?? []}>
                    {(b) => <option value={b.name}>{b.name}{b.default ? " (current)" : ""}</option>}
                  </For>
                </Show>
              </Select>
            </Field>
            <div class="pb-1.5">
              <Button
                variant="primary"
                disabled={archived() || savingBranch() || currentDefault() === detail()?.defaultBranch}
                onClick={saveDefaultBranch}
              >
                Update
              </Button>
            </div>
          </div>
        </SettingsSection>

        {/* Danger zone */}
        <SettingsSection title="Danger zone" tone="danger" icon={<Icons.AlertTriangle class="h-4 w-4" />}>
          <DangerRow
            title="Change repository visibility"
            description={<>This repository is currently <b>{detail()?.visibility}</b>.</>}
            action={<Button variant="danger" onClick={openVisibility}>Change visibility</Button>}
          />
          <DangerRow
            title={archived() ? "Unarchive this repository" : "Archive this repository"}
            description={
              archived()
                ? "Restore write access to this repository."
                : "Mark this repository read-only. It can be unarchived later."
            }
            action={
              <Button variant="danger" disabled={togglingArchive()} onClick={toggleArchive}>
                <Icons.Archive class="h-4 w-4" />
                {archived() ? "Unarchive" : "Archive"}
              </Button>
            }
          />
          <DangerRow
            title="Transfer ownership"
            description="Move this repository to another owner."
            action={<Button variant="danger" disabled title="Transfer is not available yet">Transfer</Button>}
          />
          <DangerRow
            title="Delete this repository"
            description="Permanently remove the repository, its git data, issues, and pull requests. This cannot be undone."
            action={<Button variant="danger" onClick={() => { setDelConfirm(""); setDelOpen(true); }}>Delete</Button>}
          />
        </SettingsSection>
      </div>

      {/* Visibility dialog */}
      <Dialog
        open={visOpen()}
        onClose={() => setVisOpen(false)}
        title="Change visibility"
        footer={
          <>
            <Button onClick={() => setVisOpen(false)} disabled={savingVis()}>Cancel</Button>
            <Button
              variant="danger"
              onClick={saveVisibility}
              disabled={savingVis() || visChoice() === detail()?.visibility}
            >
              <Show when={savingVis()}><Icons.Loader class="h-4 w-4 animate-spin" /></Show>
              Update visibility
            </Button>
          </>
        }
      >
        <fieldset class="space-y-2">
          <legend class="sr-only">Repository visibility</legend>
          <For each={VISIBILITIES}>
            {(opt) => (
              <label class="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-canvas-subtle">
                <input
                  type="radio"
                  name="visibility"
                  class="mt-1"
                  value={opt.value}
                  checked={visChoice() === opt.value}
                  onChange={() => setVisChoice(opt.value)}
                />
                <span class="min-w-0">
                  <span class="block text-sm font-semibold text-fg">{opt.label}</span>
                  <span class="block text-xs text-muted">{opt.hint}</span>
                </span>
              </label>
            )}
          </For>
        </fieldset>
      </Dialog>

      {/* Delete dialog */}
      <Dialog
        open={delOpen()}
        onClose={() => !deleting() && setDelOpen(false)}
        title="Delete repository"
        footer={
          <>
            <Button onClick={() => setDelOpen(false)} disabled={deleting()}>Cancel</Button>
            <Button variant="danger" onClick={deleteRepo} disabled={deleting() || delConfirm() !== fullName()}>
              <Show when={deleting()}><Icons.Loader class="h-4 w-4 animate-spin" /></Show>
              <Icons.Trash class="h-4 w-4" /> Delete this repository
            </Button>
          </>
        }
      >
        <Banner tone="danger" class="mb-3" title="This action cannot be undone.">
          This deletes the repository, its git objects, issues, pull requests, releases, and webhooks.
        </Banner>
        <label for="delete-confirm" class="mb-1.5 block text-sm font-semibold text-fg">
          Type <b class="font-mono">{fullName()}</b> to confirm.
        </label>
        <TextInput
          id="delete-confirm"
          autocomplete="off"
          value={delConfirm()}
          onInput={(e) => setDelConfirm(e.currentTarget.value)}
          placeholder={fullName()}
        />
      </Dialog>
    </AdminGate>
  );
}
