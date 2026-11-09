import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { ApiError } from "../../api/client.ts";
import { reposApi } from "../../api/repos.ts";
import type { RepoDetail, Visibility } from "../../api/types.ts";
import { Banner, Button, Dialog, Field, Select, Textarea, TextInput, useConfirmDialog } from "../../ui/index.ts";
import { createRepositoryCreation, type RepositoryCreation } from "./repository-creation.ts";

const repoHref = (repo: { owner: string; name: string }) => `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/** Uses the existing create API; namespace and membership authority stay there. */
export function NewRepository(props: { open: boolean; onClose: () => void; onCreated: () => void }): JSX.Element {
  const navigate = useNavigate(), { confirm } = useConfirmDialog();
  const [owner, setOwner] = createSignal("");
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [visibility, setVisibility] = createSignal<Visibility>("private");
  const [branch, setBranch] = createSignal("main");
  const [error, setError] = createSignal<string | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [readError, setReadError] = createSignal<string | null>(null);
  const [found, setFound] = createSignal<RepoDetail | null>(null);
  const [created, setCreated] = createSignal<RepoDetail | null>(null);
  const [conflict, setConflict] = createSignal<RepositoryCreation | null>(null);
  const flow = createRepositoryCreation();
  let retired = false, revision = 0, viewEpoch = 0;
  onCleanup(() => { retired = true; });
  const busy = () => checking() || flow.state()?.phase === "sending";
  const readAttempt = () => flow.unknown() ?? conflict();
  function close(): void { viewEpoch++; props.onClose(); }
  function change<T>(setter: (value: T) => unknown, value: T): void { revision++; setter(value); }

  async function send(attempt: RepositoryCreation): Promise<void> {
    const epoch = viewEpoch;
    setError(null); setReadError(null); setFound(null); setCreated(null); setConflict(null);
    try {
      const { repository } = await reposApi.create(attempt.input);
      if (retired || !flow.acknowledge(attempt)) return;
      props.onCreated();
      if (props.open && epoch === viewEpoch && revision === attempt.revision) navigate(repoHref(repository));
      else setCreated(repository);
    } catch (err) {
      if (retired) return;
      flow.fail(attempt, err);
      if (err instanceof ApiError && err.status === 409) setConflict(attempt);
      setError(err instanceof ApiError ? err.message : "We could not confirm whether the repository was created.");
    }
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    if (retired || busy() || flow.state() || !owner().trim() || !name().trim()) return;
    const attempt = flow.prepare({ owner: owner().trim(), name: name().trim(), description: description(), visibility: visibility(), defaultBranch: branch().trim() || "main" }, revision);
    if (attempt) await send(attempt);
  }

  async function check(attempt: RepositoryCreation): Promise<void> {
    if (retired || busy()) return;
    setChecking(true); setReadError(null); setFound(null);
    try {
      const repository = await reposApi.get(attempt.input.owner, attempt.input.name);
      if (!retired) setFound(repository);
    } catch (err) {
      if (!retired) setReadError(err instanceof ApiError && err.status === 404
        ? "The repository was not found. An earlier request may still be in flight; this does not prove it was rolled back."
        : err instanceof ApiError ? err.message : "Could not read the repository. The creation result remains unconfirmed.");
    } finally { if (!retired) setChecking(false); }
  }

  async function retry(attempt: RepositoryCreation): Promise<void> {
    const epoch = viewEpoch;
    const ok = await confirm({ title: "Retry the original repository creation?", message: `Submit the original configuration for ${attempt.input.owner}/${attempt.input.name}. No existing repository will be replaced. Check its current state first if the earlier request may have succeeded. Your newer form edits stay here.`, confirmText: "Retry original" });
    if (ok && !retired && props.open && epoch === viewEpoch && !busy() && flow.retry(attempt)) await send(attempt);
  }

  return (
    <Dialog open={props.open} onClose={close} title="Create repository">
      <form class="space-y-4" onSubmit={(event) => void submit(event)}>
        <Field for="repository-owner" label="Owner namespace" required hint="Your personal namespace, or an organization you administer. A new personal namespace will be claimed for your account.">
          <TextInput id="repository-owner" name="repository-owner" required autofocus value={owner()} onInput={event => change(setOwner, event.currentTarget.value)} />
        </Field>
        <Field for="repository-name" label="Repository name" required>
          <TextInput id="repository-name" name="repository-name" required value={name()} onInput={event => change(setName, event.currentTarget.value)} />
        </Field>
        <Field for="repository-description" label="Description">
          <Textarea id="repository-description" value={description()} onInput={event => change(setDescription, event.currentTarget.value)} />
        </Field>
        <Field for="repository-visibility" label="Visibility">
          <Select id="repository-visibility" value={visibility()} onChange={event => change(setVisibility, event.currentTarget.value as Visibility)}>
            <option value="private">Private</option><option value="internal">Internal</option><option value="public">Public</option>
          </Select>
        </Field>
        <Field for="repository-branch" label="Default branch">
          <TextInput id="repository-branch" value={branch()} onInput={event => change(setBranch, event.currentTarget.value)} />
        </Field>
        <Show when={flow.unknown()}>
          {attempt => <Banner tone="warning" title="Creation result unknown">
            <p>{error()} The original request is for {attempt().input.owner}/{attempt().input.name}. Check it before deciding whether to retry.</p>
            <Button type="button" size="sm" class="mt-2" disabled={busy()} onClick={() => void retry(attempt())}>Retry original creation</Button>
          </Banner>}
        </Show>
        <Show when={!flow.unknown() && error()}>{message => <Banner tone="danger">{message()}</Banner>}</Show>
        <Show when={readAttempt()}>
          {attempt => <div class="space-y-2">
            <Button type="button" disabled={busy()} onClick={() => void check(attempt())}>{checking() ? "Checking…" : `Check ${attempt().input.owner}/${attempt().input.name}`}</Button>
            <Show when={found()}>{repo => <Banner tone="info">Repository found. This read does not identify which request created it. <A class="text-accent hover:underline" href={repoHref(repo())}>Open existing repository</A> to verify its contents.</Banner>}</Show>
            <Show when={readError()}>{message => <Banner tone="danger">{message()}</Banner>}</Show>
          </div>}
        </Show>
        <Show when={created()}>{repo => <Banner tone="success">Created {repo().fullName}. Your form edits remain here. <A class="text-accent hover:underline" href={repoHref(repo())}>Open repository</A></Banner>}</Show>
        <div class="flex justify-end gap-2">
          <Button type="button" onClick={close}>Close</Button>
          <Button type="submit" variant="primary" disabled={busy() || !!flow.state() || !owner().trim() || !name().trim()}>{flow.state()?.phase === "sending" ? "Creating…" : "Create repository"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
