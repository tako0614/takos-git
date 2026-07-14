import { For, Show, type JSX } from "solid-js";
import { Banner, Box, BoxHeader, Icons } from "../ui/index.ts";

/**
 * The Phase-4b seam marker. Every placeholder view renders one so it is
 * unmistakably a stub, AND documents — in the UI — exactly what the 4b agent
 * for that view owns: which components to port, which api-client module to call,
 * and which routes it serves. Views also render a small LIVE proof beside this
 * (a real API call) so the seam is demonstrably wired, not mocked.
 */
export function Seam(props: {
  feature: string;
  summary: string;
  apiModule: string;
  components: readonly string[];
  routes: readonly string[];
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div class="space-y-4">
      <Banner tone="info" title={`Phase 4b — ${props.feature} view (shell placeholder)`}>
        {props.summary}
      </Banner>

      <div class="grid gap-4 md:grid-cols-2">
        <Box>
          <BoxHeader>
            <Icons.Package class="h-4 w-4 text-muted" /> This 4b agent owns
          </BoxHeader>
          <div class="space-y-3 p-4 text-sm">
            <div>
              <div class="text-xs font-semibold uppercase tracking-wide text-subtle">API client</div>
              <code class="font-mono text-accent">{props.apiModule}</code>
            </div>
            <div>
              <div class="text-xs font-semibold uppercase tracking-wide text-subtle">Components to port / build</div>
              <ul class="mt-1 flex flex-wrap gap-1.5">
                <For each={props.components}>
                  {(c) => <li class="rounded bg-neutral-muted px-2 py-0.5 font-mono text-xs">{c}</li>}
                </For>
              </ul>
            </div>
            <div>
              <div class="text-xs font-semibold uppercase tracking-wide text-subtle">Routes served</div>
              <ul class="mt-1 space-y-0.5">
                <For each={props.routes}>
                  {(r) => <li class="font-mono text-xs text-muted">{r}</li>}
                </For>
              </ul>
            </div>
          </div>
        </Box>

        <Show when={props.children}>
          <Box>
            <BoxHeader>
              <Icons.Zap class="h-4 w-4 text-success" /> Live API proof
            </BoxHeader>
            <div class="p-4">{props.children}</div>
          </Box>
        </Show>
      </div>
    </div>
  );
}
