/**
 * Settings → Collaborators: list direct collaborators with their role, add a new
 * collaborator by subject, change a role, or remove access. Backed by
 * `collaboratorsApi` (list / set / remove).
 *
 * Note: the repo OWNER is granted by repository ownership, not a
 * `repo_collaborators` row, so the owner does not appear in this list — it only
 * shows explicitly-granted collaborators, matching the server model.
 */
import {
  createResource,
  createEffect,
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { useRepo } from "../../app/RepoLayout.tsx";
import { collaboratorsApi } from "../../api/admin.ts";
import type { CollaboratorDto } from "../../api/types.ts";
import type { Role } from "../../api/contract.ts";
import { useConfirmDialog } from "../../store/confirm.ts";
import {
  Avatar,
  Banner,
  Box,
  Button,
  EmptyState,
  Field,
  Icons,
  Label,
  LoadingBlock,
  Select,
  TextInput,
  useToast,
} from "../../ui/index.ts";
import { AdminGate, ComingSoon, describeError, SettingsSection } from "./shared.tsx";

const ROLES: readonly { value: Role; label: string; hint: string }[] = [
  { value: "reader", label: "Read", hint: "View and clone the repository." },
  { value: "writer", label: "Write", hint: "Push code and manage issues and pull requests." },
  { value: "maintainer", label: "Maintain", hint: "Manage the repository without destructive actions." },
  { value: "owner", label: "Admin", hint: "Full access, including settings and deletion." },
];

const ROLE_LABEL: Record<Role, string> = {
  reader: "Read",
  writer: "Write",
  maintainer: "Maintain",
  owner: "Admin",
};

interface Collab {
  readonly id: string;
  readonly subject: string;
  readonly bindingId: string | null;
  readonly displayName: string | null;
  readonly role: Role;
}

function normalize(dto: CollaboratorDto): Collab {
  return {
    id: dto.principalId,
    subject: dto.principal.subject,
    bindingId: dto.bindingId,
    displayName: dto.principal.displayName,
    role: dto.role,
  };
}

function grantLabel(collab: Collab): string {
  return collab.bindingId ? `${collab.subject} (binding ${collab.bindingId})` : `${collab.subject} (person)`;
}

export function CollaboratorsSettingsView(): JSX.Element {
  const repo = useRepo();
  const toast = useToast();
  const confirmDialog = useConfirmDialog();

  const [reloadKey, setReloadKey] = createSignal(0);
  const [collabs] = createResource(
    () => [repo.owner(), repo.repo(), reloadKey()] as const,
    async ([o, r]) => (await collaboratorsApi.list(o, r)).items.map(normalize),
  );
  const reload = (): void => {
    setReloadKey((k) => k + 1);
  };

  // --- add collaborator -----------------------------------------------------
  const [newSubject, setNewSubject] = createSignal("");
  const [newBindingId, setNewBindingId] = createSignal("");
  const [newRole, setNewRole] = createSignal<Role>("writer");
  const [adding, setAdding] = createSignal(false);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  let alive = true;
  let generation = 0;
  createEffect(() => {
    repo.owner();
    repo.repo();
    generation++;
    setAdding(false);
    setBusyId(null);
    setNewSubject("");
    setNewBindingId("");
    setNewRole("writer");
  });
  onCleanup(() => { alive = false; generation++; });
  const captureTarget = () => ({ owner: repo.owner(), name: repo.repo(), generation });
  const isCurrent = (target: ReturnType<typeof captureTarget>) => alive &&
    target.generation === generation && target.owner === repo.owner() && target.name === repo.repo();

  async function addCollaborator(e: Event): Promise<void> {
    e.preventDefault();
    const subject = newSubject().trim();
    if (!subject) return;
    const target = captureTarget();
    setAdding(true);
    try {
      await collaboratorsApi.set(target.owner, target.name, subject, newRole(), newBindingId().trim() || undefined);
      if (!isCurrent(target)) return;
      toast.success(`Added ${subject} as ${ROLE_LABEL[newRole()]}.`);
      setNewSubject("");
      setNewBindingId("");
      setNewRole("writer");
      reload();
    } catch (err) {
      if (isCurrent(target)) toast.error(describeError(err));
    } finally {
      if (isCurrent(target)) setAdding(false);
    }
  }

  // --- change role ----------------------------------------------------------
  async function changeRole(collab: Collab, role: Role): Promise<void> {
    const target = captureTarget();
    setBusyId(collab.id);
    try {
      await collaboratorsApi.set(target.owner, target.name, collab.subject, role, collab.bindingId ?? undefined);
      if (!isCurrent(target)) return;
      toast.success(`${grantLabel(collab)} is now ${ROLE_LABEL[role]}.`);
      reload();
    } catch (err) {
      if (isCurrent(target)) { toast.error(describeError(err)); reload(); }
    } finally {
      if (isCurrent(target)) setBusyId(null);
    }
  }

  async function removeCollaborator(collab: Collab): Promise<void> {
    const target = captureTarget();
    const ok = await confirmDialog.confirm({
      title: "Remove collaborator",
      message: `Remove ${grantLabel(collab)} from this repository? Other grants are kept.`,
      confirmText: "Remove",
      danger: true,
    });
    if (!ok || !isCurrent(target)) return;
    setBusyId(collab.id);
    try {
      await collaboratorsApi.remove(target.owner, target.name, collab.subject, collab.id);
      if (!isCurrent(target)) return;
      toast.success(`Removed ${grantLabel(collab)}.`);
      reload();
    } catch (err) {
      if (isCurrent(target)) toast.error(describeError(err));
    } finally {
      if (isCurrent(target)) setBusyId(null);
    }
  }

  return (
    <AdminGate>
      <div class="space-y-6">
        {/* Add */}
        <SettingsSection
          title="Add a collaborator"
          description="Grant a person access by account subject. For automation, also enter its InterfaceBinding ID."
          icon={<Icons.User class="h-4 w-4 text-muted" />}
        >
          <form onSubmit={addCollaborator} class="flex flex-wrap items-end gap-3">
            <Field label="Account subject" class="min-w-[240px] flex-1" for="new-collab">
              <TextInput
                id="new-collab"
                placeholder="e.g. user-oidc-subject"
                autocomplete="off"
                value={newSubject()}
                onInput={(e) => setNewSubject(e.currentTarget.value)}
                disabled={adding()}
              />
            </Field>
            <Field label="Interface binding (optional)" class="min-w-[240px] flex-1" for="new-collab-binding">
              <TextInput
                id="new-collab-binding"
                placeholder="Leave blank for a person"
                autocomplete="off"
                value={newBindingId()}
                onInput={(e) => setNewBindingId(e.currentTarget.value)}
                disabled={adding()}
              />
            </Field>
            <Field label="Role" class="w-40" for="new-collab-role">
              <Select
                id="new-collab-role"
                value={newRole()}
                onChange={(e) => setNewRole(e.currentTarget.value as Role)}
                disabled={adding()}
              >
                <For each={ROLES}>{(r) => <option value={r.value} selected={newRole() === r.value}>{r.label}</option>}</For>
              </Select>
            </Field>
            <div class="pb-1.5">
              <Button type="submit" variant="primary" disabled={adding() || !newSubject().trim()}>
                <Show when={adding()} fallback={<Icons.Plus class="h-4 w-4" />}>
                  <Icons.Loader class="h-4 w-4 animate-spin" />
                </Show>
                Add
              </Button>
            </div>
          </form>
          <p class="mt-2 text-xs text-muted">{ROLES.find((r) => r.value === newRole())?.hint}</p>
        </SettingsSection>

        {/* List */}
        <div>
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-fg">
              Collaborators
              <Show when={collabs()}>
                <span class="ml-1.5 text-muted">({collabs()!.length})</span>
              </Show>
            </h2>
          </div>
          <Suspense fallback={<LoadingBlock label="Loading collaborators…" />}>
            <Show when={collabs.error}>
              <Banner tone="danger" title="Could not load collaborators">
                {describeError(collabs.error)}
              </Banner>
            </Show>
            <Show when={!collabs.error}>
              <Show
                when={(collabs()?.length ?? 0) > 0}
                fallback={
                  <EmptyState
                    icon={<Icons.Users class="h-8 w-8" />}
                    title="No collaborators yet"
                    description="Only the owner has access. Add collaborators above to grant others access."
                  />
                }
              >
                <Box>
                  <Index each={collabs() ?? []}>
                    {(collab) => (
                      <CollaboratorRow
                        collab={collab()}
                        busy={busyId() === collab().id}
                        onRole={(role) => changeRole(collab(), role)}
                        onRemove={() => removeCollaborator(collab())}
                      />
                    )}
                  </Index>
                </Box>
              </Show>
            </Show>
          </Suspense>
        </div>

        {/* Teams (org repos) — needs a teams api client. */}
        <SettingsSection title="Teams" icon={<Icons.Users class="h-4 w-4 text-muted" />}>
          <div class="flex items-center gap-2 text-sm text-muted">
            <ComingSoon>Team management coming to the UI</ComingSoon>
            For organization repositories, team access is managed through the API today.
          </div>
        </SettingsSection>
      </div>
    </AdminGate>
  );
}

function CollaboratorRow(props: {
  collab: Collab;
  busy: boolean;
  onRole: (role: Role) => void;
  onRemove: () => void;
}): JSX.Element {
  const display = (): string => props.collab.displayName || props.collab.subject;
  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <Avatar name={display()} size={32} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold text-fg">{display()}</div>
        <Show when={props.collab.displayName}>
          <div class="truncate text-xs text-muted">{props.collab.subject}</div>
        </Show>
        <div class="truncate text-xs text-muted" title={props.collab.bindingId ?? "Person"}>
          {props.collab.bindingId ? `Binding: ${props.collab.bindingId}` : "Person"}
        </div>
      </div>
      <Label tone="accent">{ROLE_LABEL[props.collab.role]}</Label>
      <label class="sr-only" for={`role-${props.collab.id}`}>
        Role for {grantLabel(props.collab)}
      </label>
      <Select
        id={`role-${props.collab.id}`}
        class="w-36"
        value={props.collab.role}
        disabled={props.busy}
        onChange={(e) => props.onRole(e.currentTarget.value as Role)}
      >
        <For each={ROLES}>{(r) => <option value={r.value} selected={props.collab.role === r.value}>{r.label}</option>}</For>
      </Select>
      <Button
        variant="danger"
        size="sm"
        disabled={props.busy}
        onClick={() => props.onRemove()}
        aria-label={`Remove ${grantLabel(props.collab)}`}
      >
        <Show when={props.busy} fallback={<Icons.Trash class="h-4 w-4" />}>
          <Icons.Loader class="h-4 w-4 animate-spin" />
        </Show>
        Remove
      </Button>
    </div>
  );
}
