import { createSignal, Show, For, type JSX } from "solid-js";
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
import { actionsApi } from "../../api/actions.ts";
import { ApiError } from "../../api/client.ts";
import type { WorkflowDto } from "../../api/types.ts";

/**
 * The `workflow_dispatch` affordance — a modal that manually triggers a
 * workflow on a ref with optional JSON inputs. On success it calls `onDispatched`
 * so the parent can refresh + navigate.
 */
export function DispatchDialog(props: {
  open: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  workflows: readonly WorkflowDto[];
  defaultRef: string;
  onDispatched: (runId: string | null) => void;
}): JSX.Element {
  const toast = useToast();
  const [path, setPath] = createSignal("");
  const [ref, setRef] = createSignal("");
  const [inputs, setInputs] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Only workflows that declare a manual trigger are dispatchable.
  const dispatchable = () =>
    props.workflows.filter((w) => w.triggers.includes("workflow_dispatch"));

  const reset = () => {
    setPath("");
    setRef("");
    setInputs("");
    setError(null);
  };

  const close = () => {
    if (submitting()) return;
    reset();
    props.onClose();
  };

  const effectivePath = () => path().trim();

  const submit = async () => {
    const p = effectivePath();
    if (!p) {
      setError("Choose or enter a workflow file path.");
      return;
    }
    let parsedInputs: Record<string, string> | undefined;
    const raw = inputs().trim();
    if (raw) {
      try {
        const obj = JSON.parse(raw) as unknown;
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
          throw new Error("not an object");
        }
        parsedInputs = Object.fromEntries(
          Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      } catch {
        setError("Inputs must be a JSON object, e.g. {\"env\":\"prod\"}.");
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await actionsApi.dispatch(props.owner, props.repo, p, {
        ref: ref().trim() || props.defaultRef,
        inputs: parsedInputs,
      });
      toast.success("Workflow run started");
      reset();
      props.onDispatched(res.run?.id ?? null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to start workflow run";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={
        <span class="inline-flex items-center gap-2">
          <Icons.Play class="h-4 w-4" /> Run workflow
        </span>
      }
      footer={
        <div class="flex items-center justify-end gap-2">
          <Button variant="default" onClick={close} disabled={submitting()}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting()}>
            <Show when={submitting()} fallback={<><Icons.Play class="h-4 w-4" /> Run workflow</>}>
              <Icons.Loader class="h-4 w-4 animate-spin" /> Starting…
            </Show>
          </Button>
        </div>
      }
    >
      <div class="flex flex-col gap-4">
        <Show when={error()}>
          <Banner tone="danger">{error()}</Banner>
        </Show>

        <Show
          when={dispatchable().length > 0}
          fallback={
            <p class="text-sm text-muted">
              No workflow declares a <code class="font-mono">workflow_dispatch</code> trigger.
              You can still enter a workflow file path manually below.
            </p>
          }
        >
          <Field label="Workflow" for="dispatch-workflow" hint="Only workflows with a manual trigger are listed.">
            <Select
              id="dispatch-workflow"
              value={path()}
              onChange={(e) => setPath(e.currentTarget.value)}
            >
              <option value="">Select a workflow…</option>
              <For each={dispatchable()}>
                {(w) => <option value={w.path}>{w.name ?? w.path}</option>}
              </For>
            </Select>
          </Field>
        </Show>

        <Field
          label="Workflow file path"
          for="dispatch-path"
          hint="Path within the repo, e.g. .github/workflows/ci.yml"
        >
          <TextInput
            id="dispatch-path"
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            placeholder=".github/workflows/ci.yml"
            class="font-mono"
          />
        </Field>

        <Field label="Ref" for="dispatch-ref" hint={`Branch or tag (default: ${props.defaultRef})`}>
          <TextInput
            id="dispatch-ref"
            value={ref()}
            onInput={(e) => setRef(e.currentTarget.value)}
            placeholder={props.defaultRef}
            class="font-mono"
          />
        </Field>

        <Field
          label="Inputs (JSON)"
          for="dispatch-inputs"
          hint="Optional workflow_dispatch inputs as a JSON object."
        >
          <Textarea
            id="dispatch-inputs"
            value={inputs()}
            onInput={(e) => setInputs(e.currentTarget.value)}
            placeholder={'{\n  "environment": "production"\n}'}
            class="font-mono"
            rows={4}
          />
        </Field>
      </div>
    </Dialog>
  );
}
