/**
 * Settings → Webhooks: HMAC-signed subscriptions with a per-hook delivery log.
 * Backed by `webhooksApi` (list / create / update / remove / ping / deliveries).
 * Secrets are write-only (never returned by the API); deliveries are async and
 * appear in the log after they run.
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
import { webhooksApi } from "../../api/admin.ts";
import type { WebhookDeliveryDto, WebhookDto } from "../../api/types.ts";
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
  RelativeTime,
  TextInput,
  useToast,
} from "../../ui/index.ts";
import { AdminGate, ComingSoon, describeError, ToggleField } from "./shared.tsx";

/** Individually-selectable delivery events (mirrors the worker's KNOWN_EVENTS, sans `*`/`ping`). */
const WEBHOOK_EVENTS: readonly { id: string; label: string }[] = [
  { id: "push", label: "Push" },
  { id: "issues", label: "Issues" },
  { id: "issue_comment", label: "Issue comments" },
  { id: "pull_request", label: "Pull requests" },
  { id: "pull_request_review", label: "PR reviews" },
  { id: "pull_request_review_comment", label: "PR review comments" },
  { id: "release", label: "Releases" },
  { id: "fork", label: "Forks" },
  { id: "check_run", label: "Check runs" },
  { id: "status", label: "Commit statuses" },
];

type HookForm = {
  url: string;
  secret: string;
  active: boolean;
  everything: boolean;
  events: string[];
};

function blankHook(): HookForm {
  return { url: "", secret: "", active: true, everything: true, events: [] };
}
function fromDto(dto: WebhookDto): HookForm {
  const everything = dto.events.includes("*");
  return {
    url: dto.url,
    secret: "",
    active: dto.active,
    everything,
    events: everything ? [] : dto.events.filter((e) => e !== "*"),
  };
}

