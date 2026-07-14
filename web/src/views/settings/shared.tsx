/**
 * Shared building blocks for the repo Settings sub-tabs (general / collaborators
 * / branches / webhooks). Kept local to the view partition — these compose the
 * frozen `ui/` primitives into the denser, form-heavy chrome the admin panels
 * reuse, plus the small helpers (error copy, an accessible Toggle) every panel
 * needs.
 */
import { Show, type JSX } from "solid-js";
import { ApiError } from "../../api/client.ts";
import { useSession } from "../../store/session.tsx";
import { Banner, Box, BoxHeader, Button, Icons } from "../../ui/index.ts";
import { cn } from "../../lib/cn.ts";

/** Turn any thrown value into human copy, mapping the common auth statuses. */
export function describeError(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Sign in with an owner/admin session to manage this repository.";
    if (err.status === 403) return err.message || "You do not have permission for this action.";
    if (err.status === 404) return err.message || "Not found.";
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

/**
 * The admin gate the panels render inside. Settings writes require an owner /
 * maintainer session; the worker enforces the exact floor per route (the SPA
 * cannot read the viewer's role from the contract yet), so we gate the whole
 * area on an authenticated session and surface the server's 403 verbatim when a
 * signed-in reader lacks the role.
 */
export function AdminGate(props: { children: JSX.Element }): JSX.Element {
  const session = useSession();
  return (
    <Show
      when={session.authenticated()}
      fallback={
        <Banner
          tone="warning"
          title="Owner or maintainer access required"
          action={
            <Show when={session.configured()}>
              <Button size="sm" variant="primary" onClick={() => session.signIn()}>
                Sign in
              </Button>
            </Show>
          }
        >
          Repository settings can only be managed by its owner or a maintainer. Sign in to continue.
        </Banner>
      }
    >
      {props.children}
    </Show>
  );
}

/** A titled settings section — a Box with an optional header + description. */
export function SettingsSection(props: {
  title: string;
  description?: JSX.Element;
  icon?: JSX.Element;
  tone?: "default" | "danger";
  headerAction?: JSX.Element;
  children: JSX.Element;
  class?: string;
}): JSX.Element {
  return (
    <Box class={cn(props.tone === "danger" && "border-danger-emphasis/50", props.class)}>
      <BoxHeader class={cn("justify-between", props.tone === "danger" && "text-danger")}>
        <span class="flex items-center gap-2">
          <Show when={props.icon}>{props.icon}</Show>
          {props.title}
        </span>
        <Show when={props.headerAction}>{props.headerAction}</Show>
      </BoxHeader>
      <div class="p-4">
        <Show when={props.description}>
          <p class="mb-3 text-sm text-muted">{props.description}</p>
        </Show>
        {props.children}
      </div>
    </Box>
  );
}

/** A danger-zone row: label + description on the left, an action on the right. */
export function DangerRow(props: {
  title: string;
  description: JSX.Element;
  action: JSX.Element;
}): JSX.Element {
  return (
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-fg">{props.title}</div>
        <p class="mt-0.5 text-xs text-muted">{props.description}</p>
      </div>
      <div class="shrink-0">{props.action}</div>
    </div>
  );
}

/** An accessible on/off switch (role="switch") — no native checkbox chrome. */
export function Toggle(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      id={props.id}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      class={cn(
        "tg-focus relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        props.checked ? "bg-success-emphasis" : "bg-neutral-muted",
        props.disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        class={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          props.checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** A labeled toggle row used inside rule / hook editors. */
export function ToggleField(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}): JSX.Element {
  const id = `tgl-${Math.random().toString(36).slice(2)}`;
  return (
    <div class="flex items-start justify-between gap-4 py-2">
      <label for={id} class="min-w-0 cursor-pointer">
        <span class="text-sm font-medium text-fg">{props.label}</span>
        <Show when={props.hint}>
          <span class="mt-0.5 block text-xs text-muted">{props.hint}</span>
        </Show>
      </label>
      <Toggle
        id={id}
        checked={props.checked}
        onChange={props.onChange}
        label={props.label}
        disabled={props.disabled}
      />
    </div>
  );
}

/** A small inline "not yet available" pill for controls awaiting an api/server seam. */
export function ComingSoon(props: { children?: JSX.Element }): JSX.Element {
  return (
    <span class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-subtle">
      <Icons.Clock class="h-3 w-3" /> {props.children ?? "Not yet available"}
    </span>
  );
}
