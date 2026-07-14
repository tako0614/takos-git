/**
 * Settings → Branches: branch-protection rules. Each rule is keyed by a branch
 * name pattern and enforced server-side on every ref-advancing write. Backed by
 * `branchProtectionApi` (list / put / remove).
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
import { branchProtectionApi } from "../../api/admin.ts";
import type { BranchProtectionRuleDto } from "../../api/types.ts";
import { useConfirmDialog } from "../../store/confirm.ts";
import {
  Banner,
  Box,
  Button,
  Dialog,
  EmptyState,
  Field,
  Icons,
  Label,
  LoadingBlock,
  Mono,
  Select,
  TextInput,
  Textarea,
  useToast,
} from "../../ui/index.ts";
import { AdminGate, describeError, SettingsSection, ToggleField } from "./shared.tsx";

type RuleForm = {
  pattern: string;
  requiredReviews: number;
  dismissStaleReviews: boolean;
  requireCodeOwner: boolean;
  requiredStatusChecks: string[];
  strictStatusChecks: boolean;
  enforceAdmins: boolean;
  restrictPush: boolean;
  allowForcePush: boolean;
  allowDeletions: boolean;
};

function blankRule(): RuleForm {
  return {
    pattern: "",
    requiredReviews: 1,
    dismissStaleReviews: false,
    requireCodeOwner: false,
    requiredStatusChecks: [],
    strictStatusChecks: false,
    enforceAdmins: false,
    restrictPush: false,
    allowForcePush: false,
    allowDeletions: false,
  };
}

function fromDto(dto: BranchProtectionRuleDto): RuleForm {
  return {
    pattern: dto.pattern,
    requiredReviews: dto.requiredReviews,
    dismissStaleReviews: dto.dismissStaleReviews,
    requireCodeOwner: dto.requireCodeOwner,
    requiredStatusChecks: [...dto.requiredStatusChecks],
    strictStatusChecks: dto.strictStatusChecks,
    enforceAdmins: dto.enforceAdmins,
    restrictPush: dto.restrictPush,
    allowForcePush: dto.allowForcePush,
    allowDeletions: dto.allowDeletions,
  };
}

export function BranchesSettingsView(): JSX.Element {
  const repo = useRepo();
  const toast = useToast();
  const confirmDialog = useConfirmDialog();

  const [reloadKey, setReloadKey] = createSignal(0);
  const [rules] = createResource(
    () => [repo.owner(), repo.repo(), reloadKey()] as const,
    async ([o, r]) => (await branchProtectionApi.list(o, r)).items,
  );
  const reload = (): void => {
    setReloadKey((k) => k + 1);
  };

  const [editorOpen, setEditorOpen] = createSignal(false);
  const [editing, setEditing] = createSignal<RuleForm>(blankRule());
  const [isNew, setIsNew] = createSignal(true);

  function openNew(): void {
    setEditing(blankRule());
    setIsNew(true);
    setEditorOpen(true);
  }
  function openEdit(dto: BranchProtectionRuleDto): void {
    setEditing(fromDto(dto));
    setIsNew(false);
    setEditorOpen(true);
  }

  async function deleteRule(pattern: string): Promise<void> {
    const ok = await confirmDialog.confirm({
      title: "Delete protection rule",
      message: `Remove the protection rule for "${pattern}"? Writes to matching branches will no longer be restricted.`,
      confirmText: "Delete rule",
      danger: true,
    });
    if (!ok) return;
    try {
      await branchProtectionApi.remove(repo.owner(), repo.repo(), pattern);
      toast.success(`Deleted rule for ${pattern}.`);
      reload();
    } catch (err) {
      toast.error(describeError(err));
    }
  }

  return (
    <AdminGate>
      <div class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-semibold text-fg">Branch protection rules</h2>
            <p class="mt-0.5 text-xs text-muted">
              Restrict how branches matching a pattern (e.g. <Mono>main</Mono> or <Mono>release/*</Mono>) can be changed.
            </p>
          </div>
          <Button variant="primary" onClick={openNew}>
            <Icons.Plus class="h-4 w-4" /> New rule
          </Button>
        </div>

        <Suspense fallback={<LoadingBlock label="Loading rules…" />}>
          <Show when={rules.error}>
            <Banner tone="danger" title="Could not load protection rules">
              {describeError(rules.error)}
            </Banner>
          </Show>
          <Show when={!rules.error}>
            <Show
              when={(rules()?.length ?? 0) > 0}
              fallback={
                <EmptyState
                  icon={<Icons.GitBranch class="h-8 w-8" />}
                  title="No protection rules"
                  description="Every branch can be pushed and deleted freely. Add a rule to require reviews or status checks."
                  action={<Button variant="primary" onClick={openNew}><Icons.Plus class="h-4 w-4" /> New rule</Button>}
                />
              }
            >
              <Box>
                <Index each={rules() ?? []}>
                  {(rule) => (
                    <RuleRow rule={rule()} onEdit={() => openEdit(rule())} onDelete={() => deleteRule(rule().pattern)} />
                  )}
                </Index>
              </Box>
            </Show>
          </Show>
        </Suspense>
      </div>

      <RuleEditorDialog
        open={editorOpen()}
        isNew={isNew()}
        value={editing()}
        onChange={setEditing}
        onClose={() => setEditorOpen(false)}
        onSaved={() => { setEditorOpen(false); reload(); }}
        owner={repo.owner()}
        repo={repo.repo()}
      />
    </AdminGate>
  );
}

function RuleRow(props: {
  rule: BranchProtectionRuleDto;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const summary = (): string[] => {
    const parts: string[] = [];
    if (props.rule.requiredReviews > 0) parts.push(`${props.rule.requiredReviews} review${props.rule.requiredReviews === 1 ? "" : "s"}`);
    if (props.rule.requiredStatusChecks.length > 0) parts.push(`${props.rule.requiredStatusChecks.length} status check${props.rule.requiredStatusChecks.length === 1 ? "" : "s"}`);
    if (props.rule.restrictPush) parts.push("push restricted");
    if (props.rule.enforceAdmins) parts.push("admins included");
    if (!props.rule.allowForcePush) parts.push("no force-push");
    if (!props.rule.allowDeletions) parts.push("no deletion");
    return parts;
  };
  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <Icons.Lock class="h-4 w-4 shrink-0 text-muted" />
      <div class="min-w-0 flex-1">
        <Mono class="text-sm font-semibold">{props.rule.pattern}</Mono>
        <div class="mt-1 flex flex-wrap gap-1.5">
          <For each={summary()}>{(s) => <Label tone="default">{s}</Label>}</For>
          <Show when={summary().length === 0}>
            <span class="text-xs text-muted">No restrictions configured</span>
          </Show>
        </div>
      </div>
      <Button size="sm" onClick={() => props.onEdit()}>
        <Icons.Edit class="h-4 w-4" /> Edit
      </Button>
      <Button size="sm" variant="danger" onClick={() => props.onDelete()} aria-label={`Delete rule ${props.rule.pattern}`}>
        <Icons.Trash class="h-4 w-4" />
      </Button>
    </div>
  );
}

function RuleEditorDialog(props: {
  open: boolean;
  isNew: boolean;
  value: RuleForm;
  onChange: (next: RuleForm) => void;
  onClose: () => void;
  onSaved: () => void;
  owner: string;
  repo: string;
}): JSX.Element {
  const toast = useToast();
  const [saving, setSaving] = createSignal(false);
  const patch = (part: Partial<RuleForm>): void => props.onChange({ ...props.value, ...part });

  const checksText = (): string => props.value.requiredStatusChecks.join("\n");
  const setChecksText = (text: string): void =>
    patch({
      requiredStatusChecks: text
        .split(/[\n,]/u)
        .map((s) => s.trim())
        .filter(Boolean),
    });

  const canSave = (): boolean => props.value.pattern.trim().length > 0 && !saving();

  async function save(): Promise<void> {
    const pattern = props.value.pattern.trim();
    if (!pattern) return;
    setSaving(true);
    try {
      await branchProtectionApi.put(props.owner, props.repo, pattern, {
        requiredReviews: props.value.requiredReviews,
        dismissStaleReviews: props.value.dismissStaleReviews,
        requireCodeOwner: props.value.requireCodeOwner,
        requiredStatusChecks: props.value.requiredStatusChecks,
        strictStatusChecks: props.value.strictStatusChecks,
        enforceAdmins: props.value.enforceAdmins,
        restrictPush: props.value.restrictPush,
        allowForcePush: props.value.allowForcePush,
        allowDeletions: props.value.allowDeletions,
      });
      props.onSaved();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={() => !saving() && props.onClose()}
      size="lg"
      title={props.isNew ? "New branch protection rule" : `Edit rule — ${props.value.pattern}`}
      footer={
        <>
          <Button onClick={() => props.onClose()} disabled={saving()}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!canSave()}>
            <Show when={saving()}><Icons.Loader class="h-4 w-4 animate-spin" /></Show>
            {props.isNew ? "Create rule" : "Save changes"}
          </Button>
        </>
      }
    >
      <div class="space-y-4">
        <Field
          label="Branch name pattern"
          hint="Exact name or glob, e.g. main, develop, release/*."
          for="rule-pattern"
        >
          <TextInput
            id="rule-pattern"
            value={props.value.pattern}
            readonly={!props.isNew}
            disabled={!props.isNew}
            placeholder="main"
            onInput={(e) => patch({ pattern: e.currentTarget.value })}
          />
        </Field>

        <Field label="Required approving reviews" for="rule-reviews">
          <Select
            id="rule-reviews"
            class="w-40"
            value={String(props.value.requiredReviews)}
            onChange={(e) => patch({ requiredReviews: Number(e.currentTarget.value) })}
          >
            <For each={[0, 1, 2, 3, 4, 5, 6]}>{(n) => <option value={String(n)}>{n}</option>}</For>
          </Select>
        </Field>

        <div class="rounded-md border border-border">
          <div class="border-b border-border px-3">
            <ToggleField
              label="Dismiss stale reviews"
              hint="Reset approvals when new commits are pushed."
              checked={props.value.dismissStaleReviews}
              onChange={(v) => patch({ dismissStaleReviews: v })}
            />
          </div>
          <div class="border-b border-border px-3">
            <ToggleField
              label="Require review from code owners"
              hint="At least one CODEOWNERS review is required."
              checked={props.value.requireCodeOwner}
              onChange={(v) => patch({ requireCodeOwner: v })}
            />
          </div>
          <div class="px-3">
            <ToggleField
              label="Require branches to be up to date"
              hint="Head must be current with the base before merging (strict checks)."
              checked={props.value.strictStatusChecks}
              onChange={(v) => patch({ strictStatusChecks: v })}
            />
          </div>
        </div>

        <Field
          label="Required status checks"
          hint="One check name per line (or comma-separated). Merges are blocked until these pass."
          for="rule-checks"
        >
          <Textarea
            id="rule-checks"
            rows={3}
            value={checksText()}
            onInput={(e) => setChecksText(e.currentTarget.value)}
            placeholder={"build\ntest"}
          />
        </Field>

        <div class="rounded-md border border-border px-3">
          <div class="border-b border-border">
            <ToggleField
              label="Restrict who can push"
              hint="Only maintainers and admins may push to matching branches."
              checked={props.value.restrictPush}
              onChange={(v) => patch({ restrictPush: v })}
            />
          </div>
          <div class="border-b border-border">
            <ToggleField
              label="Include administrators"
              hint="Enforce these rules for admins too."
              checked={props.value.enforceAdmins}
              onChange={(v) => patch({ enforceAdmins: v })}
            />
          </div>
          <div class="border-b border-border">
            <ToggleField
              label="Allow force pushes"
              checked={props.value.allowForcePush}
              onChange={(v) => patch({ allowForcePush: v })}
            />
          </div>
          <div>
            <ToggleField
              label="Allow deletions"
              checked={props.value.allowDeletions}
              onChange={(v) => patch({ allowDeletions: v })}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