export function WebhooksSettingsView(): JSX.Element {
  const repo = useRepo();
  const toast = useToast();
  const confirmDialog = useConfirmDialog();

  const [reloadKey, setReloadKey] = createSignal(0);
  const [hooks] = createResource(
    () => [repo.owner(), repo.repo(), reloadKey()] as const,
    async ([o, r]) => (await webhooksApi.list(o, r)).items,
  );
  const reload = (): void => {
    setReloadKey((k) => k + 1);
  };

  const [editorOpen, setEditorOpen] = createSignal(false);
  const [editing, setEditing] = createSignal<HookForm>(blankHook());
  const [editId, setEditId] = createSignal<string | null>(null);

  function openNew(): void {
    setEditing(blankHook());
    setEditId(null);
    setEditorOpen(true);
  }
  function openEdit(hook: WebhookDto): void {
    setEditing(fromDto(hook));
    setEditId(hook.id);
    setEditorOpen(true);
  }

  const [pingBusy, setPingBusy] = createSignal<string | null>(null);
  async function ping(id: string): Promise<void> {
    setPingBusy(id);
    try {
      await webhooksApi.ping(repo.owner(), repo.repo(), id);
      toast.success("Ping delivered. Check the recent deliveries below.");
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setPingBusy(null);
    }
  }

  async function deleteHook(hook: WebhookDto): Promise<void> {
    const ok = await confirmDialog.confirm({
      title: "Delete webhook",
      message: `Delete the webhook to ${hook.url}? Delivery history will be removed.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await webhooksApi.remove(repo.owner(), repo.repo(), hook.id);
      toast.success("Webhook deleted.");
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
            <h2 class="text-sm font-semibold text-fg">Webhooks</h2>
            <p class="mt-0.5 text-xs text-muted">
              POST event payloads to an external URL, signed with your secret (HMAC SHA-256).
            </p>
          </div>
          <Button variant="primary" onClick={openNew}>
            <Icons.Plus class="h-4 w-4" /> Add webhook
          </Button>
        </div>

        <Suspense fallback={<LoadingBlock label="Loading webhooks…" />}>
          <Show when={hooks.error}>
            <Banner tone="danger" title="Could not load webhooks">{describeError(hooks.error)}</Banner>
          </Show>
          <Show when={!hooks.error}>
            <Show
              when={(hooks()?.length ?? 0) > 0}
              fallback={
                <EmptyState
                  icon={<Icons.Link class="h-8 w-8" />}
                  title="No webhooks"
                  description="Add a webhook to notify an external service when events happen in this repository."
                  action={<Button variant="primary" onClick={openNew}><Icons.Plus class="h-4 w-4" /> Add webhook</Button>}
                />
              }
            >
              <div class="space-y-3">
                <Index each={hooks() ?? []}>
                  {(hook) => (
                    <WebhookRow
                      hook={hook()}
                      owner={repo.owner()}
                      repo={repo.repo()}
                      pinging={pingBusy() === hook().id}
                      onPing={() => ping(hook().id)}
                      onEdit={() => openEdit(hook())}
                      onDelete={() => deleteHook(hook())}
                    />
                  )}
                </Index>
              </div>
            </Show>
          </Show>
        </Suspense>
      </div>

      <WebhookEditorDialog
        open={editorOpen()}
        editId={editId()}
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

function eventSummary(events: readonly string[]): string {
  if (events.includes("*")) return "All events";
  if (events.length === 0) return "No events";
  const known = new Map(WEBHOOK_EVENTS.map((e) => [e.id, e.label]));
  return events.map((e) => known.get(e) ?? e).join(", ");
}

function WebhookRow(props: {
  hook: WebhookDto;
  owner: string;
  repo: string;
  pinging: boolean;
  onPing: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const [showLog, setShowLog] = createSignal(false);
  return (
    <Box>
      <div class="flex flex-wrap items-center gap-3 px-4 py-3">
        <Icons.Link class="h-4 w-4 shrink-0 text-muted" />
        <div class="min-w-0 flex-1">
          <Mono class="block truncate text-sm font-semibold">{props.hook.url}</Mono>
          <div class="mt-0.5 text-xs text-muted">{eventSummary(props.hook.events)}</div>
        </div>
        <Label tone={props.hook.active ? "success" : "default"}>
          {props.hook.active ? "Active" : "Inactive"}
        </Label>
        <Button size="sm" disabled={props.pinging} onClick={() => props.onPing()}>
          <Show when={props.pinging} fallback={<Icons.Zap class="h-4 w-4" />}>
            <Icons.Loader class="h-4 w-4 animate-spin" />
          </Show>
          Ping
        </Button>
        <Button size="sm" onClick={() => props.onEdit()}>
          <Icons.Edit class="h-4 w-4" /> Edit
        </Button>
        <Button size="sm" variant="danger" onClick={() => props.onDelete()} aria-label={`Delete webhook ${props.hook.url}`}>
          <Icons.Trash class="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="invisible"
          aria-expanded={showLog()}
          onClick={() => setShowLog((v) => !v)}
        >
          <Show when={showLog()} fallback={<Icons.ChevronRight class="h-4 w-4" />}>
            <Icons.ChevronDown class="h-4 w-4" />
          </Show>
          Recent deliveries
        </Button>
      </div>
      <Show when={showLog()}>
        <div class="border-t border-border">
          <DeliveryLog owner={props.owner} repo={props.repo} hookId={props.hook.id} />
        </div>
      </Show>
    </Box>
  );
}

function DeliveryLog(props: { owner: string; repo: string; hookId: string }): JSX.Element {
  const [deliveries] = createResource(
    () => [props.owner, props.repo, props.hookId] as const,
    async ([o, r, id]) => (await webhooksApi.deliveries(o, r, id)).items,
  );
  return (
    <Suspense fallback={<div class="px-4 py-4"><LoadingBlock label="Loading deliveries…" /></div>}>
      <Show when={deliveries.error}>
        <div class="px-4 py-3">
          <Banner tone="danger" title="Could not load deliveries">{describeError(deliveries.error)}</Banner>
        </div>
      </Show>
      <Show when={!deliveries.error}>
        <Show
          when={(deliveries()?.length ?? 0) > 0}
          fallback={<p class="px-4 py-4 text-sm text-muted">No deliveries yet. Use “Ping” to send a test event.</p>}
        >
          <Index each={deliveries() ?? []}>
            {(delivery) => <DeliveryRow delivery={delivery()} />}
          </Index>
        </Show>
      </Show>
    </Suspense>
  );
}

function DeliveryRow(props: { delivery: WebhookDeliveryDto }): JSX.Element {
  const d = () => props.delivery;
  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0">
      <Show
        when={d().success}
        fallback={<Icons.X class="h-4 w-4 shrink-0 text-danger" aria-label="Failed" />}
      >
        <Icons.Check class="h-4 w-4 shrink-0 text-success" aria-label="Succeeded" />
      </Show>
      <Mono class="font-semibold">{d().event}</Mono>
      <Label tone={d().success ? "success" : "danger"}>
        {d().statusCode != null ? `HTTP ${d().statusCode}` : "no response"}
      </Label>
      <Show when={d().durationMs != null}>
        <span class="text-xs text-muted">{d().durationMs} ms</span>
      </Show>
      <span class="ml-auto text-xs text-muted">
        <RelativeTime epochMs={d().createdAt} />
      </span>
      <Button size="sm" variant="invisible" disabled title="Redelivery is not available in the UI yet" aria-label="Redeliver">
        <Icons.Refresh class="h-4 w-4" />
      </Button>
    </div>
  );
}

function WebhookEditorDialog(props: {
  open: boolean;
  editId: string | null;
  value: HookForm;
  onChange: (next: HookForm) => void;
  onClose: () => void;
  onSaved: () => void;
  owner: string;
  repo: string;
}): JSX.Element {
  const toast = useToast();
  const [saving, setSaving] = createSignal(false);
  const isNew = (): boolean => props.editId === null;
  const patch = (part: Partial<HookForm>): void => props.onChange({ ...props.value, ...part });

  const toggleEvent = (id: string, on: boolean): void => {
    const set = new Set(props.value.events);
    if (on) set.add(id);
    else set.delete(id);
    patch({ events: [...set] });
  };

  const validUrl = (): boolean => {
    try {
      const u = new URL(props.value.url.trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  };
  const hasEvents = (): boolean => props.value.everything || props.value.events.length > 0;
  const canSave = (): boolean => validUrl() && hasEvents() && !saving();

  async function save(): Promise<void> {
    if (!canSave()) return;
    const events = props.value.everything ? ["*"] : props.value.events;
    const secret = props.value.secret.trim();
    setSaving(true);
    try {
      if (isNew()) {
        await webhooksApi.create(props.owner, props.repo, {
          url: props.value.url.trim(),
          events,
          active: props.value.active,
          ...(secret ? { secret } : {}),
        });
        toast.success("Webhook created.");
      } else {
        await webhooksApi.update(props.owner, props.repo, props.editId!, {
          url: props.value.url.trim(),
          events,
          active: props.value.active,
          ...(secret ? { secret } : {}),
        });
        toast.success("Webhook updated.");
      }
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
      title={isNew() ? "Add webhook" : "Edit webhook"}
      footer={
        <>
          <Button onClick={() => props.onClose()} disabled={saving()}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!canSave()}>
            <Show when={saving()}><Icons.Loader class="h-4 w-4 animate-spin" /></Show>
            {isNew() ? "Add webhook" : "Save changes"}
          </Button>
        </>
      }
    >
      <div class="space-y-4">
        <Field label="Payload URL" hint="An http(s) endpoint that receives POST payloads." for="hook-url">
          <TextInput
            id="hook-url"
            type="url"
            inputmode="url"
            placeholder="https://example.com/webhook"
            value={props.value.url}
            onInput={(e) => patch({ url: e.currentTarget.value })}
          />
        </Field>

        <Field
          label="Secret"
          hint={isNew() ? "Optional. Used to sign each delivery (X-Hub-Signature-256)." : "Leave blank to keep the current secret."}
          for="hook-secret"
        >
          <TextInput
            id="hook-secret"
            type="password"
            autocomplete="new-password"
            placeholder={isNew() ? "" : "••••••••"}
            value={props.value.secret}
            onInput={(e) => patch({ secret: e.currentTarget.value })}
          />
        </Field>

        <fieldset class="space-y-2">
          <legend class="text-sm font-semibold text-fg">Which events should trigger this webhook?</legend>
          <label class="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-canvas-subtle">
            <input
              type="radio"
              name="hook-scope"
              class="mt-1"
              checked={props.value.everything}
              onChange={() => patch({ everything: true })}
            />
            <span>
              <span class="block text-sm font-semibold text-fg">Send me everything</span>
              <span class="block text-xs text-muted">Deliver a payload for every supported event.</span>
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-canvas-subtle">
            <input
              type="radio"
              name="hook-scope"
              class="mt-1"
              checked={!props.value.everything}
              onChange={() => patch({ everything: false })}
            />
            <span>
              <span class="block text-sm font-semibold text-fg">Let me select individual events</span>
              <span class="block text-xs text-muted">Choose specific events below.</span>
            </span>
          </label>

          <Show when={!props.value.everything}>
            <div class="grid grid-cols-1 gap-1 rounded-md border border-border p-3 sm:grid-cols-2">
              <For each={WEBHOOK_EVENTS}>
                {(ev) => (
                  <label class="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-canvas-subtle">
                    <input
                      type="checkbox"
                      checked={props.value.events.includes(ev.id)}
                      onChange={(e) => toggleEvent(ev.id, e.currentTarget.checked)}
                    />
                    <span class="text-fg">{ev.label}</span>
                  </label>
                )}
              </For>
            </div>
            <Show when={!hasEvents()}>
              <p class="text-xs text-danger">Select at least one event.</p>
            </Show>
          </Show>
        </fieldset>

        <div class="rounded-md border border-border px-3">
          <ToggleField
            label="Active"
            hint="Deliveries are only sent while the webhook is active."
            checked={props.value.active}
            onChange={(v) => patch({ active: v })}
          />
        </div>

        <p class="flex items-center gap-2 text-xs text-muted">
          <ComingSoon>Redelivery</ComingSoon>
          Individual deliveries can be replayed once redelivery lands in the UI.
        </p>
      </div>
    </Dialog>
  );
}
