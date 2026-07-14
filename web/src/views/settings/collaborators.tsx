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
  createSignal,
  For,
  Index,
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
  readonly subject: string;
  readonly displayName: string | null;
  readonly role: Role;
}

/**
 * Tolerate both the typed `{ principal, role }` mirror and the server's current
 * flat `{ principalId, subject, displayName, role }` row (see integrator note).
 */
function normalize(dto: CollaboratorDto): Collab {
  const loose = dto as unknown as {
    principal?: { subject?: string; displayName?: string | null };
    subject?: string;
    displayName?: string | null;
    role: Role;
  };
  return {
    subject: loose.principal?.subject ?? loose.subject ?? "",
    displayName: loose.principal?.displayName ?? loose.displayName ?? null,
    role: loose.role,
  };
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
  const [newRole, setNewRole] = createSignal<Role>("writer");
  const [adding, setAdding] = createSignal(false);

  async function addCollaborator(e: Event): Promise<void> {
    e.preventDefault();
    const subject = newSubject().trim();
    if (!subject) return;
    setAdding(true);
    try {
      await collaboratorsApi.set(repo.owner(), repo.repo(), subject, newRole());
      toast.success(`Added ${subject} as ${ROLE_LABEL[newRole()]}.`);
      setNewSubject("");
      setNewRole("writer");
      reload();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setAdding(false);
    }
  }

  // --- change role ----------------------------------------------------------
  const [busySubject, setBusySubject] = createSignal<string | null>(null);

  async function changeRole(subject: string, role: Role): Promise<void> {
    setBusySubject(subject);
    try {
      await collaboratorsApi.set(repo.owner(), repo.repo(), subject, role);
      toast.success(`${subject} is now ${ROLE_LABEL[role]}.`);
      reload();
    } catch (err) {
      toast.error(describeError(err));
      reload();
    } finally {
      setBusySubject(null);
    }
  }

  async function removeCollaborator(subject: string): Promise<void> {
    const ok = await confirmDialog.confirm({
      title: "Remove collaborator",
      message: `Remove ${subject} from this repository? They will lose all access granted here.`,
      confirmText: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusySubject(subject);
    try {
      await collaboratorsApi.remove(repo.owner(), repo.repo(), subject);
      toast.success(`Removed ${subject}.`);
      reload();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusySubject(null);
    }
  }

  return (
    <AdminGate>
      <div class="space-y-6">
        {/* Add */}
        <SettingsSection
          title="Add a collaborator"
          description="Grant a person access by their account subject. Roles are ordered Read < Write < Maintain < Admin."
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
            <Field label="Role" class="w-40" for="new-collab-role">
              <Select
                id="new-collab-role"
                value={newRole()}
                onChange={(e) => setNewRole(e.currentTarget.value as Role)}
                disabled={adding()}
              >
                <For each={ROLES}>{(r) => <option value={r.value}>{r.label}</option>}</For>
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
                        busy={busySubject() === collab().subject}
                        onRole={(role) => changeRole(collab().subject, role)}
                        onRemove={() => removeCollaborator(collab().subject)}
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
      </div>
      <Label tone="accent">{ROLE_LABEL[props.collab.role]}</Label>
      <label class="sr-only" for={`role-${props.collab.subject}`}>
        Role for {display()}
      </label>
      <Select
        id={`role-${props.collab.subject}`}
        class="w-36"
        value={props.collab.role}
        disabled={props.busy}
        onChange={(e) => props.onRole(e.currentTarget.value as Role)}
      >
        <For each={ROLES}>{(r) => <option value={r.value}>{r.label}</option>}</For>
      </Select>
      <Button
        variant="danger"
        size="sm"
        disabled={props.busy}
        onClick={() => props.onRemove()}
        aria-label={`Remove ${display()}`}
      >
        <Show when={props.busy} fallback={<Icons.Trash class="h-4 w-4" />}>
          <Icons.Loader class="h-4 w-4 animate-spin" />
        </Show>
        Remove
      </Button>
    </div>
  );
}
