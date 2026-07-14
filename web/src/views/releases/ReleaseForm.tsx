import { createEffect, createSignal, on, Show, type JSX } from "solid-js";
import {
  ApiError,
  releasesApi,
  type ReleaseDto,
} from "../../api";
import { Banner, Button, Dialog, Field, TextInput, Textarea, useToast } from "../../ui";

interface ReleaseFormProps {
  open: boolean;
  owner: string;
  repo: string;
  /** When set, the dialog edits this release; otherwise it creates one. */
  editing?: ReleaseDto | null;
  onClose: () => void;
  /** Called with the tag of the saved release so the caller can navigate/refetch. */
  onSaved: (tag: string) => void;
}

/**
 * Create / edit a release. On create, `tag` + optional target ref are editable;
 * on edit the tag is immutable (it identifies the git ref) and only metadata
 * changes. Draft + prerelease are togglable in both modes.
 */
export function ReleaseForm(props: ReleaseFormProps): JSX.Element {
  const toast = useToast();
  const isEdit = () => !!props.editing;

  const [tag, setTag] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [name, setName] = createSignal("");
  const [body, setBody] = createSignal("");
  const [draft, setDraft] = createSignal(false);
  const [prerelease, setPrerelease] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Re-seed the form fields whenever the dialog (re)opens or its edit target
  // changes, from the editing release or a blank create form.
  createEffect(
    on(
      () => [props.open, props.editing] as const,
      ([open, r]) => {
        if (!open) return;
        setTag(r?.tag ?? "");
        setTarget("");
        setName(r?.name ?? "");
        setBody(r?.body ?? "");
        setDraft(r?.isDraft ?? false);
        setPrerelease(r?.isPrerelease ?? false);
        setError(null);
      },
    ),
  );

  const submit = async (event: Event) => {
    event.preventDefault();
    const t = tag().trim();
    if (!t) {
      setError("A tag is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (props.editing) {
        await releasesApi.update(props.owner, props.repo, props.editing.tag, {
          name: name().trim() || "",
          body: body(),
          draft: draft(),
          prerelease: prerelease(),
        });
        toast.success("Release updated.");
        props.onSaved(props.editing.tag);
      } else {
        const targetSha = target().trim();
        await releasesApi.create(props.owner, props.repo, {
          tag: t,
          name: name().trim() || undefined,
          body: body() || undefined,
          targetSha: targetSha || undefined,
          draft: draft(),
          prerelease: prerelease(),
        });
        toast.success(draft() ? "Draft release saved." : "Release published.");
        props.onSaved(t);
      }
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Failed to save the release.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Show when={props.open}>
      <Dialog
        open={props.open}
        onClose={() => (saving() ? undefined : props.onClose())}
        size="lg"
        title={isEdit() ? "Edit release" : "Draft a new release"}
      >
        <form class="flex flex-col gap-4" onSubmit={submit}>
          <Show when={error()}>
            <Banner tone="danger">{error()}</Banner>
          </Show>

          <Field label="Tag" required for="release-tag" hint={isEdit() ? "The tag cannot be changed after creation." : "A git tag to publish, e.g. v1.0.0. Created if it does not exist."}>
            <TextInput
              id="release-tag"
              placeholder="v1.0.0"
              value={tag()}
              disabled={isEdit()}
              autofocus={!isEdit()}
              onInput={(e) => setTag(e.currentTarget.value)}
            />
          </Field>

          <Show when={!isEdit()}>
            <Field label="Target" for="release-target" hint="Branch, tag or commit SHA the tag points at. Defaults to the repo's default branch.">
              <TextInput
                id="release-target"
                placeholder="main"
                value={target()}
                onInput={(e) => setTarget(e.currentTarget.value)}
              />
            </Field>
          </Show>

          <Field label="Release title" for="release-name">
            <TextInput
              id="release-name"
              placeholder="Optional — defaults to the tag"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </Field>

          <Field label="Describe this release" for="release-body" hint="Markdown supported.">
            <Textarea
              id="release-body"
              rows={8}
              placeholder="Write release notes…"
              value={body()}
              onInput={(e) => setBody(e.currentTarget.value)}
            />
          </Field>

          <fieldset class="flex flex-col gap-2">
            <label class="flex items-start gap-2 text-sm text-fg">
              <input
                type="checkbox"
                class="mt-0.5 h-4 w-4 accent-accent"
                checked={prerelease()}
                onChange={(e) => setPrerelease(e.currentTarget.checked)}
              />
              <span>
                <span class="font-medium">Set as a pre-release</span>
                <span class="block text-xs text-muted">
                  Flag this as non-production-ready.
                </span>
              </span>
            </label>
            <label class="flex items-start gap-2 text-sm text-fg">
              <input
                type="checkbox"
                class="mt-0.5 h-4 w-4 accent-accent"
                checked={draft()}
                onChange={(e) => setDraft(e.currentTarget.checked)}
              />
              <span>
                <span class="font-medium">Save as draft</span>
                <span class="block text-xs text-muted">
                  Drafts are only visible to people who can write to the repo.
                </span>
              </span>
            </label>
          </fieldset>

          <div class="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" onClick={() => props.onClose()} disabled={saving()}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving() || !tag().trim()}>
              {saving()
                ? "Saving…"
                : isEdit()
                  ? "Update release"
                  : draft()
                    ? "Save draft"
                    : "Publish release"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Show>
  );
}
